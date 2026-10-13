/**
 * 取流失败的统一分类（2026-10-13）
 *
 * ── 为什么需要它（全部来自对 8 个平台的逐一取证）──────────────────
 *
 * 1. **分类只存在于一半的平台**：netease / qq 走 `AppError` + `ERROR_CODES`，
 *    其余 6 家（kuwo/migu/soda/fivesing/kugou）是手写字面量。字符串与码表
 *    「字面相同但无引用关系」—— 改码表不会让它们编译失败，只会静默漂移。
 *
 * 2. **`fatal` 语义在同一 code 上不一致**：kugou 的版权限制是 `fatal:false`
 *    （会进重试循环白重试），netease 的同类是 `fatal:true`（队列直接短路）。
 *    队列的行为由平台各自手写的 fatal 决定，而不是由 code 派生。
 *
 * 3. **kugou 的网络异常分支 `return { error: e.message }` 既无 code 也无
 *    fatal** —— 既不换源也不判 fatal，是取流成功率上的一个黑洞。
 *
 * 4. **8 个平台都没有透出 HTTP status**（实测 grep：只有 soda/migu 在预检里看过
 *    `probe.status`，也没写进返回值）。于是「这是不是 CDN 签名过期（403）」这个
 *    最该触发换源的信息，在插件层就丢了；`resolveTrackService` 里那条专门为它写的
 *    `/HTTP\s*(403|404|410)/i` 文本匹配，实际几乎永不命中 —— 一个为「换源」预留的
 *    出口就这么白挂着。
 *
 * ── 设计原则：增量，不替换 ─────────────────────────────────────
 *
 * 本模块**不接管**既有的 `shouldFallbackByCode` 白名单判定，只做两件加法：
 *   · 给出与平台无关的 `category`（供 UI 选文案、供健康度记账）
 *   · 补上 `expiredLink` 这个此前完全缺失的出口（403/404/410）
 *
 * 平台**没有透出 status** 时，一切行为与改造前逐字节一致 —— 所以这项改动
 * 对现有 8 个平台是零回归的，收益随着平台逐个接入而累积。
 */

const { ERROR_CODES } = require('../../shared/errors');

/** 失败类别（与 code 解耦：同一类别可由多个 code 表达） */
const CATEGORY = {
  AUTH: 'auth',        // 登录态问题：重试无用；该引导登录，或换源
  PAYWALL: 'paywall',  // VIP / 版权墙：换源有意义
  EXPIRED: 'expired',  // 链接或签名过期：换源 + 同源重取都有意义
  DEAD: 'dead',        // 资源不存在（下架 / 已删除）：换源有意义，重取无意义
  GEO: 'geo',          // 地区限制（B 站常见）：换源有意义
  NETWORK: 'network',  // 网络 / 传输故障：重试有意义
  UNKNOWN: 'unknown',
};

/** code → category（码表是唯一事实来源，平台手写字面量也按同名字符串对上） */
const CODE_CATEGORY = new Map([
  [ERROR_CODES.AUTH_EXPIRED, CATEGORY.AUTH],
  [ERROR_CODES.LOGIN_REQUIRED, CATEGORY.AUTH],
  [ERROR_CODES.COOKIE_INVALID, CATEGORY.AUTH],

  [ERROR_CODES.VIP_REQUIRED, CATEGORY.PAYWALL],
  [ERROR_CODES.COPYRIGHT_RESTRICTED, CATEGORY.PAYWALL],

  [ERROR_CODES.UNAVAILABLE, CATEGORY.DEAD],
  [ERROR_CODES.NO_AUDIO_STREAM, CATEGORY.DEAD],
  [ERROR_CODES.CDN_EMPTY, CATEGORY.DEAD],

  [ERROR_CODES.NETWORK_TIMEOUT, CATEGORY.NETWORK],
  [ERROR_CODES.NETWORK_ERROR, CATEGORY.NETWORK],

  [ERROR_CODES.PLATFORM_CHANGED, CATEGORY.UNKNOWN],
  [ERROR_CODES.UNKNOWN_PLATFORM, CATEGORY.UNKNOWN],
]);

