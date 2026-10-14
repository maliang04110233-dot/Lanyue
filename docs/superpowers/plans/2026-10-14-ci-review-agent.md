# CI 复审 agent（轨道四后一半）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan的执行。步骤用 `- [ ]` 复选框跟踪。
>
> **但先读这一条**：本计划的执行**必须先拿到用户授权**。它唯一的形态是「CI 里出网、按用量计费的 LLM 调用」，
> 而 `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md` 第 4 行写明用户为本轨道选定的是
> 「纯确定性归因，CI 不出网、不花钱」—— 那一条已经被 `scripts/ci-doctor.cjs` 兑现了。
> 本文档存在的意义是**把「要不要花这笔钱」变成一个可拍板的东西**，而不是先花了再说。
>
> **拍板结果（2026-10-14，用户）：暂不落地。** 本文档留档是为了将来要花钱时不必重新论证闸门该长在哪。
> 看到这一行就不要开工：不写 `scripts/ci-review.cjs`、不改 `ci.yml`、不建 secret。
> 若要重启，先让用户在下面四件事上重新点头。

**Goal:** 人在 PR 上贴 `ai-review` 标签时，CI 调一次 MiniMax 文本模型读这次改动的 diff（以及归因引擎的结论，如果有），
把「这个改动可能漏了什么」以一条 PR 评论的形式贴回来。

**Architecture:** 三段，各自可独立验证：
① `scripts/ci-review.cjs` —— 纯 node 脚本，输入是**文件**（diff 文本 + doctor 的 finding JSON），输出是评论正文；
`fetch`、`env`、`now` 全部可注入，所以在 `node --test` 下能拿假端点跑完，不需要网络也不需要 Key。
② `ci.yml` 里一个新的 `ai-review` job —— **双闸门**：`github.event_name == 'pull_request'` 且 PR 带 `ai-review` 标签，
且 `secrets.MINIMAX_API_KEY` 非空（由脚本自己判并跳过，YAML 里判 secret 空串是不可靠的）。
③ 贴评论用 `${{ secrets.GITHUB_TOKEN }}` 直接打 GitHub REST，不引入 `actions/github-script`（它要 pnpm，
Windows runner 上的 `ERR_PNPM_IGNORED_BUILDS` 是本仓已知的坑）。

**Tech Stack:** Node 22（CI 现有版本，`fetch` 是全局）、`.github/workflows/ci.yml`、`node --test` + `node:assert`（本仓既有）、
MiniMax `POST /v1/text/chatcompletion_v2` + `MiniMax-Text-01`（`src/api/ai-music.js:18,24` 的既有常量）。

**Spec:** `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`（轨道四那一行 + 「归因 vs 复审」那段口径说明）

---

## 拍板清单（执行前必须由用户确认的四件事）

1. **花钱**：一次复审 = 一次 `MiniMax-Text-01` 非流式调用。input 规模由 diff 截断上限决定
   （本计划定 40000 字符，见 Task 1），output 上限 `max_tokens: 900`。
   单价请用户自己核对 —— 本计划不写价格，因为写了就是猜的。
2. **Key 放哪**：仓库 secret `MINIMAX_API_KEY`（Settings → Secrets and variables → Actions）。
   它是**用户本人按量计费的那把**，所以「谁能在 CI 里用它」=「谁能贴标签」= 有 write 权限的人。
   fork PR 拿不到 secret，本计划在 job 条件里显式排除 fork。
3. **触发方式**：只由 `ai-review` 标签触发（不自动对每个 PR 跑）。这条是本设计的核心 ——
   它把「要不要花这笔钱」的决定权留在人贴标签那一下，而不是写死在 YAML 里由 agent 代决。
4. **评论落地形态**：贴成 PR 评论（issue comments），不是 review comment —— 后者要 `pull-requests: write`
   之外再构造 commit 行号，而 diff 的行号在 truncated 之后会失真，贴错行比不贴更糟。

若用户对 1~3 有任何一条说不，本计划就此停止，轨道四保持现状（归因半侧已落地并 runner 验绿）。

## Global Constraints

- **零新增依赖**：`package.json` 的 dependencies 不因本计划变长（`scripts/ci-review.cjs` 只用 `node:fs`/`node:path` + 全局 `fetch`）。
- **计费调用禁自动重试**：与 `src/api/ai-music.js` 同口径 —— 一次超时换两跳就是双倍扣费。脚本里不许出现 retry 循环。
- **fail-open**：复审自身的任何失败（无 Key、无标签、出网失败、模型回坏东西、贴评论 401）都只发
  `::warning::` 并以退出码 0 结束。CI 的红灯含义必须唯一属于代码，不能属于这个新 job。
  这与 `scripts/ci-doctor.cjs` 的「退出码恒为 0」是同一条纪律的两个实例。
