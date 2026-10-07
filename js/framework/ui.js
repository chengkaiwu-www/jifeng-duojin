/**
 * framework/ui.js —— 轻量 UI 绘制与命中检测
 *
 * 小游戏里没有组件库,按钮/文本/进度条都得自己画。
 * 本模块提供最常用的一小组原语,并且把"绘制"与"点击命中"绑定在一起,
 * 避免每个场景都手写一遍 x/y/width/height 判断。
 *
 * 坐标全部为设计坐标(基于 750 宽),由 screen.js 统一换算。
 */
const screen = require('./screen.js');

/** 圆角矩形路径(小游戏环境支持 arcTo) */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 文本绘制。
 * 性能提示:fillText 在小游戏里开销较高,频繁变动的文字(如倒计时)尽量
 * 复用同一个 font 设置,避免每帧改 font 触发重新测量。
 */
function text(ctx, str, x, y, opt) {
  const o = opt || {};
  ctx.save();
  ctx.font = (o.weight || '') + ' ' + (o.size || 32) + 'px ' +
    (o.family || '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif');
  ctx.fillStyle = o.color || '#ffffff';
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'middle';
  if (o.stroke) {
    ctx.lineWidth = o.strokeWidth || 4;
    ctx.strokeStyle = o.stroke;
    ctx.strokeText(str, x, y);
  }
  ctx.fillText(str, x, y);

  /* ★ 必须在 restore **之前**量宽度。
   *
   * canvas 的 font 是**全局态**,restore 之后它已经变回调用前的字体了 ——
   * 拿那个字体去 measureText,量出来的宽度与刚刚画出来的那行字不是一个字号。
   * 全作所有"文字 A 的右边接文字 B"的布局都吃这个返回值
   * (最典型的就是"数值 + 单位"、"图标 + 文字"一起居中),
   * 宽度错了,单位就会压到数值上 —— 这正是玩家看到的"文字重叠"。
   *
   * 这类 bug 在开发机上不一定显形:它取决于**上一个 ui.text 用了多大的字**,
   * 而字号是随状态变的。今天看着好,明天换个数据就歪了。 */
  const measured = ctx.measureText(str).width;
  ctx.restore();
  return { width: measured };
}

/** 画一张图片,支持按设计宽度等比缩放 */
function image(ctx, img, x, y, w, h) {
  if (!img) return;
  const iw = img.width || w;
  const ih = img.height || h;
  const dw = w || iw;
  const dh = h || (w ? (ih / iw) * w : ih);
  ctx.drawImage(img, x, y, dw, dh);
  return { w: dw, h: dh };
}

/**
 * 按钮:绘制 + 命中检测一体。
 * hit() 在 onTouchEnd 里调用,传入设计坐标。
 * 返回对象同时携带渲染与命中能力,避免坐标写两遍。
 */
