/**
 * gameplay/rules.js —— 竖版躲障跑酷 · 纯逻辑层
 *
 * 玩法:单指左右拖动。
 *   · 红色障碍(红块)—— 躲开。撞到扣 1 条命并短暂无敌;成功躲过 +DODGE_SCORE 分。
 *   · 金色能量块(金块)—— 主动抢。撞到即拾取:命未满则回 1 条命(本局上限 MAX_HEALS 次),
 *                        命已满则 +PICKUP_SCORE 分。错过不扣分,只是白丢一个机会。
 *   金块有 PICKUP_NEAR_CHANCE 的概率贴着红块生成 —— 想拿就得往危险边上靠,
 *   这是本作唯一的"决策",也是它和满大街躲障游戏的区别所在。
 *
 *   · 擦身而过(Graze)—— 贴着红块边缘掠过时 +GRAZE_SCORE 分(每个红块最多一次)。
 *   它把"安全躲避"和"贴身掠过"分出了收益差:稳妥走位拿 5 分,贴着边缘走拿 7 分。
 *   这样"贪"这件事就有了持续的小额回报,而不是只有金块出现时才需要判断一次。
 *
 * ─── 三个模式机制(默认全部关闭,定义见 config.GAME 末尾) ───
 * 每个模式只打开属于它的那一个,于是四个模式的核心挑战真的不一样,
 * 而这一层仍然只有一份代码:
 *   ① 摆动(sway)  障碍横向位置 = 纵向位置的函数      → 改变"怎么躲"
 *   ② 游走(drift) 金块匀速横移,倍率越高跑得越快     → 改变"为什么贪"
 *   ③ 摇摆(lane)  走廊随存活时间收窄、并整体左右平移 → 改变"空间有多大"
 *
 * 三条机制表面上都是"某个东西在横向动",但玩家要做的判断完全不同:
 *   ① 读**单个块**的波形(每块相位随机)  → 个体预判
 *   ② 算**单个金块**的落点(匀速直线,可算) → 提前站位
 *   ③ 跟**整个空间**的节拍(全场同步平移)  → 节奏跟随
 * 所以它们彼此正交,不会让四个模式又塌回"同一件事的四档速度"。
 *
 * 三者互不干涉,也都不碰经典模式:未启用时分别退化成
 * "sin 那一行不执行 / vx 恒为 0 / 走廊恒等于整屏",与加机制之前逐值一致。
 *
 * 这一层完全不碰 Canvas、不碰 wx,只负责推进状态。
 * 好处:调手感不用改渲染代码;规则可以脱离小程序环境单独跑测试;
 *      将来若换引擎(Cocos 等),这层逻辑可整体复用。
 *
 * 坐标系:与渲染共用同一套"设计坐标"(宽度恒为 750),由 screen.js 统一换算。
 */
const cfg = require('../config/config.js');
const Modes = require('./modes.js');
const G = cfg.GAME;      // 基准参数(= 经典模式);具体模式生效的参数在 world.params 里

/** 玩家跟随手指的速度系数:越大越跟手,越小越滑。手感调参主要动这个值 */
const FOLLOW_SPEED = 16;

/** 玩家碰撞判定框相对视觉尺寸的收缩量(让玩家感觉"擦边不算死",体感更好) */
const HITBOX_INSET = 10;

/** 实体类型 */
const KIND = { HAZARD: 'hazard', PICKUP: 'pickup' };

/* ---------- 创建世界 ---------- */
/**
 * @param {{width:number, height:number, groundY:number}} bounds
 *        groundY:玩家所在的"地面"纵向位置(设计坐标)
 * @param {object} [modeDef] 玩法模式定义(见 gameplay/modes.js)。
 *        不传 = 经典模式 —— 这样老的调用方(含测试)一行都不用改。
 *
 * ⚠️ 参数**挂在 world.params 上**,而不是继续读模块级的 cfg.GAME。
 *    原因是多模式:同一份 rules.js 要跑四套数值,读全局变量的话
 *    切一次模式就会把所有已存在的 world 一起改掉。
 *    world 自己带着参数走,才是可并存的。
 */
