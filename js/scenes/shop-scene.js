/**
 * scenes/shop-scene.js —— 商城(皮肤商店 + 成就)
 *
 * 这是"长期目标层"唯一的界面。它存在的理由只有一句话:
 *   **目标感必须被看见,否则不成立。**
 * 玩家不会因为"系统里存在 24 款皮肤"而留下,他会因为"我买了 10 款,还差 14 款"而留下。
 * 所以这个页面最重要的不是好看,是**把'还差多少'摆在最显眼的位置**。
 *
 * 皮肤页的定位是**商店**,不是成就墙:
 *   · 每一款都标价、都能买,买不买由玩家自己决定(不存在"系统发给你"的皮肤);
 *   · 未拥有的**照样画出轮廓**(灰),让人看见"那里有个东西、它长什么样";
 *   · 买不起的给进度条 + 精确差额,而不是只写一句"金币不足"。
 * 成就页则是另一种东西 —— 它展示"我做到了什么",达成时会发金币(见 achievements.js)。
 * 两者合在一个页面里,是因为它们共同回答同一个问题:**我还能往哪里去。**
 *
 * 顶部那条**稀有度筛选**是这一版新增的:
 *   24 款平铺成 8 行,玩家其实"看不完" —— 一屏只能看到 3 行,
 *   他没法回答"传说档到底有几款、长什么样"。筛选把"整页浏览"变成
 *   "按档位查看",这是货架型界面最基本的可用性要求。
 *
 * 交互上刻意保留了三件事:
 *   ① 未拥有的皮肤照样画出轮廓,不是一片锁;
 *   ② 每个买不起的都带进度条 + 精确差额;
 *   ③ 购买/装备都是一步到位,不做二次确认 —— 内容是游戏内货币,而且贵在"想不想"而非"敢不敢"。
 *
 * ============================================================
 * ★ 第七轮修正(起因是一个真实反馈:"这些皮肤没有什么让我购买的吸引力")
 *
 * 翻代码时数出来一个很硬的事实 —— **玩家在掏钱之前,从没见过他要买的东西:**
 *   · 卡片预览只有 68px,未拥有的还被压到 35% 不透明度(`dim: !owned`);
 *   · 未拥有的**把发光和光环直接关掉**(`glow: style.glow && owned`)——
 *     而发光正是史诗档、光环正是传说档唯一"贵在哪"的标志:
 *     **越贵的,在商店里越看不出它贵。**
 *   · **拖尾从来没画过** —— 可它恰恰是游戏里最显眼的差异(renderTrail 每帧 8 个采样点);
 *   · `skin.desc` 那 24 条文案**从未被渲染过**(全项目搜过:只有成就与模式的 desc 被画到屏幕上)。
 *
 * 所以这一轮的判断是一句话:**演示即商品。**
 * 舍不得把东西演示好,就别指望有人想要它。四处改动都由此而来:
 *   ① 预览放大到 96px 并**带上拖尾示意**,未拥有**不再压暗、不再关光效**;
 *      "未拥有"这件事改由卡片本身表达(虚底 + 稀有度淡边 + 价格行),不靠把商品涂灰;
 *   ② 卡片补上 desc(单行截断,完整文案在详情里);
 *   ③ 新增**详情弹层**:点未拥有的卡片先看清 —— 240px 实时预览(自转 / 拖尾 / 档位光效都在动)、
 *      完整文案、形状与拖尾的名字、这一档多出来的那件东西、价格与进度;
 *   ④ 稀有度不再只是"换个色" —— 见 skins.js 的 TIER_MARKS:
 *      稀有=断续描边 / 史诗=呼吸光环 / 传说=再加环绕星点。**每往上一档就多一件不可能看错的东西。**
 *
 * ⚠️ 详情弹层里的"实时预览"**不等于"在游戏里试穿一局"**:真正的试穿要临时改装备、
 *    再把 Game 场景推上导航栈(而 Game 现在是 `replace` 进入的,没有"从哪来回哪去"的栈语义)。
 *    为了不给"存档里留下一个没买却穿在身上的造型"开一条口子,这一轮先用**大尺寸实时预览**替代 ——
 *    它把"看不清"这个真正的原因解决了,而导航改造留到以后真有必要时再做。
 * ============================================================
 */

const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');
const Storage = require('../framework/storage.js');

const Career = require('../gameplay/career.js');
const Skins = require('../gameplay/skins.js');
const Achievements = require('../gameplay/achievements.js');

const Analytics = require('../platform/analytics.js');
const WX = require('../platform/wx-adapter.js');

/* ---------- 页签 ---------- */
const TAB = { SKINS: 'skins', ACHIEVEMENTS: 'achievements' };
let tab = TAB.SKINS;

/** 稀有度筛选:'all' = 全部,其余为 Skins.RARITY 的 key */
const FILTER_ALL = 'all';
let filter = FILTER_ALL;

/* ---------- 状态 ---------- */
let archive = null;
let career = null;
let scrollY = 0;          // 内容滚动偏移(设计坐标)
let maxScroll = 0;
let tabButtons = [];
let filterButtons = [];
let backButton = null;
let rows = [];            // 当前页签的可点击行(带各自的 rect + 行为),渲染与命中共用一份
let toastText = '';
let toastSub = '';
let toastTimer = 0;

/* 详情弹层:非 null 时它盖住整页,只有它自己的按钮能响应。
 * 存在的理由就是这一轮的核心判断 —— **演示即商品**,买之前先让它被看清。 */
let sheetSkin = null;
let sheetMainBtn = null;
let sheetCloseBtn = null;

/* 拖动与点击的区分:手指移动超过这个距离就不算"点击",防止滚动时误触购买 */
const DRAG_THRESHOLD = 10;
let dragging = false;
let dragStartY = 0;
let dragStartScroll = 0;
let dragMoved = false;