- **Key 不落日志**：任何 stdout/annotation/评论正文里都不许出现 `MINIMAX_API_KEY` 的值；
  Authorization 头只在请求对象内部拼，不进 prompt、不进日志。
- **模型输出是不可信文本**：贴进 PR 前统一包一层「内容由模型生成，未经人工审阅」的告示；
  脚本不给模型任何工具面（与本仓助手的严格 JSON 协议不同的地方正在此处 —— 复审**不需要**执行能力，
  只要一段话，所以没有确认闸门也没有白名单，这是刻意收窄而非遗漏）。
- **workflow 两处口径**：本计划只碰 `ci.yml`。`release.yml` **不加**复审 job —— 发版走 tag，
  没有 PR 载体（拿不到 `issue_number`），也没有贴标签的人；不要为了「对称」把它塞进去。
- **不 tag、不发版**（本程序全程约束）。
- 提交只按文件名 `git add`，绝不用 `-A`（`F:\新建文件夹` 下挂着十几个仓库）。

---

### Task 1: `scripts/ci-review.cjs` —— 复审引擎（纯函数 + 可注入 IO）

**Files:**
- Create: `scripts/ci-review.cjs`
- Test: `test/ciReview.test.js`

**Interfaces:**
- Consumes: `scripts/ci-doctor.cjs` 的导出 `analyze(attempts)` 的返回形状
  `{verdict, attempts, findings:[{category,name,file,culprit,attempts,evidence,nextAction}]}`（该文件末行 `module.exports` 已导出，无需改动）。
- Produces: `{ buildPrompt, callModel, renderComment, gate, run, DIFF_CAP, MODEL, API_BASE, LABEL }`
  —— Task 2 的 workflow 只依赖 `run()` 的 CLI 面（`--diff-file` / `--findings-file` / `--out-file` 与 env 三件套），
  Task 3 的守卫测试依赖 `LABEL` 与 `DIFF_CAP` 这两个常量。

- [ ] **Step 1: 写失败的测试 —— 未贴标签时零出网**

创建 `test/ciReview.test.js`：

```js
/**
 * CI 复审 agent 的守卫（轨道四后一半）
 *
 * 这条链的唯一危险是「花钱」和「把红搞混」，所以钉子的重心不在模型说得好不好，
 * 而在四件事：没授权就不出网、出网只出一次（禁重试）、Key 不进日志、
 * 复审自身挂了不能把 CI 变红。行为全部用假 fetch 跑，测试进程不触网。
 */
const test = require('node:test');
const assert = require('node:assert');
const review = require('../scripts/ci-review.cjs');

const KEY = 'mk-secret-DO-NOT-LEAK';

/** 记录每次被调用的 URL 与 headers/body，断言「出过几次网」就靠它 */
function fakeFetch(handler) {
  const calls = [];
  return { calls, fn: async (url, init) => { calls.push({ url, init }); return handler(url, init); } };
}

test('gate: 没有 ai-review 标签 / 没有 Key / fork PR —— 一律 skipped 且零出网', async () => {
  const f = fakeFetch(() => { throw new Error('不该出网'); });
  for (const env of [
    { LABELS: 'bug', MINIMAX_API_KEY: KEY },
    { LABELS: 'ai-review', MINIMAX_API_KEY: '' },
    { LABELS: 'ai-review', MINIMAX_API_KEY: KEY, FORK: '1' },
  ]) {
    const out = await review.run({ env: { GITHUB_TOKEN: 't', PR_NUMBER: '7', ...env }, fetchImpl: f.fn,
      diff: 'a', findings: null });
    assert.strictEqual(out.skipped, true, `env=${JSON.stringify(env)} 应跳过`);
    assert.strictEqual(out.exitCode, 0, '跳过必须是绿');
  }
  assert.strictEqual(f.calls.length, 0, 'gate 拒绝后不应有任何网络调用');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ciReview.test.js`
Expected: FAIL —— `Cannot find module '../scripts/ci-review.cjs'`

- [ ] **Step 3: 写引擎最小实现（只够过 Step 1）**

创建 `scripts/ci-review.cjs`：

