/**
 * gameplay/modes.js —— 玩法模式(纯数据 + 纯函数)
 *
 * ────────────────────────────────────────────────────────────────
 * 核心设计:一个模式 = 一组 config.GAME 的参数覆盖 + 至多一个规则开关。
 *
 * 为什么不给每个模式写一份 rules.js?
 *   四个模式共享同一套规则骨架(生成 → 下落 → 碰撞 → 计分),
 *   差异只体现在"数值与节奏"上。若各写一份,四个文件会迅速漂移成
 *   四份需要同步维护的代码 —— 改一个碰撞 bug 要改四遍,还必然漏一遍。
 *   所以这里刻意把模式收成**纯数据**,rules.js 只负责"照着这组参数跑"。
 *
 * 为什么是"每个模式一个独有机制",而不是继续调数值?
 *   调数值只能让四个模式"快慢不同",但玩家从头到尾做的事一模一样 ——
 *   于是玩起来就会觉得"四个模式太像了"。真正的差异只能来自
 *   **核心挑战本身不一样**。所以给每个模式打开一个属于它的机制开关
 *   (机制定义见 config.GAME 末尾的三段注释):
 *     疾风 = 障碍横向摆动        → 改变"怎么躲"
 *     金潮 = 连击链 + 金块游走   → 改变"为什么贪"
 *     死线 = 走廊收窄 + 左右摇摆 → 改变"空间有多大"
 *   三个机制彼此正交,却共享同一份 rules.js —— 四个模式,一套骨架。
 *
 * ★ 一条共性(第二版修订补上):机制必须是**看得见的运动**,不能只是一个数字。
 *   第一版的「金潮 = 连击倍率」「死线 = 走廊线性收窄」都输在这里 ——
 *   倍率是个看不见的倍数;收窄 55 秒才走完 34%,玩家几乎察觉不到。
 *   两者的问题一样:**玩家的动作其实没有变**。
 *   所以给这两者各补一层物理上可见的运动:金块匀速游走(要去追)、走廊整体摇摆(要跟着走)。
 *   现在三个机制的玩家动作分别落在"避 / 追 / 随"上,彼此再也不可能混淆。
 *   (这也是"能在技术评审里讲清"的一点:机制的可感知性 ≠ 机制的强度。)
 *
 * 为什么「经典」一条机制都不开?
 *   经典是**基准**:它必须是"什么都不加"的那一个。
 *   有它当锚点,玩家才能说清另外三个各自"到底变了什么";
 *   老玩家的肌肉记忆也才能完全有效 —— 那是本作唯一的资产。
 *
 * ⚠️ 每个模式的 maxScorePerSecond 是**服务端防作弊的唯一依据**,
 *    必须与 cloudfunctions/submitScore/index.js 的 MODE_LIMITS 表逐值一致。
 *    上限推导见 rateOf():把四种得分的"每秒理论最大值"相加。
 *    设小了正常玩家被判作弊(体验事故),设大了作弊者能刷上榜首(数据事故)。
 *
 * ⚠️ 关于排行榜:只有「经典」计入全服榜(scoreboard: true)。
 *    跨模式比分数是不公平的 —— 死线模式 60 秒封顶,永远赢不了无限时长的经典。
 *    这是设计决策,不是偷懒:把不可比的分数放在同一张榜上,
 *    榜就失去了"我在同类玩家中排第几"这个唯一的意义。
 * ────────────────────────────────────────────────────────────────
 */
const cfg = require('../config/config.js');
const G = cfg.GAME;

const DEFAULT_MODE_ID = 'classic';

/**
 * 四个模式,各自压住玩法的一条轴,并各自打开一个独有的机制:
 *   经典 = 基准 ·     三种要素齐全 · 机制:无(什么都不加,所以它才是尺子)
 *   疾风 = 速度轴 ·   障碍横向摆动 · 机制:sway  —— 站定必被扫到,必须预判
 *   金潮 = 收益轴 ·   拾取连击链   · 机制:combo —— 目标从活得久变成别断链
 *   死线 = 时间轴 ·   活动走廊收窄 · 机制:timeLimit + lane —— 时间在少、地方也在小
 * 每条轴都对应一个不同的"为什么再来一局"的心理动机。
 */
