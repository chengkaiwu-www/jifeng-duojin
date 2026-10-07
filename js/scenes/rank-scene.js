/**
 * scenes/rank-scene.js —— 排行榜
 *
 * 双轨榜:
 *   ① 全服榜 —— 来自云函数 getRank,零授权,首发即用
 *   ② 好友榜 —— 来自开放数据域(openDataContext),需要关系链授权
 *
 * ────────────────────────────────────────────────────────────────
 * ★ 本轮改版:这一页此前是全作**最像"一串裸文字"**的地方
 *
 * 改版前的实际画法是:两行裸表头(排名 / 玩家 / 最高分)+ 若干行裸文字,
 * 前三名只靠换个字色区分,"我的名次"是一句挂在屏幕底部的灰字。
 * 它之所以这么写,是因为"榜单不就是一列文字吗" —— 但恰恰相反:
 * **榜单是最需要版式的一页**,因为它的信息结构天生是**表格**,
 * 而表格的可读性 100% 来自对齐、分隔与身份识别,而不是来自数据本身。
 *
 * 四处改动,都对应一个具体的可读性问题:
 *   ① 裸行 → **卡片行**(圆角底 + 顶部内高光)。行与行之间有了边界,
 *      眼睛才不会滑到隔壁行去;这也是全作其它列表的统一语言。
 *   ② 名次 → **奖牌徽章**。第 1/2/3 名各有自己的金银铜实心圆,
 *      其余是等宽右对齐的数字。名次是这一页**唯一有序的东西**,
 *      它必须被一眼认出,而不是"颜色略微不同的一列数字"。
 *   ③ 昵称 → **字母头像 + 昵称 + 「我」角标**。榜单里全是名字,
 *      没有头像就只能逐个字读;由昵称哈希定色的圆牌让"那几个人"先被认出来,
 *      名字再被读到。零美术资源、零服务端字段。
 *   ④ 分数 → **数值(大)+ 单位(小)右对齐**。所有分数靠右对齐后才可比 ——
 *      左对齐的数字列,位数不同就没法一眼比大小。
 * 另外:加载中从"加载中…"换成**旋转的弧**;空榜从一句灰字换成
 * **图标 + 主文案 + 下一步该做什么**;我的名次从屏幕底部的飘字换成
 * **固定在列表下方的同一套卡片行** —— 它是"我"的位置,不该是页脚。
 *
 * 页签也从两个独立按钮改成**分段控件**(共用一个底槽 + 一块滑动的选中块):
 * 两个互斥状态、一个控件,是移动端最标准的做法。
 *
 * ⚠️ 未改动:开放数据域(子域)那一半。子域是独立 JS 环境,读不到主域任何变量,
 *    只能靠 postMessage 指挥、把 sharedCanvas 当图片贴出来。那部分的渲染代码
 *    不在主域,这一轮碰不到,也不该碰。
 * ────────────────────────────────────────────────────────────────
 *
 * 开放数据域的关键机制(务必理解,否则一定踩坑):
 *   - 子域是独立的 JS 运行环境,读不到主域的任何变量;
 *   - 通信只能靠 openDataContext.postMessage(子域用 wx.onMessage 接收);
 *   - 子域不能使用 DOM,只能往 sharedCanvas 上用 Canvas API 画;
 *   - 主域把这个 sharedCanvas 当成一张图片 drawImage 出来展示。
 */
const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');

const Cloud = require('../platform/cloud.js');
const Analytics = require('../platform/analytics.js');

let tab = 'global';          // 'global' | 'friends'
let loading = false;
let list = [];               // 全服榜 [{ rank, nickname, score, isMe }]
let myRank = null;
let emptyTip = '';
let emptyIcon = 'trophy';
let buttons = [];
let segPressed = -1;

/* ---------- 布局常量(设计坐标) ---------- */
const ROW_H = 92;
const ROW_GAP = 14;
const ROW_PAD = 40;          // 列表左右留白 → 行宽 = 屏宽 - 80
const BADGE_R = 22;          // 名次徽章半径
const AVA_R = 22;            // 头像半径
const SEG_H = 80;

/** 前三名的奖牌色;其余名次用普通数字。索引即名次,0 位空着 */
const MEDALS = [null, '#ffb020', '#c8d2dd', '#d8894a'];

