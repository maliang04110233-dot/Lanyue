/**
 * ciDoctor.test.js —— scripts/ci-doctor.cjs 的归因规则自带自测
 *
 * 为什么必须补：轨道四的全部价值押在「同一段 TAP 文本，规则给出同一个结论」。
 * 归因脚本自己错判时，症状和 2026-10-14 那次假绿一模一样 —— 不是变红，是**变得更好读**：
 * 一条被误判成「环境抖动」的真回归，读起来比裸 annotation 更像可以重跑了事。
 * 所以这个脚本没有自测就等于没有。
 *
 * fixture 一律用**真跑出来的 TAP**，不是我按记忆写的样子：
 *   ① 断言失败块：`node --test --test-reporter=tap` 在一条 deepStrictEqual 失败上的原样输出。
 *   ② 误归属块：用例内起了一个延后 reject 的异步任务（就是 qq 上游路由那个形状），
 *      node 把它报成 `not ok N - <文件名>`（整文件级），真凶写在**前面**那行 `# Error:` 注释里。
 *      第 ② 条是本轮 CI 红四天的直接教训：现有 annotation 逻辑用
 *      `Select-String 'not ok \d+' -Context 0,26` 只取失败行之后的 26 行，
 *      于是唯一指出真凶的那一行被丢掉 —— 只有用例名的 annotation 等于把红推给「猜环境差异」。
 *   ③ 出网特征串：本轮真在 CI 里出现过的目标（c.y.qq.com / y.qq.com / ECONNREFUSED 族）。
 * 若 node 升级改了文案，这些用例会红，而红得对 —— 规则判据必须跟着真实输出走。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseTap, analyze, formatAnnotations, formatSummary, run } = require('../scripts/ci-doctor.cjs');

// ── fixture：真 TAP 文本 ────────────────────────────────

/** 普通断言失败：用例名级 not ok，带 expected/actual 与 stack */
const TAP_ASSERTION = [
  'TAP version 13',
  '# Subtest: 用例丙：断言失败',
  'not ok 1 - 用例丙：断言失败',
  '  ---',
  '  duration_ms: 4.3433',
  "  type: 'test'",
  "  location: 'F:\\\\新建文件夹\\\\Lanyue-1.0.35\\\\test\\\\localLibrary.test.js:3:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly deep-equal:',
  '    + actual - expected',
  '',
  '      {',
  "    +   title: '未知 - 01.mp3'",
  "    -   title: '无标签'",
  '      }',
  '',
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  '  stack: |-',
  '    TestContext.<anonymous> (F:\\新建文件夹\\Lanyue-1.0.35\\test\\localLibrary.test.js:4:10)',
  '    Test.runInAsyncScope (node:async_hooks:227:14)',
  '  ...',
  '1..1',
  '# tests 1',
  '# pass 0',
  '# fail 1',
  '',
].join('\n');

/** 误归属：两个用例都 ok，整文件 not ok，真凶写在 not ok **之前**的 # Error 注释里 */
const TAP_ASYNC_ESCAPE = [
  'TAP version 13',
  '# Subtest: 用例甲：正常通过',
  'ok 1 - 用例甲：正常通过',
  '  ---',
  '  duration_ms: 0.5444',
  "  type: 'test'",
  '  ...',
  '# Subtest: 用例乙：触发游离 rejection',
  'ok 2 - 用例乙：触发游离 rejection',
  '  ---',
  '  duration_ms: 0.1751',
  "  type: 'test'",
  '  ...',
  '# Error: Test "用例乙：触发游离 rejection" at test/localLibrary.test.js:3:1 generated asynchronous activity after the test ended. This activity created the error "Error: 上游路由自己炸了" and would have caused the test to fail, but instead triggered an unhandledRejection event.',
  '# Subtest: test/localLibrary.test.js',
  'not ok 1 - test/localLibrary.test.js',
  '  ---',
  '  duration_ms: 233.8972',
  "  type: 'test'",
  "  location: 'F:\\新建文件夹\\Lanyue-1.0.35\\test\\localLibrary.test.js:1:1'",
  "  failureType: 'testCodeFailure'",
  '  exitCode: 1',
  '  error: test failed',
  '  code: ERR_TEST_FAILURE',
  '  ...',
  '1..3',
  '# tests 3',
  '# pass 2',
  '# fail 1',
  '',
].join('\n');

