/**
 * scenes/game-scene.js —— 玩法场景 · 竖版躲障跑酷
 *
 * 玩法:单指左右拖动,「红色的躲,金色的抢,边缘的险」。
 *   · 红色障碍 —— 躲开。撞到扣 1 条命并短暂无敌。
 *   · 金色能量块 —— 主动撞上去。命未满回 1 条命(本局上限 2 次),命满则 +8 分。
 *      它有 55% 的概率贴着红块生成,想拿就得往危险边上靠。
 *   · 擦身而过 —— 贴着红块边缘掠过 +2 分(每个红块最多一次)。
 *   分数 = 存活秒数 × 10 + 躲避次数 × 5 + 擦身次数 × 2 + 命满时的拾取加分
 *
 * 关于"留人"的设计,分三层(这一层负责前两层):
 *   ① 单局层 —— 重开摩擦 / 近失提示 / 即时反馈
 *      · 重开摩擦:结算后点击面板上半区任意位置直接重开,死亡后 0.9 秒解锁。
 *      · 近失提示:差一点点破纪录时,结算面板直接说"就差 N 分"。
 *      · 即时反馈:擦身 / 拾取都有飘字,让每一局从第 1 秒起就"有事发生"。
 *   ② 跨局层 —— 结算时把本局并进生涯统计,并**当场告诉玩家攒到了什么**
 *      · 结算面板固定三行:局内金币 / 新成就及其奖励金币 / "再攒多少就能买下一款"
 *        这是"再来一局"最有效的钩子,也是金币经济唯一的露出位置
 *      · 目标只有在被看见时才有驱动力 —— 这三行比分数本身更重要
 *   ③ 回访层 —— 不在本文件(见 home-scene 的签到与每日目标)
 *
 * 职责边界(这是本文件最重要的约定):
 *   本文件只做三件事 —— 渲染世界状态、把触摸转成输入、驱动结算闭环。
 *   **所有玩法规则都在 js/gameplay/rules.js 里**,本文件不写任何计分/碰撞逻辑。
 *   生涯统计在 gameplay/career.js,造型与成就的定义在 gameplay/skins.js 与 achievements.js。
 *   改玩法只改 rules.js;改画面只改本文件。
 *
 * ────────────────────────────────────────────────────────────────
 * 玩法模式与特效(本轮新增)
 *
 *   模式:本文件**不定义任何模式**。模式是 gameplay/modes.js 里的纯数据,
 *        这里只做三件事 —— 进场景时决议当前模式、把模式传给 rules.js 建世界、
 *        把模式的差异(限时/配色/规则文案)画出来。
 *        所以"加第五个模式"在这里的成本是**零行代码**。
 *
 *   特效:全部走 framework/effects.js 的粒子池,本文件只负责"什么时候放"。
 *        ⚠️ 特效**只读不写** —— 它永远不改 world 里的任何数字。
 *           一旦特效开始影响判定,"看起来躲开了"和"真的躲开了"就会分家。
 * ────────────────────────────────────────────────────────────────
 */
const cfg = require('../config/config.js');
const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');
const Storage = require('../framework/storage.js');
const Effects = require('../framework/effects.js');
const Rules = require('../gameplay/rules.js');
const Modes = require('../gameplay/modes.js');
const Career = require('../gameplay/career.js');
const Skins = require('../gameplay/skins.js');
const Achievements = require('../gameplay/achievements.js');
const Dates = require('../utils/date.js');

const Cloud = require('../platform/cloud.js');
const Share = require('../platform/share.js');
const Ad = require('../platform/ad.js');
const Analytics = require('../platform/analytics.js');
const WX = require('../platform/wx-adapter.js');

/* DYING = 命归零、正在问"要不要看视频续一命"的**冻结态**。
 * 它必须是一个独立状态,不能在 OVER 里做 —— 因为 endGame() 会写存档、发金币、
 * 判成就、上报分数,全是不可逆的;复活要在这些发生**之前**拦截。 */
const STATE = { READY: 'ready', PLAYING: 'playing', DYING: 'dying', OVER: 'over' };

/* ---------- 场景状态(纯展示用,玩法状态在世界对象里) ---------- */
let state = STATE.READY;
let world = null;
let buttons = [];
let submitStatus = '';
let rankInfo = null;
let dragging = false;
let hitFlash = 0;          // 受击红闪
let dodgePulse = 0;        // 躲避成功的高亮脉冲
let pickPulse = 0;         // 拾取能量块的高亮脉冲
let grazePulse = 0;        // 擦身而过的高亮脉冲(整屏金边闪一下)

/* ---------- 玩法模式(本轮新增) ---------- */
let mode = null;           // Modes.resolve(archive.mode) 的结果:本局跑哪套参数
let bannerTimer = 0;       // 开局模式横幅的剩余时间(秒),纯展示
let ambientT = 0;          // 环境粒子相位(累计时间)。环境层是纯函数,不占粒子池
let runBest = 0;           // 本模式的历史最高分(开局快照,结算时用来判断"破纪录")
let modeRecord = false;    // 本局是否刷新了本模式纪录
let modeRuleText = '';     // READY 面板上本模式的规则速览(由 buildRuleText 生成)
let readyLayout = null;    // READY 面板的折行结果与卡片高度(见 buildReadyLayout)

/* ---------- 造型与跨局成长 ---------- */
let equippedSkin = null;   // 本局使用的造型(进场景时读一次,局内不变)
let trailPoints = [];      // 拖尾残影(仅"带拖尾"的造型用),纯视觉

/* 本局结算产生的成长信息 —— 只在结算面板上显示一次,所以用场景局部变量而不是存档。
 * ⚠️ 金币分成两笔,故意分开显示:
 *    coinsGained 是"这一局打得怎么样"换来的,achBonus 是"你达成了某个里程碑"换来的。
 *    合成一个数字会丢掉"打得好=赚得快"这个信息,而它正是技巧驱动的兑现方式。 */
let coinsGained = 0;       // 本局靠局内表现赚到的金币
let achBonus = 0;          // 本局新达成成就额外发的金币
let unlockedAch = [];      // 本局新达成的成就
let goalHint = null;       // 下一款该买的造型({skin, progress})

/* 飘字反馈:把"刚刚发生了什么好事"在画面里说出来。
 * 躲障类游戏的正反馈本来就很稀疏(躲开是"没坏事"),不给即时反馈的话,
 * 玩家的体感就是"一直在等难度涨上来"。 */
let floaters = [];         // { x, y, text, color, life }

/* 重开摩擦是这一类游戏留存的第一杠杆:
 * 从"死"到"下一局开始"多一次点击、多一个判断,乘上几十局就是巨大的流失。
 * overAt 记录结束时刻,死亡后 0.9 秒内不响应点击 —— 玩家手指通常还在屏幕上。 */
let overAt = 0;
let restartZoneBottom = 0; // 结算面板里"点击即重开"区域的下边界(按钮区以上)
let pressInRestartZone = false;  // 本次按下的起点是否落在重开区内(防止从按钮上滑出去被误判)
const RESTART_LOCK_MS = 900;

/* ---- 广告(激励视频)状态。ENABLE_AD 关闭时这三项永远是初值,不产生任何分支 ---- */
let reviveUsed = 0;        // 本局已用掉的"看视频复活"次数(上限 cfg.AD.REVIVE_PER_RUN)
let reviveDeadline = 0;    // 复活询问的截止时刻(Date.now() 毫秒);0 = 当前不在询问中
let coinsDoubled = false;  // 本局结算是否已用过"看视频金币翻倍"(一局只给一次)

/* ---------- 布局参数(设计坐标,宽度 750) ---------- */
function groundY() {
  return screen.height - 300 - screen.safeBottom;
}

function buildWorld() {
  return Rules.createWorld({
    width: screen.width,
    height: screen.height,
    groundY: groundY(),
  }, mode);
}

/**
 * READY 面板上的规则速览 —— 由**本模式实际生效的参数**生成,而不是写死的文案。
 * 这样加一个模式、改一个数值,面板上的字自动跟着变,不会出现
 * "界面写着 2 条命、实际跑 3 条命"这种只有真机上才发现的错。
 */
function buildRuleText() {
  const P = mode.params;
  const lines = [];

  // 第 1 行:本模式**独有的机制**。机制优先于数值 ——
  // 玩家记不住"速度 520、生成间隔 0.72",但一定记得住"红块会摆""金块会跑"。
  if (mode.sway > 0) {
    lines.push('★ 红块边走边左右摆动 —— 看清波形再动,站定必被扫到');
  } else if (mode.drift > 0) {
    lines.push('★ 金块会横向游走,连击越高跑得越快 —— 站着不动,一个也拿不到');
  } else if (mode.laneSway > 0) {
    lines.push('★ 限时 ' + mode.timeLimit + ' 秒,活动走廊一边收窄一边左右摇摆');
  } else if (mode.combo) {
    lines.push('★ 连着拾取金块,倍率最高 ×' + P.COMBO_MAX + ' —— 被撞一下立刻归零');
  } else if (mode.timeLimit > 0) {
    lines.push('★ 限时 ' + mode.timeLimit + ' 秒,活动空间同时收窄到 '
      + Math.round((P.LANE_MIN_RATIO || 1) * 100) + '%');
  }

  // 第 2 行:一句话定位(每个模式都有,包括不开任何机制的经典)
  lines.push(mode.hint);

  // 后两行:所有模式共通的要素,数值同样取自实际生效的参数
  lines.push('金块回命(上限 ' + P.MAX_HEALS + ' 次),命满则 +' + P.PICKUP_SCORE + ' 分');
  lines.push('贴边掠过「险 +' + P.GRAZE_SCORE + '」· 判定窗口 ' + P.GRAZE_DISTANCE);
  return lines;
}

