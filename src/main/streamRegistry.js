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
 * @param {{url:URL, ips:string[]}} [check]
 *        调用方**已经完成**的那次 SSRF 校验结果（ipc/download.js 的 proxy-play
 *        在登记前就校验过同一个 URL）。带上它是为了省掉流代理里的第二次校验 ——
 *        此前同一次播放要解析两次 DNS，而第一次的结果被丢掉了（见 streamProtocol
 *        与本文件的 lastUsed 注释）。
 *
 *        安全等价性：连接本来就用 `makePinnedLookup(check.ips)` 固定到**校验时**
 *        解析出的 IP，所以「校验一次」与「校验两次后用第二次的 IP」在连接层面
 *        等价；而固定住 IP 反而更抗 DNS rebinding（域名后续被改指内网也不影响，
 *        因为我们根本不再重新解析）。真正会改变上游 URL 的只有 refresh 回调，
 *        那条路径在 streamProtocol 里会独立重新校验。
 * @returns {string} 放进 audio.src 的 scheme URL
 */
function registerStream(url, referer, refresh, check) {
  if (!url) return null;
  const key = makeKey();
  const stamp = Date.now();
  _entries.set(key, {
    url,
    referer: referer || '',
    at: stamp,
    // lastUsed 与 at 分开：at 是「登记时刻」（决定重取额度是否还在窗口内），
    // lastUsed 是「最近一次被播放器取用」（决定淘汰顺序）。seek 会不断产生新的
    // scheme 请求 —— 每次都刷新 lastUsed，于是**正在播放的那条流不会被淘汰**。
    // 此前淘汰只看登记顺序，播放中途被淘汰就会得到 `404 no stream meta`，
    // 表现为「歌播到一半突然停住」。
    lastUsed: stamp,
    // 被取用次数：淘汰时「取用过」的条目一律优先于「还没用过」的。
    // 只靠 lastUsed 排序在同毫秒内不可靠 —— 批量登记 20 条时它们的时间戳可能
    // 完全相同，此时「谁在播」只能靠这个计数区分。
    usedCount: 0,
    check: check && check.ips && check.ips.length ? check : null,
    refresh: typeof refresh === 'function' ? refresh : null,
    refreshCount: 0,
  });
  if (_entries.size > MAX_ENTRIES) {
    // 淘汰策略（2026-10-13）：
    //   1. **绝不淘汰刚登记的这条**。这条错起来最直接 —— 调用方拿到 scheme URL
    //      立刻就 audio.src，而它若已被淘汰，protocol.handle 会回
    //      `404 no stream meta`，表现是「刚点播放就没声音」。之前第一版实现
    //      恰好踩了这个：候选池里只有它自己（其余条目都被取用过），于是它把自己
    //      删了 —— 是 test/stream-protocol.test.js 抓出来的。
    //   2. 优先淘汰**从未被取用**的条目（「预取了但没播」的登记最该回收）。
    //   3. 若每条都在用（长时间循环播放），退化为按最近取用时间淘汰最旧的那条。
    //
    // 为什么不能简单按登记顺序淘汰：正在播放的流一旦被淘汰，audio 元素下一次
    // Range 请求就会拿到 404，表现为「歌播到一半突然停住」。
    const pool = [];
    const neverUsed = [];
    for (const [k, v] of _entries) {
      if (k === key) continue;
      pool.push(k);
      if ((Number(v.usedCount) || 0) === 0) neverUsed.push(k);
    }
    const candidates = neverUsed.length ? neverUsed : pool;
    let victimKey = null;
    let victimUsed = Infinity;
    for (const k of candidates) {
      const used = Number(_entries.get(k).lastUsed) || 0;
      if (used < victimUsed) { victimUsed = used; victimKey = k; }
    }
    if (victimKey != null) _entries.delete(victimKey);
  }
  return `${STREAM_SCHEME}://${key}`;
}

/**
 * 从 scheme URL 里取出登记簿 key。
 *
 * **为什么必须归一化（2026-10-13 现场教训）**
 * --------------------------------------------------
 * registerStream 交给 audio.src 的是 `lanyue-stream://kabc`（没有尾斜杠），
 * 但 standard scheme 的 URL 会被 Chromium 规范化 —— host 之后补上 `/`，
 * 回传的 request.url 多半是 `lanyue-stream://kabc/`。key 多一个斜杠就
 * 查不到条目。
 *
 * 而查不到的后果格外隐蔽：那条 404 分支不写任何日志，于是现场表现为
 * 「所有网络歌都播不出来」+「主进程日志一片干净」—— 没有 4xx、没有告警，
 * 只有渲染层 audio 的 error 事件刷一屏 toast。上一轮修 CSP 时就被它误导过：
 * CSP 确实是真 bug（已修），但修完现象不变，因为真正挡在前面的是这一层。
 *
 * 为什么既有测试没抓到：它们全部用 `registerStream` 的**返回值原样**回查
 * （`resolveStream(k)`），而真实链路传进来的是 Chromium 规范化后的形态。
 * 测试用理想输入，于是永远绿。`?query` / `#hash` 一并截掉：key 只由 makeKey
 * 生成（`k` + 时间戳 + 随机串），不可能含这三者，截断不会误伤。
 */
function normalizeKey(schemeUrl) {
  return String(schemeUrl || '')
    .replace(/^[a-z-]+:\/\//i, '')
    .replace(/[/?#].*$/, '');
}

function resolveStream(schemeUrl) {
  const key = normalizeKey(schemeUrl);
  const entry = _entries.get(key) || null;
  // 取用即刷新 lastUsed 并累加计数：正在播放/正在 seek 的流因此不会被淘汰
  if (entry) {
    entry.lastUsed = Date.now();
    entry.usedCount = (Number(entry.usedCount) || 0) + 1;
  }
  return entry;
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
  normalizeKey,
  canRefreshStream,
  markStreamRefreshed,
  clearStreams,
  streamCount,
};
