/**
 * platform/cloud.js —— 云调用统一封装
 *
 * 小游戏接入云开发后,客户端不能直接信任自己算出来的任何东西,
 * 所有涉及资产/排名的写操作都要经云函数。本模块把这件事统一收口。
 *
 * 三个关键设计(对应云开发的两个真实痛点):
 *   1. 超时 —— 云函数冷启动可能等待实例启动,必须设置超时,不能让 UI 无限转圈;
 *   2. 重试 —— 网络抖动时自动重试,指数退避;
 *   3. 降级落盘 —— 上报失败就把数据存本地队列,下次启动补报。
 *      这条是小游戏"断网也能玩"的基础,否则玩家一断网进度就丢。
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');
const EventBus = require('../framework/event-bus.js');
const Storage = require('../framework/storage.js');

const QUEUE_KEY = 'report_queue';
const MAX_QUEUE = 200;

let inited = false;
let available = false;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次调用,带超时 */
function callOnce(name, data, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('cloud function timeout: ' + name));
    }, timeout);

    wx.cloud.callFunction({
      name,
      data: data || {},
      success: (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 统一约定:云函数返回 { code:0, data:any } 表示成功
        const r = res && res.result;
        if (r && typeof r.code === 'number' && r.code !== 0) {
          reject(Object.assign(new Error(r.msg || 'cloud error'), { code: r.code }));
        } else {
          resolve(r ? r.data : null);
        }
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

/* ---------- 失败队列(落盘补报) ---------- */
function readQueue() {
  return Storage.get(QUEUE_KEY, []) || [];
}

function pushQueue(item) {
  const q = readQueue();
  q.push(item);
  // 队列不能无限增长,超出丢弃最旧的
  while (q.length > MAX_QUEUE) q.shift();
  Storage.set(QUEUE_KEY, q);
}

function clearQueue() {
  Storage.set(QUEUE_KEY, []);
}

module.exports = {
  /** 初始化云开发环境 */
  init() {
    if (inited) return Promise.resolve(available);
    if (!cfg.ENABLE_CLOUD) {
      Logger.warn('cloud disabled by config, running in offline mode');
      inited = true; available = false;
      return Promise.resolve(false);
    }
    if (!wx.cloud) {
      Logger.warn('wx.cloud not available (base lib too old?), offline mode');
      inited = true; available = false;
      return Promise.resolve(false);
    }
    try {
      wx.cloud.init({
        env: cfg.CLOUD_ENV,
        traceUser: true,
      });
      inited = true;
      available = true;
      Logger.log('cloud init ok, env =', cfg.CLOUD_ENV);
    } catch (e) {
      Logger.error('cloud init failed:', e);
      inited = true;
      available = false;
    }
    return Promise.resolve(available);
  },

  isAvailable() { return available; },

  /**
   * 调用云函数(带超时 + 重试)。
   * @param {string} name
   * @param {object} data
   * @param {{timeout?:number, retry?:number, silent?:boolean}} [opt]
   */
  async call(name, data, opt) {
    const o = opt || {};
    if (!available) throw new Error('cloud unavailable');

    const timeout = o.timeout || cfg.API_TIMEOUT;
    const retry = o.retry === undefined ? cfg.API_RETRY : o.retry;

    let lastErr = null;
    for (let i = 0; i <= retry; i++) {
      try {
        return await callOnce(name, data, timeout);
      } catch (e) {
        lastErr = e;
        Logger.warn('cloud call failed (' + (i + 1) + '/' + (retry + 1) + '):', name, e && e.message);
        if (o.silent !== true && i === retry) {
          // 全部重试失败才提示用户
        }
        if (i < retry) await delay(200 * Math.pow(2, i)); // 指数退避
      }
    }
    throw lastErr;
  },

  /**
   * 上报型调用:失败不抛错,自动落盘,下次启动补报。
   * 用于"必须尽力送达,但失败也不能影响玩家"的场景(分数、埋点、存档)。
   */
  async report(name, data) {
    try {
      const res = await module.exports.call(name, data, { retry: 1 });
      return res;
    } catch (e) {
      Logger.warn('report failed, queued locally:', name);
      pushQueue({ name, data, ts: Date.now() });
      return null;
    }
  },

  /** 启动时调用:把上次失败的请求补报上去 */
  async flushQueue() {
    const q = readQueue();
    if (!q.length) return { sent: 0, failed: 0 };
    Logger.log('flushing pending reports:', q.length);

    const remain = [];
    for (let i = 0; i < q.length; i++) {
      try {
        await callOnce(q[i].name, q[i].data, cfg.API_TIMEOUT);
      } catch (e) {
        // 只保留 24 小时内的,超期丢弃避免无限堆积
        if (Date.now() - q[i].ts < 24 * 3600 * 1000) remain.push(q[i]);
      }
    }
    Storage.set(QUEUE_KEY, remain);
    const sent = q.length - remain.length;
    Logger.log('flush done: sent=' + sent + ' failed=' + remain.length);
    EventBus.emit('cloud:flushed', { sent, remain: remain.length });
    return { sent, failed: remain.length };
  },

  /**
   * 拉取远程配置/开关。
   * 用途:修复线上问题时不用重新提审 —— 改 configs 集合即可动态开关功能。
   */
  async fetchRemoteConfig() {
    try {
      const data = await module.exports.call('login', { action: 'getConfig' }, { retry: 0 });
      return data && data.configs ? data.configs : null;
    } catch (e) {
      return null;
    }
  },

  _pushQueue: pushQueue,
  _readQueue: readQueue,
  _clearQueue: clearQueue,
};