// 开放数据域的 sharedCanvas 尺寸(设计坐标下的展示区域)
const OD_WIDTH = 750;
const OD_HEIGHT = 820;

function rowW() { return screen.width - ROW_PAD * 2; }
function listTop() { return screen.safeTop + 244; }
function listBottom() { return screen.height - 150 - screen.safeBottom; }

function segRect() {
  const w = screen.width - 96;
  return { x: 48, y: screen.safeTop + 108, w: w, h: SEG_H, half: w / 2 };
}

function openDataContext() {
  return typeof wx.getOpenDataContext === 'function' ? wx.getOpenDataContext() : null;
}

function buildButtons() {
  const cx = screen.width / 2;
  buttons = [
    ui.button({
      x: cx - 220, y: screen.height - 130 - screen.safeBottom, w: 440, h: 96,
      text: '返 回', fontSize: 34, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => module.exports.back(),
    }),
  ];
}

/** 拉取全服榜 */
async function loadGlobal() {
  loading = true;
  emptyTip = '';
  emptyIcon = 'trophy';
  list = [];
  try {
    const data = await Cloud.call('getRank', { type: 'global', limit: 50 }, { retry: 1, silent: true });
    list = (data && data.list) || [];
    myRank = data && data.myRank;
    if (!list.length) {
      emptyTip = '还没有人上榜';
      emptyIcon = 'trophy';
    }
  } catch (e) {
    emptyTip = '榜单加载失败';
    emptyIcon = 'alert';
  }
  loading = false;
}

/** 让开放数据域绘制好友榜(主域只发指令 + 展示结果) */
function showFriends() {
  const odc = openDataContext();
  if (!odc) {
    emptyTip = '当前版本不支持好友榜';
    emptyIcon = 'alert';
    return;
  }
  // 设定 sharedCanvas 的绘制尺寸
  const c = odc.canvas;
  c.width = OD_WIDTH;
  c.height = OD_HEIGHT;

  // 通知子域:开始绘制好友榜
  odc.postMessage({
    type: 'renderFriendRank',
    width: OD_WIDTH,
    height: OD_HEIGHT,
  });
  Analytics.track('rank_view', { tab: 'friends' });
}

function switchTab(next) {
  if (tab === next) return;
  tab = next;
  if (next === 'global') loadGlobal();
  else showFriends();
}

module.exports = {
  name: 'Rank',

  onEnter(params) {
    tab = (params && params.tab) || 'global';
    buildButtons();
    if (tab === 'global') loadGlobal();
    else showFriends();
    Analytics.track('rank_view', { tab });
  },

  onUpdate() { },

  onRender() {
    const ctx = screen.ctx;
    ui.bg(ctx, screen.width, screen.height, { tint: ui.COLORS.accent });
    const cx = screen.width / 2;

    /* ---- 顶栏:区块标题 + 说明 ----
     * 用了与其它页面同一套 section():左侧一根主题色短竖条。
     * 全作每一页的标题都长这样,"我在哪一页"就不需要读字了。 */
    ui.section(ctx, {
      x: 48, y: screen.safeTop + 58, w: screen.width - 96,
      text: '排行榜', size: 40, barH: 36, barColor: ui.COLORS.gold,
      note: '全服榜只统计「经典」模式',
    });

    renderSegment(ctx);
    buttons.forEach((b) => b.render(ctx));

    const top = listTop();
    const bottom = listBottom();

    if (tab === 'global') {
      if (loading) {
        // 在动的弧 + 一句"正在做什么" —— 静态的三个字分不清"在加载"和"卡住了"
        const my = (top + bottom) / 2;
        ui.spinner(ctx, cx, my - 18, 26, { color: ui.COLORS.brand });
        ui.text(ctx, '正在拉取全服榜单…', cx, my + 44, {
          size: ui.TYPE.body, color: ui.COLORS.textSub, align: 'center',
        });
      } else if (emptyTip) {
        ui.empty(ctx, {
          cx: cx, cy: (top + bottom) / 2 - 20,
          icon: emptyIcon, iconSize: 96,
          title: emptyTip,
          sub: emptyIcon === 'alert'
            ? '检查一下网络,稍后再试'
            : '去玩一局,第一个名字就是你的',
        });
      } else {
        renderRows(ctx, top, bottom);
      }
    } else {
      /* ---- 好友榜:直接展示开放数据域画好的 sharedCanvas ---- */
      const odc = openDataContext();
      if (!odc) {
        ui.empty(ctx, {
          cx: cx, cy: (top + bottom) / 2 - 20,
          icon: 'alert', iconSize: 96,
          title: emptyTip || '当前版本不支持好友榜',
          sub: '好友榜需要微信关系链授权',
        });
      } else {
        ctx.drawImage(odc.canvas, 0, top, screen.width, OD_HEIGHT);
      }
    }
  },

  onTouchStart(p) {
    buttons.forEach((b) => b.onDown(p));
    const s = segRect();
    if (p.y >= s.y && p.y <= s.y + s.h) {
      if (p.x >= s.x && p.x <= s.x + s.half) segPressed = 0;
      else if (p.x > s.x + s.half && p.x <= s.x + s.w) segPressed = 1;
      else segPressed = -1;
    } else {
      segPressed = -1;
    }
  },

  onTouchEnd(p) {
    buttons.forEach((b) => b.onUp(p));

    // 与主页的模式 chip 同口径:按下与抬起都落在同一格才算切换,
    // 避免"在页签上滑出去"被误判成一次切换
    const s = segRect();
    let hit = -1;
    if (p.y >= s.y && p.y <= s.y + s.h) {
      if (p.x >= s.x && p.x <= s.x + s.half) hit = 0;
      else if (p.x > s.x + s.half && p.x <= s.x + s.w) hit = 1;
    }
    if (hit >= 0 && hit === segPressed) switchTab(hit === 0 ? 'global' : 'friends');
    segPressed = -1;
  },

  /** 返回:优先出栈,栈底则回主页 */
  back() {
    const prev = SceneManager.pop();
    if (!prev) SceneManager.replace('Home');
  },

  onExit() {
    segPressed = -1;
    // 离开时通知子域停止绘制,避免无谓的渲染开销
    const odc = openDataContext();
    if (odc) odc.postMessage({ type: 'hide' });
  },
};