/** 出网特征：失败详情里带着真实目标域名 —— 本仓测试必须离线，这不是抖动 */
const TAP_EGRESS = [
  'TAP version 13',
  '# Subtest: scan-local-library: 返回全部音频',
  'not ok 7 - scan-local-library: 返回全部音频',
  '  ---',
  "  location: 'F:\\新建文件夹\\Lanyue-1.0.35\\test\\libraryIpc.integration.test.js:120:1'",
  '  error: |-',
  '    出现对外连接: c.y.qq.com:80',
  '    Aggregated error: connect ECONNREFUSED 1.1.1.1:80',
  '  code: ERR_ASSERTION',
  '  stack: |-',
  '    TestContext.<anonymous> (F:\\新建文件夹\\Lanyue-1.0.35\\test\\libraryIpc.integration.test.js:131:5)',
  '  ...',
  '1..7',
  '# pass 6',
  '# fail 1',
  '',
].join('\n');

/** 只有基础设施层面的红：node 崩了但没报出任何用例 */
const TAP_INFRA = [
  'TAP version 13',
  '# Subtest: test/foo.test.js',
  'ok 1 - test/foo.test.js',
  '  ---',
  '  ...',
  '1..1',
  '# pass 1',
  '# fail 0',
  '',
].join('\n');

function attempt(index, exitCode, tap) {
  return { index, exitCode, tap };
}

/** 把同一份 TAP 当作 N 次 attempt（CI 的步骤会重试 3 次）*/
function attemptsSame(times, tap) {
  return Array.from({ length: times }, (_, i) => attempt(i + 1, 1, tap));
}

// ── parseTap ────────────────────────────────────────────

test('parseTap: 断言失败块抽出用例名、位置、expected/actual 与 stack 首帧', () => {
  const parsed = parseTap(TAP_ASSERTION);

  assert.strictEqual(parsed.failures.length, 1);
  const f = parsed.failures[0];
  assert.strictEqual(f.name, '用例丙：断言失败');
  assert.strictEqual(f.fileLevel, false, '用例级失败不该被认成整文件级');
  assert.match(f.location, /localLibrary\.test\.js:3:1$/);
  assert.match(f.error, /title: '未知 - 01\.mp3'/);
  assert.strictEqual(f.culprit, 'F:\\新建文件夹\\Lanyue-1.0.35\\test\\localLibrary.test.js:4:10',
    'stack 首帧才是真凶位置，location 只是用例声明处');
  assert.strictEqual(parsed.counts.fail, 1);
  assert.strictEqual(parsed.counts.pass, 0);
});

test('parseTap: 通过用例不产生 failure', () => {
  const parsed = parseTap(TAP_INFRA);
  assert.deepStrictEqual(parsed.failures, []);
  assert.strictEqual(parsed.counts.pass, 1);
});

test('parseTap: 整文件级 not ok（名字就是 .test.js）单独标记', () => {
  const parsed = parseTap(TAP_ASYNC_ESCAPE);

  assert.strictEqual(parsed.failures.length, 1);
  const f = parsed.failures[0];
  assert.strictEqual(f.fileLevel, true);
  assert.strictEqual(f.name, 'test/localLibrary.test.js');
});

