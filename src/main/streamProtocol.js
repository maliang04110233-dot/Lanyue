/**
 * 在线播放流式代理（根因 1）
 *
 * 问题
 * ----
 * 旧路径（main/playCache.js 的 proxyPlay）把在线音频**整首 HTTP GET 落盘**，
 * 等 file.on('finish') 才返回 file:// 给 audio 元素。后果：
 *   · 整首下完之前 audio.duration 是 NaN —— 进度条和拖动全被守卫拦死
 *     （player.js 里 `if (audio.duration)` 与 `if (!audio.duration) return`）；
 *   · 30s 超时叠加 200MB 上限，长音频/慢网必然失败；
 *   · 用户点开一首歌要先等整首下载，白等。
 *
 * 也就是说"在线音源不能从中间播"并非 seek 失败，而是**下载完成前 seek 入口
 * 根本不存在**。本模块把它改回真正的流式播放。
 *
 * 做法
 * ----
 * 注册自定义 scheme `lanyue-stream`，protocol.handle 里按 Range 头转发到上游，
 * 响应以 206/200 原样喂给 audio 元素。Chromium 拿到 Content-Length + Accept-Ranges
 * 后，duration 立即可用，seek 就是一次新的 Range 请求。
 *
 * 三条必须守住的安全/正确性约束
 * --------------------------------
 * 1. SSRF 与整首下载同规格：每一跳都过 assertPublicHttpUrl，连接用
 *    makePinnedLookup 固定到已校验的 IP。渲染层可以把任意 URL 塞进这个 scheme，
 *    不校验等于给 SSRF 开后门 —— 这也是旧路径已经在做的。
 * 2. Range 头**只透传上游给的值**，解析失败就当没有 Range，绝不自己拼。
 *    自己拼一个越界 range 会让某些 CDN 返回 200 全量，白白又变回整首下载。
 * 3. 体积上限保留在**单次响应**上（沿用 200MB），不在整首歌上 ——
 *    流式之后本来就不该有整首上限的语义。
 *
 * 上游不支持 Range（返回 200）时必须如实透传 200 而不是伪造 206：
 * audio 元素遇到 200 会从头顺播，此时 seek 仍会退化为"不可用"，
 * 但那是因为这个源不支持，不是我们伪造的假象。
 *
 * 签名 URL 过期重取（D-35）
 * ----------------------
 * 会员音源的直链带签名，过期后上游一律 403。403 命中时向登记簿里的
 * refresh 回调要一条新 URL，然后**用原始请求原样重放**（方法、Range 头、
 * referer 全部沿用原值）。四条不可退让的规矩：
 *
 *   1. 判定点在拿到上游响应之后、Range 分流**之前**。只在 206 分支打补丁
 *      会漏掉首播与 HEAD —— 实测过期 URL 在七种请求形态下全部 403。
 *   2. 触发码限死 403。404/410 是资源不存在、401 是凭据问题，重取都无用。
 *   3. 重取回来的 URL 必须**重新过一次 assertPublicHttpUrl**。它是渲染层
 *      或平台插件给的，不是"自己解析出来的"就天然可信 —— 漏这一步等于开了一条
 *      "平台返回什么就请求什么"的通道。
 *   4. 403 的响应体一律 res.resume() 丢弃，绝不当音频回写给 Chromium。
 *      上游返的是 HTML 错误页，让 audio 去解码只会得到怪声。
 *
 * 重取不是跨源换源：refresh 回调由主进程用 api.getDownloadUrl 在**同一 source**
 * 内重新解析，自动兜底换源那个产品开关仍保持关闭。
 */

const { Readable } = require('stream');
const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');
const logger = require('../utils/logger');
const registry = require('./streamRegistry');

/** 流式播放用的自定义 scheme（注意与 CSP / will-navigate 白名单的关系） */
const STREAM_SCHEME = 'lanyue-stream';
/** 单次响应体积上限，沿用整首下载的 200MB */
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * 解析 Range: bytes=start-end
 *
 * 只接受单区间。CDN 的多区间（bytes=0-99,200-299）对音频播放没有意义，
 * 遇到就当没有 Range —— 宁可少一个优化，也不要拼出一个上游会拒绝的请求。
 *
 * @returns {{start:number,end:number}|null} 不可解析或非法时 null
 */
function parseRange(header, totalSize) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start;
  let end;
  if (s === '') {
    // bytes=-N：最后 N 字节
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(totalSize) || totalSize <= 0) return null;
    start = Math.max(0, totalSize - n);
    end = totalSize - 1;
  } else {
    start = Number(s);
    end = e === '' ? '' : Number(e);
  }
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== '' && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

