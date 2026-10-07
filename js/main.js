/**
 * main.js —— 启动编排
 *
 * 整个小游戏的启动顺序在这里定义。这个顺序不是随意的,是按"用户等待感"设计的:
 *
 *   0ms    初始化画布 → 立刻能画东西
 *   0ms    画加载页   → 绝不白屏(白屏是首屏流失的头号原因)
 *   之后   并行:云环境初始化 / 静默登录 / 补报上次失败的数据
 *   就绪   预加载首屏资源 → 进主页
 *
 * 原则:任何一步失败都不阻塞进入游戏。登录失败走游客态,资源失败就少一张图,
 * 但玩家必须能玩到核心玩法。
 */
const cfg = require('./config/config.js');
const Logger = require('./utils/logger.js');

const screen = require('./framework/screen.js');
const EventBus = require('./framework/event-bus.js');
const SceneManager = require('./framework/scene-manager.js');
const GameLoop = require('./framework/game-loop.js');
const Resources = require('./framework/resource-loader.js');

const WX = require('./platform/wx-adapter.js');
const Cloud = require('./platform/cloud.js');
const Auth = require('./platform/auth.js');
const Share = require('./platform/share.js');
const Ad = require('./platform/ad.js');
const Lifecycle = require('./platform/lifecycle.js');
const Analytics = require('./platform/analytics.js');

/** 触摸事件绑定:把 clientX/Y 换算成设计坐标后交给当前场景 */
function bindTouch() {
  wx.onTouchStart((e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    SceneManager.touch('start', screen.touchToDesign(t.clientX, t.clientY));
  });
  wx.onTouchMove((e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    SceneManager.touch('move', screen.touchToDesign(t.clientX, t.clientY));
  });
  wx.onTouchEnd((e) => {
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t) return;
    SceneManager.touch('end', screen.touchToDesign(t.clientX, t.clientY));
  });
  wx.onTouchCancel(() => SceneManager.touch('end', { x: -1, y: -1 }));
}

/** 启动时能立刻画的加载页(纯 Canvas 绘制,零图片依赖) */
function drawBootScreen(progress) {
  const ctx = screen.ctx;
  const ui = require('./framework/ui.js');
  // 启动页是玩家看到的第一帧,背景与后面所有页面保持同一道渐变
  ui.bg(ctx, screen.width, screen.height);

  const cx = screen.width / 2;

  // 标题
  ui.text(ctx, cfg.GAME_NAME, cx, screen.height * 0.42, {
    size: 64, color: '#ffffff', align: 'center', weight: 'bold',
  });
  ui.text(ctx, '正在准备资源…', cx, screen.height * 0.42 + 62, {
    size: 26, color: 'rgba(255,255,255,0.5)', align: 'center',
  });

  // 进度条
  ui.progress(ctx, {
    x: cx - 180, y: screen.height * 0.62, w: 360, h: 12,
    value: progress || 0, color: '#07c160',
  });
}

/** 主循环的更新与渲染入口 */
function startLoop() {
  GameLoop.start(
    (dt) => SceneManager.update(dt),
    (alpha) => SceneManager.render(alpha, screen.ctx)
  );
}

/** 生命周期与主循环的联动:切后台必须暂停 */
function wireLifecycle() {
  EventBus.on('game:hide', () => {
    GameLoop.pause();
    WX.setKeepScreenOn(false);
  });
  EventBus.on('game:show', (opts) => {
    GameLoop.resume();
    Share.captureShareTicket(opts);        // 记录群分享来源
    // 回前台时补报离线期间积压的数据
    Cloud.flushQueue();
  });
  EventBus.on('game:memory-warning', () => {
    // 内存告警时释放非首屏资源,防止闪退
    Resources.releaseAll();
    WX.triggerGC();
  });
}

async function bootstrap() {
  Logger.setPrefix('MG');
  Logger.log('bootstrap start');

  // 1. 画布与适配(必须最先)
  screen.init();
  drawBootScreen(0);

  // 2. 触摸与生命周期(尽早绑定,避免启动期间的输入丢失)
  bindTouch();
  Lifecycle.init({
    onHide: () => WX.setKeepScreenOn(false),
  });
  wireLifecycle();

  // 3. 云环境 + 埋点
  await Cloud.init();
  Analytics.init();
  Analytics.track('launch', { env: cfg.CLOUD_ENV });

  // 4. 补报上次失败的上报(不阻塞)
  Cloud.flushQueue();

  // 5. 场景与分享注册
  Share.init();

  /* 广告实例:未开通(ENABLE_AD=false 或没填广告位 ID)时它自己静默返回 false,
   * 事件里不会多出任何入口 —— 这也是"代码先写好、上线后再开"能成立的原因。 */
  Ad.initRewarded();

  startLoop();

  // 6. 进入启动场景:由 BootScene 负责登录 + 资源预加载 + 切主页
  SceneManager.replace('Boot', {
    onProgress: (p) => drawBootScreen(p),
  });

  Logger.log('bootstrap done');
}

// 兜底:任何启动期异常都不能白屏,给出可读提示并尝试继续
try {
  bootstrap();
} catch (e) {
  Logger.error('bootstrap fatal:', e);
  try {
    drawBootScreen(0);
    require('./framework/ui.js').text(screen.ctx, '启动失败,请重试', screen.width / 2,
      screen.height / 2, { size: 32, color: '#e5484d', align: 'center' });
  } catch (e2) { /* ignore */ }
}

module.exports = { bootstrap };
