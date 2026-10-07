/**
 * cloudfunctions/submitScore/index.js —— 分数上报 + 服务端防作弊
 *
 * 核心原则:客户端算出来的分数一律不可信。
 * 小游戏的 JS 代码对用户完全可见,改分数只需要一行代码,
 * 所以"服务端校验"不是可选项,是必需项。
 *
 * 这里实现四道防线,成本很低但能挡掉绝大多数作弊:
 *   ① 类型与合法性校验
 *   ② 物理上限校验(分数 <= 每秒最高分 × 实际时长)
 *   ③ 时长下限校验(低于最短时长的上报判为异常)
 *   ④ 频率限流(同一用户单位时间内的上报次数)
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const scoresCol = db.collection('scores');
const statsCol = db.collection('user_stats');
const eventsCol = db.collection('events');

/* ===== 服务端校验参数:必须与客户端 js/gameplay/modes.js 逐值一致 =====
 *
 * 玩法:竖版躲障跑酷 ——「红色的躲,金色的抢,边缘的险」
 *   客户端计分 = 存活秒数 × BASE_SCORE_PER_SECOND
 *              + 躲避红块次数 × DODGE_SCORE
 *              + 擦身而过次数 × GRAZE_SCORE
 *              + 命满时拾取金块的累计加分(PICKUP_SCORE)
 *
 * ⚠️ 多模式之后,上限**不再是一个数字**,而是一张按模式区分的表。
 *    这是必需的:疾风模式的合法上限是 47 分/秒,经典是 32。
 *    两者共用一个上限的话,疾风玩家的正常成绩会被判作弊 ——
 *    那比作弊更严重(作弊损失的是榜单,误判损失的是玩家)。
 *
 * 每秒上限推导(每项都按"理论上限"取,即玩家每一帧都做到最好):
 *   存活 = BASE_SCORE_PER_SECOND
 *   躲避 = DODGE_SCORE  / SPAWN_MIN_INTERVAL
 *   擦身 = GRAZE_SCORE  / SPAWN_MIN_INTERVAL   (每个红块最多擦身一次)
 *   拾取 = PICKUP_SCORE × COMBO_MAX / PICKUP_INTERVAL
 *
 *   经典  10 + 5/0.45 + 2/0.45 + 8×1/1.6  ≈ 30.56 → 32
 *   疾风  12 + 6/0.30 + 3/0.30 + 6×1/1.8  ≈ 45.33 → 47
 *   金潮  10 + 5/0.40 + 2/0.40 + 6×3/0.95 ≈ 46.45 → 49
 *   死线  14 + 6/0.38 + 3/0.38 + 10/1.2   ≈ 46.02 → 48
 *
 * ⚠️ 金潮那一项多了一个 ×3 —— 它开着**拾取连击链**,倍率最高 3 倍。
 *    上限必须按"每一次拾取都吃满倍率"这种理论最坏情况来算,
 *    否则一个真把连击打满的高手会被服务端判成作弊。
 *    这里宁可放宽,也不能误杀:作弊损失的是榜单,误判损失的是玩家。
 *
 * ⚠️ 客户端改任何一个计分参数(含 modes.js 里的模式覆盖值),这张表必须同步重算。
 *    `.workbuddy/tmp/test-modes.js` 会逐值比对两端,防的就是"改了客户端忘了改服务端"。
 *    设小了正常玩家被判作弊(体验事故),设大了作弊者能刷上榜首(数据事故)。
 *
 * maxDuration 也按模式分:死线模式限时 60 秒,上报一个 300 秒的时长
 * 从物理上就不可能 —— 这比统一的 900 秒上限严得多。
 *
 * scoreboard 决定该模式的成绩**是否写进 user_stats(全服榜的数据源)**。
 * 只有经典为 true:一张榜只有一把尺子才是可比的(理由见下方写库处)。
 */
const MODE_LIMITS = {
  classic:  { maxScorePerSecond: 32, maxDuration: 900, scoreboard: true  },
  gale:     { maxScorePerSecond: 47, maxDuration: 900, scoreboard: false },
  rush:     { maxScorePerSecond: 49, maxDuration: 900, scoreboard: false },
  deadline: { maxScorePerSecond: 48, maxDuration: 90,  scoreboard: false },
};
const DEFAULT_MODE = 'classic';    // 未知模式按经典校验:不拒收(会丢玩家成绩),也不放宽
const MIN_DURATION = 2;            // 单局最短有效时长(秒)。本玩法是"活多久算多久",设太大会误杀新手
const RATE_WINDOW_MS = 60 * 1000;  // 限流窗口
const RATE_MAX_CALLS = 20;         // 窗口内最大上报次数

const OK = (data) => ({ code: 0, data });