/**
 * 归一化要透传给上游的 Range 头。
 *
 * 放行**单区间**的两种写法：
 *   · `bytes=<start>-[<end>]` —— 起点明确
 *   · `bytes=-N` —— 末尾 N 字节。**为什么不因为「判越界需要 totalSize」而拒绝**：
 *     越界与否本来就该由上游用 416 回答，而 416 在重取分支里是如实透传给
 *     Chromium 的（见 refreshUpstreamOn403 之后那段「重取成功不代表这次请求成立」）。
 *     本地猜一个 totalSize 反而会丢掉合法的 seek 请求 —— D-35 的契约是
 *     「重放必须与原请求逐字相同」，此前有一条守卫测试正是这么钉的（后缀形态）。
 *
 * 拒绝的只有：多区间（`bytes=0-99,200-299`）、畸形值、缺 `bytes=`、空。
 * 多区间对音频播放没有意义；有的 CDN 返回 multipart/byteranges，Chromium 侧
 * 表现为解码怪声甚至中断 —— 那比退化顺播更难排查。
 *
 * 宁可退化（当没有 Range ⇒ 上游返回 200 全量 ⇒ 从头顺播）也不要构造一个
 * 上游会拒绝或会误解的请求。
 *
 * @param {string|null} header Chromium 传来的 Range 头
 * @returns {string|null} 可安全透传的值；不可用时返回 null
 */
function normalizeRangeHeader(header) {
  if (!header || typeof header !== 'string') return null;
  const s = String(header).trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(s);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // bytes=-N
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    return s;
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? null : Number(rawEnd);
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  // 原样透传上游给的语义（不自己重写格式），只做合法性判定
  return s;
}

/** 内容类型 → Chromium 能识别为音频的 mime */
function contentTypeOf(res) {
  const raw = String((res.headers && res.headers['content-type']) || '').split(';')[0].trim();
  if (/^audio\//i.test(raw)) return raw;
  if (/^(application|audio)\/octet-stream$/i.test(raw)) return 'audio/mpeg';
  return raw || 'audio/mpeg';
}

/**
 * 把上游 http(s) 响应的头转成给 audio 元素的 Response 头
 * @param {boolean} partial 是否 206
 */
function buildResponseHeaders(res, partial, contentLength) {
  const h = {
    'Content-Type': contentTypeOf(res),
    'Accept-Ranges': 'bytes',
  };
  if (Number.isFinite(contentLength) && contentLength > 0) h['Content-Length'] = String(contentLength);
  if (partial) h['Content-Range'] = String(res.headers['content-range'] || '');
  return h;
}

/**
 * 向 Chromium 发起一次带 Range 的上游请求
 * @returns {Promise<import('http').IncomingMessage>} 失败时 reject
 */
function requestUpstream(u, ips, referer, rangeHeader) {
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const headers = {
    'Host': u.host,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Referer': referer || '',
  };
  // 只透传上游给的 Range 字符串，不自己拼（见头注约束 2）
  if (rangeHeader) headers.Range = rangeHeader;

  return new Promise((resolve, reject) => {
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      lookup: makePinnedLookup(ips),
      servername: u.hostname,
    }, resolve);
    req.on('error', reject);
    // 单次响应超时：流式下这是"等第一个字节"的耐心，不是整首的时限
    req.setTimeout(30000, () => { req.destroy(new Error('stream timeout')); });
  });
}

/** 跟随重定向（与整首下载同规格：逐跳校验 + 跨域清 referer） */
async function requestUpstreamFollowing(u0, ips0, referer, rangeHeader, depth = 5) {
  if (depth <= 0) throw new Error('too many redirects');
  const res = await requestUpstream(u0, ips0, referer, rangeHeader);
  const loc = res.headers && res.headers.location;
  if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
    res.resume();
    const next = new URL(loc, u0.toString()).toString();
    let nextReferer = referer;
    try {
      const nextHost = new URL(next).host;
      const refHost = referer ? new URL(referer).host : '';
      if (refHost && nextHost !== refHost) nextReferer = '';
    } catch (_e) { /* 解析失败保持原 referer */ }
    // 重定向目标同样要过 SSRF 校验，否则第一跳的校验形同虚设
    const check = await assertPublicHttpUrl(next);
    if (!check.ok) throw new Error(`URL 校验失败: ${check.reason}`);
    return requestUpstreamFollowing(check.url, check.ips, nextReferer, rangeHeader, depth - 1);
  }
  return res;
}

/**
 * 签名 URL 过期后的回源重取（D-35）
 *
 * 返回新的上游响应；拿不到新 URL / 新 URL 过不了校验 / 重取后仍失败时返回 null，
 * 由调用方落终态失败。**每一次 403 的响应体都在这里 res.resume() 丢弃** ——
 * 上游给的是 HTML 错误页，让它进 Chromium 只会变成怪声。
 *
 * @param {object} entry 登记簿条目（resolveStream 的返回值）
 * @param {object} deps  { canRefresh, markRefreshed, assertUrl }
 * @param {string} referer 原请求的 referer
 * @param {string|null} rangeHeader 原请求的 Range 头，重放时原样沿用
 * @returns {Promise<import('http').IncomingMessage|null>}
 */