/** 平台手写的、码表里没有但语义明确的 code（取证时逐个平台收集） */
const EXTRA_CODE_CATEGORY = new Map([
  ['PLATFORM_BUSY', CATEGORY.NETWORK],
  ['FETCH_FAILED', CATEGORY.NETWORK],
  ['BAD_PARAMS', CATEGORY.UNKNOWN],
  ['BAD_RESPONSE', CATEGORY.UNKNOWN],
]);

/**
 * 值得跨源换源的 HTTP 状态。
 *
 * 403 是 CDN 签名过期的主形态（实测：网易云/QQ/B 站的取流直链过期后一律 403），
 * 换源通常能立刻拿到一条新链；404/410 是资源已不存在，换别的源也许还有。
 * **不能**包括 5xx/429 —— 那是服务端自己的问题，换源同样会打在同一批服务上。
 */
const FALLBACK_HTTP_STATUSES = new Set([403, 404, 410]);

function categoryOfCode(code) {
  if (!code) return null;
  return CODE_CATEGORY.get(code) || EXTRA_CODE_CATEGORY.get(code) || null;
}

/**
 * 由 HTTP 状态推断类别（仅在 code 缺失或与状态冲突时起补充作用）。
 * @param {number|null} status
 * @returns {string|null}
 */
function categoryOfStatus(status) {
  if (status === 403) return CATEGORY.EXPIRED;   // 多数平台里 403 = 签名/登录态问题
  if (status === 404 || status === 410) return CATEGORY.DEAD;
  if (status === 401) return CATEGORY.AUTH;
  if (status === 429) return CATEGORY.NETWORK;   // 限流：等一下就好，换源也限流
  if (status >= 500) return CATEGORY.NETWORK;
  return null;
}

/**
 * category → 规范 code（2026-10-13）
 *
 * **为什么需要反向映射**：下游认的是 code，不是 category。
 *   · 渲染层诊断（diagnose.js）只认 ERROR_CODES：徽标查 DIAG_TABLE、
 *     批量重试查 AUTH_CODES，两者都拿 errorCode 当键；
 *   · 换源判定（resolveTrackService ← fallbackCodes）同样按 code 走白名单。
 * 而平台**没给 code** 的失败是常态 —— safeRun 折叠出的 `{error:'平台X取流异常'}`
 * 就没有 code，403 更是被 request() 直接 resolve 掉、压根不产生错误对象。
 * 于是 errorCode 一路为空：行内不戴徽标、弹层只能按关键词猜，
 * 最麻烦的是 `isAuthFailure('INFERRED')` 为假 ⇒ 「一键重试可恢复任务」
 * 会把 Cookie 失效这种重试一万次也没用的任务挨个重试一遍，纯空转。
 *
 * 只补**平台没给**的码（与 fatal 同一策略），平台自己的判断永远优先；
 * 因此平台已经发了 code 时本映射完全不起作用，既有行为不变。
 *
 * 映射出的每个码都必须已在 DIAG_TABLE 登记 —— test/diagnose-coverage.test.js
 * 会扫本文件的 `code:'…'` 字面量去反查码表，漏登记直接红。
 */
const CATEGORY_CODE = new Map([
  [CATEGORY.AUTH,    ERROR_CODES.COOKIE_INVALID],
  [CATEGORY.PAYWALL, ERROR_CODES.VIP_REQUIRED],
  [CATEGORY.DEAD,    ERROR_CODES.UNAVAILABLE],
  // 403 签名过期：重取一次直链通常就好，故归到「当前不可用」而非编造新码
  [CATEGORY.EXPIRED, ERROR_CODES.UNAVAILABLE],
  [CATEGORY.GEO,     ERROR_CODES.COPYRIGHT_RESTRICTED],
  [CATEGORY.NETWORK, ERROR_CODES.NETWORK_ERROR],
]);

/** 该类别下「重试是否可能成功」 */
function retryableOf(category) {
  return category === CATEGORY.NETWORK;
}

/**
 * 该类别下 fatal 应为何值（仅在平台没给 fatal 时作为缺省）。
 *
 * 为什么缺省倾向 fatal:true：重试只在「换 URL 可能拿到新直链」时才有意义
 * （HTTP 403/404/410）。VIP 墙、地区限制、接口变更、网络故障——换 URL 重试
 * 都不会变好，与其白跑 maxAttempts 次，不如立刻告诉用户真正的原因。
 */
function defaultFatalOf(category) {
  return category !== CATEGORY.NETWORK && category !== CATEGORY.UNKNOWN;
}