/* ============================================================
 * 内部:绘制
 * ============================================================ */

/** 分段控件 —— 两个互斥页签共用一个底槽,选中块滑到各自那一半 */
function renderSegment(ctx) {
  const s = segRect();
  const labels = ['全服榜', '好友榜'];
  const on = tab === 'global' ? 0 : 1;

  ui.card(ctx, {
    x: s.x, y: s.y, w: s.w, h: s.h, r: s.h / 2,
    fill: 'rgba(255,255,255,0.06)', stroke: ui.COLORS.stroke, sheen: false,
  });

  // 选中块:只画它自己的那块圆角底,不需要任何动画 ——
  // 两个状态之间的切换本身已经足够清楚,加动效只是把它变慢
  const pad = 6;
  const bw = s.half - pad * 2;
  ui.card(ctx, {
    x: s.x + pad + on * s.half, y: s.y + pad, w: bw, h: s.h - pad * 2, r: (s.h - pad * 2) / 2,
    fill: ui.COLORS.brand, stroke: null, sheen: true,
  });

  for (let i = 0; i < 2; i++) {
    ui.text(ctx, labels[i], s.x + s.half * i + s.half / 2, s.y + s.h / 2, {
      size: 28, align: 'center', weight: 'bold',
      color: i === on ? '#ffffff' : ui.COLORS.textSub,
    });
  }
}

/** 榜单列表:一列卡片行 + 顶部/底部的说明行 */
function renderRows(ctx, top, bottom) {
  const x = ROW_PAD;
  const w = rowW();
  const step = ROW_H + ROW_GAP;

  // 顶部说明:这一屏到底在比什么
  ui.text(ctx, '共 ' + list.length + ' 人上榜', 48, top - 26, {
    size: ui.TYPE.eyebrow, color: ui.COLORS.textDim,
  });
  ui.text(ctx, '最高分', screen.width - 48, top - 26, {
    size: ui.TYPE.eyebrow, color: ui.COLORS.textDim, align: 'right',
  });

  const maxRows = Math.max(1, Math.floor((bottom - top) / step));
  const rows = list.slice(0, maxRows);

  for (let i = 0; i < rows.length; i++) {
    drawRow(ctx, x, top + i * step, w, rows[i]);
  }

  /* ---- 我的名次:不在上面这批里时,单独钉在列表下方 ----
   * 它和上面的行**长得一模一样**,只是底色偏绿 —— 因为它是同一个表里的同一行数据,
   * 只是换了位置。做成"页脚式的一句话"会让它读起来像免责声明。 */
  if (myRank && myRank.rank > rows.length) {
    const y = Math.min(bottom - ROW_H, top + rows.length * step + 6);
    drawRow(ctx, x, y, w, {
      rank: myRank.rank, nickname: '我', score: myRank.score, isMe: true,
    }, '我的名次');
  }
}

