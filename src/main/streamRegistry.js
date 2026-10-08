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
 *
 * 重取能力（D-35）
 * --------------
 * 签名 URL 会过期，过期后上游一律 403。登记簿因此额外带着一条
 * 「怎么为这条流重新拿一条 URL」的线索：refresh 回调。
 *
 * 回调是主进程侧自己实现的**同源**重解析（ipc/download.js 用
 * api.getDownloadUrl 重新取同一个 source 的同一条曲），**不是**跨源换源：
 * 自动兜底换源是 admin 明令保持关闭的产品开关，重取只解决「同一条流的
 * 链接过期了」这一个确定性问题。两者混起来会越过那条产品决策。
 */

const MAX_ENTRIES = 20;
/**
 * 单条流的重取上限。
 *
 * 取 1 是因为签名过期是**确定性**失效：实测回源重取一次即可恢复
 * （同一 Range 重放拿到 206、字节 md5 一致）。第二次仍失败就说明不是过期，
 * 是别的故障，继续重取只是把失败推迟一点。
 */
const REFRESH_LIMIT = 1;
/**
 * 条目年龄上限（毫秒）。超过这个年纪的登记项不再触发重取。
 *
 * 存在的理由：预取会在当前歌结束前十几秒就登记下一首，所以登记簿里
 * 天然混着「刚取到不久」和「会话早期取到」的条目。只有刚取到不久就 403
 * 才符合「链接刚过期」的判据；对一条登记了几小时的流重取，多半是别的问题
 * （CDN 下线、账号掉权），重取只是白打一次平台接口。
 */
const REFRESH_WINDOW_MS = 30 * 60 * 1000;

const _entries = new Map(); // key -> { url, referer, at, refresh, refreshCount }
const STREAM_SCHEME = 'lanyue-stream';

/** key 用随机数：可枚举的顺序 id 会让「第几首歌」这种信息跟着流出去 */
function makeKey() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * 登记一条流
 *
 * @param {string} url 上游直链（只进内存，绝不编进 scheme URL）
 * @param {string} [referer] 取流时的 Referer
 * @param {() => Promise<{url:string, referer?:string}|null>} [refresh]
 *        同源重取回调：签名 URL 403 时由主进程调用，拿一条新的上游 URL。
 *        缺省表示这条流没有重取能力（本地 file:// 或旧调用方），
 *        403 时如实失败，不做别的动作。
 * @returns {string} 放进 audio.src 的 scheme URL
 */
function registerStream(url, referer, refresh) {
  if (!url) return null;
  const key = makeKey();
  const stamp = Date.now();
  _entries.set(key, {
    url,
    referer: referer || '',
    at: stamp,
    refresh: typeof refresh === 'function' ? refresh : null,
    refreshCount: 0,
  });
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

/**
 * 这条流现在还能不能重取
 *
 * 三个条件缺一不可：有回调（调用方没给就是没有重取能力）、
 * 还没用掉重取额度（防无限重取）、条目还够新（见 REFRESH_WINDOW_MS）。
 * `at` 就是为此而存在 —— 它此前写入后无人读取。
 *
 * @param {object|null} entry resolveStream 的返回值
 * @param {number} [now] 便于测试注入时刻
 */
function canRefreshStream(entry, now = Date.now()) {
  if (!entry || typeof entry.refresh !== 'function') return false;
  const used = Number(entry.refreshCount) || 0;
  if (used >= REFRESH_LIMIT) return false;
  const at = Number(entry.at) || 0;
  if (!at || now - at > REFRESH_WINDOW_MS) return false;
  return true;
}

/** 重取成功后调用：占用一次额度，并换上新 URL（旧的已确认失效） */
function markStreamRefreshed(entry, next) {
  if (!entry) return entry;
  entry.refreshCount = (Number(entry.refreshCount) || 0) + 1;
  if (next && next.url) entry.url = String(next.url);
  if (next && next.referer !== undefined) entry.referer = String(next.referer || '');
  return entry;
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
  REFRESH_LIMIT,
  REFRESH_WINDOW_MS,
  registerStream,
  resolveStream,
  canRefreshStream,
  markStreamRefreshed,
  clearStreams,
  streamCount,
};