const MODES = [
  {
    id: 'classic',
    name: '经典',
    tag: '全能',
    desc: '红块要躲、金块要抢、边缘要贴 —— 三种要素齐全',
    hint: '标准节奏,难度平滑上升',
    color: '#07c160',
    accent: '#2f6bff',
    timeLimit: 0,
    params: {},                // 空 = 完全使用 config.GAME 的基准值
    maxScorePerSecond: 32,
    maxDuration: 900,
    scoreboard: true,
  },
  {
    id: 'gale',
    name: '疾风',
    tag: '速度',
    desc: '红块边走边左右摆动,必须预判轨迹 —— 站定不动必被扫到',
    hint: '读着波形再动,考点从手速变成了预判',
    color: '#22d3ee',
    accent: '#0ea5e9',
    timeLimit: 0,
    params: {
      /* ★ 本模式的独有机制:障碍横向摆动。
         振幅 96(约等于一个红块的半个身位),波长约 700 像素;
         屏幕高约 1334,所以每个红块在屏内会完整地荡将近两个来回。
         "近两个来回"是刻意的:少于一个来回,玩家还没读出方向块就过去了;
         多于三个来回,画面就变成了纯粹的无规律抖动,读不过来,只能靠运气。 */
      OBSTACLE_SWAY: 96,
      OBSTACLE_SWAY_WAVE: 0.009,
      /* 速度:起步就快,增长更陡,天花板抬高 */
      BASE_SPEED: 520,
      SPEED_GROWTH: 24,
      MAX_SPEED: 1320,
      SPAWN_START_INTERVAL: 0.72,
      SPAWN_MIN_INTERVAL: 0.30,
      SPAWN_INTERVAL_DECAY: 0.026,
      /* 计分:速度换收益 */
      BASE_SCORE_PER_SECOND: 12,
      DODGE_SCORE: 6,
      GRAZE_SCORE: 3,
      /* 擦身窗口 26 → 36。这是**速度补偿**:速度翻倍后,
         如果判定窗口不变,"贴边"就从技巧变成了运气,必须放宽才公平。
         加了摆动之后这条更必要 —— 块会主动向你扫过来。 */
      GRAZE_DISTANCE: 36,
      /* 金块更稀、更不值钱 —— 这个模式考的是反应,不是取舍 */
      PICKUP_INTERVAL: 1.8,
      PICKUP_SCORE: 6,
      /* 无敌 1.2 → 1.0:速度已经是惩罚,不再叠加更长的无敌保护 */
      INVINCIBLE_SECONDS: 1.0,
    },
    maxScorePerSecond: 47,
    maxDuration: 900,
    scoreboard: false,
  },
  {
    id: 'rush',
    name: '金潮',
    tag: '收益',
    desc: '金块会自己横向游走:连击越高跑得越快,撞一下就断链归零',
    hint: '目标不是活得久,而是别断链 —— 而且你得追得上',
    color: '#ffb020',
    accent: '#f59e0b',
    timeLimit: 0,
    params: {
      /* ★ 本模式的独有机制:拾取连击链。
         注意 PICKUP_SCORE 从经典的 8 掉到了 6 —— 单次拾取**更不值钱**了。
         这是有意的:值钱的不是"拾取"这个动作,而是"连着拾取"。
         倍率从第 2 个金块开始生效,连到第 5 个到达上限:
           1.0 → 1.6 → 2.2 → 2.8 → 3.0(封顶),此后维持 3.0。
         于是这个模式的真实目标从"活得久"变成了"别断链" ——
         被撞一次,前面攒的倍率全部作废;而为了不断链,玩家会主动往红块边上靠。
         这正是"贪"被兑现成具体行为的地方。 */
      COMBO_ENABLED: true,
      COMBO_STEP: 0.6,
      COMBO_MAX: 3,
      /* ★ 游走:金块自己横向匀速移动,速度还要再乘上当前倍率。
         基础 150 设计像素/秒 —— 远低于玩家拖动的速度(千级以上),
         所以规则是:**只要你动,就追得上;但你不动,一个也拿不到**。
         连满时倍率 3 → 450 px/s,已经进入"必须提前起跑"的档位。
         于是"越贪越难追"不是一句文案,而是一个能算出来的数。
         为什么用匀速直线而不是正弦摆动:匀速是全作最好读的运动,一眼看出它往哪跑。
         疾风要读波形、死线要跟节拍、金潮要算落点 —— 三个模式"要动脑的地方"刻意不同。 */
      PICKUP_DRIFT: 150,
      /* 金块:间隔 1.6 → 0.95,回命额度放宽 */
      PICKUP_INTERVAL: 0.95,
      PICKUP_SCORE: 6,
      MAX_HEALS: 3,
      /* 贴着红块生成的概率 0.55 → 0.70,间距上限 190 → 165:
         金块变多的同时**也更险** —— 收益与风险必须同步放大,
         否则这个模式就只是"变简单了",而不是"变得更贪了"。 */
      PICKUP_NEAR_CHANCE: 0.70,
      PICKUP_NEAR_MAX: 165,
      /* 红块略密,给"贪"制造真实的代价 */
      SPAWN_MIN_INTERVAL: 0.40,
      SPAWN_INTERVAL_DECAY: 0.015,
      BASE_SPEED: 400,
      MAX_SPEED: 960,
      /* 躲避与擦身保持基准值:这个模式的收益不来自这两项 */
      BASE_SCORE_PER_SECOND: 10,
      DODGE_SCORE: 5,
      GRAZE_SCORE: 2,
    },
    maxScorePerSecond: 49,
    maxDuration: 900,
    scoreboard: false,
  },
  {
    id: 'deadline',
    name: '死线',
    tag: '限时',
    desc: '60 秒冲刺,活动空间一路收窄,还带着你左右摇摆',
    hint: '时间在少,地方一边变小一边漂移 —— 没有喘息',
    color: '#f43f5e',
    accent: '#e5484d',
    timeLimit: 60,             // ★ 规则开关之一:时间到 = 本局结束
    params: {
      /* ★ 本模式的独有机制:活动走廊收窄(与上面的限时同向叠加)。
         可站立的范围与障碍生成的范围一起收窄,55 秒时收到最窄的 66%,
         最后 5 秒维持在最窄处 —— 收窄的过程本身要有"到头了"的终点感。

         为什么停在 66%,而不是更窄:
         走廊最窄时宽 750 × 0.66 = 495,减去最宽的红块(280)还剩 215,
         刚好够玩家(宽 96)挤过去。再窄一点,"躲"就从"有难度"变成"无解" ——
         那不是压迫,是耍赖。难度必须来自选择变少,而不是选择消失。 */
      LANE_SHRINK_SECONDS: 55,
      LANE_MIN_RATIO: 0.66,
      /* ★ 摇摆:走廊一边收窄、一边整体左右平移。
         振幅 110 取在**安全上限内**:收窄到底时走廊的可移动余量
         = 375 × (1 − 0.66) = 127.5,所以 110 让走廊最远只贴到离屏幕边缘
         还剩 17 像素的位置,永远不可能滑出屏幕(约束写在 updateLane 的公式里)。
         周期恒定 5 秒一个来回 —— 60 秒里荡 12 个来回,足够玩家数出拍子。
         太快(<3 秒)读不过来,太慢(>8 秒)就分不清"它在摆"还是"它偏了"。
         注意它与收窄的关系:摇摆**依附**于收窄 —— 走廊没窄下来就没有可移动的余量,
         幅度随收窄进度一起增长,这也正好做出"越到后面荡得越急"。 */
      LANE_SWAY: 110,
      LANE_SWAY_PERIOD: 5,
      /* 难度压缩:60 秒内就必须爬到接近天花板,所以三条曲线一起调陡 */
      BASE_SPEED: 460,
      SPEED_GROWTH: 22,
      MAX_SPEED: 1100,
      SPAWN_START_INTERVAL: 0.80,
      SPAWN_MIN_INTERVAL: 0.38,
      SPAWN_INTERVAL_DECAY: 0.020,
      /* 存活计分提高:这个模式里"活到终点"本身就是成就 */
      BASE_SCORE_PER_SECOND: 14,
      DODGE_SCORE: 6,
      GRAZE_SCORE: 3,
      GRAZE_DISTANCE: 30,
      PICKUP_INTERVAL: 1.2,
      PICKUP_SCORE: 10,
    },
    maxScorePerSecond: 48,
    maxDuration: 90,           // 限时 60 秒,上报时长不至于超过 90
    scoreboard: false,
  },
];