/**
 * READY 面板的排版 —— **先量后画**。
 *
 * ⚠️ 这里原来是"卡片高度 = 330 + 行数 × 46",而行数取的是 `modeRuleText.length`。
 *    那只是**逻辑行数**:文字一旦比卡片宽,它就什么都不知道了。
 *    金潮的规则行有 35 个字符,25px 下约 870px,而卡片只有 632px ——
 *    真机上左右各溢出一百多像素,玩家看到的是被卡片边缘切掉两端的半行字。
 *    所以:规则行与定位语一律**按内容宽折行**,卡片高度再由折行后的
 *    **实测行数**决定。逻辑行数与屏幕行数从此不再是一回事。
 *
 * 折行要逐字量宽,所以只算一次(进场景后第一帧),不在每帧里重算。
 */
function buildReadyLayout(ctx) {
  const cardW = 632;
  const innerW = cardW - 88;                 // 与分隔线同宽 —— 文字的硬边界
  const RULE_LH = 42;                        // 规则行行距(折行后比 46 紧凑一点)

  const descRows = ui.wrapText(ctx, mode.desc, innerW, 24);
  const rows = [];
  for (let i = 0; i < modeRuleText.length; i++) {
    /* 行首那枚小圆点占的位置要预留出来,否则第一行的字会顶到圆点上 */
    const segs = ui.wrapText(ctx, modeRuleText[i], innerW - 26, 25);
    for (let k = 0; k < segs.length; k++) {
      rows.push({
        text: segs[k],
        head: i === 0,                       // 本模式的独有机制(用主题色强调)
        top: k === 0,                        // 这条规则的第一段 —— 只有它画圆点
        h: RULE_LH + (k === 0 && i > 0 ? 10 : 0),   // 规则之间多留一点,读得出分界
      });
    }
  }

  const head = 60 + 48 + (mode.mechanic ? 42 : 0) + 26 + descRows.length * 34 + 34 + 36;
  const foot = 34 + 42 + 46;                 // 分隔线 + 操作药丸 + 底部留白
  let h = 0;
  for (let i = 0; i < rows.length; i++) h += rows[i].h;
  return { cardW: cardW, innerW: innerW, descRows: descRows, rows: rows, cardH: head + h + foot };
}

/* ---------- 场景局部状态的重置 ---------- */

/** 清零一局的成长结算信息(开局与进场景时都要调,否则会上局残留) */
function resetRunGrowth() {
  coinsGained = 0;
  achBonus = 0;
  unlockedAch = [];
  goalHint = null;
  // 复活与翻倍都是**每局一次**的东西,结算与开局都要清零,否则会跨局残留
  reviveUsed = 0;
  reviveDeadline = 0;
  coinsDoubled = false;
}

/** 当前造型的拖尾形态 —— 已是字符串('none' 之外见 skins.js 的 TRAILS) */
function trailType() {
  const t = equippedSkin && equippedSkin.style ? equippedSkin.style.trail : 'none';
  return (typeof t === 'string' && t !== 'none') ? t : 'none';
}

/** 拖尾:记录最近几帧的位置并让它自然消失 */
function updateTrail(dt) {
  if (trailType() === 'none') {
    if (trailPoints.length) trailPoints.length = 0;
    return;
  }
  if (state === STATE.PLAYING) {
    trailPoints.push({ x: world.player.x, y: world.player.y, life: 1 });
    if (trailPoints.length > 8) trailPoints.shift();
  }
  for (let i = trailPoints.length - 1; i >= 0; i--) {
    trailPoints[i].life -= dt * 3.2;
    if (trailPoints[i].life <= 0) trailPoints.splice(i, 1);
  }
}

/* ============ 广告(激励视频)============
 *
 * 两个入口都**只在真的能播广告时才出现**(`Ad.isAvailable()`)。
 * 开关打开但广告位 ID 还没填时按钮不出现 —— 让玩家点到一个只能弹出
 * 「暂无广告」的按钮,比不放按钮更伤:他付出了一次期待,收回来的却是空。
 *
 * 合规(与 platform/ad.js 的注释是同一套,这里再钉一遍):
 *   - 激励视频**必须由玩家主动点击**触发,禁止自动播放;
 *   - 禁止"不看完就不让继续" ⇒ 所以「放弃」永远是可选项;
 *   - 奖励发放要在服务端幂等(见 cloudfunctions/submitScore 的做法)。
 */

/** 这一局还能不能提供复活? */
function canOfferRevive() {
  if (!Ad.isAvailable()) return false;
  if (reviveUsed >= cfg.AD.REVIVE_PER_RUN) return false;
  /* 死线模式不给复活:它是 60 秒限时结算,输赢由**时间**决定而不是命数。
   * 时间不会因为你看了一段广告就往回走,所以复活在这里没有语义。 */
  if (mode.timeLimit > 0) return false;
  return true;
}

/** 命归零时的岔路口:能问就问一次,否则直接进结算 */
function requestReviveOrEnd() {
  if (!canOfferRevive()) {
    endGame();
    return;
  }
  state = STATE.DYING;
  reviveDeadline = Date.now() + cfg.AD.ASK_SECONDS * 1000;
  buildDyingButtons();
  Analytics.track('revive_offer', { mode: mode.id, score: Rules.finalScore(world) });
}

/** 复活:回 1 命 + 一段无敌 + 清出落脚点,然后回到 PLAYING */
function revivePlayer() {
  reviveUsed += 1;
  state = STATE.PLAYING;
  reviveDeadline = 0;
  buttons = [];

  /* 只回 1 命而不是回满:回满会让"续一次"过于廉价,
   * 玩家会把它当成常规流程,而不是"我决定再赌一把"。 */
  world.lives = 1;
  world.over = false;
  world.shake = 0;
  world.invincible = Math.max(world.invincible, cfg.AD.REVIVE_INVINCIBLE);

  /* 清掉玩家上方即将撞到的**红块**,但**保留金块** ——
   * 复活后立刻有东西可抢,场面是"重新开局",不是"空场"。 */
  const yTop = world.player.y - cfg.AD.REVIVE_CLEAR_Y;
  for (let i = world.obstacles.length - 1; i >= 0; i--) {
    const ob = world.obstacles[i];
    if (ob.kind !== 'pickup' && ob.y > yTop && ob.y < world.player.y + 60) {
      world.obstacles.splice(i, 1);
    }
  }

  // 复活点必须看得见:一圈绿色冲击波 + 上升粒子(与被撞的红色爆开明确区分)
  Effects.ring(world.player.x, world.player.y, {
    color: ui.COLORS.brand, size: 24, grow: 780, width: 12, life: 0.5,
  });
  Effects.burst(world.player.x, world.player.y, {
    count: 18, colors: [ui.COLORS.brand, ui.COLORS.brandLight],
    speed: 420, size: 10, life: 0.55, grav: -80,
  });
  addFloater(world.player.x, world.player.y - 120, '复活!', ui.COLORS.brand);
  WX.vibrateShort();
  Analytics.track('revive_success', { mode: mode.id, elapsed: Math.floor(world.elapsed) });
}

/** 放弃复活 / 倒计时走完 —— 走到这里才是真的结束 */
function confirmDeath() {
  reviveDeadline = 0;
  endGame();
}

/** 结算面板的「看视频,金币翻倍」 */
function doubleCoinsByAd() {
  if (coinsDoubled || coinsGained <= 0) return;

  Ad.showRewarded().then((r) => {
    if (!r.completed) {
      /* "无填充"不是玩家的错,别把锅扣在他头上 —— 两种失败要分开说。
       * 而且这里**不结束结算**,只给提示:玩家想再试还可以再点。 */
      WX.showToast(r.reason === 'not_configured' ? '暂无可用广告' : '看完广告才能翻倍');
      Analytics.track('ad_double_fail', { reason: r.reason || 'not_completed' });
      return;
    }

    coinsDoubled = true;
    const a = Storage.loadArchive();
    a.coins += coinsGained;          // 再给一份 = 翻倍
    Storage.saveArchive(a);

    /* 目标提示必须跟着重算 —— 它写的是"再攒多少就能买"。
     * 不重算的话,金币明明涨了,那句提示还停在翻倍前,读起来就像没生效。 */
    goalHint = Skins.nextGoal(a.coins, a.ownedSkins);

    WX.showToast('金币翻倍 +' + coinsGained);
    Analytics.track('ad_double_coins', { mode: mode.id, coins: coinsGained });
    buildOverButtons();              // 用完即撤,防止重复点
  });
}

/* ============ 结算闭环 ============ */

