/**
 * scenes/signin-scene.js —— 每日签到页
 *
 * 为什么签到值得单独一页(而不是主页上一个按钮):
 *   一个"点一下 +100"的按钮,玩家点完就忘了 —— 它只兑现了今天的奖励,
 *   没有传达**明天还该来**这件事。
 *   这一页真正要回答的是:"我再签几天会发生什么?"
 *   所以页面主体不是按钮,是那条**7 格周期**:已签的点亮、今天的在闪、
 *   第 7 格挂着大奖。玩家扫一眼就知道自己站在哪、下一个甜头在哪。
 *
 * 规则全部在 gameplay/checkin.js(纯逻辑、可单测),这里只负责画和转发输入。
 * 这是刻意的:日期相关的分支(跨月/跨年/断签/重复点按)在这种页面里最难手工验证,
 * 放进纯函数才能在 Node 里断言。
 *
 * ────────────────────────────────────────────────────────────────
 * ★ 本轮改版:从"五处居中文字"改成"有层级的一张单页"
 *
 * 改版前的版面从上到下依次是:标题、两个居中的词、一个巨大的数字、
 * 一行灰字、两行更小的灰字 —— 全部是**居中摆放的文字**。
 * 居中排版的问题不在于不好看,而在于**它无法表达层级**:
 * 一行居中字和另一行居中字之间,除了字号没有别的关系,
 * 于是"连签 12 天"和"断签不会清空累计天数"看起来一样重要。
 *
 * 现在这样做:
 *   ① 标题左对齐 + 主题色竖条(与排行榜、商城同一套 section 语言),
 *      右侧挂一条"7 天一个大奖"的说明 —— 玩家不用往下读就知道这页在给什么;
 *   ② 连签天数收进**一张主卡**:左边是火焰图标 + 大数字 + 单位"天",
 *      右边一条竖分隔线后是"累计签到"。两个数字从此有了主次,
 *      而且它们的关系(连续 vs 累计)被版面直接讲清楚了;
 *   ③ 日历与里程碑各带**区块标题**,末格的大奖仍然只用金色角标强调;
 *   ④ 底部那两行裸规则收进**规则卡**:每行前面挂一个图标。
 *      规则不是免责声明,它是"我为什么要每天来"的答案,值得一个卡片。
 * ────────────────────────────────────────────────────────────────
 */
const cfg = require('../config/config.js');

const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');
const Storage = require('../framework/storage.js');

const Checkin = require('../gameplay/checkin.js');

const Analytics = require('../platform/analytics.js');
const WX = require('../platform/wx-adapter.js');
const Dates = require('../utils/date.js');

/* ---------- 布局常量 ---------- */
const CAL_COLS = 4;
const CELL_W = 160;
const CELL_H = 150;
const CELL_GAP = 16;
const MILE_W = 165;
const MILE_H = 74;
const MILE_GAP = 12;

const HERO_Y = 112;          // 主卡相对 safeTop 的偏移
const HERO_H = 196;
const SECTION_DROP = 46;     // 区块标题基准线相对区块顶的下移量(见 renderCalendar / renderMilestones)
const SECTION_GAP = 20;      // 标题墨迹与上一个区块之间的最小净空

/* ★ 日历与里程碑的位置**必须从日历的实际高度推出来**,不能再各写一个常数。
 *
 *   旧值是 CAL_DY = 400 / MILE_DY = 762 —— 两个数里暗含着一个"大概够"的净空,
 *   而那个净空是 **4px**:里程碑标题的中心落在日历底边以下 4px,
 *   30px 字的墨迹整整扎进最后一排格子 7px。玩家的原话就是"这里也有问题"。
 *   (这与商城头部那次是同一类错:一个元素的位置取决于另一个元素的**实际尺寸**,
 *    就不能各算各的。)
 *
 *   预算按 **750×1334** 排 —— 那是预览页的高度(≈ iPhone 6/7/8),
 *   也是这套布局的下限(真机 1624 只会更宽松):
 *     日历底 = CAL_DY + CAL_H
 *     ↓ SECTION_GAP
 *     里程碑标题墨迹顶 = MILE_DY − SECTION_DROP − 11
 *     ↓ 里程碑 74
 *     里程碑底 = MILE_DY + MILE_H  ≤  规则卡顶(见 ruleCardY) − 16
 */