test('parseTap: # Error 异步活动注释是「真凶行」，且它出现在 not ok 之前', () => {
  const parsed = parseTap(TAP_ASYNC_ESCAPE);

  assert.strictEqual(parsed.escapes.length, 1);
  const e = parsed.escapes[0];
  assert.strictEqual(e.ownerTest, '用例乙：触发游离 rejection');
  assert.strictEqual(e.culprit, 'test/localLibrary.test.js:3:1');
  assert.match(e.message, /上游路由自己炸了/);

  // 这条断言钉住本轮 CI 红四天的机制本身：annotation 若只取失败行之后的窗口就拿不到它
  assert.ok(TAP_ASYNC_ESCAPE.indexOf('# Error:') < TAP_ASYNC_ESCAPE.indexOf('not ok 1 - test/localLibrary'),
    '# Error 行必须在 not ok 之前 —— 只取后文的 annotation 必然丢掉真凶');
});

// ── analyze：规则优先级 ─────────────────────────────────

test('analyze: 整文件级失败 + 异步活动注释 → 判「误归属」，并给出真凶行', () => {
  const r = analyze(attemptsSame(3, TAP_ASYNC_ESCAPE));

  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(r.findings.length, 1);
  const [f] = r.findings;
  assert.strictEqual(f.category, 'ASYNC_ESCAPE');
  assert.strictEqual(f.culprit, 'test/localLibrary.test.js:3:1');
  assert.match(f.nextAction, /游离|异步/, '该说清下一步是去堵异步泄漏，不是改用例断言');
  assert.ok(!/改用例断言/.test(f.verdict), '不该把整文件失败说成这个用例自己断言错了');
});

test('analyze: 详情含出网特征 → 判「测试出网」，不是环境抖动', () => {
  const [f] = analyze(attemptsSame(3, TAP_EGRESS)).findings;

  assert.strictEqual(f.category, 'TEST_EGRESS');
  assert.match(f.culprit, /libraryIpc\.integration\.test\.js:131/);
  assert.match(f.nextAction, /离线|出网/);
});

test('analyze: 出网特征优先于「整文件级」的默认判定（同一段 TAP 两种特征都在时）', () => {
  const tap = TAP_ASYNC_ESCAPE.replace('1..3', '1..3\n# extra: connect ECONNREFUSED 1.1.1.1');
  const [f] = analyze(attemptsSame(3, tap)).findings;

  assert.strictEqual(f.category, 'TEST_EGRESS', '出网是能直接定罪的证据，比形态推断更具体');
});

test('analyze: 三次 attempt 同一指纹 → 判「确定性回归」，必须修', () => {
  const r = analyze(attemptsSame(3, TAP_ASSERTION));
  const [f] = r.findings;

  assert.strictEqual(f.category, 'DETERMINISTIC_REGRESSION');
  assert.deepStrictEqual(f.attempts, [1, 2, 3]);
  assert.match(f.nextAction, /不能靠重跑/);
});

test('analyze: 指纹在 attempt 间漂移 → 判「间歇」，并列出各次失败名', () => {
  const other = TAP_ASSERTION.replaceAll('用例丙：断言失败', '用例丁：另一条').replace('localLibrary.test.js:4:10', 'localLibrary.test.js:9:1');
  const r = analyze([
    attempt(1, 1, TAP_ASSERTION),
    attempt(2, 1, other),
    attempt(3, 1, TAP_ASSERTION),
  ]);

  const categories = r.findings.map((x) => x.category);
  assert.ok(categories.includes('FLAKY'), `应识别出间歇性，实得 ${categories.join(',')}`);
  const flaky = r.findings.find((x) => x.category === 'FLAKY');
  assert.match(flaky.evidence, /用例丁/, '间歇的证据就是「换了个名字」');
  assert.ok(flaky.culprit && flaky.culprit !== '?', '间歇也要给出可点开的地址，只说「每次红的不一样」等于没说');
});

