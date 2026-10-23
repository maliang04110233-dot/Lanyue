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

/**
 * 判定「本次启动后 main.log 是否有新增字节」，决定三条日志断言能否采信。
 *
 * 背景（2026-10-23 真机实测的假绿）：旧实现在无新增字节时静默退化为
 * 「历史尾部 20000 字节」，于是一次进程根本没进入主进程的启动（被我方
 * 注入的 ELECTRON_RUN_AS_NODE=1 变成纯 Node 模式，exit=0、零输出、不写
 * 日志）依然让三条日志断言 PASS —— 读到的是前一天的历史尾部，里面恰好有
 * 「[shortcuts] 全局快捷键已注册 3/3」。假红会被发现，假绿会让发版人拿到
 * 一张干净的验收单，因此这里把状态显式化，禁止任何静默退化。
 *
 * 状态口径：
 *   fresh   —— 当前长度 > 启动前偏移：确有新增字节，可按增量切片断言；
 *   empty   —— 当前长度 == 启动前偏移：本次启动一个字节都没写，历史内容
 *              不能作为本次启动的证据，断言必须判失败；
 *   rotated —— 当前长度 < 启动前偏移：日志被轮转/截断，新旧内容无法区分，
 *              只允许退化为尾部用于诊断输出，三条日志断言一律不得判绿。
 * 非法入参（NaN/Infinity/undefined）归入 empty：宁可判红，不可假绿。
 *
 * @param {number} bufLength 当前 main.log 的字节长度。
 * @param {number} sliceStart 首个实例 spawn 之前记录的字节偏移。
 * @returns {'fresh'|'empty'|'rotated'} 增量状态。
 */
function logIncrementalState(bufLength, sliceStart) {
  // null/undefined 不能靠 Number() 兜底：Number(null) === 0 会被误判成「从 0 开始、
  // 全部是新内容」。缺基线一律归 empty，宁可判红。
  if (bufLength == null || sliceStart == null) return 'empty';
  const len = Number(bufLength);
  const start = Number(sliceStart);
  if (!Number.isFinite(len) || !Number.isFinite(start)) return 'empty';
  if (start > len) return 'rotated';
  if (start === len) return 'empty';
  return 'fresh';
}

/**
 * 主窗口渲染层是否加载成功的判据。
 *
 * 背景（2026-10-23 真机实测锁定的盲区）：本文件此前 7 条判据全部只证明
 * 「进程活着」——存活 6 秒、第二实例被拒、无致命错误、写了日志、快捷键注册、
 * 托盘无告警。7/7 全绿时用户仍可能拿到一个**白屏**应用：
 *   exe --disable-gpu-sandbox                        → 进程存活，main.log 有
 *       「[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading
 *       'file:///...app.asar/dist/renderer/index.html'」，CDP 查到 page target
 *       存在但 title=""；
 *   exe --disable-gpu-sandbox --no-sandbox           → title="揽乐"，
 *       日志「[LOG] [main] loadFile done」。
 * 也就是说「进程活着」与「界面画出来了」是两条独立事实，必须分开断言。
 *
 * 证据来源是主进程既有日志（src/main/index.js:128-131）：
 *   loadFile(...).then(→ '[main] loadFile done').catch(→ '[main] loadFile failed:', err)
 *
 * 状态口径：
 *   loaded  —— 最后一次出现的是 done：渲染层已加载；
 *   failed  —— 最后一次出现的是 failed：渲染层未加载（= 用户白屏）；
 *   unknown —— 两者都没出现：启动后未创建窗口，或日志口径变了。
 *
 * 「以最后一次出现为准」是刻意设计：渲染失败后主进程可能回落到其它 URL 重试
 * （index.js 的 catch 里有 devUrl 回退分支），重试成功后日志形如
 * 「failed → done」。若按「出现过 failed 即失败」判定，重试成功会被判红；
 * 若按「出现过 done 即通过」判定，重试也失败的场景会被判绿。只有按时间序
 * 取最后一次，两种场景才都对。
 *
 * @param {string} logText 本次启动的 main.log 增量文本（不得传历史尾部）。
 * @returns {'loaded'|'failed'|'unknown'} 渲染层加载状态。
 */
function rendererLoadedState(logText) {
  const log = typeof logText === 'string' ? logText : '';
  // 全局匹配 + 时间序扫描：不依赖 matchAll 的捕获组，也不受未知换行风格影响。
  const re = /\[main\]\s*loadFile\s+(done|failed)/gi;
  let last = null;
  let m = re.exec(log);
  while (m !== null) {
    last = String(m[1]).toLowerCase();
    m = re.exec(log);
  }
  if (last === 'done') return 'loaded';
  if (last === 'failed') return 'failed';
  return 'unknown';
}

module.exports = {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
  logIncrementalState,
  rendererLoadedState,
};
