/**
 * gameplay/skins.js —— 造型定义与购买判定(纯逻辑层)
 *
 * 这是"长期目标"的载体。在微信官方的小游戏设计指南里,目标体系分四层:
 *   单局目标 → 每日目标 → 每周目标 → **长期目标(收集图鉴 / 解锁角色)**
 * 前两层我们有了(单局纪录、每日签到),第四层原来是空的 —— 玩 100 局和玩 1 局,
 * 玩家手里的东西一模一样,这就是"单调"的来源。
 *
 * ★ 一个重要约束:本作没有任何美术资源。
 *   所以造型不用图片,而是把外观**参数化**成 6 个变量:
 *     轮廓形状(16 种) / 主色 / 点缀色 / 拖尾形态(4 种) / 发光 / 自转+光环
 *   好处是零下载体积、零美术成本,而且**加一个造型 = 改几个色值**。
 *
 * ★ 全部造型都靠**金币购买** —— 没有"达成条件自动解锁"这一说。
 *   这样做的理由:
 *     ① 玩家要的是"我选我要变成什么样",不是"系统发给我什么";
 *     ② 只有一种货币、一条路径,规则一句话说得清,不需要解释两套逻辑;
 *     ③ 技术好的玩家并没有吃亏 —— 成就(career 的读数)会**发金币**,
 *        打得越好赚得越快。技巧驱动的方向保留了,只是换成了间接兑现。
 *   所以完整的链路是:
 *     局内表现 ─┬─→ 金币 ──────────────────┐
 *               └─→ 生涯统计 ─→ 成就 ─→ 金币 ─┴─→ 购买造型
 *             签到的金币 ────────────────────┘
 */
const cfg = require('../config/config.js');

const DEFAULT_SKIN_ID = 'origin';

/**
 * 造型允许使用的轮廓形状。
 * ⚠️ 必须与 framework/ui.js 的 SUPPORTED_SHAPES 保持一致 ——
 *    两份列表是独立维护的(渲染层不该 import 数据层,反之亦然),
 *    一致性由 test-progression.js / check-preview.js 断言锁住。
 */
const SHAPES = [
  'round', 'circle', 'diamond', 'hex',
  'pentagon', 'octagon', 'triangle',
  'star5', 'star4', 'cross',
  'shield', 'drop', 'gear',
  'ring', 'blob', 'heart',
];

/**
 * 拖尾形态。'none' 之外每种在 game-scene.renderTrail 里有对应画法:
 *   ghost  残影 —— 同形状的半透明副本,越旧越淡越小(适合"速度感")
 *   ember  余烬 —— 小圆点向下飘散(适合"火/热")
 *   star   星点 —— 小四角星(适合"梦幻/闪光")
 *   ribbon 绸带 —— 一条渐细的带子(适合"流动/优雅")
 */
const TRAILS = ['none', 'ghost', 'ember', 'star', 'ribbon'];

/** 拖尾形态的中文名 —— 商店详情弹层要把它写出来。
 *  形状有 16 种、名字不值当逐个维护,所以只把 4 种拖尾命名。 */
const TRAIL_NAMES = {
  none: '无',
  ghost: '残影',
  ember: '余烬',
  star: '星点',
  ribbon: '绸带',
};

/**
 * 稀有度。同时承担两个作用:
 *   ① 视觉分级 —— 图鉴卡片顶部一条色带,远看就知道这排的档次;
 *   ② 价格锚点 —— 同稀有度的价格区间接近,玩家能预判"下一档大概多少钱"。
 */
const RARITY = {
  starter: { key: 'starter', name: '初始', color: '#8b95a3' },
  common: { key: 'common', name: '普通', color: '#4ade80' },
  rare: { key: 'rare', name: '稀有', color: '#38bdf8' },
  epic: { key: 'epic', name: '史诗', color: '#a78bfa' },
  legend: { key: 'legend', name: '传说', color: '#ffb020' },
};