const BY_ID = {};
for (let i = 0; i < MODES.length; i++) BY_ID[MODES[i].id] = MODES[i];

/** 全部模式(顺序即 UI 展示顺序,也是"由易到难"的推荐顺序) */
function list() {
  return MODES;
}

/** 按 id 取模式定义;非法 id 一律回落经典 —— 存档被手改也不会崩 */
function get(id) {
  const def = BY_ID[id];
  return def || BY_ID[DEFAULT_MODE_ID];
}

function isValid(id) {
  return Object.prototype.hasOwnProperty.call(BY_ID, id);
}

function indexOf(id) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].id === id) return i;
  }
  return 0;
}

/**
 * 解析出该模式实际生效的完整参数表。
 * 返回的是**新对象**(不污染 cfg.GAME)—— 否则切一次模式就把全局配置改掉了。
 */
function paramsOf(id) {
  const def = get(id);
  return Object.assign({}, G, def.params);
}

/**
 * 该模式的每秒理论最高分 = 四项得分各自的每秒上限之和。
 *
 *   存活 = BASE_SCORE_PER_SECOND
 *   躲避 = DODGE_SCORE    / SPAWN_MIN_INTERVAL
 *   擦身 = GRAZE_SCORE    / SPAWN_MIN_INTERVAL   (每个红块最多擦身一次)
 *   拾取 = PICKUP_SCORE   / PICKUP_INTERVAL
 *
 * ⚠️ 改任何一个计分参数(含本文件里的覆盖值),maxScorePerSecond 必须重算。
 *    test-modes.js 会断言"上限 ≥ 推导值",让"改了参数忘了改上限"当场暴露。
 */