function button(opt) {
  const o = Object.assign({
    x: 0, y: 0, w: 400, h: 100,
    text: '',
    fontSize: 36,
    color: '#07c160',
    textColor: '#ffffff',
    radius: 16,
    pressColor: null,     // 按下态颜色
    disabled: false,
    sheen: true,          // 顶部内高光(与 card 共用同一套立体语言)
    stroke: null,         // 描边色;null = 不描边
    pressScale: 1,        // 按下时整体缩到多少(1 = 不缩放)
    onClick: null,
  }, opt);

  let pressed = false;

  const api = {
    opt: o,

    render(ctx) {
      // 禁用态用"压暗"而不是"提亮":深色底上,越亮越像可点
      const fill = o.disabled
        ? '#46505d'
        : (pressed && o.pressColor ? o.pressColor : o.color);

      ctx.save();
      if (pressed && o.pressScale !== 1) {
        // 以中心为原点缩放。视觉上"按下去"了,但命中框不动 ——
        // 手指略微滑出边缘仍算点中,对用户更宽容。
        const cx = o.x + o.w / 2;
        const cy = o.y + o.h / 2;
        ctx.translate(cx, cy);
        ctx.scale(o.pressScale, o.pressScale);
        ctx.translate(-cx, -cy);
      }

      roundRect(ctx, o.x, o.y, o.w, o.h, o.radius);
      ctx.fillStyle = fill;
      ctx.fill();

      if (o.sheen && !o.disabled) {
        const pad = Math.max(8, o.radius * 0.9);
        roundRect(ctx, o.x + pad, o.y + 1.5, Math.max(2, o.w - pad * 2), 2, 1);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
      }

      if (o.stroke) {
        roundRect(ctx, o.x, o.y, o.w, o.h, o.radius);
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();

      text(ctx, o.text, o.x + o.w / 2, o.y + o.h / 2, {
        size: o.fontSize,
        color: o.textColor,
        align: 'center',
        baseline: 'middle',
        weight: 'bold',
      });
      return api;
    },

    hit(p) {
      return !o.disabled &&
        p.x >= o.x && p.x <= o.x + o.w &&
        p.y >= o.y && p.y <= o.y + o.h;
    },

    onDown(p) { if (api.hit(p)) pressed = true; },
    onUp(p) {
      const wasPressed = pressed;
      pressed = false;
      if (wasPressed && api.hit(p) && o.onClick) o.onClick();
      return wasPressed && api.hit(p);
    },

    setDisabled(v) { o.disabled = !!v; return api; },
  };
  return api;
}

/**
 * 参数化形状路径 —— 本作"造型系统"的绘制基础。
 *
 * 因为没有美术资源,玩家造型的外观差异全部靠
 *   (轮廓形状 + 配色 + 拖尾形态 + 发光/光环 + 自转) 表达。
 * 这里只负责"把形状变成一条路径",由调用方决定填充色和描边 ——
 * 这样同一个形状既能画玩家,也能画图鉴里的小预览,不用写两套。
 *
 * 约定:传入的是**包围盒**(左上角 + 宽高),不是中心点,和 roundRect 保持一致,
 *       避免调用方在两种坐标系之间来回换算。
 *
 * ⚠️ 与 skins.js 的 SHAPES 是**两份独立的列表**,故意不互相 import
 *   (渲染层不该依赖数据层,数据层也不该为了校验去 import 画布代码)。
 *   两份列表的一致性由 test-progression.js / check-preview.js 断言锁住。
 */
const SUPPORTED_SHAPES = [
  'round',    // 圆角矩形(默认)
  'circle',   // 圆
  'diamond',  // 菱形
  'hex',      // 六边形
  'pentagon', // 五边形
  'octagon',  // 八边形
  'triangle', // 三角形
  'star5',    // 五角星
  'star4',    // 四角星(闪光)
  'cross',    // 十字
  'shield',   // 盾牌
  'drop',     // 水滴
  'gear',     // 齿轮
  'ring',     // 圆环(中空)
  'blob',     // 波形圆(有机形)
  'heart',    // 心形
];

/** 正多边形顶点路径 —— 六边形/五边形/八边形/三角形共用,不写四遍 */
function polygonPath(ctx, cx, cy, rx, ry, sides, startDeg) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = (startDeg + i * 360 / sides) * Math.PI / 180;
    const px = cx + rx * Math.cos(a);
    const py = cy + ry * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 星形:外顶点与内顶点交替(innerRatio = 内半径 / 外半径) —— 五角星/四角星/齿轮共用 */
function starPath(ctx, cx, cy, rx, ry, points, innerRatio, startDeg) {
  const step = 360 / (points * 2);
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const k = (i % 2 === 0) ? 1 : innerRatio;
    const a = (startDeg + i * step) * Math.PI / 180;
    const px = cx + rx * k * Math.cos(a);
    const py = cy + ry * k * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function shapePath(ctx, shape, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  switch (shape) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(rx, ry), 0, Math.PI * 2);
      ctx.closePath();
      return;

    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry);
      ctx.lineTo(cx + rx, cy);
      ctx.lineTo(cx, cy + ry);
      ctx.lineTo(cx - rx, cy);
      ctx.closePath();
      return;

    // 以下四个都是正多边形,只是边数与起始角不同
    case 'hex':      polygonPath(ctx, cx, cy, rx, ry, 6, -90); return;
    case 'pentagon': polygonPath(ctx, cx, cy, rx, ry, 5, -90); return;
    case 'triangle': polygonPath(ctx, cx, cy, rx, ry, 3, -90); return;
    case 'octagon':  polygonPath(ctx, cx, cy, rx, ry, 8, -112.5); return;  // 平顶

    case 'star5': starPath(ctx, cx, cy, rx, ry, 5, 0.42, -90); return;
    case 'star4': starPath(ctx, cx, cy, rx, ry, 4, 0.34, -90); return;
    case 'gear':  starPath(ctx, cx, cy, rx, ry, 8, 0.76, -90); return;     // 内比大 → 齿短而钝

    case 'cross': {
      // 12 个点手写一遍,比"两个矩形用 nonzero 规则求并"更稳(小游戏 canvas 填充规则不能指望)
      const a = rx * 0.30;
      ctx.beginPath();
      ctx.moveTo(cx - a, cy - ry); ctx.lineTo(cx + a, cy - ry);
      ctx.lineTo(cx + a, cy - a);  ctx.lineTo(cx + rx, cy - a);
      ctx.lineTo(cx + rx, cy + a); ctx.lineTo(cx + a, cy + a);
      ctx.lineTo(cx + a, cy + ry); ctx.lineTo(cx - a, cy + ry);
      ctx.lineTo(cx - a, cy + a);  ctx.lineTo(cx - rx, cy + a);
      ctx.lineTo(cx - rx, cy - a); ctx.lineTo(cx - a, cy - a);
      ctx.closePath();
      return;
    }

    case 'shield':
      ctx.beginPath();
      ctx.moveTo(cx - rx, cy - ry);
      ctx.lineTo(cx + rx, cy - ry);
      ctx.lineTo(cx + rx, cy + ry * 0.05);
      ctx.quadraticCurveTo(cx + rx, cy + ry, cx, cy + ry);
      ctx.quadraticCurveTo(cx - rx, cy + ry, cx - rx, cy + ry * 0.05);
      ctx.closePath();
      return;

    case 'drop':
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry);
      ctx.bezierCurveTo(cx + rx * 0.98, cy - ry * 0.25, cx + rx, cy + ry * 0.55, cx, cy + ry);
      ctx.bezierCurveTo(cx - rx, cy + ry * 0.55, cx - rx * 0.98, cy - ry * 0.25, cx, cy - ry);
      ctx.closePath();
      return;

    case 'ring': {
      // 外圆正向 + 内圆反向 → nonzero 填充规则下自动挖空
      const ro = Math.min(rx, ry);
      const ri = ro * 0.46;
      ctx.beginPath();
      ctx.arc(cx, cy, ro, 0, Math.PI * 2, false);
      ctx.arc(cx, cy, ri, 0, Math.PI * 2, true);
      ctx.closePath();
      return;
    }

    case 'blob': {
      // 半径带正弦扰动 → 一个不会和任何规则形状撞脸的有机轮廓
      const N = 28;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const a = i / N * Math.PI * 2;
        const k = 1 + 0.13 * Math.sin(a * 3) + 0.06 * Math.cos(a * 5);
        const px = cx + rx * k * Math.cos(a);
        const py = cy + ry * k * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    }

    case 'heart':
      // 心尖在下(y 为正),两个圆弧在上
      ctx.beginPath();
      ctx.moveTo(cx, cy + ry * 0.92);
      ctx.bezierCurveTo(cx - rx * 1.45, cy - ry * 0.10,
        cx - rx * 0.62, cy - ry * 1.35, cx, cy - ry * 0.34);
      ctx.bezierCurveTo(cx + rx * 0.62, cy - ry * 1.35,
        cx + rx * 1.45, cy - ry * 0.10, cx, cy + ry * 0.92);
      ctx.closePath();
      return;

    // 默认 round(圆角矩形),也是工程里用得最多的形状
    default:
      roundRect(ctx, x, y, w, h, r === undefined ? Math.min(w, h) * 0.22 : r);
  }
}

/**
 * 画一个"造型预览"—— 玩家方块 / 图鉴缩略图 / 拖尾残影共用。
 *
 * opt: { shape, body, accent, glow, dim, alpha, spin, halo, haloColor,
 *        edge, orbit }
 *   spin   单位是**度/秒**,传了就按真实时间自转 —— 调用方不用自己维护相位。
 *   edge   'dashed' = 形状外一圈**断续描边**(稀有档的结构性标记)
 *   halo   外圈**呼吸光环**(亮度随时间脉动,不是死的一圈)
 *   orbit  >0 = 外圈有 N 个**环绕星点**在公转(传说档)
 *   自转 / 光环 / 星点都**只影响观感,不进任何判定**(碰撞用的是 rules.js 里的包围盒)。
 *
 * ⚠️ 本函数**不认识"稀有度"** —— 那三个标记是由 gameplay/skins.js 的
 *    visualOf() 按稀有度算好、再作为普通参数传进来的。分层纪律:
 *    framework 不该知道什么是"史诗"。
 *
 * ⚠️ **发光一律用多层半透明描边近似,不使用 `shadowBlur`。**
 *    这条纪律全作一致(effects.js / card() 都守着),而且这里更要守:
 *    它挂在**玩家每一帧**和**商店 24 张卡**上,正是低端机最贵的地方。
 */