const CAL_ROWS = Math.ceil(Checkin.CYCLE_DAYS / CAL_COLS);          // 2
const CAL_H = CAL_ROWS * CELL_H + (CAL_ROWS - 1) * CELL_GAP;        // 316
const CAL_DY = HERO_Y + HERO_H + SECTION_DROP + 11 + SECTION_GAP;   // 385
const MILE_DY = CAL_DY + CAL_H + SECTION_DROP + 11 + SECTION_GAP;   // 778
const RULE_BACK = 470;       // 规则卡"底部锚定"时占掉的高度(按钮区在上方)

/**
 * 规则卡的纵向位置。
 *
 * 两个来源取更靠下的那个:
 *   · 顶部流 —— 紧贴在里程碑下面(矮屏时**必须**走这条,否则会压到里程碑);
 *   · 底部锚定 —— 真机上内容本来就排得下,保持"规则卡靠近底部按钮"的原样。
 * 用 max 而不是写死,是因为"装不装得下"由屏幕高度决定,
 * 而屏幕高度不是一个可以写进常量的东西。
 */
function ruleCardY() {
  const flow = screen.safeTop + MILE_DY + MILE_H + 16;
  const pinned = screen.height - RULE_BACK - screen.safeBottom;
  return Math.max(flow, pinned);
}

/* ---------- 状态 ---------- */
let archive = null;
let view = null;          // Checkin.plan() 的结果
let buttons = [];
let pulse = 0;            // 呼吸相位 —— 只用于"今天可领"那格与按钮的闪烁
let popup = null;         // 签到成功浮层 { coins, mileCoins, mileDays, timer }

/* ============================================================
 * 生命周期
 * ============================================================ */
module.exports = {
  name: 'Signin',

  onEnter() {
    reload();
    buildButtons();
    Analytics.track('signin_view', {
      signedToday: view.signedToday,
      streak: view.streak,
      total: view.total,
    });
  },

  /** 从别处返回时重新读存档 —— 金币可能在游戏里变了 */
  onResume() {
    reload();
    buildButtons();
  },

  doSign() {
    const today = Dates.todayStr();
    const result = Checkin.applySign(archive, today);

    if (!result.signed) {
      popup = { coins: 0, mileCoins: 0, mileDays: [], timer: 1.6, already: true };
      return;
    }

    Checkin.commit(archive, today, result);
    Storage.saveArchive(archive);

    WX.vibrateShort();
    popup = {
      coins: result.reward,
      mileCoins: result.milestoneCoins,
      mileDays: result.milestoneDays,
      timer: 2.4,
      already: false,
    };

    Analytics.track('daily_sign', {
      streak: result.streak,
      cycle: Checkin.cycleIndexOf(result.streak),
      reward: result.coins,
      total: result.total,
      milestones: result.milestoneDays.join(','),
    });

    // 云端补记:本地为准(个人主体、无付费,不存在刷奖励动机),
    // 失败不提示、不重试,只给后台留一条可查的记录。
    if (cfg.ENABLE_CLOUD) {
      require('../platform/cloud.js')
        .call('dailySign', { action: 'sign', date: today, streak: result.streak },
          { retry: 0, silent: true })
        .catch(() => { /* 忽略:本地已生效 */ });
    }

    reload();
    buildButtons();
  },

  /** 返回:优先出栈,栈底则回主页(与 rank-scene 同口径) */
  back() {
    const prev = SceneManager.pop();
    if (!prev) SceneManager.replace('Home');
  },

  onUpdate(dt) {
    pulse += dt;
    if (popup && popup.timer > 0) {
      popup.timer -= dt;
      if (popup.timer <= 0) popup = null;
    }
  },

  onRender() {
    const ctx = screen.ctx;
    ui.bg(ctx, screen.width, screen.height, { tint: ui.COLORS.gold });
    const cx = screen.width / 2;

    /* ---- 顶栏:区块标题 + 这一页在给什么 ----
     * 右侧那条说明是这一版加的:玩家进任何一页,都应该在 3 秒内知道"我能拿到什么"。 */
    ui.section(ctx, {
      x: 48, y: screen.safeTop + 58, w: screen.width - 96,
      text: '每日签到', size: 40, barH: 36, barColor: ui.COLORS.gold,
      note: '连签 ' + Checkin.CYCLE_DAYS + ' 天领大奖',
    });

    /* ---- 主卡:连签(主) + 累计(次) ---- */
    renderHero(ctx, screen.safeTop + HERO_Y);

    /* ---- 7 格周期日历 ---- */
    renderCalendar(ctx, screen.safeTop + CAL_DY);

    /* ---- 累计里程碑 ---- */
    renderMilestones(ctx, screen.safeTop + MILE_DY);

    /* ---- 规则卡 ---- */
    renderRules(ctx, ruleCardY());

    /* ---- 按钮 ---- */
    buttons.forEach((b) => b.render(ctx));

    /* ---- 签到成功浮层 ---- */
    if (popup) renderPopup(ctx, cx);
  },

  onTouchStart(p) { buttons.forEach((b) => b.onDown(p)); },
  onTouchEnd(p) { buttons.forEach((b) => b.onUp(p)); },

  onExit() { popup = null; },
};

