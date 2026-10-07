/**
 * framework/storage.js —— 本地存档
 *
 * 三层存档策略中的"第一层":
 *   实时写本地(本模块) → 关键节点异步上云(platform/cloud.js) → 云端乐观锁兜底
 *
 * 设计要点:
 *   1. 统一前缀命名空间,避免与其他数据混淆;
 *   2. 带 schema 版本号,后续改存档结构时能做迁移而不丢玩家进度;
 *   3. 所有读写包 try/catch —— 存储写满或数据损坏时不能让游戏崩掉。
 */
const Logger = require('../utils/logger.js');

const NS = 'mg_';
const ARCHIVE_KEY = 'archive';
const ARCHIVE_VERSION = 4;

/**
 * 存档默认结构。
 *
 * ⚠️ 关于 career:
 *   它是 js/gameplay/career.js 管的生涯统计,但**这里只当作一个不透明的对象**存着,
 *   framework 层不认识它的内部结构 —— 这是刻意的,framework 不允许依赖 gameplay
 *   (依赖方向是 gameplay → framework,反过来会让分层失效)。
 *   所以这里存 null,读出来的地方调 Career.normalize() 归一化。
 */
function defaultArchive() {
  return {
    version: ARCHIVE_VERSION,
    bestScore: 0,
    totalGames: 0,
    coins: 0,
    level: 1,
    lastSignDate: '',
    signStreak: 0,
    updatedAt: 0,
    cloudVersion: 0,   // 乐观锁:每次成功上云后 +1

    /* --- 成长系统(v2 新增) --- */
    career: null,             // 生涯统计,结构见 gameplay/career.js
    equippedSkin: 'origin',   // 当前装备的造型 id
    ownedSkins: ['origin'],   // 已拥有的造型 id 列表;默认造型永远在里面
    achievements: {},         // { 成就id: 1 } —— 用对象做 O(1) 判断

    /* --- 签到(v3 新增) --- */
    signTotal: 0,             // 累计签到**总天数**(不要求连续,用于里程碑)
    signMile: {},             // { 里程碑天数: 1 } —— 已领取的累计签到里程碑

    /* --- 玩法模式(v4 新增) ---
     * ⚠️ mode 存**空串**而不是 'classic':同样是分层纪律 ——
     *    框架层不认识"模式"的语义(就像它把 career 当成一个不透明对象存着)。
     *    空串交给 gameplay/modes.js 的 get() 决议成默认模式,那边是唯一知道
     *    "默认模式是哪一个"的地方。存档被手改成不存在的 id 也不会崩,只会回落。 */
    mode: '',                 // 当前选中的玩法模式 id
    bestByMode: {},           // { 模式id: 最高分 } —— 各模式分数不可比,纪录必须分开记
  };
}

/** 版本迁移入口:升级存档结构时在这里补字段,老玩家数据不会丢 */
function migrate(data) {
  if (!data || typeof data !== 'object') return defaultArchive();
  const base = defaultArchive();
  const merged = Object.assign(base, data);
  merged.version = ARCHIVE_VERSION;

  // v1 → v2:老存档没有成长系统字段,补上默认值。
  // 注意 Object.assign 只在"键不存在"时才保留默认值,而老存档里这些键本来就没有,
  // 所以直接靠 base 兜底即可;这里额外做的是**类型纠错** ——
  // 存档可能被用户手改过或被旧版本写坏,一个非数组的 ownedSkins 会让图鉴直接崩。
  if (!Array.isArray(merged.ownedSkins)) merged.ownedSkins = ['origin'];
  if (merged.ownedSkins.indexOf('origin') === -1) merged.ownedSkins.push('origin');
  if (!merged.achievements || typeof merged.achievements !== 'object' ||
      Array.isArray(merged.achievements)) {
    merged.achievements = {};
  }
  if (typeof merged.equippedSkin !== 'string' || !merged.equippedSkin) {
    merged.equippedSkin = 'origin';
  }
  if (typeof merged.coins !== 'number' || !isFinite(merged.coins) || merged.coins < 0) {
    merged.coins = 0;
  }

  // v2 → v3:签到改成"7 天周期 + 累计里程碑",新增两个字段。
  // 老存档没有它们 → 由 base 兜底为 0 / {}。这里同样只做类型纠错:
  // signTotal 是 NaN 会让签到页显示"累计 NaN 天",signMile 不是对象会让 `claimed[m.days]` 直接抛。
  const st = Number(merged.signTotal);
  merged.signTotal = (isFinite(st) && st >= 0) ? Math.floor(st) : 0;
  if (!merged.signMile || typeof merged.signMile !== 'object' || Array.isArray(merged.signMile)) {
    merged.signMile = {};
  }
  const ss = Number(merged.signStreak);
  merged.signStreak = (isFinite(ss) && ss >= 0) ? Math.floor(ss) : 0;
  if (typeof merged.lastSignDate !== 'string') merged.lastSignDate = '';

  // v3 → v4:玩法模式。老存档没有这两个字段 → 由 base 兜底。
  // 这里只做类型纠错,不校验"模式 id 是否存在" —— 那是 gameplay 的知识,
  // 框架层一旦开始判断业务字段的合法值,分层就开始漏了。
  if (typeof merged.mode !== 'string') merged.mode = '';
  if (!merged.bestByMode || typeof merged.bestByMode !== 'object' ||
      Array.isArray(merged.bestByMode)) {
    merged.bestByMode = {};
  } else {
    // 值必须收敛成非负整数 —— 一个 NaN 会让"最高分"显示成 NaN,
    // 而且会污染 isBetter 的比较(NaN > x 恒为 false,纪录再也刷不新)
    const out = {};
    const keys = Object.keys(merged.bestByMode);
    for (let i = 0; i < keys.length; i++) {
      const v = Number(merged.bestByMode[keys[i]]);
      if (isFinite(v) && v > 0) out[keys[i]] = Math.floor(v);
    }
    merged.bestByMode = out;
  }

  return merged;
}

module.exports = {
  get(key, fallback) {
    try {
      const v = wx.getStorageSync(NS + key);
      return (v === '' || v === null || v === undefined) ? fallback : v;
    } catch (e) {
      Logger.warn('storage.get failed:', key, e);
      return fallback;
    }
  },

  set(key, value) {
    try {
      wx.setStorageSync(NS + key, value);
      return true;
    } catch (e) {
      Logger.warn('storage.set failed:', key, e);
      return false;
    }
  },

  remove(key) {
    try { wx.removeStorageSync(NS + key); } catch (e) { /* ignore */ }
  },

  /** 读取本地存档(始终返回完整结构) */
  loadArchive() {
    const raw = module.exports.get(ARCHIVE_KEY, null);
    return migrate(raw);
  },

  /** 写入本地存档 */
  saveArchive(archive) {
    archive.updatedAt = Date.now();
    return module.exports.set(ARCHIVE_KEY, archive);
  },

  /** 用云端数据覆盖本地(仅当云端更新时调用) */
  applyCloudArchive(cloudData) {
    if (!cloudData) return null;
    const local = module.exports.loadArchive();
    // 云端版本号更大才覆盖,避免旧数据回滚本地进度
    if ((cloudData.cloudVersion || 0) >= (local.cloudVersion || 0)) {
      const merged = migrate(Object.assign(local, cloudData));
      module.exports.saveArchive(merged);
      return merged;
    }
    return local;
  },

  resetArchive() {
    const fresh = defaultArchive();
    module.exports.saveArchive(fresh);
    return fresh;
  },
};