function rateOf(id) {
  const p = paramsOf(id);
  const spawn = Math.max(0.01, p.SPAWN_MIN_INTERVAL);
  const pick = Math.max(0.01, p.PICKUP_INTERVAL);
  // 开了连击链的模式,拾取得分按**倍率上限**计算。
  // 上限必须覆盖"每一次拾取都吃满倍率"这种理论最坏情况 ——
  // 宁可把上限放宽,也不能让正常高手被服务端误判成作弊。
  const comboK = p.COMBO_ENABLED ? Math.max(1, p.COMBO_MAX) : 1;
  return p.BASE_SCORE_PER_SECOND +
    (p.DODGE_SCORE + p.GRAZE_SCORE) / spawn +
    p.PICKUP_SCORE * comboK / pick;
}

/**
 * 机制的短标签 —— 从**实际生效的参数**派生,而不是在模式表里手写一份文案。
 *
 * 与"READY 面板的规则速览由实际参数生成"是同一条纪律:
 * 手写的文案迟早会和参数打起来("界面写着摆动、其实摆动没开"),
 * 而派生出来的永远对得上。加机制时只要在这里补一行。
 */
function mechanicOf(def) {
  const p = def.params;
  const parts = [];
  if (def.timeLimit > 0) parts.push('限时');
  if (p.OBSTACLE_SWAY > 0) parts.push('摆动');
  // 游走是连击链的"可见形态",两者本来就是同一个机制的两面 ——
  // 所以开了游走就不再单独报"连击",否则标签会变成一串没人会读的长词。
  if (p.PICKUP_DRIFT > 0) parts.push('追猎');
  else if (p.COMBO_ENABLED) parts.push('连击');
  // 同理:摇摆是收窄的"可见形态"(走廊得先窄下来才有可移动的余量),二选一。
  if (p.LANE_SWAY > 0) parts.push('摇摆');
  else if (p.LANE_SHRINK_SECONDS > 0) parts.push('收窄');
  return parts.join(' · ');
}

/** 一次拿齐"这个模式怎么跑"的全部信息,供场景层使用 */
function resolve(id) {
  const def = get(id);
  return {
    id: def.id,
    name: def.name,
    tag: def.tag,
    mechanic: mechanicOf(def),
    desc: def.desc,
    hint: def.hint,
    color: def.color,
    accent: def.accent,
    timeLimit: def.timeLimit,
    params: paramsOf(def.id),
    /* 机制摘要 —— 让场景层写 mode.combo 比 mode.params.COMBO_ENABLED 清楚得多 */
    sway: def.params.OBSTACLE_SWAY || 0,
    combo: !!def.params.COMBO_ENABLED,
    drift: def.params.PICKUP_DRIFT || 0,
    lane: def.params.LANE_SHRINK_SECONDS || 0,
    laneSway: def.params.LANE_SWAY || 0,
    maxScorePerSecond: def.maxScorePerSecond,
    scoreboard: def.scoreboard,
  };
}

/** 该模式一局的分数上限(限时模式用时长的硬上限算,比实测时长更严) */
function modeMaxDuration(id) {
  return get(id).maxDuration;
}

/** 模式切换:下一个 / 上一个(循环),主页左右滑动或键盘用得上 */
function step(id, delta) {
  const n = MODES.length;
  const i = ((indexOf(id) + delta) % n + n) % n;
  return MODES[i].id;
}

/**
 * 某个分数在某个模式里算不算"破纪录"。
 * 每个模式的分数不可比(死线 60 秒封顶),所以纪录必须按模式分开记。
 */
function isBetter(score, prevBest) {
  const s = Number(score);
  const b = Number(prevBest);
  if (!isFinite(s) || s <= 0) return false;
  if (!isFinite(b) || b <= 0) return true;
  return s > b;
}

module.exports = {
  DEFAULT_MODE_ID,
  list,
  get,
  isValid,
  indexOf,
  paramsOf,
  rateOf,
  mechanicOf,
  resolve,
  modeMaxDuration,
  step,
  isBetter,
};