/**
 * 归一化一次取流失败。
 *
 * @param {Object} result 平台返回的原始结果（{error?, code?, fatal?, status?, url?}）
 * @param {{platform?:string, httpStatus?:number|null}} [opts]
 *        httpStatus：调用方若已知道 HTTP 状态（如预检拿到的 probe.status）可传入
 * @returns {{code:?string, status:?number, category:string, fatal:boolean,
 *            retryable:boolean, expiredLink:boolean, isFailure:boolean}}
 */
function classifyStreamError(result, opts = {}) {
  const raw = (result && typeof result === 'object') ? result : {};
  const hasUrl = typeof raw.url === 'string' && raw.url.length > 0;
  const hasError = typeof raw.error === 'string' && raw.error.length > 0;
  if (hasUrl && !hasError) {
    return {
      code: null, status: null, category: 'ok',
      fatal: false, retryable: false, expiredLink: false, isFailure: false,
    };
  }

  const code = typeof raw.code === 'string' && raw.code ? raw.code : null;
  const status = toStatus(raw.status != null ? raw.status : opts.httpStatus);
  // 优先级：显式 code → HTTP 状态 → 文本兜底。显式 code 最可信（平台最了解上下文），
  // 但当 code 与状态明显冲突时（如 code=NETWORK_ERROR 而 status=403），信状态 ——
  // 因为 403 在这批平台里几乎总是「这条链不能用了」。
  let category = categoryOfCode(code);
  const byStatus = categoryOfStatus(status);
  if (byStatus && (status === 403 || status === 404 || status === 410 || !category)) {
    category = byStatus;
  }
  if (!category) category = categoryOfText(raw.error);

  return {
    code,
    status,
    category: category || CATEGORY.UNKNOWN,
    fatal: raw.fatal === undefined ? defaultFatalOf(category) : !!raw.fatal,
    retryable: retryableOf(category),
    // 此前完全缺失的出口：换源机制据此认出「这条链只是过期了」
    expiredLink: status === 403,
    isFailure: true,
  };
}

/** 平台错误文案兜底分类（只有 code 与 status 都缺失时才用） */
function categoryOfText(error) {
  const s = String(error || '');
  if (!s) return null;
  if (/cookie|登录|鉴权|未登录|unauthor/i.test(s)) return CATEGORY.AUTH;
  if (/vip|会员|付费|版权|购买/i.test(s)) return CATEGORY.PAYWALL;
  if (/地区|区域|限制|geo|blocked/i.test(s)) return CATEGORY.GEO;
  if (/超时|timeout|ECONN|网络|ENOTFOUND|aborted|socket/i.test(s)) return CATEGORY.NETWORK;
  if (/下架|不可用|不存在|已移除/i.test(s)) return CATEGORY.DEAD;
  return null;
}

function toStatus(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}

/**
 * 把分类结果**附加**到平台返回值上（不覆盖任何既有字段）。
 * @param {Object} result
 * @param {{platform?:string, httpStatus?:number|null}} [opts]
 */
function annotateStreamError(result, opts = {}) {
  const info = classifyStreamError(result, opts);
  if (!info.isFailure) return result;
  const out = (result && typeof result === 'object') ? { ...result } : {};
  out.category = info.category;
  if (info.status != null && out.status == null) out.status = info.status;
  // fatal 只在平台**没给**时才补（平台的显式判断优先，避免改变既有行为）
  if (out.fatal === undefined) out.fatal = info.fatal;
  // code 同理：平台没给时才由类别补一个下游认得的码（见 CATEGORY_CODE 注释）。
  // 这一步是让「鉴权类不进批量重试」与「行内戴徽标」真正生效的前提 ——
  // 没有 code，渲染层拿到的 errorCode 是空的，两套表都查不到它。
  if (!out.code) {
    const inferred = CATEGORY_CODE.get(info.category);
    if (inferred) out.code = inferred;
  }
  return out;
}

module.exports = {
  CATEGORY,
  classifyStreamError,
  annotateStreamError,
  categoryOfCode,
  categoryOfStatus,
  categoryOfText,
  CATEGORY_CODE,
  FALLBACK_HTTP_STATUSES,
  CODE_CATEGORY,
  EXTRA_CODE_CATEGORY,
};
