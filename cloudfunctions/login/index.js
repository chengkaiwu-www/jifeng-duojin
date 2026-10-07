/**
 * cloudfunctions/login/index.js —— 登录 / 注册 / 拉取远程配置
 *
 * 安全要点:OPENID 只能从 cloud.getWXContext() 取,永远不信任客户端传入的任何身份字段。
 * 这是云开发最大的价值 —— 鉴权由平台完成,客户端无法伪造。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const usersCol = db.collection('users');
const statsCol = db.collection('user_stats');
const configsCol = db.collection('configs');

const OK = (data) => ({ code: 0, data });
const ERR = (code, msg) => ({ code, msg });

/** 生成一个默认昵称,避免"未命名玩家"占满榜单 */
function defaultNickname(openid) {
  let hash = 0;
  for (let i = 0; i < openid.length; i++) {
    hash = (hash * 31 + openid.charCodeAt(i)) % 100000;
  }
  return '玩家' + String(hash).padStart(5, '0');
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!openid) return ERR(401, 'cannot resolve openid');

  const action = (event && event.action) || 'login';

  try {
    /* ---------- 拉取远程配置(用于线上动态开关,改配置不用重新提审) ---------- */
    if (action === 'getConfig') {
      const res = await configsCol.limit(100).get();
      const configs = {};
      (res.data || []).forEach((doc) => { configs[doc.key] = doc.value; });
      return OK({ configs });
    }

    /* ---------- 更新昵称头像(玩家主动填写后调用) ---------- */
    if (action === 'updateProfile') {
      const patch = {};
      if (typeof event.nickname === 'string' && event.nickname.trim()) {
        patch.nickname = event.nickname.trim().slice(0, 20);
      }
      if (typeof event.avatar === 'string' && event.avatar) {
        patch.avatar = event.avatar;
      }
      if (Object.keys(patch).length) {
        await usersCol.where({ _openid: openid }).update({ data: patch });
        await statsCol.where({ _openid: openid }).update({ data: patch });
      }
      return OK({ updated: true });
    }

    /* ---------- 默认:登录 / 首次注册 ---------- */
    const now = Date.now();
    const exist = await usersCol.where({ _openid: openid }).limit(1).get();

    if (exist.data && exist.data.length) {
      const user = exist.data[0];
      // 更新活跃时间与渠道(渠道只在首次登录时记录,避免被后续覆盖)
      const patch = { lastActiveAt: now };
      await usersCol.doc(user._id).update({ data: patch });

      return OK({
        openid,
        nickname: user.nickname,
        avatar: user.avatar,
        level: user.level || 1,
        isNew: false,
        serverTime: now,
      });
    }

    // 首次登录:创建用户档案 + 统计记录
    const nickname = defaultNickname(openid);
    const profile = {
      _openid: openid,
      nickname,
      avatar: '',
      level: 1,
      channel: (event && event.channel) || '',
      createdAt: now,
      lastActiveAt: now,
    };
    const added = await usersCol.add({ data: profile });

    await statsCol.add({
      data: {
        _openid: openid,
        nickname,
        avatar: '',
        bestScore: 0,
        totalGames: 0,
        totalDuration: 0,
        winStreak: 0,
        updatedAt: now,
      },
    });

    return OK({
      openid,
      nickname,
      avatar: '',
      level: 1,
      isNew: true,
      userId: added._id,
      serverTime: now,
    });
  } catch (e) {
    console.error('[login] error', e);
    return ERR(500, 'internal error');
  }
};
