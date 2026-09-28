/**
 * 「把一首歌扔回下载队列」的单一规则 —— addToQueue 载荷构造 + 回话归类
 *
 * 从 historyFilters.js 收口过来：失效历史批量重下（154）与播放失败就地重下（155）
 * 是两个消费方，载荷怎么拼、回话怎么数不许各写一份。住在历史筛选模块里当初只因第一个
 * 消费方在那儿，第二个一出现就成了错地方。
 */

/**
 * 歌曲行 → addToQueue 载荷。
 * 刻意不带 forceRedownload：判活是点击前那一刻的 stat，从确认到入队之间文件可能被同步盘
 * 放回来，那时该让主进程的查重（findDownloaded 自己核磁盘）跳过它，覆盖式重下才是错的。
 * @returns {object|null} 缺主键 ⇒ null（没有 id/source 就没有"源"可下，别造半成品载荷）
 */
function enqueuePayloadFor(song, saveDir) {
  if (!song || typeof song !== 'object') return null;
  const id = song.id == null ? '' : String(song.id);
  const source = song.source == null ? '' : String(song.source);
  if (!id || !source) return null;
  return {
    id,
    source,
    title: String(song.title || ''),
    artist: String(song.artist || ''),
    album: String(song.album || ''),
    saveDir,
    quality: song.quality || 'standard',
    cover: '',
    duration: 0,
  };
}

/** addToQueue 返回值归类（重试计数用）：dup=已在队列 / had=已下载跳过 / fail=出错 */
function classifyRetryResult(r) {
  if (!r) return 'added';
  if (r.duplicated) return 'dup';
  if (r.alreadyDownloaded) return 'had';
  if (r.error) return 'fail';
  return 'added';
}

export { enqueuePayloadFor, classifyRetryResult };