async function refreshUpstreamOn403(entry, deps, referer, rangeHeader) {
  const { canRefresh, markRefreshed, assertUrl } = deps || {};
  if (typeof canRefresh !== 'function' || !canRefresh(entry)) return null;

  // 额度在这里就占用，而不是等重取成功再占。
  // 否则「重取后仍然失败」这条路永远不消耗额度，同一条流被反复请求就会
  // 反复重取 —— 那不是容错，是拿平台接口当重试队列使。
  markRefreshed(entry, null);

  let next = null;
  try {
    next = await entry.refresh();
  } catch (e) {
    logger.warn('[stream] 签名链接重取异常:', (e && e.message) || e);
    return null;
  }
  // 重取必须真的产出 URL。空结果照实失败，不拿旧 URL 再试一次（那是无限重取）
  if (!next || !next.url) return null;

  // 关键：新 URL 也要过 SSRF 校验。它来自渲染层/平台插件，
  // 不能因为「是自己解析出来的」就当作可信输入。
  let check = null;
  try {
    check = await assertUrl(next.url);
  } catch (e) {
    logger.warn('[stream] 重取 URL 校验异常:', (e && e.message) || e);
    return null;
  }
  if (!check || !check.ok) {
    logger.warn('[stream] 重取 URL 被 SSRF 校验拒绝:', check && check.reason);
    return null;
  }

  const nextReferer = next.referer !== undefined ? next.referer : referer;
  try {
    const res = await requestUpstreamFollowing(check.url, check.ips, nextReferer, rangeHeader);
    // 只有「重取回来还是 403」才算重取失败。416/404 等是对**这一次请求**
    // 的如实回答（例如 seek 越界），必须原样透传给 Chromium —— 抹成 403
    // 会让音频元素把「越界」误读成「链接过期」。
    if (res.statusCode === 403) {
      res.resume();
      return null;
    }
    // 换上新 URL，旧的已确认失效（额度已在发起时占用）
    entry.url = check.url.toString();
    if (next.referer !== undefined) entry.referer = String(nextReferer || '');
    return res;
  } catch (e) {
    logger.warn('[stream] 重取后的上游请求失败:', (e && e.message) || e);
    return null;
  }
}

/**
 * 注册流式 scheme
 *
 * @param {object} protocol Electron 的 protocol 模块
 * @param {(url:string)=>({referer?:string}|null)} resolveMeta
 *        从 lanyue-stream://… 反解出 { url, referer }。参照者信息只在
 *        取流那一刻有效，所以必须由调用方登记，本模块不持久化。
 * @returns {string} scheme 名
 */
