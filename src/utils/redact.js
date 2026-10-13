/**
 * 日志与诊断数据的脱敏（企业级可观测性的前置条件）
 *
 * ── 为什么需要独立模块 ─────────────────────────────────────
 *
 * 平台 API 普遍把鉴权态放进 URL：网易云的 `data`/`sign`、QQ 的 `sign`/`guid`、
 * B 站的 `token`、酷狗的 `authst`/`key`…… 这些 URL 在本仓被**到处打印**：
 * downloader 的重定向与超时、soda/migu/kuwo 的直链预检、resolveTrack 的候选跳过……
 * 此前只有 `src/api/request.js` 自己带了一个局部 `redactUrl`，属于典型的
 * 「判据只在一处实现、其余调用点各自裸奔」—— 而裸奔的那些恰恰包含**下载直链**
 * （带签名、可直接下载付费内容）。
 *
 * 日志文件是要交给用户看的（报障时贴 issue），也常被顺手存进网盘或提交进工单系统。
 * 「已脱敏」必须是**系统级保证**，而不是每个调用点的自觉 —— 所以：
 *
 *   1. 本模块是唯一实现；
 *   2. `logger` 落盘前对每一行强制过一遍（调用点漏了也不会写进文件）；
 *   3. 生产环境的 error 控制台输出同样过一遍（控制台是用户复制报错的地方）。
 *
 * 开发环境（NODE_ENV !== production）不做脱敏：本地调试需要看到完整 URL 才能
 * 复现问题，而开发环境既不落盘也不面向用户。
 *
 * ── 刻意**不**脱敏的东西 ───────────────────────────────────
 *
 * sha512 / sha1 / 文件哈希 / songId / albumId —— 它们是排障的关键线索
 * （「是不是同一个文件」「latest.yml 的校验值对不对」），且本身不是凭证。
 * 过度的脱敏会让日志失去诊断价值，这同样是缺陷。
 */

/** URL 查询串里的敏感参数（大小写不敏感） */
const SENSITIVE_QUERY_KEYS = [
  'data', 'sign', 'sign_key', 'vkey', 'authst', 'key', 'token', 'access_token',
  'refresh_token', 'cookie', 'auth', 'authorization', 'password', 'passwd', 'pwd',
  'secret', 'session', 'sessionid', 'csrf', 'xsrf', 'uid', 'userid', 'guid', 'qq',
  'musicid', 'songmid', 'wsSecret', 'wssig', 'wxtoken', 'pkey', 'psig',
];

const _q = SENSITIVE_QUERY_KEYS.join('|');

/** URL 形态：`?sign=xxx&a=1` → `?sign=[redacted]&a=1` */
const RE_QUERY = new RegExp(`([?&](?:${_q})=)[^&\\s"'\`]*`, 'gi');

/**
 * 通用键值形态：`apiKey: "x"` / `"access_token":"x"` / `aiMusicApiKey=x` / `__csrf=x`
 *
 * ── 为什么用「键名 + 判断函数」而不是「键名白名单正则」─────────────────
 *
 * 前一版写成 `(前置字符)(敏感键名表)([:=])(值)`，实测在 JSON 形态上整条漏掉
 * （`{"access_token":"AT-x"}` 不匹配，而 `access_token="x"` 匹配）—— 前置字符类
 * 与引号/JSON 的组合太脆，每加一种书写形态就要补一次正则。
 *
 * 现在改成：正则只负责「切出键值对」，**判不敏感交给 isSensitiveKey**。于是
 *   - 键名匹配是通用的（任意书写形式都能切出来）
 *   - 敏感判定只有一份（下面 isSensitiveKey），与 redactValue 用的是同一个
 * 少一条规则、少一处漂移。
 */
const RE_PAIR = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,64})\1\s*([:=])\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)}\]"]+)/g;

/**
 * `Authorization: Bearer xxx` —— 值**吃到行尾**。
 *
 * 与 Cookie 分开是有原因的：早先两者共用一条规则（值只吃到空白/分号），
 * 于是 `Authorization: Bearer eyJ...` 被替换成 `Authorization: [redacted]`，
 * 而 `Bearer` 后面的令牌因为「Bearer 已被吃掉」再也匹配不到 RE_BEARER ——
 * 令牌整条留在日志里。分成两条 + 下面的顺序要求是从这个洞里学到的。
 */
const RE_HEADER_AUTH = /\b(authorization|proxy-authorization|x-auth-token)\s*[:=]\s*[^\n]+/gi;

/** `Cookie: a=b; c=d` —— 值吃到分号（Cookie 头本身是分号分隔的） */
const RE_HEADER_COOKIE = /\b(set-cookie|cookie)\s*[:=]\s*[^;\n]+/gi;

