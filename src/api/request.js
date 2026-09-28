/**
 * 通用 HTTP 请求函数（带重试 + 指数退避）
 *
 * 设计要点：
 *   - 统一超时（默认 15s，可按场景覆盖）
 *   - 自动跟随重定向（最多 5 次）
 *   - GET / POST 都支持
 *   - 默认对 网络错误 / 5xx / 429 重试 2 次（指数退避 200ms → 600ms → 1800ms）
 *   - 4xx 客户端错误不重试（重试也白搭，3xx 已经在内部重定向处理）
 *
 * 不引入 axios/undici —— 项目里没有原生模块依赖，少装一个包就少一个供应链面。
 *
 * @typedef {Object} RequestOptions
 * @property {string} [method]   - 默认 GET
 * @property {Object} [headers]
 * @property {string|Buffer} [body]
 * @property {number} [timeout]  - 单次请求超时 ms，默认 15000
 * @property {number} [retries]  - 重试次数，默认 2
 * @property {number} [retryDelay] - 第一次重试延迟 ms，默认 200（之后 ×3 指数）
 */

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const { USER_AGENT } = require('../utils/userAgent');
const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');

/**
 * 日志脱敏：平台 API 常把鉴权态（authst/key/sign/data）放进 GET 查询串，
 * 全 URL 落日志等于把登录态抄送一份给日志文件/控制台。
 */
function redactUrl(u) {
  return String(u).replace(/([?&](?:data|sign|vkey|authst|key|token|cookie)=)[^&]*/gi, '$1[redacted]');
}

/** 跨 host 重定向时必须剥掉的凭证头（C2：防止 302 把登录态带往任意域） */
const CREDENTIAL_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];
function stripCredentials(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (CREDENTIAL_HEADERS.includes(k.toLowerCase())) delete out[k];
  }
  return out;
}

/** 网络层错误 / 超时 → 值得重试 */
function isRetriableError(err) {
  if (!err) return false;
  // SSRF 拦截不是网络故障：重试只会把同一个内网地址再打一遍，还正好给
  // DNS rebinding 送出时间窗。唯一正确的处置是让调用方看见并改 URL。
  if (err.ssrfBlocked) return false;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED') return true;
  if (err.message && /timeout|ECONNREFUSED|ECONNRESET|socket hang up|aborted/i.test(err.message)) return true;
  return false;
}

/** HTTP 5xx / 429 → 值得重试 */
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/** 跟着 3xx 重定向（最多 5 次，防止无限递归） */
const MAX_REDIRECTS = 5;
/** 请求超时默认值（ms）：普通 API 请求 / 音频链路探测 */
const DEFAULT_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 8000;

/**
 * SSRF 拦截的唯一错误出口。
 *
 * 为什么单独造一个：这条错误绝不能落进重试通道（见 isRetriableError）。
 * 消息前缀沿用既有的 `ssrf-blocked`，日志正则与上层判定不用跟着改。
 * 只放 origin 不放完整 URL —— 平台 API 常把鉴权态（data/sign/key）塞查询串里。
 */
function _ssrfBlocked(stage, origin, reason) {
  return Object.assign(
    new Error(`ssrf-blocked ${stage}: ${origin} (${reason})`),
    { ssrfBlocked: true },
  );
}

/**
 * 每一跳的 SSRF 闸口 —— 首跳与重定向跳共用这一处，判据同 _probeAudio。
 *
 * 过去只有 3xx 分支调它：第 0 跳（redirectCount === 0）整个裸奔，
 * 「每一跳都过 urlGuard」那句注释对首跳是假的。当时没出事，只因为全仓
 * 13 个调用点的 URL 都是硬编码平台域名；任何新增适配器（拼 HLS 分片 URL、
 * 封面代理 URL）都会原样继承这个缺口，所以把闸口下沉到每一跳的必经之路。
 *
 * @param {string} stage 'entry' | 'redirect'，只用于让日志一眼看出是哪一跳被拦
 * @returns {Promise<{ips: string[]|null}>} ips 交给 makePinnedLookup 固定连接，
 *   闭合「校验 → 连接」之间的 rebinding 窗口；skipSsrf 时为 null（不钉）。
 */
function _guardHop(url, options, stage, origin) {
  // skipSsrf 仅供本机测试服务器（与 downloader 的 skipSsrfCheck 同约定）
  if (options.skipSsrf) return Promise.resolve({ ips: null });
  return assertPublicHttpUrl(url).then((g) => {
    if (!g.ok) throw _ssrfBlocked(stage, origin, g.reason);
    return { ips: g.ips };
  });
}