/** 稀有度从低到高 —— 图鉴分组、价格校验都按这个序 */
const RARITY_ORDER = ['starter', 'common', 'rare', 'epic', 'legend'];

/**
 * ★ 稀有度 → 一组**结构性视觉标记**(而不是只靠换色)。
 *
 * 起因是一个真实的反馈:"这些皮肤没有什么让我购买的吸引力"。
 * 翻代码后认真数了一遍:24 款里 **13 款没有任何发光**,而拖尾只有 4 种形态,
 * 于是"普通 6 款 + 稀有 7 款"这 13 款其实**只靠「形状 + 两个色值」区分** ——
 * 形状池虽然有 16 种,但 Azure(880,蓝圆+残影)和 Sunset(1180,橙圆+绸带)**形状完全一样**。
 * 花了两档的钱,拿到的是同一层次的视觉,玩家当然不会觉得"值得再攒一档"。
 *
 * 所以这里把"档次"落成**看得见的结构差别** —— 每往上一档就多一件**不可能看错**的东西:
 *   · 稀有   → 形状外一圈**断续描边**(短划线)  —— 最便宜的"我升级了"信号
 *   · 史诗   → 外圈**呼吸光环**(实线、亮度随时间脉动,而不是死的一圈)
 *   · 传说   → 在呼吸光环之外,再加**环绕卫星点**(绕本体公转的小点)
 *
 * ⚠️ 为什么放在数据层而不是渲染层:`framework/ui.js` **不认识"稀有度"这个概念**
 *    (它的地位和"存档层不认识模式语义"是同一条分层纪律)。所以由本层把稀有度
 *    翻译成几个**具体参数**(edge / halo / orbit),再交给渲染层照参数画。
 *    渲染层因此永远不需要 import 造型表,也不知道什么是"史诗"。
 */
const TIER_MARKS = {
  starter: { edge: null, halo: false, orbit: 0 },
  common: { edge: null, halo: false, orbit: 0 },
  rare: { edge: 'dashed', halo: false, orbit: 0 },
  epic: { edge: null, halo: true, orbit: 0 },
  legend: { edge: null, halo: true, orbit: 3 },
};

/**
 * 造型表(24 款)。
 *
 * ⚠️ **必须按价格升序排列** —— 图鉴页按数组顺序直接铺,不再排序;
 *    这样"下一款想买的"永远在已拥有款的后面,视线自然往下走。
 *    test-progression.js 会断言这个顺序,别打乱。
 *
 * unlock 是数据驱动的(不是函数),这样存档、调试、预览页内联都好处理:
 *   { kind:'free' }              默认拥有
 *   { kind:'coins', price }      花金币购买
 *
 * style 字段:
 *   shape   见 SHAPES
 *   body    主色(填充)
 *   accent  点缀色(高光/描边/拖尾/光环)
 *   trail   见 TRAILS
 *   glow    是否外发光(暗背景下"浮起来")
 *   spin    自转速度(度/秒),可省略 —— 纯观感,不进判定
 *   halo    是否加一圈外光环(★ 已由 TIER_MARKS 按稀有度接管,这里写不写都行)
 *
 * ⚠️ **不要直接读 style 去渲染** —— 用 visualOf(skin) 取一份参数包。
 *    否则改一次视觉语义,主页/商店/游戏内三处都要跟着改。
 */
