/**
 * 播放失败的诊断文案 + "能不能就地补救"判定 —— 纯函数（node 可单测，顶层不碰 window）
 *
 * audio 的 error 事件只告诉你「加载或解码失败」，不区分是网络音源失效还是
 * 本地文件被移走。此前一律播「音源播放出错」，用户自己清了下载目录时被支去
 * 查网络。 只改说法不改行为（调用方照旧跳下一曲）；补上第二个函数：
 * 这次失败值不值得顺手提议重下 —— 判据在这儿，怎么入队在 playRetry.js。
 */

/** MediaError.code：3=解码失败（文件在但解不开）；4=源不可用（file:// 找不到落这儿） */
const CODE_DECODE = 3;

function _name(song) {
  const s = song && typeof song === 'object' ? song : {};
  const title = String(s.title || '').trim();
  const artist = String(s.artist || '').trim();
  return title ? (artist ? `${title} - ${artist}` : title) : '未命名曲目';
}

/** 本地文件行只认 filePath：在线行有 http url，拖入行有 blob url，都不该套用「文件被移走」这套解释 */
function isLocalFileSong(song) {
  const s = song && typeof song === 'object' ? song : null;
  return !!s && typeof s.filePath === 'string' && s.filePath.trim() !== '';
}

function _isDropped(song) {
  const s = song && typeof song === 'object' ? song : {};
  return s.source === 'drop' || /^blob:/.test(String(s.url || ''));
}

/**
 * @param {object|null} song 正在播放的行（getState('currentPlaying')）
 * @param {number} [code]    audio.error.code
 * @returns {{text:string, kind:string, local:boolean}} local=true 表示锅在盘上，文案该多读几秒
 */
function describePlayError(song, code) {
  const name = _name(song);
  if (_isDropped(song)) {
    return { kind: 'warn', local: true, text: `⚠️ 拖入的临时曲目已失效：${name}，自动播放下一曲` };
  }
  if (isLocalFileSong(song)) {
    return code === CODE_DECODE
      ? { kind: 'warn', local: true, text: `📁 本地文件解不开（可能损坏或格式不支持）：${name}，自动播放下一曲` }
      : { kind: 'warn', local: true, text: `📁 本地文件读不到，可能已被移动、删除或改名：${name}，自动播放下一曲` };
  }
  return { kind: 'warn', local: false, text: '⚠️ 音源播放出错，自动播放下一曲' };
}

/**
 * 这次失败值不值得就地提议"重新下载"。
 * 三个条件缺一不可：锅在盘上（本地文件行）、文件是真从平台下下来的（有 id+source 才有源可找）、
 * 而且不是解不开（code=3 时文件还在，重下一遍还是解不开，白占带宽）。
 * 给本地曲库导入行、拖入的 blob 行一个点了必然失败的按钮，比不给按钮更糟。
 * @returns {object|null} 可重下则返回重下要带的行信息，否则 null
 */
function playFailureRetry(song, code) {
  if (code === CODE_DECODE) return null;
  if (!isLocalFileSong(song) || _isDropped(song)) return null;
  const id = song.id == null ? '' : String(song.id);
  const source = String(song.source || '');
  if (!id || !source) return null;
  // 只搬运、不设默认值：音质兜底归 enqueuePayloadFor 一家管
  return {
    id,
    source,
    title: String(song.title || ''),
    artist: String(song.artist || ''),
    album: String(song.album || ''),
    quality: String(song.quality || ''),
  };
}

/** 提议重下时的话：要把"文件不在了"和"可以重下"讲在一句里，别只重复一遍诊断 */
function playFailureRetryText(song) {
  return `📁 「${_name(song)}」已不在磁盘上，自动播放下一曲`;
}

export { CODE_DECODE, isLocalFileSong, describePlayError, playFailureRetry, playFailureRetryText };
