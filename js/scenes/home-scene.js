/**
 * scenes/home-scene.js —— 主页
 *
 * 主页要同时回答玩家的五个问题:
 *   ① 我现在是什么样(当前皮肤头像 + 昵称)
 *   ② 我玩到哪了(当前模式的最高分 + 皮肤/成就/累计签到三张统计卡)
 *   ③ 我要玩哪个玩法(四个模式 chip,每个显示自己那一档的最高分)
 *   ④ 接下来该做什么(下一款皮肤还差多少金币 —— 这一行是整个长期目标的牵引绳)
 *   ⑤ 今天有没有事可做(签到卡:没签就带红点)
 *
 * ────────────────────────────────────────────────────────────────
 * 关于按钮数量的取舍:
 *   原来的原则是"克制,每多一个按钮首屏转化就掉一点"。
 *   这一版把入口加到 3 个(商城/排行榜/签到卡)+ 一行模式 chip,
 *   但**主按钮的视觉权重没有变**:「开始游戏」独占一行、440×112、品牌绿;
 *   其余都是深灰小按钮、整卡入口,或一排 78 高的 chip。
 *   克制不等于少,而是**主次必须一眼可辨** —— 玩家不需要读字就知道该点哪。
 *
 * 关于模式 chip 为什么不另开一个"选模式"页面:
 *   模式是**高频、低决策成本**的选择(四个选项,选中就生效),
 *   为它加一层导航,等于每次开局前多两次点击。
 *   横排 chip 让"换模式"和"开始游戏"共处一屏,点一下就能换 ——
 *   这正是"降低重开摩擦"在主页上的对应做法。
 *
 * 关于布局:下半部分全部**以屏幕底部为锚**(bottom - N),而不是以 safeTop 为锚。
 *   原因是不同机型的设计高度差异很大(16:9 → 1334,21:9 → 1750);
 *   底部锚定能让这一整块在长屏上自然下移、留白落在中间,而不是被拉散。
 * ────────────────────────────────────────────────────────────────
 */
const cfg = require('../config/config.js');
const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');
const Storage = require('../framework/storage.js');

const Career = require('../gameplay/career.js');
const Skins = require('../gameplay/skins.js');
const Achievements = require('../gameplay/achievements.js');
const Checkin = require('../gameplay/checkin.js');
const Modes = require('../gameplay/modes.js');

const Auth = require('../platform/auth.js');
const Share = require('../platform/share.js');
const Analytics = require('../platform/analytics.js');

const Dates = require('../utils/date.js');

let archive = null;
let career = null;
let skin = null;
let skinVisual = null;     // 头像的绘制参数(skins.visualOf 的结果)
let signin = null;        // Checkin.plan() 的结果
let currentMode = null;   // Modes.resolve(archive.mode)
let buttons = [];         // 开始游戏 / 商城 / 排行榜
let signinCard = null;    // 整卡可点的"每日签到"
let modeChips = [];       // 四个模式 chip(自己画,因为要表达"选中态")
let pressedChip = null;
let pulse = 0;
let enterT = 0;           // 入场动画计时(秒),进主页时从 0 开始

/* ---------- 底部锚定的布局表(设计坐标,单位 px) ---------- */
function bottom() {
  return screen.height - 120 - screen.safeBottom;
}

const L = {
  nav:    { dy: -198, h: 96 },   // 商城 / 排行榜
  start:  { dy: -330, h: 112 },  // 开始游戏(主按钮)
  mode:   { dy: -452, h: 104 },  // 四个模式 chip(名字 / 机制 / 最高分,三行)
  signin: { dy: -560, h: 92 },   // 签到卡
  goal:   { dy: -644, h: 76 },   // 下一款皮肤:带进度的小卡
  /* 三张统计卡。h 从 100 → 108 是本轮唯一一处布局改动,原因见 ui.stat 的注释:
   * 图标 26 + 数值块 36.5 + 标签 17 三层,加上各 6px 净空就要 91.5px ——
   * 100 减去它们只剩 8.5px,两边各 4px,标签只能贴着单位画。
   * 底边**没动**(dy+h 与改前都是 B−652),所以它下面那张 goal 卡和
   * 所有可点元素的坐标一个都没变,测试的点击点也不会落空。 */
  stats:  { dy: -760, h: 108 },
};