const SKINS = [
  /* ================= 初始 ================= */
  {
    id: 'origin', name: '初心', rarity: 'starter',
    desc: '最朴素的样子 · 一切都是从这里开始的',
    unlock: { kind: 'free' },
    style: { shape: 'round', body: '#07c160', accent: '#7ef0a8', trail: 'none', glow: false },
  },

  /* ================= 普通(180 ~ 560) =================
   * 第一小时内就该买得起至少一款 —— 这是整个长期目标的"入场券"。
   * 形状与配色都刻意做得干净,和后面的花哨形成对比。
   *
   * ⚠️ **第一款必须和默认造型"一眼看得出不一样"**,这是本轮修掉的一个真实缺陷:
   *    苔痕原来是 `round` + 无拖尾 + 无光效,而免费的初心也是 `round` + 无拖尾 + 无光效 ——
   *    两者的**完整视觉签名完全相同**(只差两个绿)。也就是说新手花掉第一笔 180 金币,
   *    买回来一个跟自己已经有的东西长得一模一样的东西。
   *    "没有购买吸引力"这件事,最锋利的一刀恰恰砍在最该成交的那一次上。
   *    test-progression 的 §2b 现在会断言 24 款造型的**完整视觉签名两两不同**,守的就是这条。 */
  {
    id: 'moss', name: '苔痕', rarity: 'common',
    desc: '低调,但一直在长',
    unlock: { kind: 'coins', price: 180 },
    // blob(不规则有机形)+ ghost(淡残影):"一直在长"的东西不该是个规规矩矩的圆
    style: { shape: 'blob', body: '#5a8f3d', accent: '#c8e6a0', trail: 'ghost', glow: false },
  },
  {
    id: 'sand', name: '沙丘', rarity: 'common',
    desc: '风一吹,就换了个样子',
    unlock: { kind: 'coins', price: 240 },
    style: { shape: 'pentagon', body: '#c9a227', accent: '#f3dfa2', trail: 'none', glow: false },
  },
  {
    id: 'tide', name: '潮汐', rarity: 'common',
    desc: '退下去的时候,才知道它来过',
    unlock: { kind: 'coins', price: 300 },
    style: { shape: 'drop', body: '#1f7ae0', accent: '#a9d3ff', trail: 'ghost', glow: false },
  },
  {
    id: 'maple', name: '枫叶', rarity: 'common',
    desc: '秋天最贵的一片',
    unlock: { kind: 'coins', price: 380 },
    style: { shape: 'heart', body: '#e2542b', accent: '#ffc09a', trail: 'none', glow: false },
  },
  {
    id: 'mint', name: '薄荷', rarity: 'common',
    desc: '凉,而且很快',
    unlock: { kind: 'coins', price: 460 },
    style: { shape: 'star4', body: '#2fd4a8', accent: '#d2fff0', trail: 'star', glow: false },
  },
  {
    id: 'berry', name: '莓果', rarity: 'common',
    desc: '甜得有点冲',
    unlock: { kind: 'coins', price: 560 },
    style: { shape: 'heart', body: '#c6236b', accent: '#ffb3d5', trail: 'star', glow: false },
  },

  /* ================= 稀有(660 ~ 1500) ================= */
  {
    id: 'ember', name: '熔岩', rarity: 'rare',
    desc: '跑起来会留下余烬',
    unlock: { kind: 'coins', price: 660 },
    style: { shape: 'round', body: '#ff6b35', accent: '#ffc27a', trail: 'ember', glow: false },
  },
  {
    id: 'gale', name: '疾风', rarity: 'rare',
    desc: '快到你只看得见一个尖',
    unlock: { kind: 'coins', price: 760 },
    style: { shape: 'triangle', body: '#17c3b2', accent: '#9df0e6', trail: 'ghost', glow: false },
  },
  {
    id: 'azure', name: '湛蓝', rarity: 'rare',
    desc: '冷静的那种蓝',
    unlock: { kind: 'coins', price: 880 },
    style: { shape: 'circle', body: '#2f8fff', accent: '#a8d0ff', trail: 'ghost', glow: false },
  },
  {
    id: 'violet', name: '幽紫', rarity: 'rare',
    desc: '棱角越多,越不好惹',
    unlock: { kind: 'coins', price: 1020 },
    style: { shape: 'octagon', body: '#9b5cff', accent: '#d9bcff', trail: 'ghost', glow: false },
  },
  {
    id: 'sunset', name: '落霞', rarity: 'rare',
    desc: '积少成多的颜色',
    unlock: { kind: 'coins', price: 1180 },
    style: { shape: 'circle', body: '#ff8a3d', accent: '#ffd9b0', trail: 'ribbon', glow: false },
  },
  {
    id: 'stardust', name: '星尘', rarity: 'rare',
    desc: '一路走过去,身后都是碎掉的星星',
    unlock: { kind: 'coins', price: 1350 },
    style: { shape: 'star5', body: '#4a6cff', accent: '#c3cdff', trail: 'star', glow: true },
  },
  {
    id: 'prism', name: '棱镜', rarity: 'rare',
    desc: '棱角分明,像你在百分之一秒里做的判断',
    unlock: { kind: 'coins', price: 1500 },
    style: { shape: 'diamond', body: '#22d3a8', accent: '#d5fff2', trail: 'ribbon', glow: false },
  },

  /* ================= 史诗(1680 ~ 2450) =================
   * 从这一档起都带外发光 —— 在深背景上"浮起来",一眼能和前面区分开。 */
  {
    id: 'jade', name: '苍玉', rarity: 'epic',
    desc: '没有一条直边的玉',
    unlock: { kind: 'coins', price: 1680 },
    style: { shape: 'blob', body: '#12b886', accent: '#b6f5dd', trail: 'ghost', glow: true },
  },
  {
    id: 'frost', name: '零度', rarity: 'epic',
    desc: '一次都没被撞到的那种干净',
    unlock: { kind: 'coins', price: 1860 },
    style: { shape: 'shield', body: '#c9ecff', accent: '#ffffff', trail: 'star', glow: true },
  },
  {
    id: 'hexcore', name: '六芒', rarity: 'epic',
    desc: '每一面都在反光',
    unlock: { kind: 'coins', price: 2050 },
    style: { shape: 'hex', body: '#ff4d9d', accent: '#ffc0dc', trail: 'ribbon', glow: true },
  },
  {
    id: 'honey', name: '蜂蜜', rarity: 'epic',
    desc: '甜,而且黏,甩不掉',
    unlock: { kind: 'coins', price: 2250 },
    style: { shape: 'gear', body: '#ffb020', accent: '#ffe6a8', trail: 'ember', glow: true },
  },
  {
    id: 'coral', name: '珊瑚', rarity: 'epic',
    desc: '长得很慢,但一直在长',
    unlock: { kind: 'coins', price: 2450 },
    style: { shape: 'cross', body: '#ff5f6d', accent: '#ffc9cd', trail: 'ribbon', glow: true },
  },

  /* ================= 传说(2700 ~ 3800) =================
   * 全部带光环,部分会自转 —— 这是"我攒到了"的可见凭证。 */
  {
    id: 'aurora', name: '极光', rarity: 'legend',
    desc: '一整条天上的颜色,慢悠悠地转',
    unlock: { kind: 'coins', price: 2700 },
    style: {
      shape: 'blob', body: '#2ee6c4', accent: '#b8fff0',
      trail: 'ribbon', glow: true, spin: 26, halo: true,
    },
  },
  {
    id: 'meteor', name: '陨铁', rarity: 'legend',
    desc: '从上面砸下来的东西,还在烧',
    unlock: { kind: 'coins', price: 2950 },
    style: {
      shape: 'octagon', body: '#6b7280', accent: '#ffd24a',
      trail: 'ember', glow: true, spin: 40, halo: true,
    },
  },
  {
    id: 'phantom', name: '幻梦', rarity: 'legend',
    desc: '你确定你刚才躲开了吗',
    unlock: { kind: 'coins', price: 3200 },
    style: {
      shape: 'star5', body: '#8b5cf6', accent: '#e9d5ff',
      trail: 'ghost', glow: true, halo: true,
    },
  },
  {
    id: 'void', name: '无常', rarity: 'legend',
    desc: '中间是空的,边上镶着金',
    unlock: { kind: 'coins', price: 3450 },
    style: {
      shape: 'ring', body: '#3a2f4a', accent: '#ffd24a',
      trail: 'ribbon', glow: true, spin: 18, halo: true,
    },
  },
  {
    id: 'abyss', name: '黑洞', rarity: 'legend',
    desc: '连光都跑不掉',
    unlock: { kind: 'coins', price: 3800 },
    style: {
      shape: 'gear', body: '#111827', accent: '#a78bfa',
      trail: 'ribbon', glow: true, spin: -52, halo: true,
    },
  },
];

