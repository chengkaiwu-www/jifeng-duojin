/**
 * subpackages/play/index.js —— 分包示例
 *
 * 分包的价值:小游戏主包上限只有 4MB,用户点开就要下载。
 * 把"玩起来之后才需要"的资源/代码放分包,首屏体积就能压下来。
 *
 * 用法:
 *   1. game.json 中声明(本项目已声明 name: 'play', root: 'subpackages/play/');
 *   2. 进入玩法前先加载,再从主包代码里 require **分包入口** ./game.js
 *      —— 路径必须以"调用方文件所在目录"为基准:
 *        await ResourceLoader.loadSubpackage('play');
 *        const play = require('../subpackages/play/game.js');   // 若调用方在 js/ 目录下
 *
 * 注意:分包代码在 loadSubpackage 成功之前不能被 require,否则会报模块不存在。
 *      所以务必先 await 加载再 require;且相对路径写错是最常见的报错原因。
 *      ★ 入口必须是 ./game.js(不是本文件)—— 官方要求分包 root 目录根下必须有 game.js。
 */

/**
 * 关卡(主题)配置 —— 真实项目里这里通常是几十上百关的数据,体积大,适合放分包。
 * speedScale 与 config.GAME 的难度曲线相乘,实现"同一套规则、不同难度主题"。
 */
const LEVELS = [
  { id: 1, name: '夜行', bg: '#141a22', obstacle: '#e5484d', speedScale: 1.00, unlockScore: 0 },
  { id: 2, name: '霓虹', bg: '#0f1620', obstacle: '#ff7a45', speedScale: 1.12, unlockScore: 200 },
  { id: 3, name: '熔岩', bg: '#1c1210', obstacle: '#ffb020', speedScale: 1.25, unlockScore: 500 },
  { id: 4, name: '虚空', bg: '#0b0d14', obstacle: '#7c5cff', speedScale: 1.40, unlockScore: 1000 },
];

module.exports = {
  LOADED: true,
  levels: LEVELS,

  getLevel(id) {
    for (let i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].id === id) return LEVELS[i];
    }
    return LEVELS[0];
  },
};