/* ============================================================
 * 内部:数据
 * ============================================================ */
function reload() {
  archive = Storage.loadArchive();
  view = Checkin.plan(archive, Dates.todayStr());
}

function buildButtons() {
  const cx = screen.width / 2;
  const canSign = !view.signedToday;

  buttons = [
    ui.button({
      x: cx - 220, y: screen.height - 300 - screen.safeBottom, w: 440, h: 112,
      text: canSign ? ('签 到  +' + view.reward + ' 金币') : '今日已签到',
      fontSize: canSign ? 36 : 32,
      color: canSign ? ui.COLORS.brand : '#2b3542',
      pressColor: canSign ? ui.COLORS.brandDark : '#3a4655',
      disabled: !canSign,
      onClick: () => module.exports.doSign(),
    }),
    ui.button({
      x: cx - 220, y: screen.height - 168 - screen.safeBottom, w: 440, h: 92,
      text: '返 回', fontSize: 32, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => module.exports.back(),
    }),
  ];
}

/* ============================================================
 * 内部:绘制
 * ============================================================ */

/**
 * 主卡 —— 左边"连续签到"(主角),右边"累计签到"(配角),中间一条分隔线。
 *
 * 两个数字放在同一张卡里、却不是同等大小,是因为它们的关系本身就是主次:
 * **连续**是这一页希望你保住的东西,累计只是背景信息。
 * 把它们写成上下两行居中字时,这个关系是读不出来的。
 */
function renderHero(ctx, y) {
  const x = 48;
  const w = screen.width - 96;

  ui.card(ctx, {
    x: x, y: y, w: w, h: HERO_H, r: ui.RADIUS.xl,
    fill: ui.COLORS.panel, stroke: ui.COLORS.stroke, sheen: true,
  });

  const splitX = x + w - 186;

  // 左侧:图标 + 行标 + 大数字 + 单位
  const iconS = 58;
  const iconX = x + 40;
  ui.icon(ctx, 'flame', iconX, y + HERO_H / 2 - iconS / 2, iconS, {
    color: view.signedToday ? ui.COLORS.brand : ui.COLORS.gold,
    alpha: view.signedToday ? 0.9 : 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(pulse * 3)),
  });

  const tx = iconX + iconS + 30;
  ui.text(ctx, '连续签到', tx, y + 52, {
    size: ui.TYPE.eyebrow, color: ui.COLORS.textSub,
  });

  const num = String(Math.max(0, view.streak));
  const numSize = 96;
  const nr = ui.text(ctx, num, tx, y + 122, {
    size: numSize, color: ui.COLORS.brand, weight: 'bold',
  });
  // 单位比数字小两档 —— "12"是主角,"天"是注脚。这一条在整作里一致。
  ui.text(ctx, '天', tx + nr.width + 12, y + 146, {
    size: 30, color: ui.COLORS.textSub, weight: 'bold',
  });

  ui.text(ctx, view.signedToday ? '今天已签,明天继续' : '今天还没签,签一下接上', tx, y + 174, {
    size: ui.TYPE.micro, color: ui.COLORS.textDim,
  });

  // 右侧:累计签到(小一号,并且用竖线隔开)
  ctx.save();
  ctx.fillStyle = ui.COLORS.line;
  ctx.fillRect(splitX, y + 40, 1, HERO_H - 80);
  ctx.restore();

  const rx = splitX + (x + w - splitX) / 2;
  ui.text(ctx, '累计签到', rx, y + 70, {
    size: ui.TYPE.eyebrow, color: ui.COLORS.textSub, align: 'center',
  });
  const tr = ui.text(ctx, String(view.total), rx - 14, y + 122, {
    size: 62, color: ui.COLORS.text, align: 'center', weight: 'bold',
  });
  ui.text(ctx, '天', rx - 14 + tr.width / 2 + 16, y + 138, {
    size: 24, color: ui.COLORS.textSub, weight: 'bold',
  });
}

