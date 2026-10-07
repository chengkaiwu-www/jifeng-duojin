/**
 * gameplay/checkin.js —— 每日签到的**纯逻辑**
 *
 * 为什么单独一个模块,而不是写在签到页里:
 *   签到是全作**唯一会因为"日期"而改变行为**的系统,而日期是 bug 的温床 ——
 *   跨月、跨年、时区(UTC vs 本地)、连签中断、脏存档、重复点按。
 *   把它抽成纯函数之后,就能在 Node 里把"12 月 31 日签完,1 月 1 日还能不能连上"
 *   这种一年才遇到一次的情况**直接断言掉**,不用真的等到那天。
 *   见 .workbuddy/tmp/test-checkin.js
 *
 * 周期设计:**7 天一轮,奖励递增,第 7 天额外大奖**。
 *   · 奖励递增 —— 让"再签一天"有即时理由,而不是"反正每天都给 100";
 *   · 周期回绕 —— 第 7 天之后重新回到第 1 格。
 *     上一版是"连签加成封顶 7 天",副作用是**连签 8 天和连签 30 天给一模一样的钱**,
 *     第 8 天起完全没有正反馈。改成周期之后,每 7 天都有一次"重新开始攒"的期待,
 *     而且经济上仍是收敛的(长连签不会线性放大收益)。
 *
 * 与 career/skins/achievements 的关系:它们都读 config,这里也一样。
 * gameplay 层依赖 config 是允许的(config 是叶子模块,不依赖任何人)。
 */
const cfg = require('../config/config.js');
const Dates = require('../utils/date.js');

const E = cfg.ECONOMY;

/** 周期长度(天)。第 CYCLE_DAYS 天是本轮大奖日,签完次日回到第 1 格。 */
const CYCLE_DAYS = E.SIGN_CYCLE_DAYS;

/**
 * 累计签到里程碑:达到天数给一次性额外奖励,**只发一次**。
 * 记录方式是 archive.signMile = { 天数: 1 } —— 用对象做 O(1) 判断,与 achievements 同风格。
 * 存在的理由:7 天周期只解决"明天再来",不解决"下个月还来"。
 * 里程碑是周期之上的第二层长期钩子,而且它不依赖连续,中断了也不清空。
 */
const MILESTONES = [
  { days: 3, coins: 100 },
  { days: 7, coins: 200 },
  { days: 14, coins: 400 },
  { days: 30, coins: 800 },
];

function num(v, d) {
  const n = Number(v);
  return isFinite(n) ? n : (d === undefined ? 0 : d);
}

/** streak(连签天数)落在周期的第几格 —— streak 从 1 开始,返回 1..CYCLE_DAYS */
function cycleIndexOf(streak) {
  const s = Math.floor(num(streak, 0));
  if (s <= 0) return 1;
  return ((s - 1) % CYCLE_DAYS) + 1;
}

/** 周期第 index 格(1..CYCLE_DAYS)签到给多少金币 */
function rewardAt(index) {
  const i = Math.max(1, Math.min(CYCLE_DAYS, Math.floor(num(index, 1))));
  let coins = E.SIGN_COINS + (i - 1) * E.SIGN_STREAK_BONUS;
  if (i === CYCLE_DAYS) coins += E.SIGN_CYCLE_BONUS;   // 第 7 天额外大奖
  return coins;
}

/**
 * 今天签到之后,连签会变成多少。
 * 已签到 → 返回当前值(幂等,反复调用不会涨);昨天签过 → +1;断签 → 回到 1。
 */
function streakAfterSign(archive, today) {
  const a = archive || {};
  if (a.lastSignDate === today) return Math.max(0, Math.floor(num(a.signStreak, 0)));
  if (Dates.isConsecutive(a.lastSignDate, today)) {
    return Math.min(Math.floor(num(a.signStreak, 0)) + 1, 9999);
  }
  return 1;
}

/** 下一个**未领取**的里程碑;全领完返回 null */
function nextMilestone(archive) {
  const a = archive || {};
  const total = Math.floor(num(a.signTotal, 0));
  const claimed = (a.signMile && typeof a.signMile === 'object') ? a.signMile : {};
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    if (claimed[m.days]) continue;
    return {
      days: m.days,
      coins: m.coins,
      left: Math.max(0, m.days - total),   // 还差几天
      reached: total >= m.days,            // 已达标但还没领(理论上签到时就自动领了)
    };
  }
  return null;
}

