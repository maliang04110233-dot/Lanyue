'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
  logIncrementalState,
  rendererLoadedState,
} = require('../scripts/release-smoke-checks.cjs');

test('首实例只有在无拉起错误且观察期内持续存活时通过', () => {
  assert.equal(processStayedAlive({ spawnError: null, exitCode: null, exitSignal: null, timedOut: true }), true);
  assert.equal(processStayedAlive({ spawnError: null, exitCode: 1, exitSignal: null, timedOut: false }), false);
  assert.equal(processStayedAlive({ spawnError: new Error('ENOENT'), exitCode: null, exitSignal: null, timedOut: false }), false);
});

test('第二实例必须快速以 0 退出，证明单实例锁生效', () => {
  assert.equal(secondInstanceWasRejected({ firstAlive: true, secondSpawnError: null, secondExitCode: 0, secondTimedOut: false }), true);
  assert.equal(secondInstanceWasRejected({ firstAlive: true, secondSpawnError: null, secondExitCode: null, secondTimedOut: true }), false);
  assert.equal(secondInstanceWasRejected({ firstAlive: false, secondSpawnError: null, secondExitCode: 0, secondTimedOut: false }), false);
});

test('启动日志拒绝常见致命错误，但允许普通 warning', () => {
  assert.equal(startupLogLooksHealthy('[main] ready\nwarning: optional feature disabled'), true);
  assert.equal(startupLogLooksHealthy('Cannot find module axios'), false);
  assert.equal(startupLogLooksHealthy('Unhandled rejection: boom'), false);
  assert.equal(startupLogLooksHealthy('SyntaxError: Unexpected token'), false);
});

// 真机 e2e 扩项（2026-10-17）：全局快捷键注册成功是既有日志证据
// （真机 main.log 实测「[shortcuts] 全局快捷键已注册 3/3」），此前从未被
// 门禁断言过。这里钉住判据：出现「已注册 N/M」且 N>=1 才算通过。
test('全局快捷键：日志出现「已注册 N/M」且 N>=1 才算注册成功', () => {
  assert.equal(shortcutsRegisteredInLog('[LOG] [shortcuts] 全局快捷键已注册 3/3'), true);
  assert.equal(shortcutsRegisteredInLog('[LOG] [shortcuts] 全局快捷键已注册 2/3'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 0/3'), false, '一枚都没注册上不算通过');
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 注册失败（可能已被系统或其它应用占用）'), false, '只有失败记录而无成功行不算通过');
  assert.equal(shortcutsRegisteredInLog(''), false);
  assert.equal(shortcutsRegisteredInLog(null), false);
});

test('全局快捷键：被占用时允许 N<M，但 N 必须为正整数', () => {
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 1/4'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 4/4'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 abc/4'), false, '不匹配正则相等价于「没有注册行」');
});

// 托盘：createTray 失败路径（图标加载失败 / Tray 构造抛错）都会走
// [tray] warn 链路（src/main/tray.js:52、src/main/index.js:389 之外的兜底）。
// 正常启动时日志里不应出现 [tray] 的失败记录。
test('托盘：日志中不应出现 [tray] 失败记录', () => {
  assert.equal(trayFailureAbsent('ready\nno errors here'), true);
  assert.equal(trayFailureAbsent('[tray] 图标加载失败: ENOENT'), false);
  assert.equal(trayFailureAbsent('[tray] 打开桌面歌词失败: xxx'), false);
  assert.equal(trayFailureAbsent(''), true);
  assert.equal(trayFailureAbsent(null), true);
});

// 假绿回归（2026-10-23 真机）：本次启动一行日志都没写时，旧实现静默退化为
// 「历史尾部 20000 字节」，三条日志断言因此 PASS —— 读到的是前一天的历史
// 尾部（含「[shortcuts] 全局快捷键已注册 3/3」）。这里把「增量状态」钉成判据：
// 'fresh' 才允许采信增量内容，'empty'（无新增）与 'rotated'（轮转/截断）都不行。
test('日志增量状态：无新增字节必须判 empty，不得退化为历史尾部', () => {
  assert.equal(logIncrementalState(1000, 1000), 'empty', '本次启动零新增');
  assert.equal(logIncrementalState(0, 0), 'empty', '空日志文件也没有本次新增');
  assert.equal(logIncrementalState(77579, 77579), 'empty');
});

test('日志增量状态：当前长度短于启动前偏移说明被轮转/截断', () => {
  assert.equal(logIncrementalState(1000, 2000), 'rotated');
  assert.equal(logIncrementalState(0, 1), 'rotated');
});

test('日志增量状态：有新增字节才算 fresh', () => {
  assert.equal(logIncrementalState(1000, 500), 'fresh');
  assert.equal(logIncrementalState(1001, 1000), 'fresh', '只多 1 字节也是新增');
  assert.equal(logIncrementalState(500, 0), 'fresh', '基线 0 = 启动前无日志，整份为新内容');
});

test('日志增量状态：非法入参一律归 empty（宁可判红不可假绿）', () => {
  assert.equal(logIncrementalState(undefined, 0), 'empty');
  assert.equal(logIncrementalState(1000, undefined), 'empty');
  assert.equal(logIncrementalState(null, null), 'empty', 'Number(null)===0，不能靠 Number 兜底');
  assert.equal(logIncrementalState(NaN, 0), 'empty');
  assert.equal(logIncrementalState(Infinity, 0), 'empty');
});

// 「empty 状态下不得判绿」的行为断言。判据本身在脚本里（需要读真实文件长度），
// 纯函数只负责给出状态，因此这里做两件事：
//   1) 复现脚本里的门控语义：只有 fresh 才允许三条日志断言为真；
//   2) 静态守卫 scripts/smoke-test-manual.js 的调用顺序，防止有人把
//      canAssertLogContent 的判定挪到 check 之后、或改回「静默退化为尾部」。
test('empty / rotated 状态下三条日志断言一律不得判绿', () => {
  // 历史尾部：真实存在过的旧日志内容，含 shortcuts 成功行、无致命错误、无 [tray]。
  const staleTail = [
    '2026-10-22T05:26:11.000Z [LOG] [logger] 日志落盘已启用',
    '2026-10-22T05:26:11.100Z [LOG] [shortcuts] 全局快捷键已注册 3/3',
  ].join('\n');
  assert.equal(logIncrementalState(staleTail.length, staleTail.length), 'empty');
  assert.equal(logIncrementalState(staleTail.length, staleTail.length + 500), 'rotated');

  // 脚本中的门控写法：canAssertLogContent = logState === 'fresh'，三条断言都与之相与。
  const gate = (state) => state === 'fresh' &&
    (startupLogLooksHealthy(staleTail) && shortcutsRegisteredInLog(staleTail) && trayFailureAbsent(staleTail));
  assert.equal(gate('empty'), false, '无新增时即使历史日志「看起来健康」也不许判绿');
  assert.equal(gate('rotated'), false, '轮转/截断时无法区分新旧，同样不许判绿');
  assert.equal(gate('fresh'), true, '只有确有新增字节时才允许采信内容');
});

test('静态守卫：冒烟脚本先判定增量状态，再决定三条日志断言', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'smoke-test-manual.js'), 'utf8');

  const callIdx = src.indexOf('logIncrementalState(buf.length, baseline)');
  assert.ok(callIdx > -1, '必须调用 logIncrementalState 判定增量状态');
  const gateIdx = src.indexOf("const canAssertLogContent = logState === 'fresh';");
  assert.ok(gateIdx > callIdx, 'canAssertLogContent 必须在状态判定之后');

  const assertIdx = src.indexOf("check('本次启动写了日志（main.log 增量非空）'");
  assert.ok(assertIdx > -1, '「本次启动写了日志」必须是独立断言');
  assert.ok(gateIdx > assertIdx, '门控必须在这条独立断言之后生效');

  // 三条日志断言都必须与门控相与，缺一条就是假绿通道。
  for (const name of ["check('本机 main.log 增量无常见致命错误'", "check('全局快捷键注册成功", "check('托盘启动无失败记录"]) {
    const i = src.indexOf(name);
    assert.ok(i > gateIdx, `${name} 断言必须位于门控之后`);
  }
  const gatedCount = (src.match(/canAssertLogContent && /g) || []).length;
  assert.equal(gatedCount, 3, '三条日志断言都要被 canAssertLogContent 门控');

  // 旧实现的静默退化写法必须彻底消失。
  assert.ok(!/sliceStart >= buf\.length/.test(src), '不得再出现「偏移超过文件长度就静默退化为尾部」的旧写法');
});