function endGame() {
  state = STATE.OVER;
  overAt = Date.now();

  const duration = Math.max(1, Math.round(world.elapsed));
  const score = Rules.finalScore(world);

  // 本局结算数据 —— 生涯统计与解锁判定的唯一输入。
  // hits 是"被撞到几次",0 次 = 无伤,用于"完美主义"这类成就。
  const run = {
    score: score,
    duration: duration,
    dodged: world.dodged,
    grazed: world.grazed,
    picked: world.picked,
    heals: world.heals,
    hits: world.hits,
  };

  // 1. 并入生涯统计 + 结算金币
  const archive = Storage.loadArchive();

  /* 纪录**按模式分开记**。
   * 跨模式比分数是不公平的:死线模式 60 秒封顶,永远赢不了无限时长的经典。
   * 如果四个模式共用一个 bestScore,那三个模式就永远刷不出"新纪录" ——
   * 玩家做对了一切却得不到任何确认,这正是"没有跨局反馈"的老毛病。
   * 所以:破纪录看 bestByMode,全服榜与分享仍用 bestScore(全模式最高)。 */
  const bestByMode = archive.bestByMode || (archive.bestByMode = {});
  runBest = Number(bestByMode[mode.id] || 0);
  modeRecord = Modes.isBetter(score, runBest);
  if (modeRecord) bestByMode[mode.id] = score;

  if (score > (archive.bestScore || 0)) archive.bestScore = score;
  archive.mode = mode.id;              // 顺手落盘,下次进来还是这个模式
  archive.totalGames = (archive.totalGames || 0) + 1;

  const career = Career.normalize(archive.career);
  const merged = Career.applyRun(career, run);
  archive.career = career;
  archive.coins += merged.coins;
  coinsGained = merged.coins;

  /* 1b. 顺手修一遍拥有列表 —— 老存档可能留着已经删掉的造型 id,
   *     不清掉的话图鉴会数出一堆"幽灵造型",总数还对不上。
   *     ⚠️ 这一步必须排在下面的**收集成就判定之前** ——
   *     "拥有几款"正是那些成就的读数,拿一份没修过的列表去数会数多。 */
  archive.ownedSkins = Skins.repairOwned(archive.ownedSkins);
  if (!Skins.isOwned(Skins.get(archive.equippedSkin), archive.ownedSkins)) {
    archive.equippedSkin = Skins.DEFAULT_SKIN_ID;
  }

  /* 1c. 把"拥有几款造型"同步进生涯 ——
   *     它不由任何一局产生(是商店里发生的事),但收集类成就要读它。
   *     在这里补一句,是为了让**在商店里买的那一款**也能在结算时被算进去。 */
  career.skinsOwned = Skins.countOwned(archive.ownedSkins);

  // 2. 成就判定 + 发奖励金币。必须在 career 更新之后 ——
  //    判定读的就是这一局的累计结果,漏了这一步玩家会"晚一局才拿到奖励"。
  //    成就发的金币是本作"技术 → 收益"的兑现通道:打得越好,造型买得越快。
  unlockedAch = Achievements.evaluate(career, archive.achievements);
  achBonus = Achievements.rewardCoins(unlockedAch);
  archive.coins += achBonus;

  // 3. 算"下一款该买什么":这是结算面板上最有用的一行 ——
  //    "再攒多少就能买"比"你得了多少分"更能驱动下一次点击。
  goalHint = Skins.nextGoal(archive.coins, archive.ownedSkins);

  Storage.saveArchive(archive);

  // 4. 埋点(增长漏斗的关键一环)
  Analytics.track('game_over', {
    mode: mode.id,
    score: score,
    duration: duration,
    dodged: world.dodged,
    grazed: world.grazed,
    picked: world.picked,
    heals: world.heals,
    hits: world.hits,
    timeUp: !!world.timeUp,
    isNewBest: modeRecord,          // 本模式纪录
    prevBest: runBest,              // 本模式原纪录,便于算"提高了多少"
    coins: merged.coins,
    achievementBonus: achBonus,
    unlockedAchievements: unlockedAch.length,
  });

  // 6. 分数上报(失败自动落盘,下次启动补报)。
  //    ⚠️ 必须带上 mode —— 服务端要用**该模式自己的上限**校验。
  //       不带的话,疾风模式的合法高分会被经典模式的 32 分/秒直接拦掉(体验事故)。
  if (score > 0) submitScore({ score: score, duration: duration, mode: mode.id });

  // 7. 上报到开放数据域,好友榜才能读到
  Share.uploadScoreToOpenData(archive.bestScore);

  // 8. 注册本局结果的分享内容
  Share.setShareContent(() => ({
    title: '我在《' + cfg.GAME_NAME + '》' + mode.name + '模式躲了 ' + duration +
      ' 秒拿了 ' + score + ' 分,来挑战我!',
    query: 'from=result&score=' + score + '&mode=' + mode.id,
  }));

  // 9. 破纪录彩带 —— 全程唯一一次"庆祝",值得给足
  if (modeRecord) Effects.confetti({ width: screen.width });

  buildOverButtons();
}

async function submitScore(payload) {
  submitStatus = '成绩上传中…';
  try {
    const data = await Cloud.call('submitScore', payload, { retry: 1, silent: true });
    if (data && data.accepted) {
      // 只有计入全服榜的模式(经典)才拿得到名次;
      // 其余模式服务端会回 scoreboard:false,这里不要塞一个空名次进去。
      rankInfo = data.rank
        ? { rank: data.rank, total: data.total, best: data.best }
        : null;
      submitStatus = '';
      Analytics.track('score_accepted', { rank: data.rank, mode: payload.mode });
    } else {
      submitStatus = '成绩未通过校验';
      Analytics.track('score_rejected', { reason: (data && data.reason) || 'unknown' });
    }
  } catch (e) {
    submitStatus = '成绩已存本地,联网后自动同步';
    Analytics.track('score_offline', {});
  }
}

/* ============ 按钮 ============ */

function buildReadyButtons() {
  const cx = screen.width / 2;
  buttons = [
    ui.button({
      x: cx - 220, y: screen.height - 160 - screen.safeBottom, w: 440, h: 108,
      text: '开 始', fontSize: 40, color: ui.COLORS.brand, pressColor: ui.COLORS.brandDark,
      onClick: () => module.exports.startGame(),
    }),
  ];
}

/** 复活询问的按钮。**「放弃」必须存在** —— 没有它就成了"不看完不让继续",那是违规的 */
function buildDyingButtons() {
  const cx = screen.width / 2;
  const baseY = screen.height - 150 - screen.safeBottom;

  buttons = [
    ui.button({
      x: cx - 220, y: baseY - 152, w: 440, h: 108,
      text: '看视频 · 续一命', fontSize: 36,
      color: ui.COLORS.brand, pressColor: ui.COLORS.brandDark,
      onClick: () => {
        Ad.showRewarded().then((r) => {
          if (r.completed) { revivePlayer(); return; }
          /* 广告拉不到(无填充)不是玩家的错,不能因此直接判他出局。
           * 提示一下、把倒计时重新给满,让他可以再点一次或选放弃 ——
           * 全程「放弃」都在,所以不构成强制观看。 */
          WX.showToast(r.reason === 'not_configured' ? '暂无可用广告' : '看完广告才能复活');
          reviveDeadline = Date.now() + cfg.AD.ASK_SECONDS * 1000;
          Analytics.track('revive_fail', { reason: r.reason || 'not_completed' });
        });
      },
    }),
    ui.button({
      x: cx - 220, y: baseY - 24, w: 440, h: 88,
      text: '放弃 · 看结算', fontSize: 30, color: '#2b3542', pressColor: '#3a4655',
      onClick: () => {
        Analytics.track('revive_decline', { mode: mode.id });
        confirmDeath();
      },
    }),
  ];
}

function buildOverButtons() {
  const cx = screen.width / 2;
  const baseY = screen.height - 150 - screen.safeBottom;

  /* 广告行只在"真的能播 + 本局确实赚到了金币"时占位。
   * ⚠️ 点过之后**仍然占位**,只是变成禁用态 ——
   *    按钮凭空消失会让整块按钮区跳一下,那一下比"多一个灰按钮"难看得多。
   *    (禁用按钮的 hit() 返回 false,所以它不会吞掉重开区的点击,见 ui.js) */
  const showAdRow = Ad.isAvailable() && coinsGained > 0;

  const AD_ROW_H = 88;
  const AD_ROW_GAP = 26;
  const mainTop = baseY - 150 - (showAdRow ? (AD_ROW_H + AD_ROW_GAP) : 0);

  // 按钮区以上全部算"点击即重开"区域。
  // 这样既不用精确点中按钮,又不会和下面的两个按钮抢点击 —— 边界是明确的。
  restartZoneBottom = mainTop - 24;

  buttons = [
    ui.button({
      x: cx - 220, y: mainTop, w: 440, h: 104,
      text: '再 来 一 局', fontSize: 38, color: ui.COLORS.brand, pressColor: ui.COLORS.brandDark,
      onClick: () => module.exports.startGame(),
    }),
  ];

  if (showAdRow) {
    // 深琥珀底 + 金色字:和绿色的「再来一局」明确区分,一眼看出它是"换奖励"而不是"继续"
    buttons.push(ui.button({
      x: cx - 220, y: baseY - 30 - AD_ROW_H - AD_ROW_GAP, w: 440, h: AD_ROW_H,
      text: coinsDoubled ? '金币已翻倍 ×2' : '看视频 · 金币 ×2',
      fontSize: 32,
      color: '#8a5a12', pressColor: '#6f480c',
      textColor: coinsDoubled ? ui.COLORS.textSub : ui.COLORS.goldLight,
      disabled: coinsDoubled,
      onClick: () => module.exports.doubleCoinsByAd(),
    }));
  }

  buttons.push(ui.button({
    x: cx - 220, y: baseY - 30, w: 210, h: 88,
    text: '炫耀一下', fontSize: 30, color: '#2b3542', pressColor: '#3a4655',
    onClick: () => {
      // 分享是可选行为,完成后给一点小奖励(不是"必须分享")
      Share.share({ scene: 'result' }).then((r) => {
        if (r.shared) module.exports.grantShareBonus();
      });
    },
  }));
  buttons.push(ui.button({
    x: cx + 10, y: baseY - 30, w: 210, h: 88,
    text: '排行榜', fontSize: 30, color: '#2b3542', pressColor: '#3a4655',
    onClick: () => SceneManager.replace('Rank'),
  }));
}

/* ============ 飘字反馈 ============ */

function addFloater(x, y, text, color) {
  floaters.push({ x: x, y: y, text: text, color: color, life: 1 });
  if (floaters.length > 12) floaters.shift();   // 兜底:极端情况下也不让数组无限长
}

function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.y -= 68 * dt;
    f.life -= dt * 1.4;
    if (f.life <= 0) floaters.splice(i, 1);
  }
}

function renderFloaters(ctx) {
  for (let i = 0; i < floaters.length; i++) {
    const f = floaters[i];
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life));
    ui.text(ctx, f.text, f.x, f.y, {
      size: 30, color: f.color, align: 'center', weight: 'bold',
    });
    ctx.restore();
  }
}

/* ============ 渲染 ============ */