test('analyze: exit≠0 却没有任何 not ok → 判「基础设施」，不去猜哪个用例', () => {
  const r = analyze(attemptsSame(3, TAP_INFRA));
  const [f] = r.findings;

  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(f.category, 'INFRA');
  assert.match(f.nextAction, /runner|npm|内存|磁盘/, '该指向跑不动的环境，而不是代码');
});

test('analyze: 全绿 → GREEN 且零 findings（不给绿跑制造噪音）', () => {
  const green = 'TAP version 13\nok 1 - 某用例\n1..1\n# pass 1\n# fail 0\n';
  const r = analyze([attempt(1, 0, green)]);

  assert.strictEqual(r.verdict, 'GREEN');
  assert.deepStrictEqual(r.findings, []);
});

test('analyze: 一次 attempt 里两条独立失败都要报出来', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - 用例丙：断言失败',
    '  ---',
    "  location: 'test/a.test.js:3:1'",
    '  error: |-',
    "    +   title: '未知 - 01.mp3'",
    '  stack: |-',
    '    TestContext.<anonymous> (test/a.test.js:4:10)',
    '  ...',
    'not ok 2 - 用例丁：另一条',
    '  ---',
    "  location: 'test/b.test.js:8:1'",
    '  error: |-',
    '    Expected: true',
    '  stack: |-',
    '    TestContext.<anonymous> (test/b.test.js:9:3)',
    '  ...',
    '1..2',
    '# pass 0',
    '# fail 2',
    '',
  ].join('\n');
  const r = analyze(attemptsSame(3, tap));

  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(new Set(r.findings.map((x) => x.name)).size, 2, '两条失败各自成一条归因，不能折成一条');
  assert.ok(r.findings.every((x) => x.category === 'DETERMINISTIC_REGRESSION'));
});

test('analyze: 中文全成乱码也照样定性 —— 判据只吃 ASCII，不赌 runner 的控制台码页', () => {
  // Windows runner 上 PowerShell 捕获原生命令 stdout 时按 [Console]::OutputEncoding 解码，
  // 码页不是 UTF-8 时中文进文件就成了乱码（2026-10-14 本地实测：FAIL-DETAIL 直接回显看着正常，
  // 落盘的 tap 文件里中文已经烂掉 —— 控制台又按同一码页编回去，把损坏表演成了完好）。
  // 归因必须在这种文件上仍然给出正确类别，否则「换个 runner 就哑」会重新变成人的活。
  const mojibake = (s) => Buffer.from(s, 'utf8').toString('latin1');

  assert.strictEqual(analyze(attemptsSame(3, mojibake(TAP_EGRESS))).findings[0].category, 'TEST_EGRESS');
  assert.strictEqual(analyze(attemptsSame(3, mojibake(TAP_ASYNC_ESCAPE))).findings[0].category, 'ASYNC_ESCAPE');
  assert.strictEqual(analyze(attemptsSame(3, mojibake(TAP_ASSERTION))).findings[0].category, 'DETERMINISTIC_REGRESSION');
});

// ── 形状钉：两条 workflow 的归因口径不许分叉 ─────────────

/** 抠出某个 workflow 里 `Unit tests` 步骤的 run 块正文（去缩进，逐行原样） */
function stepRunBody(file, stepName) {
  const lines = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', file), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*- name: ${stepName}\\s*$`).test(l));
  assert.notStrictEqual(start, -1, `${file} 里找不到 ${stepName} 步骤`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  assert.notStrictEqual(runAt, -1, `${file} 的 ${stepName} 步骤没有 run 块`);
  const indent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
    body.push(l.replace(/^ {4}/, ''));
  }
  return body.join('\n');
}

function unitTestsRunBody(file) {
  return stepRunBody(file, 'Unit tests');
}