// ── 渲染层加载（2026-10-23 补的第 8 条）──────────────────────────────────
// 盲区：上面 7 条断言全部只证明「进程活着」。真机实测（--disable-gpu-sandbox，
// 本执行环境渲染进程沙箱起不来）进程存活 6 秒、第二实例被拒、日志有新增、
// 快捷键 3/3、托盘无告警 —— 7/7 全绿，但 main.log 每次都是
// 「[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading
// 'file:///...app.asar/dist/renderer/index.html'」，CDP 查到 page target 存在
// 但 title=""，即用户拿到白屏。加 --no-sandbox 后同一 exe title="揽乐"、
// 日志「[main] loadFile done」。
// 判据来源：src/main/index.js:128-131 的既有日志。
test('渲染层加载：出现 [main] loadFile done 判 loaded', () => {
  assert.equal(rendererLoadedState('[LOG] [main] loadFile done'), 'loaded');
  assert.equal(rendererLoadedState([
    '2026-10-23T01:02:03.000Z [LOG] [logger] 日志落盘已启用',
    '2026-10-23T01:02:03.400Z [LOG] [main] loadFile done',
    '2026-10-23T01:02:03.500Z [LOG] [shortcuts] 全局快捷键已注册 3/3',
  ].join('\n')), 'loaded');
});

test('渲染层加载：出现 [main] loadFile failed 判 failed（白屏不得判绿）', () => {
  assert.equal(rendererLoadedState(
    "[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///C:/app.asar/dist/renderer/index.html'",
  ), 'failed');
  // 真机上失败行与快捷键/托盘成功行同时出现是常态 —— 其余判据绿不代表界面画出来了。
  assert.equal(rendererLoadedState([
    '[LOG] [shortcuts] 全局快捷键已注册 3/3',
    "[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///x/index.html'",
  ].join('\n')), 'failed');
});

test('渲染层加载：两者都没出现判 unknown（不许当成功）', () => {
  assert.equal(rendererLoadedState(''), 'unknown');
  assert.equal(rendererLoadedState('[LOG] [shortcuts] 全局快捷键已注册 3/3'), 'unknown');
  assert.equal(rendererLoadedState('loadFile 相关日志口径变了，只打了 done 字样'), 'unknown');
});

test('渲染层加载：先 failed 后 done 按最后一次算（重试成功要能表达）', () => {
  assert.equal(rendererLoadedState([
    "[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///a/index.html'",
    '[LOG] [main] trying dev server URL: http://localhost:5173',
    '[LOG] [main] loadFile done',
  ].join('\n')), 'loaded');
});

test('渲染层加载：先 done 后 failed 也按最后一次算（重试后仍失败必须判红）', () => {
  assert.equal(rendererLoadedState([
    '[LOG] [main] loadFile done',
    "[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///b/index.html'",
  ].join('\n')), 'failed');
});

test('渲染层加载：非字符串入参一律判 unknown（宁可判红不可假绿）', () => {
  assert.equal(rendererLoadedState(undefined), 'unknown');
  assert.equal(rendererLoadedState(null), 'unknown');
  assert.equal(rendererLoadedState(0), 'unknown');
});

// 静态守卫：受限环境要能跑完其余 7 条并留痕，但跳过必须是**显式**的、
// 且绝不能把 failed 判成 PASS。开关写成真值判断（'0'/'false'/'no' 也生效）
// 就等于把本机这条真红藏起来，是最坏的失效方向。
test('静态守卫：渲染层断言的跳过必须显式（严格 === "1"），且不得把 failed 判绿', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'smoke-test-manual.js'), 'utf8');

  assert.ok(
    /const SKIP_RENDER_CHECK = process\.env\.SMOKE_SKIP_RENDER_CHECK === '1';/.test(src),
    '跳过开关必须严格比较字符串 1（真值判断会让 =0 也跳过）',
  );
  assert.ok(!/if \(process\.env\.SMOKE_SKIP_RENDER_CHECK\)/.test(src), '不得用真值判断读取该开关');

  const branchIdx = src.indexOf('if (SKIP_RENDER_CHECK) {');
  const skipCallIdx = src.indexOf('skip(RENDER_CHECK_NAME');
  assert.ok(branchIdx > -1, '跳过必须落在 if (SKIP_RENDER_CHECK) 分支里');
  assert.ok(skipCallIdx > branchIdx, 'skip() 只能在显式开关分支内调用');
  assert.equal((src.match(/\bskip\(RENDER_CHECK_NAME/g) || []).length, 1,
    'SKIP 分支只允许一处，避免出现「默认跳过」的第二条路径');

  // 纯函数确实被消费，且失败分支必须带上日志原文原因与白屏归因提示。
  assert.ok(src.indexOf('rendererLoadedState(incremental)') > branchIdx,
    '第 8 条判定必须调用 rendererLoadedState');
  assert.ok(src.includes('rendererFailureDetail(incremental)'),
    'failed 分支必须把日志里的失败原因带进 message');
  assert.ok(src.includes('RENDER_FAIL_HINT'), 'failed 分支必须带白屏归因提示');

  // 汇总行必须体现跳过数与渲染层结论。
  assert.ok(src.includes('${skippedPart}'), '汇总行必须体现跳过数');
  assert.ok(src.includes('渲染层: ${rendererSummary}'), '汇总行必须体现渲染层结论');
});

// ── 启动策略（2026-10-23：换策略而不是换旗标）──────────────────────────────
// 背景：七种旗标组合实测全部拿不到渲染进程（只有 --no-sandbox 能加载），说明
// 「再窄一点的旗标」这条路不存在。改走 explorer 代理后进程树 total=3→4、
// renderer 0→1、loadFile failed→done。为了让这条路可控，策略解析、进程表
// 解析、pid 发现都抽成纯函数钉在这里。
const {
  normalizeWinPath,
  parseProcessList,
  parseCreationTimeMs,
  winBasename,
  isTargetMainProcess,
  selectMainPid,
  findPreexistingMainProcesses,
  findUnreadablePathProcesses,
  pathDataLooksUsable,
  renderWaitSettled,
  findResidualProcesses,
  resolveLaunchStrategy,
} = require('../scripts/release-smoke-checks.cjs');

