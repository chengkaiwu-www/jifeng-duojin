/**
 * utils/logger.js —— 统一日志
 *
 * 上线版本务必让 DEBUG=false,小游戏日志输出会占用主线程并影响性能。
 */
const cfg = require('../config/config.js');

let prefix = '[MG]';

function fmt(args) {
  return [prefix].concat(Array.prototype.slice.call(args));
}

module.exports = {
  setPrefix(p) { prefix = '[' + p + ']'; },
  log() { if (cfg.DEBUG) console.log.apply(console, fmt(arguments)); },
  info() { if (cfg.DEBUG) console.info.apply(console, fmt(arguments)); },
  warn() { console.warn.apply(console, fmt(arguments)); },  // 警告始终输出,便于真机排查
  error() { console.error.apply(console, fmt(arguments)); },
};