function createWorld(bounds, modeDef) {
  const def = modeDef || Modes.get(Modes.DEFAULT_MODE_ID);
  const P = Modes.paramsOf(def.id);
  const timeLimit = def.timeLimit || 0;

  const playerW = 96;
  const playerH = 96;
  const startX = bounds.width / 2;

  return {
    bounds,
    mode: def.id,         // 本局玩法模式(上报给服务端做上限校验的依据)
    params: P,            // 本局生效的完整参数表
    timeLimit: timeLimit, // 0 = 无限制(活多久算多久)
    timeLeft: timeLimit,  // 限时模式剩余秒数
    timeUp: false,        // 是否因"时间到"结束(区别于被撞爆)
    /* 机制③ 活动走廊:初值 = 整屏。不启用收窄时它恒定不变,
       所以对经典模式而言这几个字段只是"多存了几个常量",不影响任何判定。 */
    laneCenter: bounds.width / 2,
    laneHalf: bounds.width / 2,
    // 走廊中心的横向速度(设计像素/秒)。纯给渲染层画拖影用,不参与任何判定 ——
    // 逻辑层顺手算好,省得渲染层去反推相位、再和逻辑层的公式对不上。
    laneVX: 0,
    player: {
      x: startX,
      y: bounds.groundY - playerH / 2,
      w: playerW,
      h: playerH,
      targetX: startX,
      tilt: 0,            // 倾斜角,纯视觉反馈
    },
    obstacles: [],        // 红块与金块共用一条数组,靠 kind 区分
    elapsed: 0,           // 存活时长(秒)
    dodged: 0,            // 成功躲过的红块数
    grazed: 0,            // 擦身而过的红块数(每个红块最多计一次)
    picked: 0,            // 成功拾取的金块数
    /* 机制② 连击链:被撞即断。不启用时 comboMul 恒为 1,行为与经典逐值一致 */
    combo: 0,             // 当前连击数(自上次受击以来连续拾取的次数)
    comboBest: 0,         // 本局最高连击
    comboMul: 1,          // 当前倍率(仅当 COMBO_ENABLED 时才会 > 1)
    heals: 0,             // 本局已用掉的回命次数(受 params.MAX_HEALS 限制)
    hits: 0,              // 本局被撞到的次数(0 = 无伤,用于"完美主义"这类成就)
    bonus: 0,             // 命满时拾取累计得到的加分
    score: 0,
    lives: P.LIVES,
    invincible: 0,        // 剩余无敌时间
    speed: P.BASE_SPEED,
    spawnTimer: P.SPAWN_START_INTERVAL,
    spawnInterval: P.SPAWN_START_INTERVAL,
    pickupTimer: P.PICKUP_INTERVAL,
    shake: 0,             // 受击震动强度,纯视觉
    over: false,
  };
}

/* ---------- 活动走廊(机制③) ---------- */
/**
 * 走廊 —— 玩家可站立的横向范围,同时也是障碍与金块的生成范围。
 * 不启用收窄时它恒等于整屏,下面两个函数就退化成 0 与 bounds.width,
 * 于是这条机制对经典模式毫无影响。
 */
function laneLeft(world) { return world.laneCenter - world.laneHalf; }
function laneRight(world) { return world.laneCenter + world.laneHalf; }

/**
 * 按存活时间把走廊从整屏线性收到 LANE_MIN_RATIO 那么宽,收到最窄后不再变化,
 * 同时让走廊整体左右平移(机制③的"摇摆"部分)。
 *
 * "收到头就停"是刻意的:收窄要有终点感。如果一路收到底,
 * 最后几秒就变成了持续的不安,而不是一个可以被应对的压迫。
 * 摇摆则**持续到最后一秒** —— 宽度确定之后,摇摆就是最后那段的主戏。
 *
 * 摇摆幅度取 LANE_SWAY 与"当前可移动余量"的较小值,而余量 = full×(1−minRatio)×k。
 * 只要 LANE_SWAY ≤ full×(1−minRatio),走廊就**永远不会被推出屏幕** ——
 * 这条约束写在公式里,不靠运行时兜底夹取。
 */
