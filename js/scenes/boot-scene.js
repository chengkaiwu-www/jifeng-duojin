/**
 * scenes/boot-scene.js —— 启动场景
 *
 * 职责(严格限定,不要往这里塞业务):
 *   1. 静默登录
 *   2. 预加载首屏必需资源
 *   3. 拉取远程配置 / 公告
 *   4. 资源就绪后切主页
 *
 * 进入主页的条件是"资源就绪",不是"所有请求成功"。
 * 登录失败可以走游客态,公告拉不到可以不显示,但玩家必须进得去。
 */
const cfg = require('../config/config.js');
const screen = require('../framework/screen.js');
const ui = require('../framework/ui.js');
const SceneManager = require('../framework/scene-manager.js');
const Resources = require('../framework/resource-loader.js');
const Storage = require('../framework/storage.js');

const Cloud = require('../platform/cloud.js');
const Auth = require('../platform/auth.js');
const Analytics = require('../platform/analytics.js');

/** 首屏必需资源。注意:这里只放"主页第一眼要用到"的图,其余一律后置 */
const BOOT_ASSETS = [
  // './assets/images/logo.png',
  // './assets/images/btn-bg.png',
];

let progress = 0;
let tips = '正在准备资源…';
let failed = false;
let enteredAt = 0;

/** 启动页最短停留(ms)。
 *  启动页现在承载《健康游戏忠告》(新闻出版总署强制"游戏开始画面显著位置全文登载"),
 *  而它原本只是资源加载的副产品 —— 加载快的时候 200ms 就闪过去了,等于没登载。
 *  所以给"进入主页"设一个下限:资源早就绪也要满 MIN_BOOT_MS 才走。 */
const MIN_BOOT_MS = 1500;

