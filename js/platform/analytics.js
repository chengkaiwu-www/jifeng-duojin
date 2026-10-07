/**
 * platform/analytics.js —— 埋点上报
 *
 * 为什么必须做:小游戏"获得用户"的前提是知道用户从哪来、在哪一步流失。
 * 没有埋点就没有增长决策的依据,只能凭感觉。
 *
 * 设计要点:
 *   1. 批量上报,减少云函数调用次数(小游戏流量潮汐明显,逐条上报成本高);
 *   2. 失败落盘,下次启动补报(复用 Cloud.report 的队列机制);
 *   3. 事件名统一小写下划线,便于后续做漏斗分析。
 *
 * 关键漏斗事件(建议全部埋上):
 *   launch → login_success → game_start → game_over → rank_view → share_click
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');
const Cloud = require('./cloud.js');
const EventBus = require('../framework/event-bus.js');

let buffer = [];
let timer = null;
const MAX_BUFFER = 30;

function flush() {
  if (!buffer.length || !cfg.ENABLE_ANALYTICS) return;
  const batch = buffer;
  buffer = [];
  Logger.log('analytics flush:', batch.length);
  // 用 report 而非 call:埋点丢一条没关系,绝不能因为埋点报错影响玩家
  Cloud.report('submitScore', { action: 'track', events: batch });
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    flush();
  }, cfg.FLUSH_INTERVAL);
}

module.exports = {
  init() {
    if (!cfg.ENABLE_ANALYTICS) return;
    ensureTimer();
    // 订阅全局埋点事件,业务代码可以零耦合地打点
    EventBus.on('analytics:track', (payload) => module.exports.track(payload.name, payload.props));
    Logger.log('analytics ready');
  },

  /**
   * @param {string} name 事件名,如 'game_over'
   * @param {object} [props] 附加属性,如 { score: 120, duration: 18 }
   */
  track(name, props) {
    if (!cfg.ENABLE_ANALYTICS || !name) return;
    buffer.push({
      name,
      props: props || {},
      ts: Date.now(),
    });
    if (buffer.length >= MAX_BUFFER) flush();
  },

  /** 立即上报(重要事件用,如 payment_success) */
  trackNow(name, props) {
    if (!cfg.ENABLE_ANALYTICS) return;
    Cloud.report('submitScore', {
      action: 'track',
      events: [{ name, props: props || {}, ts: Date.now() }],
    });
  },

  flush,
};
