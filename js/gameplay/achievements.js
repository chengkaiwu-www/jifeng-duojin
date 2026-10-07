/**
 * gameplay/achievements.js —— 成就定义与判定(纯逻辑层)
 *
 * 成就回答的问题和造型不同:
 *   · 造型 —— 我能变成什么样(视觉目标、炫耀)
 *   · 成就 —— 我做到了什么(里程碑、自我确认)
 *
 * ★ 成就的第二个作用:**它是金币的主要来源之一**(见本文件每个条目的 coins 字段)。
 *   全部造型都靠金币购买,如果金币只能从"局内分数"来,那技术好的玩家会觉得自己
 *   的优势被抹平了。让成就发金币,就把"打得好"重新变回了经济优势 ——
 *   只是兑现方式从"直接发造型"改成"赚得更快",而造型仍然由玩家自己挑。
 *
 * ★ 设计上刻意做的一件事:所有成就都能从 career 的**某单个字段**直接算出进度。
 *   这意味着不需要为"还差多少"单独写逻辑 —— 判定和进度条是同一行数据推出来的。
 *   代价是成就的表达力被限制住了,但对这个体量完全够用,而且它换来了
 *   "改一个数字就能加一个成就"的极低维护成本。
 */
const cfg = require('../config/config.js');
const Career = require('./career.js');

const G = cfg.GAME;

/**
 * field 指向 career 里的字段,target 是达标值,coins 是达成时发放的金币奖励。
 * 判定与进度都从 (field, target) 推出来,不写第二遍。
 *
 * ⚠️ 改 field 名时务必小心:打错一个字母的后果是"这条成就永远拿不到,
 *    而且不报任何错"。test-progression.js 会断言每个 field 都真实存在于 career。
 *
 * coins 的总量(5050)刻意定在"集齐全部造型(35860 金币)的约 1/7" ——
 * 它是一笔"明显的额外收入",但不至于让玩家跳过攒钱的过程。
 * (其中"收集"那三条自己发 2300:造型要花钱买 → 收集到款数 → 又回一笔,
 *  所以它是这一层里唯一**自己养自己**的一组。)
 */
