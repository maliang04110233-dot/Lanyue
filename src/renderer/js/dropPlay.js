/**
 * 拖入音频文件即播
 *
 * dragdrop.js 此前只接管 .lrc，其余文件一律不处理；本模块补上
 * 「把资源管理器里的歌直接拖进窗口就能听」：File 经 URL.createObjectURL
 * 变 blob: 喂给 audio（CSP media-src 已放行 blob:），零新 IPC 通道。
 * 行对象标 source:'drop' + id:null —— queueFavSong 见 id 空不出红心，
 * 不会往收藏里写不可复播的脏记录。blob URL 出会话即死，
 * 故队列持久化恢复前用 sanitizeSavedQueue 滤掉拖放行并重排 playIdx
 * （在 app.js 调用侧过滤——test/player-sync 守卫 player-sync.js 零 import）。
 * 纯函数无 DOM，node 可直测。
 */

import { AUDIO_EXT_RE, splitTitleArtist } from './m3uToPlaylist.js';

export const MAX_DROP_FILES = 50;

export function isDropAudioName(name) {
  return AUDIO_EXT_RE.test(String(name || ''));
}

/**
 * 纯函数：拖入文件列表（File[]/类数组）→ { files, rows, truncated }。
 * files 为挑出的音频 File（原序，封顶 MAX_DROP_FILES），rows[i] 对应 files[i]
 * （_dropIdx 供调用方回链 File 造 blob URL）；文件名「歌手 - 歌名」自动拆分。
 */
export function planDropSongs(fileLike) {
  const picked = [];
  for (const f of Array.from(fileLike || [])) {
    if (f && isDropAudioName(f.name)) picked.push(f);
  }
  const files = picked.slice(0, MAX_DROP_FILES);
  const rows = files.map((f, i) => {
    const base = String(f.name).replace(AUDIO_EXT_RE, '').trim();
    const { artist, title } = splitTitleArtist(base);
    return {
      title: title || base,
      artist,
      source: 'drop',
      id: null,
      filePath: null,
      duration: null,
      cover: '',
      _dropIdx: i,
    };
  });
  return { files, rows, truncated: Math.max(0, picked.length - files.length) };
}

/** 纯函数：滤掉播放队列里的拖放临时行（blob URL 跨会话必成死链） */
export function filterDropRows(queue) {
  const list = Array.isArray(queue) ? queue : [];
  return list.filter((s) => !s || s.source !== 'drop');
}

/**
 * 纯函数：恢复持久化队列前消毒 {queue, playIdx}。
 * 无拖放行时原样返回同一对象（player-sync 行为零变化）；有则滤行，
 * 并把 playIdx 重映射到原当前行的新位置（原行被滤则回 0）。
 */
export function sanitizeSavedQueue(saved) {
  if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return saved;
  const q = filterDropRows(saved.queue);
  if (q.length === saved.queue.length) return saved;
  let playIdx = 0;
  const pi = saved.playIdx;
  if (typeof pi === 'number' && pi >= 0 && pi < saved.queue.length) {
    const idx = q.indexOf(saved.queue[pi]);
    if (idx >= 0) playIdx = idx;
  }
  return { ...saved, queue: q, playIdx };
}
