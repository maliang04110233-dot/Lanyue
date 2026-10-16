/**
 * 歌单详情：播放 / 加入队列 / 下载（单曲与整单）（阶段 4，从 views/playlist.js 抽出）。
 *
 * 这一组是详情列表的动作入口，全部自包含 —— 只依赖若干纯函数模块与渲染层全局
 * （showToast / getState / setState / api / playReferer / showRedownloadToast），
 * 不回调 views/playlist.js 的任何函数，故拆出后与原文件无环。
 *
 * 原文件里的取舍说明（_playFrom 的竞态丢弃、整单入队的静默跳过等）随实现一并搬来。
 */
import { t } from '../../i18n.js';
import { errBrief } from '../../errBrief.js';
import { logger } from '../../logger.js';
import { loadAndPlay } from '../../player.js';
import { resolveQuality } from '../../quality.js';
import { buildFallbackNotice } from '../../fallbackNotice.js';
import { planSelEnqueue, enqueueSkipSuffix } from '../../plSelBatch.js';
import { plState } from './state.js';

// ── 播放歌单中的歌曲 ──────────────────────────────────
async function playPlaylistSong(idx) {
  await _playFrom(plState._currentDetailSongs, idx);
}

/** 从给定歌曲列表取流播放：整个 list 作为播放队列，从 idx 起连播 */
async function _playFrom(list, idx) {
  const songs = Array.isArray(list) ? list : [];
  const song = songs[idx];
  if (!song) { showToast(t('toast.songNotFound'), 'warn'); return; }
  const quality = resolveQuality(song.source);
  const reqId = ++plState._playlistPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== plState._playlistPlayRequestId) return; // 已点别的歌，丢弃过期结果
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast(t('toast.vipRequired'), 'warn', 5000);
      } else {
        showToast(t('toast.noSource'), 'warn', 5000);
      }
      return;
    }
    song._playedQuality = quality;
    const notice = buildFallbackNotice(result, song.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.source || song.source;
    const referer = playReferer(playSource, result);
    const proxied = await api.proxyPlay(result.url, referer, {
      id: String(result.id ?? song.id),
      source: playSource,
      quality,
    });
    if (reqId !== plState._playlistPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast(t('toast.sourceFailed'), 'error', 5000);
      return;
    }
    // 整个歌单作为播放队列，从点击的歌开始
    setState('playQueue', songs.slice());
    setState('playIdx', idx);
    // currentPlaying 驱动托盘/迷你播放器/播放器卡片，也是 audio error 守卫的前置条件
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
  } catch (e) {
    if (reqId === plState._playlistPlayRequestId) {
      logger.warn('播放失败:', e);
      showToast(t('toast.playFailed', { msg: errBrief(e) }), 'error', 4000);
    }
  }
}

// ── 添加歌单歌曲到播放队列 ─────────────────────────────
function addPlaylistSongToQueue(idx) {
  const song = plState._currentDetailSongs[idx];
  if (!song) return;
  const q = (getState('playQueue') || []).slice();
  q.push(song);
  setState('playQueue', q);
  showToast(t('toast.addedToPlayQueue'), 'success');
}

// ── 下载：单曲入队 / 整单入队（语义与搜索页 addDownload 一致）──
async function downloadPlaylistSong(idx, qualityOverride) {
  const song = plState._currentDetailSongs[idx];
  if (!song) return;
  const existing = (getState('queueSnapshot') || []).find(q =>
    q.id === song.id && q.source === song.source && q.status !== 'done');
  if (existing) { showToast(t('toast.alreadyInQueue', { title: song.title }), 'warn', 2500); return; }
  const saveDir = getState('saveDir');
  const quality = qualityOverride || resolveQuality(song.source);
  try {
    const r = await api.addToQueue({ ...song, saveDir, quality });
    if (r && r.duplicated) { showToast(t('toast.queueDup', { title: song.title }), 'warn', 2500); return; }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(song.title, r.finishedAt, () => {
        api.addToQueue({ ...song, saveDir, quality, forceRedownload: true })
          .then(() => showToast(t('toast.queueAdded', { title: song.title }), 'success'))
          .catch(e => showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error'));
      });
      return;
    }
    if (r && r.queued) showToast(t('toast.queueAdded', { title: song.title }), 'success');
    else showToast((r && r.error) || t('toast.enqueueFailed'), 'error');
  } catch (e) {
    showToast(t('toast.enqueueFailedMsg', { msg: errBrief(e) }), 'error');
  }
}

/** 「▶ 播放全部」：整单进播放队列从第一首起连播（复用 playPlaylistSong 全语义） */
async function playAllPlaylist() {
  if (!plState._currentDetailSongs.length) { showToast(t('toast.playlistEmpty'), 'warn'); return; }
  await playPlaylistSong(0);
}

async function downloadAllPlaylist() {
  const songs = plState._currentDetailSongs.slice();
  if (!songs.length) { showToast(t('toast.playlistEmpty'), 'warn'); return; }
  const saveDir = getState('saveDir');
  const { toEnqueue, skipped: inQueue } = planSelEnqueue(songs, getState('queueSnapshot') || []);
  let queued = 0, dlSkipped = 0;
  for (const song of toEnqueue) {
    try {
      // 批量场景：历史已下载且文件还在 → 静默跳过（同 downloadAlbum）
      const r = await api.addToQueue({ ...song, saveDir, quality: resolveQuality(song.source) });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    } catch (e) { logger.warn('歌单批量入队失败:', song.title, e.message); }
  }
  const msg = `歌单 ${queued} 首已加入下载队列${enqueueSkipSuffix(inQueue, dlSkipped)}`;
  showToast(msg, queued || dlSkipped ? 'success' : 'info');
}

export {
  playPlaylistSong,
  _playFrom,
  addPlaylistSongToQueue,
  downloadPlaylistSong,
  playAllPlaylist,
  downloadAllPlaylist,
};
