/**
 * framework/scene-manager.js —— 场景栈
 *
 * 小游戏没有"页面栈"这个概念,必须自建。
 * 场景基类约定(实现任一即为合法场景):
 *   onEnter(params)              进入场景(做初始化、发起数据请求)
 *   onUpdate(dt)                 固定步长逻辑
 *   onRender(alpha, ctx)         渲染
 *   onTouchStart(p) / onTouchMove(p) / onTouchEnd(p)   触摸(p 为设计坐标)
 *   onExit()                     离开场景(释放资源、取消订阅)
 *   onDestroy()                  被替换并销毁
 *
 * 采用"栈 + 全屏切换"模型:push/replace/pop 足够覆盖小游戏的所有导航需求。
 */
const EventBus = require('./event-bus.js');
const Logger = require('../utils/logger.js');

const stack = [];
let destroying = false;

function call(scene, method, args) {
  if (!scene || typeof scene[method] !== 'function') return;
  try {
    scene[method].apply(scene, args || []);
  } catch (e) {
    Logger.error('scene.' + method + ' error:', e);
  }
}

module.exports = {
  /** 用新场景替换当前场景(最常用,如 主页 → 玩法) */
  replace(name, params) {
    const next = module.exports.create(name);
    const cur = module.exports.current();
    if (cur) {
      call(cur, 'onExit');
      if (!stack.length || stack[stack.length - 1] !== cur) {
        // cur 已不在栈顶,无需出栈
      } else {
        stack.pop();
        call(cur, 'onDestroy');
      }
    }
    stack.push(next);
    call(next, 'onEnter', [params || {}]);
    EventBus.emit('scene:changed', name);
    return next;
  },

  /** 压栈:用于"玩法 → 结算弹层"这类需要保留底层的场景 */
  push(name, params) {
    const next = module.exports.create(name);
    const cur = module.exports.current();
    if (cur) call(cur, 'onPause');
    stack.push(next);
    call(next, 'onEnter', [params || {}]);
    EventBus.emit('scene:changed', name);
    return next;
  },

  /** 出栈:回到上一层 */
  pop(params) {
    const cur = module.exports.current();
    if (!cur || stack.length <= 1) return null;
    call(cur, 'onExit');
    stack.pop();
    call(cur, 'onDestroy');
    const prev = module.exports.current();
    call(prev, 'onResume', [params || {}]);
    EventBus.emit('scene:changed', prev && prev.name);
    return prev;
  },

  current() {
    return stack.length ? stack[stack.length - 1] : null;
  },

  /** 清空栈(如 重开游戏) */
  clear() {
    while (stack.length) {
      const s = stack.pop();
      call(s, 'onExit');
      call(s, 'onDestroy');
    }
  },

  /**
   * 场景工厂:新增场景只需在这里注册一行。
   * 延迟 require 的好处:未进入的场景不会在启动时执行,减少首屏耗时。
   */
  create(name) {
    let scene;
    switch (name) {
      case 'Boot': scene = require('../scenes/boot-scene.js'); break;
      case 'Home': scene = require('../scenes/home-scene.js'); break;
      case 'Game': scene = require('../scenes/game-scene.js'); break;
      case 'Rank': scene = require('../scenes/rank-scene.js'); break;
      case 'Shop': scene = require('../scenes/shop-scene.js'); break;
      case 'Signin': scene = require('../scenes/signin-scene.js'); break;
      default:
        Logger.error('unknown scene:', name);
        scene = require('../scenes/home-scene.js');
    }
    // 提供默认 name,便于日志定位
    if (!scene.name) scene.name = name;
    return scene;
  },

  /** 由 main.js 注册到主循环 */
  update(dt) {
    if (destroying) return;
    call(module.exports.current(), 'onUpdate', [dt]);
  },

  render(alpha, ctx) {
    if (destroying) return;
    call(module.exports.current(), 'onRender', [alpha, ctx]);
  },

  touch(type, p) {
    const cur = module.exports.current();
    const method = type === 'start' ? 'onTouchStart'
      : type === 'move' ? 'onTouchMove'
        : type === 'end' ? 'onTouchEnd' : null;
    if (method) call(cur, method, [p]);
  },
};