module.exports = {
  name: 'Boot',

  onEnter(params) {
    this.onProgress = (params && params.onProgress) || null;
    progress = 0;
    failed = false;
    tips = '正在准备资源…';
    enteredAt = Date.now();
    this.run();
  },

  /** 切主页。不早于 MIN_BOOT_MS —— extra 是各调用点自己的额外延迟 */
  goHome(extra) {
    const remain = MIN_BOOT_MS - (Date.now() - enteredAt);
    setTimeout(() => SceneManager.replace('Home'), Math.max(extra || 0, remain));
  },

  async run() {
    try {
      // ---- 步骤 1:静默登录(并行,不阻塞资源加载) ----
      tips = '正在登录…';
      const loginPromise = Auth.login();

      // ---- 步骤 2:预加载首屏资源 ----
      tips = '正在加载资源…';
      await Resources.preload(BOOT_ASSETS, (loaded, total) => {
        progress = total ? (loaded / total) * 0.8 : 0.8;
        this.report(progress);
      });

      // ---- 步骤 3:等待登录结果 ----
      const user = await loginPromise;
      if (!user) {
        tips = '离线模式';
      }

      // ---- 步骤 4:同步云端存档(有就用云端的,没有就用本地) ----
      progress = 0.9;
      this.report(progress);
      await this.syncArchive();

      // ---- 步骤 5:远程配置(失败不影响进入) ----
      Cloud.fetchRemoteConfig().then((remote) => {
        if (remote) this.applyRemoteConfig(remote);
      });

      progress = 1;
      this.report(1);

      Analytics.track('boot_complete', { logged: !!user });

      // 留一点点时间让进度条走完,避免闪烁;同时满足《健康游戏忠告》的最短登载时间
      this.goHome(120);
    } catch (e) {
      failed = true;
      tips = '加载失败,请检查网络';
      // 即使出错也让玩家进去 —— 单机玩法不依赖网络
      this.goHome(800);
    }
  },

  /** 存档同步:云端版本更高时覆盖本地,否则把本地上报上去 */
  async syncArchive() {
    try {
      const res = await Cloud.call('saveArchive', { action: 'pull' }, { retry: 0, silent: true });
      const cloudArchive = res && res.archive;
      if (cloudArchive) {
        Storage.applyCloudArchive(cloudArchive);
      } else {
        const local = Storage.loadArchive();
        Cloud.report('saveArchive', { action: 'push', archive: local });
      }
    } catch (e) {
      // 云端不可用时完全依赖本地存档,这是可接受的降级
    }
  },

  applyRemoteConfig(cfgMap) {
    // 示例:远程开关与数值。改这里可以不用重新提审就调整线上表现。
    if (cfgMap.DISABLE_RANK === true) {
      Storage.set('disable_rank', true);
    }
    if (typeof cfgMap.PATCH_VERSION === 'string') {
      Storage.set('patch_version', cfgMap.PATCH_VERSION);
    }
  },

  report(p) {
    progress = p;
    if (this.onProgress) this.onProgress(p);
  },

  onRender(alpha) {
    const ctx = screen.ctx;
    // 启动页也用同一道渐变背景 —— 它是玩家看到的第一帧,不该比后面糙
    ui.bg(ctx, screen.width, screen.height, { tint: ui.COLORS.brand });
    const cx = screen.width / 2;

    /* ---- 品牌标记:一枚发光方块 ----
     * 这一帧只有几百毫秒,但它决定了"这是个什么量级的东西"。
     * 一行黑体字开场和一枚会发光的标记开场,玩家的直觉判断完全不同 ——
     * 而这两种做法在本作里的成本是一样的(都是几笔路径,零美术资源)。 */
    const markY = screen.height * 0.30;
    ui.sprite(ctx, {
      x: cx - 52, y: markY - 52, size: 104,
      shape: 'round',
      body: failed ? ui.COLORS.danger : ui.COLORS.brand,
      accent: failed ? ui.COLORS.dangerLight : ui.COLORS.brandLight,
      glow: true,
    });

    ui.text(ctx, cfg.GAME_NAME.split('').join(' '), cx, markY + 116, {
      size: 60, color: '#ffffff', align: 'center', weight: 'bold',
    });
    ui.text(ctx, '红色的躲,金色的抢', cx, markY + 168, {
      size: ui.TYPE.body, color: ui.COLORS.textSub, align: 'center',
    });

    /* ---- 加载进度:条 + 百分比 ----
     * 百分比是这一版加的。一条进度条只说明"在走",一个确切的数字才回答
     * "还要等多久" —— 而等待的体感长短,几乎完全由后者决定。 */
    const bw = 360;
    const barY = screen.height * 0.62;
    ui.progress(ctx, {
      x: cx - bw / 2, y: barY, w: bw, h: 12,
      value: progress,
      color: failed ? ui.COLORS.danger : ui.COLORS.brand,
    });
    ui.text(ctx, Math.round(progress * 100) + '%', cx + bw / 2 + 30, barY + 6, {
      size: ui.TYPE.caption, color: ui.COLORS.textDim, align: 'center', weight: 'bold',
    });

    ui.text(ctx, tips, cx, barY + 60, {
      size: ui.TYPE.caption, color: failed ? ui.COLORS.dangerLight : ui.COLORS.textSub,
      align: 'center',
    });

    /* ---- 《健康游戏忠告》----
     * 新闻出版总署**全国强制**:必须在"游戏开始画面的显著位置"**全文**登载,
     * 且**标题 / 正文 / 语序 / 标点与官方逐字一致**。正文见 `config.HEALTH_ADVICE`。
     * ⚠️ **用 `textSub`(α=0.62)而不是 `textDim`(α=0.40)**,两个理由:
     *    ① 合规 —— 官方要求"显著位置登载",α 0.40 太暗,够不上"显著";
     *    ② 可检测 —— `textDim` 的 α 低于重叠体检的可见阈值(0.45),
     *       用了它这五行字对体检器就是**隐形**的,一旦撞了永远报不出来。
     * ⚠️ 预览页 `preview/index.html` 的 `renderBootPage()` 有一份手工镜像,改这里必须同步。 */
    const adviceLines = cfg.HEALTH_ADVICE || [];
    const adviceLineH = 30;
    const adviceTop = screen.height - screen.safeBottom - 40 -
      (adviceLines.length + 1) * adviceLineH;
    ui.text(ctx, '《健康游戏忠告》', cx, adviceTop, {
      size: ui.TYPE.eyebrow, color: ui.COLORS.textSub, align: 'center',
    });
    for (let i = 0; i < adviceLines.length; i++) {
      ui.text(ctx, adviceLines[i], cx, adviceTop + adviceLineH * 1.6 + i * adviceLineH, {
        size: ui.TYPE.caption, color: ui.COLORS.textSub, align: 'center',
      });
    }
  },

  onExit() { },
};