/** 真正发一跳（首跳与重定向跳共用）；pinnedIps 是本跳刚跑过闸口拿到的 IP */
function _sendHop(url, options, redirectCount, parsedUrl, pinnedIps) {
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...options.headers,
      },
      timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    };
    // DNS rebinding 闭合：本跳的 guard 校验过这个域名，连接就固定用校验时的
    // IP（Host/SNI 仍是原域名），杜绝"校验→连接"之间 DNS 调包
    if (pinnedIps && pinnedIps.length) {
      reqOptions.lookup = makePinnedLookup(pinnedIps);
    }

    const req = lib.request(reqOptions, (res) => {
      // 跟随重定向（递归时也走 _followRedirects，外层 retry 不重做这次内部重定向）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let nextUrl;
        try { nextUrl = new URL(res.headers.location, url); }
        catch { return reject(new Error('非法重定向目标')); }
        // C2: 禁止 https→http 协议降级（明文链路会把凭证送出体外）
        if (parsedUrl.protocol === 'https:' && nextUrl.protocol === 'http:') {
          return reject(new Error(`拒绝协议降级重定向: ${nextUrl.origin}`));
        }
        // C2: 跨 host 重定向剥离 Cookie/Authorization —— 登录态不随 302 扩散
        if (nextUrl.hostname !== parsedUrl.hostname) {
          options = { ...options, headers: stripCredentials(options.headers || {}) };
        }
        // M8: 下一跳从 _followRedirects 起步，闸口在那一跳的入口跑 ——
        // 平台直链 302 即可把请求送进内网，入口校验拦不住后续跳。这里不
        // 再单独校验一次：同一条链路上判据只有 _guardHop 一处，首跳/后续跳
        // 不可能走出两套口径（这正是审计 P1-6 指出的缺口）。
        return _followRedirects(nextUrl.toString(), options, redirectCount + 1)
          .then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (isRetriableStatus(res.statusCode)) {
          // 5xx / 429 → 伪装成错误让外层 retry 捕获
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          err.responseBody = data;
          return reject(err);
        }
        // 4xx / 3xx（已重定向完）/ 2xx → resolve，调用方按业务判断
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    // code=ETIMEDOUT 让 isRetriableError 识别：socket 空闲超时值得重试（M4）
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })); });

    // AbortSignal 支持（M11：计费接口取消）。中止销毁 socket 走 error 路径；
    // ABORT_ERR 不在 isRetriableError 列表，外层重试不会吞掉取消语义。
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy();
        return reject(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }));
      }
      options.signal.addEventListener('abort', () => {
        req.destroy(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }));
      }, { once: true });
    }

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 发一跳：先过 SSRF 闸口，再连接。
 *
 * 校验与连接同源：拿闸口解析出的 IP 钉进 lookup，Host/SNI 仍用原域名。
 */
function _followRedirects(url, options, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`重定向次数超过上限 ${MAX_REDIRECTS}`));
  }
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) { return Promise.reject(new Error('invalid url: ' + url)); }
  return _guardHop(url, options, redirectCount === 0 ? 'entry' : 'redirect', parsedUrl.origin)
    .then(({ ips }) => _sendHop(url, options, redirectCount, parsedUrl, ips));
}

/**
 * 公开 API：带重试的请求
 *
 * SSRF：入口 URL 与之后每一跳重定向都过 urlGuard（_guardHop 是唯一闸口），
 * 被拦下时抛 ssrf-blocked 错误且**不进重试通道** —— 换个 URL 重试才有意义。
 * options.skipSsrf 仅供本机测试服务器（与 downloader 的 skipSsrfCheck 同约定）。
 *
 * @param {string} url
 * @param {RequestOptions} options
 * @returns {Promise<{status, data}|string|object>} 默认返回 {status, data} 对象
 *                                            （保持向后兼容，原代码按 JSON 解析结果取用）
 */