test('启动策略：默认直启，开关严格 === "1"，shell 未启用时不得改变行为', () => {
  const fallback = resolveLaunchStrategy({}, 'win32');
  assert.equal(fallback.mode, 'direct');
  assert.equal(fallback.error, '');
  assert.equal(resolveLaunchStrategy({ SMOKE_BARE_LAUNCH: '1' }, 'win32').bare, true);
  assert.equal(resolveLaunchStrategy({ SMOKE_LAUNCH_VIA_SHELL: '1' }, 'win32').mode, 'shell');
  // 严格字符串比较：'0'/'false'/'no'/'' 一律视为未开启（真值判断会让 =0 生效）。
  for (const value of ['0', 'false', 'no', '', 'TRUE', ' true']) {
    assert.equal(resolveLaunchStrategy({ SMOKE_LAUNCH_VIA_SHELL: value }, 'win32').mode, 'direct',
      `SMOKE_LAUNCH_VIA_SHELL=${JSON.stringify(value)} 不得开启 shell 模式`);
  }
});

test('启动策略：非 Windows 设置 shell 开关必须报错，不许静默降级成直启', () => {
  for (const platform of ['darwin', 'linux']) {
    const strategy = resolveLaunchStrategy({ SMOKE_LAUNCH_VIA_SHELL: '1' }, platform);
    assert.notEqual(strategy.error, '', `${platform} 上必须报错`);
    assert.ok(strategy.error.includes('explorer 代理仅 Windows 可用'),
      '错误文案必须写明「explorer 代理仅 Windows 可用」，否则使用者会以为是别的故障');
    assert.ok(strategy.error.includes(platform), '错误文案要带上当前平台，便于排查');
  }
  // 未设置开关时非 Windows 不报错（走既有的 exit 2 平台门禁，行为不变）。
  assert.equal(resolveLaunchStrategy({}, 'darwin').error, '');
});

test('路径归一：大小写、正斜杠、引号、\\\\?\\ 前缀都要能在比较时抹平', () => {
  const canonical = normalizeWinPath('C:\\App\\Lanyue.exe');
  assert.equal(canonical, 'c:/app/lanyue.exe');
  assert.equal(normalizeWinPath('c:/APP/lanyue.EXE'), canonical);
  assert.equal(normalizeWinPath(' "C:\\App\\Lanyue.exe" '), canonical);
  assert.equal(normalizeWinPath('\\\\?\\C:\\App\\Lanyue.exe'), canonical);
  assert.equal(normalizeWinPath('C:\\App\\Lanyue.exe\\'), canonical, '尾随反斜杠要抹平');
  assert.equal(normalizeWinPath(null), '');
  assert.equal(normalizeWinPath(undefined), '');
});

test('进程表解析：ConvertTo-Json 的三种形态（空/单对象/数组）都要吃得下', () => {
  // 零匹配时 PowerShell 输出空串，不是 []。
  assert.deepEqual(parseProcessList(''), []);
  assert.deepEqual(parseProcessList('   '), []);
  assert.deepEqual(parseProcessList(null), []);
  assert.deepEqual(parseProcessList('not-json'), [], '解析失败归空数组（随后走发现超时失败）');

  // 单匹配输出对象。
  assert.deepEqual(parseProcessList(JSON.stringify({
    ProcessId: 1234, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"',
  })), [{
    pid: 1234,
    executablePath: 'C:\\App\\Lanyue.exe',
    commandLine: '"C:\\App\\Lanyue.exe"',
    creationDate: '',
  }]);

  // 多匹配输出数组，且非法 pid 的记录被剔除。
  const many = parseProcessList(JSON.stringify([
    { ProcessId: 10, ExecutablePath: 'C:\\a.exe', CommandLine: '' },
    { ProcessId: 11, ExecutablePath: 'C:\\b.exe', CommandLine: '--type=renderer' },
    { ProcessId: null, ExecutablePath: 'C:\\c.exe', CommandLine: '' },
  ]));
  assert.deepEqual(many.map((p) => p.pid), [10, 11]);

  // 缺失字段不得抛错：CommandLine/ExecutablePath 变空串，仍参与后续判定。
  assert.deepEqual(parseProcessList(JSON.stringify([{ ProcessId: 7 }])),
    [{ pid: 7, executablePath: '', commandLine: '', creationDate: '' }]);
});

// CreationDate 的 JSON 形态必须能吃下：Windows PowerShell 5.1 的
// ConvertTo-Json 给的是 **/Date(毫秒)/**（JavaScriptSerializer 形态），不是 ISO 串
// —— 实测原文："CreationDate":"\/Date(1792117273962)\/"。
// 解析不出来时返回 null（=「这条记录没有创建时间」），绝不能抛错。
test('创建时间解析：吃下 /Date(ms)/ 形态（PS 5.1 实测形态）与 ISO 形态', () => {
  assert.equal(parseCreationTimeMs('/Date(1792117273962)/'), 1792117273962);
  assert.equal(parseCreationTimeMs('\\/Date(1792117273962)\\/'), 1792117273962, 'JSON 转义形态也要吃得下');
  assert.equal(parseCreationTimeMs(1792117273962), 1792117273962);
  assert.equal(parseCreationTimeMs('1792117273962'), 1792117273962);
  assert.equal(
    parseCreationTimeMs('2026-10-23T07:30:57.502000+08:00'),
    Date.parse('2026-10-23T07:30:57.502+08:00'),
    'ISO 形态（微秒小数 + 偏移）也要能解析',
  );
});

test('创建时间解析：解析不出来一律 null，不得抛错（该记录退化为只看路径）', () => {
  assert.equal(parseCreationTimeMs(null), null);
  assert.equal(parseCreationTimeMs(undefined), null);
  assert.equal(parseCreationTimeMs(''), null);
  assert.equal(parseCreationTimeMs('   '), null);
  assert.equal(parseCreationTimeMs('not-a-date'), null);
  assert.equal(parseCreationTimeMs('/Date(abc)/'), null);
  assert.equal(parseCreationTimeMs(NaN), null);
});

const EXE = 'C:\\App\\Lanyue.exe';

test('pid 发现：按路径大小写不敏感命中，且排除 --type= 子进程', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 100, ExecutablePath: 'c:/app/LANYUE.EXE', CommandLine: '"C:\\App\\Lanyue.exe" --type=renderer' },
    { ProcessId: 101, ExecutablePath: 'C:\\Other\\Lanyue.exe', CommandLine: '"C:\\Other\\Lanyue.exe"' },
    { ProcessId: 102, ExecutablePath: 'C:/App/Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
  ]));
  assert.equal(selectMainPid({ processes, exePath: EXE, baselinePids: new Set() }), 102,
    '必须跳过渲染子进程(100)与同名不同路径(101)，命中真正的主进程(102)');
});

test('pid 发现：启动前快照里的 pid 一律不得被选中（保护用户正在用的实例）', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 200, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
  ]));
  assert.equal(selectMainPid({ processes, exePath: EXE, baselinePids: new Set([200]) }), null,
    '用户手上的实例（快照内）绝不能被当成本次被测对象');
  assert.equal(selectMainPid({ processes, exePath: EXE, baselinePids: [200] }), null,
    '数组形态的快照同样生效');
  assert.equal(selectMainPid({ processes, exePath: EXE, baselinePids: new Set([1, 2]) }), 200,
    '快照外的 pid 才能被选中');
  assert.equal(selectMainPid({ processes: [], exePath: EXE, baselinePids: new Set() }), null);
  assert.equal(selectMainPid({ processes: [], exePath: '', baselinePids: new Set() }), null,
    '目标路径为空时不得命中任何进程');
});

test('零残留：路径匹配且不在快照内即算残留，--type= 子进程也算', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 300, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
    { ProcessId: 301, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '--type=renderer' },
    { ProcessId: 302, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
    { ProcessId: 303, ExecutablePath: 'C:\\Other\\Lanyue.exe', CommandLine: '' },
  ]));
  // 300/302 是本次启动的（302 已在快照里 = 用户实例，不算残留）。
  const residual = findResidualProcesses({ processes, exePath: EXE, baselinePids: new Set([302]) });
  assert.deepEqual(residual.map((p) => p.pid), [300, 301]);
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE, baselinePids: new Set([300, 301, 302]) }),
    [], '全部在快照内 = 零残留（不会把用户实例算成残留）');
});