const ALL = [
  /* ---- 入门:让玩家在前 3 分钟内一定拿到第一个成就 ---- */
  {
    id: 'first_run', name: '初次登场', group: '入门',
    desc: '完成你的第 1 局',
    field: 'runs', target: 1, fmt: 'int', coins: 60,
  },

  /* ---- 生存:把"活得更久"这件事拆成四级台阶 ---- */
  {
    id: 'survive_30', name: '站稳脚跟', group: '生存',
    desc: '单局存活 30 秒',
    field: 'bestDuration', target: 30, fmt: 'duration', coins: 50,
  },
  {
    id: 'survive_60', name: '一分钟', group: '生存',
    desc: '单局存活 60 秒',
    field: 'bestDuration', target: 60, fmt: 'duration', coins: 80,
  },
  {
    id: 'survive_120', name: '硬骨头', group: '生存',
    desc: '单局存活 120 秒',
    field: 'bestDuration', target: 120, fmt: 'duration', coins: 130,
  },

  /* ---- 技巧:这六条是本作独有的玩法(擦身 / 拾取 / 回命 / 无伤),
   *      比"分数高"更能说明你真的玩懂了这个游戏 ---- */
  {
    id: 'dodge_50', name: '百步穿杨', group: '技巧',
    desc: '单局躲避 50 个红块',
    field: 'bestDodged', target: 50, fmt: 'int', coins: 100,
  },
  {
    id: 'graze_10', name: '贴身舞者', group: '技巧',
    desc: '单局擦身而过 10 次',
    field: 'bestGrazed', target: 10, fmt: 'int', coins: 120,
  },
  {
    id: 'graze_20', name: '刀尖上', group: '技巧',
    desc: '单局擦身而过 20 次',
    field: 'bestGrazed', target: 20, fmt: 'int', coins: 170,
  },
  {
    id: 'pickup_5', name: '贪得无厌', group: '技巧',
    desc: '单局拾取 5 个金色能量块',
    field: 'bestPicked', target: 5, fmt: 'int', coins: 120,
  },
  {
    id: 'clutch', name: '命不该绝', group: '技巧',
    desc: '单局用满 ' + G.MAX_HEALS + ' 次回命还能继续跑',
    field: 'bestHeals', target: G.MAX_HEALS, fmt: 'int', coins: 200,
  },
  {
    id: 'flawless_45', name: '完美主义', group: '技巧',
    desc: '整局没被撞到,存活 45 秒',
    field: 'bestFlawless', target: 45, fmt: 'duration', coins: 160,
  },

  /* ---- 里程碑:分数台阶 ---- */
  {
    id: 'score_1000', name: '千分俱乐部', group: '里程碑',
    desc: '单局拿到 1000 分',
    field: 'bestScore', target: 1000, fmt: 'int', coins: 150,
  },
  {
    id: 'score_2000', name: '两千', group: '里程碑',
    desc: '单局拿到 2000 分',
    field: 'bestScore', target: 2000, fmt: 'int', coins: 250,
  },
  {
    id: 'score_3500', name: '三千五', group: '里程碑',
    desc: '单局拿到 3500 分',
    field: 'bestScore', target: 3500, fmt: 'int', coins: 400,
  },

  /* ---- 积累:给"慢慢玩"的人的目标,和技巧无关 ---- */
  {
    id: 'runs_50', name: '常客', group: '积累',
    desc: '累计游玩 50 局',
    field: 'runs', target: 50, fmt: 'int', coins: 180,
  },
  {
    id: 'graze_300', name: '惯性冒险', group: '积累',
    desc: '累计擦身而过 300 次',
    field: 'grazed', target: 300, fmt: 'int', coins: 260,
  },
  {
    id: 'hour', name: '一小时', group: '积累',
    desc: '累计存活 3600 秒',
    field: 'seconds', target: 3600, fmt: 'duration', coins: 320,
  },

  /* ---- 收集:造型侧的成就。
   * ★ 加这一组的起因是一个真实反馈:"这些皮肤没有什么让我购买的吸引力"。
   *   查下来的三个原因之一是「买了不响」—— 原来 16 条成就**全是玩法指标**
   *   (存活/躲避/擦身/拾取/局数),**没有一条和收集有关**,
   *   于是"我买到第 10 款"这件事在系统里不发生任何事。
   *
   *   这一组把"收集"本身变成一件有回响的事,而且是**双向**的:
   *   造型要花金币买 → 收集到一定款数 → 又发一笔金币。
   *   所以它同时也是给"想买但钱不够"的人的一句"再买两款就回本了"。
   *
   *   三个台阶刻意卡在**收藏进度条的三段**上(前端 / 过半 / 全满),
   *   而不是平均分布 —— 第 5 款是"入场后第一次回头看见自己的收藏",
   *   第 12 款正好过半,第 24 款是全收集。
   *
   * ⚠️ 读的是 career.skinsOwned,由 shop-scene 在购买时写入(见那里的 syncCollection)。 ---- */
  {
    id: 'collect_5', name: '初见收藏', group: '收集',
    desc: '集齐 5 款造型',
    field: 'skinsOwned', target: 5, fmt: 'int', coins: 200,
  },
  {
    id: 'collect_12', name: '半个衣柜', group: '收集',
    desc: '集齐 12 款造型',
    field: 'skinsOwned', target: 12, fmt: 'int', coins: 600,
  },
  {
    id: 'collect_24', name: '全都要', group: '收集',
    desc: '集齐全部造型',
    field: 'skinsOwned', target: 24, fmt: 'int', coins: 1500,
  },
];

/** 成就分组顺序(图鉴页按这个顺序排版,不在表里的组排最后) */
const GROUPS = ['入门', '生存', '技巧', '里程碑', '积累', '收集'];

function byId(id) {
  for (let i = 0; i < ALL.length; i++) {
    if (ALL[i].id === id) return ALL[i];
  }
  return null;
}

/** 某条成就的读数来源(缺失一律当 0) */
function valueOf(a, career) {
  const v = Number((career || {})[a.field]);
  return isFinite(v) && v > 0 ? v : 0;
}

function isDone(a, career) {
  return valueOf(a, career) >= a.target;
}