module.exports = {
  name: 'Home',

  onEnter() {
    reload();
    buildButtons();
    buildModeChips();
    enterT = 0;          // 进场重放一次入场动画(从商城/结算返回时 onResume,不重放)

    // 注册分享内容:主页分享的是"来玩"而不是分数
    Share.setShareContent(() => ({
      title: '来玩《' + cfg.GAME_NAME + '》,看谁分数高!',
      query: 'from=home&mode=' + currentMode.id,
    }));

    // 每次回主页都可能带着新的金币/皮肤回来,埋点记录一次进度快照
    Analytics.track('home_view', {
      mode: currentMode.id,
      best: archive.bestScore,
      modeBest: modeBest(currentMode.id),
      coins: archive.coins,
      runs: career.runs,
      signedToday: signin.signedToday,
    });
  },

  /** 重新读存档并归一化(从商城/签到/结算返回时调用,保证显示的是最新状态) */
  onResume() {
    reload();
    buildButtons();
    buildModeChips();
  },

  startGame() {
    Analytics.track('game_start', { mode: currentMode.id, bestScore: archive.bestScore });
    SceneManager.replace('Game');
  },

  goShop() {
    Analytics.track('shop_view', { from: 'home' });
    SceneManager.push('Shop');
  },

  goRank() {
    Analytics.track('rank_view', { from: 'home' });
    SceneManager.push('Rank');
  },

  goSignin() {
    Analytics.track('signin_view', { from: 'home' });
    SceneManager.push('Signin');
  },

  /** 切换玩法模式并落盘 —— 选完立刻生效,下一次开局就用新参数 */
  selectMode(id) {
    if (!Modes.isValid(id) || id === currentMode.id) return;
    archive.mode = id;
    Storage.saveArchive(archive);
    currentMode = Modes.resolve(id);
    Analytics.track('mode_select', { mode: id, from: 'home' });
    pulse = 0;
  },

  onUpdate(dt) {
    // 呼吸相位:只喂给"今天还没签"的签到卡和红点
    pulse += dt;
    // 入场动画只跑一小段,跑完就不再累加(避免这个数在长会话里无限增长)
    if (enterT < 2) enterT += dt;
  },

  onRender() {
    const ctx = screen.ctx;
    // 背景换成渐变(原来是纯色)—— 顶部偏亮、底部收暗,大屏上立刻有了纵深
    ui.bg(ctx, screen.width, screen.height, { tint: ui.COLORS.brand });

    const cx = screen.width / 2;
    const B = bottom();

    /* ---- 入场:整页从下方 18px 淡入上浮 ----
     * 刻意不做"每个元素错开进场":那需要在七八处 save/restore,
     * 而"整页一起进"已经足够消除"啪一下出现"的生硬感,代价只有一对。 */
    const e = ui.Ease.outCubic(Math.min(1, enterT / 0.34));
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(0, (1 - e) * 18);

    /* ---- 顶栏:皮肤(当作头像用)+ 昵称 + 金币 ---- */
    // 给头像一块卡座 —— 否则一个色块直接浮在渐变背景上,四周没有边界,像贴纸
    ui.card(ctx, {
      x: 40, y: screen.safeTop + 12, w: 112, h: 112, r: ui.RADIUS.lg,
      fill: 'rgba(255,255,255,0.05)', stroke: ui.COLORS.stroke, sheen: false,
    });
    ui.sprite(ctx, {
      x: 48, y: screen.safeTop + 20, size: 96,
      shape: skinVisual.shape, body: skinVisual.body,
      accent: skinVisual.accent, glow: skinVisual.glow,
      spin: skinVisual.spin, halo: skinVisual.halo,
      edge: skinVisual.edge, orbit: skinVisual.orbit,
    });

    const user = Auth.getUser();
    // 昵称用 fitText 而不是写死字号 —— 名字长度不可控,固定字号一定会压到金币药丸上
    ui.fitText(ctx, (user && user.nickname) || '游客玩家', 176, screen.safeTop + 48,
      screen.width - 96 - 176 - 210, {
        size: 34, color: ui.COLORS.text, weight: 'bold', minSize: 22,
      });

    /* 当前造型:一个轮廓图标 + 名字。
     * 图标是这一版加的 —— 一串文字前面挂一枚图标,扫读速度的提升比换字体明显得多,
     * 而且它顺手说明了"这一行讲的是造型,不是昵称"。 */
    ui.icon(ctx, 'shapes', 176, screen.safeTop + 86, 22, {
      color: ui.COLORS.textDim, lineWidth: 1.7,
    });
    ui.text(ctx, skin.name, 208, screen.safeTop + 97, {
      size: 22, color: ui.COLORS.textSub,
    });

    /* 金币:图标 + 数字。
     * 有古钱图标时,"金币"两个字是多余的 —— 形状比文字认得快。
     * 图标 + 数字一起居中,而不是让数字单独居中(否则图标会把整组推歪)。 */
    const coinTxt = String(archive.coins);
    const ctw = ui.measure(ctx, coinTxt, 28, 'bold');
    const groupW = 26 + 10 + ctw;
    const coinW = Math.max(146, groupW + 52);
    const pillX = screen.width - 48 - coinW;
    ui.pill(ctx, {
      x: pillX, y: screen.safeTop + 36, w: coinW, h: 54,
      fill: 'rgba(255,176,32,0.12)', stroke: 'rgba(255,176,32,0.34)',
    });
    const cgx = pillX + (coinW - groupW) / 2;
    ui.icon(ctx, 'coin', cgx, screen.safeTop + 50, 26, {
      color: ui.COLORS.gold, lineWidth: 2,
    });
    ui.text(ctx, coinTxt, cgx + 36, screen.safeTop + 63, {
      size: 28, color: ui.COLORS.gold, weight: 'bold',
    });

    /* ---- 主体:当前模式的最高分 ----
     * 显示的是**当前模式**的纪录,而不是全模式最高:
     * 玩家点「疾风」看到经典留下的高分,只会以为"这模式没记我的成绩"。
     *
     * 排版上补了两件小事:上面一行小字说清"这是什么分数",
     * 数字后面跟一个小一号的"分" —— 与排行榜、签到页、结算面板同一套数字语言。
     * 一个 96px 的裸数字不加说明,玩家得自己猜它是分数、金币还是名次。 */
    ui.text(ctx, '本模式最高分', cx, screen.safeTop + 180, {
      size: ui.TYPE.eyebrow, color: ui.COLORS.textDim, align: 'center',
      stroke: 'rgba(0,0,0,0.35)', strokeWidth: 4,
    });

    const bestStr = String(modeBest(currentMode.id));
    const bestW = ui.measure(ctx, bestStr, 96, 'bold');
    const unitW = ui.measure(ctx, '分', 26, 'bold');
    const grpW = bestW + 10 + unitW;
    ui.text(ctx, bestStr, cx - grpW / 2 + bestW / 2, screen.safeTop + 252, {
      size: 96, color: ui.COLORS.text, align: 'center', weight: 'bold',
      stroke: 'rgba(0,0,0,0.5)', strokeWidth: 8,
    });
    ui.text(ctx, '分', cx - grpW / 2 + bestW + 10, screen.safeTop + 274, {
      size: 26, color: ui.COLORS.textSub, weight: 'bold',
      stroke: 'rgba(0,0,0,0.4)', strokeWidth: 4,
    });

    // 模式名做成药丸,描边取模式色 —— 一眼就知道"这个分数属于哪一套规则"
    const mLabel = currentMode.name + ' 模式 · 最高分';
    const mw = mLabel.length * 22 + 56;
    ui.pill(ctx, {
      x: cx - mw / 2, y: screen.safeTop + 302, w: mw, h: 46,
      fill: 'rgba(255,255,255,0.06)', stroke: currentMode.color,
    });
    ui.text(ctx, mLabel, cx, screen.safeTop + 325, {
      size: 25, color: currentMode.color, align: 'center', weight: 'bold',
    });

    // 非经典模式不计入全服榜。放在分数正下方 ——
    // 因为它解释的正是"你刚看到的这个分数到底算不算数"。
    if (!currentMode.scoreboard) {
      ui.text(ctx, '「' + currentMode.tag + '」模式不计入全服榜,只记本地纪录',
        cx, screen.safeTop + 372, {
          size: 20, color: ui.COLORS.textDim, align: 'center',
        });
    }

    /* ---- 三张统计卡:皮肤 / 成就 / 累计签到 ----
     * 改成**一条指标栏**(一张卡 + 两条竖分隔线),而不是三张独立小卡:
     * 三个数字本来就是一组,共用一张底才读得出"它们同属我这一份进度"。 */
    renderStats(ctx, B + L.stats.dy);

    /* ---- 下一款皮肤:长期目标的牵引绳,必须每天被看见 ----
     * 从"一行居中文字"升级成**一张带进度的小卡**:
     * 一句话只能说"还差 120 金币",一条进度条能让人立刻看到"快到了"。
     * 而"快到了"才是驱动下一次点击的那个感觉。 */
    renderGoal(ctx, B + L.goal.dy);

    /* ---- 签到卡(整卡可点)---- */
    signinCard.render(ctx);
    renderSigninText(ctx);

    /* ---- 模式选择 ---- */
    renderModeChips(ctx);

    /* ---- 其余按钮 ---- */
    buttons.forEach((b) => b.render(ctx));

    ctx.restore();
  },

  onTouchStart(p) {
    buttons.forEach((b) => b.onDown(p));
    signinCard.onDown(p);
    pressedChip = hitModeChip(p);
  },

  onTouchEnd(p) {
    buttons.forEach((b) => b.onUp(p));
    signinCard.onUp(p);

    // 模式 chip:按下与抬起都落在同一个 chip 上才算选中 ——
    // 与按钮同口径,避免"在 chip 上滑出去"被误判成一次选择
    const chip = hitModeChip(p);
    if (chip && chip === pressedChip) module.exports.selectMode(chip.id);
    pressedChip = null;
  },

  onExit() { pressedChip = null; },
};

