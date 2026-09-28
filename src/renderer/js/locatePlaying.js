/**
 * 定位正在播放的歌（纯匹配 + 行闪烁）
 *
 * indexOfPlaying 四级匹配：对象引用 → 平台+ID（String 归一，防 81 键漂移）
 * → filePath（本地曲库）→ 标题|歌手（trim/小写/空白折叠归一）。
 * 本文件不碰任何全局 window/document 顶层访问，flashRow 带 document 守卫。
 */

function normKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function indexOfPlaying(list, cur) {
  if (!Array.isArray(list) || !cur) return -1;
  let i = list.indexOf(cur);
  if (i >= 0) return i;
  if (cur.id != null && cur.id !== '') {
    const k = normKey(cur.source) + '|' + normKey(cur.id);
    i = list.findIndex(s => s && s.id != null && s.id !== '' &&
      normKey(s.source) + '|' + normKey(s.id) === k);
    if (i >= 0) return i;
  }
  if (cur.filePath) {
    i = list.findIndex(s => s && s.filePath === cur.filePath);
    if (i >= 0) return i;
  }
  if (normKey(cur.title)) {
    const tk = normKey(cur.title) + '|' + normKey(cur.artist);
    i = list.findIndex(s => s && normKey(s.title) + '|' + normKey(s.artist) === tk);
    if (i >= 0) return i;
  }
  return -1;
}

/** 滚到视口中央 + 描边闪 1.2s（songGroups.locateRow 同款观感） */
export function flashRow(row) {
  if (!row || typeof document === 'undefined') return false;
  if (row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.style.outline = '2px solid var(--neon-cyan)';
  setTimeout(() => { row.style.outline = ''; }, 1200);
  return true;
}

/**
 * playIdx 防漂移：声明下标处正是当前引用就信它（O(1) 快路径），
 * 否则退回 indexOfPlaying 全量匹配（队列去重/删行可能让下标错位）。
 */
export function resolvePlayingIndex(list, cur, declaredIdx) {
  if (!Array.isArray(list) || !cur) return -1;
  const d = +declaredIdx;
  if (Number.isInteger(d) && d >= 0 && d < list.length && list[d] === cur) return d;
  return indexOfPlaying(list, cur);
}
