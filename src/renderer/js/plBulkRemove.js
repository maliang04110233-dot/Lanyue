/**
 * 歌单详情「多选批量移除」纯函数
 *
 * 键形与 src/main/ipc/playlist.js 的 songKey 严格一致（id:source），
 * 因此勾选状态是「歌的身份」而非行号：过滤、排序、外部加歌重渲染都不丢选中。
 * 提交走既有 save-user-playlist（带 id 即整单更新），不动未勾选歌曲的
 * addedAt 与存储曲序，零新 IPC 通道。
 */

export function plSongKey(song) {
  return String(song.id) + ':' + String(song.source || '');
}

/** 纯函数：songs × 勾选键集 → { keep, removed }；空洞（null）行直接丢弃 */
export function splitBySelection(songs, keySet) {
  const set = keySet instanceof Set ? keySet : new Set(keySet || []);
  const keep = [];
  const removed = [];
  for (const s of (Array.isArray(songs) ? songs : [])) {
    if (!s) continue;
    (set.has(plSongKey(s)) ? removed : keep).push(s);
  }
  return { keep, removed };
}

/** 纯函数：一组歌的键集合（全选可见用；忽略空洞） */
export function keysOf(songs) {
  const out = new Set();
  for (const s of (Array.isArray(songs) ? songs : [])) {
    if (s) out.add(plSongKey(s));
  }
  return out;
}