/* ============================================================
 * 内部:数据
 * ============================================================ */

/** 某个模式的历史最高分(没有记录返回 0) */
function modeBest(id) {
  const n = Number((archive.bestByMode || {})[id]);
  return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
}

function reload() {
  archive = Storage.loadArchive();
  career = Career.normalize(archive.career);
  archive.career = career;

  // 存档自愈:清掉已经不存在的皮肤 id、确保默认皮肤在列表里。
  // 玩家可能刚在商城买了皮肤,也可能带着一个旧版本写坏的存档回来。
  const repaired = Skins.repairOwned(archive.ownedSkins);
  let dirty = repaired.length !== archive.ownedSkins.length;
  archive.ownedSkins = repaired;
  if (!Skins.isOwned(Skins.get(archive.equippedSkin), archive.ownedSkins)) {
    archive.equippedSkin = Skins.DEFAULT_SKIN_ID;
    dirty = true;
  }

  // 模式同一个道理:存档里可能是空串(v4 默认)或一个已经不存在的 id,
  // 都由 Modes 决议成一个真实存在的模式,并把决议结果写回去。
  const resolved = Modes.get(archive.mode).id;
  if (resolved !== archive.mode) {
    archive.mode = resolved;
    dirty = true;
  }

  if (dirty) Storage.saveArchive(archive);

  skin = Skins.get(archive.equippedSkin);
  // 头像的绘制参数在进入时就解析好 —— 稀有度带来的光效是数据层算的(见 skins.visualOf)
  skinVisual = Skins.visualOf(skin);
  currentMode = Modes.resolve(archive.mode);
  signin = Checkin.plan(archive, Dates.todayStr());
}