/* ---------------- 查询 ---------------- */

/** 按 id 取造型;取不到时回落到默认造型(绝不返回 undefined,渲染层不必判空) */
function get(id) {
  for (let i = 0; i < SKINS.length; i++) {
    if (SKINS[i].id === id) return SKINS[i];
  }
  return SKINS[0];
}

/** 稀有度元数据(缺失时按"普通"兜底,不让渲染层拿到 undefined) */
function rarityOf(skin) {
  if (!skin) return RARITY.common;
  return RARITY[skin.rarity] || RARITY.common;
}

/**
 * 把一款造型翻译成"渲染层要的一组具体参数"。
 *
 * 存在的理由有两个,都很实际:
 *   ① **调用方不该各读各的 style 字段** —— 主页头像、商店卡片、游戏内本体三处
 *      原来都写 `glow: skin.style.glow` 这类代码,一改造型语义就要改三处;
 *   ② **稀有度的结构性标记必须由数据层算** —— 渲染层不认识"稀有度"(见 TIER_MARKS)。
 *
 * ⚠️ 返回值里**没有** style 之外的东西,也不含任何绘制代码 —— 它只是"参数包"。
 */
function visualOf(skin) {
  const s = (skin && skin.style) ? skin.style : {};
  const marks = TIER_MARKS[(skin && skin.rarity) || 'common'] || TIER_MARKS.common;
  return {
    shape: s.shape || 'round',
    body: s.body || '#07c160',
    accent: s.accent || '#7ef0a8',
    trail: s.trail || 'none',
    glow: !!s.glow,
    spin: Number(s.spin) || 0,
    // ---- 以下三项由**稀有度**推导,数据层写不写都不影响(见 TIER_MARKS)----
    edge: marks.edge,                                   // 'dashed' = 外圈断续描边
    halo: marks.halo || !!s.halo,                       // 外圈呼吸光环
    orbit: marks.orbit,                                 // 环绕卫星点数量
  };
}

