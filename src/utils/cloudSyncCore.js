/**
 * WebDAV 一次同步的编排（纯逻辑，依赖注入，无 IO / 无 electron）
 *
 * 流程：拉取远端 → 与本地合并 → 推回远端 → 推成功后才回写本地。
 * 回写放在推送之后是刻意的：写失败（403/断网）时本地数据不被半途合并污染；
 * 多设备并发写用 ETag 乐观锁（见 utils/webdav.js），412 时重拉重并再推一次。
 *
 * 与 export/import 手动备份的关系：同步只覆盖可合并的三类数据
 * （歌单/下载模板/下载历史）。saveDir、审批目录等机器相关设置**不参与同步**。
 */

const { mergeSnapshotData } = require('./syncMerge');

function _envelope(data, now) {
  return {
    app: 'music-downloader',
    version: 2,
    exportedAt: new Date(now()).toISOString(),
    data,
  };
}

function _remoteDataOrThrow(remote) {
  if (!remote.exists) return {};
  const snap = remote.snapshot;
  if (!snap || snap.app !== 'music-downloader') {
    throw new Error('远端文件不是本应用的备份（app 字段不匹配），已中止');
  }
  return snap.data && typeof snap.data === 'object' ? snap.data : {};
}

/**
 * @param {Object} deps
 * @param {{url:string,user?:string,pass?:string}} deps.config
 * @param {Object} deps.localData  { userPlaylists, downloadTemplates, downloadHistory }
 * @param {Function} deps.fetchSnapshot
 * @param {Function} deps.pushSnapshot
 * @param {Function} deps.applyMerged 推成功后回写本地的钩子
 * @param {Function} [deps.now]
 */
async function syncOnce(deps) {
  const { config, localData, fetchSnapshot, pushSnapshot, applyMerged } = deps;
  const now = deps.now || (() => Date.now());
  try {
    if (!config || !config.url) throw new Error('未配置 WebDAV 同步 URL');

    const remote1 = await fetchSnapshot(config);
    let merged = mergeSnapshotData(localData, _remoteDataOrThrow(remote1));
    let put = await pushSnapshot(
      config, _envelope(merged, now),
      { etag: remote1.exists ? remote1.etag : undefined },
    );
    let conflictRetried = false;
    if (put && put.ok === false && put.conflict) {
      conflictRetried = true;
      const remote2 = await fetchSnapshot(config);
      merged = mergeSnapshotData(merged, _remoteDataOrThrow(remote2));
      // P2-4（2026-10-13 复审）：重拉之后必须**重新上锁**。
      // 旧实现这里传 {}，webdav.js 因 opts.etag 为空省略 If-Match ⇒ 无锁覆盖：
      // 若此刻还有第三台设备在写，它的修改被静默吞掉且不产生任何冲突提示
      // （最后一写赢），等于把「412 时重拉重并再推一次」的语义变成了「重推一次，
      // 不管别人刚写了什么」。既然重拉了，就拿重拉到的 ETag 当新的前置条件。
      put = await pushSnapshot(config, _envelope(merged, now),
        { etag: remote2.exists ? remote2.etag : undefined });
    }
    if (!put || put.ok !== true) throw new Error('远端快照写入未成功，已放弃回写本地');

    applyMerged(merged);
    const out = {
      success: true,
      summary: {
        playlists: merged.userPlaylists.length,
        templates: merged.downloadTemplates.length,
        historyTotal: merged.downloadHistory.length,
      },
    };
    if (conflictRetried) out.conflictRetried = true;
    return out;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { syncOnce };