test('零残留判定不得把 isTargetMainProcess 的 --type= 排除规则带进来', () => {
  // 显式钉住：清理要「一个都不剩」，与 pid 发现的谓词不共用 --type= 过滤。
  const entry = { pid: 401, executablePath: 'C:\\App\\Lanyue.exe', commandLine: '--type=gpu-process' };
  assert.equal(isTargetMainProcess({ entry, exePath: EXE, baselinePids: new Set() }), false,
    'pid 发现必须排除 --type= 子进程');
  assert.deepEqual(
    findResidualProcesses({ processes: [entry], exePath: EXE, baselinePids: new Set() }).map((p) => p.pid),
    [401], '清理检查必须把 --type= 残留中子进程算进来');
});

// ── 路径数据可用性（2026-10-23 收口：守卫不许自己说谎）──────────────────────
// QA 变异实测：把 stdout 的 UTF8 声明删掉 → 路径里的中文被按 CP936 写、
// 再按 utf8 解码 → 归一化后永远比不相等 → 「零残留检查」打印「清理: 零残留」，
// 而机器上还有 4 个 Lanyue.exe 在跑。守卫报告了与事实相反的结论。
// 下面这组用例把「路径数据是否可用」钉成一个可判定的布尔值。

/**
 * 本机真实路径（产物在中文目录下）与它被 CP936 写坏后的样子。
 * 污染串是 2026-10-23 真机实测原文（PS 不设 UTF8 声明 → stdout 按 936 写出 →
 * Node 按 utf8 解码）：非 ASCII 段变成 U+FFFD / U+00BD / U+013C，
 * 而 **ASCII 段逐字节保留**。
 */
const EXE_ZH = 'F:\\新建文件夹\\Lanyue-1.0.35\\release\\win-unpacked\\Lanyue.exe';
const EXE_ZH_CORRUPTED = 'F:\uFFFD\u00BD\uFFFD\uFFFD\u013C\uFFFD\uFFFD\uFFFD'
  + '\\Lanyue-1.0.35\\release\\win-unpacked\\Lanyue.exe';

test('路径数据可用性：真机实测的污染路径必须被判为「不可用」（否则守卫会说谎）', () => {
  // 前置事实：污染**不改变 basename**（exe 名是 ASCII，损坏只影响非 ASCII 字符）。
  // 所以「只看 basename 是否命中」这条弱判据对污染完全无感 —— 必须靠别的信号识别。
  assert.equal(winBasename(EXE_ZH_CORRUPTED), winBasename(EXE_ZH),
    '损坏后的 basename 与真值相同 —— 这正是弱判据会漏掉的原因');
  assert.notEqual(normalizeWinPath(EXE_ZH_CORRUPTED), normalizeWinPath(EXE_ZH),
    '但整体路径已经永远比不相等 ⇒ 路径比对会静默失配');

  assert.equal(pathDataLooksUsable([], EXE_ZH), true, '没有记录 → 无从损坏');
  assert.equal(pathDataLooksUsable([{ ProcessId: 1, ExecutablePath: EXE_ZH }], EXE_ZH), true,
    '干净数据必须判可用');
  assert.equal(pathDataLooksUsable([{ ProcessId: 1, ExecutablePath: EXE_ZH_CORRUPTED }], EXE_ZH), false,
    '真机实测的污染数据必须判不可用（替换字符 + ASCII 骨架相同但整体不同）');
});

test('路径数据可用性：basename 全不匹配 ⇒ 不可用；路径全空 ⇒ 可用（交给盲区判据）', () => {
  assert.equal(pathDataLooksUsable([{ ProcessId: 1, ExecutablePath: 'C:\\Other\\OtherApp.exe' }], EXE_ZH),
    false, '非空路径里一条 basename 都没命中目标 exe ⇒ 这份数据不可信');
  assert.equal(pathDataLooksUsable([{ ProcessId: 2, ExecutablePath: null, CommandLine: 'x' }], EXE_ZH),
    true, '非空路径一条都没有 → 无从损坏（同名但路径全空由 findUnreadablePathProcesses 负责）');
  assert.equal(pathDataLooksUsable([{ ProcessId: 3, ExecutablePath: '' }], EXE_ZH), true);
  assert.equal(pathDataLooksUsable(null, EXE_ZH), true);
});

test('路径数据可用性：ASCII 乱码（把非 ASCII 段写成 ?）必须被判为不可用', () => {
  // Windows 禁止文件名里出现 ? * | < > " ⇒ 这条字符串根本不是一条真实的路径。
  const garbled = 'F:\\????\\Lanyue-1.0.35\\release\\win-unpacked\\Lanyue.exe';
  assert.equal(winBasename(garbled), winBasename(EXE_ZH), 'basename 仍然命中（弱判据看不出来）');
  assert.equal(pathDataLooksUsable([{ ProcessId: 1, ExecutablePath: garbled }], EXE_ZH), false,
    '含 Windows 非法文件名字符 ⇒ 不可用');
});

test('路径数据可用性：非法入参（目标路径为空）一律判不可用（fail-closed）', () => {
  assert.equal(pathDataLooksUsable([{ ProcessId: 1, ExecutablePath: EXE_ZH }], ''), false,
    '连目标 exe 名都拿不到 ⇒ 无法判定 ⇒ 判不可用');
});

// ── 残留判定：路径信号 ∪ 创建时间信号 ───────────────────────────────────────
// 为什么要并集：路径比对在数据被污染时**静默失配**（过滤结果为空 = 「没有残留」，
// 而事实是残留着一堆）。创建时间是 ASCII 安全的独立信号：它只依赖 exe 名与
// epoch 毫秒，路径整体被写坏时依然成立。两个信号都为空才敢下「零残留」的结论。
test('残留判定：路径匹配算残留（既有口径不变）', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 500, ExecutablePath: EXE_ZH, CommandLine: `"${EXE_ZH}"`, CreationDate: '/Date(1000)/' },
  ]));
  const residual = findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set() });
  assert.deepEqual(residual.map((p) => p.pid), [500]);
});

test('残留判定：仅创建时间命中（路径不匹配）也算残留 —— 独立信号', () => {
  const launchedAt = 1_700_000_000_000;
  const created = new Date(launchedAt + 1000).getTime();
  const processes = parseProcessList(JSON.stringify([
    // 路径被写坏（比不相等），但创建时间在启动之后、pid 不在快照、进程名命中。
    {
      ProcessId: 600,
      ExecutablePath: EXE_ZH_CORRUPTED,
      CommandLine: `"${EXE_ZH_CORRUPTED}"`,
      CreationDate: `/Date(${created})/`,
    },
  ]));
  const residual = findResidualProcesses({
    processes, exePath: EXE_ZH, baselinePids: new Set(), launchedAt,
  });
  assert.deepEqual(residual.map((p) => p.pid), [600],
    '路径信号失配时，创建时间这条独立信号必须能把残留捞出来');
});

test('残留判定：创建时间早于启动时刻（超出容差）⇒ 不算残留', () => {
  const launchedAt = 1_700_000_000_000;
  const before = new Date(launchedAt - 60_000).getTime();
  const processes = parseProcessList(JSON.stringify([
    {
      ProcessId: 601,
      ExecutablePath: 'C:\\Other\\Lanyue.exe',
      CommandLine: '"C:\\Other\\Lanyue.exe"',
      CreationDate: `/Date(${before})/`,
    },
  ]));
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set(), launchedAt }),
    [], '启动前就存在的进程不算本次残留',
  );
});

