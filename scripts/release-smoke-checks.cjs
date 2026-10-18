'use strict';

/**
 * Windows 发行冒烟的纯判据。与进程拉起分离，确保门禁自身可被单测。
 */
function processStayedAlive({ spawnError, exitCode, exitSignal, timedOut }) {
  if (spawnError) return false;
  if (!timedOut) return false;
  return exitCode == null && exitSignal == null;
}

function secondInstanceWasRejected({ firstAlive, secondSpawnError, secondExitCode, secondTimedOut }) {
  return !!firstAlive && !secondSpawnError && !secondTimedOut && secondExitCode === 0;
}

function startupLogLooksHealthy(text) {
  const log = String(text || '');
  const fatal = [
    /uncaught exception/i,
    /unhandled rejection/i,
    /cannot find module/i,
    /ERR_ELECTRON/i,
    /SyntaxError:/i,
    /TypeError:.*(?:undefined|null)/i,
  ];
  return !fatal.some((re) => re.test(log));
}

/**
 * 全局快捷键注册成功的判据：启动日志里出现「[shortcuts] 全局快捷键已注册 N/M」
 * 且 N >= 1。来源是 main/globalShortcuts.js:51 的既有日志（真机 main.log
 * 实测出现过「已注册 3/3」），此前从未被门禁消费过。
 *
 * 判定口径：
 *   - 行必须命中「已注册 N/M」且 N、M 是非负整数；
 *   - N=0 不算（一枚都没注册上，说明 accelerator 被系统/占用或 prefs 关了）；
 *   - N<M 允许（部分键被占用是真实场景，908 抗辩不成立时仍应放行）。
 * 说明：prefs 里 globalShortcuts=false 时 registerGlobalShortcuts() 直接 return，
 * 日志里根本不会有「已注册」行 → 判 false。这正确：门禁跑的是默认配置，
 * 用户手动关掉快捷键后门禁失败提示改配置后重跑，属可解释的失败。
 */
function shortcutsRegisteredInLog(text) {
  const log = String(text || '');
  const m = log.match(/\[shortcuts\]\s*全局快捷键已注册\s*(\d+)\/(\d+)/);
  if (!m) return false;
  const registered = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  return registered >= 1 && registered <= total;
}

/**
 * 托盘健康判据：启动日志里不应出现 [tray] 前缀的失败 warn/error。
 * 来源是 tray.jscreateTray 的两条失败路径：
 *   - '[tray] 图标加载失败:'  (tray.js:52)
 *   - '[tray] 打开桌面歌词失败:'/ '[tray] 打开迷你播放器失败:'  (tray.js:119/125)
 * 注意：这两条菜单回调属用户主动操作，启动冒烟期间不应触发；但放进判据
 * 可以一并守住偶发回归，因为门禁期间若出现即说明启动路径有异常副作用。
 */
function trayFailureAbsent(text) {
  const log = String(text || '');
  return !/\[tray\]/.test(log);
}

module.exports = {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
};