/** 7 格周期日历:上排 4 格,下排 3 格居中 */
function renderCalendar(ctx, top) {
  const totalW = CAL_COLS * CELL_W + (CAL_COLS - 1) * CELL_GAP;
  const startX = (screen.width - totalW) / 2;

  ui.section(ctx, {
    x: 48, y: top - SECTION_DROP, w: screen.width - 96,
    text: '本轮进度', size: 30, barH: 26, barColor: ui.COLORS.brand,
    note: view.cycleIndex + ' / ' + Checkin.CYCLE_DAYS + ' 天',
  });

  for (let i = 0; i < view.cells.length; i++) {
    const cell = view.cells[i];
    const row = Math.floor(i / CAL_COLS);
    const col = i % CAL_COLS;

    // 下排只有 3 格(第 5~7 天),整排居中,避免左边空一块
    let x = startX + col * (CELL_W + CELL_GAP);
    const countInRow = (row === 1) ? (view.cells.length - CAL_COLS) : CAL_COLS;
    if (row === 1) {
      const rowW = countInRow * CELL_W + (countInRow - 1) * CELL_GAP;
      x = (screen.width - rowW) / 2 + col * (CELL_W + CELL_GAP);
    }
    const y = top + row * (CELL_H + CELL_GAP);

    drawCell(ctx, x, y, cell);
  }
}

function drawCell(ctx, x, y, cell) {
  const claimable = cell.isToday && !view.signedToday;
  // 可领的那格呼吸一下 —— 静止的金色边框在一屏金框里不会被注意到
  const breathe = claimable ? (0.5 + 0.5 * Math.sin(pulse * 4)) : 0;

  ctx.save();

  // 底色:已签 → 品牌绿;可领 → 深金;未来 → 面板灰
  let bg = ui.COLORS.panel;
  if (cell.lit) bg = 'rgba(7,193,96,0.22)';
  else if (claimable) bg = 'rgba(255,176,32,' + (0.14 + 0.10 * breathe) + ')';

  ui.roundRect(ctx, x, y, CELL_W, CELL_H, 18);
  ctx.fillStyle = bg;
  ctx.fill();
  ui.sheen(ctx, x, y, CELL_W, CELL_H, 18);

  // 描边:可领 → 金色呼吸;第 7 格 → 常亮金边
  let stroke = null;
  let lw = 3;
  if (claimable) {
    stroke = 'rgba(255,176,32,' + (0.55 + 0.45 * breathe) + ')';
    lw = 4;
  } else if (cell.jackpot) {
    stroke = 'rgba(255,176,32,0.55)';
  } else if (cell.lit) {
    stroke = 'rgba(7,193,96,0.5)';
  }
  if (stroke) {
    ui.roundRect(ctx, x, y, CELL_W, CELL_H, 18);
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.restore();

  const cx = x + CELL_W / 2;

  // 第 7 格挂一个"大奖"角标 —— 这是整个页面唯一需要被一眼看见的字。
  // 用统一的 badge() 画,和排行榜的「我」、商城的档位标签是同一套角标语言。
  if (cell.jackpot) {
    ui.badge(ctx, {
      x: cx, y: y + 1, text: '大奖',
      color: ui.COLORS.gold, textColor: '#3a2a05',
      size: ui.TYPE.eyebrow, h: 34, padX: 14, r: 17,
    });
  }

  /* ---- 日期:从"第 4 天"改成"日期数字 + 天"两段 ----
   * 一行"第 4 天"里,真正有意义的是那个 4。把它放大、把"天"缩小,
   * 玩家扫一列就能顺着 1→7 数下去,不用逐字读。 */
  const dr = ui.text(ctx, String(cell.index), cx - 8, y + 48, {
    size: 30, color: ui.COLORS.textSub, align: 'center', weight: 'bold',
  });
  ui.text(ctx, '天', cx - 8 + dr.width / 2 + 10, y + 54, {
    size: 18, color: ui.COLORS.textDim,
  });

  if (cell.lit) {
    // 已签:打勾收进一个圆里 —— 比一个裸的勾更像"盖章完成"
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, y + 98, 21, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(7,193,96,0.95)';
    ctx.fill();
    ctx.restore();
    drawCheck(ctx, cx, y + 98, 24, '#ffffff');
    ui.text(ctx, '+' + cell.reward + ' 已到手', cx, y + 132, {
      size: ui.TYPE.micro, color: 'rgba(255,255,255,0.52)', align: 'center',
    });
  } else {
    const gold = cell.jackpot || claimable;
    ui.text(ctx, '+' + cell.reward, cx, y + 98, {
      size: 36, color: gold ? ui.COLORS.gold : ui.COLORS.text,
      align: 'center', weight: 'bold',
    });
    ui.text(ctx, cell.isToday ? '今天' : '待签到', cx, y + 132, {
      size: ui.TYPE.micro,
      color: cell.isToday ? ui.COLORS.gold : ui.COLORS.textDim,
      align: 'center',
    });
  }
}

function drawCheck(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(4, size * 0.20);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.45, cy);
  ctx.lineTo(cx - size * 0.08, cy + size * 0.36);
  ctx.lineTo(cx + size * 0.48, cy - size * 0.4);
  ctx.stroke();
  ctx.restore();
}

