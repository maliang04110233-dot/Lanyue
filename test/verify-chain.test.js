/**
 * 守卫：`npm run verify` 必须离线可复现
 *
 * ── 背景 ──────────────────────────────────────────────────────
 *
 * verify 曾把 `audit:deps` 串在第二步（lint 之后、test 之前）。当时的理由
 * 大概是「顺手把漏洞扫描也做了」，但这个位置让它变成了**主战场的一道闸**：
 *
 *   npm audit 的退出码 1 有两个来源 ——
 *     ① 真有 high 级漏洞；
 *     ② registry 不支持 audit 端点，或网络失败。
 *
 * 两者共用退出码，调用方无法区分。而国内常用的 npmmirror 对
 * `/-/npm/v1/security/advisories/bulk` 返回 404 NOT_IMPLEMENTED，
 * 实测 `npm audit --omit=dev --audit-level=high` 在本机直接 exit 1：
 *
 *   npm error audit endpoint returned an error
 *   { error: '[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet' }
 *
 * 后果是任何用镜像的开发者执行 `npm run verify` 都会在第二步硬失败，
 * test / check:dead-deps / build / smoke:asar 永远跑不到 —— 一个为了
 * 「多查点东西」而加的步骤，把真正要跑的东西全挡住了。
 *
 * 修法不是「换个 registry 就行」：CI 上 npmjs 限流、临时 5xx 同样会触发。
 * 所以分工改成：verify 只跑**离线可复现**的检查，漏洞扫描作为 CI 里的独立
 * 步骤，并在那里按 stderr 特征把「查不到」降级为 warning、把「真有漏洞」
 * 保持红灯（见 .github/workflows/ci.yml）。
 *
 * 本测试钉住这个分工，防止 audit 又被串回 verify。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const scripts = JSON.parse(read('package.json')).scripts;

test('verify 不含 audit:deps（registry 不实现 audit 端点时会硬失败）', () => {
  assert.ok(scripts.verify, 'package.json 缺 verify 脚本');
  assert.doesNotMatch(
    scripts.verify, /audit/,
    'verify 里又出现 audit 了。npm audit 的退出码 1 同时表示「有漏洞」和'
      + '「registry 没有 audit 端点」，串进 verify 会让后者把开发者挡在 test/build 之前。',
  );
});

test('verify 覆盖了真正需要本地跑通的全套检查', () => {
  // 移出 audit 不该顺手把别的东西也弄丢了。这里逐条钉住。
  for (const step of ['lint', 'test', 'check:dead-deps', 'check:icons', 'build', 'smoke:asar']) {
    assert.match(
      scripts.verify, new RegExp(`\\b${step}\\b`),
      `verify 少了 ${step} —— 移出 audit 时不该顺带砍掉它`,
    );
  }
});

test('audit:deps 脚本仍保留（漏洞扫描不能消失，只是换了位置）', () => {
  assert.match(
    scripts['audit:deps'], /npm audit .*--omit=dev.*--audit-level=high/,
    'audit:deps 脚本被删或改了参数 —— 漏洞扫描不能因为「难跑」就不做了',
  );
});

test('CI 里 audit 步骤能区分「有漏洞」与「查不到」', () => {
  const ci = read(path.join('.github', 'workflows', 'ci.yml'));
  assert.match(ci, /npm audit --omit=dev --audit-level=high/, 'CI 里的 audit 步骤不见了');

  // 关键：必须有把基础设施失败降级为 warning 的分支，且分支条件要能匹配
  // 镜像 404 与网络失败这两类真实报错。
  assert.match(ci, /::warning::/, 'CI 的 audit 步骤没有降级为 warning 的分支');
  assert.match(
    ci, /NOT_IMPLEMENTED|audit endpoint returned an error/,
    '降级条件里没有覆盖 npmmirror 的 404 NOT_IMPLEMENTED —— 那个仓库最常见的失败形态',
  );
  assert.match(
    ci, /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND/,
    '降级条件里没有覆盖网络类失败（registry 限流/临时故障）',
  );
  // 且降级必须放行、真漏洞必须红灯 —— 后者由 exit "$status" 保证，这里钉住它还在。
  assert.match(ci, /exit "\$status"/, 'audit 步骤不再按原退出码返回，真漏洞可能被一并放过');
});

test('verify 里没有其它需要触网的步骤（它必须离线可复现）', () => {
  // git / curl / 任何 registry 往返都会让 verify 变成「看网络脸色」。
  // 这一条是本文件存在的意义：verify 的价值在于任何机器上都能跑出同一个结果。
  for (const cmd of ['curl', 'wget', 'git fetch', 'git ls-remote', 'npm view', 'npm outdated']) {
    assert.doesNotMatch(
      scripts.verify, new RegExp(`\\b${cmd}\\b`),
      `verify 里出现了需要触网的 ${cmd} —— verify 必须离线可复现`,
    );
  }
});
