/**
 * doctorSelfCheck.test.js —— 归因引擎的 FAIL 分支每次绿跑都在 runner 上走一遍
 *
 * 补的是轨道四最后那句留白：`node scripts/ci-doctor.cjs --tap-dir . --summary`
 * 这一行原先只在「单测连红三次」之后才执行，于是它自己坏没坏，只有真红那次才知道 ——
 * 而那一次恰好最需要它。合成一份「三轮同指纹的中文用例名红 TAP」，让每个绿跑都拿它
 * 真跑一遍脚本，就把这个死角提前到日常提交（和 test/ciDoctor.test.js 把归因引擎单独
 * 拉进 lint 覆盖是同一条理由）。
 *
 * 三条用例各管一段，别混着读：
 *   ① fixture 语义（跨平台）：这份合成 TAP 喂给 run() 必须定成确定性回归、中文名字不许烂。
 *      管的是「fixture 别过期」—— node 改了 TAP 文案时，先在这里响，而不是在 runner 上响。
 *   ② 步骤形状（跨平台）：那一步必须**捕获**归因输出、且把 GITHUB_STEP_SUMMARY 支到临时文件。
 *      管的是安全不变量：归因引擎红路吐的是 `::error::` 行，直接回显就等于在绿跑上伪造
 *      真红 annotation 与真红 job summary —— 那比没有自检更糟。
 *   ③ 抠出步骤体真跑（仅 Windows，与 runner 同族 shell）：整步自证 OK、stdout 里一个
 *      `::error::` 都不许有。
 * ③ 与 ② 有重叠是有意的：② 是不依赖 shell 的下限，③ 在非 Windows 开发机跳过时仍有 ①② 兜着。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { run } = require('../scripts/ci-doctor.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'ci-doctor-red.tap');
const STEP_NAME = 'CI doctor self-check';

/** 从 workflow 的某个步骤里抠出 `run: |` 命令体（去 4 空格缩进），抠不到即红 */
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

test('合成红 TAP fixture：三轮同指纹喂给 run() 必须定成确定性回归，中文用例名不许烂', () => {
  const tap = fs.readFileSync(FIXTURE, 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-selfcheck-fixture-'));
  try {
    // 复现 CI 的落盘形态：attempt-1..3.tap.txt + 各自非 0 退出码
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(dir, `attempt-${i}.tap.txt`), tap, 'utf8');
      fs.writeFileSync(path.join(dir, `attempt-${i}.exit`), '1\n', 'utf8');
    }
    const out = run({ dir });
    assert.strictEqual(out.exitCode, 0, '归因引擎的退出码必须恒为 0 —— 红由原步骤判，它只解释红');
    assert.strictEqual(out.result.verdict, 'FAIL');
    assert.strictEqual(out.result.findings[0].category, 'DETERMINISTIC_REGRESSION',
      `三轮同指纹应定成确定性回归，实际是 ${out.result.findings[0].category} —— fixture 与 node 的真实输出脱节了`);
    assert.strictEqual(out.result.findings[0].name, '用例丙：断言失败');
    assert.ok(!out.stdout.join('\n').includes('\uFFFD'), 'annotation 里有替换符 —— 编码链路坏了');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自检步骤只捕获不回显：归因输出的 ::error:: 不许进 runner 的 stdout，job summary 不许被写脏', () => {
  const body = stepRunBody('ci.yml', STEP_NAME);
  assert.match(body, /\$out = node scripts\/ci-doctor\.cjs --tap-dir /,
    '归因引擎的输出必须赋给变量（捕获），不能裸跑 —— 裸跑就是让 runner 把假红的 annotation 当真');
  assert.match(body, /\$env:GITHUB_STEP_SUMMARY\s*=/,
    '步骤必须把 GITHUB_STEP_SUMMARY 支到临时文件 —— 否则合成红会写进真实 job summary，绿跑看起来像红过');
  assert.match(body, /-replace '::error::'/, '回显排查原文前必须把 ::error:: 换成中性串（防止自检失败那次再伪造一层红）');
  assert.ok(!/Write-Output "::error/.test(body), '步骤里不该有任何直接把 ::error:: 写给 stdout 的行');
  // 「中文用例名活着」的两条断言必须钉在**用例名那一位**上，不是全串级别的「还有非 ASCII 吗」——
  // 归因的建议文案本身就是中文，全串探测被纯 ASCII 用例名的 fixture 试穿了（见下面那条牙齿用例）
  assert.match(body, /name=\[\^\\u0000-\\u007f\]/, 'annotation 侧没有「name= 后面还得有非 ASCII」这条断言');
  assert.match(body, /DETERMINISTIC_REGRESSION \\\| \[\^\\u0000-\\u007f\]/, 'summary 侧没有同款断言');
  // 这条 run 块会被原样写进 PowerShell 脚本文件，编码由 runner 决定 —— 与 Unit tests 同步纯 ASCII 口径，
  // 要断言的中文一律用 [char]0xXXXX 拼，不许把中文字面量写进 YAML
  assert.ok(!body.split('').some((c) => { const n = c.codePointAt(0); return (n < 32 && n !== 10 && n !== 13) || n > 126; }),
    '自检步骤的 run 块必须纯 ASCII');
});

test('抠出自检步骤体真跑一遍（Windows）：整步自证 OK 且 stdout 里一个 ::error:: 都没有', {
  skip: process.platform !== 'win32' ? '需要 Windows PowerShell（CI runner 就是 windows-latest）' : false,
}, () => {
  const body = stepRunBody('ci.yml', STEP_NAME);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-selfcheck-run-'));
  let stdout = '';
  try {
    stdout = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', body],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8',
        env: Object.assign({}, process.env, { RUNNER_TEMP: work, GITHUB_RUN_ID: 'local-test' }) });
  } catch (err) {
    assert.fail(`自检步骤在本地跑挂了（exit=${err.status}）：\n${String(err.stdout || '')}\n${String(err.stderr || '')}`);
  }
  assert.ok(stdout.includes('CI-DOCTOR-SELFCHECK-OK'), `没看到自证 OK 那行，实际输出：${JSON.stringify(stdout.slice(0, 300))}`);
  assert.ok(!stdout.includes('::error::'), '步骤 stdout 里出现了 ::error:: —— 绿跑会因此挂上假红 annotation');
  // 真实 job summary 没被碰：步骤把 GITHUB_STEP_SUMMARY 改指到 work 下面，所以父 env 里那个变量
  // （本地通常不存在）不该被写过；再确认临时 summary 文件确实落了地、且中文活着
  const summaries = fs.readdirSync(work, { recursive: true }).map(String)
    .filter((n) => /step-summary\.md$/.test(n));
  assert.strictEqual(summaries.length, 1, `临时 summary 文件应有 1 份，实际 ${summaries.join(', ') || '无'}`);
  const sum = fs.readFileSync(path.join(work, summaries[0]), 'utf8').replace(/^\uFEFF/, '');
  assert.ok(sum.includes('用例丙：断言失败'), `job summary 形态的归因表里中文用例名烂掉了：${JSON.stringify(sum.slice(0, 120))}`);
  assert.ok(!sum.includes('\uFFFD'), '临时 summary 里有替换符');
});