```js
#!/usr/bin/env node
/**
 * CI 复审 agent —— 读这次改动的 diff，给出「可能漏了什么」的一段话。
 *
 * 与 scripts/ci-doctor.cjs 的分工是刻意的两半，别混：
 *   doctor：只在单测红满三次时跑，纯确定性规则，**不出网、不花钱**，退出码恒 0；
 *   review：只在人往 PR 上贴 `ai-review` 标签时跑，一次计费调用，同样退出码恒 0。
 * 「红」这个字在本仓只能有一种含义 —— 代码问题。复审自己挂了、没 Key、被限流，
 * 全都降级成 warning 放绿（见 run() 的每个 catch），否则归因引擎刚清掉的歧义又被带回来。
 *
 * Key 的处理：只进 Authorization 头，不进 prompt、不进 stdout、不进评论正文。
 * 计费调用禁自动重试 —— 一次超时换两跳就是双倍扣费（同 src/api/ai-music.js 的 retries: 0 口径）。
 */
const fs = require('node:fs');

const API_BASE = 'https://api.minimaxi.com';   // 与 src/api/ai-music.js:18 同一处
const MODEL = 'MiniMax-Text-01';               // 与同文件 :24 同一处
const LABEL = 'ai-review';
const DIFF_CAP = 40000;                        // 字符。截断而非拒绝：大 PR 恰恰是最想复审的
const MAX_TOKENS = 900;

function gate(env) {
  const labels = String(env.LABELS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!labels.includes(LABEL)) return { ok: false, why: `PR 未贴 ${LABEL} 标签` };
  if (!env.MINIMAX_API_KEY) return { ok: false, why: '仓库 secret MINIMAX_API_KEY 未配置' };
  // fork PR 的 GITHUB_TOKEN 无 secret 读取权，且贴标签的人未必是本人 —— 直接不跑
  if (env.FORK_PR === 'true') return { ok: false, why: 'fork PR 不跑复审' };
  if (!env.PR_NUMBER) return { ok: false, why: '没有 PR 编号（非 pull_request 事件）' };
  return { ok: true };
}

module.exports = { gate, API_BASE, MODEL, LABEL, DIFF_CAP, MAX_TOKENS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ciReview.test.js`
Expected: PASS（此时 `run()` 还不存在 —— 先在 `module.exports` 前补上最小 `run`：调 `gate`，
不通过就 `return { exitCode: 0, skipped: true, stdout: ['::warning::CI-REVIEW ' + why] }`；
通过则 `throw new Error('not implemented')` 也会被下面的 catch 兜住。Step 5 起填真实现。）

- [ ] **Step 5: 写「只出一次网 + 禁重试」的失败测试**

追加进 `test/ciReview.test.js`：

