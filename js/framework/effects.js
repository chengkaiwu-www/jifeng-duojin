/**
 * framework/effects.js —— 轻量粒子特效层
 *
 * 为什么需要单独一层:
 *   特效如果散落在场景的 renderXxx 里(每个地方自己维护一个数组、自己算衰减),
 *   很快就会变成"每个特效一套代码",而且**数组会无限增长** ——
 *   小游戏的内存与 GC 都经不起每帧 new 几十个对象。
 *
 * 这一层的三条硬约束(都是为了真机上不掉帧):
 *   ① **固定容量粒子池**:启动时一次性分配 MAX_PARTICLES 个对象,之后只改字段、
 *      绝不 new。池满时**静默丢弃新的**(而不是扩容)—— 特效丢一帧没人看得出,
 *      但一次 GC 卡顿所有人都能感觉到。
 *   ② **禁止 shadowBlur**:发光效果在 Canvas 上是逐像素卷积,低端机上极贵。
 *      这里的"发光"一律用 alpha 叠加的同心圆近似,成本是常量。
 *   ③ **零状态环境层**:ambient() 是纯函数(位置 = hash(i) 与时间的函数),
 *      不占用粒子池、不产生 GC,背景永远有东西在动但开销是 0 分配。
 *
 * ⚠️ 这一层**只读不写**:它不碰 world、不改任何玩法状态。
 *    特效永远不能影响判定 —— 否则"视觉"和"规则"就开始互相污染了。
 */

/** 粒子池容量。220 是实测在低端安卓上仍能稳定 60fps 的量级 */
const MAX_PARTICLES = 220;

/** 缓动:让粒子末段自然收敛,而不是"到点突然消失" */
function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

