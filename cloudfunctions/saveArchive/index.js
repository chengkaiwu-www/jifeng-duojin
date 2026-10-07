/**
 * cloudfunctions/saveArchive/index.js —— 存档同步(乐观锁)
 *
 * 要解决的唯一问题:多设备并发写导致的相互覆盖。
 * 场景:A 手机过关后同步了进度,B 手机用迟到的旧数据又覆盖回去,玩家进度倒退。
 *
 * 解法:每条存档带一个单调递增的 version。
 *       服务端只在"新 version > 库中 version"时才写入,否则拒绝并返回库中最新版,
 *       由客户端把最新版拉回去。这就是乐观锁。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const archivesCol = db.collection('archives');

const OK = (data) => ({ code: 0, data });

/** 存档体积上限,防止被塞进超大对象拖垮数据库 */
const MAX_ARCHIVE_BYTES = 32 * 1024;

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: 401, msg: 'cannot resolve openid' };

  const action = (event && event.action) || 'pull';
  const now = Date.now();

  try {
    /* ---------- 拉取存档 ---------- */
    if (action === 'pull') {
      const res = await archivesCol.where({ _openid: openid }).limit(1).get();
      const doc = res.data && res.data[0];
      return OK({
        archive: doc ? doc.data : null,
        version: doc ? doc.version : 0,
        serverTime: now,
      });
    }

    /* ---------- 推送存档(乐观锁) ---------- */
    if (action === 'push') {
      const archive = event && event.archive;
      if (!archive || typeof archive !== 'object') {
        return OK({ saved: false, reason: 'invalid_archive' });
      }

      // 体积保护
      let size = 0;
      try { size = JSON.stringify(archive).length; } catch (e) { size = MAX_ARCHIVE_BYTES + 1; }
      if (size > MAX_ARCHIVE_BYTES) {
        return OK({ saved: false, reason: 'archive_too_large' });
      }

      const version = Number(archive.cloudVersion || 0);

      const res = await archivesCol.where({ _openid: openid }).limit(1).get();
      const doc = res.data && res.data[0];

      if (!doc) {
        // 首次同步
        const initVersion = version || 1;
        await archivesCol.add({
          data: {
            _openid: openid,
            data: Object.assign({}, archive, { cloudVersion: initVersion }),
            version: initVersion,
            updatedAt: now,
          },
        });
        return OK({ saved: true, version: initVersion });
      }

      // 乐观锁核心判断:只有更新的版本才允许写入
      if (version <= (doc.version || 0)) {
        return OK({
          saved: false,
          reason: 'stale_version',
          archive: doc.data,
          version: doc.version,
        });
      }

      await archivesCol.doc(doc._id).update({
        data: {
          data: Object.assign({}, archive, { cloudVersion: version }),
          version,
          updatedAt: now,
        },
      });

      return OK({ saved: true, version });
    }

    return OK({ ignored: true });
  } catch (e) {
    console.error('[saveArchive] error', e);
    return { code: 500, msg: 'internal error' };
  }
};