function updateLane(world) {
  const P = world.params;
  const shrink = P.LANE_SHRINK_SECONDS || 0;
  if (shrink <= 0) return;

  const minRatio = Math.max(0.05, Math.min(1, P.LANE_MIN_RATIO || 1));
  const k = Math.min(1, world.elapsed / shrink);
  const full = world.bounds.width / 2;

  let offset = 0;
  const swayAmp = P.LANE_SWAY || 0;
  const period = P.LANE_SWAY_PERIOD || 0;
  if (swayAmp > 0 && period > 0) {
    // 幅度随收窄进度 k 一起增长 → "越到后面荡得越急"。
    // 周期恒定、不随难度变化 —— 节奏数得出来,玩家才谈得上预判;
    // 若周期也跟着变,摆动就退化成随机抖动,玩家学不到任何东西。
    const amp = Math.min(swayAmp, full * (1 - minRatio)) * k;
    const omega = (Math.PI * 2) / period;
    offset = Math.sin(world.elapsed * omega) * amp;
    world.laneVX = amp * omega * Math.cos(world.elapsed * omega);
  } else {
    world.laneVX = 0;
  }

  world.laneCenter = full + offset;
  world.laneHalf = full - (full - full * minRatio) * k;
}

/* ---------- 输入 ---------- */
/** 设置玩家的目标横向位置(由触摸拖动驱动),并做边界收束 */
function setPlayerTarget(world, designX) {
  const half = world.player.w / 2;
  const margin = 40;
  let lo = laneLeft(world) + half + margin;
  let hi = laneRight(world) - half - margin;
  // 走廊若被脏参数收到比玩家还窄,就收敛到中点 ——
  // 宁可"站着不能动",也不能算出一个左边界大于右边界的区间。
  if (hi < lo) lo = hi = (lo + hi) / 2;

  let x = designX;
  if (x < lo) x = lo;
  if (x > hi) x = hi;
  world.player.targetX = x;
}

/* ---------- 难度曲线 ---------- */
/**
 * 随存活时间线性提升下落速度、缩短生成间隔,两条曲线都设了上限。
 * @param {number} elapsed 存活秒数
 * @param {object} [params] 生效参数;不传 = 基准(经典)。传 world.params 即可。
 */
function difficultyAt(elapsed, params) {
  const P = params || G;
  const speed = Math.min(P.BASE_SPEED + elapsed * P.SPEED_GROWTH, P.MAX_SPEED);
  const interval = Math.max(
    P.SPAWN_START_INTERVAL - elapsed * P.SPAWN_INTERVAL_DECAY,
    P.SPAWN_MIN_INTERVAL
  );
  return { speed, interval };
}

/* ---------- 生成:红块 ---------- */
/** 生成一个红色障碍,返回它本身(供金块定位参考) */
function spawnObstacle(world) {
  const P = world.params;
  const w = P.OBSTACLE_MIN_WIDTH +
    Math.random() * (P.OBSTACLE_MAX_WIDTH - P.OBSTACLE_MIN_WIDTH);
  const h = P.OBSTACLE_HEIGHT;

  // 生成范围 = 走廊内左右各留 20 的内边距,避免贴边生成导致玩家无处可躲
  let minX = laneLeft(world) + 20;
  let maxX = laneRight(world) - w - 20;
  if (maxX < minX) maxX = minX;

  // 机制①:摆动会让红块从基准位置向两侧荡开,
  // 所以生成范围必须**预先**把振幅扣掉 —— 否则块会荡到屏幕外面去,
  // 在玩家看来就是"明明该有的红块凭空少了一块"。
  const sway = P.OBSTACLE_SWAY || 0;
  if (sway > 0) {
    const inset = Math.min(sway, Math.max(0, (maxX - minX) / 2));
    minX += inset;
    maxX -= inset;
  }

  const x = minX + Math.random() * Math.max(0, maxX - minX);

  const ob = {
    kind: KIND.HAZARD,
    x,
    y: -h - 10,
    w,
    h,
    // 摆动状态围绕基准位置;相位按块随机 —— 若所有块同相位,
    // 整屏就会变成"一起左右平移",玩家一眼就读完了,没有预判的空间。
    baseX: x,
    swayPhase: Math.random() * Math.PI * 2,
    swayAmp: sway,
    passed: false,   // 是否已判定为"躲避成功"
    grazed: false,   // 是否已判定为"擦身而过"(每个红块只计一次)
  };
  world.obstacles.push(ob);
  return ob;
}

