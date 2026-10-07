/**
 * framework/screen.js —— 屏幕适配与坐标换算
 *
 * 设计思想:
 *   1. 画布后备存储按物理像素设置(canvas.width = 逻辑宽 × dpr),保证清晰度;
 *   2. 一次性对上下文做 ctx.scale(dpr × scale),之后所有绘制代码都直接用
 *      "设计坐标系"(宽度固定 750)写坐标,不需要到处乘系数;
 *   3. 触摸坐标反向换算回设计坐标系,保证"点哪打哪"。
 *
 * 这样写的收益:美术按 750 宽出图,程序按 750 宽写坐标,任何机型上视觉比例一致。
 */
const cfg = require('../config/config.js');
const Logger = require('../utils/logger.js');

let canvas = null;
let ctx = null;
let dpr = 1;
let scale = 1;        // 设计坐标 → 逻辑坐标 的缩放系数
let viewW = cfg.DESIGN_WIDTH;   // 设计坐标下的可视宽度(恒为 750)
let viewH = 0;                  // 设计坐标下的可视高度(随机型变化,用于全屏布局)
let safeTop = 0;                // 设计坐标下的顶部安全区(刘海屏)
let safeBottom = 0;             // 设计坐标下的底部安全区

/** 兜底:老版本基础库用 getSystemInfoSync,新版本优先用 getWindowInfo */
function readWindowInfo() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const w = wx.getWindowInfo();
      return {
        screenWidth: w.screenWidth,
        screenHeight: w.screenHeight,
        pixelRatio: w.pixelRatio,
        safeArea: w.safeArea,
        windowHeight: w.windowHeight,
      };
    }
  } catch (e) { /* 降级 */ }
  const s = wx.getSystemInfoSync();
  return {
    screenWidth: s.screenWidth,
    screenHeight: s.screenHeight,
    pixelRatio: s.pixelRatio,
    safeArea: s.safeArea,
    windowHeight: s.windowHeight,
  };
}

module.exports = {
  /** 初始化:必须在使用任何绘图 API 之前调用 */
  init() {
    const info = readWindowInfo();
    dpr = info.pixelRatio || 1;

    // 第一次调用 wx.createCanvas() 得到的是"上屏画布"
    canvas = wx.createCanvas();
    canvas.width = info.screenWidth * dpr;
    canvas.height = info.screenHeight * dpr;

    ctx = canvas.getContext('2d');
    scale = info.screenWidth / cfg.DESIGN_WIDTH;
    ctx.scale(dpr * scale, dpr * scale);

    viewW = cfg.DESIGN_WIDTH;
    viewH = canvas.height / (dpr * scale);

    if (info.safeArea) {
      safeTop = info.safeArea.top * dpr / (dpr * scale);
      safeBottom = Math.max(0, (info.screenHeight - info.safeArea.bottom)) * dpr / (dpr * scale);
    }

    Logger.log('screen ready: dpr=' + dpr + ' scale=' + scale.toFixed(3) +
      ' design=' + viewW + 'x' + Math.round(viewH));
    return module.exports;
  },

  get canvas() { return canvas; },
  get ctx() { return ctx; },
  get dpr() { return dpr; },
  get scale() { return scale; },
  get width() { return viewW; },
  get height() { return viewH; },
  get safeTop() { return safeTop; },
  get safeBottom() { return safeBottom; },

  /**
   * 触摸坐标 → 设计坐标
   * @param {number} clientX 事件里的 clientX(逻辑像素)
   */
  touchToDesign(clientX, clientY) {
    return { x: clientX / scale, y: clientY / scale };
  },

  /** 清屏。每帧 render 开始时调用 */
  clear(color) {
    ctx.fillStyle = color || '#111418';
    ctx.fillRect(0, 0, viewW, viewH);
  },
};
