/**
 * 播放队列 → 用户歌单的纯函数。
 * 队列行本就是原始歌曲对象（url 只在取流后的 currentPlaying 上），
 * 这里只做三件事：判可持久、盖 addedAt（歌单详情「添加时间」排序依赖它）、
 * 生成带时间的默认歌单名。无 DOM / api 依赖，node 可直接单测。
 * 原 queueToSongs（无脑滤空+盖章）退役 —— 整单存为改走 pickPlSavableRows。
 */

export function defaultQueuePlaylistName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `播放队列 · ${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * 这行能不能存进歌单：drop 行是临时 blob（重启即死）；
 * 本地行靠 filePath 重播；在线行靠 id+source 取流 —— 缺键的都是死行。
 */
export function isPlSavableRow(s) {
  if (!s || !s.title) return false;
  const src = String(s.source || '');
  if (src === 'drop') return false;
  if (src === 'local') return !!s.filePath;
  return s.id != null;
}

/** 纯函数：勾选队列行 → 可持久歌单行（保序，滤死行，盖 addedAt） */
export function pickPlSavableRows(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : []).filter(isPlSavableRow).map(s => ({ ...s, addedAt: now }));
}