/**
 * 背景。
 * 三层信息,从上到下依次是"时间 / 模式 / 空间":
 *   ① 环境粒子(模式主题色)—— 无状态的一层,永远在动但不占粒子池
 *   ② 远处光带(随时间由冷转热)—— 保留原有设计,给"越来越快"的心理暗示
 *   ③ 地面线(模式主题色)—— 玩家最容易注意到的一处模式差异
 */
function renderBackground(ctx) {
  const t = world ? Math.min(1, world.elapsed / 45) : 0;
  const mc = mode ? mode.color : ui.COLORS.brand;

  // ① 底色换成一道纵向渐变(原来是纯色)。
  //    纯色在大屏上会显得"平",渐变立刻给出纵深,而成本是 0 ——
  //    渐变对象被 ui.bg 缓存住,每帧只是一次 fillRect。
  ui.bg(ctx, screen.width, screen.height, { tint: mc, grid: false });

  // ② 环境粒子。parallaxX 让它们相对玩家做轻微反向位移 ——
  //    没有视差的话,背景就是一张贴纸,玩家感觉不到自己在"移动"
  Effects.ambient(ctx, {
    width: screen.width,
    height: screen.height,
    t: ambientT,
    color: mc,
    count: 26,
    alpha: 0.20,
    parallaxX: world ? (world.player.x - screen.width / 2) : 0,
  });

  // ③ 远处光带
  ctx.save();
  ctx.globalAlpha = 0.09 + t * 0.1;
  ctx.fillStyle = t > 0.6 ? ui.COLORS.danger : ui.COLORS.accent;
  ctx.fillRect(0, screen.height * 0.16, screen.width, 3);
  ctx.restore();

  // ④ 地面
  ctx.fillStyle = ui.COLORS.panel;
  ctx.fillRect(0, groundY() + 48, screen.width, screen.height - groundY() - 48);
  ui.divider(ctx, 0, groundY() + 48, screen.width, { color: mc, h: 3 });

  // ⑤ 走廊边界 —— 只在"死线"模式真正收窄之后才画。
  //    它是这个模式**唯一的空间提示**:不画出来,玩家只会觉得"怎么越来越挤",
  //    却不知道为什么挤、也不知道还能往哪躲。可见的约束才算约束。
  //    走廊开始摇摆之后,这两条线还会自己移动 —— 空间于是从"背景"变成"要应付的东西"。
  if (world && mode && mode.lane > 0 && world.laneHalf < screen.width / 2 - 1) {
    const l = world.laneCenter - world.laneHalf;
    const r = world.laneCenter + world.laneHalf;
    ctx.save();

    // 走廊之外压暗 —— 像一条被照亮的路,比画两条线更容易读懂
    ctx.fillStyle = 'rgba(4,7,11,0.55)';
    ctx.fillRect(0, 0, l, screen.height);
    ctx.fillRect(r, 0, screen.width - r, screen.height);

    // 墙面拖影:沿走廊**正在移动的反方向**补三道渐淡竖线。
    // 和红块的摆动轨迹带是同一个道理 —— 先让玩家看见"它在往哪走",
    // 才谈得上预判。少了这一层,摇摆只会被读成"画面莫名偏了一点"。
    if (mode.laneSway > 0 && world.laneVX !== 0) {
      const dir = world.laneVX > 0 ? -1 : 1;    // 拖影留在"它刚从那来"的一侧
      ctx.strokeStyle = mc;
      ctx.lineWidth = 3;
      for (let k = 1; k <= 3; k++) {
        ctx.globalAlpha = 0.22 * (4 - k) / 3;
        const off = dir * k * 26;
        ctx.beginPath();
        ctx.moveTo(l + off, 0); ctx.lineTo(l + off, screen.height);
        ctx.moveTo(r + off, 0); ctx.lineTo(r + off, screen.height);
        ctx.stroke();
      }
    }

    // 墙线画在拖影之上
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = mc;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(l, 0); ctx.lineTo(l, screen.height);
    ctx.moveTo(r, 0); ctx.lineTo(r, screen.height);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 拖尾:仅"带拖尾"的造型有,而且按造型的 trail 形态分四种画法。
 *
 * 为什么值得分四种:拖尾是本作**唯一在游玩过程中持续可见**的造型差异 ——
 * 图鉴里看到的是一张静态缩略图,而拖尾是玩家每分钟都在看的。
 * 它同时服务两件事:造型的辨识度,以及"我刚才移动得多快"的体感。
 *
 * 四种形态的共同点是"只读 trailPoints,不改任何状态" —— 纯装饰,不进判定。
 */
function renderTrail(ctx) {
  const type = trailType();
  const n = trailPoints.length;
  if (type === 'none' || n === 0) return;

  // 拖尾只读三样:形状、主色、点缀色。残影副本**不**带发光/光环/星点 ——
  // 拖尾是"运动留下的痕迹",给它再叠一层光效只会糊成一团。
  const sk = Skins.visualOf(equippedSkin);

  /* ---- 残影:同形状的半透明副本,越旧越淡越小 ---- */
  if (type === 'ghost') {
    for (let i = 0; i < n; i++) {
      const t = trailPoints[i];
      const k = (i + 1) / n;                 // 越靠后越新
      const size = 96 * (0.45 + k * 0.4);
      ui.sprite(ctx, {
        x: t.x - size / 2, y: t.y - size / 2, size: size,
        shape: sk.shape, body: sk.body, accent: sk.accent,
        alpha: t.life * 0.16 * k,
      });
    }
    return;
  }

  /* ---- 余烬:小圆点一边变淡一边往下飘 ---- */
  if (type === 'ember') {
    for (let i = 0; i < n; i++) {
      const t = trailPoints[i];
      const k = (i + 1) / n;
      ctx.save();
      ctx.globalAlpha = t.life * 0.5 * k;
      ctx.fillStyle = (i % 2) ? sk.accent : sk.body;
      ctx.beginPath();
      // 横向散开一点、纵向按"越旧掉得越远"堆叠,避免粒子连成一条直线
      ctx.arc(t.x + (i % 3 - 1) * 10, t.y + (n - i) * 8, 4 + k * 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  /* ---- 星点:一串小四角星 ---- */
  if (type === 'star') {
    for (let i = 0; i < n; i++) {
      const t = trailPoints[i];
      const k = (i + 1) / n;
      const size = 11 + k * 24;
      ctx.save();
      ctx.globalAlpha = t.life * 0.72 * k;
      ui.sprite(ctx, {
        x: t.x - size / 2, y: t.y - size / 2, size: size,
        shape: 'star4', body: sk.accent, accent: '#ffffff',
      });
      ctx.restore();
    }
    return;
  }

  /* ---- 绸带:一条逐渐变粗的带子(从最旧画到最新,自然形成渐细) ---- */
  if (type === 'ribbon') {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = sk.accent;
    for (let i = 1; i < n; i++) {
      const a = trailPoints[i - 1];
      const b = trailPoints[i];
      const k = i / n;
      ctx.globalAlpha = a.life * 0.4 * k;
      ctx.lineWidth = 2 + k * 18;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 玩家:造型参数化的形状 + 移动倾斜 + 无敌闪烁 */
function renderPlayer(ctx) {
  const p = world.player;
  // ⚠️ 一律经 Skins.visualOf() 取参数,不要直接读 style ——
  //    稀有度带来的结构性光效(断续描边/呼吸光环/环绕星点)是数据层算的,
  //    直接读 style 就会把它们漏掉,于是"传说款在游戏里和普通款一样"。
  const sk = equippedSkin ? Skins.visualOf(equippedSkin) : null;

  // 无敌期间闪烁(每 0.1 秒切换可见性)
  const blinking = world.invincible > 0 && Math.floor(world.invincible * 10) % 2 === 0;
  if (blinking) return;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.tilt * 0.5);

  // 落地投影
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ui.roundRect(ctx, -p.w / 2 + 6, groundY() - p.y + 46, p.w - 12, 12, 6);
  ctx.fill();

  // 本体:受击瞬间整块闪白,其余时间按造型绘制
  if (hitFlash > 0) {
    ui.roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 22);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  } else if (sk) {
    // spin / halo 都是纯观感:自转不改变包围盒,光环画在形状之外 ——
    // 所以玩家看到的和 rules.js 判定的仍然是同一个尺寸,不会产生误判。
    ui.sprite(ctx, {
      x: -p.w / 2, y: -p.h / 2, size: p.w,
      shape: sk.shape, body: sk.body, accent: sk.accent, glow: sk.glow,
      spin: sk.spin, halo: sk.halo, edge: sk.edge, orbit: sk.orbit,
    });
  } else {
    ui.roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 22);
    ctx.fillStyle = ui.COLORS.brand;
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 红块与金块。
 * 两者在**轮廓**上就区分开(红=方形,金=圆形),这样即使在快速下落、
 * 余光扫过的情况下也不会看错 —— 颜色在深色背景上的辨识度不如形状可靠。
 */
function renderObstacles(ctx) {
  const mc = mode ? mode.color : ui.COLORS.danger;

  for (let i = 0; i < world.obstacles.length; i++) {
    const ob = world.obstacles[i];

    /* ---- 金色能量块:圆形 + 深色十字 ---- */
    if (ob.kind === Rules.KIND.PICKUP) {
      const cx = ob.x + ob.w / 2;
      const cy = ob.y + ob.h / 2;
      const r = ob.w / 2;

      // 外圈淡光环:让金块在深色背景上"浮"起来。
      // 仍然用 alpha 描边近似发光,绝不引入 shadowBlur(逐像素卷积,低端机极贵)。
      ctx.beginPath();
      ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,176,32,0.30)';
      ctx.lineWidth = 5;
      ctx.stroke();

      // 运动残影 —— 金块在横向游走,必须让玩家一眼看出"它往哪跑"。
      // 匀速直线是全作最好读的运动,但前提是玩家看得见方向;
      // 残影间距随当前倍率拉开:连击越高、拖影越长,速度感不用文字就已经在说话。
      // 用**亮一档**的金色而不是本体色:残影是"余晖",亮色 + 低透明度在深底上
      // 更像光迹;顺带也让"这是残影"和"这是金块"在色值上永远分得开。
      if (ob.driftDir) {
        const step = 12 + 8 * ((world.comboMul || 1) - 1);
        ctx.save();
        for (let k = 3; k >= 1; k--) {
          ctx.globalAlpha = 0.05 + 0.05 * (3 - k);
          ctx.beginPath();
          ctx.arc(cx - ob.driftDir * k * step, cy, r - k * 5, 0, Math.PI * 2);
          ctx.fillStyle = ui.COLORS.goldLight;
          ctx.fill();
        }
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = ui.COLORS.gold;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 3;
      ctx.stroke();

      // 十字:两条细圆角矩形,零成本地表达"补给"语义
      const arm = r * 0.5;
      const thick = 11;
      ctx.fillStyle = '#4a2c00';
      ui.roundRect(ctx, cx - arm, cy - thick / 2, arm * 2, thick, thick / 2);
      ctx.fill();
      ui.roundRect(ctx, cx - thick / 2, cy - arm, thick, arm * 2, thick / 2);
      ctx.fill();
      continue;
    }

    /* ---- 红色障碍 ---- */

    // 摆动轨迹带 —— 把这条红块**将来会经过的横向范围**先画出来。
    // 这是"预判"能被学会的前提:玩家必须先看见"它会在这一带来回",
    // 才谈得上去读相位、提前走位。不画轨迹,摆动就只剩一次莫名其妙的横移,
    // 玩家不会学到任何东西,只会觉得"这游戏在耍我"。
    if (ob.swayAmp > 0) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ui.roundRect(ctx, ob.baseX - ob.swayAmp, ob.y + ob.h * 0.3,
        ob.w + ob.swayAmp * 2, ob.h * 0.4, ob.h * 0.2);
      ctx.fillStyle = mc;
      ctx.fill();
      ctx.restore();
    }

    // 用统一的卡片画法:圆角 + 顶部内高光 + 描边 ——
    // 和全作其他所有的"面"共用同一套立体语言,而不是这里一套那里一套。
    ui.card(ctx, {
      x: ob.x, y: ob.y, w: ob.w, h: ob.h, r: 12,
      fill: ui.COLORS.danger,
      stroke: 'rgba(255,255,255,0.20)',
      sheen: true,
    });
  }
}

/**
 * 画一行**居中的「图标 + 文字」**。
 *
 * 结算面板的每一行都是居中的,而"居中 + 图标"比"居中文字"难写:
 * 图标必须先知道文字有多宽,才能把两者当成一个整体摆到正中。
 * 少了这一步,图标会以屏幕中心为锚,而文字以自己为锚 —— 结果就是两者各偏一边。
 *
 * maxW 给了之后,过长的文字会自动降字号(而不是溢出卡片)。
 */
function centeredIconLine(ctx, cx, y, iconName, str, opt) {
  const o = opt || {};
  const iconS = o.iconSize || 26;
  const gap = 12;
  let size = o.size || ui.TYPE.body;

  if (o.maxW) {
    const limit = o.maxW - iconS - gap;
    while (size > 16 && ui.measure(ctx, str, size, o.weight) > limit) size -= 2;
  }

  const tw = ui.measure(ctx, str, size, o.weight);
  const total = iconS + gap + tw;
  const x0 = cx - total / 2;

  ui.icon(ctx, iconName, x0, y - iconS / 2, iconS, {
    color: o.iconColor || o.color, lineWidth: Math.max(1.5, iconS * 0.09),
  });
  ui.text(ctx, str, x0 + iconS + gap, y, {
    size: size, color: o.color, weight: o.weight,
  });
}

/** 顶部 HUD:模式徽标 / 分数 / 命数 / 时长 / 连击 / 三项计数 */
function renderHUD(ctx) {
  const cx = screen.width / 2;
  const mc = mode.color;
  const timed = mode.timeLimit > 0;
  const top = screen.safeTop;

  /* ---- ① 模式徽标:居中一块带主题色描边的药丸 ----
   * 局内必须能一眼看出"我在玩哪个模式" —— 四个模式的规则不同,
   * 玩家中途回来看一眼 HUD 却分不清自己在哪一局,是很糟的体验。
   * 后面缀上**机制标签**:它才是"这四个模式到底哪里不一样"的答案。 */
  const label = mode.mechanic ? (mode.name + ' · ' + mode.mechanic) : mode.name;
  const pillH = 46;
  const pillW = Math.max(150, 30 + label.length * 26 + 18);
  const bx = cx - pillW / 2;
  const by = top + 12;
  ui.pill(ctx, {
    x: bx, y: by, w: pillW, h: pillH,
    fill: 'rgba(255,255,255,0.07)', stroke: mc,
  });
  ui.text(ctx, label, bx + pillW / 2, by + pillH / 2, {
    size: 24, color: mc, align: 'center', weight: 'bold',
  });

  /* ---- ② 命数:右上角,用小方块表示(不用 emoji,不同机型渲染差异大) ----
   * 槽位数按**本模式**的生命上限画 —— 不同模式可能不一样多。 */
  const maxLives = mode.params.LIVES;
  const lifeW = 34, gap = 10;
  const totalW = maxLives * lifeW + (maxLives - 1) * gap;
  const startX = screen.width - 48 - totalW;
  for (let i = 0; i < maxLives; i++) {
    const on = i < world.lives;
    ui.roundRect(ctx, startX + i * (lifeW + gap), top + 50, lifeW, 18, 6);
    ctx.fillStyle = on ? ui.COLORS.danger : 'rgba(255,255,255,0.14)';
    ctx.fill();
  }

  /* ---- ③ 存活时长 / 倒计时(左上角) ----
   * 限时模式里"还剩多久"比"已经多久"重要得多,所以直接换掉这个数字,而不是再加一个
   * —— 两个计时器同屏出现,玩家会先愣一秒去分辨哪个是哪个。 */
  ui.text(ctx, timed ? String(Math.ceil(world.timeLeft)) + '"' : Math.floor(world.elapsed) + '"',
    48, top + 52, {
      size: 40, color: timed ? mc : ui.COLORS.textSub, weight: 'bold',
    });

  /* ---- ④ 分数:整块 HUD 的主角 ----
   * 这里刻意用**描边**而不是"固定宽度的胶囊"来解决可读性:
   * 分数的位数是不定的(3 位到 6 位),固定宽度要么框不住、要么太宽,
   * 而且一个横向居中的大胶囊必然和两侧的徽标 / 连击抢位置。
   * 描边没有宽度,位数再多也永远合适。 */
  const scoreStr = String(world.score);
  const digits = scoreStr.replace(/[^0-9]/g, '').length || 1;
  ui.text(ctx, scoreStr, cx, top + 118, {
    size: digits > 4 ? 78 : 92,
    color: ui.COLORS.text, align: 'center', weight: 'bold',
    stroke: 'rgba(0,0,0,0.55)', strokeWidth: 9,
  });
  ui.text(ctx, '得分', cx, top + 186, {
    size: 24, color: ui.COLORS.textSub, align: 'center',
    stroke: 'rgba(0,0,0,0.45)', strokeWidth: 5,
  });

  /* ---- ⑤ 机制读数:连击(金潮)或 时间条(死线) ----
   * 两者不会同时出现 —— 金潮不限时、死线不连击。所以它们可以共用这一行,
   * 也就不会把 HUD 撑得更长。 */
  if (mode.combo) {
    // 倍率是"接下来每个金块值多少"的唯一提示。不显式显示,
    // 玩家根本不知道自己此刻几倍 —— 也就不会为它去冒险,整条机制就白做了。
    const cw = 300, chh = 58;
    const active = world.combo > 0;
    ui.pill(ctx, {
      x: cx - cw / 2, y: top + 206, w: cw, h: chh,
      fill: active ? 'rgba(255,176,32,0.20)' : 'rgba(255,255,255,0.05)',
      stroke: active ? 'rgba(255,176,32,0.55)' : ui.COLORS.stroke,
    });
    ui.text(ctx,
      active ? ('连 ' + world.combo + '　倍率 ×' + world.comboMul.toFixed(1)) : '连击未开始',
      cx, top + 206 + chh / 2, {
        size: 25, color: active ? ui.COLORS.gold : ui.COLORS.textDim,
        align: 'center', weight: 'bold',
      });
  } else if (timed) {
    // 时间条:倒计时的数字只能看到"还有 47 秒",
    // 条能看到"我大概走到哪一段了" —— 压迫感来自后者。
    ui.progress(ctx, {
      x: 40, y: top + 226, w: screen.width - 80, h: 10,
      value: Math.max(0, world.timeLeft / world.timeLimit),
      color: mc, radius: 5,
    });
  }

  /* ---- ⑥ 三项计数:给一条极淡的底,把它们从背景里"托"起来 ---- */
  const statsY = top + 300;
  ui.pill(ctx, {
    x: cx - 250, y: statsY - 22, w: 500, h: 44,
    fill: 'rgba(9,13,19,0.34)',
  });
  ui.text(ctx, '躲避 ' + world.dodged, cx - 172, statsY, {
    size: 24, color: dodgePulse > 0 ? ui.COLORS.gold : ui.COLORS.textSub, align: 'center',
  });
  ui.text(ctx, '擦身 ' + world.grazed, cx, statsY, {
    size: 24, color: grazePulse > 0 ? ui.COLORS.gold : ui.COLORS.textSub, align: 'center',
  });
  ui.text(ctx, '拾取 ' + world.picked, cx + 172, statsY, {
    size: 24, color: pickPulse > 0 ? ui.COLORS.gold : ui.COLORS.textSub, align: 'center',
  });
}

/**
 * 开局横幅 —— 模式名从中间淡入再淡出。
 *
 * 存在的意义只有一条:让"这一局和上一局不一样"被看见。
 * 模式的价值全部在参数里,而**参数是看不见的**:不显式告诉玩家,
 * 他只会觉得"这局好像快了点",而不会意识到自己换了一个玩法。
 * 让一处机制被理解,比让它存在更重要。
 */
function renderBanner(ctx) {
  const t = Math.max(0, bannerTimer / 1.5);        // 1 → 0
  const a = Math.min(1, t * 2.4);                  // 尾段淡出,不要"啪"地消失
  const cx = screen.width / 2;
  const y = screen.height * 0.42;
  const bw = 560, bh = 168;
  // 入场时用 outCubic 从 92% 长到 100% —— 一点点"撑开"的动作,
  // 比纯淡入更有存在感,又不像 outBack 那样弹得过火
  const s = 0.92 + 0.08 * ui.Ease.outCubic(Math.min(1, (1 - t) * 8));

  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(cx, y);
  ctx.scale(s, s);
  ctx.translate(-cx, -y);

  // 卡片承载,并让描边与光晕都取模式色 —— 横幅一出现,整个屏幕的"主题"就变了
  ui.card(ctx, {
    x: cx - bw / 2, y: y - bh / 2, w: bw, h: bh, r: ui.RADIUS.xl,
    fill: 'rgba(12,17,24,0.88)',
    stroke: mode.color,
    glow: mode.color,
  });

  ui.text(ctx, mode.name, cx, y - 20, {
    size: 62, color: mode.color, align: 'center', weight: 'bold',
  });
  // 副标题优先说**机制**,而不是档位 —— 机制才回答"这局和前几局有什么不同"
  ui.text(ctx, mode.mechanic ? ('独有机制 · ' + mode.mechanic) : (mode.tag + ' 模式'),
    cx, y + 46, {
      size: 24, color: ui.COLORS.textSub, align: 'center',
    });

  // 两条从卡片两侧推入的模式色短线:零成本,但一眼就知道"屏幕的主题变了"
  const lw = 110 * t;
  ctx.fillStyle = mode.color;
  ctx.fillRect(cx - bw / 2 - lw, y - 2, lw, 4);
  ctx.fillRect(cx + bw / 2, y - 2, lw, 4);

  ctx.restore();
}

/* ============ 场景 ============ */

module.exports = {
  name: 'Game',

  onEnter() {
    // 模式必须**先决议** —— buildWorld() 要用它。
    // Modes.resolve() 对未知 id 会回落经典,所以被手改过的存档也不会让这里炸。
    const archive = Storage.loadArchive();
    mode = Modes.resolve(archive.mode);
    modeRuleText = buildRuleText();
    readyLayout = null;       // 折行要 ctx,留到第一帧再算
    runBest = Number((archive.bestByMode || {})[mode.id] || 0);

    Effects.clear();          // 清掉上一场残留的粒子
    ambientT = 0;
    bannerTimer = 0;
    modeRecord = false;

    world = buildWorld();
    state = STATE.READY;
    submitStatus = '';
    rankInfo = null;
    hitFlash = 0;
    dodgePulse = 0;
    pickPulse = 0;
    grazePulse = 0;
    floaters = [];
    overAt = 0;
    pressInRestartZone = false;
    resetRunGrowth();

    // 造型在**进场景时读一次**:局内不换装,避免渲染时反复读存档
    equippedSkin = Skins.get(archive.equippedSkin);
    trailPoints = [];

    buildReadyButtons();

    Share.setShareContent(() => ({
      title: '来挑战《' + cfg.GAME_NAME + '》!看我躲多久',
      query: 'from=game&mode=' + mode.id,
    }));
  },

  startGame() {
    Analytics.track('round_play_start', { mode: mode.id });
    // 清粒子:重开是高频动作(结算面板点哪都能重开),
    // 上一局的碎片如果飘进新一局,是那种"说不出哪里怪但就是不对"的问题
    Effects.clear();
    world = buildWorld();
    state = STATE.PLAYING;
    buttons = [];
    grazePulse = 0;
    floaters = [];
    overAt = 0;
    pressInRestartZone = false;
    modeRecord = false;
    bannerTimer = 1.5;        // 开局横幅:让"这一局和上一局不一样"被看见
    resetRunGrowth();
    trailPoints = [];
  },

  onUpdate(dt) {
    if (hitFlash > 0) hitFlash -= dt * 3;
    if (dodgePulse > 0) dodgePulse -= dt * 3;
    if (pickPulse > 0) pickPulse -= dt * 3;
    if (grazePulse > 0) grazePulse -= dt * 3;
    if (bannerTimer > 0) bannerTimer = Math.max(0, bannerTimer - dt);
    ambientT += dt;
    updateFloaters(dt);
    updateTrail(dt);
    // 粒子推进**不受游戏状态限制** —— 结算面板上碎片仍然要飘完,
    // 否则"死了"的那一瞬间特效会硬生生定格,看起来像卡住了
    Effects.update(dt);

    /* 复活询问的倒计时。★ 必须放在"非 PLAYING 就 return"**之前** ——
     * DYING 不是 PLAYING,放到后面这一句就永远走不到,冻结的画面会一直停在那里。 */
    if (state === STATE.DYING && reviveDeadline > 0 && Date.now() > reviveDeadline) {
      confirmDeath();
    }

    if (state !== STATE.PLAYING) return;

    // 玩法推进全部交给 rules.js
    // 断链发生在 step 内部(combo 被清零),所以要先留个快照才知道断了多少
    const comboBefore = world.combo;
    const events = Rules.step(world, dt);
    const px = world.player.x;
    const py = world.player.y;

    if (events.hit) {
      hitFlash = 1;
      floaters = [];              // 受击时清掉飘字,避免和扣命反馈叠在一起看不清
      // 断链必须说出来。连击的价值全在"我攒了多久"上,而断链本身是**沉默的** ——
      // 不说,玩家只会觉得"怎么分涨得慢了",而不会明白自己刚刚失去了什么。
      if (mode.combo && comboBefore > 1) {
        addFloater(px, py - 132, '连击中断 ×' + comboBefore, ui.COLORS.dangerLight);
      }
      // 受击特效 = 冲击波 + 碎片。两件一起放才有"撞上了"的重量感:
      // 只有碎片像散落的像素,只有圆环像一段 UI 动画
      Effects.ring(px, py, {
        color: ui.COLORS.danger, size: 26, grow: 720, width: 13, life: 0.36,
      });
      Effects.burst(px, py, {
        count: 22, colors: [ui.COLORS.danger, '#ff9093'],
        speed: 420, kind: 'square', size: 12, life: 0.5,
      });
      WX.vibrateShort();          // 不支持的机型自动忽略
      Analytics.track('hit', { elapsed: Math.floor(world.elapsed), mode: mode.id });
      /* 命归零不再直接进结算 —— 先给一次"看视频续命"的机会。
       * 广告不可用时 requestReviveOrEnd() 内部立刻 endGame(),行为与接入前一致。 */
      if (world.over) requestReviveOrEnd();
    }

    if (events.timeUp) {
      // 时间到(仅死线模式):白色冲击波 + 向上飘的碎屑。
      // 刻意和"被撞爆"的红完全区分开 —— 结局不同,反馈就该不同。
      Effects.ring(px, py, {
        color: '#ffffff', size: 30, grow: 900, width: 15, life: 0.5,
      });
      Effects.burst(px, py, {
        count: 30, colors: ['#ffffff', mode.color],
        speed: 520, size: 11, life: 0.7, grav: -90,
      });
      WX.vibrateShort();
      endGame();
    }

    if (events.dodged > 0) {
      dodgePulse = 1;
    }

    if (events.graze > 0) {
      grazePulse = 1;
      // 擦身的火花往**移动方向的反面**甩,所以"我从哪边擦过去的"是被画出来的,
      // 不需要玩家去读飘字。这是"技能表达"最便宜的一种可视化。
      const movingRight = (world.player.targetX - px) >= 0;
      Effects.spark(px, py, {
        count: 10,
        angle: movingRight ? Math.PI : 0,
        spread: 2.2,
        color: ui.COLORS.gold,
        speed: 560,
      });
      addFloater(px, py - 84, '险 +' + mode.params.GRAZE_SCORE, ui.COLORS.gold);
      Analytics.track('graze', {
        elapsed: Math.floor(world.elapsed), total: world.grazed, mode: mode.id,
      });
    }

    if (events.heal || events.bonus) {
      pickPulse = 1;
      WX.vibrateShort();
      const c = events.heal ? ui.COLORS.brand : ui.COLORS.gold;
      // 连击越高,爆发的圆环越大 —— 让"倍率正在涨"被身体感觉到,
      // 而不只是 HUD 上多了一个数字。
      const boost = (mode.combo && mode.params.COMBO_MAX > 1)
        ? Math.min(1, world.comboMul / mode.params.COMBO_MAX) : 0;
      // 拾取 = 爆发 + 一圈小冲击波。回命用品牌绿、加分用金,
      // 两种结果用两种颜色,不用读字就知道刚才发生了什么
      Effects.burst(px, py, {
        count: 16 + Math.round(boost * 10), color: c, speed: 380, size: 10, life: 0.46,
      });
      Effects.ring(px, py, {
        color: c, size: 16, grow: 520 + boost * 240, width: 7 + boost * 3, life: 0.28,
      });
      // 飘字报**实际到手的分**,不是基础分 ——
      // 否则玩家会以为连击没生效:HUD 上写着 ×2.8,飘出来的却还是 +6。
      const gain = events.heal
        ? '回命'
        : '+' + Math.round(mode.params.PICKUP_SCORE * (mode.combo ? world.comboMul : 1));
      addFloater(px, py - 84, gain, c);
      Analytics.track(events.heal ? 'pickup_heal' : 'pickup_bonus', {
        elapsed: Math.floor(world.elapsed), lives: world.lives, mode: mode.id,
        combo: world.combo,
      });
    }
  },

  onRender(alpha) {
    const ctx = screen.ctx;

    // 受击时整屏抖动
    if (world.shake > 0) {
      ctx.save();
      ctx.translate(
        (Math.random() - 0.5) * 14 * world.shake,
        (Math.random() - 0.5) * 14 * world.shake
      );
    }

    renderBackground(ctx);

    /* DYING 也要画世界 —— 它是"世界被冻住了",不是"世界消失了"。
     * 玩家正是靠这张静止的画面判断"我刚才死在哪里"。 */
    if (state === STATE.PLAYING || state === STATE.DYING || state === STATE.OVER) {
      renderObstacles(ctx);
      renderTrail(ctx);
      renderPlayer(ctx);
      renderFloaters(ctx);
      // 游玩中的粒子画在世界层之上、HUD 之下 —— 它属于"场景里发生的事"。
      // 结算态的粒子反过来要**盖在遮罩之上**(彩带必须能飘过黑幕),所以分两处调用。
      if (state === STATE.PLAYING) Effects.render(ctx);
    }

    if (world.shake > 0) ctx.restore();

    // 擦身而过:整屏金边一闪。成本只是一个 strokeRect,
    // 但"我刚才几乎死掉"的体感全靠它 —— 这是这一作心跳的来源。
    if (grazePulse > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, grazePulse) * 0.55;
      ctx.strokeStyle = ui.COLORS.gold;
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, screen.width - 10, screen.height - 10);
      ctx.restore();
    }

    /* ★ HUD 只在**真正在玩**的时候画(PLAYING)。
     *
     * 此前是"除准备态外都画",于是结算态也画了 —— 而结算面板是满屏的、
     * 自己就有一个 120px 的大分数和一个「第 N 局 · 模式」标题:
     *   HUD 的 92px 分数(y=206) 撞 面板标题(y=190)
     *   HUD 的「得分」标签(y=274) 撞 面板的 120px 大分数(y=274)
     * 两处都是**同一个数字被写了两遍**,叠在一起又都对不齐,
     * 玩家看到的是"花了的大字",读不出任何一个。
     *
     * 三层理由,任何一层都足够:
     *   ① 结算面板已经完整说了"这局多少分、第几局、什么模式",HUD 是纯重复;
     *   ② 它们**坐标上真的会撞**(见上),不是"看起来挤";
     *   ③ 准备态的同类问题也一并解决 —— 那三个 0 没有信息量(见下)。 */
    if (state === STATE.PLAYING) renderHUD(ctx);

    /* ---- 开局模式横幅 ---- */
    if (state === STATE.PLAYING && bannerTimer > 0) renderBanner(ctx);

    /* ---- 准备态:模式说明(卡片承载,而不是把字直接压在遮罩上) ---- */
    if (state === STATE.READY) {
      const cx = screen.width / 2;
      ctx.fillStyle = 'rgba(6,9,13,0.74)';
      ctx.fillRect(0, 0, screen.width, screen.height);

      if (!readyLayout) readyLayout = buildReadyLayout(ctx);
      const L = readyLayout;
      const cardX = cx - L.cardW / 2;
      const cardY = screen.height * 0.185;

      ui.card(ctx, {
        x: cardX, y: cardY, w: L.cardW, h: L.cardH, r: ui.RADIUS.xl,
        fill: 'rgba(20,27,36,0.95)',
        stroke: ui.COLORS.strokeHi,
      });

      let y = cardY + 60;

      // 模式名 —— 玩家在主页选了模式,进来必须立刻确认"自己选对了"
      ui.text(ctx, mode.name, cx, y, {
        size: 54, color: mode.color, align: 'center', weight: 'bold',
      });

      y += 48;

      // 机制标签。这是本屏**最重要**的一行字:四个模式的差异全在机制上,
      // 而机制是看不见的 —— 玩家不会自己发现"这局的红块会摆"。
      if (mode.mechanic) {
        const tagTxt = '独有机制 · ' + mode.mechanic;
        const tw = ui.measure(ctx, tagTxt, 22, 'bold') + 44;
        ui.pill(ctx, {
          x: cx - tw / 2, y: y - 21, w: tw, h: 42,
          fill: 'rgba(255,255,255,0.06)', stroke: mode.color,
        });
        ui.text(ctx, tagTxt, cx, y, {
          size: 22, color: mode.color, align: 'center', weight: 'bold',
        });
        y += 42;
      }

      y += 26;
      // 定位语同样折行 —— 疾风那句 29 个字符已经不短,换个模式就可能超
      for (let i = 0; i < L.descRows.length; i++) {
        ui.text(ctx, L.descRows[i], cx, y + i * 34, {
          size: 24, color: ui.COLORS.textSub, align: 'center',
        });
      }

      y += L.descRows.length * 34;
      y += 34;
      ui.divider(ctx, cardX + 44, y, L.cardW - 88);
      y += 36;

      // 规则速览由本模式**实际生效的参数**生成,不是写死的文案 ——
      // 这样"界面说 2 条命、实际跑 3 条命"这类错永远不可能出现
      for (let i = 0; i < L.rows.length; i++) {
        const row = L.rows[i];
        const lw2 = ui.measure(ctx, row.text, 25);
        // 每条规则的第一段前面挂一枚小圆点。多条规则并列时,没有标记就是
        // 一整段散文;有了标记,眼睛会一条一条地读,而不是一次性扫过。
        if (row.top) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx - lw2 / 2 - 18, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = row.head ? ui.COLORS.accentLight : ui.COLORS.textDim;
          ctx.fill();
          ctx.restore();
        }
        ui.text(ctx, row.text, cx, y, {
          size: 25,
          color: row.head ? ui.COLORS.accentLight : ui.COLORS.textSub,
          align: 'center',
        });
        y += row.h;
      }

      ui.divider(ctx, cardX + 44, y, L.cardW - 88);
      y += 34;
      // 操作提示收进一枚药丸:它是这一屏唯一一句"教你动手"的话,
      // 直接压在卡片底上会混进上面的规则里,给它一个自己的容器。
      const hint = '手指左右拖动 —— 红色的躲,金色的抢';
      const hw = ui.measure(ctx, hint, 26) + 56;
      ui.pill(ctx, {
        x: cx - hw / 2, y: y - 21, w: hw, h: 42,
        fill: 'rgba(255,255,255,0.07)', stroke: ui.COLORS.stroke,
      });
      ui.text(ctx, hint, cx, y, {
        size: 26, color: ui.COLORS.text, align: 'center',
      });
    }

    /* ---- 复活询问(命归零之后的岔路口)----
     * 世界是冻结的,所以这里只需要回答两件事:"发生了什么" 和 "我还有几秒"。 */
    if (state === STATE.DYING) {
      const cx = screen.width / 2;
      const left = Math.max(0, Math.ceil((reviveDeadline - Date.now()) / 1000));

      ctx.fillStyle = 'rgba(4,7,11,0.82)';
      ctx.fillRect(0, 0, screen.width, screen.height);

      const dCardW = 620;
      const dCardH = 372;
      const dCardX = cx - dCardW / 2;
      const dCardY = screen.height * 0.235;

      ui.card(ctx, {
        x: dCardX, y: dCardY, w: dCardW, h: dCardH, r: ui.RADIUS.xl,
        fill: 'rgba(20,27,36,0.96)', stroke: ui.COLORS.strokeHi,
      });

      let dy = dCardY + 64;
      ui.text(ctx, '命用完了', cx, dy, {
        size: 50, color: ui.COLORS.text, align: 'center', weight: 'bold',
      });

      dy += 62;
      ui.text(ctx, '这一局已躲 ' + world.dodged + ' 个 · ' + Rules.finalScore(world) + ' 分',
        cx, dy, { size: 26, color: ui.COLORS.textSub, align: 'center' });

      dy += 54;
      ui.divider(ctx, dCardX + 46, dy, dCardW - 92);

      dy += 50;
      ui.text(ctx, '看一段视频,原地续一命接着跑', cx, dy, {
        size: 25, color: ui.COLORS.brand, align: 'center',
      });

      dy += 46;
      ui.text(ctx, left > 0 ? (left + ' 秒后自动结算') : '请选择', cx, dy, {
        size: 23, color: ui.COLORS.textDim, align: 'center',
      });
    }

    /* ---- 结算面板(卡片承载) ---- */
    if (state === STATE.OVER) {
      const cx = screen.width / 2;
      ctx.fillStyle = 'rgba(4,7,11,0.80)';
      ctx.fillRect(0, 0, screen.width, screen.height);

      const finalScore = Rules.finalScore(world);
      const archive = Storage.loadArchive();
      const isBest = modeRecord;
      // 近失比较的基准是**本模式的纪录**,不是全模式最高分 ——
      // 拿死线模式的 2000 分去比经典模式的 5000 分,玩家永远只看到"差 3000 分",
      // 那不是激励,那是一句"你不该玩这个模式"。
      const gapToBest = Math.max(0, runBest - finalScore);

      const cardW = 646;
      const cardH = 664;
      const cardX = cx - cardW / 2;
      const cardY = screen.height * 0.085;

      // 破纪录时卡片自己会发光并镶金边 —— 整屏只有这一处会发光,
      // 所以"这局不一样"不需要任何文字去强调
      ui.card(ctx, {
        x: cardX, y: cardY, w: cardW, h: cardH, r: ui.RADIUS.xl,
        fill: 'rgba(20,27,36,0.96)',
        stroke: isBest ? 'rgba(255,176,32,0.62)' : ui.COLORS.strokeHi,
        glow: isBest ? ui.COLORS.gold : null,
      });

      let y = cardY + 52;

      ui.text(ctx, '第 ' + archive.totalGames + ' 局 · ' + mode.name + ' 模式',
        cx, y, { size: 26, color: ui.COLORS.textSub, align: 'center' });

      y += 84;
      /* 分数 + 小一号的"分"。
       * 120px 的一串数字不带单位,玩家要自己想一下它是分数、金币还是名次 ——
       * 数字与单位一起居中,既保住了"分数是主角",又让它是**什么**这件事不用猜。 */
      {
        const sw = ui.measure(ctx, String(finalScore), 120, 'bold');
        const uw = ui.measure(ctx, '分', 30, 'bold');
        const gw = sw + 14 + uw;
        ui.text(ctx, String(finalScore), cx - gw / 2 + sw / 2, y, {
          size: 120, color: ui.COLORS.text, align: 'center', weight: 'bold',
        });
        ui.text(ctx, '分', cx - gw / 2 + sw + 14, y + 30, {
          size: 30, color: ui.COLORS.textSub, weight: 'bold',
        });
      }

      y += 70;
      if (isBest) {
        ui.text(ctx, '新纪录!', cx, y, {
          size: 38, color: ui.COLORS.gold, align: 'center', weight: 'bold',
        });
      } else if (gapToBest <= Math.max(50, Math.round(runBest * 0.1))) {
        // 近失提示:这是"再来一局"最直接的钩子,比干巴巴的"历史最高 XXXX"有效得多。
        // 阈值取 10%(下限 50 分),既不会人人都"差一点",也不会没人触发。
        ui.text(ctx, '就差 ' + gapToBest + ' 分破纪录!', cx, y, {
          size: 34, color: ui.COLORS.gold, align: 'center', weight: 'bold',
        });
      } else {
        ui.text(ctx, mode.name + ' 模式最高 ' + runBest, cx, y, {
          size: 26, color: ui.COLORS.textSub, align: 'center',
        });
      }

      y += 38;
      ui.divider(ctx, cardX + 46, y, cardW - 92);
      y += 38;

      // 结局与存活时长 —— 顺带把"时间到"和"被撞爆"两种结局在字色上分开
      ui.text(ctx, world.timeUp ? '时间到 · 撑到最后' : '存活 ' + Math.floor(world.elapsed) + ' 秒',
        cx, y, {
          size: 28, color: world.timeUp ? mode.color : ui.COLORS.text,
          align: 'center', weight: 'bold',
        });

      y += 44;
      ui.text(ctx, '躲 ' + world.dodged + '　擦身 ' + world.grazed + '　拾取 ' + world.picked,
        cx, y, { size: 24, color: ui.COLORS.textSub, align: 'center' });

      /* 连击(仅金潮)——
       * 分数只说明结果,而"最高连到几"才是这个模式真正在追的东西:
       * 玩家心里记的是"我这局连到 9 个",不是"我拿了 1840 分"。 */
      if (mode.combo) {
        y += 44;
        ui.text(ctx, '最高连击 ' + world.comboBest + ' 连', cx, y, {
          size: 27,
          color: world.comboBest > 1 ? ui.COLORS.gold : ui.COLORS.textDim,
          align: 'center', weight: 'bold',
        });
      }

      y += 46;
      // 全服榜只统计经典模式 —— 跨模式比分数没有意义(见 gameplay/modes.js 的说明)。
      // 所以非经典模式这里**明说"不计入"**,而不是偷偷显示一个会被误读的名次。
      if (!mode.scoreboard) {
        ui.text(ctx, '「' + mode.tag + '」模式不计入全服榜', cx, y, {
          size: 23, color: ui.COLORS.textDim, align: 'center',
        });
      } else if (rankInfo && rankInfo.rank) {
        ui.text(ctx, '全服第 ' + rankInfo.rank + ' 名 / 共 ' + rankInfo.total + ' 人',
          cx, y, { size: 27, color: ui.COLORS.brand, align: 'center', weight: 'bold' });
      } else if (submitStatus) {
        ui.text(ctx, submitStatus, cx, y, {
          size: 23, color: ui.COLORS.textSub, align: 'center',
        });
      }

      y += 34;
      ui.divider(ctx, cardX + 46, y, cardW - 92);
      y += 38;

      /* ---- 跨局成长:金币 / 成就奖励 / 下一款目标
       * 这一段是结算面板上**最有用**的部分。分数只说明"这一局怎么样",
       * 而它们说明"我在攒钱、我在变强" —— 后者才是玩家再来一局的理由。 ---- */
      if (coinsGained > 0) {
        centeredIconLine(ctx, cx, y, 'coin', '金币 +' + coinsGained, {
          size: 30, color: ui.COLORS.gold, weight: 'bold', iconSize: 30,
          maxW: cardW - 92,
        });
      }

      // 成就奖励单独一行:让"打得好 = 赚得快"这件事被直接看见。
      // 如果和上面的局内金币合并成一个数字,这条信息就没了。
      y += 44;
      if (unlockedAch.length > 0) {
        const more = unlockedAch.length > 1 ? ('　等 ' + unlockedAch.length + ' 项') : '';
        centeredIconLine(ctx, cx, y, 'medal',
          '成就「' + unlockedAch[0].name + '」' + more + '　奖励 +' + achBonus + ' 金币', {
            size: 24, color: ui.COLORS.brand, weight: 'bold', iconSize: 26,
            maxW: cardW - 92,
          });
      }

      y += 42;
      if (goalHint) {
        centeredIconLine(ctx, cx, y, 'shapes',
          Skins.goalText(goalHint.skin, archive.coins), {
            size: 23, color: ui.COLORS.accentLight, iconSize: 26,
            maxW: cardW - 92,
          });
      }

      /* 收藏进度 —— 它是"买了就响"在**局内**的那一半。
       * 玩家在商店里花的钱,要在这里被再确认一次"它算数":
       * 否则买造型这件事只在商店里存在,一回到游戏就消失了。 */
      y += 34;
      const ownedCount = Skins.countOwned(archive.ownedSkins);
      const allOwned = ownedCount >= Skins.SKINS.length;
      centeredIconLine(ctx, cx, y, allOwned ? 'crown' : 'star',
        allOwned ? '造型全部收集 · 24 / 24' : ('造型 ' + ownedCount + ' / ' + Skins.SKINS.length), {
          size: 22,
          color: allOwned ? ui.COLORS.gold : ui.COLORS.textDim,
          weight: allOwned ? 'bold' : '',
          iconSize: 24,
          maxW: cardW - 92,
        });

      // 重开提示紧跟卡片下沿。解锁前不显示 —— 免得玩家手指还按在屏幕上时结算被跳过。
      if (Date.now() - overAt > RESTART_LOCK_MS) {
        ui.text(ctx, '点击此处任意位置 · 再来一局', cx, cardY + cardH + 52, {
          size: 30, color: ui.COLORS.brand, align: 'center', weight: 'bold',
        });
      }
    }

    // 结算 / 准备态的粒子画在遮罩**之上** —— 破纪录彩带必须能飘过黑幕,
    // 否则最该被看见的那一次庆祝会被结算面板压住。全程只会有一次 render 生效。
    if (state !== STATE.PLAYING) Effects.render(ctx);

    buttons.forEach((b) => b.render(ctx));
  },

  /* ---------- 触摸:全部转成"目标横坐标",交给 rules 处理 ---------- */
  onTouchStart(p) {
    if (state === STATE.PLAYING) {
      dragging = true;
      Rules.setPlayerTarget(world, p.x);
      return;
    }
    // 记录按下起点:只有起点在"重开区"、终点也在"重开区"才算重开,
    // 避免从按钮上滑出去被误判成重开
    pressInRestartZone = state === STATE.OVER &&
      p.y < restartZoneBottom &&
      !buttons.some((b) => b.hit(p));
    buttons.forEach((b) => b.onDown(p));
  },

  onTouchMove(p) {
    if (state === STATE.PLAYING && dragging) {
      Rules.setPlayerTarget(world, p.x);
    }
  },

  onTouchEnd(p) {
    if (state === STATE.PLAYING) {
      dragging = false;
      return;
    }

    let consumedByButton = false;
    buttons.forEach((b) => { if (b.onUp(p)) consumedByButton = true; });

    const inZone = pressInRestartZone && p.y < restartZoneBottom;
    pressInRestartZone = false;

    // 结算面板:点击(按钮区以上的)任意位置直接重开。
    // 死亡后 0.9 秒内不响应 —— 玩家手指通常还在屏幕上,否则会瞬间跳过结算。
    if (!consumedByButton && inZone &&
        Date.now() - overAt > RESTART_LOCK_MS) {
      Analytics.track('quick_restart', {});
      module.exports.startGame();
    }
  },

  /** 分享后的小奖励:可选行为 + 每日次数上限,合规且不破坏经济系统 */
  grantShareBonus() {
    // 日期一律走 utils/date.js 的本地日期 —— 直接用 toISOString 会差 8 小时(UTC+8)
    const today = Dates.todayStr();
    const key = 'share_bonus_' + today;
    const used = Storage.get(key, 0);
    if (used >= cfg.ECONOMY.SHARE_DAILY_LIMIT) return;
    Storage.set(key, used + 1);
    const a = Storage.loadArchive();
    a.coins += cfg.ECONOMY.SHARE_COINS;
    Storage.saveArchive(a);
    WX.showToast('分享奖励 +' + cfg.ECONOMY.SHARE_COINS + ' 金币');
  },

  /** 结算面板的「看视频,金币翻倍」—— 按钮的回调指向这里(与 grantShareBonus 同一种写法) */
  doubleCoinsByAd() {
    doubleCoinsByAd();
  },

  onExit() {
    dragging = false;
    // 离开场景就清空粒子池。粒子池是**模块级**的(全场景共用一个池),
    // 不清的话上一局的碎片会跟着进下一个场景 —— 这类跨场景残留很难复现。
    Effects.clear();
  },
};
