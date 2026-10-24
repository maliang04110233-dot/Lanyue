'use strict';

/**
 * Windows 发行冒烟的纯判据。与进程拉起分离，确保门禁自身可被单测。
 */

/**
 * 创建时间判据的容差（毫秒）。
 *
 * 取 2 秒的原因：进程表的 CreationDate 与 Node 侧的 Date.now() 是两次独立采样
 * （CIM 侧的系统时间 vs JS 侧的系统时间），且「记录启动时刻」与「进程真正被
 * 创建」之间存在毫秒级差。2 秒足够覆盖采样抖动；再大就会把「启动前就在跑、
 * 但恰好在快照之后重建」的进程误判成本次残留。
 */
const CREATION_TIME_TOLERANCE_MS = 2000;

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

/**
 * 归一化 Windows 路径，用于把进程表的 ExecutablePath 与目标 exe 路径做等值比较。
 *
 * 为什么不能直接比字符串：同一份路径在进程表、命令行与 Node 侧有至少三种写法
 * ——`C:\a\b\Lanyue.exe`、`c:/a/b/Lanyue.exe`、`"C:\a\b\Lanyue.exe"`，长路径还
 * 可能带 `\\?\` 前缀。大小写不敏感 + 正斜杠归一是 Windows 文件系统语义的要求，
 * 少了任何一步都会把本次启动的进程判成「不是它」，进而让 pid 发现超时。
 *
 * @param {*} input 原始路径（可带引号、可含反斜杠、可为 null）。
 * @returns {string} 小写、正斜杠、无尾斜杠的路径；非法入参返回空串。
 */
function normalizeWinPath(input) {
  let text = input == null ? '' : String(input);
  text = text.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  text = text.replace(/^\\\\\?\\/, '');
  text = text.replace(/\\/g, '/');
  text = text.replace(/\/+$/, '');
  return text.toLowerCase();
}

/**
 * 把单条进程记录规整成 `{ pid, executablePath, commandLine, creationDate }`。
 * PowerShell 的 ConvertTo-Json 用 ProcessId/ExecutablePath/CommandLine/CreationDate
 * 四个键，但为了单测能直接喂驼峰结构，两套键名都接受。
 *
 * creationDate 原样保留成字符串：它在 JSON 里的形态有多种（见 parseCreationTimeMs），
 * 解析放在纯函数里做，这里不猜、不转、也不丢 —— 丢掉就等于把「独立于路径的第二个
 * 信号」在入口处扔了。
 *
 * @param {*} entry 原始记录。
 * @returns {{pid:number, executablePath:string, commandLine:string, creationDate:string}|null}
 *   pid 非正整数（含缺失、NaN、字符串乱码）一律返回 null —— 没有可靠 pid 的
 *   记录不能参与「是不是本次启动的进程」的判定。
 */
function toProcessEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawPid = entry.ProcessId !== undefined
    ? entry.ProcessId
    : (entry.pid !== undefined ? entry.pid : entry.processId);
  const pid = Number(rawPid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const rawPath = entry.ExecutablePath !== undefined ? entry.ExecutablePath : entry.executablePath;
  const rawCmd = entry.CommandLine !== undefined ? entry.CommandLine : entry.commandLine;
  const rawCreated = entry.CreationDate !== undefined ? entry.CreationDate : entry.creationDate;
  return {
    pid: Math.trunc(pid),
    executablePath: rawPath == null ? '' : String(rawPath),
    commandLine: rawCmd == null ? '' : String(rawCmd),
    creationDate: rawCreated == null ? '' : formatCreationDate(rawCreated),
  };
}

/**
 * 把创建时间字段规整成字符串（Date 对象转 ISO；其余原样字符串化）。
 *
 * @param {*} value 原始创建时间字段。
 * @returns {string} 字符串形态的创建时间；null/undefined 返回空串。
 */
function formatCreationDate(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : '';
  }
  return String(value);
}

