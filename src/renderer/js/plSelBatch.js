/**
 * 歌单详情多选「⬇ 下载已勾选 / ▶ 播放已勾选」纯函数
 *
 * 选态复用0178f20 的 plSongKey/splitBySelection（歌身份作键），这里只做
 * 批量入队前的判重规划与文案合成：判定语义与搜索页批量、整单入队一致
 * （同 id+source 且队列里未完成即跳过），抽出来后三处共用一份规则。
 * 入队走既有 addToQueue 通道，零新 IPC。
 */

/** 队列快照里已有该歌且未完成 */
export function isInQueueActive(song, queueSnapshot) {
  if (!song) return false;
  const snap = Array.isArray(queueSnapshot) ? queueSnapshot : [];
  return snap.some(q => q && q.id === song.id && q.source === song.source && q.status !== 'done');
}

/**
 * songs × 队列快照 → { toEnqueue, skipped }
 * 保序入队；空洞行丢弃；快照命中计 skipped（一次性前置判定，循环中不再复查）。
 */
export function planSelEnqueue(songs, queueSnapshot) {
  const toEnqueue = [];
  let skipped = 0;
  for (const s of (Array.isArray(songs) ? songs : [])) {
    if (!s) continue;
    if (isInQueueActive(s, queueSnapshot)) skipped++;
    else toEnqueue.push(s);
  }
  return { toEnqueue, skipped };
}

/** 批量入队 toast 的跳过说明后缀；无跳过返回空串（整单/多选两条线共用防文案漂移） */
export function enqueueSkipSuffix(inQueue, dlSkipped) {
  const parts = [];
  if (inQueue > 0) parts.push(`${inQueue} 首已在队列`);
  if (dlSkipped > 0) parts.push(`${dlSkipped} 首已下载过`);
  return parts.length ? `（跳过 ${parts.join('，')}）` : '';
}