```js
test('授权齐全：恰好一次模型调用 + 恰好一次贴评论调用，中途失败不重试', async () => {
  let thrown = false;
  const f = fakeFetch((url) => {
    if (thrown) throw new Error('不该有第二次调用');
    if (url.includes('/v1/text/chatcompletion_v2')) {
      thrown = true;   // 模型回 200 但内容坏 —— 这是「失败」，不许再打一次
      return { ok: true, status: 200, json: async () => ({ choices: [] }) };
    }
    return { ok: true, status: 201, json: async () => ({}) };
  });
  const out = await review.run({
    env: { MINIMAX_API_KEY: KEY, GITHUB_TOKEN: 't', PR_NUMBER: '7', LABELS: 'ai-review', REPO: 'o/r' },
    fetchImpl: f.fn, diff: '+const a = 1', findings: null,
  });
  assert.strictEqual(out.exitCode, 0, '模型回坏东西也必须绿（fail-open）');
  assert.match(out.stdout.join('\n'), /CI-REVIEW/);
  assert.strictEqual(f.calls.filter(c => c.url.includes('chatcompletion')).length, 1, '计费调用禁重试');
});

test('Authorization 头带 Key，但 Key 不出现在 stdout / 评论正文 / prompt 里', async () => {
  const f = fakeFetch(async (url) => url.includes('chatcompletion')
    ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '看着没问题' } }] }) }
    : { ok: true, status: 201, json: async () => ({}) });
  const out = await review.run({
    env: { MINIMAX_API_KEY: KEY, GITHUB_TOKEN: 't', PR_NUMBER: '7', LABELS: 'ai-review', REPO: 'o/r' },
    fetchImpl: f.fn, diff: '+const a = 1', findings: null,
  });
  const hay = out.stdout.join('\n') + '|' + out.comment + '|' + JSON.stringify(f.calls.map(c => c.init.body));
  assert.ok(!hay.includes(KEY), 'Key 泄漏');
  const auth = f.calls.find(c => c.url.includes('chatcompletion')).init.headers.Authorization;
  assert.strictEqual(auth, `Bearer ${KEY}`, 'Key 只该在头里');
});

test('diff 超过上限时截断并写明被截断，而不是拒绝复审', async () => {
  const f = fakeFetch(async (url) => url.includes('chatcompletion')
    ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    : { ok: true, status: 201, json: async () => ({}) });
  const huge = 'l'.repeat(review.DIFF_CAP + 5000);
  await review.run({ env: { MINIMAX_API_KEY: KEY, GITHUB_TOKEN: 't', PR_NUMBER: '7', LABELS: 'ai-review', REPO: 'o/r' },
    fetchImpl: f.fn, diff: huge, findings: null });
  const body = f.calls[0].init.body;
  assert.match(body, /已截断/);
  assert.ok(body.length < review.DIFF_CAP + 6000, '截断没生效');
});

test('doctor 的归因结论（若有）进 prompt：让复审知道「哪儿已经确定红了」', async () => {
  const f = fakeFetch(async (url) => url.includes('chatcompletion')
    ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    : { ok: true, status: 201, json: async () => ({}) });
  const findings = { verdict: 'FAIL', attempts: 3,
    findings: [{ category: 'DETERMINISTIC_REGRESSION', name: '某用例', file: 'test/a.test.js',
      culprit: 'src/x.js:9', attempts: [1, 2, 3], nextAction: '看这一行' }] };
  await review.run({ env: { MINIMAX_API_KEY: KEY, GITHUB_TOKEN: 't', PR_NUMBER: '7', LABELS: 'ai-review', REPO: 'o/r' },
    fetchImpl: f.fn, diff: '+const a = 1', findings });
  assert.match(f.calls[0].init.body, /DETERMINISTIC_REGRESSION/);
});

test('renderComment: 模型文本一律包在「未经人工审阅」告示下，且剥掉 GitHub workflow 命令前缀', () => {
  const body = review.renderComment('看着没问题\n::error::伪装的注解');
  assert.match(body, /模型生成/);
  assert.ok(!/^::/m.test(body), '正文里不该出现可执行的 workflow 命令行');
});

test('贴评论用的是 GITHUB_TOKEN 打 REST，不引入 github-script（Windows runner 的 pnpm 坑）', async () => {
  const f = fakeFetch(async (url) => url.includes('chatcompletion')
    ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    : { ok: true, status: 201, json: async () => ({}) });
  await review.run({ env: { MINIMAX_API_KEY: KEY, GITHUB_TOKEN: 't', PR_NUMBER: '7', LABELS: 'ai-review', REPO: 'o/r' },
    fetchImpl: f.fn, diff: 'd', findings: null });
  const post = f.calls.find(c => c.url.includes('/repos/o/r/'));
  assert.ok(post, '应有贴评论调用');
  assert.match(post.url, /\/issues\/7\/comments$/);
  assert.strictEqual(post.init.headers.Authorization, 'Bearer t');
});
```

Run: `node --test test/ciReview.test.js`
Expected: FAIL（`review.run`/`renderComment` 未实现或不完整）

- [ ] **Step 6: 实现 `buildPrompt` / `callModel` / `renderComment` / `run`**

补进 `scripts/ci-review.cjs`（`module.exports` 之前）：

```js
function buildPrompt({ diff, findings }) {
  const cap = diff.length > DIFF_CAP ? diff.slice(0, DIFF_CAP) + '\n…（diff 已截断，后面没给）' : diff;
  const det = findings && findings.findings && findings.findings.length
    ? '\n\n确定性归因已判出的问题（这些别再说一遍，只补它没覆盖的）：\n'
      + findings.findings.map(x => `- ${x.category} ${x.name} @ ${x.culprit || x.file || '-'}`).join('\n')
    : '';
  return `你在复审一个 Electron 音乐下载器的一次改动。只读，不执行任何东西。
请指出：① 这个 diff 里可能漏掉的影响面（IPC 契约、i18n 双词典、平台分支、asar 排除项这几类是本仓的历史雷区）；
② 明显缺少对应测试的新行为；③ 会坑到运行时而非测试的东西。
每条不超过两句，最多五条；没把握就写「没有明显问题」。不要复述 diff。${det}