function sprite(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, size: 96,
    shape: 'round', body: '#07c160', accent: '#7ef0a8',
    glow: false, dim: false, alpha: 1,
    spin: 0, halo: false, haloColor: null,
    edge: null, orbit: 0,
  }, opt);

  const cx = o.x + o.size / 2;
  const cy = o.y + o.size / 2;
  const baseAlpha = o.alpha * (o.dim ? 0.35 : 1);
  const now = Date.now();

  ctx.save();
  ctx.globalAlpha = baseAlpha;

  /* ---- 外发光:四层同心描边,越外越淡越粗 ----
   * 与 card() 的 glow 同一手法 —— 用几笔描边近似一片模糊,
   * 代价是常数级的路径绘制,而不是逐像素卷积。 */
  if (o.glow) {
    const layers = 4;
    for (let i = 0; i < layers; i++) {
      const t = (i + 1) / layers;
      ctx.globalAlpha = baseAlpha * 0.12 * (1 - t * 0.55);
      ctx.lineWidth = 2 + t * 14;
      ctx.strokeStyle = o.accent;
      shapePath(ctx, o.shape, o.x, o.y, o.size, o.size, o.size * 0.22);
      ctx.stroke();
    }
    ctx.globalAlpha = baseAlpha;
  }

  /* ---- 断续描边(稀有档):把形状整体放大一圈,在外面画短划线 ---- */
  if (o.edge === 'dashed' && !o.dim) {
    const pad = o.size * 0.16;
    const big = o.size + pad * 2;
    ctx.globalAlpha = baseAlpha * 0.72;
    ctx.strokeStyle = o.accent;
    ctx.lineWidth = Math.max(2, o.size * 0.028);
    if (ctx.setLineDash) ctx.setLineDash([o.size * 0.075, o.size * 0.06]);
    shapePath(ctx, o.shape, o.x - pad, o.y - pad, big, big, big * 0.22);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.globalAlpha = baseAlpha;
  }

  if (o.spin) {
    const ang = (now / 1000) * o.spin * Math.PI / 180;
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.translate(-cx, -cy);
  }

  shapePath(ctx, o.shape, o.x, o.y, o.size, o.size, o.size * 0.22);
  ctx.fillStyle = o.body;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 高光:一小条圆角矩形,零成本地表达"这是个立体的东西"。
  // 圆环/十字/齿轮这类中空或异形的轮廓不适合压高光,会盖住形状本身。
  const highlightable = !o.dim && ['round', 'circle', 'diamond', 'hex', 'pentagon', 'octagon'].indexOf(o.shape) !== -1;
  if (highlightable) {
    const pad = o.size * 0.16;
    ctx.globalAlpha = baseAlpha * 0.28;
    roundRect(ctx, o.x + pad, o.y + pad * 0.85, o.size - pad * 2, o.size * 0.15, o.size * 0.08);
    ctx.fillStyle = o.accent;
    ctx.fill();
  }

  /* ---- 呼吸光环:画在形状之外,不遮挡本体。
   * 用 sin 让亮度来回走 —— "会呼吸"本身就比一圈死线更像"这东西是活的"。 */
  if (o.halo && !o.dim) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 620);
    ctx.globalAlpha = baseAlpha * (0.20 + 0.32 * pulse);
    ctx.strokeStyle = o.haloColor || o.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, o.size * 0.68, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = baseAlpha;
  }

  /* ---- 环绕星点:传说档的"加冕"。挂在与光环同一个半径上,看起来像环上镶的珠子。
   * 角度直接由时间算 —— 不存相位,也就不可能在别处被改坏。 ---- */
  if (o.orbit > 0 && !o.dim) {
    const ang0 = (now / 1000) * 1.2;
    const r = o.size * 0.68;
    const dotR = Math.max(1.5, o.size * 0.055);
    ctx.fillStyle = o.accent;
    for (let i = 0; i < o.orbit; i++) {
      const a = ang0 + (i * Math.PI * 2) / o.orbit;
      ctx.globalAlpha = baseAlpha * 0.92;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = baseAlpha;
  }

  ctx.restore();
}

/**
 * 画一小段**静态拖尾示意** —— 商店卡片与详情弹层用它。
 *
 * 为什么需要它:拖尾是**游戏里最显眼的差异**(game-scene.renderTrail 每帧画 8 个采样点),
 * 但商店里一直没有画过 —— 于是"你花的钱最直观能买到的东西"恰恰是唯一看不见的。
 *
 * ⚠️ 它不是 renderTrail 的替代品:那一个读的是逐帧累积的 `trailPoints`(真实运动历史),
 *    而这里只是在**没有运动历史**的静态场景里把 4 种形态画个示意。
 *    两者必须保持形态一致(ghost 残影 / ember 余烬 / star 星点 / ribbon 绸带),
 *    所以放在同一层 —— 以后改拖尾外观,只要看这两个地方。
 *
 * opt: { x, y, size, shape, body, accent, trail, alpha, span }
 *   (x, y) 是**造型自身**的左上角;拖尾画在它的左侧。
 *   span 是相邻采样点的横向间距,默认 size × 0.72 ——
 *   商店卡片那种窄格子里要传小一点,否则拖尾会伸到隔壁卡片上。
 */
