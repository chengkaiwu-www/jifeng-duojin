/**
 * platform/lifecycle.js —— 小游戏生命周期
 *
 * 小游戏的生命周期比小程序简单得多,但每一条都直接影响稳定性:
 *   onShow   回前台 → 恢复主循环、检查是否需要补报数据
 *   onHide   切后台 → 必须立刻暂停主循环和音频,否则回前台掉帧/闪退
 *   onError  JS 异常 → 必须上报,否则线上问题完全不可见
 *   onMemoryWarning 内存告警 → 主动释放资源,这是防闪退的最后一道闸
 */
const Logger = require('../utils/logger.js');
const EventBus = require('../framework/event-bus.js');

module.exports = {
  init(handlers) {
    const h = handlers || {};

    wx.onShow((opts) => {
      Logger.log('app onShow', opts);
      EventBus.emit('game:show', opts || {});
      if (h.onShow) h.onShow(opts || {});
    });

    wx.onHide(() => {
      Logger.log('app onHide');
      // 注意:这里不做任何耗时操作,微信只给很短的执行窗口
      EventBus.emit('game:hide', {});
      if (h.onHide) h.onHide();
    });

    // 错误监控:线上问题的唯一可见来源,务必保留
    wx.onError((err) => {
      Logger.error('app onError:', err);
      EventBus.emit('analytics:track', {
        name: 'js_error',
        props: { msg: String(err).slice(0, 200) },
      });
    });

    // 未捕获的 Promise 异常(小游戏基础库较新版本支持)
    if (typeof wx.onUnhandledRejection === 'function') {
      wx.onUnhandledRejection((res) => {
        Logger.error('unhandled rejection:', res && res.reason);
        EventBus.emit('analytics:track', {
          name: 'promise_rejection',
          props: { msg: String(res && res.reason).slice(0, 200) },
        });
      });
    }

    // 内存告警:低端机的分水岭,收到就释放资源
    wx.onMemoryWarning((res) => {
      Logger.warn('memory warning, level =', res && res.level);
      EventBus.emit('game:memory-warning', res || {});
      if (h.onMemoryWarning) h.onMemoryWarning(res || {});
    });

    // 音频中断(来电、其他 App 播放音乐),必须暂停并提示玩家
    if (typeof wx.onAudioInterruptionBegin === 'function') {
      wx.onAudioInterruptionBegin(() => EventBus.emit('audio:interrupt', { type: 'begin' }));
      wx.onAudioInterruptionEnd(() => EventBus.emit('audio:interrupt', { type: 'end' }));
    }
  },
};