/** 拖尾形态的中文名(未知形态回落成"无",不让界面显示 undefined) */
function trailTextOf(skin) {
  const t = (skin && skin.style && skin.style.trail) || 'none';
  return TRAIL_NAMES[t] || TRAIL_NAMES.none;
}

/**
 * 这一档"多出来的那件东西"的中文说法 —— 商店详情弹层用它。
 * 和 mechanicOf() 的机制标签是同一条纪律:**文案从实际参数派生**,
 * 而不是手写一句可能和 TIER_MARKS 打起来的说明("写着有光环、其实没开")。
 */
function markTextOf(skin) {
  const m = TIER_MARKS[(skin && skin.rarity) || 'common'] || TIER_MARKS.common;
  if (m.orbit > 0) return '呼吸光环 + ' + m.orbit + ' 个环绕星点';
  if (m.halo) return '呼吸光环';
  if (m.edge) return '断续描边';
  return '无附加光效';
}

/** 价格:默认造型是 0,其余读 unlock.price */
function priceOf(skin) {
  if (!skin || !skin.unlock || skin.unlock.kind !== 'coins') return 0;
  return skin.unlock.price;
}

/** 是否已拥有 —— 只看列表,不再有"条件达成"这条旁路 */
function isOwned(skin, owned) {
  return Array.isArray(owned) && owned.indexOf(skin.id) !== -1;
}

/**
 * 购买进度:图鉴里的进度条、结算面板的"再攒多少"都读它。
 * @returns {{current:number, target:number, ratio:number, left:number, text:string}}
 */
function progressOf(skin, coins) {
  const price = priceOf(skin);
  if (price <= 0) {
    return { current: 1, target: 1, ratio: 1, left: 0, text: '默认拥有' };
  }
  const cur = Math.max(0, Math.min(Number(coins) || 0, price));
  return {
    current: cur,
    target: price,
    ratio: cur / price,
    left: Math.max(0, price - cur),
    text: cur + ' / ' + price + ' 金币',
  };
}