test('ci.yml 与 release.yml 的 Unit tests 命令体逐行相同 —— probe 调试行曾在两处差活四天', () => {
  // 分叉是怎么发生的：详版归因先只加在 ci.yml（release.yml 要 tag 才跑，当时无从验证），
  // 于是同一条 `::error::probe` 调试行在 ci.yml 被删掉后，还在 release.yml 里每次绿跑
  // 都发一条假 error。读一份 yaml 再比对成本极低，分叉成本是一次「发版时才发现两处不一样」。
  const ci = unitTestsRunBody('ci.yml');
  const rel = unitTestsRunBody('release.yml');
  assert.strictEqual(rel, ci, '两份 Unit tests 命令体必须逐行一致');

  // 钉住关键特征本身（防止有人把两处一起改坏成另一份共同形状）
  assert.match(ci, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.match(ci, /-Context 3,26/);
  assert.match(ci, /Context\.PreContext/);
  assert.match(ci, /node scripts\/ci-doctor\.cjs --tap-dir \. --summary/);
  assert.ok(!/probe attempt=/.test(ci), '调试探针行不该留在任何一侧 —— 它每次绿跑都发一条 ::error::');
  assert.ok(!ci.split('').some((c) => { const n = c.codePointAt(0); return n < 32 && n !== 10 && n !== 13 || n > 126; }),
    'run 块必须纯 ASCII：它会被原样写进 PowerShell 脚本文件，编码由 runner 决定');
});


// ── 输出：annotation 必须能被 runner 解析 ────────────────

test('formatAnnotations: 每条 finding 一行，% 与 # 与换行都转义（workflow command 的硬要求）', () => {
  const r = analyze(attemptsSame(3, TAP_EGRESS));
  // 刻意用 'a%b'：转义正确时它是 'a%25b'，转义漏掉时原样出现 —— 两者可分辨。
  // （早先用 '100%' 做样本是自欺：'100%25' 里照样含 '100%'，断言恒真。）
  r.findings[0].evidence = 'a%b #c\n第二行\r\n';
  const [line] = formatAnnotations(r);

  assert.ok(line.startsWith('::error::CI-DOCTOR '), `annotation 前缀缺失: ${line}`);
  assert.ok(line.includes('category=TEST_EGRESS'));
  assert.ok(!line.includes('\n') && !line.includes('\r'), '一条 annotation 必须是单行');
  assert.ok(line.includes('a%25b'), '% 必须转义');
  assert.ok(line.includes('%23c'), '# 必须转义');
  assert.strictEqual(line.includes('a%b'), false);
});

test('formatAnnotations: 条数封顶，超出汇总成一条（runner 只显示少量 annotation，多了等于没有）', () => {
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push(`not ok ${i + 1} - 用例${i}\n  ---\n  error: 'x'\n  stack: |-\n    at (a.test.js:${i + 1}:1)\n  ...\n`);
  }
  const tap = `TAP version 13\n${many.join('\n')}\n1..12\n# fail 12\n`;
  const r = analyze(attemptsSame(3, tap));
  assert.ok(r.findings.length >= 10, 'fixture 本身要够多失败');

  const lines = formatAnnotations(r);
  assert.ok(lines.length <= 6, `annotation 应封顶在 6 条内，实得 ${lines.length}`);
  assert.match(lines.join('\n'), /另有 \d+ 条/, '被截掉的数量要说出来，不能装作只有这些');
});

test('formatAnnotations: 单条长度受控（runner 会截断，宁可少说也别切掉 next action）', () => {
  const r = analyze(attemptsSame(3, TAP_EGRESS));
  r.findings[0].evidence = 'x'.repeat(5000);

  for (const line of formatAnnotations(r)) {
    assert.ok(line.length <= 1200, `annotation 过长(${line.length})：${line.slice(0, 80)}`);
  }
});

test('formatSummary: markdown 表按类别给计数，供人读 step summary', () => {
  const r = analyze(attemptsSame(3, TAP_ASSERTION));
  const md = formatSummary(r);

  assert.match(md, /CI 归因/);
  assert.match(md, /DETERMINISTIC_REGRESSION/);
  assert.match(md, /用例丙/);
});

