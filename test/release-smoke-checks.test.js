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

