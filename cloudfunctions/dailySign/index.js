/**
 * cloudfunctions/dailySign/index.js —— 每日签到
 *
 * 两个必须做对的点:
 *   ① 幂等 —— 玩家断网重连后重复提交是常态,不是异常。
 *      用 (openid + 日期) 构建唯一记录,重复提交直接返回"已签到",不会重复发奖。
 *   ② 时区 —— 云函数运行在 UTC,必须手动 +8 小时才是北京时间,
 *      否则玩家在 0:00~8:00 之间签到会算到前一天。
 *
 * ⚠️ 奖励公式与 `js/gameplay/checkin.js` **必须保持一致**(7 天周期,第 7 格大奖)。
 *    这份副本存在的意义只是"后台留一条可查的记录",金币以客户端本地存档为准
 *    (作品定位、无付费,不存在刷奖励动机,见 home/signin 场景里的说明)。
 *    改周期参数时**两处一起改** —— 客户端 config.ECONOMY.SIGN_* 与这里的常量。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const signCol = db.collection('sign_logs');
const archivesCol = db.collection('archives');

const OK = (data) => ({ code: 0, data });

const BASE_REWARD = 100;   // 周期第 1 格
const STREAK_BONUS = 20;   // 周期内每往后一格多给的金币
const CYCLE_DAYS = 7;      // 周期长度(天)
const CYCLE_BONUS = 200;   // 周期最后一格的额外大奖

/** streak 落在周期的第几格(1..CYCLE_DAYS) */
function cycleIndexOf(streak) {
  const s = Math.floor(Number(streak) || 0);
  if (s <= 0) return 1;
  return ((s - 1) % CYCLE_DAYS) + 1;
}

/** 周期第 index 格签到给多少金币 */
function rewardAt(index) {
  const i = Math.max(1, Math.min(CYCLE_DAYS, Math.floor(Number(index) || 1)));
  let coins = BASE_REWARD + (i - 1) * STREAK_BONUS;
  if (i === CYCLE_DAYS) coins += CYCLE_BONUS;
  return coins;
}

/** 取北京时间日期字符串 YYYY-MM-DD */
function beijingDate(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 取前一天的北京时间日期 */
function prevBeijingDate(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000 - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: 401, msg: 'cannot resolve openid' };

  const now = Date.now();
  const today = beijingDate(now);
  const yesterday = prevBeijingDate(now);

  try {
    /* ===== 幂等检查:先查今天是否已签到 ===== */
    const exist = await signCol.where({ _openid: openid, date: today }).limit(1).get();
    if (exist.data && exist.data.length) {
      const doc = exist.data[0];
      return OK({
        ok: false,
        reason: 'already',
        date: today,
        streak: doc.streak || 1,
      });
    }

    /* ===== 计算连续签到天数 ===== */
    const lastRes = await signCol
      .where({ _openid: openid })
      .orderBy('date', 'desc')
      .limit(1)
      .get();

    const lastDoc = lastRes.data && lastRes.data[0];
    let streak = 1;
    if (lastDoc) {
      streak = (lastDoc.date === yesterday) ? (lastDoc.streak || 1) + 1 : 1;
    }

    const reward = rewardAt(cycleIndexOf(streak));

    /* ===== 写入签到记录 =====
       并发下可能有两次请求同时通过上面的检查,
       所以这里依赖 sign_logs 上 (openid, date) 的唯一索引兜底:
       第二条写入会失败,捕获后按"已签到"返回,不会重复发奖。 */
    try {
      await signCol.add({
        data: {
          _openid: openid,
          date: today,
          streak,
          reward,
          createdAt: now,
        },
      });
    } catch (e) {
      // 唯一索引冲突 = 已经被并发请求签过了
      return OK({ ok: false, reason: 'already', date: today, streak });
    }

    /* ===== 发放奖励:同步到存档 ===== */
    const archRes = await archivesCol.where({ _openid: openid }).limit(1).get();
    const archDoc = archRes.data && archRes.data[0];

    if (archDoc) {
      const data = archDoc.data || {};
      data.coins = (data.coins || 0) + reward;
      data.lastSignDate = today;
      data.signStreak = streak;
      data.signTotal = (data.signTotal || 0) + 1;   // 累计签到天数(里程碑用)
      data.cloudVersion = (data.cloudVersion || 0) + 1;

      await archivesCol.doc(archDoc._id).update({
        data: { data, version: data.cloudVersion, updatedAt: now },
      });
    } else {
      // 还没有存档:创建一份并把奖励写进去
      await archivesCol.add({
        data: {
          _openid: openid,
          data: {
            version: 1,
            bestScore: 0,
            totalGames: 0,
            coins: reward,
            level: 1,
            lastSignDate: today,
            signStreak: streak,
            signTotal: 1,
            updatedAt: now,
            cloudVersion: 1,
          },
          version: 1,
          updatedAt: now,
        },
      });
    }

    return OK({
      ok: true,
      date: today,
      streak,
      reward,
      serverTime: now,
    });
  } catch (e) {
    console.error('[dailySign] error', e);
    return { code: 500, msg: 'internal error' };
  }
};
