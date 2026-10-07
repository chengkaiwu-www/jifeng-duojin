/**
 * utils/date.js —— 本地日期工具
 *
 * ⚠️ 为什么不用 new Date().toISOString().slice(0, 10):
 *    toISOString 返回的是 **UTC** 时间。中国是 UTC+8,这意味着在本地时间
 *    0:00–8:00 之间,toISOString 给出的还是"昨天"。
 *    结果就是:签到/每日奖励的日期边界悄悄错位 8 小时 ——
 *    早上 7 点签到,系统认为是昨天;同一个上午还能再签一次。
 *    这类 bug 不会报错,只会在真实用户身上零星出现,极难排查。
 *    所以统一走这里的本地日期函数。
 */
function pad2(n) {
  return n < 10 ? ('0' + n) : String(n);
}

/** 把一个 Date 转成本地日期串 "2026-10-01" */
function dayStr(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 今天(本地时区) */
function todayStr() {
  return dayStr(new Date());
}

/** 昨天(本地时区)—— 用于判断签到是否连续 */
function yesterdayStr() {
  return dayStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

/** 两个日期串是否相邻(今天签了、昨天也签了 → 连续) */
function isConsecutive(prevDay, currentDay) {
  if (!prevDay || !currentDay) return false;
  const prev = new Date(prevDay + 'T00:00:00');
  const cur = new Date(currentDay + 'T00:00:00');
  if (isNaN(prev.getTime()) || isNaN(cur.getTime())) return false;
  const diff = Math.round((cur.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
  return diff === 1;
}

module.exports = { pad2, dayStr, todayStr, yesterdayStr, isConsecutive };