/** 埋点批量写入(与分数上报共用一个函数,减少函数数量与冷启动次数) */
async function trackEvents(openid, events) {
  if (!Array.isArray(events) || !events.length) return;
  // 单次最多写 30 条,超出截断,防止被刷爆
  const list = events.slice(0, 30).map((e) => ({
    _openid: openid,
    name: String(e.name || '').slice(0, 40),
    props: (e.props && typeof e.props === 'object') ? e.props : {},
    clientTs: Number(e.ts) || Date.now(),
    ts: Date.now(),
  }));
  try {
    await eventsCol.add({ data: list });
  } catch (e) {
    // 埋点写入失败绝不能影响主流程
    console.warn('[submitScore] track failed', e && e.message);
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: 401, msg: 'cannot resolve openid' };

  /* ---------- 埋点上报分支 ---------- */
  if (event && event.action === 'track') {
    await trackEvents(openid, event.events);
    return OK({ tracked: true });
  }

  const now = Date.now();
  const score = Number(event && event.score);
  const duration = Number(event && event.duration);
  /* mode 是防作弊校验的**输入之一**,不是装饰字段:它决定用哪一行上限。
   * 未知模式回落经典,而不是拒绝上报 —— 客户端版本比服务端新时,
   * 一个没见过的模式名不该让玩家平白丢成绩。 */
  const mode = String((event && event.mode) || DEFAULT_MODE).slice(0, 16);
  const limit = MODE_LIMITS[mode] || MODE_LIMITS[DEFAULT_MODE];

  /* ===== 防线 ①:类型与合法性 ===== */
  if (!isFinite(score) || !isFinite(duration) || score < 0 || duration < 0) {
    return OK({ accepted: false, reason: 'invalid_payload' });
  }

  /* ===== 防线 ③:时长下限 / 上限(上限按模式) ===== */
  if (duration < MIN_DURATION || duration > limit.maxDuration) {
    return OK({ accepted: false, reason: 'invalid_duration' });
  }

  /* ===== 防线 ②:物理上限(按模式) =====
     注意这里用的是"上报时长",而不是固定的单局上限 —— 因为玩家可能中途退出。 */
  const theoreticalMax = Math.floor(limit.maxScorePerSecond * duration);
  if (score > theoreticalMax) {
    console.warn('[submitScore] cheat detected', { openid, mode, score, duration, theoreticalMax });
    return OK({ accepted: false, reason: 'score_exceeds_limit' });
  }

  try {
    /* ===== 防线 ④:频率限流 ===== */
    const recent = await scoresCol.where({
      _openid: openid,
      createdAt: _.gt(now - RATE_WINDOW_MS),
    }).count();

    if (recent.total >= RATE_MAX_CALLS) {
      return OK({ accepted: false, reason: 'rate_limited' });
    }

    /* ---------- 写库 ---------- */
    // ① 所有模式、所有局次都记一条(scores 表)—— 用于数据分析与调参,
    //    只保留必要字段,避免写放大。
    await scoresCol.add({
      data: {
        _openid: openid,
        score,
        duration,
        mode,
        isBest: false,
        createdAt: now,
      },
    });

    /* ② 只有**计入榜单的模式**(目前只有经典)才更新 user_stats。
     *
     *    为什么必须分开:user_stats.bestScore 是全服榜排序的唯一依据。
     *    疾风模式的上限是 47 分/秒,比经典的 32 高一半 ——
     *    如果它也往里写,榜单前几名会被"疾风玩家"占满,
     *    而他们和经典玩家玩的根本不是同一个难度。
     *    **一张榜只有一把尺子,才是可比的。** */
    if (!limit.scoreboard) {
      return OK({
        accepted: true, score, mode, scoreboard: false, serverTime: now,
      });
    }

    const statRes = await statsCol.where({ _openid: openid }).limit(1).get();
    let stat = statRes.data && statRes.data[0];

    if (!stat) {
      // 兜底:统计记录缺失时补建(老用户或异常情况)
      await statsCol.add({
        data: {
          _openid: openid, bestScore: 0, totalGames: 0, totalDuration: 0,
          winStreak: 0, updatedAt: now,
        },
      });
      stat = { bestScore: 0, totalGames: 0, totalDuration: 0 };
    }

    const prevBest = stat.bestScore || 0;
    const isNewBest = score > prevBest;
    const best = isNewBest ? score : prevBest;

    await statsCol.where({ _openid: openid }).update({
      data: {
        bestScore: best,
        totalGames: _.inc(1),
        totalDuration: _.inc(duration),
        winStreak: isNewBest ? _.inc(1) : 0,
        updatedAt: now,
      },
    });

    /* ---------- 计算名次 ----------
       名次 = 比我最高分更高的人数 + 1
       count 在大数据量下比拉全表排序便宜得多,适合做实时名次。 */
    let rank = 1;
    let total = 0;
    try {
      const higher = await statsCol.where({ bestScore: _.gt(best) }).count();
      rank = higher.total + 1;
      const all = await statsCol.count();
      total = all.total;
    } catch (e) {
      // 名次计算失败不影响成绩记录,返回不带名次的结果即可
      console.warn('[submitScore] rank calc failed', e && e.message);
    }

    return OK({
      accepted: true,
      score,
      best,
      isNewBest,
      rank,
      total,
      mode,
      scoreboard: true,
      serverTime: now,
    });
  } catch (e) {
    console.error('[submitScore] error', e);
    return { code: 500, msg: 'internal error' };
  }
};