function buildButtons() {
  const cx = screen.width / 2;
  const B = bottom();

  buttons = [
    // 主按钮:更大、更亮、按下会缩一点点,并且带一圈描边把边缘"立"起来。
    // 主页有 3 个按钮 + 4 个 chip + 1 张签到卡,主次必须一眼可辨 ——
    // 玩家不该需要读字就知道该点哪一个。
    ui.button({
      x: cx - 220, y: B + L.start.dy, w: 440, h: L.start.h,
      text: '开 始 游 戏', fontSize: 40,
      color: ui.COLORS.brand, pressColor: ui.COLORS.brandDark,
      pressScale: 0.965, stroke: 'rgba(255,255,255,0.22)',
      onClick: () => module.exports.startGame(),
    }),
    // 次级按钮:深灰、无描边,视觉上主动"退后"
    ui.button({
      x: cx - 220, y: B + L.nav.dy, w: 210, h: L.nav.h,
      text: '商 城', fontSize: 30, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => module.exports.goShop(),
    }),
    ui.button({
      x: cx + 10, y: B + L.nav.dy, w: 210, h: L.nav.h,
      text: '排行榜', fontSize: 30, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => module.exports.goRank(),
    }),
  ];

  // 签到卡:自身只画底板,文字由 renderSigninText 画在上面 ——
  // 这样"没签"时能在卡上叠红点与金色描边,而不是被按钮的渲染盖住
  signinCard = ui.button({
    x: 48, y: B + L.signin.dy, w: screen.width - 96, h: L.signin.h,
    text: '', color: ui.COLORS.panel, pressColor: '#28323f', radius: 18,
    onClick: () => module.exports.goSignin(),
  });
}

