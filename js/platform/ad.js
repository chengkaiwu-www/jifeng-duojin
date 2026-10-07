/**
 * platform/ad.js —— 广告(激励视频 / 插屏 / Banner)
 *
 * 变现前提:先在小游戏后台开通"流量主",并创建广告位拿到 adUnitId。
 * 本项目 MVP 阶段默认关闭(config.ENABLE_AD = false),玩法验证后再开。
 *
 * 合规红线:
 *   - 激励视频必须由玩家"主动点击"触发,禁止自动播放;
 *   - 禁止"不看完广告就不能继续游戏"这类强制设计;
 *   - 广告奖励的发放必须在服务端做幂等(见 cloudfunctions/submitScore 的做法)。
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');
const EventBus = require('../framework/event-bus.js');

let rewardedAd = null;
let rewardedLoaded = false;
let rewardedUnitId = '';    // 填入你的激励视频广告位 ID

module.exports = {
  /**
   * 广告是否**真的可用**(已开通 + 已配广告位 + 实例创建成功)。
   *
   * ★ 场景层必须用它来决定"广告按钮要不要出现",而不是直接看 `cfg.ENABLE_AD` ——
   *   开关打开但广告位 ID 还没填(或创建失败)时,按钮若照样出现,
   *   玩家点下去只会得到"暂无广告",那比没有按钮更糟。
   */
  isAvailable() {
    return !!(cfg.ENABLE_AD && rewardedAd);
  },

  /**
   * 初始化激励视频实例。小游戏要求视频实例全局复用,不要每次创建。
   * @param {string} [adUnitId] 不传 = 读 config.AD_UNITS.rewarded
   */
  initRewarded(adUnitId) {
    const unitId = adUnitId || (cfg.AD_UNITS && cfg.AD_UNITS.rewarded) || '';
    if (!cfg.ENABLE_AD || !unitId) return false;
    if (typeof wx.createRewardedVideoAd !== 'function') {
      Logger.warn('createRewardedVideoAd not supported');
      return false;
    }
    rewardedUnitId = unitId;
    rewardedAd = wx.createRewardedVideoAd({ adUnitId: unitId });

    rewardedAd.onLoad(() => { rewardedLoaded = true; Logger.log('rewarded ad loaded'); });
    rewardedAd.onError((err) => {
      rewardedLoaded = false;
      Logger.warn('rewarded ad error:', err);
      EventBus.emit('ad:error', err);
    });
    rewardedAd.onClose((res) => {
      // isEnded === true 表示完整观看,才可发奖
      const completed = !!(res && res.isEnded);
      Logger.log('rewarded ad closed, completed =', completed);
      EventBus.emit('ad:rewarded', { completed });
    });
    return true;
  },

  /**
   * 播放激励视频。
   * 注意:广告拉取可能失败(无填充),必须给玩家友好提示,不能让按钮点了没反应。
   * @returns {Promise<{completed:boolean, reason?:string}>}
   */
  showRewarded() {
    return new Promise((resolve) => {
      if (!cfg.ENABLE_AD || !rewardedAd) {
        return resolve({ completed: false, reason: 'not_configured' });
      }

      const onReward = (res) => {
        EventBus.off('ad:rewarded', onReward);
        EventBus.off('ad:error', onError);
        resolve({ completed: !!(res && res.completed) });
      };
      const onError = (err) => {
        EventBus.off('ad:rewarded', onReward);
        EventBus.off('ad:error', onError);
        resolve({ completed: false, reason: 'ad_error' });
      };

      EventBus.on('ad:rewarded', onReward);
      EventBus.on('ad:error', onError);

      rewardedAd.show().catch(() => {
        // 拉取失败时重试一次加载
        rewardedAd.load()
          .then(() => rewardedAd.show())
          .catch((err) => {
            Logger.warn('rewarded ad show failed:', err);
            onError(err);
          });
      });
    });
  },

  /** 插屏广告(过场时展示,注意频率,过密会被判骚扰) */
  showInterstitial(adUnitId) {
    if (!cfg.ENABLE_AD || !adUnitId || typeof wx.createInterstitialAd !== 'function') return;
    try {
      const ad = wx.createInterstitialAd({ adUnitId });
      ad.show().catch(() => { /* 无填充时静默失败 */ });
    } catch (e) { /* ignore */ }
  },

  /** Banner 广告 */
  showBanner(opt) {
    if (!cfg.ENABLE_AD || typeof wx.createBannerAd !== 'function') return null;
    try {
      const banner = wx.createBannerAd({
        adUnitId: opt.adUnitId,
        style: {
          left: opt.left || 0,
          top: opt.top || 0,
          width: opt.width || 300,
        },
      });
      banner.show();
      return banner;
    } catch (e) {
      return null;
    }
  },
};