/** 购买条件的纯文字描述,用于图鉴里的说明行 */
function requirementText(skin) {
  const price = priceOf(skin);
  return price > 0 ? (price + ' 金币') : '默认拥有';
}

/**
 * "还差多少"的完整句子,用于结算面板的下一步钩子。
 * 单独一个函数是因为这句话要在多个地方用同一套口径 ——
 * 结算面板写"还差 32 金币"、图鉴写"还差 33 金币"这种不一致会立刻让人失去信任。
 */
function goalText(skin, coins) {
  if (!skin) return '';
  const price = priceOf(skin);
  if (price <= 0) return '';
  const left = progressOf(skin, coins).left;
  if (left <= 0) return '「' + skin.name + '」已经买得起了 · 去图鉴换上';
  return '再攒 ' + left + ' 金币就能买「' + skin.name + '」';
}

/**
 * 挑出"下一款该买的"造型 —— 顺着价格升序走,第一款还没拥有的就是它。
 * 全买完了返回 null(此时结算面板不显示这一行)。
 */
function nextGoal(coins, owned) {
  for (let i = 0; i < SKINS.length; i++) {
    const s = SKINS[i];
    if (priceOf(s) <= 0) continue;
    if (isOwned(s, owned)) continue;
    return { skin: s, progress: progressOf(s, coins) };
  }
  return null;
}

/** 已拥有几款 —— 主页与图鉴页的 "造型 N/24" */
function countOwned(owned) {
  let n = 0;
  for (let i = 0; i < SKINS.length; i++) {
    if (isOwned(SKINS[i], owned)) n += 1;
  }
  return n;
}

/** 集齐全部需要多少金币 —— 用于展示"总目标"有多远,以及校验经济数值 */
function totalPrice() {
  let sum = 0;
  for (let i = 0; i < SKINS.length; i++) sum += priceOf(SKINS[i]);
  return sum;
}

/** 按稀有度切好,图鉴若要分组展示直接用(当前页签是按价格铺,这个留给以后) */
function grouped() {
  const out = [];
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    const key = RARITY_ORDER[i];
    const items = SKINS.filter((s) => s.rarity === key);
    if (items.length) out.push({ rarity: RARITY[key], items: items });
  }
  return out;
}

/**
 * 当前装备的造型。存档里的 id 无效时(旧版本删过造型、存档被改坏)回落默认 ——
 * 绝不返回 undefined,渲染层因此不用判空。
 */
function equippedOrDefault(id) {
  return get(id);
}

/**
 * 保证存档里的 ownedSkins 合法:默认造型永远在里面,已不存在的 id 清掉。
 * 直接改传入的数组并返回它 —— 调用点在 loadArchive 之后调一次即可。
 * 没有这个函数,"存档被清坏后玩家连一个能穿的造型都没有"是会真发生的。
 */
function repairOwned(owned) {
  const list = Array.isArray(owned) ? owned : [];
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    // 只保留当前表里真实存在的 id(旧版本删掉的造型不该永远赖在存档里)
    for (let j = 0; j < SKINS.length; j++) {
      if (SKINS[j].id === list[i]) { kept.push(list[i]); break; }
    }
  }
  if (kept.indexOf(DEFAULT_SKIN_ID) === -1) kept.unshift(DEFAULT_SKIN_ID);
  return kept;
}

module.exports = {
  SHAPES,
  TRAILS,
  TRAIL_NAMES,
  RARITY,
  RARITY_ORDER,
  TIER_MARKS,
  SKINS,
  DEFAULT_SKIN_ID,
  get,
  rarityOf,
  visualOf,
  trailTextOf,
  markTextOf,
  priceOf,
  isOwned,
  progressOf,
  requirementText,
  goalText,
  nextGoal,
  countOwned,
  totalPrice,
  grouped,
  equippedOrDefault,
  repairOwned,
};