test('残留判定：两个信号都不命中 ⇒ 不算残留', () => {
  const launchedAt = 1_700_000_000_000;
  const before = new Date(launchedAt - 60_000).getTime();
  const processes = parseProcessList(JSON.stringify([
    {
      ProcessId: 602,
      ExecutablePath: 'C:\\Other\\OtherApp.exe',
      CommandLine: '"C:\\Other\\OtherApp.exe"',
      CreationDate: `/Date(${before})/`,
    },
  ]));
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set(), launchedAt }),
    [], '路径不匹配 + 创建时间在启动前 ⇒ 不算残留',
  );
});

test('残留判定：快照内的 pid 一律不算残留；无 launchedAt 时只认路径信号', () => {
  const launchedAt = 1_700_000_000_000;
  const created = new Date(launchedAt + 1000).getTime();
  const processes = parseProcessList(JSON.stringify([
    {
      ProcessId: 603,
      ExecutablePath: 'C:\\Other\\Lanyue.exe',
      CommandLine: '"C:\\Other\\Lanyue.exe"',
      CreationDate: `/Date(${created})/`,
    },
  ]));
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set([603]), launchedAt }),
    [], '启动前快照里的 pid（用户实例）绝不能被算成残留',
  );
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set() }),
    [], '没有 launchedAt ⇒ 只认路径信号（不猜创建时间）',
  );
});

test('残留判定：创建时间解析不出来时退化为只看路径，且不得抛错', () => {
  const launchedAt = 1_700_000_000_000;
  const processes = parseProcessList(JSON.stringify([
    {
      ProcessId: 604,
      ExecutablePath: 'C:\\Other\\Lanyue.exe',
      CommandLine: '"C:\\Other\\Lanyue.exe"',
      CreationDate: '不是时间',
    },
  ]));
  assert.deepEqual(
    findResidualProcesses({ processes, exePath: EXE_ZH, baselinePids: new Set(), launchedAt }),
    [], '解析不出创建时间 ⇒ 该记录不参与创建时间判据（且不得报错）',
  );
});

// 静态守卫：shell 模式是**换启动策略**，不是放宽判据。第 8 条仍然只能靠
// loadFile done 判定；清理检查不进 N/M 分母；开关不得成为默认。

test('静态守卫：explorer 代理模式不得给第 8 条开旁路，清理检查不得进 N/M 分母', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'smoke-test-manual.js'), 'utf8');

  // 策略解析走纯函数，且非法配置在启动任何进程之前 exit 1。
  const strategyIdx = src.indexOf('resolveLaunchStrategy(process.env, process.platform)');
  assert.ok(strategyIdx > -1, '必须用 resolveLaunchStrategy 解析启动策略');
  const exitIdx = src.indexOf('process.exit(1);', strategyIdx);
  const launchIdx = src.indexOf('await launchInstance(');
  assert.ok(exitIdx > strategyIdx && exitIdx < launchIdx,
    '非法策略必须在拉起任何进程之前 exit 1（否则会先跑一遍再报错）');

  // 第 8 条：判定分支里不许出现启动方式的字样（不许「shell 即通过」）。
  const branchIdx = src.indexOf("} else if (!canAssertLogContent) {");
  const renderStart = src.indexOf('const renderState = rendererLoadedState(incremental);');
  const renderEnd = src.indexOf('await shutdownInstance(second);', renderStart);
  assert.ok(branchIdx > -1 && renderStart > branchIdx, '渲染层判定仍须在增量门控之后');
  const renderSection = src.slice(renderStart, renderEnd);
  assert.ok(!/VIA_SHELL|launchStrategy/.test(renderSection),
    '渲染层判定分支不得引用启动方式 —— 它只能靠 loadFile done 判绿');
  assert.ok(renderSection.includes("renderState === 'loaded'"), 'loaded 仍是唯一判绿条件');

  // 清理检查：单独一行输出、不调用 check()/skip()（即不进 results，也不进分母）。
  const cleanupIdx = src.indexOf('function verifyCleanup(');
  assert.ok(cleanupIdx > -1, '必须有独立的 verifyCleanup');
  const cleanupBody = src.slice(cleanupIdx, src.indexOf('/**', cleanupIdx + 10));
  assert.ok(cleanupBody.includes('清理: 零残留'), '零残留必须单独成行');
  assert.ok(cleanupBody.includes('FAIL  清理后仍有残留进程'), '有残留必须显式 FAIL 并列出 pid');
  assert.ok(!/\bcheck\(|\bskip\(|results\.push\(/.test(cleanupBody),
    '清理检查不得写进 results —— 否则会挤进 N/M 分母');
  assert.ok(/const TOTAL_ASSERTIONS = 8;/.test(src), '分母必须仍是 8');
  assert.ok(/cleanupFailure/.test(src) && /cleanupFailure\) \? 1 : 0/.test(src),
    '有残留必须把退出码置 1');

  // 默认不得是 shell 模式。
  assert.ok(!/const VIA_SHELL = true/.test(src), 'shell 模式不得成为默认');
  assert.ok(src.includes('SMOKE_LAUNCH_VIA_SHELL=1') && src.includes('explorer 代理'),
    'ENV 行 / 头注释必须能区分三种启动方式');
});

// ── 前置条件：本机已有实例时必须拒绝（2026-10-23 收口）──────────────────────
// 背景：用户已经开着一个实例时，新实例被单实例锁拒绝、main.log 零增量，冒烟
// 必然印出「1/8 通过」。那是如实的红、错误的归因 —— 读验收单的人只会当成
// 产品缺陷。所以脚本在第一条断言之前先查这个谓词，命中就 PRECOND + exit 1。
test('前置条件：本机已有同路径主进程时必须被列出（--type= 子进程不算）', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 900, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
    { ProcessId: 901, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe" --type=renderer' },
    { ProcessId: 902, ExecutablePath: 'C:\\Other\\Lanyue.exe', CommandLine: '"C:\\Other\\Lanyue.exe"' },
  ]));
  assert.deepEqual(findPreexistingMainProcesses({ processes, exePath: EXE }).map((p) => p.pid), [900],
    '只认主进程：渲染子进程(901)与同名不同路径(902)都不算既有实例');

  assert.deepEqual(findPreexistingMainProcesses({ processes: [], exePath: EXE }), [],
    '没有既有实例 → 可以开跑');
  assert.deepEqual(findPreexistingMainProcesses({ processes: null, exePath: EXE }), [],
    '查询结果异常时不得凭空报「已有实例」（否则冒烟永远跑不起来）');
  assert.deepEqual(findPreexistingMainProcesses({ processes, exePath: '' }), [],
    '目标路径为空时不得误报');

  const onlyChildren = parseProcessList(JSON.stringify([
    { ProcessId: 903, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '--type=gpu-process' },
  ]));
  assert.deepEqual(findPreexistingMainProcesses({ processes: onlyChildren, exePath: EXE }), [],
    '只剩子进程（主进程已在退出）时不拦，交给 pid 发现分支自己报');
});