/* ---------- 布局常量 ---------- */
/* 皮肤是 3 列(24 款 → 8 行,筛选后更少)。卡片要同时放下稀有度色带、**带拖尾的大预览**、
 * 名称、描述、价格/进度条 —— 所以比只有"名称 + 状态"的版本高不少。
 * 高度不够时挤在一起的不是文字,是信息;而**信息挤在一起就等于没有信息**。 */
const COLS_SKINS = 3;
const CELL_W = 210;
const CELL_H = 274;
const CELL_GAP = 15;
const SKIN_PREVIEW = 96;     // 卡片里的预览尺寸(第七轮:68 → 96,并把拖尾画出来)
const ACH_COLS = 2;
const ACH_W = 330;
const ACH_H = 106;
const ACH_GAP = 14;

const RARITY_NAMES = ['全部', '普通', '稀有', '史诗', '传说'];

/**
 * 筛选档位:'全部' + 四个付费档。
 *
 * 为什么不直接用 Skins.RARITY_ORDER:它含 `starter` 一档,而那一档只有默认皮肤,
 * 且默认皮肤**永远在 ownedSkins 里** —— 给它一个筛选 chip 只会得到一个恒定满员的空货架。
 * 商店的筛选条应该只列"可能还没买的东西"。
 * (test-progression.js 会断言这里的每一项都存在于 Skins.RARITY 或为 FILTER_ALL,
 *  防止以后加档位时两边不同步。)
 */
const FILTER_KEYS = [FILTER_ALL, 'common', 'rare', 'epic', 'legend'];

function contentTop() { return screen.safeTop + 358; }
function contentBottom() { return screen.height - 150 - screen.safeBottom; }

function showToast(msg, sub) {
  toastText = msg;
  toastSub = sub || '';
  toastTimer = 2.6;
}

/** 按字符数单行截断 —— 不引 measureText:真机与预览页才能用同一套口径估宽 */
function ellipsize(text, maxChars) {
  const s = String(text || '');
  return s.length > maxChars ? (s.slice(0, maxChars - 1) + '…') : s;
}

/** 存档落盘(所有会改存档的操作都走这里,避免漏写) */
function persist() {
  Storage.saveArchive(archive);
}

/* ---------- 筛选 ---------- */

/** 当前筛选下的皮肤列表(顺序保持价格升序,不打乱) */
function visibleSkins() {
  if (filter === FILTER_ALL) return Skins.SKINS;
  const out = [];
  for (let i = 0; i < Skins.SKINS.length; i++) {
    if (Skins.SKINS[i].rarity === filter) out.push(Skins.SKINS[i]);
  }
  return out;
}

/** 每个筛选项下的款数(画在名字后面,让"传说只有 5 款"这种信息可见) */
function countOf(key) {
  if (key === FILTER_ALL) return Skins.SKINS.length;
  let n = 0;
  for (let i = 0; i < Skins.SKINS.length; i++) {
    if (Skins.SKINS[i].rarity === key) n += 1;
  }
  return n;
}

/* ---------- 行/格的构建 ---------- */

function buildSkinCells() {
  const out = [];
  const list = visibleSkins();
  const totalW = COLS_SKINS * CELL_W + (COLS_SKINS - 1) * CELL_GAP;
  const startX = (screen.width - totalW) / 2;
  for (let i = 0; i < list.length; i++) {
    const col = i % COLS_SKINS;
    const row = Math.floor(i / COLS_SKINS);
    out.push({
      skin: list[i],
      x: startX + col * (CELL_W + CELL_GAP),
      y: contentTop() + row * (CELL_H + CELL_GAP),
      w: CELL_W,
      h: CELL_H,
    });
  }
  return out;
}

function buildAchCells() {
  const out = [];
  const totalW = ACH_COLS * ACH_W + (ACH_COLS - 1) * ACH_GAP;
  const startX = (screen.width - totalW) / 2;
  const flat = Achievements.ALL;
  for (let i = 0; i < flat.length; i++) {
    const col = i % ACH_COLS;
    const row = Math.floor(i / ACH_COLS);
    out.push({
      ach: flat[i],
      x: startX + col * (ACH_W + ACH_GAP),
      y: contentTop() + row * (ACH_H + ACH_GAP),
      w: ACH_W,
      h: ACH_H,
    });
  }
  return out;
}

/** 重算行布局与滚动上限(切页签、切筛选、屏幕尺寸变化时都要调) */
function rebuild() {
  rows = tab === TAB.SKINS ? buildSkinCells() : buildAchCells();

  let lowest = contentTop();
  for (let i = 0; i < rows.length; i++) {
    lowest = Math.max(lowest, rows[i].y + rows[i].h);
  }
  const viewH = contentBottom() - contentTop();
  maxScroll = Math.max(0, lowest - contentBottom());
  // 内容比视口矮时不需要滚动;比视口高时把偏移夹回合法范围
  if (maxScroll === 0) scrollY = 0;
  else scrollY = Math.max(0, Math.min(scrollY, maxScroll));

  // 内容不足一屏时,底部对齐会让画面显得上重下轻,这里把整体上移一点点居中
  if (maxScroll === 0) scrollY = -Math.min(40, (viewH - (lowest - contentTop())) / 2);
  scrollY = Math.round(scrollY);
}

/* ---------- 行为 ---------- */

/** 皮肤格的状态:决定显示什么文案、点击做什么 */
function skinState(skin) {
  if (Skins.isOwned(skin, archive.ownedSkins)) {
    return archive.equippedSkin === skin.id
      ? { kind: 'equipped', owned: true, text: '已装备', color: ui.COLORS.brand }
      : { kind: 'equip', owned: true, text: '点击装备', color: ui.COLORS.text };
  }

  const price = Skins.priceOf(skin);
  if (price <= 0) {
    // 只可能是存档被改坏 —— 默认皮肤本该永远在 ownedSkins 里
    return { kind: 'equip', owned: true, text: '点击装备', color: ui.COLORS.text };
  }

  const left = Math.max(0, price - archive.coins);
  if (left <= 0) {
    return { kind: 'buy', owned: false, text: '购买 · ' + price + ' 金币', color: ui.COLORS.gold, price: price };
  }
  return { kind: 'short', owned: false, text: '还差 ' + left + ' 金币', color: ui.COLORS.textSub, price: price };
}

