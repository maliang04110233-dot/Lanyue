/**
 * 「这条失败是不是连通性问题」——全仓唯一判据之家
 *
 * 为什么要有这个文件：同一支正则此前在三个地方各写一遍，而且三遍并不一样：
 *   1. src/main/updateError.js —— 更新器拿它决定「说什么 + 要不要给手动下载按钮」；
 *   2. src/utils/downloader.js —— 传输层拿它决定「要不要退避重试 + 断点续传」，那份只列了
 *      Node 的 socket 码，Chromium 抛的 net::ERR_INTERNET_DISCONNECTED 一类**一条都不匹配**，
 *      于是断网时的传输失败既不退避也不续传，直接判死；
 *   3. src/main/downloadQueue.js —— 队列终态该回写的 errorCode 压根没回写（只有取流 fatal
 *      那条路写码），所以断网跑完的队列行与历史行不戴徽标，诊断弹层只会说「未分类的失败」。
 * 三处判据一处漂移就是"同一首歌在三条线上得到三种说法"，所以搬到这里，三处都只问结论。
 *
 * 两支正则的分工（沿用 updateError 定下的分寸，没改口径）：
 *   - TRANSPORT_ERROR：连接建立不了 / 中途断了 / 域名解析不出来 —— 这一族「稍后再试」成立。
 *   - TLS_ERROR：证书与 TLS 握手被拦。拦你的东西不会自己消失，所以它算"网络类"（更新器
 *     该给手动下载入口），但**不算可自动重试**（传输层不退避、队列不自动重排队）。
 *
 * 两套命名都必须覆盖：Chromium 的 net::ERR_* 与 Node 的 socket 码。用户可见文本里
 * 还有中文的「下载超时 / 网络超时」，一并认。
 */
'use strict';

const { ERROR_CODES } = require('./errors');

/** 传输层失败（见文件头） */
const TRANSPORT_ERROR = /net::ERR_[A-Z_]*(?:TIMED_OUT|ABORTED|RESET|CLOSED|REFUSED|FAILED|DISCONNECTED|CHANGED|SUSPENDED|NOT_RESOLVED|UNREACHABLE|NOT_CONNECTED|SOCKET|EMPTY_RESPONSE|CONNECTION_)|\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE|AI_AGAIN|NOTFOUND)\b|socket hang up|\bnetwork\b|timeout|timed out|aborted|下载超时|网络超时|超时/i;

/** 证书 / TLS 握手失败：常见于代理、VPN、安全软件 */
const TLS_ERROR = /net::ERR_(?:CERT_[A-Z_]+|SSL_PROTOCOL_ERROR|SSL_FALLBACK_EXCEEDED)|unable to verify the first certificate|self[- ]signed certificate|certificate (?:chain|has expired|revoked)/i;

/** 传输失败里再分一档：超时值得跟用户说「请检查网络/代理」，与「连接被掐断」不是一回事 */
const TIMEOUT_HINT = /TIMED_OUT|ETIMEDOUT|\btimed out\b|\btimeout\b|下载超时|网络超时|超时/i;

/**
 * 引擎自归类的连通性错误码。清单住在 errors.js 的码表里，这里只是把它点名出来，
 * 供队列判定「这条失败能不能被复网自动续跑」用 —— 渲染层那份字面量清单由测试钉着与本表逐字相等。
 */
const NETWORK_CODES = [ERROR_CODES.NETWORK_TIMEOUT, ERROR_CODES.NETWORK_ERROR];

/** 从任意形状（字符串 / Error / 队列条目 / 裸码）里取出给用户看的那句话 */
function messageOf(subject) {
  if (subject == null) return '';
  if (typeof subject === 'string') return subject;
  if (typeof subject === 'object') {
    const parts = [];
    if (subject.message) parts.push(String(subject.message));
    if (subject.error) parts.push(String(subject.error));
    if (subject.code) parts.push(String(subject.code));
    if (subject.errorCode) parts.push(String(subject.errorCode));
    return parts.join(' ');
  }
  return String(subject);
}

/** 这条文本是不是 TLS/证书类 */
function isTlsFailure(subject) {
  const msg = messageOf(subject);
  return !!msg && TLS_ERROR.test(msg);
}

/** 这条文本是不是传输层失败（TLS 不算：它不在 TRANSPORT 那一族里） */
function isTransportFailure(subject) {
  const msg = messageOf(subject);
  if (!msg) return false;
  if (TLS_ERROR.test(msg)) return false;
  return TRANSPORT_ERROR.test(msg);
}

/**
 * 传输失败对应哪个自归类错误码：超时一档、其余断连一档；不是传输失败就不认领（返回 null）。
 * 「不认领」是有意的：把 403/磁盘满/版权限制说成网络问题，用户就会去检查根本没坏的网络。
 * @returns {?string}
 */
function transportCode(subject) {
  if (!isTransportFailure(subject)) return null;
  return TIMEOUT_HINT.test(messageOf(subject)) ? ERROR_CODES.NETWORK_TIMEOUT : ERROR_CODES.NETWORK_ERROR;
}

/**
 * 这条失败是不是「重试有意义」的连通性问题：自动退避、复网自动重排队都问这一枚。
 * 入参可以是字符串 / Error / 队列条目 {errorCode, error}；有码时以码为准（取流层已经归好类），
 * 没码时才回落到文本 —— 文本推断只用来兜住下载传输层那一族（那里没有码可写）。
 */
function isConnectivityFailure(subject) {
  if (subject == null) return false;
  if (typeof subject === 'object' && subject.errorCode) {
    return NETWORK_CODES.includes(String(subject.errorCode));
  }
  return isTransportFailure(subject);
}

module.exports = {
  TRANSPORT_ERROR,
  TLS_ERROR,
  NETWORK_CODES,
  messageOf,
  isTlsFailure,
  isTransportFailure,
  transportCode,
  isConnectivityFailure,
};