// ── CLI：归因工具自己失败时不能把绿跑弄红 ────────────────

test('run: 读到 attempt-*.tap.txt 就出归因，退出码恒为 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-'));
  fs.writeFileSync(path.join(dir, 'attempt-1.tap.txt'), TAP_ASSERTION, 'utf8');
  fs.writeFileSync(path.join(dir, 'attempt-2.tap.txt'), TAP_ASSERTION, 'utf8');
  fs.writeFileSync(path.join(dir, 'attempt-3.tap.txt'), TAP_ASSERTION, 'utf8');

  const out = run({ dir });

  assert.strictEqual(out.exitCode, 0, '归因不越权改闸门结论，红由原步骤判');
  assert.match(out.stdout.join('\n'), /CI-DOCTOR category=DETERMINISTIC_REGRESSION/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run: 目录里没有 tap 文件也照常绿退出，只发一条 warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-empty-'));
  const out = run({ dir });

  assert.strictEqual(out.exitCode, 0);
  assert.match(out.stdout.join('\n'), /::warning::/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run: PowerShell 写的 UTF-8 带 BOM 也能解析（Windows runner 的默认编码）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-bom-'));
  fs.writeFileSync(path.join(dir, 'attempt-1.tap.txt'), '﻿' + TAP_ASSERTION, 'utf8');

  const out = run({ dir });
  assert.strictEqual(out.exitCode, 0);
  assert.match(out.stdout.join('\n'), /CI-DOCTOR category=/, 'BOM 没剥掉会让首行 TAP version 认不出来');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run: 不读目录、显式给 --tap-file 时也能跑（本地复现用同一条路）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-file-'));
  const file = path.join(dir, 'local.tap.txt');
  fs.writeFileSync(file, TAP_ASYNC_ESCAPE, 'utf8');

  const out = run({ tapFile: file });
  assert.match(out.stdout.join('\n'), /category=ASYNC_ESCAPE/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run: 全程不产生任何对外连接（轨道四的承诺：CI 不出网、不花钱）', async () => {
  const net = require('node:net');
  const tried = [];
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function spyConnect(...args) {
    tried.push(JSON.stringify(args.flat(1)));
    return originalConnect.apply(this, args);
  };

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-egress-'));
    fs.writeFileSync(path.join(dir, 'attempt-1.tap.txt'), TAP_ASSERTION, 'utf8');
    run({ dir });
    assert.deepStrictEqual(tried, [], `归因脚本不该有任何连接: ${tried.join(', ')}`);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    net.Socket.prototype.connect = originalConnect;
  }
});

test('ci-doctor.cjs 落在 lint 覆盖里 —— 它只在 CI 红的那次才执行，坏掉不能等到那时才发现', () => {
  // scripts/ 整目录不过 lint（历史见 test/scripts-hygiene.test.js 的头注释），
  // 而 CI 里其他 scripts/*.cjs 都被某条步骤**执行**过，语法错误当场就炸。
  // 只有归因引擎是例外：绿跑在 `passed on attempt 1` 就 exit 0，压根跑不到它。
  // 于是「归因引擎自己坏了」这件事，只会在真正需要它的那次红里出现 ——
  // 而那次已经缺归因了。把它单独纳进 lint，就是把这个死角提前到日常提交。
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.lint.includes('scripts/ci-doctor.cjs'),
    `lint 命令没覆盖归因引擎：${pkg.scripts.lint}`);
});