diff：
${cap}`;
}

async function callModel({ fetchImpl, apiKey, prompt, signal }) {
  const res = await fetchImpl(`${API_BASE}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, messages: [
      { role: 'system', content: '你是严格的代码复审者。只输出结论，不输出任何工具调用或 JSON 协议。' },
      { role: 'user', content: prompt },
    ], temperature: 0.2, max_tokens: MAX_TOKENS }),
  });
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (res.status !== 200 || !text) throw new Error(`模型调用失败 status=${res.status}`);
  return text;
}

/** 模型文本是不可信内容：告示 + 剥掉可能伪装成 workflow 命令的行 */
function renderComment(text) {
  const safe = String(text).split('\n').filter(l => !/^::[a-z]+::/i.test(l)).join('\n').trim();
  return [`## AI 复审（内容由模型生成，未经人工审阅）`, '', safe || '（模型没有给出内容）'].join('\n');
}

async function postComment({ fetchImpl, token, repo, prNumber, body, apiBase }) {
  const res = await fetchImpl(`${apiBase || 'https://api.github.com'}/repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`贴评论失败 status=${res.status}`);
}

async function run(opts = {}) {
  const env = opts.env || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const stdout = [];
  const g = gate(env);
  if (!g.ok) { stdout.push(`::warning::CI-REVIEW 跳过：${g.why}`); return { exitCode: 0, skipped: true, stdout, comment: '' }; }
  let comment = '';
  try {
    const text = await callModel({ fetchImpl, apiKey: env.MINIMAX_API_KEY,
      prompt: buildPrompt({ diff: String(opts.diff || ''), findings: opts.findings }),
      signal: AbortSignal.timeout(90_000) });
    comment = renderComment(text);
    await postComment({ fetchImpl, token: env.GITHUB_TOKEN, repo: env.REPO, prNumber: env.PR_NUMBER,
      body: comment, apiBase: env.GITHUB_API_URL });
    stdout.push(`::notice::CI-REVIEW 已贴复审（PR #${env.PR_NUMBER}）`);
  } catch (e) {
    // 任何一步挂了都放绿：复审的存在不该给 CI 增加第二种「红」
    stdout.push(`::warning::CI-REVIEW 失败已忽略（${String(e && e.message || e).slice(0, 180)}）`);
  }
  return { exitCode: 0, skipped: false, stdout, comment };
}
```

并把导出补全：

```js
module.exports = { gate, buildPrompt, callModel, renderComment, postComment, run,
  API_BASE, MODEL, LABEL, DIFF_CAP, MAX_TOKENS };
```

Run: `node --test test/ciReview.test.js`
Expected: PASS（全部用例）

- [ ] **Step 7: 加 CLI 入口（workflow 靠它读文件、写产物）**

追加到 `scripts/ci-review.cjs` 末尾：

```js
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  const readOrNull = (p) => { try { return p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; } };
  let diff = '';
  try { diff = get('--diff-file') ? fs.readFileSync(get('--diff-file'), 'utf8') : ''; } catch { /* 空 diff 走跳过 */ }
  run({
    env: process.env,
    diff,
    findings: readOrNull(get('--findings-file')),
  }).then((r) => {
    for (const l of r.stdout) console.log(l);
    if (get('--out-file') && r.comment) { try { fs.writeFileSync(get('--out-file'), r.comment, 'utf8'); } catch { /* 留档失败不影响 */ } }
    process.exitCode = r.exitCode;   // 恒 0 —— 见文件头那条纪律
  }, (e) => { console.log(`::warning::CI-REVIEW 自身失败（${String(e && e.message || e).slice(0, 160)}），忽略`); process.exitCode = 0; });
}
```

Run: `node scripts/ci-review.cjs --diff-file NUL`
Expected: stdout 一行 `::warning::CI-REVIEW 跳过：PR 未贴 ai-review 标签`，退出码 0（本地无 GitHub env 必然如此）

- [ ] **Step 8: 提交**

```bash
git add scripts/ci-review.cjs test/ciReview.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(ci): 复审引擎 —— 标签授权才出网、计费禁重试、Key 只进头、自身失败一律放绿"
```

---

### Task 2: `ci.yml` 接线 —— 标签闸门 + 取 diff + 跑引擎

**Files:**
- Modify: `.github/workflows/ci.yml`（新增第三个 job，`lint-test`/`build-smoke` 两步逐行不动）
- Test: `test/ciReview.test.js`（追加形状钉）

**Interfaces:**
- Consumes: Task 1 的 CLI（`--diff-file` / `--findings-file` / `--out-file`）、env 六件套
  `MINIMAX_API_KEY` `GITHUB_TOKEN` `PR_NUMBER` `LABELS` `REPO` `FORK_PR`。
- Produces: job id `ai-review`（Task 3 的 lint 覆盖钉与本任务的形状钉都按这个 id 钉）。

- [ ] **Step 1: 写形状钉（先失败）**

追加进 `test/ciReview.test.js`：

```js
/**
 * workflow 侧的三条钉 —— 归因那条链的分叉教训（`test/ciDoctor.test.js` 里
 * 「两条 workflow 的 Unit tests 命令体逐行相同」钉的是同一件事）：
 * 出网与花钱的开关一旦只写在 YAML 里，源码测试全绿而闸门被改坏是查不出来的。
 */