function spriteTrail(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, size: 96,
    shape: 'round', body: '#07c160', accent: '#7ef0a8',
    trail: 'none', alpha: 1, span: null,
  }, opt);
  if (o.trail === 'none') return;

  const cx = o.x + o.size / 2;
  const cy = o.y + o.size / 2;
  const span = o.span === null || o.span === undefined ? o.size * 0.72 : o.span;   // 采样点横向间距
  const n = 4;

  ctx.save();
  ctx.globalAlpha = o.alpha;

  if (o.trail === 'ghost') {
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const s = o.size * (0.82 - k * 0.22);
      sprite(ctx, {
        x: cx - span * k - s / 2, y: cy - s / 2, size: s,
        shape: o.shape, body: o.body, accent: o.accent,
        alpha: o.alpha * (0.34 - k * 0.075),
      });
    }
  } else if (o.trail === 'ember') {
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      ctx.globalAlpha = o.alpha * (0.62 - k * 0.12);
      ctx.fillStyle = (i % 2) ? o.accent : o.body;
      ctx.beginPath();
      ctx.arc(cx - span * k, cy + o.size * 0.24 + k * o.size * 0.18,
        o.size * (0.055 + (1 - k) * 0.03), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (o.trail === 'star') {
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const s = o.size * 0.19 * (1 - k * 0.45);
      sprite(ctx, {
        x: cx - span * k - s / 2, y: cy - s / 2, size: s,
        shape: 'star4', body: o.accent, accent: '#ffffff',
        alpha: o.alpha * (0.8 - k * 0.15),
      });
    }
  } else if (o.trail === 'ribbon') {
    ctx.lineCap = 'round';
    ctx.strokeStyle = o.accent;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      ctx.globalAlpha = o.alpha * (0.5 - k * 0.08);
      ctx.lineWidth = o.size * (0.15 - k * 0.026);
      ctx.beginPath();
      ctx.moveTo(cx - span * (k - 1 / n), cy);
      ctx.lineTo(cx - span * k, cy);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * 进度条(用于加载页与限时模式的剩余时间条)。
 * 除了槽与填充,额外画一道顶部内高光与前端亮点 ——
 * 这两笔让它从"两个色块"变成"一根有厚度的条",成本却接近于零。
 */
function progress(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, w: 400, h: 16,
    value: 0,               // 0 ~ 1
    bgColor: null,          // null = 用规范里的凹陷面色
    color: '#07c160',
    radius: 8,
    sheen: true,
  }, opt);

  const r = o.radius;
  ctx.save();

  roundRect(ctx, o.x, o.y, o.w, o.h, r);
  ctx.fillStyle = o.bgColor || COLORS.surfaceSunken;
  ctx.fill();
  roundRect(ctx, o.x, o.y, o.w, o.h, r);
  ctx.strokeStyle = COLORS.stroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  const vw = Math.max(0, Math.min(1, o.value)) * o.w;
  if (vw > 0) {
    const w = Math.max(vw, r * 2);
    roundRect(ctx, o.x, o.y, w, o.h, r);
    ctx.fillStyle = o.color;
    ctx.fill();

    if (o.sheen && o.h >= 10) {
      const pad = r * 0.8;
      roundRect(ctx, o.x + pad, o.y + 1.5, Math.max(2, w - pad * 2), 2, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ============================================================
 * 设计规范(token)
 *
 * 之前每个场景各写各的圆角、间距、字号,结果是"每张卡片都差一点点"——
 * 单看都还行,拼在一起就散。这里把三件事收成一组**有限的档位**:
 *   SPACE 间距(4 的倍数) · RADIUS 圆角 · TYPE 字号
 * 约定:场景里不再出现 17、23、46 这类一次性数值,一律从档位里取。
 * 档位有限,就不会有"差一点点"。
 * ============================================================ */

/** 间距阶 —— 4 的倍数,且相邻档位差异足够大,才能形成视觉节奏 */
const SPACE = { xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 };

/** 圆角阶 —— 组件越大圆角越大,视觉上才"撑得住" */
const RADIUS = { sm: 12, md: 18, lg: 26, xl: 34 };

/** 字阶 —— 八个档位覆盖全部文本,不再随手写字号 */
const TYPE = {
  hero: 92,     // 结算大分数
  title: 46,    // 页面标题
  heading: 34,  // 卡片标题 / 按钮
  body: 28,     // 正文
  label: 24,    // 次要标签
  caption: 21,  // 脚注 / 提示
  eyebrow: 20,  // 区块行标(小 + 字距,压在标题上方)
  micro: 17,    // 角标 / 极次要信息
};

/** 缓动函数 —— 入场与按压都靠它,避免各处手写 Math.pow 且写法不一致 */
const Ease = {
  outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
  outBack: function (t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  inOutCubic: function (t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
};

/**
 * 常用色板,统一视觉语言。
 *
 * ⚠️ 上排是**既有键,值一律未改** —— 预览页与一致性检查都直接依赖这组字面量。
 *    新增的层次色全部作为新键追加在下排,不动老键。
 */
const COLORS = {
  /* ---- 既有 ---- */
  bg: '#141a22',
  panel: '#1f2733',
  mask: 'rgba(0,0,0,0.6)',
  brand: '#07c160',       // 微信绿
  brandDark: '#059847',
  accent: '#2f6bff',
  gold: '#ffb020',
  danger: '#e5484d',
  text: '#ffffff',
  textSub: 'rgba(255,255,255,0.62)',
  line: 'rgba(255,255,255,0.12)',

  /* ---- 层次与精细度(本轮新增) ----
   * 深色界面最怕"一片死黑":所有面都是同一个黑,卡片就浮不起来。
   * 这里补上背景渐变两端 + 三层表面 + 两级描边,
   * 让"背景 / 卡片 / 悬浮态"在明度上有明确的先后关系。 */
  bgTop: '#18202b',        // 背景渐变顶部(偏亮,制造纵深)
  bgBottom: '#0d131a',     // 背景渐变底部(收暗,把视线压在地面附近)
  surface: '#212c3a',      // 一级表面:卡片
  surfaceHi: '#2b3849',    // 二级表面:选中 / 悬浮
  surfaceSunken: '#171f29',// 凹陷面:进度槽 / 空置槽位
  stroke: 'rgba(255,255,255,0.09)',   // 常规描边
  strokeHi: 'rgba(255,255,255,0.20)', // 强调描边
  sheen: 'rgba(255,255,255,0.10)',    // 顶部内高光
  textDim: 'rgba(255,255,255,0.40)',  // 三级文本(脚注)

  /* ---- 语义色的"亮一档"变体 ----
   * 深色底上原色做小面积文字常偏闷,高亮数值用亮一档的版本。 */
  brandLight: '#3ddc84',
  accentLight: '#6f9bff',
  goldLight: '#ffd166',
  dangerLight: '#ff7a7f',
};

/* ============================================================
 * 规范原语
 * ============================================================ */

/** 背景渐变缓存 —— 每帧 new 一个 CanvasGradient 会持续产生垃圾,必须复用 */
/* ============================================================
 * 背景:一道渐变 + 一层网格
 *
 * 起因:整作六个页面此前共用**同一条** #18202b→#0d131a 的纵向渐变。
 * 单独看没问题,连着切几页就会发现"每个页面都是同一块黑",而且
 * 从顶部到底部只有明度变化,没有任何"光照方向"或"材质"的信息 ——
 * 这正是"黑色有点单调"的来源。
 *
 * 改法刻意选了**零额外填充成本**的那条路:
 *   ① 光晕不另起一层径向渐变,而是**并进主渐变的色标里** ——
 *      顶部先染一抹该页的主题色(0→22%),再回落到中性,底部再压暗一档。
 *      视觉上得到"光从上方来",成本仍然是**一次全屏 fillRect**,与改动前完全一样。
 *   ② 真正额外付出的只有一层 2% 的网格(十几条 1px fillRect)——
 *      它把"平面"变成"有尺度的空间",是深色界面最便宜的一种质感来源。
 *
 * 为什么不让每个页面自己画背景:那会立刻漂成六套光照方向。
 * 页面之间的差异只应该是**色相**(tint),不该是光照逻辑。
 * ============================================================ */

/** '#rrggbb' / '#rgb' → [r,g,b] */
function hexToRgb(hex) {
  let s = String(hex || '').replace('#', '').trim();
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  if (!isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 把 b 按 t 混进 a —— 用来从任意主题色派生"同色系的深色" */
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = [0, 0, 0].map(function (_, i) {
    return Math.max(0, Math.min(255, Math.round(A[i] + (B[i] - A[i]) * t)));
  });
  return '#' + c.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

const _bgCache = new Map();

/**
 * 统一页面背景。
 * @param {object} opt
 *   tint     本页主题色 —— 顶部那一抹光晕就取它,六个页面因此各有温度
 *   grid     false = 不画网格(游戏内场地元素多,再铺网格就乱了)
 *   gridSize 网格间距,默认 112
 */
function bg(ctx, w, h, opt) {
  const o = opt || {};
  const top = o.top || COLORS.bgTop;
  const bottom = o.bottom || COLORS.bgBottom;
  const tint = o.tint || null;

  let e = _bgCache.get(ctx);
  if (!e || e.w !== w || e.h !== h || e.top !== top || e.bottom !== bottom || e.tint !== tint) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    if (tint) {
      g.addColorStop(0, mixHex(top, tint, 0.24));       // 顶部:主题色微染(光从上方来)
      g.addColorStop(0.22, top);                        // 回落到中性
      g.addColorStop(0.72, bottom);
      g.addColorStop(1, mixHex(bottom, '#000000', 0.42)); // 底部再压暗一档
    } else {
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);
    }
    e = { w: w, h: h, top: top, bottom: bottom, tint: tint, grad: g };
    _bgCache.set(ctx, e);
  }
  ctx.fillStyle = e.grad;
  ctx.fillRect(0, 0, w, h);

  /* 网格材质:2% 白。太明显就变成"蓝图纸",太淡又看不见 —— 2% 是
   * 在深色底上"看得到格子但读不出格子"的那一档。 */
  if (o.grid !== false) {
    const step = o.gridSize || 112;
    ctx.fillStyle = 'rgba(255,255,255,0.020)';
    for (let x = step; x < w; x += step) ctx.fillRect(Math.round(x), 0, 1, h);
    for (let y = step; y < h; y += step) ctx.fillRect(0, Math.round(y), w, 1);
  }
  return e.grad;
}

/**
 * 卡片 —— 本作所有"面"的统一画法。
 *
 * 精致感来自三件小事,而不是花哨的特效:
 *   ① 统一圆角      ② 1px 半透明描边(边界清楚,卡片才"立"得住)
 *   ③ 顶部一道内高光(暗示受光方向,是最廉价也最有效的立体感)
 *
 * ⚠️ 刻意不用 ctx.shadow* —— 那是逐像素卷积,低端机上极贵
 *    (与 effects.js 里禁用 shadowBlur 是同一条纪律)。
 *    需要发光时走 glow 参数:多层同心描边,层数固定,代价可预测。
 */
function card(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, w: 100, h: 100,
    r: RADIUS.md,
    fill: COLORS.surface,
    stroke: COLORS.stroke,
    strokeWidth: 1,
    sheen: true,
    glow: null,        // 传颜色 = 外发光
    glowWidth: 3,
    alpha: 1,
  }, opt);

  ctx.save();
  if (o.alpha !== 1) ctx.globalAlpha = o.alpha;

  if (o.glow) {
    // 由外向内三层,越靠内越亮 —— 同心描边模拟光晕,不做模糊
    for (let i = 3; i >= 1; i--) {
      ctx.globalAlpha = o.alpha * 0.09 * (4 - i);
      roundRect(ctx, o.x - i * 2, o.y - i * 2, o.w + i * 4, o.h + i * 4, o.r + i * 2);
      ctx.strokeStyle = o.glow;
      ctx.lineWidth = o.glowWidth;
      ctx.stroke();
    }
    ctx.globalAlpha = o.alpha;
  }

  roundRect(ctx, o.x, o.y, o.w, o.h, o.r);
  ctx.fillStyle = o.fill;
  ctx.fill();

  if (o.sheen) {
    const pad = o.r * 0.9;
    roundRect(ctx, o.x + pad, o.y + 1.5, Math.max(2, o.w - pad * 2), 2, 1);
    ctx.fillStyle = COLORS.sheen;
    ctx.fill();
  }

  if (o.stroke) {
    roundRect(ctx, o.x, o.y, o.w, o.h, o.r);
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.strokeWidth;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * 胶囊底衬 —— HUD 上的数字压在动态背景上时,靠它保证可读性。
 * 本质就是"半径 = 半高"的卡片,所以直接复用 card,不做第二套画法。
 */
function pill(ctx, opt) {
  const o = opt || {};
  return card(ctx, Object.assign({
    r: (o.h || 40) / 2,
    fill: 'rgba(0,0,0,0.34)',
    sheen: false,
  }, o));
}

/** 渐隐分隔线缓存(同上,避免每帧建渐变) */
const _divCache = new Map();

/** 渐隐分隔线 —— 两端淡出,比一条实线"轻",不会把版面切得太硬 */
function divider(ctx, x, y, w, opt) {
  const o = opt || {};
  const color = o.color || COLORS.line;
  const key = x + '|' + w + '|' + color;

  let e = _divCache.get(ctx);
  if (!e || e.key !== key) {
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    e = { key: key, grad: grad };
    _divCache.set(ctx, e);
  }
  ctx.fillStyle = e.grad;
  ctx.fillRect(x, y, w, o.h || 1);
}

/**
 * 给任意一块**已经画好的**圆角面补一道顶部内高光。
 *
 * 存在的理由:有些"面"的形状是特殊的(稀有度描边、选中态高亮、日历格…),
 * 套不进 card 的那一套参数;但它们仍然该有同一道高光 ——
 * 否则"一些卡片有立体感、另一些没有",整页就会显得没做完。
 * 所以把那一笔单独抽出来,给它们就地补上。
 */
function sheen(ctx, x, y, w, h, r) {
  const pad = (r === undefined ? RADIUS.md : r) * 0.9;
  roundRect(ctx, x + pad, y + 1.5, Math.max(2, w - pad * 2), 2, 1);
  ctx.fillStyle = COLORS.sheen;
  ctx.fill();
}

/* ============================================================
 * 排版与图形语言
 *
 * 起因:整作的文字此前几乎都是"一个 fillText 摆在某个坐标上" ——
 * 页面靠**字号**表意,而不靠**层级**。于是每一屏读起来都像一段说明文字,
 * 而不是一张被设计过的界面。缺的从来不是字体,是文字**周边的东西**:
 *
 *   section()   区块标题 —— 左侧一根主题色短竖条。一屏里有三四个区块时,
 *               没有它就是"字号不同的几行字",有了它才知道"这块在讲什么"。
 *   stat()      统计行   —— 数值(大)/ 单位(小)/ 标签(灰) 三段式 + 分隔线。
 *               "1280 分"同字号写在一起是一句话;拆开才是一个**指标**。
 *   kv()        键值行   —— 左标签右数值,共用一条基线,可选点线引导。
 *   empty()     空状态   —— 图标 + 主文案 + 副文案。一句孤零零的灰字
 *               会让人以为"页面坏了";有图标才像"这里本来就该是空的"。
 *   spinner()   加载     —— 一段随时间旋转的弧。"它在动"本身就是信息。
 *   icon()      矢量图标 —— 零美术资源。一串文字前面挂一个图标,
 *               扫读速度的提升比换任何一种字体都大。
 *   monogram()  字母头像 —— 榜单里没有美术资源,又不能给每人画一个方块。
 *
 * ⚠️ 分层纪律不变:这一节全是**纯绘制**,不认识任何业务概念
 *    (稀有度 / 模式 / 成就 / 榜单),只接收"画什么、画在哪、什么色"。
 * ============================================================ */

/** 全局字体族 —— text() 与 measure() 必须同源,否则"量出来的宽"和"画出来的宽"会差一个字体 */
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 量一段文字的宽度,不改动外部 ctx 状态。
 *
 * 为什么需要它:canvas 的 measureText 依赖**当前 font**,而 font 是个全局态。
 * 想算"这个数字 + 这个单位一共多宽"就得临时改 font,算完忘记还回去,
 * 后面所有绘制都会用错字体 —— 这类 bug 只在个别机型上偶尔出现,极难查。
 */
function measure(ctx, str, size, weight) {
  ctx.save();
  ctx.font = (weight || '') + ' ' + (size || TYPE.body) + 'px ' + FONT;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

/**
 * 单行自适应:字号从 size 逐档减小,直到放得下为止。
 *
 * 玩家昵称、皮肤名这类长度不可控的文本,用固定字号一定会溢出卡片。
 * 缩小而不是截断 —— 名字被切掉一半比字小一点难受得多。
 */
function fitText(ctx, str, x, y, maxW, opt) {
  const o = opt || {};
  let size = o.size || TYPE.body;
  const min = o.minSize || 15;
  while (size > min && measure(ctx, str, size, o.weight) > maxW) size -= 2;
  return text(ctx, str, x, y, Object.assign({}, o, { size: size }));
}

/** 单行截断(带省略号)—— 与 fitText 相反:宁可切掉也不改变字号,用于"必须整齐"的列表 */
function ellipsis(ctx, str, maxW, opt) {
  const o = opt || {};
  const size = o.size || TYPE.body;
  let s = String(str === undefined || str === null ? '' : str);
  if (measure(ctx, s, size, o.weight) <= maxW) return s;
  while (s.length > 1 && measure(ctx, s + '…', size, o.weight) > maxW) s = s.slice(0, -1);
  return s + '…';
}

/**
 * 按宽度折行 —— 返回若干行文本。
 *
 * 为什么需要它:整作大量文案是"从参数派生的一句话"(READY 面板的规则速览、
 * 模式的定位语),它们的长度**不可控** —— 金潮那句
 * 「金块会横向游走,连击越高跑得越快 —— 站着不动,一个也拿不到」
 * 在 25px 下约 870px,而卡片只有 632px。
 * 这里不能用 fitText(要缩到 18px 才塞得下,读起来吃力),也不能用 ellipsis
 * (截断掉的正是"这一屏最重要的一行字"里的一半信息)—— 只能折行。
 *
 * 中文没有词边界,所以按字断行;但**逗号 / 破折号 / 空格之后**是天然的气口,
 * 能在那里断就在那里断,否则读起来像被硬生生切断。
 */
function wrapText(ctx, str, maxW, size, weight) {
  const s = String(str === undefined || str === null ? '' : str);
  if (!s) return [''];
  if (maxW <= 0) return [s];
  const BREAK = /[\s,，。、;；:：!！?？)）】」》—]/;
  const out = [];
  let line = '';
  let breakAt = -1;          // line 内最近一个气口(断点落在该字符**之后**)
  const rebreak = function () {
    breakAt = -1;
    for (let k = 0; k < line.length; k++) {
      if (BREAK.test(line.charAt(k))) breakAt = k + 1;
    }
  };
  const flush = function () {
    /* 气口离行尾太远就不用它 —— 否则会断出"第一行只剩两三个字"的难看结果 */
    if (breakAt > 0 && line.length - breakAt <= 6) {
      out.push(line.slice(0, breakAt));
      line = line.slice(breakAt);
    } else if (breakAt === line.length) {
      out.push(line);
      line = '';
    } else {
      out.push(line);
      line = '';
    }
    rebreak();
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (line && measure(ctx, line + ch, size, weight) > maxW) flush();
    line += ch;
    if (BREAK.test(ch)) breakAt = line.length;
  }
  if (line) out.push(line);
  return out;
}

/**
 * 区块标题 —— 左侧主题色短竖条 + 标题,可选右侧附注。
 * 返回画完标题后的右边界,方便调用方接着排。
 */
function section(ctx, opt) {
  const o = Object.assign({
    x: 48, y: 0, w: 0, text: '', color: COLORS.text,
    size: TYPE.heading, note: '', noteColor: COLORS.textSub,
    barColor: COLORS.brand, barW: 6, barH: 32,
  }, opt);

  ctx.save();
  roundRect(ctx, o.x, o.y - o.barH / 2, o.barW, o.barH, o.barW / 2);
  ctx.fillStyle = o.barColor;
  ctx.fill();
  ctx.restore();

  const tx = o.x + o.barW + SPACE.sm;
  const r = text(ctx, o.text, tx, o.y, { size: o.size, color: o.color, weight: 'bold' });
  if (o.note && o.w) {
    text(ctx, o.note, o.x + o.w, o.y, {
      size: TYPE.caption, color: o.noteColor, align: 'right',
    });
  }
  return r;
}

/**
 * 一排统计 —— 图标 / 数值 / 单位 / 标签 四层。
 *
 * items: [{ icon, value, unit, label, color, valueSize }]
 *   h > 0 时自动带底板与内部竖分隔线 —— 三格共用**一张**卡比三张独立小卡更像
 *   "一条指标栏",而且分隔线天然说明了它们同属一组。
 *   h = 0 时只排文字(用于已经有大卡的区域)。
 *
 * ⚠️ 单位比数值小两档、并且**跟着数值一起居中**。若各自居中,
 *    "12/24" 与 "3/19" 两格的数字会左右不齐,一栏指标立刻显得潦草。
 */
function stat(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, w: 0, h: 0,
    items: [], divider: true,
    fill: 'rgba(255,255,255,0.05)', stroke: COLORS.stroke, r: RADIUS.md, sheen: false,
    valueSize: 34, unitSize: 20, labelSize: TYPE.micro,
    iconSize: 26,
  }, opt);
  const n = o.items.length;
  if (n === 0) return;

  if (o.h > 0) {
    card(ctx, {
      x: o.x, y: o.y, w: o.w, h: o.h, r: o.r,
      fill: o.fill, stroke: o.stroke, sheen: o.sheen,
    });
  }

  const colW = o.w / n;
  const hasLabel = o.items.some((it) => it.label);
  const hasIcon = o.items.some((it) => it.icon);

  /* ---------- 纵向排布:图标(上)/ 数值块(中,含单位)/ 标签(下)----------
   *
   * ⚠️ 这里原来是两个魔数比例:「数值放 0.60×h,标签放 h−16」。
   *    h=100 时两者相距 24px,看着够 —— 可"数值"的**下沿并不是数值基线**:
   *    单位要下沉 vs×0.28(=34×0.28≈9.5px)再算自己的半高,于是整个数值块
   *    往下探了约 19.5px,只比标签的顶边低 4px。
   *    4px 的"盒间距"落到实心笔画上就是**贴在一起** —— 玩家看到的是
   *    「4 天」的"天"压在「累计签到」上,而这类数字卡全作只此一处,
   *    一眼就是"没做完"。多个模式数值、多个页面共用一个原语,
   *    所以它在别的数据下(「/24」「/19」)也照样会撞。
   *
   *    这与商城头部那次(药丸宽度是动态的、附注却按死宽度收边)是**同一类错**:
   *    一个元素的位置取决于另一个元素的**实际尺寸**,就不能各算各的。
   *    所以改成真正的"自上而下流":先量出三层各自的高度,按最小净空依次排下来,
   *    最后把整块内容在 h 里居中。换 h、换字号、单位从"/24"变成"天",
   *    或者哪天给某项单独调大 valueSize,都不会再撞。 */
  const gapIcon = 6;    // 图标 → 数值块
  const gapLabel = 6;   // 数值块 → 标签

  // 数值块的上下沿(相对数值基线):上沿是数值的半高;下沿要把单位的沉降算进去
  const vTop = -o.valueSize / 2;
  let unitDrop = 0, unitHalf = 0;
  for (let k = 0; k < n; k++) {
    const it = o.items[k];
    if (!it.unit) continue;
    unitDrop = Math.max(unitDrop, (it.valueSize || o.valueSize) * 0.28);
    unitHalf = Math.max(unitHalf, (it.unitSize || o.unitSize) / 2);
  }
  const vBottom = unitDrop + unitHalf;

  const iconH = hasIcon ? o.iconSize : 0;
  const labelH = hasLabel ? o.labelSize : 0;
  const blockH = vBottom - vTop;                                        // 数值块高度
  const totalH = (hasIcon ? iconH + gapIcon : 0) + blockH +
    (hasLabel ? gapLabel + labelH : 0);

  // 整体居中。h 不够时(或上层明确用 h=0 只排文字)退化成"从 y 往下流",
  // 宁可贴顶也不越出给定的盒子。
  const top0 = o.h > 0 ? o.y + Math.max(0, (o.h - totalH) / 2) : o.y - vTop;
  const blockTop = top0 + (hasIcon ? iconH + gapIcon : 0);
  const iconCy = top0 + iconH / 2;
  const valueCy = blockTop - vTop;
  const labelCy = blockTop + blockH + gapLabel + labelH / 2;

  for (let i = 0; i < n; i++) {
    const it = o.items[i];
    const ccx = o.x + colW * (i + 0.5);
    const vs = it.valueSize || o.valueSize;
    const us = it.unitSize || o.unitSize;
    const vs0 = String(it.value);
    const vw = measure(ctx, vs0, vs, 'bold');
    const uw = it.unit ? measure(ctx, it.unit, us, 'bold') : 0;
    // 数值与单位组成一个整体再居中 —— 否则单位会把数字推偏,一排数字左右不齐
    const total = vw + uw + (it.unit ? 5 : 0);
    const vx = ccx - total / 2;

    if (it.icon) {
      icon(ctx, it.icon, ccx - o.iconSize / 2, iconCy - o.iconSize / 2, o.iconSize, {
        color: it.color || COLORS.textSub, lineWidth: Math.max(1.5, o.iconSize * 0.085),
      });
    }

    text(ctx, vs0, vx, valueCy, {
      size: vs, color: it.color || COLORS.text, weight: 'bold',
    });
    if (it.unit) {
      text(ctx, it.unit, vx + vw + 5, valueCy + vs * 0.28, {
        size: us, color: it.unitColor || COLORS.textSub, weight: 'bold',
      });
    }
    if (it.label) {
      text(ctx, it.label, ccx, labelCy, {
        size: o.labelSize, color: COLORS.textSub, align: 'center',
      });
    }
    if (o.divider && i < n - 1) {
      ctx.save();
      ctx.fillStyle = COLORS.line;
      // 分隔线与**内容**同高,而不是与盒子同高 —— 内容一变高,它自己跟着变
      ctx.fillRect(o.x + colW * (i + 1), top0 + 3, 1, Math.max(8, totalH - 6));
      ctx.restore();
    }
  }
}

/**
 * 键值行 —— 左标签、右数值、共用一条基线。
 * leader = true 时补一串点线,把视线从左引到右(长列表里很有效)。
 */
function kv(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, w: 400, label: '', value: '',
    labelColor: COLORS.textSub, valueColor: COLORS.text,
    size: TYPE.label, valueWeight: 'bold', leader: false, leaderColor: COLORS.line,
  }, opt);

  text(ctx, o.label, o.x, o.y, { size: o.size, color: o.labelColor });
  text(ctx, o.value, o.x + o.w, o.y, {
    size: o.size, color: o.valueColor, align: 'right', weight: o.valueWeight,
  });

  if (o.leader) {
    const x0 = o.x + measure(ctx, o.label, o.size) + 14;
    const x1 = o.x + o.w - measure(ctx, o.value, o.size, o.valueWeight) - 14;
    if (x1 > x0 + 8) {
      ctx.save();
      ctx.strokeStyle = o.leaderColor;
      ctx.lineWidth = 1;
      if (ctx.setLineDash) ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(x0, o.y + 1);
      ctx.lineTo(x1, o.y + 1);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

/** 角标 —— 卡片角上的一小块,用于"我 / 新 / 大奖"。x,y 是它的中心 */
function badge(ctx, opt) {
  const o = Object.assign({
    x: 0, y: 0, text: '', color: COLORS.gold, textColor: '#2a1c02',
    size: TYPE.micro, padX: 13, h: 30, r: 15,
  }, opt);
  const w = measure(ctx, o.text, o.size, 'bold') + o.padX * 2;
  roundRect(ctx, o.x - w / 2, o.y - o.h / 2, w, o.h, o.r);
  ctx.fillStyle = o.color;
  ctx.fill();
  text(ctx, o.text, o.x, o.y, {
    size: o.size, color: o.textColor, align: 'center', weight: 'bold',
  });
  return w;
}

/**
 * 空状态 —— 图标 + 主文案 + 副文案,整体以 (cx, cy) 为中心。
 * 副文案存在的意义:一句"还没有人上榜"只说明现状,
 * 加上"快去抢第一名"才是**下一步该做什么**。
 */
function empty(ctx, opt) {
  const o = Object.assign({
    cx: 375, cy: 620, icon: 'alert', iconSize: 92, color: COLORS.textDim,
    title: '', sub: '', titleColor: COLORS.textSub, alpha: 0.5,
  }, opt);

  icon(ctx, o.icon, o.cx - o.iconSize / 2, o.cy - o.iconSize / 2 - 26, o.iconSize, {
    color: o.color, alpha: o.alpha,
  });
  if (o.title) {
    text(ctx, o.title, o.cx, o.cy + o.iconSize / 2 + 4, {
      size: TYPE.body, color: o.titleColor, align: 'center',
    });
  }
  if (o.sub) {
    text(ctx, o.sub, o.cx, o.cy + o.iconSize / 2 + 46, {
      size: TYPE.caption, color: COLORS.textDim, align: 'center',
    });
  }
}

/**
 * 加载指示 —— 一段随时间旋转的弧。
 * 刻意不写"加载中…"就完事:静态的三个字无法区分"在加载"和"卡住了",
 * 而一段在动的弧可以。整圈用极淡的槽色,转动的那一段用主题色。
 */
function spinner(ctx, cx, cy, r, opt) {
  const o = opt || {};
  const t = typeof o.t === 'number' ? o.t : Date.now() / 1000;
  const lw = Math.max(2, r * 0.24);

  ctx.save();
  ctx.lineCap = 'round';

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const a0 = t * 3.6;
  ctx.strokeStyle = o.color || COLORS.brand;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a0 + Math.PI * 0.66);
  ctx.stroke();
  ctx.restore();
}

/** 稳定哈希 —— monogram 用它把"同一个昵称"映射到"同一个颜色" */
function hashCode(str) {
  const s = String(str === undefined || str === null ? '' : str);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 字母头像 —— 榜单里没有美术资源可用。
 *
 * 关键在**稳定**:色相由昵称哈希决定,同一个名字永远是同一个颜色,换一局也不会变。
 * 于是"榜上那几个人"在视觉上被区分开了,而这一切不需要服务端返回任何头像字段,
 * 也不需要一张图片 —— 这是"零美术资源"下能拿到的最接近"有头像"的效果。
 */
function monogram(ctx, name, cx, cy, size, opt) {
  const o = opt || {};
  const s = String(name === undefined || name === null ? '' : name).trim();
  const ch = s ? s[0] : '玩';
  const hue = hashCode(s || '玩家') % 360;
  const r = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = o.fill || ('hsl(' + hue + ', 34%, 32%)');
  ctx.fill();
  ctx.strokeStyle = o.stroke || 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  text(ctx, ch, cx, cy + 1, {
    size: Math.round(size * 0.44),
    color: o.color || 'rgba(255,255,255,0.92)',
    align: 'center', baseline: 'middle', weight: 'bold',
  });
}

/* ============================================================
 * 矢量图标 —— 零美术资源
 *
 * 全部用路径画,笔画式(lineWidth 随 size 走),因此同一份代码在 18px 与 92px 下都成立。
 * 约定与 shapePath 一致:传入**包围盒左上角 + 边长**,不是中心点。
 *
 * ⚠️ 与 SUPPORTED_SHAPES 同一条纪律:这里是**图标**,那边是**玩家造型**,两回事。
 *    不要为了省事把造型名塞进 icon(),它们的用途和观感完全不同。
 * ============================================================ */
const ICONS = [
  'coin',    // 金币(古钱:外圆 + 方孔)
  'trophy',  // 奖杯
  'medal',   // 奖牌
  'crown',   // 皇冠
  'calendar',// 日历
  'check',   // 对勾
  'clock',   // 时钟
  'flame',   // 火苗(连签)
  'lock',    // 锁
  'star',    // 星
  'chart',   // 柱状图
  'gift',    // 礼盒
  'shapes',  // 造型图鉴(圆/方/三角)
  'alert',   // 提示(圆圈 + 感叹号)
];

function icon(ctx, name, x, y, size, opt) {
  const o = opt || {};
  const s = size || 32;
  const cx = x + s / 2;
  const cy = y + s / 2;

  ctx.save();
  ctx.strokeStyle = o.color || COLORS.textSub;
  ctx.fillStyle = o.color || COLORS.textSub;
  ctx.lineWidth = o.lineWidth || Math.max(1.5, s * 0.088);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;

  switch (name) {
    case 'coin': {
      const r = s * 0.42;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const h = r * 0.40;
      roundRect(ctx, cx - h, cy - h, h * 2, h * 2, h * 0.32);
      ctx.stroke();
      break;
    }

    case 'trophy': {
      const w = s * 0.46, h = s * 0.40, ty = y + s * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, ty);
      ctx.lineTo(cx + w / 2, ty);
      ctx.lineTo(cx + w / 2, ty + h * 0.52);
      ctx.quadraticCurveTo(cx + w / 2, ty + h, cx, ty + h);
      ctx.quadraticCurveTo(cx - w / 2, ty + h, cx - w / 2, ty + h * 0.52);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - w / 2, ty + h * 0.26, h * 0.30, Math.PI * 0.5, Math.PI * 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + w / 2, ty + h * 0.26, h * 0.30, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, ty + h);
      ctx.lineTo(cx, y + s * 0.78);
      ctx.moveTo(cx - s * 0.20, y + s * 0.88);
      ctx.lineTo(cx + s * 0.20, y + s * 0.88);
      ctx.stroke();
      break;
    }

    case 'medal': {
      const r = s * 0.255, my = y + s * 0.66;
      ctx.beginPath();
      ctx.arc(cx, my, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.62, y + s * 0.06);
      ctx.lineTo(cx - r * 0.24, my - r * 0.72);
      ctx.moveTo(cx + r * 0.62, y + s * 0.06);
      ctx.lineTo(cx + r * 0.24, my - r * 0.72);
      ctx.stroke();
      break;
    }

    case 'crown': {
      const by = y + s * 0.76, h = s * 0.44;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.38, by);
      ctx.lineTo(cx - s * 0.38, by - h * 0.52);
      ctx.lineTo(cx - s * 0.16, by - h * 0.18);
      ctx.lineTo(cx, by - h);
      ctx.lineTo(cx + s * 0.16, by - h * 0.18);
      ctx.lineTo(cx + s * 0.38, by - h * 0.52);
      ctx.lineTo(cx + s * 0.38, by);
      ctx.closePath();
      ctx.stroke();
      break;
    }

    case 'calendar': {
      const w = s * 0.76, h = s * 0.68;
      const top = cy - h / 2 + s * 0.05;
      roundRect(ctx, cx - w / 2, top, w, h, s * 0.11);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, top + h * 0.30);
      ctx.lineTo(cx + w / 2, top + h * 0.30);
      ctx.moveTo(cx - w * 0.26, top - s * 0.06);
      ctx.lineTo(cx - w * 0.26, top + s * 0.08);
      ctx.moveTo(cx + w * 0.26, top - s * 0.06);
      ctx.lineTo(cx + w * 0.26, top + s * 0.08);
      ctx.stroke();
      break;
    }

    case 'check': {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.30, cy + s * 0.02);
      ctx.lineTo(cx - s * 0.07, cy + s * 0.25);
      ctx.lineTo(cx + s * 0.31, cy - s * 0.26);
      ctx.stroke();
      break;
    }

    case 'clock': {
      const r = s * 0.42;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.52);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + r * 0.44, cy + r * 0.22);
      ctx.stroke();
      break;
    }

    case 'flame': {
      ctx.beginPath();
      ctx.moveTo(cx, y + s * 0.08);
      ctx.bezierCurveTo(cx + s * 0.36, y + s * 0.36,
        cx + s * 0.30, y + s * 0.94, cx, y + s * 0.94);
      ctx.bezierCurveTo(cx - s * 0.30, y + s * 0.94,
        cx - s * 0.36, y + s * 0.36, cx, y + s * 0.08);
      ctx.stroke();
      // 内焰:一小段向上的弧,让"火"有两层
      ctx.beginPath();
      ctx.moveTo(cx, y + s * 0.46);
      ctx.quadraticCurveTo(cx + s * 0.13, y + s * 0.66, cx, y + s * 0.80);
      ctx.stroke();
      break;
    }

    case 'lock': {
      const w = s * 0.62, h = s * 0.46;
      const top = cy - h * 0.10;
      roundRect(ctx, cx - w / 2, top, w, h, s * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, top, w * 0.30, Math.PI, 0);
      ctx.stroke();
      break;
    }

    case 'star': {
      starPath(ctx, cx, cy, s * 0.42, s * 0.42, 5, 0.44, -90);
      ctx.fill();
      break;
    }

    case 'chart': {
      const bw = s * 0.16, gap = s * 0.10;
      const base = y + s * 0.84;
      const hs = [s * 0.34, s * 0.56, s * 0.76];
      for (let i = 0; i < 3; i++) {
        const bx = cx - (bw * 3 + gap * 2) / 2 + i * (bw + gap);
        roundRect(ctx, bx, base - hs[i], bw, hs[i], bw * 0.35);
        ctx.stroke();
      }
      break;
    }

    case 'gift': {
      const w = s * 0.72, h = s * 0.56;
      const top = cy - h * 0.16;
      roundRect(ctx, cx - w / 2, top, w, h, s * 0.08);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(cx, top + h);
      ctx.moveTo(cx - w / 2, top + h * 0.22);
      ctx.lineTo(cx + w / 2, top + h * 0.22);
      ctx.stroke();
      // 蝴蝶结:两个小圈
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.quadraticCurveTo(cx - w * 0.34, top - h * 0.42, cx, top - h * 0.06);
      ctx.moveTo(cx, top);
      ctx.quadraticCurveTo(cx + w * 0.34, top - h * 0.42, cx, top - h * 0.06);
      ctx.stroke();
      break;
    }

    case 'shapes': {
      // 三件不同的轮廓并排 —— 一眼就是"造型图鉴",不需要写"皮肤"两个字
      ctx.beginPath();
      ctx.arc(cx - s * 0.26, cy - s * 0.18, s * 0.15, 0, Math.PI * 2);
      ctx.stroke();
      roundRect(ctx, cx + s * 0.10, cy - s * 0.33, s * 0.30, s * 0.30, s * 0.07);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.28, cy + s * 0.34);
      ctx.lineTo(cx - s * 0.06, cy + s * 0.34);
      ctx.lineTo(cx - s * 0.17, cy + s * 0.06);
      ctx.closePath();
      ctx.stroke();
      break;
    }

    case 'alert':
    default: {
      const r = s * 0.42;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.46);
      ctx.lineTo(cx, cy + r * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.46, Math.max(1, s * 0.05), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

module.exports = {
  roundRect, shapePath, sprite, spriteTrail, text, image, button, progress,
  bg, card, pill, divider, sheen,
  section, stat, kv, badge, empty, spinner, icon, monogram,
  measure, fitText, ellipsis, wrapText, hashCode, FONT,
  SPACE, RADIUS, TYPE, Ease,
  SUPPORTED_SHAPES, ICONS, COLORS, screen,
};