/**
 * 「落盘不烂中文」从本地实测升级为 runner 上每次绿跑都跑的断言（2026-10-14）。
 *
 * 背景：workflow 的 Unit tests 步骤把 node 的 stdout **捕获进变量**再 `Out-File` 落盘，
 * 而 PowerShell 解码原生命令输出用的是 [Console]::OutputEncoding —— Windows runner 的默认码页
 * 不是 UTF-8。不强令码页时中文用例名会静默烂在 attempt-N.tap.txt 里，而 FAIL-DETAIL 走内存回显
 * 又按同一码页编回去，看起来一切正常（2026-10-14 本地实测到这一层才看清，写进了 ci.yml 的注释）。
 * 那条注释与「归因判据只吃 ASCII」的用例都在，**唯独没人证明那两行真能保住中文** ——
 * 此前只有一次性手工模拟。
 *
 * 做法不是复制那两行，而是**从 YAML 里把它们抠出来执行**，只把生产者换成一个吐已知中文用例名的探针。
 * 牙在哪、不在哪（2026-10-14 实测清楚，别把这条用例读成它能探测一切）：
 *   ① 有人删掉/改掉那两行 → 抠取断言直接红（「抠不出就无法自证」）—— 这是**环境无关**的那半边牙；
 *   ② 在默认码页不是 UTF-8 的机器上（CI runner 属此类），绕过码页那行会让落盘中文真烂掉 → 第二个断言红。
 *      但本机实测这台开发机的控制台码页已经是 UTF-8，把那行去掉照样不烂 —— 所以②是**条件成立**的，
 *      这条用例的价值主要在 runner 上：那里每次绿跑都会把「落盘 + 归因读回」这条链真走一遍。
 * 于是复制不会过期，删改会立刻响；而「保住中文」这句话从一次性的本地模拟，变成 runner 上的常态断言。
 * 非 Windows 机器跳过：CI 就是 windows-latest，本仓测试口径与之对齐。
 */
test('真跑一遍 workflow 的落盘两行：中文用例名进 attempt 文件必须原样活着', {
  // 用 option 形态而不是 t.skip()：后者在部分 node 版本的 TestContext 上没有，
  // 非 Windows 的开发机该「被跳过」而不是抛 TypeError
  skip: process.platform !== 'win32' ? '需要 Windows PowerShell（CI runner 就是 windows-latest）' : false,
}, () => {
  const body = unitTestsRunBody('ci.yml');
  const codepageLine = (body.match(/^.*\[Console\]::OutputEncoding.*$/m) || [])[0];
  const outFileLine = (body.match(/^.*Out-File -FilePath "attempt-\$i\.tap\.txt".*$/m) || [])[0];
  assert.ok(codepageLine, 'ci.yml 的 Unit tests 步骤里没有强令码页的那一行 —— 抠不出就无法自证');
  assert.ok(outFileLine, 'ci.yml 的 Unit tests 步骤里没有落盘 attempt 文件的那一行 —— 同上');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-encoding-roundtrip-'));
  try {
    // 探针只负责把真 TAP 吐到 stdout；编码链路（PowerShell 解码 → Out-File）由下面抠出来的两行负责
    fs.writeFileSync(path.join(dir, 'probe.js'),
      `process.stdout.write(${JSON.stringify(TAP_ASSERTION)});`, 'utf8');
    const script = ['$i = 1', codepageLine, '$out = node probe.js 2>&1', outFileLine].join('\n');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { cwd: dir, encoding: 'utf8' });

    const landed = fs.readFileSync(path.join(dir, 'attempt-1.tap.txt'), 'utf8').replace(/^\uFEFF/, '');
    assert.ok(landed.includes('用例丙：断言失败'),
      `中文用例名没能活着落盘（拿到的是: ${JSON.stringify(landed.slice(0, 60))}）`);
    assert.ok(!landed.includes('\uFFFD'), '落盘文件里有替换符 —— 解码链路已经坏了');

    // 光名字活着还不够，归因引擎读这份落盘产物必须照样定对性、叫对名
    const out = run({ dir });
    assert.strictEqual(out.result.verdict, 'FAIL');
    assert.strictEqual(out.result.findings[0].name, '用例丙：断言失败');
    assert.strictEqual(out.result.findings[0].category, 'DETERMINISTIC_REGRESSION');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