/** 累计签到里程碑:4 个台阶,已领取打勾,未达成显示还差几天 */
function renderMilestones(ctx, y) {
  const list = Checkin.MILESTONES;
  const totalW = list.length * MILE_W + (list.length - 1) * MILE_GAP;
  const startX = (screen.width - totalW) / 2;
  const claimed = archive.signMile || {};
  const total = view.total;

  ui.section(ctx, {
    x: 48, y: y - SECTION_DROP, w: screen.width - 96,
    text: '累计里程碑', size: 30, barH: 26, barColor: ui.COLORS.gold,
    note: '断签不影响累计',
  });

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const x = startX + i * (MILE_W + MILE_GAP);
    const done = !!claimed[m.days];
    const reached = total >= m.days;

    ctx.save();
    ui.roundRect(ctx, x, y, MILE_W, MILE_H, 14);
    ctx.fillStyle = done ? 'rgba(7,193,96,0.20)' : ui.COLORS.panel;
    ctx.fill();
    ui.sheen(ctx, x, y, MILE_W, MILE_H, 14);
    if (done) {
      ui.roundRect(ctx, x, y, MILE_W, MILE_H, 14);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(7,193,96,0.6)';
      ctx.stroke();
    }
    ctx.restore();

    const cx = x + MILE_W / 2;

    // 已达成的台阶盖一个勾章 —— 四个台阶并排时,"哪几个已经过了"是唯一的读法
    if (done) {
      drawCheck(ctx, cx - MILE_W / 2 + 26, y + MILE_H / 2, 22, 'rgba(7,193,96,0.95)');
    }

    ui.text(ctx, m.days + ' 天', cx + (done ? 12 : 0), y + 26, {
      size: 25, color: ui.COLORS.text, align: 'center', weight: 'bold',
    });
    ui.text(ctx, done ? '已领 +' + m.coins : (reached ? '待领取' : '还差 ' + (m.days - total) + ' 天'),
      cx + (done ? 12 : 0), y + 56, {
        size: ui.TYPE.micro,
        color: done ? ui.COLORS.brand : ui.COLORS.textSub,
        align: 'center',
      });
  }
}

/**
 * 规则卡 —— 两条规则各挂一个图标。
 *
 * 原来这两行是页面最下面两行 22px 灰字,与背景没有任何边界,
 * 读起来像免责声明。但它们其实是这一页**最重要的信息**:
 * "断签不清空累计"消除了玩家的心理负担,"第 7 天有额外奖励"给了明天的理由。
 * 值得一张卡片、一个标题、两个图标。
 */
function renderRules(ctx, y) {
  const x = 48;
  const w = screen.width - 96;
  const h = 148;

  ui.card(ctx, {
    x: x, y: y, w: w, h: h, r: ui.RADIUS.lg,
    fill: 'rgba(255,255,255,0.04)', stroke: ui.COLORS.stroke, sheen: false,
  });

  ui.section(ctx, {
    x: x + 32, y: y + 40, text: '规则', size: 26, barW: 5, barH: 24,
    barColor: ui.COLORS.textDim, color: ui.COLORS.textSub,
  });

  const rows = [
    ['flame', '断签不会清空累计天数,只会重置这一轮周期'],
    ['gift', '第 ' + Checkin.CYCLE_DAYS + ' 天签到额外奖励 ' + cfg.ECONOMY.SIGN_CYCLE_BONUS + ' 金币'],
  ];

  for (let i = 0; i < rows.length; i++) {
    const ry = y + 84 + i * 40;
    ui.icon(ctx, rows[i][0], x + 34, ry - 11, 22, {
      color: ui.COLORS.textDim, lineWidth: 1.8,
    });
    ui.text(ctx, rows[i][1], x + 68, ry, {
      size: ui.TYPE.caption, color: ui.COLORS.textSub,
    });
  }
}

