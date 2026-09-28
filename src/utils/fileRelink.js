/**
 * 一次改名/移动的全部善后
 *
 * rename-file 只负责把磁盘文件改名的那一刻；这里负责之后所有"按路径记账"的东西：
 * 下载历史（含 assets 去重索引）、用户歌单与收藏夹、最近播放、播放进度记忆、
 * 以及歌曲旁边的 .lrc。漏掉任何一项，用户看到的都是"改个名把歌单和徽标弄坏了"。
 *
 * 规则本身在 utils/relinkRefs.js（纯函数），这里只做读写编排。
 */

const prefs = require('./prefs');
const history = require('./history');
const logger = require('./logger');
const fsa = require('./fsAsync');
const {
  pathsEqual, sidecarPathFor, relinkPlaylists, relinkProgressMap, relinkRecent,
} = require('./relinkRefs');
const { matchRenamedRefs } = require('./reconcileRenames');

/**
 * @returns {Promise<{history:number,playlists:number,recent:number,progress:number,lyricRenamed:boolean}>}
 */
async function relinkFileRefs(oldPath, newPath) {
  const out = { history: 0, playlists: 0, recent: 0, progress: 0, lyricRenamed: false };
  if (pathsEqual(oldPath, newPath)) return out;

  out.history = history.relinkPath(oldPath, newPath);

  const playlists = prefs.get('userPlaylists');
  const pr = relinkPlaylists(playlists, oldPath, newPath);
  if (pr.changed) {
    prefs.set('userPlaylists', pr.playlists);
    out.playlists = pr.changed;
  }

  const recent = prefs.get('recentlyPlayed');
  const rr = relinkRecent(recent, oldPath, newPath);
  if (rr.changed) {
    prefs.set('recentlyPlayed', rr.value);
    out.recent = rr.changed;
  }

  const progress = prefs.get('playProgressMap');
  const pm = relinkProgressMap(progress, oldPath, newPath);
  if (pm.changed) {
    prefs.set('playProgressMap', pm.map);
    out.progress = pm.changed;
  }

  // 歌词 sidecar 跟着走；新名字旁已有 .lrc 时绝不覆盖（那是用户另存过的词）
  const from = sidecarPathFor(oldPath);
  const to = sidecarPathFor(newPath);
  if (from && to && !pathsEqual(from, to) && await fsa.exists(from) && !await fsa.exists(to)) {
    try {
      await fsa.fsp.rename(from, to);
      out.lyricRenamed = true;
    } catch (e) {
      logger.warn('[relink] 歌词文件搬运失败:', e.message);
    }
  }
  return out;
}

/**
 * 曲库扫描后的外部改名对账。
 *
 * 在资源管理器里改了下载文件的 name 时，app 一无所知：徽标消失、重复下载、
 * 歌单里的本地歌播不动。扫描结果里有磁盘上真实存在的文件及其 ID3 标题/歌手，
 * 拿它跟下载历史对账，唯一命中的按"app 内改名"的同一条路回写（relinkFileRefs）。
 *
 * @param {Array<{filePath,title,artist}>} scanned 本次扫描到的歌曲
 * @returns {Promise<{fixed:number, ambiguous:number}>} fixed=接回几条；ambiguous=有候选但不唯一、放弃几条
 */
async function reconcileScannedRefs(scanned) {
  const { fixes, ambiguous } = matchRenamedRefs(history.donePathRefs(), scanned);
  let fixed = 0;
  for (const f of fixes) {
    try {
      await relinkFileRefs(f.from, f.to);
      fixed += 1;
    } catch (e) {
      logger.warn('[reconcile] 外部改名回写失败:', f.from, e.message);
    }
  }
  if (fixed) logger.info(`[reconcile] 已自动接回 ${fixed} 个被外部改名的下载文件`);
  if (ambiguous) logger.info(`[reconcile] ${ambiguous} 条记录疑似被改名但候选不唯一，未自动指认`);
  return { fixed, ambiguous };
}

module.exports = { relinkFileRefs, reconcileScannedRefs };
