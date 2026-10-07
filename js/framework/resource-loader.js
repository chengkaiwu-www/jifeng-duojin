/**
 * framework/resource-loader.js —— 资源加载与缓存
 *
 * 覆盖小游戏的三种资源来源:
 *   1. 本地包内图片(assets/)
 *   2. 分包(按需下载后加载,不计入主包体积)
 *   3. 远程 CDN 图片(完全不受包体限制)
 *
 * 关键约束:小游戏加载图片只能用 wx.createImage()(即 Image 对象),
 * 没有 DOM,也不能用 new Image() 之外的方式。
 */
const Logger = require('../utils/logger.js');

const cache = Object.create(null);      // url -> Image
const pending = Object.create(null);    // url -> Promise,做并发去重
const loadedSubpackages = Object.create(null);

/** 加载单张图片 */
function loadImage(url) {
  if (cache[url]) return Promise.resolve(cache[url]);
  if (pending[url]) return pending[url];   // 同一张图被多处请求时只下载一次

  pending[url] = new Promise((resolve, reject) => {
    const img = wx.createImage();
    img.onload = () => {
      cache[url] = img;
      delete pending[url];
      resolve(img);
    };
    img.onerror = (err) => {
      delete pending[url];
      Logger.warn('image load failed:', url, err);
      reject(new Error('image load failed: ' + url));
    };
    img.src = url;
  });

  return pending[url];
}

module.exports = {
  /**
   * 批量预加载,带进度回调。
   * 单张失败不会中断整体流程 —— 首页缺一张图不应该阻塞进游戏。
   * @param {string[]} urls
   * @param {(loaded:number,total:number)=>void} [onProgress]
   */
  preload(urls, onProgress) {
    const list = urls || [];
    const total = list.length;
    if (!total) return Promise.resolve({ ok: 0, fail: 0 });

    let done = 0, ok = 0, fail = 0;
    return Promise.all(list.map((u) => loadImage(u).then(
      () => { ok++; done++; if (onProgress) onProgress(done, total); },
      () => { fail++; done++; if (onProgress) onProgress(done, total); }
    ))).then(() => ({ ok, fail }));
  },

  /** 取已缓存的图片(渲染时用,返回 null 表示还没加载好) */
  get(url) {
    return cache[url] || null;
  },

  /**
   * 加载分包。首次调用会下载分包代码,之后直接返回缓存结果。
   * 用法:进入玩法场景前 await ResourceLoader.loadSubpackage('play')
   * @param {string} name  game.json 中 subpackages[].name
   */
  loadSubpackage(name) {
    if (loadedSubpackages[name]) return loadedSubpackages[name];

    loadedSubpackages[name] = new Promise((resolve, reject) => {
      const task = wx.loadSubpackage({
        name,
        success: () => {
          Logger.log('subpackage loaded:', name);
          resolve(true);
        },
        fail: (err) => {
          Logger.warn('subpackage load failed:', name, err);
          delete loadedSubpackages[name];
          reject(err);
        },
      });
      // 如需在界面上展示分包下载进度,监听这里
      if (task && typeof task.onProgressUpdate === 'function') {
        task.onProgressUpdate((res) => {
          Logger.log('subpackage progress:', name, res.progress + '%');
        });
      }
    });

    return loadedSubpackages[name];
  },

  /** 从远程 CDN 下载文件到本地临时路径(大资源走这条路,不计入包体) */
  download(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200) resolve(res.tempFilePath);
          else reject(new Error('download status ' + res.statusCode));
        },
        fail: reject,
      });
    });
  },

  /** 释放内存:场景切换时对不再需要的大图调用,防止内存持续上涨 */
  release(url) {
    if (cache[url]) {
      cache[url].src = '';   // 断开底层引用,帮助 GC 回收
      delete cache[url];
    }
  },

  releaseAll() {
    Object.keys(cache).forEach((u) => module.exports.release(u));
  },

  getStats() {
    return { cached: Object.keys(cache).length, pending: Object.keys(pending).length };
  },
};