/**
 * 画一个"带拖尾的造型预览" —— 商店卡片与详情弹层共用。
 *
 * 拖尾画在造型**左侧**,所以造型本身要向右让出半个拖尾的长度,看起来才是居中的。
 * 卡片格子窄,所以 span 传得比默认值小 —— 否则拖尾会伸到隔壁卡片上。
 *
 * @param {number} cx,cy 整个"造型+拖尾"的视觉中心
 * @param {number} size   造型本体尺寸
 * @param {{spanRatio:number, dim:boolean, alpha:number}} opt
 */
function drawSkinPreview(ctx, skin, cx, cy, size, opt) {
  const v = Skins.visualOf(skin);
  const o = opt || {};
  const spanRatio = o.spanRatio === undefined ? 0.5 : o.spanRatio;
  const span = size * spanRatio;
  const skx = cx - size / 2 + span * 0.25;   // 0.25 而不是 0.5:拖尾元素自身也有宽度
  const sky = cy - size / 2;

  ui.spriteTrail(ctx, {
    x: skx, y: sky, size: size, shape: v.shape, body: v.body,
    accent: v.accent, trail: v.trail, span: span,
  });
  ui.sprite(ctx, {
    x: skx, y: sky, size: size, shape: v.shape, body: v.body, accent: v.accent,
    glow: v.glow, halo: v.halo, orbit: v.orbit, edge: v.edge, spin: v.spin,
    alpha: o.alpha === undefined ? 1 : o.alpha,
  });
}

/**
 * 同步"已收集几款"并结算**收集**成就。
 *
 * 为什么要手动同步:career 里其它字段都是**一局的读数**,由 Career.applyRun 累加;
 * 而"拥有几款造型"是**商店里发生的事**,没有任何一局能代表它。
 * 不写这一步,收集类成就要等到**下一局结算**才补发 —— 而"买了就响"正是这一轮想要的那一下。
 *
 * ⚠️ 只结清 `COLLECTION_FIELDS` 这一组(见 achievements.js 的 evaluate 注释):
 *    `evaluate` 的本职是"把所有待发的成就一次性结清",那是**局末**该做的事;
 *    商店只是买了一件东西,顺手把玩法成就也发掉会让飘字说出"成就「马拉松」奖励 +300"
 *    这种跟买造型无关的话,而且金额是一堆成就的总和 —— 说的和给的对不上。
 *
 * @returns {null|{list:Array, coins:number}} 本次新达成的收集成就
 */
function syncCollection() {
  career.skinsOwned = Skins.countOwned(archive.ownedSkins);
  const fresh = Achievements.evaluate(career, archive.achievements, Achievements.COLLECTION_FIELDS);
  if (fresh.length === 0) return null;
  return { list: fresh, coins: Achievements.rewardCoins(fresh) };
}

/** 真正扣钱买下 —— 卡片和详情弹层共用同一条路径,避免两处各写一份(必然会漂) */
function buySkin(skin, price) {
  if (archive.coins < price) return false;   // 双保险:状态算错也不会扣成负数
  archive.coins -= price;
  archive.ownedSkins.push(skin.id);
  archive.equippedSkin = skin.id;            // 买完直接换上,少一次点击
  WX.vibrateShort();
  Analytics.track('skin_buy', { id: skin.id, price: price, coins_left: archive.coins });

  const got = syncCollection();
  if (got) {
    archive.coins += got.coins;              // 收集成就的金币当场到账
    showToast('成就「' + got.list[0].name + '」　奖励 +' + got.coins + ' 金币',
      '已收集 ' + Skins.countOwned(archive.ownedSkins) + ' / ' + Skins.SKINS.length + ' 款造型');
  } else {
    showToast('买到「' + skin.name + '」并已装备',
      '已收集 ' + Skins.countOwned(archive.ownedSkins) + ' / ' + Skins.SKINS.length + ' 款造型');
  }
  persist();
  return true;
}

function onSkinTap(cell) {
  const skin = cell.skin;
  const st = skinState(skin);

  if (st.kind === 'equipped') return;

  // 已拥有:直接换上(一次点击就够 —— 高频、低决策成本)
  if (st.kind === 'equip') {
    archive.equippedSkin = skin.id;
    persist();
    showToast('已换上「' + skin.name + '」');
    Analytics.track('skin_equip', { id: skin.id });
    return;
  }

  // 未拥有:**先让他看清,再让他决定**。这就是这一轮的核心改动 ——
  // 原来这里直接飘一句"还差 N 金币",而玩家连它长什么样都没看清。
  openSheet(skin);
}

/* ---------- 详情弹层 ---------- */

/* 弹层尺寸与内部各行的纵向偏移 —— 集中在这里,免得渲染和建按钮两处各写一套数字而漂掉。
 * 高度按 750 设计宽度下的 16:9 屏(1334)算过:上下各留 234,不顶到屏幕边。 */
const SHEET_W = 640;
const SHEET_H = 866;
const SHEET_PREVIEW = 220;
const SHEET_PREVIEW_CY = 294;     // 预览中心相对弹层顶部的偏移
const SHEET_MAIN_Y = 666;         // 主按钮纵偏移
const SHEET_CLOSE_Y = 772;        // 关闭按钮纵偏移

function sheetRect() {
  return {
    x: (screen.width - SHEET_W) / 2,
    y: (screen.height - SHEET_H) / 2,
    w: SHEET_W,
    h: SHEET_H,
  };
}