/** 稳定的伪随机 [0,1):同一个 i 永远得到同一个值 —— ambient 靠它做"无状态" */
function hash(i, k) {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/* ---------- 粒子池 ---------- */

function newParticle() {
  return {
    kind: 'dot',      // dot | square | streak | ring | ribbon
    x: 0, y: 0,
    vx: 0, vy: 0,
    life: 0,          // 剩余寿命(秒)
    maxLife: 1,       // 初始寿命,用来算衰减比例
    size: 8,
    grow: 0,          // size 每秒增长量(圆环靠它扩散)
    width: 3,         // 描边宽度 / 线条粗细
    color: '#ffffff',
    rot: 0,
    spin: 0,          // 弧度/秒
    grav: 0,          // 重力(设计像素/秒²)
    drag: 0,          // 阻尼系数(0 = 无阻尼)
  };
}

const pool = [];
for (let i = 0; i < MAX_PARTICLES; i++) pool.push(newParticle());

/** 当前活跃粒子数 —— pool[0..n) 是活跃区,swap-remove 保持紧凑 */
let n = 0;

function count() {
  return n;
}

/** 清空全部粒子(切场景、重开一局时调,避免上一局的碎片飘到新一局) */
function clear() {
  n = 0;
}

/** 取一个空槽并初始化;池满返回 null(静默丢弃,不扩容) */
function alloc(kind, x, y, opt) {
  if (n >= MAX_PARTICLES) return null;
  const p = pool[n];
  n += 1;

  p.kind = kind;
  p.x = x;
  p.y = y;
  p.vx = opt.vx || 0;
  p.vy = opt.vy || 0;
  p.maxLife = Math.max(0.05, opt.life === undefined ? 0.5 : opt.life);
  p.life = p.maxLife;
  p.size = opt.size === undefined ? 8 : opt.size;
  p.grow = opt.grow || 0;
  p.width = opt.width === undefined ? 3 : opt.width;
  p.color = opt.color || '#ffffff';
  p.rot = opt.rot || 0;
  p.spin = opt.spin || 0;
  p.grav = opt.grav || 0;
  p.drag = opt.drag || 0;
  return p;
}

/* ---------- 特效预设 ---------- */

/**
 * 环形爆发:向四周飞散的碎片。
 * 用在哪:受击(红色碎片)/ 拾取(金色碎片)/ 时间到(白色碎片)。
 */
function burst(x, y, opt) {
  const o = opt || {};
  const num = clamp(o.count === undefined ? 16 : o.count, 0, 40);
  const speed = o.speed === undefined ? 320 : o.speed;
  const colors = o.colors || [o.color || '#ffffff'];
  const kind = o.kind || 'dot';
  const spread = o.spread === undefined ? 1 : o.spread;   // 1 = 全圆

  for (let i = 0; i < num; i++) {
    // 均匀分布在圆周上,再叠一点抖动 —— 完全随机会出现"成团"的难看分布
    const a = (o.angle === undefined ? 0 : o.angle) +
      (i / num) * Math.PI * 2 * spread +
      (Math.random() - 0.5) * 0.35;
    const v = speed * (0.55 + Math.random() * 0.75);
    alloc(kind, x, y, {
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: (o.life === undefined ? 0.46 : o.life) * (0.7 + Math.random() * 0.6),
      size: (o.size === undefined ? 9 : o.size) * (0.6 + Math.random() * 0.8),
      color: colors[i % colors.length],
      grav: o.grav === undefined ? 460 : o.grav,
      drag: o.drag === undefined ? 2.2 : o.drag,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 8,
    });
  }
}

/** 冲击波圆环:一个向外扩张并淡出的空心圆。受击时用它表达"撞上了" */
function ring(x, y, opt) {
  const o = opt || {};
  alloc('ring', x, y, {
    size: o.size === undefined ? 18 : o.size,
    grow: o.grow === undefined ? 620 : o.grow,
    life: o.life === undefined ? 0.34 : o.life,
    width: o.width === undefined ? 9 : o.width,
    color: o.color || '#ffffff',
  });
}

/**
 * 定向火花:沿某个方向甩出的细线。
 * 用在哪:擦身而过 —— 火花的方向就是玩家掠过红块的方向,
 * 所以"我刚才从哪边擦过去的"这件事是被画出来的,不用文字解释。
 */
function spark(x, y, opt) {
  const o = opt || {};
  const num = clamp(o.count === undefined ? 8 : o.count, 0, 24);
  const angle = o.angle === undefined ? 0 : o.angle;
  const spreadArc = o.spread === undefined ? 1.1 : o.spread;
  const speed = o.speed === undefined ? 520 : o.speed;

  for (let i = 0; i < num; i++) {
    const a = angle + (Math.random() - 0.5) * spreadArc;
    const v = speed * (0.6 + Math.random() * 0.9);
    alloc('streak', x, y, {
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0.20 + Math.random() * 0.16,
      size: 18 + Math.random() * 16,
      width: 2 + Math.random() * 2.5,
      color: o.color || '#ffb020',
      drag: 3.4,
      grav: 120,
    });
  }
}

/** 彩带:破纪录时从顶部飘落。ribbon 是细长矩形,带自转 */
function confetti(opt) {
  const o = opt || {};
  const num = clamp(o.count === undefined ? 42 : o.count, 0, 80);
  const W = o.width === undefined ? 750 : o.width;
  const colors = o.colors || ['#07c160', '#ffb020', '#2f6bff', '#e5484d', '#ffffff'];

  for (let i = 0; i < num; i++) {
    alloc('ribbon', Math.random() * W, -20 - Math.random() * 140, {
      vx: (Math.random() - 0.5) * 120,
      vy: 190 + Math.random() * 260,
      life: 1.8 + Math.random() * 1.4,
      size: 14 + Math.random() * 16,
      width: 6 + Math.random() * 7,
      color: colors[i % colors.length],
      grav: 130,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 9,
    });
  }
}

/* ---------- 推进与渲染 ---------- */

/**
 * @param {number} dt 固定步长(秒)
 * 用 swap-remove 回收:把活跃区末尾的粒子换到被淘汰的位置,再收缩 n。
 * 比 splice 便宜得多(小游戏里 splice 的数组搬移在每帧几十次时会明显掉帧)。
 */
function update(dt) {
  const step = clamp(dt, 0, 0.05);   // 卡顿后不让粒子瞬移,避免"一帧穿屏"
  for (let i = n - 1; i >= 0; i--) {
    const p = pool[i];
    p.life -= step;
    if (p.life <= 0) {
      const last = pool[n - 1];
      pool[n - 1] = p;
      pool[i] = last;
      n -= 1;
      continue;
    }
    if (p.drag) {
      const k = Math.max(0, 1 - p.drag * step);
      p.vx *= k;
      p.vy *= k;
    }
    if (p.grav) p.vy += p.grav * step;
    p.x += p.vx * step;
    p.y += p.vy * step;
    p.rot += p.spin * step;
    p.size += p.grow * step;
  }
}

function render(ctx) {
  for (let i = 0; i < n; i++) {
    const p = pool[i];
    const t = p.life / p.maxLife;          // 1 → 0
    const a = clamp(t, 0, 1);
    if (a <= 0.01) continue;

    ctx.save();
    ctx.globalAlpha = a;

    if (p.kind === 'ring') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.width * a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.size), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (p.kind === 'streak') {
      // 细线:方向即速度方向,长度随寿命收缩 —— 天然画出"甩出去"的感觉
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = a * 0.9;
      ctx.lineWidth = p.width;
      ctx.lineCap = 'round';
      const len = p.size * (0.4 + t * 0.9);
      const ang = Math.atan2(p.vy, p.vx);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    ctx.translate(p.x, p.y);
    if (p.rot) ctx.rotate(p.rot);
    ctx.fillStyle = p.color;

    if (p.kind === 'square') {
      const s = p.size;
      ctx.fillRect(-s / 2, -s / 2, s, s);
    } else if (p.kind === 'ribbon') {
      const h = p.size;
      const w = p.width * (0.6 + t * 0.9);
      ctx.fillRect(-w / 2 - h * 0.3, -h / 2, w, h);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(0.5, p.size / 2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ---------- 无状态环境层 ---------- */

/**
 * 背景漂浮粒子 —— **纯函数,不用粒子池、不产生任何分配**。
 *
 * 每个点的位置只由 (i, t) 决定:i 决定它的相位与速度,t 是累计时间。
 * 好处:① 零 GC;② 任何时候调用都能得到同一个画面,可以脱离帧率单独验证;
 *      ③ 不需要"生成—回收"的循环,永远不会泄漏。
 *
 * @param {object} opt {width, height, t, color, count, parallaxX, alpha, speed}
 */
function ambient(ctx, opt) {
  const o = opt || {};
  const W = o.width || 750;
  const H = o.height || 1334;
  const t = o.t || 0;
  const num = clamp(o.count === undefined ? 26 : o.count, 0, 90);
  const color = o.color || '#ffffff';
  const baseAlpha = o.alpha === undefined ? 0.16 : o.alpha;
  const speedK = o.speed === undefined ? 1 : o.speed;
  const px = o.parallaxX || 0;

  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < num; i++) {
    const depth = 0.35 + hash(i, 3) * 0.65;                    // 越大越"近"
    const sp = (22 + hash(i, 2) * 46) * speedK * depth;
    const y = ((hash(i, 1) * H + t * sp) % (H + 120)) - 60;
    const x = hash(i, 0) * W + px * depth * 0.05;
    const r = (1.4 + hash(i, 4) * 3.2) * depth;

    ctx.globalAlpha = baseAlpha * depth;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

module.exports = {
  MAX_PARTICLES,
  clear,
  count,
  burst,
  ring,
  spark,
  confetti,
  update,
  render,
  ambient,
  easeOut,
  hash,
};
