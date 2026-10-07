/**
 * platform/auth.js —— 登录与用户档案
 *
 * 云开发场景下的登录极简:
 *   调用 login 云函数,服务端通过 cloud.getWXContext() 拿到 OPENID,
 *   首次进入则注册用户档案,返回给客户端。
 *
 * 安全要点:客户端永远不传 openid,也永远不缓存"服务端身份"。
 * 每次调用云函数,服务端都能独立拿到可信的 OPENID,这是云开发的天然优势。
 */
const Logger = require('../utils/logger.js');
const Cloud = require('./cloud.js');
const EventBus = require('../framework/event-bus.js');

let user = null;         // { openid, nickname, avatar, level, isNew }
let loggingIn = null;    // 登录中的 Promise,防止并发重复登录

const USER_KEY = 'user_profile';

module.exports = {
  /**
   * 静默登录。失败不阻塞游戏 —— 返回 null,调用方走游客态。
   * @param {{channel?:string}} [opt]
   */
  login(opt) {
    if (user) return Promise.resolve(user);
    if (loggingIn) return loggingIn;

    const o = opt || {};
    loggingIn = Cloud.call('login', { channel: o.channel || '' }, { retry: 1, silent: true })
      .then((data) => {
        user = data || null;
        if (user) {
          wx.setStorageSync('mg_user_profile', user);
          Logger.log('login ok, isNew =', user.isNew);
          EventBus.emit('auth:success', user);
        }
        loggingIn = null;
        return user;
      })
      .catch((err) => {
        Logger.warn('login failed, fallback to guest:', err && err.message);
        loggingIn = null;
        // 降级:用上次缓存的档案,进入游客/离线态
        try { user = wx.getStorageSync('mg_user_profile') || null; } catch (e) { user = null; }
        EventBus.emit('auth:failed', err);
        return user;
      });

    return loggingIn;
  },

  getUser() { return user; },
  isLoggedIn() { return !!user; },

  /**
   * 获取用户昵称头像(需用户主动触发,不能启动就弹 —— 会被审核判定为骚扰)。
   * 小游戏里推荐使用 wx.getUserProfile 的替代方案:让用户自己填写昵称,
   * 或使用平台提供的头像昵称填写能力(以官方最新文档为准)。
   */
  requestProfile() {
    return new Promise((resolve) => {
      if (module.exports.canGetUserInfo()) {
        wx.getUserProfile({
          desc: '用于展示排行榜昵称与头像',
          success: (res) => {
            const info = res.userInfo || {};
            if (user) {
              user.nickname = info.nickName;
              user.avatar = info.avatarUrl;
              Cloud.report('login', { action: 'updateProfile', nickname: info.nickName, avatar: info.avatarUrl });
            }
            resolve(info);
          },
          fail: () => resolve(null),
        });
      } else {
        resolve(null);
      }
    });
  },

  canGetUserInfo() {
    return typeof wx.getUserProfile === 'function';
  },

  logout() {
    user = null;
    try { wx.removeStorageSync('mg_user_profile'); } catch (e) { /* ignore */ }
  },
};