function openSheet(skin) {
  sheetSkin = skin;
  Analytics.track('skin_detail', { id: skin.id });
}

function closeSheet() {
  sheetSkin = null;
}

/** 详情弹层主按钮的行为:买 / 换 / 什么都不做 */
function sheetMainAction() {
  const skin = sheetSkin;
  if (!skin) return;
  const st = skinState(skin);
  if (st.kind === 'buy') { buySkin(skin, st.price); return; }
  if (st.kind === 'equip') {
    archive.equippedSkin = skin.id;
    persist();
    showToast('已换上「' + skin.name + '」');
    Analytics.track('skin_equip', { id: skin.id });
    return;
  }
  // 已装备 / 还差金币:给一句"怎么赚",而不是什么都不发生
  if (st.kind === 'short') {
    showToast('还差 ' + (st.price - archive.coins) + ' 金币', '跑几局、签个到,或者去成就看看还能拿多少');
  }
}

function renderSheet(ctx) {
  if (!sheetSkin) return;
  const skin = sheetSkin;
  const st = skinState(skin);
  const rarity = Skins.rarityOf(skin);
  const v = Skins.visualOf(skin);
  const r = sheetRect();
  const cx = r.x + r.w / 2;

  // 背后压暗 —— 弹层必须比页面高一层,否则"重点"和"背景"会抢注意力
  ctx.fillStyle = 'rgba(0,0,0,0.76)';
  ctx.fillRect(0, 0, screen.width, screen.height);

  ui.card(ctx, {
    x: r.x, y: r.y, w: r.w, h: r.h, r: 28,
    fill: ui.COLORS.panel, stroke: hexAlpha(rarity.color, 0.5), sheen: true,
  });

  // 顶部稀有度色带
  ctx.save();
  ui.roundRect(ctx, r.x + 40, r.y + 34, r.w - 80, 6, 3);
  ctx.fillStyle = rarity.color;
  ctx.fill();
  ctx.restore();

  ui.text(ctx, skin.name, cx, r.y + 100, {
    size: 46, color: ui.COLORS.text, align: 'center', weight: 'bold',
  });

  // 稀有度 + 这一档多出来的那件东西 —— 由 TIER_MARKS 派生,不会和实际画出来的不符
  ui.text(ctx, rarity.name + ' · ' + Skins.markTextOf(skin), cx, r.y + 142, {
    size: 22, color: hexAlpha(rarity.color, 0.95), align: 'center',
  });

  // 大预览:自转 / 拖尾 / 档位光效全在动 —— 这就是"看清"的核心
  drawSkinPreview(ctx, skin, cx, r.y + SHEET_PREVIEW_CY, SHEET_PREVIEW, { spanRatio: 0.6 });

  ui.divider(ctx, r.x + 60, r.y + 474, r.w - 120);

  ui.text(ctx, skin.desc, cx, r.y + 518, {
    size: 25, color: ui.COLORS.textSub, align: 'center',
  });

  /* 外观三项 —— 全部由数据派生,不手写文案。
   * 玩家真正想知道的是"它和别的比多了什么",而不是一串参数名。 */
  const info = [
    ['拖尾', Skins.trailTextOf(skin)],
    ['光效', Skins.markTextOf(skin)],
    ['发光', v.glow ? '有 · 暗背景上会浮起来' : '无'],
  ];
  for (let i = 0; i < info.length; i++) {
    const iy = r.y + 564 + i * 32;
    ui.text(ctx, info[i][0], r.x + 70, iy, { size: 22, color: ui.COLORS.textDim });
    ui.text(ctx, info[i][1], r.x + r.w - 70, iy, {
      size: 22, color: ui.COLORS.text, align: 'right',
    });
  }

  /* ---- 主按钮:买 / 换 / 还差多少。文案与配色每帧现算 ---- */
  const b = sheetMainBtn.opt;
  /* ⚠️ 三段文案都由 skinState() 现算好了(它的字段叫 `text`),这里直接用。
   *    曾经写成 `st.kind === 'short' ? '还差 ' + st.left + ' 金币' : st.text`
   *    —— `left` 这个字段**在 skinState 里根本不存在**,
   *    于是弹层主按钮上明晃晃写着「还差 undefined 金币」。
   *    教训:状态对象长什么样,就以它的定义为准,别在渲染处凭记忆另拼一份文案。 */
  const mainText = st.text;
  const mainFill = st.kind === 'buy' ? ui.COLORS.gold
    : (st.kind === 'equip' ? ui.COLORS.brand : 'rgba(255,255,255,0.08)');
  const mainColor = (st.kind === 'buy' || st.kind === 'equip') ? '#12202c' : ui.COLORS.textSub;

  ui.roundRect(ctx, b.x, b.y, b.w, b.h, 22);
  ctx.fillStyle = mainFill;
  ctx.fill();
  ui.sheen(ctx, b.x, b.y, b.w, b.h, 22);
  ui.text(ctx, mainText, b.x + b.w / 2, b.y + b.h / 2, {
    size: 30, color: mainColor, align: 'center', baseline: 'middle', weight: 'bold',
  });

  // 买不起时把"还差多少"画出来 —— 精确差额比一句"金币不足"有用得多
  if (st.kind === 'short') {
    const p = Skins.progressOf(skin, archive.coins);
    ui.progress(ctx, {
      x: b.x + 30, y: b.y + 22, w: b.w - 60, h: 7,
      value: p.ratio, color: rarity.color,
    });
  }

  // 关闭按钮
  const cb = sheetCloseBtn.opt;
  ui.roundRect(ctx, cb.x, cb.y, cb.w, cb.h, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ui.text(ctx, '关 闭', cb.x + cb.w / 2, cb.y + cb.h / 2, {
    size: 26, color: ui.COLORS.textSub, align: 'center', baseline: 'middle',
  });
}

/* ---------- 渲染:皮肤页 ---------- */

function renderSkinCells(ctx) {
  if (rows.length === 0) {
    // 空货架也要像"被设计过":图标 + 一句现状 + 一句下一步,而不是一行灰字
    ui.empty(ctx, {
      cx: screen.width / 2, cy: contentTop() + 150,
      icon: 'shapes', iconSize: 92,
      title: '这个档位暂时没有造型',
      sub: '换个筛选看看',
    });
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const skin = c.skin;
    const st = skinState(skin);
    const owned = st.owned;
    const rarity = Skins.rarityOf(skin);

    // 卡片底:已拥有用实底,未拥有用虚底 —— 一眼看出"那边还有东西"
    // ⚠️ "未拥有"由**卡片**表达,不再把商品本身涂灰(第七轮改动)。
    ui.roundRect(ctx, c.x, c.y, c.w, c.h, 18);
    ctx.fillStyle = owned ? ui.COLORS.panel : 'rgba(255,255,255,0.045)';
    ctx.fill();
    // 与全作其他卡片同一道顶部内高光 —— 统一立体语言
    ui.sheen(ctx, c.x, c.y, c.w, c.h, 18);

    // 未拥有:用稀有度色描一圈淡边,让"这一排是什么档位"一眼可辨
    if (!owned) {
      ui.roundRect(ctx, c.x, c.y, c.w, c.h, 18);
      ctx.strokeStyle = hexAlpha(rarity.color, 0.32);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 已装备:微信绿描边,唯一一个"最亮"的状态
    if (st.kind === 'equipped') {
      ui.roundRect(ctx, c.x, c.y, c.w, c.h, 18);
      ctx.strokeStyle = ui.COLORS.brand;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // 顶部稀有度色带:整页扫过去就是一条"档次阶梯"
    ctx.save();
    ui.roundRect(ctx, c.x, c.y, c.w, 6, 3);
    ctx.fillStyle = rarity.color;
    ctx.globalAlpha = owned ? 1 : 0.7;
    ctx.fill();
    ctx.restore();

    // 右上角稀有度文字(色带只有颜色,给个词更明确)
    ui.text(ctx, rarity.name, c.x + c.w - 14, c.y + 26, {
      size: 17, color: hexAlpha(rarity.color, 1), align: 'right',
    });

    /* ★ 预览:第七轮 68 → 96,并**把拖尾也画出来**。
     * 未拥有的**不再压暗、不再关掉发光/光环** ——
     * 原来"越贵的越看不出它贵",是这一轮最主要的一处修正。 */
    drawSkinPreview(ctx, skin, c.x + c.w / 2, c.y + 82, SKIN_PREVIEW, { spanRatio: 0.5 });

    // 名称
    ui.text(ctx, skin.name, c.x + c.w / 2, c.y + 152, {
      size: 26, color: ui.COLORS.text,
      align: 'center', weight: 'bold',
    });

    // ★ 描述:那 24 条文案此前**从未被渲染过**。卡片上只放单行截断版,
    //   完整文案在详情弹层里 —— 卡片的职责是"让你想点进去",不是"把话说完"。
    ui.text(ctx, ellipsize(skin.desc, 11), c.x + c.w / 2, c.y + 184, {
      size: 16, color: ui.COLORS.textDim, align: 'center',
    });

    if (owned) {
      ui.text(ctx, st.text, c.x + c.w / 2, c.y + 214, {
        size: 20, color: st.color, align: 'center',
      });
      continue;
    }

    // 未拥有:价格文案 + 进度条(买得起的就没有进度条 —— 进度条只在"还差"时才有意义)
    ui.text(ctx, st.text, c.x + c.w / 2, c.y + 214, {
      size: 20, color: st.color, align: 'center', weight: st.kind === 'buy' ? 'bold' : '',
    });

    if (st.kind === 'short') {
      const p = Skins.progressOf(skin, archive.coins);
      ui.progress(ctx, {
        x: c.x + 22, y: c.y + 236, w: c.w - 44, h: 7,
        value: p.ratio, color: rarity.color,
      });
      ui.text(ctx, p.text, c.x + c.w / 2, c.y + 258, {
        size: 17, color: ui.COLORS.textSub, align: 'center',
      });
    }
  }
}

/** 把 #rrggbb 转成带透明度的 rgba —— 让同一个稀有度色能当"实色"也能当"淡边" */
function hexAlpha(hex, a) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return 'rgba(255,255,255,' + a + ')';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return 'rgba(255,255,255,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* ---------- 渲染:成就页 ---------- */

function renderAchCells(ctx) {
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const a = c.ach;
    const done = Achievements.isDone(a, career);
    const p = Achievements.progressOf(a, career);

    ui.roundRect(ctx, c.x, c.y, c.w, c.h, 16);
    ctx.fillStyle = done ? 'rgba(7,193,96,0.12)' : 'rgba(255,255,255,0.045)';
    ctx.fill();
    ui.sheen(ctx, c.x, c.y, c.w, c.h, 16);

    if (done) {
      ui.roundRect(ctx, c.x, c.y, c.w, c.h, 16);
      ctx.strokeStyle = 'rgba(7,193,96,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 左侧小徽记:达成是实心圆 + 勾,未达成是空心圆
    const bx = c.x + 30, by = c.y + 30, br = 12;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    if (done) {
      ctx.fillStyle = ui.COLORS.brand;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx - 5, by);
      ctx.lineTo(bx - 1, by + 5);
      ctx.lineTo(bx + 6, by - 5);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ui.text(ctx, a.name, c.x + 56, c.y + 28, {
      size: 25, color: done ? ui.COLORS.text : ui.COLORS.textSub, weight: 'bold',
    });

    // 金币奖励:这是成就存在的第二个理由 —— 它是皮肤的购买力来源。
    // 已领取的就写"已领",避免玩家以为还能再拿一次。
    ui.text(ctx, done ? ('已领 +' + a.coins) : ('+' + a.coins + ' 金币'),
      c.x + c.w - 20, c.y + 28, {
        size: 18, color: done ? 'rgba(7,193,96,0.85)' : ui.COLORS.gold,
        align: 'right', weight: 'bold',
      });

    ui.text(ctx, a.desc, c.x + 22, c.y + 60, {
      size: 18, color: 'rgba(255,255,255,0.45)',
    });

    if (!done) {
      ui.progress(ctx, {
        x: c.x + 22, y: c.y + 84, w: c.w - 130, h: 6,
        value: p.ratio, color: ui.COLORS.accent,
      });
      ui.text(ctx, p.text, c.x + c.w - 20, c.y + 87, {
        size: 17, color: 'rgba(255,255,255,0.5)', align: 'right',
      });
    }
  }
}

/* ---------- 渲染:外框 ---------- */

function renderHeader(ctx) {
  /* ★ 金币几何必须**先算** —— 药丸宽度随金币位数变化(max(146, 数字宽+52)),
   *   标题右侧那句附注要按它的实际左边缘收边。
   *
   *   这里曾经写死 `w: screen.width - 200`(右端留给药丸 200px),
   *   而 0 金币时药丸左边缘在 **556**、附注右端在 **598** ——
   *   附注最后两个字被金色药丸**压掉 42px**,正是玩家看到的"字体重合,看不清"。
   *   写死一个"大概够"的宽度,迟早会被真实数据(金币多一位)顶穿;
   *   几何量之间必须真的建立依赖。 */
  const coinTxt = String(archive.coins);
  const ctw = ui.measure(ctx, coinTxt, 28, 'bold');
  const groupW = 26 + 10 + ctw;
  const coinW = Math.max(146, groupW + 52);
  const pillX = screen.width - 48 - coinW;

  /* 标题用 section():左侧一根主题色短竖条,右侧一句"这里面有什么"。
   * 与排行榜、签到页同一套语气 —— 全作四个页面的标题长得一样,
   * 玩家就不需要靠读字来判断自己在哪一页。 */
  ui.section(ctx, {
    x: 48, y: screen.safeTop + 56, w: pillX - 24 - 48,
    text: '商城', size: 40, barH: 36, barColor: ui.COLORS.accent,
    note: '装扮 · 成就',
  });

  /* 金币:图标 + 数字,右对齐。
   * 这一页是全作唯一花金币的地方,"有多少钱"必须比别处更显眼 ——
   * 所以给它一个金色药丸;有了古钱图标之后,"金币"两个字就不必再写了。 */
  ui.pill(ctx, {
    x: pillX, y: screen.safeTop + 34, w: coinW, h: 54,
    fill: 'rgba(255,176,32,0.12)', stroke: 'rgba(255,176,32,0.34)',
  });
  const cgx = pillX + (coinW - groupW) / 2;
  ui.icon(ctx, 'coin', cgx, screen.safeTop + 48, 26, {
    color: ui.COLORS.gold, lineWidth: 2,
  });
  ui.text(ctx, coinTxt, cgx + 36, screen.safeTop + 61, {
    size: 28, color: ui.COLORS.gold, weight: 'bold',
  });

  /* 收藏进度条。
   * ★ 这里此前写的是「已拥有 6 / 24」,而右端已经有 4%,页签上又写了一遍
   *   「皮肤 1/24」——**同一件事在一屏里说了三遍**。
   *   玩家不会觉得"信息丰富",只会觉得"这页没收拾干净"。
   *   数字留给页签(那里它说明的是"这个列表有多少"),条子自己说明比例,
   *   这里只需要一个说明"这条是什么"的标签。 */
  const owned = Skins.countOwned(archive.ownedSkins);
  const total = Skins.SKINS.length;
  const pct = total > 0 ? Math.round((owned / total) * 100) : 0;
  ui.text(ctx, '收集进度', 48, screen.safeTop + 108, {
    size: 22, color: ui.COLORS.textSub,
  });
  ui.text(ctx, pct + '%', screen.width - 48, screen.safeTop + 108, {
    size: 22, color: ui.COLORS.brand, align: 'right', weight: 'bold',
  });
  ui.progress(ctx, {
    x: 48, y: screen.safeTop + 128, w: screen.width - 96, h: 8,
    value: total > 0 ? (owned / total) : 0, color: ui.COLORS.brand,
  });

  /* 生涯摘要:三个数字并排,中间两条竖分隔线。
   * 分隔线同时表达了两件事 —— "这是三个独立指标" 和 "它们同属我这一份生涯";
   * 少了它,三个数字就只是三串碰巧挨在一起的文字。 */
  const hl = Career.highlights(career);
  const startX = 48;
  const colW = (screen.width - 96) / hl.length;
  for (let i = 0; i < hl.length; i++) {
    const ccx = startX + colW * i + colW / 2;
    ui.text(ctx, hl[i].value, ccx, screen.safeTop + 166, {
      size: 28, color: ui.COLORS.text, align: 'center', weight: 'bold',
    });
    ui.text(ctx, hl[i].label, ccx, screen.safeTop + 196, {
      size: ui.TYPE.micro, color: ui.COLORS.textSub, align: 'center',
    });
    if (i < hl.length - 1) {
      ctx.save();
      ctx.fillStyle = ui.COLORS.line;
      ctx.fillRect(startX + colW * (i + 1), screen.safeTop + 156, 1, 50);
      ctx.restore();
    }
  }
}

function renderTabs(ctx) {
  const owned = Skins.countOwned(archive.ownedSkins);
  const achCount = Achievements.countDone(archive.achievements);

  const defs = [
    { key: TAB.SKINS, text: '皮肤 ' + owned + '/' + Skins.SKINS.length },
    { key: TAB.ACHIEVEMENTS, text: '成就 ' + achCount + '/' + Achievements.ALL.length },
  ];

  for (let i = 0; i < defs.length; i++) {
    const b = tabButtons[i];
    const on = tab === defs[i].key;
    const o = b.opt;
    ui.roundRect(ctx, o.x, o.y, o.w, o.h, 14);
    ctx.fillStyle = on ? ui.COLORS.brand : 'rgba(255,255,255,0.07)';
    ctx.fill();
    ui.text(ctx, defs[i].text, o.x + o.w / 2, o.y + o.h / 2, {
      size: 26, color: on ? '#ffffff' : ui.COLORS.textSub,
      align: 'center', baseline: 'middle', weight: 'bold',
    });
  }
}

/** 稀有度筛选条(只在皮肤页显示) */
function renderFilters(ctx) {
  for (let i = 0; i < filterButtons.length; i++) {
    const b = filterButtons[i];
    const o = b.opt;
    const key = FILTER_KEYS[i];
    const on = filter === key;

    ui.roundRect(ctx, o.x, o.y, o.w, o.h, 30);
    if (on) {
      ctx.fillStyle = key === FILTER_ALL
        ? ui.COLORS.accent
        : hexAlpha(Skins.RARITY[key].color, 0.9);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
    }

    // 未选中的档位也用它的稀有度色写字 —— 让"这条是什么档"在选中之前就能看出来
    const label = (key === FILTER_ALL ? RARITY_NAMES[0] : Skins.RARITY[key].name) + ' ' + countOf(key);
    ui.text(ctx, label, o.x + o.w / 2, o.y + o.h / 2, {
      size: 21,
      color: on ? '#ffffff' : (key === FILTER_ALL ? ui.COLORS.textSub : hexAlpha(Skins.RARITY[key].color, 0.85)),
      align: 'center', baseline: 'middle', weight: on ? 'bold' : '',
    });
  }
}

module.exports = {
  name: 'Shop',

  onEnter() {
    archive = Storage.loadArchive();
    career = Career.normalize(archive.career);
    archive.career = career;

    // 存档自愈:清掉已经不存在的皮肤 id、确保默认皮肤在列表里、装备项合法。
    // 这些都可能在旧存档 / 被手改的存档里出问题,进页面时一次性修好。
    const repaired = Skins.repairOwned(archive.ownedSkins);
    let dirty = repaired.length !== archive.ownedSkins.length;
    archive.ownedSkins = repaired;
    if (!Skins.isOwned(Skins.get(archive.equippedSkin), archive.ownedSkins)) {
      archive.equippedSkin = Skins.DEFAULT_SKIN_ID;
      dirty = true;
    }

    /* 把"拥有几款"同步进生涯并结清收集成就 —— 收集类成就是**从 career 的单字段**判定的
     * (见 achievements.js),而上一次买造型可能发生在上一局之前 / 甚至上一个版本,
     * 所以进页面时就对齐一次。
     * 不写这一步,收集成就要等到下一局结算才补发,玩家会觉得"我明明买了它却不认"。 */
    const collectAtEntry = syncCollection();
    if (dirty) persist();

    tab = TAB.SKINS;
    filter = FILTER_ALL;
    scrollY = 0;
    sheetSkin = null;

    tabButtons = [
      ui.button({
        x: 48, y: screen.safeTop + 216, w: 320, h: 76, text: '', radius: 14,
        onClick: () => { tab = TAB.SKINS; scrollY = 0; rebuild(); },
      }),
      ui.button({
        x: screen.width - 368, y: screen.safeTop + 216, w: 320, h: 76, text: '', radius: 14,
        onClick: () => { tab = TAB.ACHIEVEMENTS; scrollY = 0; rebuild(); },
      }),
    ];

    // 筛选条:5 个 chip(全部 + 4 个付费档),等宽铺满,两边各留 24
    // 这里按 FILTER_KEYS 顺序铺,与 renderFilters 必须一致(同一个数组,不会漂)
    const chipGap = 10;
    const chipW = Math.floor((screen.width - 48 - chipGap * (FILTER_KEYS.length - 1)) / FILTER_KEYS.length);
    const chipTotalW = chipW * FILTER_KEYS.length + chipGap * (FILTER_KEYS.length - 1);
    const chipStartX = (screen.width - chipTotalW) / 2;
    filterButtons = FILTER_KEYS.map((key, i) => ui.button({
      x: chipStartX + i * (chipW + chipGap), y: screen.safeTop + 296,
      w: chipW, h: 52, text: '', radius: 30,
      onClick: () => {
        filter = key;
        scrollY = 0;
        rebuild();
        Analytics.track('shop_filter', { rarity: key });
      },
    }));

    backButton = ui.button({
      x: screen.width / 2 - 220, y: screen.height - 124 - screen.safeBottom, w: 440, h: 92,
      text: '返 回', fontSize: 32, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => SceneManager.pop(),
    });

    /* 详情弹层的两个按钮 —— 位置在弹层坐标系里算好,这里只建一次。
     * 主按钮的**文字与配色每帧由 renderSheet 现算**(买/换/还差多少是三种不同的话),
     * 所以这里 `text: ''`、只借用它的命中判定与按压态 —— 与页签按钮同一套做法。 */
    const sr = sheetRect();
    sheetMainBtn = ui.button({
      x: sr.x + 60, y: sr.y + SHEET_MAIN_Y, w: SHEET_W - 120, h: 92, text: '', radius: 22,
      onClick: () => sheetMainAction(),
    });
    sheetCloseBtn = ui.button({
      x: sr.x + 60, y: sr.y + SHEET_CLOSE_Y, w: SHEET_W - 120, h: 74, text: '', radius: 18,
      onClick: () => closeSheet(),
    });

    toastText = '';
    toastSub = '';
    toastTimer = 0;

    /* 进页面那一刻就已经集齐了(比如旧存档里早买够了 5 款)→ 现在就把奖发掉,
     * 别让他等到下一局。飘字必须写在上面那次清零**之后**,否则刚写好就被自己抹掉。 */
    if (collectAtEntry) {
      archive.coins += collectAtEntry.coins;
      showToast('成就「' + collectAtEntry.list[0].name + '」　奖励 +' + collectAtEntry.coins + ' 金币',
        '已收集 ' + career.skinsOwned + ' / ' + Skins.SKINS.length + ' 款造型');
      persist();
    }
    rebuild();

    Analytics.track('shop_view', { owned: Skins.countOwned(archive.ownedSkins) });
  },

  onUpdate(dt) {
    if (toastTimer > 0) toastTimer -= dt;
  },

  onRender() {
    const ctx = screen.ctx;
    ui.bg(ctx, screen.width, screen.height, { tint: ui.COLORS.gold });

    renderHeader(ctx);
    renderTabs(ctx);
    if (tab === TAB.SKINS) renderFilters(ctx);

    // 内容区:超出部分裁掉,滚动时不越界盖住顶部和底部
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, contentTop() - 8, screen.width, contentBottom() - contentTop() + 16);
    ctx.clip();
    ctx.translate(0, -scrollY);
    if (tab === TAB.SKINS) renderSkinCells(ctx);
    else renderAchCells(ctx);
    ctx.restore();

    // 滚动提示:内容还有更多时,底部画一条淡线
    if (scrollY + (contentBottom() - contentTop()) < maxScroll) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, contentBottom() - 2, screen.width, 2);
    }

    backButton.render(ctx);

    // 详情弹层盖在最上层(它自带遮罩);toast 再盖在弹层之上 ——
    // 在弹层里买成功时,那句"成就…奖励 +N 金币"必须能被看见。
    renderSheet(ctx);

    if (toastTimer > 0) {
      const cx = screen.width / 2;
      const hasSub = !!toastSub;
      const th = hasSub ? 132 : 96;
      const top = screen.height * 0.5 - th / 2;
      ui.roundRect(ctx, cx - 350, top, 700, th, 18);
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fill();
      ui.text(ctx, toastText, cx, hasSub ? top + 50 : top + 48, {
        size: hasSub ? 25 : 26, color: '#ffffff', align: 'center', weight: 'bold',
      });
      if (hasSub) {
        ui.text(ctx, toastSub, cx, top + 90, {
          size: 22, color: ui.COLORS.textSub, align: 'center',
        });
      }
    }
  },

  /* ---------- 触摸:拖动滚动 + 点击 ---------- */
  onTouchStart(p) {
    // 弹层打开时它独占输入 —— 底下的页面不该还能被点到(否则会隔着弹层买到底下的皮肤)
    if (sheetSkin) {
      sheetMainBtn.onDown(p);
      sheetCloseBtn.onDown(p);
      dragging = false;
      return;
    }

    backButton.onDown(p);
    tabButtons.forEach((b) => b.onDown(p));
    if (tab === TAB.SKINS) filterButtons.forEach((b) => b.onDown(p));

    // 起手落在固定区域(页签/筛选/返回)时不参与滚动,否则页面会跟着手指乱晃
    if (backButton.hit(p) || tabButtons.some((b) => b.hit(p)) ||
        (tab === TAB.SKINS && filterButtons.some((b) => b.hit(p)))) {
      dragging = false;
      return;
    }
    dragging = true;
    dragStartY = p.y;
    dragStartScroll = scrollY;
    dragMoved = false;
  },

  onTouchMove(p) {
    if (sheetSkin) return;              // 弹层内不滚动
    if (!dragging) return;
    const dy = p.y - dragStartY;
    if (Math.abs(dy) > DRAG_THRESHOLD) dragMoved = true;
    if (dragMoved && maxScroll > 0) {
      scrollY = Math.max(0, Math.min(dragStartScroll - dy, maxScroll));
    }
  },

  onTouchEnd(p) {
    /* ---- 弹层打开时:只有它的两个按钮与"点空白处关闭" ---- */
    if (sheetSkin) {
      let consumed = false;
      if (sheetMainBtn.onUp(p)) consumed = true;
      if (sheetCloseBtn.onUp(p)) consumed = true;
      if (consumed) return;

      const r = sheetRect();
      const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
      if (!inside) closeSheet();        // 点遮罩关闭 —— 移动端最顺手的一种关闭方式
      return;
    }

    // 先让固定按钮结算(返回、页签、筛选)
    let consumed = false;
    backButton.onUp(p);
    tabButtons.forEach((b) => { if (b.onUp(p)) consumed = true; });
    if (tab === TAB.SKINS) filterButtons.forEach((b) => { if (b.onUp(p)) consumed = true; });

    const wasDragging = dragging;
    const moved = dragMoved;
    dragging = false;
    dragMoved = false;

    if (consumed || !wasDragging || moved) return;   // 滚动 / 点按钮,都不是"点内容"

    // 只在内容视口内接受点击,避免和底部按钮的重叠区域重复响应
    if (p.y < contentTop() - 8 || p.y > contentBottom() + 8) return;

    // 命中检测要加上滚动偏移 —— 内容被 translate 过,屏幕坐标和内容坐标差一个 scrollY
    const cy = p.y + scrollY;

    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      if (p.x >= c.x && p.x <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) {
        if (c.skin) onSkinTap(c);
        // 成就格不需要操作,但点一下给出进度反馈 —— 让"没达成"也有信息量
        else if (c.ach && !Achievements.isDone(c.ach, career)) {
          const pr = Achievements.progressOf(c.ach, career);
          showToast('当前进度 ' + pr.text);
        }
        break;
      }
    }
  },

  onExit() {
    if (archive) persist();
  },
};
