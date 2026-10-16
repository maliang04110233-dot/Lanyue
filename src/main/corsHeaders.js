/**
 * CORS 响应头白名单（本工程唯一的安全边界）。
 *
 * 从 main/index.js 拆出（阶段 3 主进程模块化）：它决定哪些源能拿到非 null 的
 * Access-Control-Allow-Origin。白名单 = 本地来源 + 各平台 manifest 声明的域名
 * （派生）。改变动后必须与历史枚举逐条相等，由 test/platform-contract.test.js
 * 的集合相等断言守住（不允许新增项）。
 *
 * 部分平台的 CDN 子域是动态的（douyinvod 按地域/节点变化、kugou 音频域有多个
 * 前缀），精确匹配枚举不完，故额外做后缀匹配。后缀带前导点，
 * `evil-douyinvod.com` 这类不会以 `.douyinvod.com` 结尾，不会被误放行。
 */
const { session } = require('electron');

const LOCAL_ORIGINS = ['http://localhost', 'http://127.0.0.1'];

function installCorsHeaders() {
  const { origins: platformOrigins, suffixes: platformSuffixes } =
    require('../api').registry.getAllowedOrigins();
  const ALLOWED_ORIGINS = new Set([...LOCAL_ORIGINS, ...platformOrigins]);
  const ALLOWED_ORIGIN_SUFFIXES = [...platformSuffixes];
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    // M5 修正：原实现拿 details.url 自身的 origin 判定并回填，等于给每个
    // 响应写上"它自己"，对本应用（file:// 页 origin 为 null）完全无效，
    // 还会覆盖上游正确的 ACAO。正确语义：目标是白名单平台源时，把
    // 「发起方」反射回去 —— 打包后发起方是 file://（null），dev 是本地端口。
    let targetOrigin = '';
    try { targetOrigin = new URL(details.url).origin; } catch (_e) { /* noop */ }
    const isAllowed = ALLOWED_ORIGINS.has(targetOrigin)
      || ALLOWED_ORIGIN_SUFFIXES.some((sfx) => targetOrigin.endsWith(sfx));
    const headers = { ...details.responseHeaders };
    const hasACAO = Object.keys(headers).some(k => k.toLowerCase() === 'access-control-allow-origin');
    if (isAllowed && !hasACAO) {
      const initiator = details.initiator && /^https?:\/\//.test(details.initiator)
        ? new URL(details.initiator).origin
        : 'null';
      headers['Access-Control-Allow-Origin'] = [initiator];
      headers['Access-Control-Allow-Methods'] = ['GET', 'HEAD', 'OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['Range', 'Referer'];
    }
    callback({ responseHeaders: headers });
  });
}

module.exports = { installCorsHeaders, LOCAL_ORIGINS };
