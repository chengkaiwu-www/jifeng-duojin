/**
 * openDataContext/index.js —— 开放数据域(子域)
 *
 * ⚠️ 这是独立于主域的 JS 运行环境,三条铁律:
 *   1. 读不到主域的任何变量,主域也读不到这里 —— 只能靠 postMessage 通信;
 *   2. 不能使用 DOM,所有内容必须用 Canvas API 画到 sharedCanvas 上;
 *   3. 能调用的 wx API 极其有限,主要是关系链托管数据相关的那几个。
 *
 * 好友榜/群榜的完整链路:
 *   主域: wx.setUserCloudStorage 上报分数(在 platform/share.js)
 *   主域: openDataContext.postMessage 通知绘制(在 scenes/rank-scene.js)
 *   子域: wx.getFriendCloudStorage / wx.getGroupCloudStorage 读取
 *   子域: 排序后画到 sharedCanvas
 *   主域: 把 sharedCanvas 当图片 drawImage 出来
 */
const sharedCanvas = wx.getSharedCanvas();
const ctx = sharedCanvas.getContext('2d');

/* ---------- 头像缓存 ---------- */
const avatarCache = Object.create(null);

function loadAvatar(url) {
  if (!url) return null;
  if (avatarCache[url]) return avatarCache[url];
  const img = wx.createImage();
  img.src = url;
  avatarCache[url] = img;
  // 加载完成后重绘一次(否则首次绘制时头像是空的)
  img.onload = function () { redraw(); };
  return img;
}

/* ---------- 状态 ---------- */
let currentData = [];       // 排序后的榜单数据
let myOpenId = null;        // 当前用户的 openid(由主域通过 postMessage 告知)
let viewWidth = 750;
let viewHeight = 820;
let mode = 'friend';        // 'friend' | 'group'
let shareTicket = null;
let visible = false;

/* ---------- 绘制 ---------- */
const COLORS = {
  text: '#ffffff',
  sub: 'rgba(255,255,255,0.55)',
  gold: '#ffb020',
  brand: '#07c160',
  meBg: 'rgba(7,193,96,0.16)',
};

function drawText(str, x, y, opt) {
  const o = opt || {};
  ctx.save();
  ctx.font = (o.weight || '') + ' ' + (o.size || 28) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = o.color || COLORS.text;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
  ctx.restore();
}

