/**
 * 订阅新歌行「逐首下载」纯函数
 *
 * 入队语义与 playlist.js downloadPlaylistSong 对齐：payload = 歌曲原字段
 * + saveDir + quality（qualityOf 由调用方注入 resolveQuality，纯函数零依赖）。
 * 行定位用 id（字符串化比较）而非下标：主进程检查推送会整体替换 _subList，
 * 点按下标可能已指向另一首歌，id 失配宁可拒绝也不下错单。
 */

function subDlPayload(song, saveDir, qualityOf) {
  return { ...song, saveDir, quality: qualityOf(song.source) };
}

function subDlPayloadList(songs, saveDir, qualityOf) {
  return (songs || []).filter(Boolean).map(s => subDlPayload(s, saveDir, qualityOf));
}

/** 在条目 newSongs 里按 id 找歌（视图重渲染与点击之间的竞态防护） */
function subNewSongById(songs, id) {
  return (songs || []).find(s => s && String(s.id) === String(id)) || null;
}

/** 队列里是否已有同歌未完成行（pending/downloading），有则不再重复加队 */
function subActiveQueueDup(queue, song) {
  if (!Array.isArray(queue) || !song) return null;
  return queue.find(q =>
    q && q.id === song.id && q.source === song.source && q.status !== 'done') || null;
}

export { subDlPayload, subDlPayloadList, subNewSongById, subActiveQueueDup };