/** 裸 Bearer 令牌（不在 header 语境里出现时） */
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** `apiKey: "xxx"` / `"password":"xxx"` 这类键值形态由 RE_PAIR + isSensitiveKey 覆盖，
 *  这里不再单独维护一份键名表 —— 两份表必然漂移（前一版就漏了 aiMusicApiKey）。 */

const REDACTED = '[redacted]';

/**
 * 对任意文本做脱敏（幂等：已脱敏的内容再过一次不会变化）。
 * @param {*} input
 * @returns {string}
 */
function redactText(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : String(input);
  if (!s) return '';
  s = s.replace(RE_QUERY, `$1${REDACTED}`);
  // ⚠️ 顺序要紧：Bearer 必须在 header 规则**之前**。
  // 反过来的话，`Authorization: Bearer eyJ...` 会先被 header 规则吃掉 "Bearer"，
  // 剩下的令牌就再也匹配不到 RE_BEARER —— 实测正是这样漏出去的。
  s = s.replace(RE_BEARER, `Bearer ${REDACTED}`);
  s = s.replace(RE_HEADER_AUTH, (_m, key) => `${key}: ${REDACTED}`);
  s = s.replace(RE_HEADER_COOKIE, (_m, key) => `${key}: ${REDACTED}`);
  // 键值对：正则切出键名，是否敏感交给 isSensitiveKey（唯一判定处）
  s = s.replace(RE_PAIR, (m, q1, key, sep) => (
    isSensitiveKey(key) ? `${q1}${key}${q1}${sep}${REDACTED}` : m
  ));
  return s;
}

/**
 * 只脱敏 URL 的查询串（保留路径与来源信息，便于定位是哪个接口）。
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  if (url == null) return '';
  return String(url).replace(RE_QUERY, `$1${REDACTED}`);
}

/**
 * 对象深度脱敏（诊断包里的偏好摘要用）。
 *
 * 规则：
 *   - 键名命中敏感词（不区分大小写、下划线/连字符等价）⇒ 整个值替换为 [redacted]
 *   - 其余值按类型递归；字符串同样过一遍 redactText
 *   - 深度上限 6 层、数组上限 50 项，防环形引用与超大对象
 *
 * @param {*} value
 * @param {{depth?:number}} [opts]
 */
function redactValue(value, opts = {}) {
  const depth = opts.depth || 0;
  if (depth > 6) return '[深度截断]';
  if (value == null) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') return redactText(value);
  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((v) => redactValue(v, { depth: depth + 1 }));
    if (value.length > 50) head.push(`…（共 ${value.length} 项）`);
    return head;
  }
  if (t === 'object') {
    const out = {};
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      if (i++ >= 100) { out['…'] = '（键数截断）'; break; }
      out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, { depth: depth + 1 });
    }
    return out;
  }
  return REDACTED;   // function / symbol / bigint：诊断里没有价值
}

/**
 * 键名是否敏感（cookie / token / key / pass / secret / 凭证类）。
 *
 * 这一处是 redactText 与 redactValue **共用的唯一判定**，所以「哪些键算敏感」
 * 只有一份定义。正则必须是**包含**匹配而不是精确匹配：本仓真实存在的键名是
 * `aiMusicApiKey` / `mcpToken` / `refresh_token` 这类带前缀/带修饰的形态，
 * 精确匹配会把它们全部漏掉。
 */
function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[-_]/g, '');
  if (k === 'cookies' || k === 'cookie') return true;
  if (/(token|secret|password|passwd|pwd|apikey|credential|privatekey|session|csrf|xsrf)/.test(k)) return true;
  // 平台签名参数里**独特**的那些：非 URL 上下文（配置片段、日志中间串）里
  // 出现 `sign=xxx` / `authst=xxx` 同样是鉴权态，必须抹。
  // 刻意**不含** data / key / uid：这三个词在正常日志里太常见（`data=data`、
  // `key=title`、`uid=1`），脱敏它们会让日志被大量 [redacted] 淹没 ——
  // 过度脱敏同样是缺陷。URL 形态的这些参数由 RE_QUERY 覆盖（那里有 ?/& 锚点，
  // 不会误伤）。
  if (/(sign|authst|vkey|psig|pkey|wssig)/.test(k)) return true;
  // …Key 即视为凭证（如 apiKey / musicKey / sessionKey）
  if (k === 'key') return false;            // 单字 key 太常见：`排序 key=title`
  return k.endsWith('key') && !/monkey|hotkey/.test(k);
}

module.exports = {
  redactText,
  redactUrl,
  redactValue,
  isSensitiveKey,
  SENSITIVE_QUERY_KEYS,
  REDACTED,
};