function registerStreamScheme(protocol, resolveMeta) {
  protocol.handle(STREAM_SCHEME, async (request) => {
    const meta = await resolveMeta(request.url);
    if (!meta || !meta.url) {
      // 这一分支曾经**不写任何日志**（2026-10-13 补）。后果是它成了整个播放链路上
      // 最难查的一处：Chromium 规范化 scheme URL 后 key 查不到，就走这里 404，
      // 而主进程日志一片干净 —— 现场只能看到渲染层刷 toast，
      // 根本分不清「请求没发出来（CSP）」与「发出来了但没这条流（这里）」。
      // 记下原始 URL 与登记簿规模，两种情况一眼可辨。
      logger.warn('[stream] 登记簿里没有这条流:', request.url,
        `（登记簿现有 ${registry.streamCount()} 条）`);
      return new Response('no stream meta', { status: 404 });
    }

    // SSRF 校验：**优先复用登记时那次**（proxy-play 在 registerStream 之前已经
    // 校验过同一个 URL 并把结果带了进来）。
    //
    // 此前这里无条件再校验一次，于是同一次播放解析两次 DNS：第一次的结果被丢掉，
    // 只有第二次真正用于连接。两次往返各省 10~80ms，且在弱网下更明显。
    //
    // 复用是否削弱防护？不会：连接本来就用 makePinnedLookup(check.ips) 固定到
    // 校验时解析出的 IP，用第一次还是第二次的 IP 在连接层面等价；而固定住 IP
    // 反而更抗 DNS rebinding（域名之后被改指内网也不影响我们，因为不再重新解析）。
    //
    // 什么时候必须重新校验？上游 URL 被换过之后 —— 即 refresh 成功时
    // （streamProtocol 的 refreshUpstreamOn403 会改写 entry.url）。此时
    // entry.check 指向的是旧 URL，与当前 meta.url 不一致，必须重新走一遍。
    let check = null;
    const reusable = meta.check
      && meta.check.url
      && String(meta.check.url) === String(meta.url)
      && Array.isArray(meta.check.ips) && meta.check.ips.length;
    if (reusable) {
      check = meta.check;
    } else {
      check = await assertPublicHttpUrl(meta.url);
      if (!check.ok) {
        logger.warn('[stream] URL 校验失败:', check.reason);
        return new Response('URL rejected', { status: 403 });
      }
    }

    // Range 头**只透传上游给的值**，且必须先过 normalizeRangeHeader。
    // 头注约束 2 早就承诺「解析失败就当没有 Range，绝不自己拼」，但此前
    // parseRange 是死代码（定义了零调用点），于是多区间 / 畸形 Range 被原样
    // 打给 CDN —— 有的返回 200 全量（退化成整首下载），有的返回
    // multipart/byteranges，Chromium 侧表现为解码怪声或播放中断。
    const rawRange = request.headers && request.headers.get
      ? request.headers.get('Range')
      : null;
    const rangeHeader = normalizeRangeHeader(rawRange);

    let res;
    try {
      res = await requestUpstreamFollowing(check.url, check.ips, meta.referer, rangeHeader);
    } catch (e) {
      logger.warn('[stream] 上游请求失败:', e && e.message);
      return new Response('upstream failed', { status: 502 });
    }

    // D-35：签名 URL 过期 → 回源重取 → 用**原始 Range**重放。
    // 判定必须在 Range 分流之前：只在 206 分支打补丁会漏掉首播与 HEAD。
    if (res.statusCode === 403) {
      // 上游的错误页绝不能进 Chromium，先把这次 403 的响应体丢弃
      res.resume();
      const deps = {
        canRefresh: registry.canRefreshStream,
        markRefreshed: registry.markStreamRefreshed,
        assertUrl: assertPublicHttpUrl,
      };
      const refreshed = await refreshUpstreamOn403(meta, deps, meta.referer, rangeHeader);
      if (!refreshed) return new Response('upstream 403', { status: 403 });
      res = refreshed;
      // 重取成功不代表这一次请求就成立：越界 Range 仍会拿到 416。
      // 如实透传，落到下面那条 partial 判定之外，绝不伪造成 206/200。
      if (res.statusCode >= 400) {
        res.resume();
        return new Response('upstream ' + res.statusCode, { status: res.statusCode });
      }
    } else if (res.statusCode >= 400) {
      // 非 403 的 4xx/5xx 如实透传状态码，不伪装成音频，也不浪费一次重取
      res.resume();
      return new Response('upstream ' + res.statusCode, { status: res.statusCode });
    }

    const declared = parseInt(res.headers['content-length'] || '0', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      res.resume();
      return new Response('too large', { status: 413 });
    }

    const partial = res.statusCode === 206;
    // 每条流**首次**取用时记一笔（usedCount 由 resolveStream 累加，此处读到的是取用后
    // 的值）。为什么只记首次：seek 会不断产生新的 Range 请求，逐次记账能把日志冲垮；
    // 而「这条流第一跳拿到什么状态」才是判断链路通不通的关键那一笔。
    if (Number(meta.usedCount) === 1) {
      logger.log('[stream] 首次取用', String(meta.url).slice(0, 90),
        '->', res.statusCode, partial ? '206' : '200');
    }
    const contentLength = partial
      ? contentLengthOfRange(res.headers)
      : declared;

    let received = 0;
    let aborted = false;
    const body = new Readable({
      read() {
        if (aborted) return;
        const chunk = res.read();
        if (chunk) {
          received += chunk.length;
          if (received > MAX_BYTES) {
            // 超限就断流：已播出的部分还能听，但不再继续拉
            aborted = true;
            res.destroy();
            this.push(null);
            return;
          }
          this.push(chunk);
          return;
        }
        this.push(null);
      },
      destroy(_err, cb) { res.destroy(); cb(_err); },
    });

    return new Response(body, {
      status: partial ? 206 : 200,
      headers: buildResponseHeaders(res, partial, contentLength),
    });
  });
  return STREAM_SCHEME;
}

/** 从 Content-Range 解析这一段的长度（206 必有 Content-Range） */
function contentLengthOfRange(headers) {
  const cr = headers['content-range'];
  if (cr) {
    const span = /^bytes\s+(\d+)-(\d+)\//.exec(String(cr));
    if (span) {
      const len = Number(span[2]) - Number(span[1]) + 1;
      if (Number.isFinite(len) && len > 0) return len;
    }
  }
  const cl = parseInt(headers['content-length'] || '0', 10);
  return Number.isFinite(cl) ? cl : 0;
}

module.exports = {
  STREAM_SCHEME,
  MAX_BYTES,
  parseRange,
  normalizeRangeHeader,
  contentTypeOf,
  contentLengthOfRange,
  registerStreamScheme,
  requestUpstream,
  requestUpstreamFollowing,
  refreshUpstreamOn403,
};
