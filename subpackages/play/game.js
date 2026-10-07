/**
 * subpackages/play/game.js —— 分包「play」的入口文件
 *
 * ★ 微信小游戏的硬性约定：subpackages[].root 指向的目录，**根目录下必须有 game.js**，
 *   它就是该分包的入口。缺了它会直接编译失败，报错原文：
 *     Error: game.json: 未找到 ["subpackages"][0]["root"] 对应的 /subpackages/play/game.js 文件
 *   （官方文档「分包加载」原文：root「可以指定一个目录，目录根目录下的 game.js 会作为入口文件」。）
 *
 * 本分包目前承载「关卡 / 主题配置」（见 ./index.js），属于"玩起来之后才需要"的数据，
 * 放进分包可以让主包更小（主包硬上限 4MB，分包单个不限、主包+分包合计 ≤ 30MB）。
 *
 * 接入方式（主包内按需使用，**务必先加载再 require**，顺序颠倒会报"模块不存在"）：
 *   1) await Resources.loadSubpackage('play');          // 下载并执行分包入口
 *   2) const play = require('<相对调用方的路径>/subpackages/play/game.js');
 *
 * 低版本兼容（基础库 < 2.1.0 无 wx.loadSubpackage）：直接 require 本入口文件即可触发加载，
 *   即 require('<路径>/subpackages/play/game.js')。
 */
module.exports = require('./index.js');