/** 四个模式 chip 的矩形 —— 等宽平分,不依赖文字长度(否则选中态会"跳") */
function buildModeChips() {
  const defs = Modes.list();
  const gap = 12;
  const total = screen.width - 96;
  const w = Math.floor((total - gap * (defs.length - 1)) / defs.length);
  const startX = (screen.width - (w * defs.length + gap * (defs.length - 1))) / 2;
  const y = bottom() + L.mode.dy;

  modeChips = defs.map((d, i) => ({
    id: d.id,
    def: d,
    x: startX + i * (w + gap),
    y: y,
    w: w,
    h: L.mode.h,
  }));
}

function hitModeChip(p) {
  for (let i = 0; i < modeChips.length; i++) {
    const c = modeChips[i];
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return c;
  }
  return null;
}

/* ============================================================
 * 内部:绘制
 * ============================================================ */

/** 四个模式 chip —— 名字 / 机制 / 最高分三行,选中态用模式自己的主题色描边 */
function renderModeChips(ctx) {
  for (let i = 0; i < modeChips.length; i++) {
    const c = modeChips[i];
    const on = c.id === currentMode.id;
    const press = pressedChip === c;   // 视觉反馈,不影响判定

    ui.card(ctx, {
      x: c.x, y: c.y, w: c.w, h: c.h, r: ui.RADIUS.sm,
      fill: on
        ? 'rgba(255,255,255,0.10)'
        : (press ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)'),
      stroke: on ? c.def.color : ui.COLORS.stroke,
      strokeWidth: on ? 3 : 1,
      sheen: on,
    });

    ui.text(ctx, c.def.name, c.x + c.w / 2, c.y + 28, {
      size: 27,
      color: on ? c.def.color : ui.COLORS.text,
      align: 'center', weight: 'bold',
    });

    // 机制标签 —— 这一行才是"四个模式到底哪里不一样"的答案。
    // 参数上的差异玩家永远看不见,机制名看得见;
    // 而且它由 Modes.mechanicOf 从**实际参数**派生,不会出现"写着摆动其实没开"。
    ui.text(ctx, Modes.mechanicOf(c.def) || '基准', c.x + c.w / 2, c.y + 56, {
      size: 18,
      color: on ? c.def.color : ui.COLORS.textDim,
      align: 'center',
    });

    const best = modeBest(c.id);
    ui.text(ctx, best > 0 ? String(best) : '—', c.x + c.w / 2, c.y + 82, {
      size: 20, color: on ? ui.COLORS.text : ui.COLORS.textSub, align: 'center',
    });
  }
}