/**
 * 解析进程的创建时间为「epoch 毫秒」。
 *
 * **实测形态（Windows PowerShell 5.1，2026-10-23）**：
 * `Get-CimInstance Win32_Process | Select-Object CreationDate | ConvertTo-Json -Compress`
 * 给出的是 **JavaScriptSerializer 形态**：`"CreationDate":"\/Date(1792117273962)\/"`
 * （JSON 里斜杠被转义成 `\/`；JSON.parse 之后是 `/Date(1792117273962)/`）。
 * 不是 ISO 串 —— 这点必须实测确认，不能照着别的语言的经验写死。
 * 因此下面同时吃两种形态，解析不出来就返回 null（**不得抛错**：解析失败只是
 * 「这条记录没有创建时间」，不是「查询失败」）。
 *
 * 形态表：
 *   `/Date(1792117273962)/`   → 1792117273962（.NET / JavaScriptSerializer）
 *   `2026-10-23T07:30:57.502000+08:00` → Date.parse（ISO 8601，毫秒精度）
 *   `1792117273962` / `"1792117273962"` → 已是 epoch 毫秒
 *   其它 / 空 / null → null（该记录不参与创建时间判据）
 *
 * @param {*} value 原始创建时间字段（字符串 / 数字 / Date）。
 * @returns {number|null} epoch 毫秒；无法解析返回 null。
 */
function parseCreationTimeMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  // .NET / JavaScriptSerializer 形态：/Date(1792117273962)/
  // （JSON 原文里斜杠被转义成 \/，JSON.parse 之后就没有反斜杠了；这里两种都收。）
  const dotNet = /^[\\/]*Date\((-?\d+)(?:[+-]\d+)?\)[\\/]*$/i.exec(text);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  // 纯数字：已是 epoch 毫秒。
  if (/^-?\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isFinite(ms) ? ms : null;
  }
  // ISO 8601：把超过 3 位的小数秒截到 3 位（V8 的 Date.parse 只保证毫秒精度，
  // 实测 `2026-10-23T07:30:57.502000+08:00` 直接 parse 虽可行，但截断更稳）。
  const iso = text.replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 取路径的 basename（Windows 语义：反斜杠与正斜杠都算分隔符，结果小写）。
 *
 * 走 normalizeWinPath 是为了复用它已经做过的三件事：剥引号、去 `\\?\` 前缀、
 * 反斜杠转正斜杠并转小写。basename 比较必须忽略大小写 —— Windows 文件系统本身
 * 就是大小写不敏感的。
 *
 * @param {*} input 原始路径。
 * @returns {string} 小写 basename；入参为空返回空串。
 */
function winBasename(input) {
  const normalized = normalizeWinPath(input);
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * 判定进程记录里能不能拿到「进程名」（用于创建时间这条与路径无关的信号）。
 *
 * 两个来源，任一命中即可：
 *   1) ExecutablePath 的 basename；
 *   2) CommandLine 里任意一个空白分隔 token 的 basename —— 进程路径不可读时
 *      （权限盲区）命令行往往还在，而命令行里的 exe 名同样是 ASCII 的。
 *
 * **为什么 ASCII 这一点是承重的**：CP936 → UTF-8 的损坏只影响非 ASCII 字符，
 * 所以「路径整体被写坏」时，exe 的 basename（Lanyue.exe）通常还 intact。
 * 这条信号因此能在路径数据被污染时继续工作 —— 那正是它的存在意义。
 *
 * @param {{executablePath:string, commandLine:string}} entry 进程记录。
 * @param {string} targetBase 目标 exe basename（小写）。
 * @returns {boolean}
 */
function processNameMatches(entry, targetBase) {
  if (!targetBase) return false;
  if (!entry || typeof entry !== 'object') return false;
  if (winBasename(entry.executablePath) === targetBase) return true;
  const cmd = String(entry.commandLine == null ? '' : entry.commandLine).trim();
  if (!cmd) return false;
  // 逐 token 找 basename：路径含空格且未加引号时，第一个 token 只是路径的前半截，
  // 逐 token 找才不漏。
  return cmd.split(/\s+/).some((token) => winBasename(token) === targetBase);
}

/**
 * 解析进程表查询结果。
 *
 * ConvertTo-Json 在「恰好一个匹配进程」时输出对象、多个时输出数组、零个时输出
 * 空串（连 `[]` 都没有），所以三种形态都必须吃得下。任何异常一律归空数组：
 * 调用方（pid 发现）会因此走超时失败分支，是 fail-closed 的方向，不假绿。
 *
 * @param {*} raw 原始 JSON 文本、已解析的对象/数组，或空值。
 * @returns {Array<{pid:number, executablePath:string, commandLine:string, creationDate:string}>}
 */
function parseProcessList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(toProcessEntry).filter(Boolean);
  if (typeof raw === 'object') {
    const single = toProcessEntry(raw);
    return single ? [single] : [];
  }
  const text = String(raw).trim();
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return [];
  }
  if (Array.isArray(parsed)) return parsed.map(toProcessEntry).filter(Boolean);
  const single = toProcessEntry(parsed);
  return single ? [single] : [];
}

/**
 * 判定某条进程记录是否「就是本次要盯的主进程」。
 *
 * 三个条件缺一不可：
 *   1) ExecutablePath 归一化后等于目标 exe（大小写不敏感、正斜杠归一）；
 *   2) CommandLine 不含 `--type=`：Electron 的渲染/GPU/utility 子进程都用
 *      `--type=renderer|gpu-process|utility` 标识，主进程没有这个参数。少了这
 *      一条会把渲染进程误判成主进程，随后 taskkill 打在主进程上而残留渲染进程；
 *   3) pid 不在启动前快照里 —— 这是**保护用户正在运行的实例**的红线。少了这
 *      一条，脚本会把用户手上那个 Lanyue.exe 当成本次被测对象：轻则断言读到
 *      别人的日志（假绿/假红都成立），重则收尾时把它杀掉。用户丢窗口是最坏
 *      的失效方向，所以这条判定必须与快照强绑定，不许由调用方「顺手省掉」。
 *
 * @param {{entry:object, exePath:string, baselinePids:Set<number>|number[]}} args
 * @returns {boolean}
 */
function isTargetMainProcess({ entry, exePath, baselinePids } = {}) {
  const target = normalizeWinPath(exePath);
  if (!target) return false;
  if (!entry || typeof entry !== 'object') return false;
  const pid = Number(entry.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (normalizeWinPath(entry.executablePath) !== target) return false;
  if (/--type=/i.test(String(entry.commandLine == null ? '' : entry.commandLine))) return false;
  const baseline = baselinePids instanceof Set ? baselinePids : new Set(baselinePids || []);
  return !baseline.has(Math.trunc(pid));
}

/**
 * 从进程表里选出本次启动的主进程 pid（explorer 代理模式下唯一的 pid 来源）。
 *
 * @param {{processes:*, exePath:string, baselinePids:Set<number>|number[]}} args
 * @returns {number|null} 命中的 pid；没有命中返回 null（调用方据此轮询/超时失败）。
 */
function selectMainPid({ processes, exePath, baselinePids } = {}) {
  for (const entry of parseProcessList(processes)) {
    if (isTargetMainProcess({ entry, exePath, baselinePids })) return entry.pid;
  }
  return null;
}

/**
 * 前置条件判据：本机**已经**有同一路径的主进程在跑时，把它列出来。
 *
 * 为什么需要它（2026-10-23 实测）：用户已经开着一个实例时，冒烟必然走出
 * 「新实例被单实例锁拒绝、main.log 零增量」的路径 —— 第 1/4/5/6/7/8 条全红，
 * 汇总行印「1/8 通过」。那是**如实的红，但归因错误**：读验收单的人会以为产品
 * 坏了，实际是「跑之前就该拒绝」。假红的净效果是训练人「重跑一次就行」，
 * 比慢几秒糟得多，所以脚本在拉起任何进程之前先查这个谓词，命中即 exit 1。
 *
 * 谓词复用 isTargetMainProcess（路径归一 + 排除 `--type=` 子进程），但
 * **不排除**任何快照：这里问的正是「启动前已经存在哪些主进程」。
 * ExecutablePath 为空（权限不足等）的记录无法判定路径，一律不算命中 ——
 * 这时精确性让位于「不要因为看不见就误报」。
 *
 * @param {{processes:*, exePath:string}} args
 * @returns {Array<{pid:number, executablePath:string, commandLine:string}>}
 *   命中的既有主进程；空数组表示可以开跑。
 */
function findPreexistingMainProcesses({ processes, exePath } = {}) {
  const target = normalizeWinPath(exePath);
  if (!target) return [];
  return parseProcessList(processes).filter((entry) => isTargetMainProcess({
    entry,
    exePath,
    baselinePids: new Set(),
  }));
}

/**
 * 前置检查的盲区探测：同名进程**存在**，但 `ExecutablePath` 读不到的那些记录。
 *
 * 为什么必须单独探测（2026-10-23 收口）：findPreexistingMainProcesses 靠
 * 「路径归一后等值」认出本机已有的同包实例。但一个非提权进程去查一个提权进程
 * （或跨会话、被安全软件挂钩的进程）时，Win32_Process 会**返回记录**却把
 * ExecutablePath 留空 —— 这条记录判不出路径，按该谓词的口径「一律不算命中」。
 * 于是前置检查会给出「本机没有已存在实例」这个**可能错误**的结论，紧接着新实例
 * 被单实例锁拒绝、main.log 零增量，冒烟印出「1/8 通过」。那是如实的红、错误的
 * 归因 —— 和加前置条件之前一模一样地误导人。
 *
 * 纯函数，只负责**把盲区数出来**，不改变任何判据：
 *   - 调用方据 count > 0 打一行 WARN（不阻断，理由见 smoke-test-manual.js 里
 *     unreadablePathCount 的注释：阻断会把「机器上恰好有个高权限同名进程」这种
 *     正常场景永久堵死）；
 *   - 第 1/4 条若最终 FAIL，再用同一个数字给 message 追加归因提示。
 *
 * 过滤规则（每一条都有具体理由，别随手简化）：
 *   1) `ExecutablePath` 归一化后为空 → 计入（这就是盲区本身）；
 *   2) `CommandLine` 可读且含 `--type=` → **不计入**：那必然是渲染/GPU/utility
 *      子进程，物理上不可能持有单实例锁，算进来只会稀释提示的可信度；
 *   3) `CommandLine` 也读不到时无法排除，按 fail-safe **计入**（宁可多提示一句，
 *      也不要因为「看不见」而报出一句干净的假绿）。
 *
 * 上游是 queryTargetProcesses 按 `Name=<exe 名>` 过滤过的结果，所以这里不需要
 * 再做进程名匹配；直接调用时传什么就算什么（单测即如此使用）。
 *
 * @param {{processes:*}} args 进程表查询结果（parseProcessList 能吃下的任意形态）。
 * @returns {Array<{pid:number, executablePath:string, commandLine:string}>}
 *   路径不可读、且无法排除为子进程的记录；空数组 = 前置检查没有盲区。
 */
function findUnreadablePathProcesses({ processes } = {}) {
  return parseProcessList(processes).filter((entry) => {
    if (normalizeWinPath(entry.executablePath)) return false;
    return !/--type=/i.test(String(entry.commandLine == null ? '' : entry.commandLine));
  });
}

/**
 * 渲染层轮询的停止条件（纯函数）：拿到**明确结论**就停，绝不吃满 deadline。
 *
 * 为什么需要轮询而不是「固定等够 N 秒再读一次」（2026-10-23 实测依据）：
 * 旧实现用 SHELL_LOG_SETTLE_MS = 14000 固定等待，余量只有 0.19s（实测
 * 「loadFile done」比唯一那次读数晚 0.19s 落盘）。慢机上这点余量必然被吃掉，
 * 于是判成 unknown = 假红 —— 与「4 次里出现 1 次 6/8」的抖动同源。
 *
 * 判据本身一个字没改：仍然是「增量日志里最后一次 loadFile 是 done」。
 * 白屏应用永远不会写 done，所以轮询只会消掉「观测太早」这种假红，
 * 不可能把红等成绿。
 *
 * skipRenderCheck 为真（第 8 条已显式跳过、记 SKIP 不记 PASS）时，只要增量里
 * 出现快捷键注册行，四条日志内容断言就已可判定，继续等 loadFile 没有意义
 * （要等的正是那条被跳过的断言），因此一并返回 true。
 *
 * @param {{logText:string, logState:'fresh'|'empty'|'rotated', skipRenderCheck:boolean}} args
 * @returns {boolean} true = 可以停止等待并据此判定。
 */
function renderWaitSettled({ logText, logState, skipRenderCheck } = {}) {
  if (logState !== 'fresh') return false;
  const text = typeof logText === 'string' ? logText : '';
  if (rendererLoadedState(text) !== 'unknown') return true;
  return skipRenderCheck === true && shortcutsRegisteredInLog(text);
}

/**
 * 取字符串里的 ASCII 可见字符（其余一律丢弃）。
 *
 * 用途：构造路径的「ASCII 骨架」。CP936 → UTF-8 的解码损坏**只影响非 ASCII
 * 字符**，ASCII 字节（0x00-0x7F）在 UTF-8 解码里永远原样保留（也不会被当成
 * 多字节序列的续字节吃掉，因为续字节的范围是 0x80-0xBF）。所以「ASCII 骨架」
 * 是一份路径在损坏前后**不变**的部分。
 *
 * @param {*} text 原始字符串。
 * @returns {string} 只含 ASCII 可见字符（0x20-0x7E）的字符串。
 */
function asciiSkeleton(text) {
  return String(text == null ? '' : text).replace(/[^\x20-\x7E]/g, '');
}

/**
 * 文本里是否出现了 Unicode 替换字符 U+FFFD。
 *
 * U+FFFD 是「按错编码解码」的铁证：UTF-8 解码器遇到非法字节序列时必定产出
 * 它。真实的 Windows 路径里几乎不可能出现这个字符。
 *
 * @param {*} text 原始字符串。
 * @returns {boolean}
 */
function containsReplacementChar(text) {
  return String(text == null ? '' : text).includes('\uFFFD');
}

/**
 * 路径里是否出现了 Windows **不允许出现在文件名里**的字符。
 *
 * Windows 保留这些字符：< > : " | ? * （以及 0x00-0x1F 的控制字符）。也就是说
 * 一条真实的 Windows 路径里不可能出现它们（盘符的冒号除外）。
 * 因此「路径里有 ? 或 *」⇒ 这条字符串不是一条真实的路径 ⇒ 数据被写坏了。
 *
 * 这条判据挡住的是「用 ASCII 乱码替换掉非 ASCII 段」这类污染：把
 * 「新建文件夹」写成「????」之后，ASCII 骨架也跟着变了，前面的判据 3 抓不到，
 * 但这条一抓一个准。
 *
 * @param {*} text 原始路径。
 * @returns {boolean}
 */
function pathHasForbiddenChar(text) {
  const raw = String(text == null ? '' : text);
  // 盘符的冒号是合法的，去掉它再判（UNC 路径本来就没有冒号）。
  const withoutDrive = raw.replace(/^[A-Za-z]:/, '');
  // 刻意检查控制字符（Windows 文件名禁用字符集），非误用
  // eslint-disable-next-line no-control-regex
  return /[<>:"|?*\u0000-\u001F]/.test(withoutDrive);
}

/**
 * 判定「进程表里的路径数据是否还可信」。
 *
 * 背景（2026-10-23 QA 变异实测）：路径数据曾经经由 PowerShell 的 stdout 文本
 * 通道回到 Node，而 Windows PowerShell 5.1 默认按控制台代码页（本机 CP936）写
 * stdout。中文路径（「F:\新建文件夹\...」）被 Node 按 utf8 解码后变成替换字符，
 * 于是 normalizeWinPath 归一化后的路径**永远不等于**目标路径 →
 * findPreexistingMainProcesses / selectMainPid / findResidualProcesses 全部
 * 匹配不到 → verifyCleanup 打印「清理: 零残留」，而机器上还有 4 个 Lanyue.exe
 * 在跑。**守卫主动报告了与事实相反的结论**，比没有守卫更坏。
 *
 * 三条判据（任何一条不成立即判不可信；调用方必须 fail-closed）：
 *
 *   1) basename 口径 —— 取所有 ExecutablePath **非空**的记录；一条都没有 →
 *      可信（true，本机确实没有该进程，路径数据无从损坏；「同名进程存在却路径
 *      全空」属于另一条判据 findUnreadablePathProcesses）。否则这些非空路径里
 *      **至少有一条**的 basename（忽略大小写）等于目标 exe 的 basename；
 *      一条都不命中 → 不可信（这份数据根本不是关于本 exe 的）。
 *
 *   2) 替换字符 —— 路径里出现 U+FFFD ⇒ 这份文本是「按错编码解码」的产物 ⇒
 *      不可信。真实的 Windows 路径里不会出现这个字符。
 *
 *   3) 非法文件名字符 —— 路径里出现 Windows 禁止的字符（< > : " | ? *）⇒ 这条
 *      字符串根本不是一条真实的 Windows 路径 ⇒ 不可信。
 *
 *   4) ASCII 骨架 —— 某条记录的路径与目标路径**逐字符的 ASCII 部分完全相同、
 *      整体却不同** ⇒ 差异只发生在非 ASCII 位置 ⇒ 路径被写坏了 ⇒ 不可信。
 *
 * **为什么必须补上第 2、3、4 条（这是对「只看 basename」这条口径的实测修正）**：
 * 损坏只影响非 ASCII 字符，恰恰意味着 **exe 的 basename（Lanyue.exe）是 ASCII，
 * 它会原样幸存**。也就是说「basename 命中」这个判据在数据被污染时**照样成立**
 * —— 只看 basename 的实现对「路径整体被写坏」这种最典型的污染完全无感，会
 * 继续判「可用」，然后继续假绿。本机实测（GBK 字节按 UTF-8 解码）：
 *   `F:\新建文件夹\Lanyue.exe` → `F:\Ɛʄ\Lanyue.exe`
 * basename 仍是 `lanyue.exe`（命中），但路径已经永远比不相等 ⇒ 路径比对静默
 * 失配。第 2 条（出现 U+FFFD）、第 3 条（出现 Windows 非法文件名字符）与
 * 第 4 条（ASCII 骨架相同、整体不同）都能识别这一条 —— 这就是「可判定，不靠猜」
 * 的完整含义。
 *
 * 覆盖不到的残余风险（如实说明）：把非 ASCII 段整体换成**另一段合法的 ASCII**
 * （如把「新建文件夹」写成「XXXXXX」）时，本 exe 的路径与「另一个安装的路径」
 * 在原理上不可区分（两者都是合法的 Windows 路径）。这类污染的正解是**根因修复**
 * —— 路径数据不再经过任何按控制台代码页编码的通道（见 smoke-test-manual.js 的
 * queryTargetProcesses），而不是靠猜。
 *
 * @param {*} processes 进程表查询结果（parseProcessList 能吃下的任意形态）。
 * @param {string} exePath 目标 exe 的绝对路径。
 * @returns {boolean} true = 路径数据可用（可继续做路径比对）；false = 不可信，
 *   调用方必须 fail-closed（拒绝执行 / 不得宣称零残留）。
 */
function pathDataLooksUsable(processes, exePath) {
  const entries = parseProcessList(processes);
  const withPath = entries.filter((entry) => normalizeWinPath(entry.executablePath));
  if (!withPath.length) return true;
  const targetBase = winBasename(exePath);
  if (!targetBase) return false;
  const target = normalizeWinPath(exePath);
  const targetAscii = asciiSkeleton(target);

  // 判据 1：basename 至少一条命中。
  if (!withPath.some((entry) => winBasename(entry.executablePath) === targetBase)) return false;
  // 判据 2：路径里不得出现替换字符（U+FFFD = 按错编码解码的铁证）。
  if (withPath.some((entry) => containsReplacementChar(entry.executablePath))) return false;
  // 判据 3：路径里不得出现 Windows 禁止的文件名字符（? * | < > " …）。
  if (withPath.some((entry) => pathHasForbiddenChar(entry.executablePath))) return false;
  // 判据 4：ASCII 骨架相同却整体不同 ⇒ 差异只发生在非 ASCII 位置 ⇒ 被写坏了。
  if (target && withPath.some((entry) => {
    const normalized = normalizeWinPath(entry.executablePath);
    return normalized !== target && asciiSkeleton(normalized) === targetAscii;
  })) return false;
  return true;
}

/**
 * 收尾阶段的「零残留」判据：列出所有「本次启动拉起、且现在还在跑」的进程。
 *
 * 判据 = **两个信号的并集**：
 *
 *   A) 路径匹配 —— ExecutablePath 归一化后等于目标 exe，且 pid 不在启动前快照。
 *      与 selectMainPid 共用同一套路径归一，但**不排除** `--type=` 子进程：
 *      清理断言要的是「一个都不剩」，渲染/GPU 子进程若残留同样算残留（它们会
 *      占住 userData 锁）。
 *
 *   B) 创建时间 —— CreationDate >= launchedAt - CREATION_TIME_TOLERANCE_MS，
 *      且 pid 不在启动前快照，且进程名等于目标 exe 的 basename。
 *
 * 为什么必须是并集（这是本次修复的核心）：路径比对在数据被污染时**静默失配** ——
 * 归一化后不相等 ⇒ 过滤结果为空 ⇒ 「没有残留」，而事实是残留着一堆。空数组在这
 * 条路径上恰恰是「坏掉」的输出，不是「干净」的输出。创建时间是**独立于路径**的
 * 信号：它只依赖 ASCII 安全的 exe 名与 epoch 毫秒，路径整体被写坏时它仍然成立。
 * 两个信号都为空的交集，才敢下「零残留」的结论。
 *
 * 容差 2 秒：进程表的 CreationDate 与 Node 侧的 Date.now() 来自两台不同的时钟
 * 来源（CIM 的系统时间 vs JS 的系统时间），且 spawn 之前基线的建立与首个进程
 * 的创建可能相差毫秒级。2 秒足够覆盖采样抖动，又不会把「启动前就存在的进程」
 * 误判成残留（那种进程的 pid 本来就在快照里，由 pid 差集排除）。
 *
 * @param {{processes:*, exePath:string, baselinePids:Set<number>|number[],
 *   launchedAt?:number}} args
 *   launchedAt 缺省时只启用信号 A（保持旧调用方行为不变）。
 * @returns {Array<{pid:number, executablePath:string, commandLine:string, creationDate:string}>}
 */
function findResidualProcesses({ processes, exePath, baselinePids, launchedAt } = {}) {
  const target = normalizeWinPath(exePath);
  const baseline = baselinePids instanceof Set ? baselinePids : new Set(baselinePids || []);
  const targetBase = winBasename(exePath);
  const launchMs = Number(launchedAt);
  const hasLaunch = Number.isFinite(launchMs);
  return parseProcessList(processes).filter((entry) => {
    if (baseline.has(entry.pid)) return false;
    // 信号 A：路径匹配（不排除 --type= 子进程 —— 清理要「一个都不剩」）。
    if (target && normalizeWinPath(entry.executablePath) === target) return true;
    // 信号 B：创建时间（与路径无关的独立信号）。
    if (!hasLaunch || !targetBase) return false;
    const createdMs = parseCreationTimeMs(entry.creationDate);
    if (createdMs == null) return false;
    if (createdMs < launchMs - CREATION_TIME_TOLERANCE_MS) return false;
    return processNameMatches(entry, targetBase);
  });
}

/**
 * 解析「本次要用哪种启动策略」，把三种形态收敛成一个纯函数，避免判定散落在
 * 脚本里。
 *
 * 三种策略（详见 scripts/smoke-test-manual.js 头注释）：
 *   direct + 旗标（默认）  —— 日常 CI 用，受限环境下第 8 条必红；
 *   direct + 裸启动        —— SMOKE_BARE_LAUNCH=1，验证「去掉环境适配后」的表现；
 *   shell（explorer 代理） —— SMOKE_LAUNCH_VIA_SHELL=1，受限环境下唯一能验证
 *                             渲染层的路径。
 *
 * 非 Windows 平台设置 shell 开关时**必须报错**，不许静默降级成直启：降级之后
 * 汇总行仍印「N/8 通过」，读验收单的人会以为渲染层是在 shell 模式下验过的。
 *
 * @param {Record<string,string|undefined>} env 进程环境（通常是 process.env）。
 * @param {string} platform process.platform 的取值。
 * @returns {{mode:'direct'|'shell', viaShell:boolean, bare:boolean, error:string}}
 *   error 非空表示配置非法，调用方应 exit 1 且不得启动任何进程。
 */
function resolveLaunchStrategy(env, platform) {
  const source = env || {};
  const viaShell = source.SMOKE_LAUNCH_VIA_SHELL === '1';
  const bare = source.SMOKE_BARE_LAUNCH === '1';
  if (viaShell && platform !== 'win32') {
    return {
      mode: 'direct',
      viaShell,
      bare,
      error: 'explorer 代理仅 Windows 可用（SMOKE_LAUNCH_VIA_SHELL=1 依赖 explorer.exe 桌面会话）；'
        + `当前平台 ${platform}，请改用直启模式，不要用本开关假装验证过渲染层`,
    };
  }
  return { mode: viaShell ? 'shell' : 'direct', viaShell, bare, error: '' };
}

module.exports = {
  CREATION_TIME_TOLERANCE_MS,
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
  logIncrementalState,
  rendererLoadedState,
  normalizeWinPath,
  parseProcessList,
  parseCreationTimeMs,
  winBasename,
  asciiSkeleton,
  containsReplacementChar,
  pathHasForbiddenChar,
  isTargetMainProcess,
  selectMainPid,
  findPreexistingMainProcesses,
  findUnreadablePathProcesses,
  pathDataLooksUsable,
  renderWaitSettled,
  findResidualProcesses,
  resolveLaunchStrategy,
};
