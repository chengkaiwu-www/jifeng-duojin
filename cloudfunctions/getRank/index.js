/**
 * cloudfunctions/getRank/index.js —— 排行榜查询
 *
 * 双轨榜中的"全服榜/周榜"。零授权成本,是冷启动阶段的主榜。
 * 好友榜走开放数据域,不在这里实现(见 openDataContext/index.js)。
 *
 * 性能要点:
 *   榜单是"读多写少"的典型场景,必须做缓存。
 *   直接 orderBy + limit 在数据量大时会成为热点,这里加了一层
 *   基于 configs 集合的轻量缓存(缓存 60 秒),避免高并发下反复扫表。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const statsCol = db.collection('user_stats');
const configsCol = db.collection('configs');

const CACHE_TTL = 60 * 1000;         // 榜单缓存 60 秒
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const OK = (data) => ({ code: 0, data });

/** 读缓存 */
async function readCache(key) {
  try {
    const res = await configsCol.where({ key }).limit(1).get();
    const doc = res.data && res.data[0];
    if (doc && doc.value && (Date.now() - (doc.value.ts || 0)) < CACHE_TTL) {
      return doc.value;
    }
  } catch (e) { /* 缓存不可用时直接查库 */ }
  return null;
}

/** 写缓存(失败不影响返回) */
async function writeCache(key, value) {
  try {
    const res = await configsCol.where({ key }).limit(1).get();
    const payload = Object.assign({}, value, { ts: Date.now() });
    if (res.data && res.data.length) {
      await configsCol.doc(res.data[0]._id).update({ data: { value: payload } });
    } else {
      await configsCol.add({ data: { key, value: payload } });
    }
  } catch (e) { /* ignore */ }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const type = (event && event.type) || 'global';       // 'global' | 'weekly'
  const limit = Math.min(Math.max(Number((event && event.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);

  try {
    const cacheKey = 'rank_cache_' + type + '_' + limit;
    let list = await readCache(cacheKey);

    if (!list) {
      /* ---------- 全服榜:按历史最高分降序 ---------- */
      const res = await statsCol
        .orderBy('bestScore', 'desc')
        .orderBy('updatedAt', 'asc')      // 同分时先达到的人排前面
        .limit(limit)
        .field({ _openid: true, nickname: true, avatar: true, bestScore: true })
        .get();

      list = (res.data || [])
        .filter((d) => (d.bestScore || 0) > 0)   // 过滤掉 0 分,避免新用户占满榜单
        .map((d, i) => ({
          rank: i + 1,
          openid: d._openid,
          nickname: d.nickname || '玩家',
          avatar: d.avatar || '',
          score: d.bestScore || 0,
          isMe: d._openid === openid,
        }));

      await writeCache(cacheKey, list);
    } else {
      // 缓存命中时,isMe 必须按当前请求者重新计算
      list = list.map((item) => Object.assign({}, item, { isMe: item.openid === openid }));
    }

    /* ---------- 我的名次与总分 ----------
       注意:这两项不能走缓存,必须实时算,否则玩家刚打完一局看到的名次是旧的。 */
    let myRank = null;
    try {
      const statRes = await statsCol.where({ _openid: openid }).limit(1).get();
      const stat = statRes.data && statRes.data[0];
      if (stat && (stat.bestScore || 0) > 0) {
        const higher = await statsCol.where({ bestScore: _.gt(stat.bestScore) }).count();
        myRank = {
          rank: higher.total + 1,
          score: stat.bestScore,
        };
      }
    } catch (e) {
      console.warn('[getRank] myRank failed', e && e.message);
    }

    return OK({ type, list, myRank, cachedAt: Date.now() });
  } catch (e) {
    console.error('[getRank] error', e);
    return { code: 500, msg: 'internal error' };
  }
};
