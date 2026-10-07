/**
 * gameplay/career.js —— 生涯统计(纯逻辑层)
 *
 * 解决问题:原来每一局结束,"除了分数什么都没留下"。
 * 玩家第 2 局和第 20 局看到的界面完全一样 —— 这就是"单调"的机制来源。
 *
 * 这一层做的事只有一件:**把散落在每一局里的表现,累加成一个跨局的数字**。
 * 有了它,才可能有"解锁""图鉴""成就"这些长期目标 —— 它们全都只是这个数字的读数。
 *
 * 为什么单独一个文件:
 *   1. 它是纯函数式的数据变换,不碰 Canvas、不碰 wx,可以脱离小程序环境直接跑测试;
 *   2. 解锁判定(skins.js / achievements.js)需要读它,但**它不反向依赖**它们,
 *      这样依赖方向始终是单向的:skins → career → config;
 *   3. 将来加"周榜""赛季"这类统计,只在这里加字段,不动别处。
 *
 * ⚠️ 与 rules.js 的分工:
 *   rules.js 负责**一局之内**的状态(血量、障碍、本局分数);
 *   career.js 负责**跨局累计**的状态(总局数、总时长、历史最佳)。
 *   两者都用 "world / career" 这种普通对象传递,不做类继承 —— 便于存档序列化。
 */
const cfg = require('../config/config.js');
const E = cfg.ECONOMY;

const CAREER_VERSION = 1;

/** 新档的默认生涯数据 */
function create() {
  return {
    version: CAREER_VERSION,

    /* --- 累计值:只增不减,用来喂"累计类"解锁条件 --- */
    runs: 0,           // 总游玩局数
    seconds: 0,        // 累计存活秒数(取整后累加)
    dodged: 0,         // 累计躲过的红块
    grazed: 0,         // 累计擦身而过次数
    picked: 0,         // 累计拾取的金块
    heals: 0,          // 累计回命次数
    coinsEarned: 0,    // 累计赚到的金币(不含签到/分享赠送,展示用)

    /* --- 最佳值:单局最好成绩,用来喂"单局类"解锁条件 --- */
    bestScore: 0,      // 单局最高分
    bestDuration: 0,   // 单局最长存活(秒)
    bestDodged: 0,     // 单局最多躲避
    bestGrazed: 0,     // 单局最多擦身
    bestPicked: 0,     // 单局最多拾取
    bestHeals: 0,      // 单局最多回命次数(极限残血反打)
    bestFlawless: 0,   // 整局没被撞到的**最长**存活秒数

    /* --- 商店侧:唯一一个不由"一局"产出的字段 ---
     * "拥有几款造型"是**商店里发生的事**,没有任何一局能代表它,所以在购买时显式写进来
     * (见 scenes/shop-scene.js 的 syncCollection)。
     * 它存在的理由是收集类成就需要一个可判定的读数 ——
     * 而 achievements.js 的纪律是"每条成就都能从 career 的**单字段**算出进度",
     * 所以宁可在这里多一个字段,也不去给成就系统开一条"从存档读 ownedSkins"的旁路。 */
    skinsOwned: 0,     // 已拥有的造型款数(用于收集类成就)
  };
}

/**
 * 归一化:把存档里读到的东西变成一份保证合法的生涯数据。
 * 存档可能来自旧版本、可能被手改过、可能是 null —— 任何一个 NaN 都会让图鉴进度条
 * 显示成 "NaN/300",这类问题在真机上极难排查,所以在这里一次性挡掉。
 */
function normalize(raw) {
  const base = create();
  if (!raw || typeof raw !== 'object') return base;

  const out = Object.assign(base, raw);
  out.version = CAREER_VERSION;

  const keys = Object.keys(base);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'version') continue;
    const v = out[k];
    if (typeof v !== 'number' || !isFinite(v) || v < 0) out[k] = 0;
    else out[k] = Math.floor(v);
  }
  return out;
}

/**
 * 把一局的结算数据并入生涯。
 * 直接改传入的 career(它本来就是从存档里 load 出来的对象,就地更新即可),
 * 返回本局产生的"增量信息",供结算面板展示。
 *
 * @param {object} career 已 normalize 过的生涯数据
 * @param {{score:number, duration:number, dodged:number, grazed:number,
 *          picked:number, heals:number, hits:number}} run 本局结算数据
 * @returns {{coins:number, records:string[]}} coins = 本局赚到的金币;
 *          records = 本局刷新的纪录字段名列表(用于"新纪录"逐条展示)
 */
function applyRun(career, run) {
  const c = career;
  const records = [];

  const score = num(run.score);
  const duration = Math.max(0, Math.floor(num(run.duration)));
  const dodged = num(run.dodged);
  const grazed = num(run.grazed);
  const picked = num(run.picked);
  const heals = num(run.heals);
  const flawless = num(run.hits) === 0;

  // 1. 累计
  c.runs += 1;
  c.seconds += duration;
  c.dodged += dodged;
  c.grazed += grazed;
  c.picked += picked;
  c.heals += heals;

  // 2. 最佳(逐项比较,刷新了就记一笔,结算面板可以逐条打出来)
  if (score > c.bestScore) { c.bestScore = score; records.push('bestScore'); }
  if (duration > c.bestDuration) { c.bestDuration = duration; records.push('bestDuration'); }
  if (dodged > c.bestDodged) { c.bestDodged = dodged; records.push('bestDodged'); }
  if (grazed > c.bestGrazed) { c.bestGrazed = grazed; records.push('bestGrazed'); }
  if (picked > c.bestPicked) { c.bestPicked = picked; records.push('bestPicked'); }
  if (heals > c.bestHeals) { c.bestHeals = heals; records.push('bestHeals'); }
  if (flawless && duration > c.bestFlawless) {
    c.bestFlawless = duration;
    records.push('bestFlawless');
  }

  // 3. 金币:本作唯一的"软货币",只出不进不行 —— 它是造型购买的来源
  const coins = coinsForRun(run);
  c.coinsEarned += coins;

  return { coins: coins, records: records };
}

/** 一局能赚多少金币。分数越高越多,但增速低于分数,避免后期金币通胀 */
function coinsForRun(run) {
  const score = num(run.score);
  const duration = Math.max(0, Math.floor(num(run.duration)));
  return Math.floor(score / E.COINS_PER_SCORE) + Math.floor(duration / 10) * E.COINS_PER_10S;
}

/** 把任意输入收敛成一个有限非负整数 —— 防作弊数据、NaN 都从这里过一遍 */
function num(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** 秒数转人类可读:"45 秒" / "3 分 20 秒" / "1 小时 2 分" */
function formatSeconds(total) {
  const s = Math.max(0, Math.floor(num(total)));
  if (s < 60) return s + ' 秒';
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? (m + ' 分 ' + r + ' 秒') : (m + ' 分');
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? (h + ' 小时 ' + m + ' 分') : (h + ' 小时');
}

/** 累计战绩里挑几条最有说服力的,给图鉴页顶部做"生涯卡片" */
function highlights(career) {
  const c = normalize(career);
  return [
    { label: '总局数', value: String(c.runs) },
    { label: '累计存活', value: formatSeconds(c.seconds) },
    { label: '累计躲过', value: String(c.dodged) },
    { label: '累计擦身', value: String(c.grazed) },
  ];
}

module.exports = {
  CAREER_VERSION,
  create,
  normalize,
  applyRun,
  coinsForRun,
  formatSeconds,
  highlights,
};