/* ---------- 生成:金块 ---------- */
/**
 * 生成一个金色能量块。
 * 有两种落点:①完全随机 ②贴着刚生成的红块旁边(制造取舍)。
 * 无论哪种,都必须保证 y 在屏幕上方之外,否则会"凭空出现"在画面中间。
 */
function spawnPickup(world) {
  const P = world.params;
  const size = P.PICKUP_SIZE;
  const minX = laneLeft(world) + 20;
  const maxX = Math.max(minX, laneRight(world) - size - 20);

  let x = minX + Math.random() * (maxX - minX);
  let y = -size - 10;

  // 取最近生成的红块做参考:它在数组末尾,也是位置最靠上的一个
  const list = world.obstacles;
  const last = list.length ? list[list.length - 1] : null;

  if (last && last.kind === KIND.HAZARD && Math.random() < P.PICKUP_NEAR_CHANCE) {
    // 参考点是红块的**基准位置**而不是当前位置:摆动模式里红块会荡走,
    // 而金块是要停在那儿等玩家来够的。贴着轨道生成,"险"才是真实存在的 ——
    // 否则等玩家赶到时红块早已荡开,所谓取舍就变成了摆设。
    const refX = last.swayAmp > 0 ? last.baseX : last.x;
    const side = Math.random() < 0.5 ? -1 : 1;   // 贴在红块的左边还是右边
    const gap = P.PICKUP_NEAR_MIN +
      Math.random() * (P.PICKUP_NEAR_MAX - P.PICKUP_NEAR_MIN);
    const nearX = side < 0 ? refX - gap - size : refX + last.w + gap;
    x = Math.max(minX, Math.min(maxX, nearX));
    // min() 保证它绝不会出现在屏幕内 —— 红块已经下落过一截时,退回顶部生成
    y = Math.min(last.y, -size - 10);
  }

  // 机制② 游走方向:只在漂移开启时给值,关闭时固定为 0。
  // "金块会不会游走"这件事从头到尾只有一个判据 ——
  // 逻辑层据此决定推不推进 x,渲染层据此决定画不画残影,两处永远同步。
  const driftDir = (P.PICKUP_DRIFT || 0) > 0 ? (Math.random() < 0.5 ? -1 : 1) : 0;

  world.obstacles.push({
    kind: KIND.PICKUP, x, y, w: size, h: size, passed: false, driftDir,
  });
}

/* ---------- 碰撞 ---------- */
/** 轴对齐矩形重叠检测(AABB),比圆形检测更适合矩形障碍 */
function rectsOverlap(a, b) {
  return a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;
}

