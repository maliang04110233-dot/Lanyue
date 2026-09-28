/**
 * MusicDL 渲染层 — 「哪些红条是在等网络」
 *
 * 引擎（下半）给断网/超时的下载终态补上了 NETWORK_ERROR / NETWORK_TIMEOUT 两枚码，
 * 渲染层这才第一次有可能不问用户就把它们挑出来：断网时横幅报个数，复网时按个数自动重新入队。
 *
 * 判据之家在 src/shared/netClass.js（渲染层不能 import src/shared，见 sidecar 家法），
 * 这里只留一份字面量清单，由 test/net-recovery.test.js 钉着与 NETWORK_CODES 逐字相等。
 */

/** 引擎自归类的连通性失败码（与 shared/netClass.NETWORK_CODES 一一对应） */
export const NET_CODES = ['NETWORK_TIMEOUT', 'NETWORK_ERROR'];

/**
 * 队列快照里「因网络而失败、等网络恢复就该重跑」的行。
 * 只认码不认文本：非网络红条（需 VIP / 版权受限 / 磁盘满）一条都不许被自动重排 ——
 * 那些再跑一遍还是同样失败，只是把用户的队列变成无限循环的红色。
 */
export function netFailedTasks(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(s => s
    && s.status === 'error'
    && NET_CODES.includes(String(s.errorCode || '')));
}
