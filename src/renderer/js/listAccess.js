/**
 * 「取不到曲目」的分档口径（纯函数）
 *
 * 平台能力位（capabilities）由主进程 pluginRegistry 按「方法是否实现」推导，
 * 早已随 get-platforms 下发到渲染层 —— 所以「这个平台压根不支持展开歌单」
 * 是一件渲染层就能确定的事实，不需要新 IPC、不需要主进程改返回形状。
 *
 * 三档分开说（c65a888 的法律搬到浏览路径）：
 *   unsupported  平台没实现该方法 —— 确定事实，连请求都不该发；
 *   unavailable  平台支持但这次没取到 —— 只能说"可能"（空歌单 / 私密 / VIP / 接口变动），
 *                断言其中任一种都是新的假话；
 *   unknown      平台清单还没就绪 —— 没证据就不拦用户的路，照常取数。
 *
 * 判档与文案同一个返回值：调用方取数前问一次（决定 fetch）、取空后再问一次（决定怎么说），
 * 两次拿到的是同一个对象。同一事实只许一个家。
 */

export const EMPTY_UNSUPPORTED = 'unsupported';
export const EMPTY_UNAVAILABLE = 'unavailable';
export const EMPTY_UNKNOWN = 'unknown';

function fill(text, params) {
  if (!params) return text;
  return Object.keys(params).reduce(
    (acc, k) => acc.split('{' + k + '}').join(String(params[k])), text);
}

/**
 * 取单词条（如"歌单"/"专辑"）—— "什么算取不到词"只有这一家。
 *
 * ⚠️ i18n.t 找不到键时**返回键本身**，所以 `t(key) || 兜底` 是假兜底：
 *    词典漂移时会把 "modal.subjectPlaylist" 印到界面上。必须按 key-echo 判缺失。
 * @param {Function} [tr] (key) => string
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function term(tr, key, fallback) {
  let v = '';
  if (typeof tr === 'function') {
    try { v = tr(key) || ''; } catch (_e) { v = ''; }
  }
  return v && v !== key ? v : fallback;
}

/** 取句子词条，缺失/未初始化/i18n 抛错一律回落中文（回落串同样要插值） */
function say(tr, key, fallback, params) {
  const only = typeof tr === 'function' ? k => tr(k, params) : undefined;
  return fill(term(only, key, fallback), params);
}

/**
 * @param {object} platform 主进程下发的平台对象（含 capabilities）；未就绪时可为 undefined
 * @param {object} opts
 * @param {string} opts.capability 能力位键名（playlistSongs / albumSongs / singerSongs）
 * @param {string} [opts.subject]  文案里的名词（歌单 / 专辑 / 歌手）
 * @param {string} [opts.name]     平台显示名
 * @param {Function} [opts.tr]     取词条的函数，签名 (key, params) => string
 * @returns {{code:string, text:string, fetch:boolean}}
 */
export function listAccessHint(platform, opts = {}) {
  const { capability, subject = '歌单', name = '', tr } = opts;
  const caps = platform && typeof platform.capabilities === 'object' && platform.capabilities
    ? platform.capabilities : null;

  if (!caps) {
    return {
      code: EMPTY_UNKNOWN,
      fetch: true,
      text: say(tr, 'modal.listUnknown',
        '未取到曲目：平台信息尚未就绪或接口暂时不可用，请稍后重试'),
    };
  }

  if (caps[capability] !== true) {
    return {
      code: EMPTY_UNSUPPORTED,
      fetch: false,
      text: say(tr, 'modal.listUnsupported',
        '{name}暂不支持展开{subject}，可在搜索页逐首下载这些歌曲', { name, subject }),
    };
  }

  const base = say(tr, 'modal.listUnavailable',
    '{subject}里没有可显示的曲目：它可能是空的，也可能是私密或仅 VIP 可见', { name, subject });
  if (caps.cookie !== true) return { code: EMPTY_UNAVAILABLE, fetch: true, text: base };
  // 只对"有登录入口"的平台提这件事 —— 没有 Cookie 能力的平台听到"去登录"是新的假话
  const login = say(tr, 'modal.listNeedsLogin',
    '；若该内容需要登录，请到「设置 › 账号」粘贴 {name} 的 Cookie 后重试', { name, subject });
  return { code: EMPTY_UNAVAILABLE, fetch: true, text: base + login };
}

export default { listAccessHint, term, EMPTY_UNSUPPORTED, EMPTY_UNAVAILABLE, EMPTY_UNKNOWN };