// ── 渲染层轮询（2026-10-23 收口：固定等待 → 轮询观测）──────────────────────
// 旧实现固定等 14s，余量只有 0.19s，慢机上必然假红（判 unknown）。判据没变，
// 变的只是「什么时候看」：得到明确结论立即停，不为时序牺牲结论。
test('轮询停止条件：拿到 loaded/failed 立即停，unknown 继续等', () => {
  const fresh = { logState: 'fresh', skipRenderCheck: false };
  assert.equal(renderWaitSettled({ ...fresh, logText: '[LOG] [main] loadFile done' }), true);
  assert.equal(renderWaitSettled({
    ...fresh,
    logText: "[WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///x/index.html'",
  }), true, 'failed 同样是明确结论（白屏要立刻判红，不必等满 30s）');
  assert.equal(renderWaitSettled({ ...fresh, logText: '[LOG] [shortcuts] 全局快捷键已注册 3/3' }), false,
    '只有快捷键行、没有 loadFile 结论时必须继续等');
  assert.equal(renderWaitSettled({ ...fresh, logText: '' }), false);
  assert.equal(renderWaitSettled({}), false, '空入参不许当作结论');
});

test('轮询停止条件：非 fresh 的增量不得当作结论（历史尾部不能冒充本次启动）', () => {
  for (const logState of ['empty', 'rotated']) {
    assert.equal(renderWaitSettled({
      logText: '[LOG] [main] loadFile done', logState, skipRenderCheck: false,
    }), false, `${logState} 状态下的 done 不能算结论`);
  }
});

test('轮询停止条件：第 8 条已显式跳过时，快捷键行出现即可停（要等的断言已被跳过）', () => {
  assert.equal(renderWaitSettled({
    logText: '[LOG] [shortcuts] 全局快捷键已注册 3/3', logState: 'fresh', skipRenderCheck: true,
  }), true);
  assert.equal(renderWaitSettled({
    logText: '[LOG] [shortcuts] 全局快捷键已注册 0/3', logState: 'fresh', skipRenderCheck: true,
  }), false, 'N=0 不算注册成功，继续等（与第 6 条判据一致）');
});

/** 读一遍冒烟脚本源码，供静态守卫使用。 */
const readSmokeScript = () => require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'scripts', 'smoke-test-manual.js'), 'utf8');

