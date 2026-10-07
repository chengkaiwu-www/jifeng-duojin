/**
 * framework/game-loop.js —— 主循环(定步长逻辑 + 插值渲染)
 *
 * 为什么不能简单地"每帧跑一次 update":
 *   60Hz 设备每秒跑 60 次,30Hz 设备每秒只跑 30 次。如果 update 里按"每帧移动固定距离"
 *   写逻辑,30Hz 设备上的游戏速度会慢一半,手感完全不同。
 *
 * 本实现:逻辑固定按 1/60 秒推进,渲染用剩余比例做插值。
 * 收益:所有机型的物理速度一致,同时渲染尽量平滑。
 */
const Logger = require('../utils/logger.js');

const STEP = 1 / 60;        // 逻辑步长(秒)
const MAX_FRAME = 0.25;     // 单帧最大补偿时长,防止切后台回来"追帧爆炸"

let running = false;
let lastTime = 0;
let accumulator = 0;
let rafId = null;           // 小游戏里 requestAnimationFrame 无有效返回,仅作占位
let onUpdate = null;
let onRender = null;
let fpsTimer = 0;
let fpsCount = 0;
let fps = 0;

function frame(now) {
  if (!running) return;

  // 小游戏部分环境下 requestAnimationFrame 不传参数,用 Date.now() 兜底
  if (typeof now !== 'number') now = Date.now();

  let elapsed = (now - lastTime) / 1000;
  lastTime = now;
  if (elapsed > MAX_FRAME) elapsed = MAX_FRAME;
  if (elapsed < 0) elapsed = 0;

  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= STEP && steps < 5) {
    if (onUpdate) onUpdate(STEP);
    accumulator -= STEP;
    steps++;
  }
  // 极端卡顿时丢弃堆积的步数,避免"死亡螺旋"(越卡越要追帧,越追越卡)
  if (steps >= 5) accumulator = 0;

  if (onRender) onRender(accumulator / STEP);

  // FPS 采样:仅用于 debug 面板
  fpsTimer += elapsed; fpsCount++;
  if (fpsTimer >= 1) { fps = fpsCount; fpsTimer = 0; fpsCount = 0; }

  requestAnimationFrame(frame);
}

module.exports = {
  /**
   * @param {(dt:number)=>void} updateFn 固定步长逻辑更新
   * @param {(alpha:number)=>void} renderFn 渲染,alpha 为插值系数 0~1
   */
  start(updateFn, renderFn) {
    if (running) return;
    onUpdate = updateFn;
    onRender = renderFn;
    running = true;
    lastTime = Date.now();
    accumulator = 0;
    Logger.log('game loop started');
    requestAnimationFrame(frame);
  },

  /**
   * 暂停:切后台必须调用。
   * 不暂停会导致回前台时 elapsed 巨大 → 掉帧甚至闪退。
   */
  pause() {
    if (!running) return;
    running = false;
    Logger.log('game loop paused');
  },

  /** 恢复:重新对齐时间基准,避免把后台时长算进来 */
  resume() {
    if (running) return;
    running = true;
    lastTime = Date.now();
    accumulator = 0;
    Logger.log('game loop resumed');
    requestAnimationFrame(frame);
  },

  isRunning() { return running; },
  getFPS() { return fps; },
};