/**
 * 牙齿用例：把这一步抠出来跑**坏**的现场，它必须响。
 * 为什么单独一条：上一条正例只证明「步骤在好现场下绿」，而这条自检的全部意义是
 * 「归因引擎坏掉时拦住」。不验证它就会得到一个永远为真的步骤 —— CI 里加一步不难，
 * 加一步什么都不检测才可怕。两次坏现场各打一枪：
 *   ① 合成 TAP 其实是全绿的 → 归因给不出确定性回归 → 必须报 no annotation；
 *   ② 用例名换成纯 ASCII（模拟中文在编码链路上丢掉）→ 必须报 test name lost。
 * ② 是 2026-10-14 真试穿出来的：当时那条断言写成「全串里还有非 ASCII 吗」，而
 * 归因的处置建议本身就是中文，纯 ASCII 用例名照样放行 —— 于是断言收窄到 name= 那一位。
 */
test('自检步骤的两条牙齿：绿 fixture 与纯 ASCII 用例名都必须让它响（Windows）', {
  skip: process.platform !== 'win32' ? '需要 Windows PowerShell（CI runner 就是 windows-latest）' : false,
}, () => {
  const body = stepRunBody('ci.yml', STEP_NAME);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-selfcheck-teeth-'));
  const runBody = (fixturePath) => {
    const script = body.replace('test/fixtures/ci-doctor-red.tap', fixturePath);
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8',
          env: Object.assign({}, process.env, { RUNNER_TEMP: work, GITHUB_RUN_ID: 'teeth-' + path.basename(work) }) });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
    }
  };

  try {
    // ① 全绿 fixture：归因不该有确定性回归
    const green = path.join(work, 'green.tap');
    fs.writeFileSync(green, 'TAP version 13\nok 1 - x\n1..1\n# pass 1\n# fail 0\n', 'utf8');
    const r1 = runBody(green);
    assert.strictEqual(r1.code, 1, `绿 fixture 下自检本该失败，实际 exit=${r1.code}\n${r1.out}`);
    assert.match(r1.out, /no annotation/);
    assert.ok(!r1.out.includes('::error::'), '回显排查原文时 ::error:: 前缀没被中和 —— 假红 annotation 又回来了');

    // ② 纯 ASCII 用例名：中文这一位丢了就该响
    const ascii = path.join(work, 'ascii.tap');
    fs.writeFileSync(ascii, fs.readFileSync(FIXTURE, 'utf8')
      .replace(/用例丙：断言失败/g, 'plain-ascii-name'), 'utf8');
    const r2 = runBody(ascii);
    assert.strictEqual(r2.code, 1, `纯 ASCII 用例名本该失败，实际 exit=${r2.code}\n${r2.out}`);
    assert.match(r2.out, /test name lost/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
