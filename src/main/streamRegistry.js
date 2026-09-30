/**
 * 流式播放的 URL 登记簿
 *
 * lanyue-stream://<key> 只是占位，真正的上游 URL 存在这里。
 * 为什么不把上游 URL 直接编码进 scheme URL：URL 里带签名参数会进
 * 渲染层的 src、prefetch key、devtools 历史与日志，等于把会员凭证
 * 摊在每个会打日志的地方 —— 和本仓「明文凭据只走 http 层」的纪律冲突。
 *
 * 生命周期：登记 → 播放器取用 → 淘汰。上限 20 条（与旧 playCache 的
 * LRU 50 相比更紧，因为流式不落盘，不需要留那么多历史）。
 */

const MAX_ENTRIES = 20;
const _entries = new Map(); // key -> { url, referer, at }
const STREAM_SCHEME = 'lanyue-stream';

/** key 用随机数：可枚举的顺序 id 会让"第几首歌"这种信息跟着流出去 */
function makeKey() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * 登记一条流
 * @returns {string} 放进 audio.src 的 scheme URL
 */
function registerStream(url, referer) {
  if (!url) return null;
  const key = makeKey();
  const stamp = Date.now();
  _entries.set(key, { url, referer: referer || '', at: stamp });
  if (_entries.size > MAX_ENTRIES) {
    // 插序 map：第一个即最旧
    const oldest = _entries.keys().next().value;
    _entries.delete(oldest);
  }
  return `${STREAM_SCHEME}://${key}`;
}

function resolveStream(schemeUrl) {
  const key = String(schemeUrl || '').replace(/^[a-z-]+:\/\//i, '');
  return _entries.get(key) || null;
}

function clearStreams() {
  _entries.clear();
}

function streamCount() {
  return _entries.size;
}

module.exports = {
  STREAM_SCHEME,
  MAX_ENTRIES,
  registerStream,
  resolveStream,
  clearStreams,
  streamCount,
};
