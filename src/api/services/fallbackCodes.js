/**
 * 触发换源的错误码集合（从 resolveTrackService.js 抽离，便于单独断言）。
 *
 * 判定原则：**「换个平台有救」才换源**。
 *   - VIP / 需登录 / 版权 / 下架 / 无音频流 / CDN 空 —— 换源可能拿到别家的免费流 ⇒ 换；
 * - 平台接口变更（PLATFORM_CHANGED，典型为酷狗反爬）—— 自家接口坏了别家还在 ⇒ 换；
 *   - 网络类错误（超时/断网）不换 —— 整体网络问题换源同样失败，只白费请求；
 *   - 未知平台不换 —— 歌本身可能不存在，换源无意义。
 */

const FALLBACK_CODES = Object.freeze(new Set([
  'VIP_REQUIRED',
  'LOGIN_REQUIRED',
  'AUTH_EXPIRED',
  'COOKIE_INVALID',
  'COPYRIGHT_RESTRICTED',
  'UNAVAILABLE',
  'NO_AUDIO_STREAM',
  'CDN_EMPTY',
  'PLATFORM_CHANGED',
]));

/**
 * 判定错误码是否值得跨源重试。
 * @param {string|null|undefined} code
 * @returns {boolean}
 */
function shouldFallbackByCode(code) {
  return !!code && FALLBACK_CODES.has(code);
}

module.exports = { FALLBACK_CODES, shouldFallbackByCode };