test('静态守卫：固定等待已删除，渲染层观测改为轮询且拿到结论即退出', () => {
  const src = readSmokeScript();

  assert.ok(!/const SHELL_LOG_SETTLE_MS/.test(src),
    '固定等待常量必须彻底删除（不留死代码）');
  assert.ok(/const RENDER_POLL_INTERVAL_MS = 400;/.test(src), '轮询间隔必须是 400ms');
  assert.ok(/const RENDER_WAIT_DEADLINE_MS = 30000;/.test(src), '上限必须是 30s');
  assert.ok(/const RENDER_WAIT_MIN_MS = 1500;/.test(src), '下限必须是 1500ms（等日志 flush）');

  const pollStart = src.indexOf('async function waitForRendererSnapshot(');
  assert.ok(pollStart > -1, '必须有独立的轮询函数');
  const pollBody = src.slice(pollStart, src.indexOf('async function main(', pollStart));
  assert.ok(pollBody.includes('rendererLoadedState('), '轮询里必须真正判定渲染层');
  assert.ok(pollBody.includes('renderWaitSettled('), '停止条件必须走纯函数（可单测）');
  assert.ok(/if \(settled\) return/.test(pollBody), '拿到结论必须立即返回，不得等满 deadline');
  assert.ok(pollBody.includes('RENDER_POLL_INTERVAL_MS'), '轮询间隔必须生效');
  assert.ok(pollBody.includes('RENDER_WAIT_DEADLINE_MS'), '上限必须生效');

  // 两种启动模式共用同一段轮询：只有一处调用，且不得包在 VIA_SHELL 分支里。
  assert.equal((src.match(/await waitForRendererSnapshot\(/g) || []).length, 1,
    '轮询必须只有一处调用（两种启动模式共用），否则直启路径会退回固定时序');
  const waitCallIdx = src.indexOf('await waitForRendererSnapshot(');
  assert.ok(!/if \(VIA_SHELL\) \{\s*const settle/.test(src), '不得残留 shell 专属的固定等待');
  assert.ok(waitCallIdx > src.indexOf('await launchInstance('), '轮询必须在启动之后');
  assert.ok(waitCallIdx < src.indexOf("check('本次启动写了日志（main.log 增量非空）'"),
    '轮询必须在消费增量日志的断言之前');
});

test('静态守卫：已有实例时在第一条断言之前 PRECOND 拒绝（exit 1，无 N/M 汇总）', () => {
  const src = readSmokeScript();

  const preIdx = src.indexOf('PRECOND 检测到本机已有同一路径的实例在运行');
  assert.ok(preIdx > -1, '必须输出 PRECOND 提示，说明「判红不是产品故障」');

  const preBlockStart = src.indexOf('const preexistingMain = ');
  assert.ok(preBlockStart > -1 && preBlockStart < preIdx, '判定必须先于 PRECOND 输出');
  assert.ok(src.slice(preBlockStart, preIdx).includes('findPreexistingMainProcesses('),
    '前置条件必须复用主进程谓词（排除 --type= 子进程）');

  const launchIdx = src.indexOf('await launchInstance(');
  const firstCheckIdx = src.indexOf("check('首实例启动后持续存活 6 秒'");
  assert.ok(launchIdx > -1 && firstCheckIdx > -1);
  assert.ok(preIdx < launchIdx, '前置检查必须在拉起任何进程之前');
  assert.ok(preIdx < firstCheckIdx, '前置检查必须在第一条断言之前（一条断言都不执行）');

  const exitIdx = src.indexOf('process.exit(1);', preIdx);
  assert.ok(exitIdx > preIdx && exitIdx < launchIdx, '命中前置条件必须 exit 1，且发生在启动之前');
  const preBlock = src.slice(preBlockStart, exitIdx);
  assert.ok(!/VIA_SHELL/.test(preBlock), '两种启动模式都必须生效，不得包在 VIA_SHELL 分支里');
  assert.ok(!/finish\(/.test(preBlock), '拒绝时不得打印 N/M 汇总（会被误读成结果）');
});

// ── 进程表查询的编码：路径数据**不得**再经 stdout 文本通道 ──────────────────
// 这一行被删掉时的表现极具欺骗性：中文路径归一化后与目标永不相等 → 「pid 发现
// 超时」+「零残留假绿」两个假象同时出现，且都不指向真因。
// 现在的口径是：路径数据走 **UTF-8 文件通道**（PowerShell 写文件、Node 读文件），
// stdout 只承载一行通道自检；那行 UTF8 声明不再承重，但删掉它会让冒烟**拒绝执行**。
test('静态守卫：路径数据必须走 UTF-8 文件通道，不得再经 stdout 文本通道', () => {
  const src = readSmokeScript();

  const fnIdx = src.indexOf('function queryTargetProcesses(');
  assert.ok(fnIdx > -1, '必须有进程表查询函数');

  // ① PowerShell 侧：JSON 必须写进文件，且是无 BOM 的 UTF-8。
  const writeIdx = src.indexOf('[System.IO.File]::WriteAllText(');
  assert.ok(writeIdx > fnIdx, 'PowerShell 必须把 JSON 写进文件（而不是写 stdout）');
  assert.ok(/WriteAllText\([^)]*UTF8Encoding\(\$false\)/.test(src),
    '必须用 UTF8Encoding($false) 写无 BOM 的 UTF-8（Out-File -Encoding utf8 会写 BOM）');
  const jsonIdx = src.indexOf('ConvertTo-Json');
  assert.ok(jsonIdx > -1 && jsonIdx < writeIdx, 'JSON 必须先算出来再写进文件');
  assert.ok(/const json = Get-CimInstance/.test(src) || /\$json = Get-CimInstance/.test(src),
    'ConvertTo-Json 的结果必须先赋给 $json（不能直接流到 stdout）');

  // ② Node 侧：按 utf8 读文件。
  const readIdx = src.indexOf("fs.readFileSync(outFile, 'utf8')");
  assert.ok(readIdx > fnIdx, 'Node 必须用 fs.readFileSync(..., \'utf8\') 读那个文件');

  // ③ 临时文件必须用完即删（异常路径也要删）。
  assert.ok(src.includes('fs.unlinkSync('), '临时文件必须删除');
  const fnBody = src.slice(fnIdx, src.indexOf('\nfunction ', fnIdx + 10));
  assert.ok(/finally\s*\{/.test(fnBody), '删除必须放在 finally 里（异常路径也要删）');
  assert.ok(/removeTempFile\(outFile\)/.test(fnBody), 'finally 里必须真的删掉那个临时文件');

  // ④ stdout 上的 UTF8 声明仍在，但它不再是承重的（路径数据不在 stdout 上）。
  const encIdx = src.indexOf('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  assert.ok(encIdx > fnIdx, '编码设置必须在 queryTargetProcesses 里');
  assert.ok(encIdx < jsonIdx, '编码设置必须早于 ConvertTo-Json');
  assert.ok(/encoding: 'utf8'/.test(src), 'execFileSync 的解码必须与上面声明的 UTF8 一致');
});

test('静态守卫：stdout 通道自检必须存在（删掉 UTF8 声明时拒绝执行，不得静默失配）', () => {
  const src = readSmokeScript();

  assert.ok(src.includes('function checkStdoutChannel('), '必须有通道自检函数');
  assert.ok(src.includes("const STDOUT_CANARY_PREFIX = 'CANARY|';"), '必须给自检行一个固定前缀');
  assert.ok(src.includes('WebName'), '自检必须核对 PowerShell 自报的输出编码名');
  assert.ok(/webName !== 'utf-8'/.test(src), '编码名不是 utf-8 ⇒ 通道不可信');
  assert.ok(src.includes('STDOUT_CANARY_PROBE'), '自检必须带一个非 ASCII 探针（纯 ASCII 探针检不出乱码）');

  // 探针必须真的是非 ASCII（否则「被写坏」也看不出来）。
  const probeDecl = /const STDOUT_CANARY_PROBE = '([^']*)';/.exec(src);
  assert.ok(probeDecl && probeDecl[1], '必须定义探针常量');
  assert.ok([...probeDecl[1]].some((ch) => ch.codePointAt(0) > 126), '探针必须含非 ASCII 字符');

  // 通道自检失败 ⇒ 拒绝执行（两种模式都拒绝），且不得打印 N/M 汇总。
  const errIdx = src.indexOf('进程表查询的通道自检失败');
  assert.ok(errIdx > -1, '必须报出通道自检失败');
  const exitIdx = src.indexOf('process.exit(1);', errIdx);
  const launchIdx = src.indexOf('await launchInstance(');
  assert.ok(exitIdx > errIdx && exitIdx < launchIdx, '通道自检失败必须 exit 1，且发生在启动之前');
});

// ── 路径数据不可用 ⇒ 必须 fail-closed（守卫不许自己说谎）──────────────────────
test('静态守卫：路径数据不可用时必须拒绝执行，收尾也不得宣称零残留', () => {
  const src = readSmokeScript();

  // ① 前置检查：pathDataLooksUsable 为 false ⇒ PRECOND + exit 1（一条断言都不跑）。
  assert.ok(src.includes('pathDataLooksUsable('), '必须调用 pathDataLooksUsable 判据');
  const preIdx = src.indexOf('PRECOND 进程表路径数据不可用');
  assert.ok(preIdx > -1, '必须输出「进程表路径数据不可用」这一行');
  const preExitIdx = src.indexOf('process.exit(1);', preIdx);
  const launchIdx = src.indexOf('await launchInstance(');
  const firstCheckIdx = src.indexOf("check('首实例启动后持续存活 6 秒'");
  assert.ok(preExitIdx > preIdx && preExitIdx < launchIdx, '必须 exit 1，且发生在拉起任何进程之前');
  assert.ok(preExitIdx < firstCheckIdx, '必须发生在第一条断言之前（一条断言都不执行）');
  assert.ok(!/finish\(/.test(src.slice(preIdx, preExitIdx)), '拒绝时不得打印 N/M 汇总');

  // ② 收尾：路径数据不可用 ⇒ 打印「无法确认」，绝不打印「零残留」。
  const cleanupIdx = src.indexOf('function verifyCleanup(');
  assert.ok(cleanupIdx > -1, '必须有独立的 verifyCleanup');
  const cleanupBody = src.slice(cleanupIdx, src.indexOf('/**', cleanupIdx + 10));
  assert.ok(cleanupBody.includes('pathDataLooksUsable('), '收尾也必须先判路径数据是否可用');
  assert.ok(cleanupBody.includes('清理: 无法确认（进程表路径数据不可用）—— 不得视为零残留'),
    '路径数据不可用时必须打印「无法确认」');
  const unusableIdx = cleanupBody.indexOf('清理: 无法确认（进程表路径数据不可用）');
  const zeroIdx = cleanupBody.indexOf('清理: 零残留');
  assert.ok(unusableIdx > -1 && zeroIdx > unusableIdx,
    '「无法确认」必须在「零残留」之前判定（先判可用，再谈零残留）');
  assert.ok(!/\bcheck\(|\bskip\(|results\.push\(/.test(cleanupBody),
    '清理检查不得写进 results —— 否则会挤进 N/M 分母');
});

test('静态守卫：残留判定必须是「路径信号 ∪ 创建时间信号」，不得只剩路径比对', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'release-smoke-checks.cjs'), 'utf8');

  const fnIdx = src.indexOf('function findResidualProcesses(');
  assert.ok(fnIdx > -1, '必须有 findResidualProcesses');
  const body = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx));
  assert.ok(body.includes('parseCreationTimeMs('), '残留判定必须用上创建时间这条独立信号');
  assert.ok(body.includes('CREATION_TIME_TOLERANCE_MS'), '创建时间判据必须有容差');
  assert.ok(body.includes('processNameMatches('), '创建时间判据必须核对进程名（否则会误伤同名进程）');
  assert.ok(body.includes('normalizeWinPath(entry.executablePath) === target'),
    '路径信号不得被移除（它是两个信号之一）');
  assert.ok(/CREATION_TIME_TOLERANCE_MS = 2000;/.test(src), '容差必须是 2000ms');
});

// ── shell 模式的混合口径必须在输出里自证 ───────────────────────────────────
test('静态守卫：第 2 条断言必须写明「第二实例经直启验证」并说明原因', () => {
  const src = readSmokeScript();
  assert.ok(src.includes('第二实例经直启验证（explorer 不返回退出码'),
    'shell 模式下第 2 条的 message 必须自证口径，否则读输出的人以为是代理验的');
  assert.ok(src.includes('验证口径: 第二实例经直启验证'),
    'message 必须带「验证口径」字样，便于在验收单上检索');
  assert.ok(src.indexOf('混合口径（只出现在 shell 模式') > -1,
    '头注释的启动策略一节必须补上这个混合点');
});

// ── 裁定 1：第 8 条已跳过时提前停止，但必须写明「刻意不等」──────────────────
// 背景：SKIP_RENDER_CHECK 下要等的就是那条被跳过的断言，等满 30s 纯属白等，
// 而且会促使人「宁可不加这个开关」。但提前停止不能伪装成「结论明确」——
// 那条断言本次记的是 SKIP，即便渲染层字样碰巧出现也不代表它是结论。
// 所以停止原因由开关决定，并单独印一行 WAIT 说明原因。
test('静态守卫：第 8 条跳过时的提前停止必须单独印 WAIT 写明原因', () => {
  const src = readSmokeScript();

  assert.ok(src.includes('WAIT  渲染层已跳过（SMOKE_SKIP_RENDER_CHECK=1），提前停止等待 @'),
    '跳过路径必须印出「渲染层已跳过…提前停止等待 @<秒>s」这一行');
  assert.ok(/提前停止等待 @\$\{waitedSecText\}s/.test(src),
    '必须带上「启动后多少秒就停了」的时间点，否则读的人以为是超时');

  const pollStart = src.indexOf('async function waitForRendererSnapshot(');
  const pollBody = src.slice(pollStart, src.indexOf('async function main(', pollStart));
  const skipLineIdx = pollBody.indexOf('渲染层已跳过（SMOKE_SKIP_RENDER_CHECK=1），提前停止等待');
  assert.ok(skipLineIdx > -1, '这一行必须落在轮询函数里（它是停止决策的一部分）');
  assert.ok(/const settledBySkip = settled && skipRenderCheck === true;/.test(pollBody),
    '停止原因必须由开关决定，不能由「渲染层碰巧有没有结论」决定');
  assert.ok(skipLineIdx > pollBody.indexOf('const settledBySkip = '),
    '跳过声明必须在停止原因判定之后');
  assert.ok(/settled && !settledBySkip \? ' → 结论明确，停止等待'/.test(pollBody),
    '跳过时不得再印「结论明确」（一句输出里不许有两个互相矛盾的停止理由）');
  assert.ok(pollBody.includes("stoppedBy: settledBySkip ? 'skip-render-check' : 'settled'"),
    '返回值必须把两种停止原因分开（skip-render-check 记的是 SKIP，不是结论）');
});

// ── 裁定 2：PRECOND 读不到 ExecutablePath 的盲区必须显式提示 ─────────────────
// 盲区现象：权限不足时 Win32_Process 会返回记录但 ExecutablePath 为空，按「路径
// 等值」谓词一律不算命中 → 前置检查输出「本机没有已存在实例」，随后又跑出
// 「1/8 通过」。所以要把这类记录数出来提示，并在第 1/4 条 FAIL 时关联归因。
test('前置盲区：ExecutablePath 读不到的同名进程必须被单独数出来', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 1, ExecutablePath: 'C:\\App\\Lanyue.exe', CommandLine: '"C:\\App\\Lanyue.exe"' },
    { ProcessId: 2, ExecutablePath: null, CommandLine: '"C:\\App\\Lanyue.exe"' },
    { ProcessId: 3, ExecutablePath: '', CommandLine: '' },
    { ProcessId: 4, ExecutablePath: null, CommandLine: 'Lanyue.exe --type=renderer' },
    { ProcessId: 5, ExecutablePath: '   ', CommandLine: null },
  ]));
  assert.deepEqual(findUnreadablePathProcesses({ processes }).map((p) => p.pid), [2, 3, 5],
    '路径为空/全空格的计入；路径可读的(1)与能确认是子进程的(4)不计入');
  assert.deepEqual(findUnreadablePathProcesses({ processes: [] }), [],
    '没有进程 → 没有盲区');
  assert.deepEqual(findUnreadablePathProcesses({ processes: null }), [],
    '查询结果异常时不得凭空报盲区（否则每台机器都刷一行 WARN）');
  assert.deepEqual(findUnreadablePathProcesses({}), [], '空入参不得抛错');
});

