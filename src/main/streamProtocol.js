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
 */

const { Readable } = require('stream');
const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');
const logger = require('../utils/logger');

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
    if (!meta || !meta.url) return new Response('no stream meta', { status: 404 });

    const check = await assertPublicHttpUrl(meta.url);
    if (!check.ok) {
      logger.warn('[stream] URL 校验失败:', check.reason);
      return new Response('URL rejected', { status: 403 });
    }

    const rangeHeader = request.headers && request.headers.get
      ? request.headers.get('Range')
      : null;

    let res;
    try {
      res = await requestUpstreamFollowing(check.url, check.ips, meta.referer, rangeHeader);
    } catch (e) {
      logger.warn('[stream] 上游请求失败:', e && e.message);
      return new Response('upstream failed', { status: 502 });
    }

    // 逐跳响应也要过 SSRF 校验已被 requestUpstreamFollowing 覆盖；这里处理
    // 非 2xx：非重定向的 4xx/5xx 如实透传状态码，不伪装成音频
    if (res.statusCode >= 400) {
      res.resume();
      return new Response('upstream ' + res.statusCode, { status: res.statusCode });
    }

    const declared = parseInt(res.headers['content-length'] || '0', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      res.resume();
      return new Response('too large', { status: 413 });
    }

    const partial = res.statusCode === 206;
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
  contentTypeOf,
  contentLengthOfRange,
  registerStreamScheme,
  requestUpstream,
};