/** 画一行榜单 */
function drawRow(ctx, x, y, w, item, tag) {
  const isMe = !!item.isMe;
  const cy = y + ROW_H / 2;

  // 行底:自己那一行用品牌绿淡染 + 绿描边,其余是标准卡片
  ui.card(ctx, {
    x: x, y: y, w: w, h: ROW_H, r: ui.RADIUS.md,
    fill: isMe ? 'rgba(7,193,96,0.13)' : 'rgba(255,255,255,0.05)',
    stroke: isMe ? ui.COLORS.brand : ui.COLORS.stroke,
    strokeWidth: isMe ? 2 : 1,
    sheen: !isMe,
  });

  /* ---- ① 名次徽章 ----
   * 前三名:实心奖牌圆 + 深色数字;其余:等宽右对齐的普通数字。
   * 名次是这一页唯一有序的东西,必须一眼可辨,而不是"颜色略深的一列数字"。 */
  const medalX = x + 22 + BADGE_R;
  const medal = MEDALS[item.rank] || null;
  if (medal) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(medalX, cy, BADGE_R, 0, Math.PI * 2);
    ctx.fillStyle = medal;
    ctx.fill();
    ctx.restore();
    ui.text(ctx, String(item.rank), medalX, cy + 1, {
      size: 26, color: '#1d1503', align: 'center', baseline: 'middle', weight: 'bold',
    });
  } else {
    ui.text(ctx, String(item.rank), medalX, cy + 1, {
      size: 28, color: ui.COLORS.textSub, align: 'center', baseline: 'middle', weight: 'bold',
    });
  }

  /* ---- ② 字母头像 ----
   * 昵称哈希 → 色相。同一个名字永远是同一个颜色,换一局也不会变,
   * 于是榜单里"那几个人"先被认出来,名字再被读到。 */
  const avaX = x + 22 + BADGE_R * 2 + 26 + AVA_R;
  ui.monogram(ctx, item.nickname, avaX, cy, AVA_R * 2);

  /* ---- ③ 昵称 ----
   * 固定不动的右边界:头像右侧 → 分数区左侧。名字再长也不会挤到分数上。 */
  const nameX = avaX + AVA_R + 20;
  const scoreW = 132;
  const nameMax = x + w - scoreW - 24 - nameX;
  const drawn = ui.fitText(ctx, item.nickname || '玩家', nameX, cy + 1, nameMax, {
    size: 28, color: ui.COLORS.text, weight: isMe ? 'bold' : '', minSize: 18,
  });

  if (tag || isMe) {
    // 角标跟在名字后面 —— 而不是替换掉名字。玩家需要同时知道"这是谁"和"这是我"。
    // 位置被夹在分数区左侧,名字再长也不会把角标顶到分数上。
    const bx = Math.min(nameX + drawn.width + 24, x + w - scoreW - 26);
    ui.badge(ctx, {
      x: bx, y: cy, text: tag || '我',
      color: isMe ? ui.COLORS.brand : ui.COLORS.gold,
      textColor: isMe ? '#04240f' : '#2a1c02',
      size: ui.TYPE.micro, h: 30, padX: 12,
    });
  }

  /* ---- ④ 分数:数值(大) + 单位(小) 一起右对齐 ----
   * 左对齐的数字列比不出大小,右对齐才能。单位比数字小一号,
   * 于是"1280"是主角、"分"是注脚 —— 这与主页分数、结算分数的处理是同一套。 */
  const right = x + w - 26;
  const unitW = ui.measure(ctx, '分', 19, '');
  ui.text(ctx, String(item.score), right - unitW - 5, cy + 1, {
    size: 34, color: ui.COLORS.text, align: 'right', baseline: 'middle', weight: 'bold',
  });
  ui.text(ctx, '分', right, cy + 8, {
    size: 19, color: ui.COLORS.textSub, align: 'right', baseline: 'middle',
  });
}