function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawAvatar(item, x, y, size) {
  const img = loadAvatar(item.avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img && img.width) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = '#3a4655';
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function redraw() {
  if (!visible) return;

  ctx.clearRect(0, 0, viewWidth, viewHeight);

  if (!currentData.length) {
    drawText('还没有好友上榜', viewWidth / 2, viewHeight / 2 - 20, {
      size: 28, color: COLORS.sub, align: 'center',
    });
    drawText('成为第一个上榜的好友吧!', viewWidth / 2, viewHeight / 2 + 26, {
      size: 24, color: COLORS.sub, align: 'center',
    });
    return;
  }

  const rowH = 84;
  const padX = 30;
  const avatarSize = 52;

  // 表头
  drawText('好友排名', padX, 24, { size: 24, color: COLORS.sub });
  drawText('最高分', viewWidth - padX, 24, { size: 24, color: COLORS.sub, align: 'right' });

  const maxRows = Math.min(currentData.length, Math.floor((viewHeight - 60) / rowH));

  for (let i = 0; i < maxRows; i++) {
    const item = currentData[i];
    const y = 60 + i * rowH;

    // 自己所在行高亮
    if (item.openid && myOpenId && item.openid === myOpenId) {
      ctx.save();
      drawRoundRect(padX - 12, y - 6, viewWidth - (padX - 12) * 2, rowH - 14, 12);
      ctx.fillStyle = COLORS.meBg;
      ctx.fill();
      ctx.restore();
    }

    // 名次
    const rankColor = item.rank <= 3 ? COLORS.gold : COLORS.sub;
    drawText(String(item.rank), padX + 6, y + rowH / 2 - 10, {
      size: 30, color: rankColor, weight: item.rank <= 3 ? 'bold' : '',
    });

    // 头像
    drawAvatar(item, padX + 60, y + 6, avatarSize);

    // 昵称
    const name = (item.nickname || '好友');
    drawText(name.length > 8 ? name.slice(0, 8) + '…' : name, padX + 60 + avatarSize + 18, y + rowH / 2 - 10, {
      size: 28, color: COLORS.text,
    });

    // 分数
    drawText(String(item.score), viewWidth - padX, y + rowH / 2 - 10, {
      size: 32, color: COLORS.text, align: 'right', weight: 'bold',
    });
  }

  // 超出一屏时提示
  if (currentData.length > maxRows) {
    drawText('仅显示前 ' + maxRows + ' 名', viewWidth / 2, viewHeight - 26, {
      size: 22, color: COLORS.sub, align: 'center',
    });
  }
}

/* ---------- 数据处理 ---------- */
/**
 * 把托管数据(KVDataList)解析成榜单数组
 * 注意:群榜返回的数据不保证有序,必须自己排序;好友榜按分数降序返回但不含我时也要插入我。
 */
function parseRankData(rawList) {
  const arr = (rawList || []).map(function (item) {
    let score = 0;
    const kv = item.KVDataList || [];
    for (let i = 0; i < kv.length; i++) {
      if (kv[i].key === 'score') score = parseInt(kv[i].value, 10) || 0;
    }
    return {
      openid: item.openid,
      nickname: item.nickname,
      avatarUrl: item.avatarUrl,
      score: score,
    };
  });

  // 按分数降序排序
  arr.sort(function (a, b) { return b.score - a.score; });

  // 补上名次
  for (let i = 0; i < arr.length; i++) {
    arr[i].rank = i + 1;
  }
  return arr;
}

/** 计算"距离上一名还差多少分",这是排行榜最有价值的转化钩子 */
function buildCatchUpTip(arr) {
  if (!myOpenId) return null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].openid === myOpenId) {
      if (i === 0) return null;   // 已经是第一名
      const prev = arr[i - 1];
      return { target: prev.nickname, diff: prev.score - arr[i].score };
    }
  }
  return null;
}

/* ---------- 数据获取 ---------- */
function fetchFriendRank() {
  wx.getFriendCloudStorage({
    keyList: ['score', 'update_time'],
    success: function (res) {
      currentData = parseRankData(res.data);
      redraw();
    },
    fail: function () {
      currentData = [];
      redraw();
    },
  });
}

function fetchGroupRank(ticket) {
  wx.getGroupCloudStorage({
    shareTicket: ticket,
    keyList: ['score', 'update_time'],
    success: function (res) {
      currentData = parseRankData(res.data);
      redraw();
    },
    fail: function () {
      // 群榜失败时降级到好友榜,保证界面不空
      fetchFriendRank();
    },
  });
}

/* ---------- 与主域通信 ---------- */
wx.onMessage(function (msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    // 主域告知当前用户 openid,用于高亮"我"
    case 'setOpenId':
      myOpenId = msg.openid;
      break;

    case 'renderFriendRank':
      visible = true;
      mode = 'friend';
      viewWidth = msg.width || viewWidth;
      viewHeight = msg.height || viewHeight;
      sharedCanvas.width = viewWidth;
      sharedCanvas.height = viewHeight;
      fetchFriendRank();
      break;

    case 'renderGroupRank':
      visible = true;
      mode = 'group';
      shareTicket = msg.shareTicket;
      viewWidth = msg.width || viewWidth;
      viewHeight = msg.height || viewHeight;
      sharedCanvas.width = viewWidth;
      sharedCanvas.height = viewHeight;
      if (shareTicket) fetchGroupRank(shareTicket);
      else fetchFriendRank();
      break;

    case 'hide':
      // 离开榜单时清空,避免主域误显示上一帧
      visible = false;
      currentData = [];
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      break;

    default:
      break;
  }
});

console.log('[openDataContext] ready');