/** 三张统计卡 —— 把"我攒了什么"拆成三个可比较的数字,并排成一条指标栏 */
function renderStats(ctx, y) {
  const owned = Skins.countOwned(archive.ownedSkins);
  const achDone = Achievements.countDone(archive.achievements);

  /* 用 ui.stat 而不是三张手写小卡:图标 / 数值 / 单位 / 标签 四层的位置
   * 由同一份代码决定,于是"皮肤 3/24"和"累计签到 7 天"的基线必然对齐 ——
   * 手写三遍时它们一定会差那么一两像素,而那一点点差异就是"没做完"的来源。 */
  ui.stat(ctx, {
    x: 48, y: y, w: screen.width - 96, h: L.stats.h,
    items: [
      {
        icon: 'shapes', value: owned, unit: '/' + Skins.SKINS.length,
        label: '皮肤', color: ui.COLORS.brand,
      },
      {
        icon: 'medal', value: achDone, unit: '/' + Achievements.ALL.length,
        label: '成就', color: ui.COLORS.accent,
      },
      {
        icon: 'calendar', value: signin.total, unit: '天',
        label: '累计签到', color: ui.COLORS.gold,
      },
    ],
  });
}

/**
 * 下一款造型的目标卡 —— 主页上唯一的"往前看"。
 *
 * 原来这里是一行居中文字("再攒 120 金币就能买「苔痕」")。一句话只能表达差额,
 * 表达不了"我离它有多近";而"快到了"恰恰是驱动下一次点击的那个感觉。
 * 所以改成一张卡:左边把**下一款长什么样**直接画出来,右边把差额做成大数字,
 * 底部一条贴着下沿的进度条 —— 像一格电量,扫一眼就知道还剩多少。
 *
 * 已经是最后一款(全收集)时,这里换成一句"你已经是这个游戏本身了" ——
 * 目标消失了,但不该变成一片空白。
 */
function renderGoal(ctx, y) {
  const x = 48;
  const w = screen.width - 96;
  const h = L.goal.h;
  const goal = Skins.nextGoal(archive.coins, archive.ownedSkins);

  const reached = !!goal && goal.progress.left <= 0;

  ui.card(ctx, {
    x: x, y: y, w: w, h: h, r: ui.RADIUS.lg,
    fill: goal ? 'rgba(47,107,255,0.10)' : 'rgba(255,176,32,0.10)',
    stroke: goal ? 'rgba(47,107,255,0.34)' : 'rgba(255,176,32,0.36)',
    sheen: false,
  });

  if (!goal) {
    ui.icon(ctx, 'crown', x + 22, y + h / 2 - 16, 32, { color: ui.COLORS.gold });
    ui.text(ctx, '全部造型已收集完', x + 70, y + h / 2 - 10, {
      size: 22, color: ui.COLORS.gold, weight: 'bold',
    });
    ui.text(ctx, '你已经是这个游戏本身了', x + 70, y + h / 2 + 14, {
      size: ui.TYPE.micro, color: ui.COLORS.textSub,
    });
    return;
  }

  const skin = goal.skin;
  const p = goal.progress;
  const v = Skins.visualOf(skin);

  // 小预览:让"下一款长什么样"先被看见 ——
  // 目标如果只是一个名字,动力会少一半;这和后一版商城的"演示即商品"是同一条道理。
  ui.sprite(ctx, {
    x: x + 18, y: y + 14, size: 44,
    shape: v.shape, body: v.body, accent: v.accent,
    glow: v.glow, halo: v.halo, orbit: v.orbit, edge: v.edge,
  });

  ui.text(ctx, '下一款目标', x + 74, y + 24, {
    size: 16, color: ui.COLORS.textDim,
  });
  ui.text(ctx, skin.name + ' · ' + Skins.rarityOf(skin).name, x + 74, y + 46, {
    size: 21, color: ui.COLORS.text, weight: 'bold',
  });

  // 右侧差额:数值大、单位小,和全作其它数字同一套排版
  const right = x + w - 22;
  if (reached) {
    ui.text(ctx, '已买得起', right, y + 46, {
      size: 22, color: ui.COLORS.gold, align: 'right', weight: 'bold',
    });
  } else {
    const uw = ui.measure(ctx, '金币', 17, 'bold');
    ui.text(ctx, String(p.left), right - uw - 5, y + 44, {
      size: 30, color: ui.COLORS.accentLight, align: 'right', weight: 'bold',
    });
    ui.text(ctx, '金币', right, y + 50, {
      size: 17, color: ui.COLORS.textSub, align: 'right', weight: 'bold',
    });
  }

  // 进度条贴着卡片下沿:进度是这一行真正的主角,它该有自己的位置
  ui.progress(ctx, {
    x: x + 18, y: y + h - 14, w: w - 36, h: 6,
    value: p.ratio, radius: 3,
    color: reached ? ui.COLORS.gold : ui.COLORS.accent,
  });
}