/** 竖直方向是否重叠 —— 擦身判定只在"擦肩那一瞬间"成立,不能全时段扫 */
function verticallyOverlap(a, b) {
  return a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 横向空隙:两块没有横向重叠时返回它们之间的间距,重叠时返回 0 */
function horizontalGap(a, b) {
  if (a.x + a.w < b.x) return b.x - (a.x + a.w);
  if (b.x + b.w < a.x) return a.x - (b.x + b.w);
  return 0;
}

/* ---------- 拾取结算 ---------- */
/**
 * 吃到金块:命没满就回命(受 MAX_HEALS 限制),命满了就折算成分数。
 * 这个分叉是刻意的 —— 它让同一个道具在"受伤时"和"满血时"价值不同,
 * 从而形成"受伤后积极抢金块"的回补行为。
 */
function applyPickup(world) {
  const P = world.params;

  // 机制② 连击链:每接住一个(无论回命还是加分)都算一次"连"。
  // 连击衡量的是"连续接住了几个",不是"得了多少分" ——
  // 所以回命也计入,让"手感连贯"和"数值奖励"始终是同一件事。
  let mul = 1;
  if (P.COMBO_ENABLED) {
    world.combo += 1;
    if (world.combo > world.comboBest) world.comboBest = world.combo;
    mul = Math.min(1 + (world.combo - 1) * P.COMBO_STEP, P.COMBO_MAX);
    world.comboMul = mul;
  }

  world.picked += 1;
  if (world.lives < P.LIVES && world.heals < P.MAX_HEALS) {
    world.lives += 1;
    world.heals += 1;
    return 'heal';
  }
  // 未开启连击时 mul 恒为 1,四舍五入后与原来的 PICKUP_SCORE 逐值相同 ——
  // 经典模式在这里一个字节的行为变化都没有。
  world.bonus += Math.round(P.PICKUP_SCORE * mul);
  return 'bonus';
}

/* ---------- 推进一帧 ---------- */
/**
 * @param {object} world
 * @param {number} dt 固定步长(秒)
 * @returns {{hit:boolean, dodged:number, graze:number, heal:boolean, bonus:boolean}}
 *          本帧事件,供场景做音效 / 震动 / 高亮反馈
 */
function step(world, dt) {
  const events = { hit: false, dodged: 0, graze: 0, heal: false, bonus: false, timeUp: false };
  if (world.over) return events;

  // 1. 存活计时
  world.elapsed += dt;

  // 1b. 限时模式(死线):时间到 = 本局结束。
  //     这是本作**唯一**一条按模式分叉的规则 —— 其余模式的差异全部只是数值。
  //     时间到与"被撞爆"是两种不同的结局,所以另开一个 timeUp 事件,
  //     让结算面板能说出"时间到!"而不是"你死了"。
  if (world.timeLimit > 0) {
    world.timeLeft = Math.max(0, world.timeLimit - world.elapsed);
    if (world.timeLeft <= 0) {
      world.over = true;
      world.timeUp = true;
      events.timeUp = true;
      world.score = finalScore(world);
      return events;
    }
  }

  // 2. 难度推进
  const diff = difficultyAt(world.elapsed, world.params);
  world.speed = diff.speed;
  world.spawnInterval = diff.interval;

  // 2b. 走廊收窄(机制③)。放在难度之后、生成之前 ——
  //     本帧新生成的障碍必须用的是**本帧已收窄后**的走廊,否则窄走廊下会漏块。
  updateLane(world);

  // 3. 玩家跟随手指(线性插值,避免瞬间吸附带来的生硬感)
  const p = world.player;
  const dx = p.targetX - p.x;
  p.x += dx * Math.min(1, dt * FOLLOW_SPEED);
  p.tilt = Math.max(-0.22, Math.min(0.22, dx * 0.004));

  // 4. 无敌倒计时与震动衰减
  if (world.invincible > 0) world.invincible = Math.max(0, world.invincible - dt);
  if (world.shake > 0) world.shake = Math.max(0, world.shake - dt * 4);

  // 5. 生成:红块按难度曲线,金块按固定节奏(先红块后金块,金块才能参考到它)
  world.spawnTimer -= dt;
  if (world.spawnTimer <= 0) {
    spawnObstacle(world);
    world.spawnTimer = world.spawnInterval;
  }

  world.pickupTimer -= dt;
  if (world.pickupTimer <= 0) {
    spawnPickup(world);
    world.pickupTimer = world.params.PICKUP_INTERVAL;
  }

  // 6. 下落 + 碰撞 + 通过判定
  const P = world.params;
  const swayWave = P.OBSTACLE_SWAY_WAVE || 0;
  const playerRect = {
    x: p.x - p.w / 2 + HITBOX_INSET,
    y: p.y - p.h / 2 + HITBOX_INSET,
    w: p.w - HITBOX_INSET * 2,
    h: p.h - HITBOX_INSET * 2,
  };
  const passLine = playerRect.y + playerRect.h;

  for (let i = world.obstacles.length - 1; i >= 0; i--) {
    const ob = world.obstacles[i];
    ob.y += world.speed * dt;

    // 机制① 摆动:横向位置是**纵向位置的函数**,不是时间的函数。
    // 这一条是整个机制能不能成立的关键(见 config.js 中 OBSTACLE_SWAY 的说明):
    // 用 y 驱动后,无论下落多快,玩家看到的永远是同一段完整波形 —— 可读、可学、可预判。
    // 速度只改变"多快走完这段波形",不改变"波形长什么样"。
    if (ob.swayAmp > 0) {
      ob.x = ob.baseX + Math.sin(ob.y * swayWave + ob.swayPhase) * ob.swayAmp;
    }

    /* ---- 金块:碰到即可拾取,且不受无敌状态影响 ---- */
    if (ob.kind === KIND.PICKUP) {
      // 机制② 游走:匀速横移,碰到走廊边界原速折返。
      // 速度**每帧按当前倍率现算**,所以连击一涨,屏幕上所有金块立刻变快 ——
      // 玩家会明确感到"我连起来了,它们开始跑了"。这个即时反馈是刻意的:
      // 它把抽象的倍率变成一个看得见的后果,也让"越贪越难追"变成身体记忆。
      if (ob.driftDir) {
        const spd = P.PICKUP_DRIFT * (P.COMBO_ENABLED ? world.comboMul : 1);
        ob.x += ob.driftDir * spd * dt;
        const lo = laneLeft(world);
        const hi = laneRight(world) - ob.w;
        if (ob.x <= lo) { ob.x = lo; ob.driftDir = 1; }
        else if (ob.x >= hi) { ob.x = hi; ob.driftDir = -1; }
      }

      if (rectsOverlap(playerRect, ob)) {
        const kind = applyPickup(world);
        world.obstacles.splice(i, 1);
        if (kind === 'heal') events.heal = true;
        else events.bonus = true;
      } else if (ob.y > world.bounds.height + 20) {
        world.obstacles.splice(i, 1);   // 没抢到,直接丢弃(无惩罚)
      }
      continue;
    }

    /* ---- 红块 ---- */
    // 碰撞(无敌期间不判定)
    if (world.invincible <= 0 && rectsOverlap(playerRect, ob)) {
      world.lives -= 1;
      world.hits += 1;              // 累计受击次数:0 次 = 本局无伤
      // 机制② 断链。注意"惩罚"不是扣分,而是**把倍率打回原点** ——
      // 玩家失去的是"接下来每个金块都能多拿一倍"的预期,
      // 这比直接扣掉已经到手的分数更让人想立刻补回来(也因此更想吃下一个)。
      world.combo = 0;
      world.comboMul = 1;
      world.invincible = P.INVINCIBLE_SECONDS;
      world.shake = 1;
      world.obstacles.splice(i, 1);   // 撞到的障碍立即消失,避免同一障碍连续扣血
      events.hit = true;
      if (world.lives <= 0) {
        world.lives = 0;
        world.over = true;
      }
      continue;
    }

    // 擦身而过:只在竖直方向重叠(即"正在擦肩")且没有撞上的那一瞬判定。
    // gap > 0 保证"横向已经重叠"的情况不会误判 —— 那种情况只可能是碰撞或无敌穿透。
    if (!ob.grazed && verticallyOverlap(playerRect, ob)) {
      const gap = horizontalGap(playerRect, ob);
      if (gap > 0 && gap <= P.GRAZE_DISTANCE) {
        ob.grazed = true;
        world.grazed += 1;
        events.graze += 1;
      }
    }

    // 整个障碍通过了玩家所在的高度线 → 记一次成功躲避
    if (!ob.passed && ob.y > passLine) {
      ob.passed = true;
      world.dodged += 1;
      events.dodged += 1;
    }

    // 移出屏幕后回收,防止数组无限增长(小游戏内存敏感)
    if (ob.y > world.bounds.height + 20) {
      world.obstacles.splice(i, 1);
    }
  }

  // 7. 计分(与 finalScore 口径必须一致)
  world.score = finalScore(world);

  return events;
}

/** 结算用的最终分数 */
function finalScore(world) {
  const P = world.params;
  return Math.floor(world.elapsed) * P.BASE_SCORE_PER_SECOND +
    world.dodged * P.DODGE_SCORE +
    world.grazed * P.GRAZE_SCORE +
    world.bonus;
}

/**
 * 某个模式在给定时长下的理论最高分:客户端自检用,
 * 口径必须与云端的 MODE_LIMITS 对齐(见 gameplay/modes.js 的 rateOf)。
 */
function theoreticalMax(duration, modeDef) {
  const def = modeDef || Modes.get(Modes.DEFAULT_MODE_ID);
  return Math.floor(def.maxScorePerSecond * duration);
}

module.exports = {
  KIND,
  FOLLOW_SPEED,
  HITBOX_INSET,
  createWorld,
  setPlayerTarget,
  step,
  finalScore,
  theoreticalMax,
  difficultyAt,
  laneLeft,
  laneRight,
  updateLane,
  spawnObstacle,
  spawnPickup,
  applyPickup,
  rectsOverlap,
  verticallyOverlap,
  horizontalGap,
};