async function request(url, options = {}) {
  const maxRetries = options.retries ?? 2;
  const baseDelay  = options.retryDelay ?? 200;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await _followRedirects(url, options);
      // 向后兼容：原 request() 直接返回解析后的 JSON/字符串
      if (result && typeof result === 'object' && 'data' in result && 'status' in result) {
        return result.data;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const isRetriable = isRetriableError(err) || isRetriableStatus(err.statusCode);
      if (!isRetriable || attempt === maxRetries) {
        throw err;
      }
      // 指数退避：200ms → 600ms → 1800ms
      const delay = baseDelay * Math.pow(3, attempt);
      const reason = err.statusCode ? `HTTP ${err.statusCode}` : err.message;
      logger.warn(`[request] ${redactUrl(url)} 失败 (尝试 ${attempt + 1}/${maxRetries + 1})，${delay}ms 后重试: ${reason}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // 不会到这里
  throw lastErr;
}

// ── 音频直链预检 ────────────────────────────────────────────
// 用途：平台给出直链后先探一次，坏链可及早触发换源（getDownloadUrlSmart），
// 而不是把坏链交给下载器/播放器才失败。
//
// 关键约束：绝不在内存里累积音频体。
//   - 先 HEAD；CDN 不支持 HEAD（403/405/501）时退化为 GET + Range: bytes=0-1
//   - 收到响应头立即 destroy()，最多只读 1 字节（服务器忽略 Range 返回整体也安全）
const MAX_PROBE_REDIRECTS = 5;

/** 从响应头取音频体积：优先 content-range 的总长（Range 请求），否则 content-length */
function _sizeFromHeaders(h) {
  const cr = h['content-range'];
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(String(cr));
    if (m) return parseInt(m[1], 10);
  }
  const cl = h['content-length'];
  return cl ? parseInt(cl, 10) : null;
}

/** 由 content-type 推断扩展名，缺失时回落到 URL 后缀，默认 mp3（酷我主路径即 mp3） */
function _extFromMeta(contentType, url) {
  const c = String(contentType || '').toLowerCase();
  if (/flac/.test(c)) return 'flac';
  if (/mp4|m4a|aac/.test(c)) return 'm4a';
  if (/ogg|opus/.test(c)) return 'ogg';
  if (/wav|wave/.test(c)) return 'wav';
  if (/mpeg|mp3/.test(c)) return 'mp3';
  const m = /\.(mp3|flac|m4a|aac|ogg|wav)(?:$|[?#])/i.exec(String(url));
  return m ? m[1].toLowerCase() : 'mp3';
}

/**
 * 单次探测（never reject，失败也 resolve 成 { ok:false } 形态给上层判断）
 * 每一跳都过 urlGuard（M8：直链可能来自远端响应/中转站，不能默认可信）；
 * skipSsrf 仅供本机测试服务器场景（与 downloader 的 skipSsrfCheck 同约定）。
 * @returns {Promise<{status:number|null, contentType?:string, sizeBytes?:number|null, reason?:string}>}
 */
async function _probeAudio(url, method, headers, timeout, redirectLeft, skipSsrf) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: null, reason: 'invalid-url' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { status: null, reason: 'unsupported-protocol' };
  }
  let guardIps = null;
  if (!skipSsrf) {
    const guard = await assertPublicHttpUrl(url);
    if (!guard.ok) return { status: null, reason: `ssrf-blocked: ${guard.reason}` };
    guardIps = guard.ips; // 校验与连接同源：钉住本次解析出的 IP（rebinding 闭合）
  }

  return await new Promise((resolve) => {
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout,
    };
    if (guardIps && guardIps.length) reqOptions.lookup = makePinnedLookup(guardIps);

    const req = lib.request(reqOptions, (res) => {
      const status = res.statusCode || 0;

      // 直链常 302 到 CDN，跟到底（手动跟，避免 request() 的 body 累积）
      if (status >= 300 && status < 400 && res.headers.location && redirectLeft > 0) {
        res.resume();
        let nextUrl;
        try { nextUrl = new URL(res.headers.location, url); }
        catch { return resolve({ status, reason: 'invalid-redirect' }); }
        if (isHttps && nextUrl.protocol === 'http:') {
          return resolve({ status, reason: 'downgrade-blocked' });
        }
        return _probeAudio(nextUrl.toString(), method, headers, timeout, redirectLeft - 1, skipSsrf).then(resolve);
      }

      const out = {
        status,
        contentType: res.headers['content-type'] || '',
        sizeBytes: _sizeFromHeaders(res.headers),
      };
      res.destroy(); // 只要头，不读 body
      resolve(out);
    });

    req.on('error', (e) => resolve({ status: null, reason: e.message || 'error' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: null, reason: 'timeout' }); });
    req.end();
  });
}

/**
 * 音频直链可用性预检
 *
 * @param {string} url
 * @param {{headers?: Object, timeout?: number}} [opts]
 * @returns {Promise<{ok:boolean, status?:number|null, contentType?:string, sizeBytes?:number|null, ext?:string, reason?:string}>}
 */
async function testAudioLink(url, opts = {}) {
  if (!url || typeof url !== 'string') return { ok: false, status: null, reason: 'empty-url' };

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    ...(opts.headers || {}),
  };
  const timeout = opts.timeout || PROBE_TIMEOUT_MS;
  const skipSsrf = opts.skipSsrfCheck === true;

  let r = await _probeAudio(url, 'HEAD', headers, timeout, MAX_PROBE_REDIRECTS, skipSsrf);
  if (!r.status || r.status === 403 || r.status === 405 || r.status === 501) {
    r = await _probeAudio(url, 'GET', { ...headers, Range: 'bytes=0-1' }, timeout, MAX_PROBE_REDIRECTS, skipSsrf);
  }

  const status = r.status;
  if (status !== 200 && status !== 206) {
    return { ok: false, status: status || null, reason: r.reason || `HTTP ${status}` };
  }

  const ct = String(r.contentType || '').toLowerCase();
  // 无版权曲常返回 text/plain 的 "refuse request!"（酷我 antiserver 即如此）
  if (/^text\//.test(ct)) {
    return { ok: false, status, contentType: ct, reason: 'not-audio' };
  }

  return {
    ok: true,
    status,
    contentType: ct,
    sizeBytes: r.sizeBytes,
    ext: _extFromMeta(ct, url),
  };
}

module.exports = request;
// 挂在 request 函数上（module.exports 保持函数本身，不破坏既有 `request(...)` 调用）
module.exports.testAudioLink = testAudioLink;