/** 签到成功浮层:金币数 + 若触发里程碑再补一行 */
function renderPopup(ctx, cx) {
  const cy = screen.height * 0.42;
  /* ★ 卡片宽度 = 页面内容宽,不是随手写的一个数。
   *
   *   原来是 500。居中之后左右各留 125,而日历是 4 列 × 160 + 3 × 16 = 688 宽
   *   (x ∈ [31,719]),于是**最左格与最右格的字正好落在卡片左右边缘上**:
   *     · 最左格「+100 已到手」中心 111、宽约 97 → [62,160],被左边缘 123 切掉 37px
   *     · 最右格「+160」中心 639、宽约 80 → [599,679],被右边缘 627 切掉 28px
   *   玩家看到的就是"两套字重合在一起"。
   *
   *   改成 screen.width - 96 —— 与主页主卡、里程碑同一条内容边距 ——
   *   卡片两侧比最外两格的字还宽,日历文字被完整盖住,不再有边缘切字。
   *
   *   ⇒ 这里修的是**几何**。把遮罩调黑只是让问题"看不见",换个奖励数值
   *     (字更宽)照样会露出来 —— 调参治不了碰撞,让几何建立依赖才行。 */
  const w = screen.width - 96;
  const lines = popup.mileDays.length > 0 ? 3 : 2;
  const h = 150 + lines * 46;

  ctx.save();
  /* 遮罩保持很淡 —— 只为了把注意力压到中间,不需要把整页涂黑(签到的结果是好事)。
   *
   * ⚠️ 曾经怀疑根因是"背景字太亮所以抢注意力",把这里调到 0.62。
   *    截图对比后证明**没用**:背景只是略微变暗,而"卡片边缘切字"这件事一点没变。
   *    真正的根因是**卡片宽度**(见下)。修碰撞靠几何,不靠遮罩 ——
   *    调暗只是让问题看不见,换个奖励数值(字更宽)照样会露出来。 */
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.fillRect(0, 0, screen.width, screen.height);
  /* ★ 但是**卡片本身必须实心**。
   *   原来是 rgba(16,22,30,0.96) —— 那 4% 足够让日历里的「+180 待签到」
   *   以一层灰影透出来,和「签到成功 / +100 金币」叠在一起。
   *   遮罩负责"把注意力压到中间",卡片负责"这块地方只讲一件事",两件事别混。 */
  ui.card(ctx, {
    x: cx - w / 2, y: cy - h / 2, w: w, h: h, r: ui.RADIUS.lg,
    fill: 'rgb(16,22,30)', stroke: 'rgba(255,176,32,0.5)', sheen: false,
    glow: popup.already ? null : 'rgba(255,176,32,0.9)',
  });
  ctx.restore();

  let y = cy - h / 2 + 62;

  // 成功时挂一个金色礼盒 —— 一屏金黄的字里,一个图标先把"这是好事"说完了
  if (!popup.already) {
    ui.icon(ctx, 'gift', cx - 17, y - 40, 34, { color: ui.COLORS.gold });
  }

  ui.text(ctx, popup.already ? '今天已经签过啦' : '签到成功', cx, y, {
    size: 30, color: ui.COLORS.text, align: 'center', weight: 'bold',
  });

  if (!popup.already) {
    y += 56;
    // 金币 + 数量 + 单位,与全作其它"钱"的地方同一套排版
    const num = '+' + popup.coins;
    const nw = ui.measure(ctx, num, 46, 'bold');
    const uw = ui.measure(ctx, '金币', 22, 'bold');
    const total = nw + 8 + uw;
    ui.icon(ctx, 'coin', cx - total / 2 - 34, y - 15, 30, { color: ui.COLORS.gold, lineWidth: 2 });
    ui.text(ctx, num, cx - total / 2 + 4, y, {
      size: 46, color: ui.COLORS.gold, weight: 'bold',
    });
    ui.text(ctx, '金币', cx - total / 2 + 4 + nw + 8, y + 8, {
      size: 22, color: ui.COLORS.goldLight, weight: 'bold',
    });

    if (popup.mileDays.length > 0) {
      y += 48;
      ui.text(ctx, '累计 ' + popup.mileDays.join(' / ') + ' 天　额外 +' + popup.mileCoins + ' 金币',
        cx, y, {
          size: ui.TYPE.caption, color: ui.COLORS.brand, align: 'center',
        });
    }
  }
}
