/**
 * platform/wx-adapter.js —— wx API 适配层
 *
 * 两个职责:
 *   1. Promise 化:把 wx.* 的回调式 API 包成 Promise,业务层用 async/await 写起来清爽;
 *   2. 能力探测与降级:低版本基础库缺少新 API 时,不能让游戏直接崩,要有兜底。
 *
 * 这是唯一允许直接调用 wx.* 的地方(除 screen.js 的画布初始化外)。
 * 业务层只依赖这里的语义化方法,将来换引擎/换平台只改这一层。
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');

/** 通用 Promise 包装 */
function promisify(fn) {
  return function (options) {
    return new Promise((resolve, reject) => {
      fn(Object.assign({}, options, {
        success: (res) => resolve(res),
        fail: (err) => reject(err),
      }));
    });
  };
}

/** 版本号比较:不能直接字符串比较("2.9.0" > "2.10.0" 会判错) */
function compareVersion(v1, v2) {
  const a = String(v1).split('.');
  const b = String(v2).split('.');
  const len = Math.max(a.length, b.length);
  while (a.length < len) a.push('0');
  while (b.length < len) b.push('0');
  for (let i = 0; i < len; i++) {
    const na = parseInt(a[i], 10) || 0;
    const nb = parseInt(b[i], 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

let sysInfo = null;
let baseLibVersion = '0.0.0';

function readSysInfo() {
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const a = wx.getAppBaseInfo();
      baseLibVersion = a.SDKVersion || '0.0.0';
      return a;
    }
  } catch (e) { /* 降级 */ }
  try {
    const s = wx.getSystemInfoSync();
    baseLibVersion = s.SDKVersion || '0.0.0';
    return s;
  } catch (e) {
    return {};
  }
}

const api = {
  /** 是否具备某能力(低版本基础库兼容用) */
  can(name) {
    return typeof wx[name] === 'function';
  },

  /** 基础库版本是否 >= 某版本 */
  supportVersion(v) {
    return compareVersion(baseLibVersion, v) >= 0;
  },

  get baseLibVersion() { return baseLibVersion; },
  get sysInfo() { return sysInfo || (sysInfo = readSysInfo()); },

  showToast(title, icon) {
    try { wx.showToast({ title, icon: icon || 'none', duration: 1600 }); } catch (e) { /* ignore */ }
  },

  showLoading(title) {
    try { wx.showLoading({ title: title || '加载中', mask: true }); } catch (e) { /* ignore */ }
  },

  hideLoading() {
    try { wx.hideLoading(); } catch (e) { /* ignore */ }
  },

  /** 网络状态 —— 弱网/断网时的降级依据 */
  getNetwork() {
    return new Promise((resolve) => {
      try {
        wx.getNetworkType({
          success: (res) => resolve(res.networkType),
          fail: () => resolve('unknown'),
        });
      } catch (e) { resolve('unknown'); }
    });
  },

  vibrateShort() {
    try { if (module.exports.can('vibrateShort')) wx.vibrateShort({ type: 'light' }); } catch (e) { /* ignore */ }
  },

  setKeepScreenOn(on) {
    try { wx.setKeepScreenOn({ keepScreenOn: !!on }); } catch (e) { /* ignore */ }
  },

  /** 主动触发 GC,场景切换释放大图后调用 */
  triggerGC() {
    try { if (module.exports.can('triggerGC')) wx.triggerGC(); } catch (e) { /* ignore */ }
  },

  /** 设置右上角菜单的转发开关,以及是否允许分享到朋友圈(小游戏部分能力需版本支持) */
  showShareMenu() {
    try {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) {
      try { wx.showShareMenu({ withShareTicket: true }); } catch (e2) { /* ignore */ }
    }
  },

  getSetting: () => promisify(wx.getSetting)({}),
  getUserInfo: () => promisify(wx.getUserInfo)({}),
  login: () => promisify(wx.login)({}),
  request: (o) => promisify(wx.request)(o),
  getSystemInfoSync: () => readSysInfo(),

  compareVersion,
  Logger,
  config: cfg,
};

module.exports = api;