test('ci.yml 的 ai-review job：pull_request 专属 + 标签闸门 + 无 fork + 不阻塞主闸门', () => {
  const yaml = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = yaml.match(/^  ai-review:\n(?:.*\n)*?(?=^  \S|^\s*$/m));
  assert.ok(job, 'ci.yml 里没有 ai-review job');
  const body = job[0];
  assert.match(body, /if: \$\{\{ github\.event_name == 'pull_request'/, '必须只在 PR 事件跑');
  assert.match(body, /ai-review/, '闸门必须显式认标签，而不是「有 secret 就跑」');
  assert.match(body, /head\.repo\.full_name == github\.repository/, 'fork PR 必须排除');
  assert.ok(!/needs:/.test(body), '不得 needs 别的 job —— 复审挂了/慢了都不能挡住主闸门');
  assert.match(yaml, /MINIMAX_API_KEY: \$\{\{ secrets\.MINIMAX_API_KEY \}\}/, 'Key 只能从 secret 注入');
  assert.match(body, /continue-on-error: true|CI-REVIEW/, '引擎失败必须是 warning 而不是红');
});
```

Run: `node --test test/ciReview.test.js`
Expected: FAIL —— `ci.yml 里没有 ai-review job`

- [ ] **Step 2: 加 job**

在 `.github/workflows/ci.yml` 的 `build-smoke` job 之后追加（顶层 `jobs:` 下，两空格缩进）：

```yaml
  # ── 第三层：AI 复审（**默认不跑**）──────────────────────
  # 与前两层的性质不同：这一层出网、按用量计费，所以它的开关不是代码而是「人贴的标签」。
  # 归因（scripts/ci-doctor.cjs）是纯确定性规则，绿跑零 annotation；
  # 复审只在 PR 带 `ai-review` 标签时才打一次模型 —— 决定「这次要不要花这笔钱」的
  # 必须是贴标签的那个人，不能是 YAML 里的自动条件。
  # needs 故意不写：复审是附加信息，主闸门的结论不能等它。
  # permissions 只在这一层收到 pull-requests: write（贴评论），workflow 顶层仍是 contents: read。
  ai-review:
    name: AI Review (opt-in)
    runs-on: windows-latest
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      contains(github.event.pull_request.labels.*.name, 'ai-review')
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      # 不 npm ci：这一步只需要 node 与 git，装依赖反而把分钟级的 job 拖成十分钟级
      - name: 取 diff
        shell: bash
        run: |
          git diff "origin/${GITHUB_BASE_REF}...HEAD" > pr.diff || true
          wc -c pr.diff

      # 本版**不接**归因产物：doctor 的结论已经在 step summary 里给人看了，而 ai-review 与 lint-test
      # 是两个并行 job（故意不 needs，见上面注释），拿不到 attempt-N.tap.txt。
      # 引擎侧的 --findings-file 已实现并有测试覆盖，将来要接就是补一个 artifact 传递 —— 别顺手加，
      # 那是第二条需要论证的链路（多一次 artifact 读写就多一种失败形态）。
      - name: 跑复审
        env:
          MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
          # 这两个值是 YAML 那道 if 的第二道锁：闸门条件改坏了（历史上 workflow 与源码两侧分叉过一次，
          # 见 test/ciDoctor.test.js 那条「两处命令体逐行相同」钉的教训），脚本自己还认一次标签与 fork
          LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}
          FORK_PR: ${{ github.event.pull_request.head.repo.fork }}
        run: node scripts/ci-review.cjs --diff-file pr.diff --out-file review.md
```

- [ ] **Step 3: 跑形状钉确认通过**

Run: `node --test test/ciReview.test.js`
Expected: PASS

- [ ] **Step 4: YAML 语法自证（不靠 CI 试错）**

Run: `node -e "const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); const bad=s.split('\n').map((l,i)=>[i+1,l]).filter(([n,l])=>/\t/.test(l)||/^ {1,3}\S/.test(l)); console.log('tabs/oddIndent', bad.length, 'jobs', (s.match(/^  [a-z-]+:$/gm)||[]).length)"`
Expected: `tabs/oddIndent 0 jobs 3`（制表符与奇数缩进是 Actions 解析失败的两个主因，本地先看住，别拿 runner 当调试器）

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/ci.yml test/ciReview.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(ci): ai-review job —— 标签授权闸门、不 needs 主闸门、per-job pull-requests:write"
```

---

### Task 3: 把引擎纳进 lint 与脚本台账（补上「绿跑执行不到」的死角）

**Files:**
- Modify: `package.json`（`scripts.lint`）
- Test: `test/ciDoctor.test.js:451` 附近（同一条 lint 覆盖钉的形状）、`test/scripts-hygiene.test.js`（口径行）

**Interfaces:**
- Consumes: Task 1 的文件路径 `scripts/ci-review.cjs`。
- Produces: 无下游。

- [ ] **Step 1: 写失败测试**

追加进 `test/ciDoctor.test.js`（复用文件已有的 `fs`/`path`）：

```js
test('ci-review.cjs 也在 lint 覆盖里 —— 与归因同一条死角：只在特定事件才执行', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.lint.includes('scripts/ci-review.cjs'),
    `lint 命令没覆盖复审引擎：${pkg.scripts.lint}`);
});
```

Run: `node --test test/ciDoctor.test.js`
Expected: FAIL（lint 只有 `src/ test/ scripts/ci-doctor.cjs`）

- [ ] **Step 2: 改 lint 命令**

`package.json`：`"lint": "eslint src/ test/ scripts/ci-doctor.cjs"` →
`"lint": "eslint src/ test/ scripts/ci-doctor.cjs scripts/ci-review.cjs"`。
（仍按文件名点名，**不要**改成 `scripts/`：该目录下 `audit-all.js`/`audit-missing.js`/`mark-i18n.js` 有 8 处既有 error，
整目录纳进来会立刻把主闸门变红 —— 这条取舍的现场记录在 roadmap 与 `test/scripts-hygiene.test.js` 头部。）

- [ ] **Step 3: 跑 lint 确认零新增 error**

Run: `npm run lint`
Expected: `✖ 2 problems (0 errors, 2 warnings)`（那两条 warning 是 `test/list-axes.test.js:53` 与
`src/renderer/js/views/local.js:438` 的既有项，与本计划无关）

- [ ] **Step 4: 更新 `test/scripts-hygiene.test.js` 头部那句口径**

该文件头部现在写的是「唯一被单独拉进 lint 的是 `scripts/ci-doctor.cjs`」，改完 lint 就变谎话了。
改成点名两个文件、理由同一句（绿跑执行不到）。这是本仓「注释与现实分叉」台账里反复出现的那类账，顺手钉住：

```js
test('lint 单独点名的 scripts 文件必须真的存在（防止口径注释先于文件过期）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const named = (pkg.scripts.lint.match(/scripts\/[\w.-]+\.cjs/g) || []);
  assert.ok(named.length >= 2, `lint 点名的 CI 脚本少于两处：${pkg.scripts.lint}`);
  for (const n of named) assert.ok(fs.existsSync(path.join(__dirname, '..', n)), `lint 点名了不存在的文件 ${n}`);
});
```

Run: `node --test test/scripts-hygiene.test.js`
Expected: PASS

- [ ] **Step 5: 全量本地闸门**

Run: `npm run lint && node --test test/*.test.js`
Expected: lint 0 error；测试 `fail 0`（用例总数应比现状多约 12 枚）

- [ ] **Step 6: 提交**

```bash
git add package.json test/ciDoctor.test.js test/scripts-hygiene.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "chore(ci): 复审引擎纳进 lint —— 它和归因一样在绿跑里执行不到，死角不能只堵一半"
```

---

### Task 4: 台账与文档收编（把「要花钱」这件事写到明面上）

**Files:**
- Modify: `CHANGELOG.md`（`[未发布] → ### 工程`）
- Modify: `SECURITY.md`（新增一节：CI 侧模型调用与 secret 的边界）
- Modify: `README.md`（若已有 CI 说明段落，加一行「PR 贴 `ai-review` 标签可触发一次可选的 AI 复审」）
- Modify: `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`（第 4 行状态 + 删掉「另立计划再说」那句）

**Interfaces:**
- Consumes: Task 1/2 的最终形态（标签名、secret 名、job 名）。
- Produces: 无下游。

- [ ] **Step 1: CHANGELOG**

`[未发布] → ### 工程` 追加两条：一条写复审 agent 的形态与**默认不跑**（标签授权 + 计费），
一条写它与归因的分工（归因不出网）。措辞要求：让读的人第一句就知道「这玩意会花钱、我不贴标签它就不动」。

- [ ] **Step 2: SECURITY.md 新增一节**

必须写清的三条边界（缺一条这节就没意义）：
① `MINIMAX_API_KEY` 只经 env 注入、只进 Authorization 头，不进 prompt/日志/评论正文（`test/ciReview.test.js` 有钉）；
② 谁能贴 `ai-review` 标签 = 谁能花这把 Key 的钱，所以标签权限属于 write 协作者；fork PR 排除；
③ 模型输出按不可信文本处理（剥 workflow 命令行 + 未经人工审阅告示），且该 job 只有
`contents: read` + `pull-requests: write`，**没有** contents:write —— 被 prompt 注入的模型改不动仓库。

- [ ] **Step 3: roadmap 第 4 行状态改写**

把「复审 agent 未动 —— …另立计划再说」改成实际落地状态（含 SHA 与两次 CI 结论），
并删掉正文里那条「另立计划再说」的留白句；轨道四至此两半都齐。

- [ ] **Step 4: 自检文档完整性**

Run: `node -e "for (const f of ['CHANGELOG.md','SECURITY.md','README.md']) { const s=require('fs').readFileSync(f,'utf8'); console.log(f, s.length, 'fffd', (s.match(/\uFFFD/g)||[]).length); }"`
Expected: 三份文件 `fffd 0`（本仓编辑中文文档时 U+FFFD 是唯一能区分「写坏了」与「看起来正常」的硬指标）

- [ ] **Step 5: 提交并推送（路由切换规则：直连失败立刻换代理，不重复探测）**

```bash
git add CHANGELOG.md SECURITY.md README.md docs/superpowers/plans/2026-10-14-ai-program-roadmap.md
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "docs: 复审 agent 的花钱边界与三轨道台账收编 —— 标签=授权、fork 排除、模型输出按不可信处理"
git push origin HEAD:main
```

---

## 验证计划（做完怎么算「验过」）

1. **本地零出网验证**：`node --test test/ciReview.test.js` 全绿 —— 引擎的行为全部由假 fetch 钉住，
   测试进程不需要网络也不需要 Key。
2. **主闸门不受影响**：`01ccead` 之后的每次 push，`Lint & Unit Tests` 与 `Build & Asar Smoke` 结论不变；
   `ai-review` job 在 push 事件下**根本不出现**（`if` 里第一句就是 `github.event_name == 'pull_request'`）。
3. **闸门真在标签上**：开一个不带标签的 PR → Actions 里 `ai-review` 显示 skipped；
   贴 `ai-review` → 它开始跑并贴出一条评论。**这一步会花一次调用**，属于本计划拍板清单第 1 条，
   需用户点头后才做。
4. **失败放绿**：临时把 secret 设成坏值跑一次带标签的 PR（或用不存在的 PR 号）→ 该 job 应为
   `success` 且日志里只有 `::warning::CI-REVIEW 失败已忽略`。
5. **归因链没被污染**：带标签与不带标签两种 PR 的 `CI-DOCTOR` annotation 数量应完全一致（复审不参与归因）。

## 本计划刻意**不做**的事（防止后续 agent 顺手加）

- 不做自动触发（不「每个 PR 都复审」）：那是把花钱的决定权从人手里拿走。
- 不做 review comment / 行级建议：truncated diff 的行号会指错位置，指错的评论比没评论更坏。
- 不给模型任何工具面或写权限：复审只需要一段话。
- 不进 `release.yml`：tag 事件没有 PR 载体（无 `issue_number`、无贴标签的人）。
- 不加 `actions/github-script`：它要 pnpm，Windows runner 上是本仓已知的坑；直接打 REST 零新增。