test('前置盲区：谓词层只负责「数出来 + 不误判为已有实例」，是否拒绝由脚本承担', () => {
  const processes = parseProcessList(JSON.stringify([
    { ProcessId: 11, ExecutablePath: null, CommandLine: '"C:\\Other\\Lanyue.exe"' },
  ]));
  assert.equal(findUnreadablePathProcesses({ processes }).length, 1, '盲区被数出来');
  assert.deepEqual(findPreexistingMainProcesses({ processes, exePath: EXE }), [],
    '谓词层不得把盲区当成「已有实例」—— 那会让脚本打出「本机已有实例」这种假结论');
  // 是否拒绝执行是**脚本层**的决定（见下面的静态守卫）：盲区存在时脚本必须
  // 拒绝执行，因为路径读不到 ⇒ 无法排除「用户的实例被当成本次启的那个」。
});

test('静态守卫：盲区必须打 WARN，并拒绝执行（不得被当成「没有已存在实例」）', () => {
  const src = readSmokeScript();

  const warnIdx = src.indexOf('前置检查存在盲区：若其中之一正是本包实例，本次结果可能被单实例锁干扰');
  assert.ok(warnIdx > -1, '必须输出这行 WARN，否则盲区对读输出的人不可见');
  assert.ok(/WARN {2}检测到 \$\{unreadablePathCount\}/.test(src), 'WARN 行要带盲区数量');
  assert.ok(src.includes('无法读取路径（权限不足）'), 'WARN 行要写明「权限不足」这个成因');

  // 盲区不得被当作「本机没有已存在实例」：WARN 之后必须拒绝执行（exit 1），
  // 且发生在拉起任何进程之前、且不得打印 N/M 汇总。
  const refuseIdx = src.indexOf('PRECOND 无法确认本机是否已有已存在实例');
  assert.ok(refuseIdx > -1, '必须输出「无法确认是否有已存在实例」这一行');
  assert.ok(refuseIdx > warnIdx, '拒绝必须紧跟在 WARN 之后（两件事相邻才看得出因果）');
  const exitIdx = src.indexOf('process.exit(1);', refuseIdx);
  const launchIdx = src.indexOf('await launchInstance(');
  assert.ok(exitIdx > refuseIdx && exitIdx < launchIdx, '盲区必须 exit 1，且发生在启动之前');
  const refuseBlock = src.slice(refuseIdx, exitIdx);
  assert.ok(!/finish\(/.test(refuseBlock), '拒绝时不得打印 N/M 汇总（会被误读成结果）');
  assert.ok(!/FAIL {2}检测到/.test(src), '盲区不得记 FAIL —— 它是前置条件，不是断言');

  // 归因必须接在第 1/4 条上，且只在失败时追加。
  assert.ok(src.indexOf('function withBlindSpotHint(') > -1, '必须有统一的追加函数');
  assert.ok(src.includes('可能是单实例锁干扰'), 'message 末尾要写出「可能是单实例锁干扰」');
  const firstAliveIdx = src.indexOf("check('首实例启动后持续存活 6 秒', firstAlive,");
  assert.ok(firstAliveIdx > -1, '第 1 条必须保留字面量调用形态（守卫认的是它）');
  assert.ok(src.slice(firstAliveIdx, src.indexOf('\n', firstAliveIdx) + 200).includes('withBlindSpotHint('),
    '第 1 条 FAIL 时必须追加盲区归因');
  const logAssertIdx = src.indexOf("check('本次启动写了日志（main.log 增量非空）', logState === 'fresh',");
  assert.ok(logAssertIdx > -1, '第 4 条必须保留字面量调用形态');
  assert.ok(src.slice(logAssertIdx, src.indexOf('\n', logAssertIdx) + 200).includes('withBlindSpotHint('),
    '第 4 条 FAIL 时必须追加盲区归因');

  // 通过的行不得挂归因（否则 PASS 后面写着「可能被干扰」，结论看起来不稳）。
  assert.ok(src.includes('firstAlive ? firstAliveDetail(first) : withBlindSpotHint('),
    '第 1 条只在失败分支追加归因');
  assert.ok(src.includes("logState === 'fresh' ? `${deltaBytes} B 新增` : withBlindSpotHint("),
    '第 4 条只在失败分支追加归因');
});