/** 进度:current / target / ratio / text —— 图鉴页的进度条读它 */
function progressOf(a, career) {
  const raw = valueOf(a, career);
  const cur = Math.min(raw, a.target);
  return {
    current: cur,
    target: a.target,
    ratio: a.target > 0 ? cur / a.target : 1,
    text: (a.fmt === 'duration' ? Career.formatSeconds(raw) : String(raw)) +
      ' / ' + (a.fmt === 'duration' ? Career.formatSeconds(a.target) : String(a.target)),
    done: raw >= a.target,
  };
}

/**
 * 结算后调用:把本次达成的成就补进 unlocked(对象映射 { id: 1 }),返回新增的列表。
 * unlocked 用对象而不是数组,是为了 O(1) 判断"这条拿过没有"——
 * 图鉴页每帧要画 19 条,用数组会变成 19×19 的扫描。
 *
 * `onlyFields`(可选):只结清 `field` 命中这份名单的成就。**默认不传 = 全都要**,向后兼容。
 * 存在的理由:本函数是"把**所有**待发的成就一次性结清",而"结清"发生的地点不同性质也不同 ——
 *   · 局末(game-scene.onEnd):刚刚跑完一局,把这一局的成绩兑掉,天经地义;
 *   · 商店(shop-scene.syncCollection):只是**买了一款造型**,"拥有几款"变了而已。
 *     若在这里也全量结清,一个因为某种原因还挂着的玩法成就就会被商店顺手发掉,
 *     而商店的飘字只报得出 `list[0]` 的名字 —— 玩家会看到"成就「马拉松」奖励 +300"
 *     这种跟买造型毫无关系的话,而且**金额是一堆成就的总和**。所以商店只认收集组。
 */
function evaluate(career, unlocked, onlyFields) {
  const map = (unlocked && typeof unlocked === 'object') ? unlocked : {};
  const only = (onlyFields && onlyFields.length) ? onlyFields : null;
  const fresh = [];
  for (let i = 0; i < ALL.length; i++) {
    const a = ALL[i];
    if (only && only.indexOf(a.field) === -1) continue;
    if (map[a.id]) continue;
    if (isDone(a, career)) {
      map[a.id] = 1;
      fresh.push(a);
    }
  }
  return fresh;
}

/** 收集组的 field 名 —— 商店里"买了就响"的只有这一组,所以在这里给它一个正式名字 */
const COLLECTION_FIELDS = ['skinsOwned'];

/** 已达成数量 / 总数 —— 主页与图鉴页顶部的总进度 */
function countDone(unlocked) {
  const map = unlocked || {};
  let n = 0;
  for (let i = 0; i < ALL.length; i++) {
    if (map[ALL[i].id]) n += 1;
  }
  return n;
}

/** 把任意输入收敛成有限非负整数 —— 奖励值被手改坏时不至于发出 NaN 金币 */
function num(v) {
  const n = Number(v);
  return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
}

/**
 * 本次新达成的成就一共奖励多少金币。
 * 单独一个函数(而不是让 evaluate 直接返回 {list, coins})是为了不改 evaluate 的返回形状 ——
 * 调用点已经习惯"拿到一个数组",多一个纯函数比多一种返回类型更好读。
 */
function rewardCoins(list) {
  let sum = 0;
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i++) sum += num(arr[i].coins);
  return sum;
}

/** 全部成就的金币奖励总量 —— 用于校验经济数值(它是造型总价的多少分之一) */
function totalReward() {
  let sum = 0;
  for (let i = 0; i < ALL.length; i++) sum += num(ALL[i].coins);
  return sum;
}

/** 按分组切好,图鉴页直接拿去渲染,不在渲染层做分组逻辑 */
function grouped() {
  const out = [];
  for (let g = 0; g < GROUPS.length; g++) {
    const items = ALL.filter((a) => a.group === GROUPS[g]);
    if (items.length) out.push({ group: GROUPS[g], items: items });
  }
  return out;
}

module.exports = {
  ALL,
  GROUPS,
  COLLECTION_FIELDS,
  byId,
  isDone,
  progressOf,
  evaluate,
  countDone,
  rewardCoins,
  totalReward,
  grouped,
};
