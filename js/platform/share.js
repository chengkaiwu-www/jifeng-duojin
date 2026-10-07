/**
 * platform/share.js —— 分享与关系链
 *
 * 小游戏增长的第一引擎。核心事实:
 *   - onShareAppMessage 的回调在用户点右上角"转发"或主动调 wx.shareAppMessage 时触发;
 *   - 分享卡片 imageUrl 建议 5:4(如 500×400),这是玩家在群里看到的唯一素材;
 *   - 群分享必须 withShareTicket,shareTicket 在 wx.onShow 的回调里拿,
 *     这是后续用 wx.getGroupCloudStorage 取群成员成绩的唯一钥匙;
 *   - success 回调只代表"分享动作完成",不代表对方点开,不要据此发重奖。
 *
 * ⚠️ 合规红线(触犯即驳回):
 *   禁止强制分享("分享后才能继续");禁止诱导分享("分享给3个群")。
 *   分享必须是玩家的可选行为。
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');
const EventBus = require('../framework/event-bus.js');
const WX = require('./wx-adapter.js');

/* 软件名从 config 单一来源取 —— 软著登记要求名称在多处逐字一致,
 * 所以这里不再写字面量(见 config.js 的 GAME_NAME 注释)。 */
const GAME_NAME = cfg.GAME_NAME;

let currentShare = null;      // 当前场景提供的分享内容工厂
let lastShareTicket = null;

module.exports = {
  /** 由 main.js 在启动时调用一次 */
  init() {
    if (!cfg.ENABLE_SHARE) return;

    // 开启右上角转发 + 朋友圈(基础库支持时)
    WX.showShareMenu();

    // 场景切换时更新分享内容
    EventBus.on('share:update', (factory) => { currentShare = factory; });

    // 全局转发回调:优先用场景注册的内容
    wx.onShareAppMessage(() => {
      const payload = typeof currentShare === 'function' ? currentShare() : currentShare;
      return module.exports.buildPayload(payload || {});
    });

    // 朋友圈分享(部分版本支持)
    if (typeof wx.onShareTimeline === 'function') {
      wx.onShareTimeline(() => {
        const payload = typeof currentShare === 'function' ? currentShare() : currentShare;
        return {
          title: (payload && payload.title) || ('来玩《' + GAME_NAME + '》'),
          query: (payload && payload.query) || 'from=timeline',
          imageUrl: (payload && payload.imageUrl) || './assets/images/share-card.png',
        };
      });
    }

    Logger.log('share module ready');
  },

  /** 组装分享参数,统一补全归因参数 */
  buildPayload(p) {
    const query = p.query ? p.query + '&from=share' : 'from=share';
    return {
      title: p.title || ('来挑战《' + GAME_NAME + '》'),
      imageUrl: p.imageUrl || './assets/images/share-card.png',
      query,
    };
  },

  /** 场景注册自己的分享内容 */
  setShareContent(factory) {
    currentShare = factory;
  },

  /**
   * 主动拉起分享面板(玩家点击"炫耀一下"按钮时调用)。
   * @returns {Promise<{shared:boolean}>} shared=false 表示玩家取消了
   */
  share(extra) {
    return new Promise((resolve) => {
      if (!cfg.ENABLE_SHARE) return resolve({ shared: false });
      const cur = typeof currentShare === 'function' ? currentShare() : currentShare;
      const payload = module.exports.buildPayload(Object.assign({}, cur || {}, extra || {}));

      try {
        wx.shareAppMessage({
          title: payload.title,
          imageUrl: payload.imageUrl,
          query: payload.query,
          success: () => {
            Logger.log('share success');
            EventBus.emit('share:success', extra || {});
            // 埋点:分享是核心增长指标,必须上报
            EventBus.emit('analytics:track', { name: 'share_click', props: { scene: (extra && extra.scene) || '' } });
            resolve({ shared: true });
          },
          fail: () => resolve({ shared: false }),
        });
      } catch (e) {
        Logger.warn('share failed:', e);
        resolve({ shared: false });
      }
    });
  },

  /** 记录通过分享卡片进入的 shareTicket(群榜数据入口) */
  captureShareTicket(opts) {
    if (opts && opts.shareTicket) {
      lastShareTicket = opts.shareTicket;
      Logger.log('got shareTicket');
      EventBus.emit('share:ticket', lastShareTicket);
    }
    return lastShareTicket;
  },

  getShareTicket() { return lastShareTicket; },

  /**
   * 上报最高分到开放数据域可读的托管数据。
   * 好友榜/群榜的数据源,必须先调这个,子域才能读到。
   */
  uploadScoreToOpenData(score) {
    return new Promise((resolve) => {
      if (typeof wx.setUserCloudStorage !== 'function') return resolve(false);
      wx.setUserCloudStorage({
        KVDataList: [
          { key: 'score', value: String(score) },
          { key: 'update_time', value: String(Date.now()) },
        ],
        success: () => resolve(true),
        fail: () => resolve(false),
      });
    });
  },
};
