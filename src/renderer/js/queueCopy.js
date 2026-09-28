/**
 * 播放队列「📋 复制曲单」取数 —— 纯函数（node 可测，无 DOM）
 *
 * 勾选集合存的是行对象身份，不是下标：拖拽排序、批量移除都不误伤，
 * 但代价是集合里可能留着已被移出队列的陈旧身份。所以取数必须以队列为外层循环，
 * 复制出来的才始终是"现在队列里的那些歌"。
 */

/** 队列序 × 勾选身份 → 要复制的行；顺带丢掉没标题的行（否则清单里出现空行） */
function pickQueueCopyRows(queue, checked) {
  const q = (Array.isArray(queue) ? queue : []).filter(s => s && typeof s === 'object' && String(s.title || '').trim());
  const sel = checked instanceof Set ? checked
    : (Array.isArray(checked) ? new Set(checked) : null);
  const hasSel = !!(sel && sel.size);
  return { rows: hasSel ? q.filter(s => sel.has(s)) : q, scope: hasSel ? 'checked' : 'all' };
}

/** 播报必须说清复制了哪个范围：勾 3 首和整队 20 首不是一回事 */
function queueCopyToastText(count, scope) {
  return scope === 'checked'
    ? `📋 已复制勾选的 ${count} 首（歌名 - 歌手）`
    : `📋 已复制整个队列 ${count} 首（歌名 - 歌手）`;
}

export { pickQueueCopyRows, queueCopyToastText };
