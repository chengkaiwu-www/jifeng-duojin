/**
 * framework/event-bus.js —— 极简事件总线
 *
 * 作用:解耦"平台层事件"(如 onHide、登录成功)与"玩法层消费者"。
 * 玩法代码不需要知道 wx 的存在,只订阅语义化事件即可。
 *
 * 用法:
 *   EventBus.on('game:hide', fn);
 *   EventBus.emit('game:hide');
 */
const Logger = require('../utils/logger.js');

const handlers = Object.create(null);

function listOf(event) {
  if (!handlers[event]) handlers[event] = [];
  return handlers[event];
}

module.exports = {
  /** 订阅,返回取消订阅函数 */
  on(event, fn) {
    listOf(event).push(fn);
    return () => module.exports.off(event, fn);
  },

  /** 只触发一次 */
  once(event, fn) {
    const wrapped = function () {
      module.exports.off(event, wrapped);
      fn.apply(null, arguments);
    };
    return module.exports.on(event, wrapped);
  },

  off(event, fn) {
    const list = handlers[event];
    if (!list) return;
    if (!fn) { delete handlers[event]; return; }
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },

  /**
   * 触发事件。
   * 注意:handler 内部抛错不能影响其他监听者,否则一次异常会拖垮整条广播链。
   */
  emit(event) {
    const list = handlers[event];
    if (!list || !list.length) return;
    const args = Array.prototype.slice.call(arguments, 1);
    for (let i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args);
      } catch (e) {
        Logger.error('EventBus handler error on "' + event + '":', e);
      }
    }
  },

  clear() {
    Object.keys(handlers).forEach((k) => delete handlers[k]);
  },
};