/** 签到卡上的文字与红点 */
function renderSigninText(ctx) {
  const o = signinCard.opt;
  const unsigned = !signin.signedToday;

  // 未签:金色描边 + 呼吸(幅值很小,只是让静态界面有一点"在等你"的感觉)
  if (unsigned) {
    const breathe = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(pulse * 3));
    ctx.save();
    ui.roundRect(ctx, o.x, o.y, o.w, o.h, 18);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,176,32,' + breathe + ')';
    ctx.stroke();
    ctx.restore();
  }

  // 左侧一枚日历图标:它把"签到"这件事的**周期感**先说出来,
  // 未签时用金色(与呼吸描边同一个语义色),已签时退成灰
  ui.icon(ctx, 'calendar', o.x + 26, o.y + o.h / 2 - 16, 32, {
    color: unsigned ? ui.COLORS.gold : ui.COLORS.textDim,
  });

  const tx = o.x + 74;
  ui.text(ctx, '每日签到', tx, o.y + 32, {
    size: 28, color: ui.COLORS.text, weight: 'bold',
  });

  const sub = unsigned
    ? ('今天可领 +' + signin.reward + ' 金币　第 ' + signin.cycleIndex + '/' + Checkin.CYCLE_DAYS + ' 天')
    : ('已签到 · 连签 ' + signin.streak + ' 天　明天继续');
  ui.text(ctx, sub, tx, o.y + 66, {
    size: 22, color: unsigned ? ui.COLORS.gold : ui.COLORS.textSub,
  });

  /* 右箭头改成**矢量画法**。
   * 原来用的是字体里的字符 '›' —— 不同机型上字重、基线、左右边距全不一样,
   * 是那种"在开发机上好好的、在别人手机上歪了"的典型来源。两条线画出来就永远一样。 */
  const ax = o.x + o.w - 40;
  const ay = o.y + o.h / 2;
  ctx.save();
  ctx.strokeStyle = ui.COLORS.textSub;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax - 7, ay - 12);
  ctx.lineTo(ax + 6, ay);
  ctx.lineTo(ax - 7, ay + 12);
  ctx.stroke();
  ctx.restore();

  // 红点:没签到才有。位置压在卡片右上角外侧一点,保证不会被忽略。
  if (unsigned) {
    const dx = o.x + o.w - 32;
    const dy = o.y + 4;
    ctx.save();
    ctx.beginPath();
    ctx.arc(dx, dy, 13, 0, Math.PI * 2);
    ctx.fillStyle = ui.COLORS.danger;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = ui.COLORS.bg;
    ctx.stroke();
    ctx.restore();
  }
}