/** 累计天数达到 totalAfter 时,本次应当补发的里程碑奖励(可能一次跨过好几档) */
function milestoneReward(totalAfter, claimed) {
  const c = (claimed && typeof claimed === 'object') ? claimed : {};
  let coins = 0;
  const days = [];
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    if (totalAfter >= m.days && !c[m.days]) { coins += m.coins; days.push(m.days); }
  }
  return { coins: coins, days: days };
}

/**
 * 生成签到页需要的**全部信息** —— 页面只负责画,不负责算。
 *
 * cells 的语义(这是本模块最容易写错的地方):
 *   · signedToday 为真 → 第 1..cycleIndex 格全部点亮(含今天这格);
 *   · signedToday 为假 → 第 1..cycleIndex-1 格点亮,cycleIndex 格是"今天待领"。
 *   cycleIndex 始终表示**今天在周期里的位置**,不管有没有签。
 */
function plan(archive, today) {
  const a = archive || {};
  const signedToday = a.lastSignDate === today;
  const nextStreak = streakAfterSign(a, today);
  const cycleIndex = cycleIndexOf(nextStreak);

  const cells = [];
  for (let i = 1; i <= CYCLE_DAYS; i++) {
    cells.push({
      index: i,
      lit: signedToday ? i <= cycleIndex : i < cycleIndex,
      isToday: i === cycleIndex,
      reward: rewardAt(i),
      jackpot: i === CYCLE_DAYS,
    });
  }

  return {
    signedToday: signedToday,
    streak: Math.floor(num(a.signStreak, 0)),
    nextStreak: nextStreak,
    cycleIndex: cycleIndex,
    reward: signedToday ? 0 : rewardAt(cycleIndex),
    cells: cells,
    total: Math.floor(num(a.signTotal, 0)),
    milestone: nextMilestone(a),
  };
}

/**
 * 执行一次签到 —— **不改动传入的 archive**。
 *
 * 返回"应该写入什么",由调用方决定何时落盘。这样测试里可以对同一份存档
 * 反复调用验证幂等,而不用关心副作用。
 */
function applySign(archive, today) {
  const a = archive || {};
  const streak = Math.floor(num(a.signStreak, 0));
  const total = Math.floor(num(a.signTotal, 0));

  if (a.lastSignDate === today) {
    return {
      signed: false, reward: 0, milestoneCoins: 0, milestoneDays: [],
      streak: streak, total: total, coins: 0,
    };
  }

  const nextStreak = streakAfterSign(a, today);
  const reward = rewardAt(cycleIndexOf(nextStreak));
  const nextTotal = total + 1;
  const ms = milestoneReward(nextTotal, a.signMile);

  return {
    signed: true,
    reward: reward,
    milestoneCoins: ms.coins,
    milestoneDays: ms.days,
    streak: nextStreak,
    total: nextTotal,
    coins: reward + ms.coins,   // 本次实际进账
  };
}

/**
 * 把 applySign 的结果写回存档。
 * 场景里只调这一个写入口,避免"改了 streak 忘了 coins"这类漏写。
 * 已经签过(signed=false)时是空操作。
 */
function commit(archive, today, result) {
  const a = archive || {};
  if (!result || !result.signed) return a;

  a.coins = Math.max(0, Math.floor(num(a.coins, 0))) + result.coins;
  a.lastSignDate = today;
  a.signStreak = result.streak;
  a.signTotal = result.total;

  if (result.milestoneDays && result.milestoneDays.length) {
    if (!a.signMile || typeof a.signMile !== 'object') a.signMile = {};
    for (let i = 0; i < result.milestoneDays.length; i++) {
      a.signMile[result.milestoneDays[i]] = 1;
    }
  }
  return a;
}

module.exports = {
  CYCLE_DAYS,
  MILESTONES,
  cycleIndexOf,
  rewardAt,
  streakAfterSign,
  nextMilestone,
  milestoneReward,
  plan,
  applySign,
  commit,
};
