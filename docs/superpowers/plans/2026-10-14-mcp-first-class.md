# MCP 一等公民化 + 调用审计 + 速率限制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把揽乐的 MCP 服务从「默认关、设置页藏一行」升级成可审计、限速、一键接入的一等公民，并补上目前完全缺失的端到端调用测试。

**Architecture:** 三个纯函数模块（审计存储 / 连接片段 / 协议层 `onCall` 钩子）+ 传输层令牌桶 + 设置页 UI。所有可测逻辑都不碰 electron：`filePath`、`now`、`tools`、`callTool`、`onCall` 一律依赖注入，与仓库现有 `mcpCore.js` / `mcpServer.js` 的 DI 口径一致（`src/main/mcp/mcpCore.js:46`、`src/main/mcp/mcpServer.js:43`）。接线层只做组装（`src/main/ipc/mcp.js`）。

**Tech Stack:** Node 22 内置（`node:http`、`node:fs/promises`、`node:crypto`）、`node:test` + `node:assert`、Electron 主进程、原生 JS 渲染层（无框架）。

**Spec:** `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`（程序级约束）；缺口依据 `SECURITY.md §4「本地服务无速率限制」`、`docs/archive/AI_MUSIC_RESEARCH_2026-09-19.md:66`（工具白名单红线）。

## Global Constraints

- 零新增依赖：`package.json` 的 dependencies/devDependencies 一律不动。
- MCP 工具白名单红线不扩：cookie/登录、文件路径读写、set-pref、对话框、更新安装不进 `AGENT_TOOLS`（`src/main/mcp/tools.js:8-9`）。
- `src/renderer/js/features.js` 的 `FEATURES.ai` 保持 `false`（AI 创作是产品决定，本计划不碰）。
- 新通道先声明进 `src/shared/ipcContract.js`，再用 `src/main/ipc/register.js` 的 `handle()` 注册。
- 新用户可见文案全部进 `src/renderer/js/lang/zh.json` + `en.json`；`views/settings.js` 属 `test/toast-i18n.test.js` 的 `CONQUERED`（欠账 0），禁止往 `showToast()` 塞中文字面量。
- 审计文件绝不落敏感值：密钥/令牌/Cookie 类参数只留键名（判据 `SENSITIVE_ARG_RE`）。
- 每个任务结束时五层闸门全绿：`npm run lint`、`npm run audit:deps`、`npm run check:dead-deps`、`node --test --test-concurrency=2 "test/*.test.js"`、`npm run build && npm run smoke:asar`。
- 提交：`git -c user.name=CodeBuddy -c user.email=codebuddy@local commit`；只 stage 显式路径。

---

### Task 1: 审计存储 `auditStore.js`

**Files:**
- Create: `src/main/mcp/auditStore.js`
- Test: `test/mcp-audit-store.test.js`（新建）

**Interfaces:**
- Consumes: 无（仅 Node 内置）
- Produces:
  - `createAuditStore({ filePath, maxEntries = 200 }) → { record(entry): Promise<void>, list({ limit }): Promise<Array>, clear(): Promise<void>, size(): Promise<number> }`
  - `summarizeArgs(namedArgs) → { argsKeys: string[], summary: string }`
  - `SENSITIVE_ARG_RE`（正则）、`AUDIT_FILE_NAME = 'mcp-audit.json'`
  - `entry` 形状（Task 3 的 `onCall` 必须产出同形对象）：
    `{ ts:number, tool:string, source:'agent'|'assistant', ok:boolean, ms:number, argsKeys:string[], summary:string, err?:string }`

- [x] **Step 1: 写失败测试**

新建 `test/mcp-audit-store.test.js`：

```js
/**
 * MCP 调用审计存储
 *
 * 钉四件事：① 写了能读回（最新在前）；② 容量封顶不无限增长；
 * ③ 敏感值绝不进磁盘（审计文件里搜得到「周杰伦」搜不到密钥 —— 前者是审计的
 * 可读性，后者一旦落盘就等于把计费凭证抄进一个不带加密的 JSON）；
 * ④ 并发读-改-写不丢条目、损坏文件不炸。②③④ 都是本仓历史事故的同族
 * （生成历史就是因为并发整文件覆盖丢过条目，损坏 JSON 曾经每次冷启动重复读+备份）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuditStore, summarizeArgs, SENSITIVE_ARG_RE } = require('../src/main/mcp/auditStore');

const tmpFile = (name = 'mcp-audit.json') =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-audit-')), name);

const mkEntry = (over = {}) => ({
  ts: 1, tool: 'search_music', source: 'agent', ok: true, ms: 10, argsKeys: ['keyword'], summary: '', ...over,
});

test('record→list：最新在前，字段原样读回', async () => {
  const store = createAuditStore({ filePath: tmpFile() });
  await store.record(mkEntry({ ts: 1, tool: 'search_music' }));
  await store.record(mkEntry({ ts: 2, tool: 'add_to_queue', ok: false, err: '平台无结果' }));
  const items = await store.list({ limit: 10 });
  assert.deepStrictEqual(items.map(i => i.tool), ['add_to_queue', 'search_music']);
  assert.strictEqual(items[0].err, '平台无结果');
  assert.strictEqual(items[0].source, 'agent');
});

test('容量封顶：超出丢最旧', async () => {
  const store = createAuditStore({ filePath: tmpFile(), maxEntries: 3 });
  for (let i = 0; i < 5; i++) await store.record(mkEntry({ ts: i, tool: `t${i}` }));
  assert.deepStrictEqual((await store.list({ limit: 99 })).map(i => i.ts), [4, 3, 2]);
});

test('list 的 limit 生效且不报错', async () => {
  const store = createAuditStore({ filePath: tmpFile() });
  for (let i = 0; i < 5; i++) await store.record(mkEntry({ ts: i }));
  assert.strictEqual((await store.list({ limit: 2 })).length, 2);
  assert.strictEqual((await store.list({})).length, 5);
});

test('clear：清空后读为空，文件仍在（不留「读不到=没开过」的歧义）', async () => {
  const f = tmpFile();
  const store = createAuditStore({ filePath: f });
  await store.record(mkEntry());
  await store.clear();
  assert.deepStrictEqual(await store.list({ limit: 10 }), []);
  assert.ok(fs.existsSync(f), 'clear 应写空数组而不是删文件');
});

test('并发写入不丢条目', async () => {
  const store = createAuditStore({ filePath: tmpFile(), maxEntries: 50 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.record(mkEntry({ ts: i, tool: `t${i}` }))));
  assert.strictEqual((await store.list({ limit: 100 })).length, 20);
});

test('损坏的审计文件：按空处理，后续写入照常', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ 半截', 'utf8');
  const store = createAuditStore({ filePath: f });
  assert.deepStrictEqual(await store.list({ limit: 10 }), []);
  await store.record(mkEntry());
  assert.strictEqual((await store.list({ limit: 10 })).length, 1);
});

test('summarizeArgs：普通检索词留摘要，敏感键只留名', () => {
  const s = summarizeArgs({ keyword: '周杰伦 现场', aiMusicApiKey: 'mk-SECRET-123', page: 2 });
  assert.deepStrictEqual(s.argsKeys.slice().sort(), ['aiMusicApiKey', 'keyword', 'page']);
  assert.strictEqual(s.summary, '周杰伦 现场');
  assert.ok(!JSON.stringify(s).includes('mk-SECRET-123'), '敏感值不许出现在摘要产物里');
});

test('审计文件里搜不到敏感值（端到端一次）', async () => {
  const f = tmpFile();
  const store = createAuditStore({ filePath: f });
  const args = { cookie: 'SESSION=abc', q: '夜跑' };
  await store.record(mkEntry({ ...summarizeArgs(args), tool: 'search_music' }));
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('SESSION=abc'), 'Cookie 值不得落审计盘');
  assert.ok(raw.includes('夜跑'), '普通检索词应保留 —— 没有它的审计等于没用');
  assert.ok(SENSITIVE_ARG_RE.test('cookie'), '判据本身要能被单独钉住，防止将来误改');
});
```

- [x] **Step 2: 跑到红**

Run: `node --test test/mcp-audit-store.test.js`
Expected: FAIL — `Cannot find module '../src/main/mcp/auditStore'`

- [x] **Step 3: 最小实现**

新建 `src/main/mcp/auditStore.js`：

```js
/**
 * MCP 调用审计存储（滚动 JSON 文件）
 *
 * 为什么要有这份审计：MCP 服务把「搜索 / 加入下载队列 / 改歌单 / 收藏」开给了
 * 本机任意一个拿到令牌的进程。没有审计时，用户只能在事后发现磁盘上多了 200 首
 * 下载，却查不到是谁干的 —— 「一等公民」不只是能连上要容易，还得能回答「它做了什么」。
 *
 * 三条纪律（都有对应测试）：
 *   1. 敏感值不落盘。参数名命中 SENSITIVE_ARG_RE 的一律只记键名，值丢弃：审计文件
 *      是不加密的普通 JSON，而工具面参数里可能出现 key/cookie/token。
 *   2. 容量封顶。桌面进程不能因一个坏客户端把磁盘写满 —— 与生成历史同口径（cap 50 →
 *      这里 200 条，一次调用约 200 B，最坏 40 KB）。
 *   3. 读-改-写串行 + tmp/rename 原子写。并发调用整文件覆盖会丢条目
 *      （`src/api/ai-music.js` 的生成历史踩过同一个坑，那里的 promise 链是同一个解法）。
 *
 * 损坏文件按空处理而不是抛：这是可观测性数据，读不出来时「什么都不显示」比
 * 「设置页整个打不开」更可接受；下一次成功写入会覆盖掉坏文件。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');

const AUDIT_FILE_NAME = 'mcp-audit.json';
const SENSITIVE_ARG_RE = /(key|token|cookie|password|secret|authorization|auth)/i;
const SUMMARY_MAX = 60;

/** 具名参数 → 可安全落盘的摘要（键名全留，值只取第一个非敏感字符串） */
function summarizeArgs(namedArgs) {
  const obj = (namedArgs && typeof namedArgs === 'object' && !Array.isArray(namedArgs)) ? namedArgs : {};
  const argsKeys = Object.keys(obj);
  let summary = '';
  for (const k of argsKeys) {
    if (SENSITIVE_ARG_RE.test(k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v) { summary = v.slice(0, SUMMARY_MAX); break; }
  }
  return { argsKeys, summary };
}

function createAuditStore({ filePath, maxEntries = 200 }) {
  let chain = Promise.resolve();

  async function _readRaw() {
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_e) {
      return [];
    }
  }

  async function _writeRaw(list) {
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  }

  async function record(entry) {
    const run = async () => {
      const list = await _readRaw();
      list.unshift(entry);
      if (list.length > maxEntries) list.length = maxEntries;
      await _writeRaw(list);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  async function list({ limit } = {}) {
    const all = await _readRaw();
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? all.slice(0, n) : all.slice();
  }

  async function clear() { await chain.then(async () => { await _writeRaw([]); }, async () => { await _writeRaw([]); }); }

  async function size() { return (await _readRaw()).length; }

  return { record, list, clear, size, maxEntries };
}

module.exports = { createAuditStore, summarizeArgs, SENSITIVE_ARG_RE, AUDIT_FILE_NAME };
```

- [x] **Step 4: 跑到绿**

Run: `node --test test/mcp-audit-store.test.js`
Expected: PASS，`ℹ pass 8` / `ℹ fail 0`

- [x] **Step 5: 全量门禁**

Run: `npm run lint && npm run check:dead-deps && node --test --test-concurrency=2 "test/*.test.js"`
Expected: lint 0 error；dead-deps 通过（新模块尚未被 require，`check:dead-deps` 只看 npm 包，不看源文件）；`ℹ fail 0`

- [x] **Step 6: 提交**

```bash
git add src/main/mcp/auditStore.js test/mcp-audit-store.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(mcp): 调用审计存储 —— 谁驱动了揽乐从此有据可查（敏感值不落盘、容量封顶、写串行）"
```

---

### Task 2: 传输层速率限制（闭合 SECURITY.md §4）

**Files:**
- Modify: `src/main/mcp/mcpServer.js:43-111`（`createMcpServer` 增参数、`route` 增一刀）
- Test: `test/mcp-rate-limit.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `createMcpServer({ token, handleMessage, rateLimit = { capacity: 120, refillPerSec: 30 }, now = Date.now, onRejected = null })`；被限流时返回 `429 { error: 'rate_limited' }` + `Retry-After` 头，并调用 `onRejected({ tool: <method|null>, retryAfterSec })`。默认值 `DEFAULT_RATE_LIMIT` 导出。

- [x] **Step 1: 写失败测试**

新建 `test/mcp-rate-limit.test.js`：

```js
/**
 * MCP 传输层速率限制
 *
 * SECURITY.md §4 记录的未闭合项：「MCP 服务只靠 Bearer 令牌与 Origin 白名单防误触，
 * 没有请求频率限制」。一个写坏的 Agent 循环（或拿到令牌的任意本机进程）可以无限
 * 触发下载/改库。这里补上令牌桶，钉四条：
 *   ① 桶满必拒（429 + Retry-After）；② 时间推进后自动恢复；
 *   ③ 未通过鉴权的请求不吃桶 —— 否则任何人都能用垃圾请求把合法客户端饿死；
 *   ④ 批量 JSON-RPC 按整批计一次（协议层已把数组拆开分发，计量口径要钉住）。
 * 时钟注入（now）保证不靠 sleep 测限流。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createMcpServer, DEFAULT_RATE_LIMIT } = require('../src/main/mcp/mcpServer');

const TOKEN = 'rate-test-token-0123456789';

async function serve(opts = {}) {
  let clock = 0;
  const rejected = [];
  const server = createMcpServer({
    token: TOKEN,
    handleMessage: async (msg) => (Array.isArray(msg)
      ? msg.map(m => ({ jsonrpc: '2.0', id: m.id, result: { ok: true } }))
      : { jsonrpc: '2.0', id: msg.id, result: { ok: true } }),
    rateLimit: opts.rateLimit,
    now: () => clock,
    onRejected: (info) => rejected.push(info),
  });
  const { port } = await server.start(0);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: server.stop,
    rejected,
    advance(ms) { clock += ms; },
  };
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
});
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

test('桶满必拒：超出 capacity 立刻 429，带 Retry-After', async () => {
  const h = await serve({ rateLimit: { capacity: 3, refillPerSec: 1 } });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await post(h.url, init)).status, 200);
    const res = await post(h.url, init);
    assert.strictEqual(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1, 'Retry-After 至少 1 秒');
    const body = await res.json();
    assert.strictEqual(body.error, 'rate_limited');
    assert.strictEqual(h.rejected.length, 1);
  } finally { await h.stop(); }
});

test('时间推进后恢复：refill 到足额就能继续调用', async () => {
  const h = await serve({ rateLimit: { capacity: 2, refillPerSec: 1 } });
  try {
    await post(h.url, init); await post(h.url, init);
    assert.strictEqual((await post(h.url, init)).status, 429);
    h.advance(1000);
    assert.strictEqual((await post(h.url, init)).status, 200);
  } finally { await h.stop(); }
});

test('鉴权失败不吃桶：错 token 连打 100 次后，合法请求仍有全额容量', async () => {
  const h = await serve({ rateLimit: { capacity: 5, refillPerSec: 1 } });
  try {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(h.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify(init),
      });
      assert.strictEqual(r.status, 401);
    }
    for (let i = 0; i < 5; i++) assert.strictEqual((await post(h.url, init)).status, 200);
    assert.strictEqual(h.rejected.length, 0, '401 不该被记成限流');
  } finally { await h.stop(); }
});

test('批量请求整批计一次（计量口径钉死）', async () => {
  const h = await serve({ rateLimit: { capacity: 2, refillPerSec: 1 } });
  try {
    const res = await post(h.url, [init, init, init]);
    assert.strictEqual(res.status, 200, '3 条一批发 200 —— 批次只扣 1 个令牌');
    assert.strictEqual((await post(h.url, init)).status, 200);
    assert.strictEqual((await post(h.url, init)).status, 429);
  } finally { await h.stop(); }
});

test('默认容量存在且宽松：正常 Agent 一轮对话（几十次调用）不该被限', () => {
  assert.ok(DEFAULT_RATE_LIMIT.capacity >= 60, '默认容量过小会误伤真实使用');
  assert.ok(DEFAULT_RATE_LIMIT.refillPerSec >= 10);
});
```

- [x] **Step 2: 跑到红**

Run: `node --test test/mcp-rate-limit.test.js`
Expected: FAIL — 前四条 429 断言拿到 200（还没限流），第五条 `DEFAULT_RATE_LIMIT` 为 undefined

- [x] **Step 3: 实现令牌桶**

在 `src/main/mcp/mcpServer.js` 的 `MAX_BODY_BYTES` 下面加：

```js
const DEFAULT_RATE_LIMIT = { capacity: 120, refillPerSec: 30 };

/** 令牌桶：容量 = 突发上限，refill = 稳态配额。时钟注入以便测试。 */
function createTokenBucket({ capacity, refillPerSec, now }) {
  let tokens = capacity;
  let last = now();
  return {
    tryTake(cost = 1) {
      const t = now();
      const gained = ((t - last) / 1000) * refillPerSec;
      last = t;
      tokens = Math.min(capacity, tokens + gained);
      if (tokens < cost) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / refillPerSec)) };
      }
      tokens -= cost;
      return { ok: true };
    },
  };
}
```

把签名从 `function createMcpServer({ token, handleMessage })` 改为：

```js
function createMcpServer({ token, handleMessage, rateLimit = DEFAULT_RATE_LIMIT, now = Date.now, onRejected = null }) {
  const bucket = createTokenBucket({ ...rateLimit, now });
```

在 `route()` 里，紧接 Origin 检查（现 `:79-82`）之后、`readBody`（现 `:84`）之前插入：

```js
    // 速率限制放在鉴权之后：未过鉴权的请求一律 401 且不消耗令牌，
    // 否则任意本机进程都能用垃圾请求把合法 Agent 的配额吃光（限流反成 DoS 面）。
    const take = bucket.tryTake(1);
    if (!take.ok) {
      if (onRejected) onRejected({ retryAfterSec: take.retryAfterSec });
      res.setHeader('Retry-After', String(take.retryAfterSec));
      return json(res, 429, { error: 'rate_limited' });
    }
```

并更新导出与文件头注释的安全边界清单（加一行「请求频率：令牌桶，默认
`capacity=120 / refillPerSec=30`；超限 429 + Retry-After」）：

```js
module.exports = { createMcpServer, MCP_PATH, MAX_BODY_BYTES, LOCAL_ORIGIN_RE, DEFAULT_RATE_LIMIT, createTokenBucket };
```

- [x] **Step 4: 跑到绿**

Run: `node --test test/mcp-rate-limit.test.js test/mcpServer.test.js`
Expected: 全 PASS（既有的 401/403/413/-32700/405/404 钉不许因为多了一道 429 而改动）

- [x] **Step 5: 全量门禁**

Run: `node --test --test-concurrency=2 "test/*.test.js"` → `ℹ fail 0`

- [x] **Step 6: 提交**

```bash
git add src/main/mcp/mcpServer.js test/mcp-rate-limit.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(mcp): 传输层令牌桶限流 —— 闭合 SECURITY.md §4 的「无速率限制」"
```

---

### Task 3: 协议层 `onCall` 钩子 + 接线到 IPC 与契约

**Files:**
- Modify: `src/main/mcp/mcpCore.js:46-94`（`createMcpHandler` 加 `onCall`、加 `source`）
- Modify: `src/main/ipc/mcp.js`（建 store、传钩子、注册两条新通道、状态里带计数）
- Modify: `src/shared/ipcContract.js:175-177`（`mcp-audit` / `mcp-audit-clear`）
- Test: `test/mcpCore.test.js`（追加）、`test/mcp-audit-wiring.test.js`（新建，纯逻辑接线）

**Interfaces:**
- Consumes: Task 1 的 `createAuditStore` / `summarizeArgs`、Task 2 的 `onRejected`
- Produces:
  - `createMcpHandler({ tools, serverVersion, callTool, onCall = null, source = 'agent' })`，
    每次 `tools/call` 结束调用 `onCall(entry)`，entry 即 Task 1 的 entry 形状。
  - IPC `mcp-audit`（`invoke`，参数 `opts` obj：`{ limit?: number }`）→ `{ items, maxEntries, count, rateLimited }`
  - IPC `mcp-audit-clear`（`invoke`，无参）→ `{ success: true }`
  - `mcp-status` 返回值新增 `auditCount: number`、`rateLimited: number`

- [x] **Step 1: 写协议层失败测试**

在 `test/mcpCore.test.js` 末尾追加（沿用该文件既有的 `tools` 构造 helper；若无则用下面内联表）：

```js
test('onCall：每次 tools/call 都产出一条审计（成功与业务失败都记）', async () => {
  const tools = [{
    name: 'search_music', channel: 'search-music',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } },
  }];
  const entries = [];
  const handler = createMcpHandler({
    tools, serverVersion: '1.0.0',
    callTool: async (channel, args) => (args[0] === 'boom' ? { error: '平台无结果' } : { songs: [] }),
    onCall: (e) => entries.push(e),
  });
  await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: '周杰伦' } } });
  await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: 'boom' } } });
  assert.strictEqual(entries.length, 2, '两次调用都要有记录');
  assert.strictEqual(entries[0].tool, 'search_music');
  assert.strictEqual(entries[0].ok, true);
  assert.strictEqual(entries[0].summary, '周杰伦');
  assert.deepStrictEqual(entries[0].argsKeys, ['keyword']);
  assert.strictEqual(entries[1].ok, false, '业务失败（isError）也是审计对象');
  assert.strictEqual(entries[1].source, 'agent');
});

test('onCall：未知工具与参数校验失败不产审计，抛错要产 err 字段', async () => {
  const entries = [];
  const handler = createMcpHandler({
    tools: [{ name: 'get_lyrics', channel: 'get-lyrics', inputSchema: { type: 'object', required: ['id'], properties: { id: {} } } }],
    serverVersion: '1.0.0',
    callTool: async () => { throw new Error('网络不可达'); },
    onCall: (e) => entries.push(e),
  });
  await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.strictEqual(entries.length, 0, '工具名都不存在时无从审计');
  await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_lyrics', arguments: {} } });
  assert.strictEqual(entries[0].ok, false);
  assert.match(entries[0].err, /网络不可达/);
});
```

- [x] **Step 2: 跑到红**

Run: `node --test test/mcpCore.test.js`
Expected: FAIL — `entries.length` 为 0（`onCall` 尚未实现）

- [x] **Step 3: 实现钩子**

`src/main/mcp/mcpCore.js` 的 `createMcpHandler` 签名加两个参数，`tools/call` 分支改为（保留既有 `namedToPositional`、`toolText` 行为，只加计量与回调）：

```js
function createMcpHandler({ tools, serverVersion, callTool, onCall = null, source = 'agent' }) {
```

```js
      case 'tools/call': {
        const name = params && params.name;
        const tool = byName.get(name);
        if (!tool) return rpcError(id, -32602, `未知工具: ${String(name).slice(0, 64)}`);
        const started = Date.now();
        const r = namedToPositional(tool.channel, params && params.arguments);
        if (!r.ok) return toolText(id, true, r.error);
        let result; let failErr = '';
        try {
          result = await callTool(tool.channel, r.args);
        } catch (e) {
          failErr = e.message || String(e);
          if (onCall) onCall({ ts: started, tool: name, source, ok: false, ms: Date.now() - started, err: failErr, ...summarizeArgsIn(params && params.arguments) });
          return toolText(id, true, `工具执行失败: ${failErr}`);
        }
        const businessError = !!(result && typeof result === 'object' && result.error);
        if (onCall) onCall({ ts: started, tool: name, source, ok: !businessError, ms: Date.now() - started, ...summarizeArgsIn(params && params.arguments) });
        return toolText(id, businessError, JSON.stringify(result === undefined ? null : result));
      }
```

顶部引入摘要函数 —— **必须复用 Task 1 的同一份实现**，否则「什么算敏感参数」
就有了第二套判据（本仓反漂移家法）：

```js
const { summarizeArgs } = require('./auditStore');
const summarizeArgsIn = (a) => summarizeArgs(a);
```

- [x] **Step 4: 契约与接线**

`src/shared/ipcContract.js` 在 `'mcp-set-config'` 那行下面加两行：

```js
  'mcp-audit':      { invoke: MAIN, args: [['opts', t.obj()]] },
  'mcp-audit-clear': { invoke: MAIN },
```

`src/main/ipc/mcp.js`：引入 `path`、`createAuditStore`、`AUDIT_FILE_NAME`；
模块级状态与工厂：

```js
let _audit = null;
let _rateLimited = 0;

function _auditStore() {
  if (_audit) return _audit;
  let dir = '';
  try { dir = require('electron').app.getPath('userData'); } catch (_e) { return null; }
  _audit = createAuditStore({ filePath: path.join(dir, AUDIT_FILE_NAME) });
  return _audit;
}
```

`_start()` 里把 handler 建出来时传入钩子，并把 server 的 `onRejected` 计数接上：

```js
  const handleMessage = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: _appVersion(),
    source: 'agent',
    onCall: (entry) => { const s = _auditStore(); if (s) s.record(entry).catch(() => {}); },
    callTool: async (channel, args) => { /* 原实现不动 */ },
  });

  _server = createMcpServer({
    token, handleMessage,
    onRejected: () => { _rateLimited += 1; },
  });
```

`_status()` 返回值加两项（渲染层设置页直接吃它，不再另开一条通道）：

```js
    auditCount: _audit ? _audit._cachedSize || 0 : 0,
    rateLimited: _rateLimited,
```

> 说明：`auditCount` 不每次读盘（状态行可能在切页时反复调用）。实现方式：
> `createAuditStore` 增一个每次写入后更新的 `_cachedSize`（Task 1 的 store
> 在 `record`/`clear` 成功分支里加 `this._cachedSize = list.length`）。若嫌隐晦，
> 改成 `_status()` 里 `auditCount` 直接省略、由 `mcp-audit` 的返回值给前端 —— 二者择一，
> 不许两处都算。**本计划取后者：`_status()` 不返回 `auditCount`，前端从 `mcp-audit` 取 `count`。**
> 因此上面这行改为：
> `rateLimited: _rateLimited,`

`register()` 里加两条：

```js
  handle('mcp-audit', async (_, opts) => {
    const store = _auditStore();
    if (!store) return { items: [], count: 0, maxEntries: 0, rateLimited: _rateLimited, error: '审计不可用（userData 未就绪）' };
    const items = await store.list({ limit: (opts && opts.limit) || 50 });
    return { items, count: await store.size(), maxEntries: store.maxEntries, rateLimited: _rateLimited };
  });

  handle('mcp-audit-clear', async () => {
    const store = _auditStore();
    if (!store) return { success: false, error: '审计不可用' };
    await store.clear();
    _rateLimited = 0;
    return { success: true };
  });
```

- [x] **Step 5: 写接线测试**

新建 `test/mcp-audit-wiring.test.js` —— 主进程模块 `ipc/mcp.js` 依赖 electron，
本仓既有做法是静态钉（不 mock electron）。钉三件事：钩子已接、契约已声明、
审计不落进云同步导出：

```js
/**
 * MCP 审计接线（静态守卫）
 *
 * ipc/mcp.js 依赖 electron，起不来真实现场，所以按本仓既有做法钉源码形状：
 * 漏接 onCall、漏声明契约、或者把审计文件塞进 WebDAV 导出，都会在这里变红 ——
 * 三者都是「实现完但没生效」的经典形态。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const MCP_IPC = read('src/main/ipc/mcp.js');
const CONTRACT = read('src/shared/ipcContract.js');
const CLOUD = read('src/main/ipc/cloudSync.js');
const AUDIT = read('src/main/mcp/auditStore.js');

test('createMcpHandler 收到 onCall，且摘要函数复用 auditStore（不许第二套判据）', () => {
  assert.match(MCP_IPC, /onCall:/, 'MCP 服务没接审计钩子 —— 审计文件永远为空');
  const core = read('src/main/mcp/mcpCore.js');
  assert.match(core, /require\('\.\/auditStore'\)/, '协议层没有复用 auditStore 的参数摘要');
  assert.ok(!/SENSITIVE_ARG_RE\s*=/.test(core), '协议层另写了一份敏感参数判据');
});

test('两条审计通道都在契约里，且 invoke 给 main', () => {
  for (const ch of ['mcp-audit', 'mcp-audit-clear']) {
    assert.match(CONTRACT, new RegExp(`'${ch}':\\s*\\{\\s*invoke:\\s*MAIN`), `${ch} 未声明进契约`);
    assert.match(MCP_IPC, new RegExp(`handle\\('${ch}'`), `${ch} 未注册 handler`);
  }
});

test('审计文件不进 WebDAV 快照/导出（可观测数据里含检索词，属本机隐私）', () => {
  assert.ok(!/mcp-audit/.test(CLOUD), 'cloudSync 里出现审计文件名 —— 它会被同步出去');
  assert.match(AUDIT, /SENSITIVE_ARG_RE/);
});

test('限流计数随 mcp-status 暴露给设置页', () => {
  assert.match(MCP_IPC, /rateLimited:\s*_rateLimited/);
  const statusIdx = MCP_IPC.indexOf('function _status()');
  assert.ok(statusIdx >= 0 && MCP_IPC.slice(statusIdx, statusIdx + 700).includes('rateLimited'));
});
```

- [x] **Step 6: 跑到绿**

Run: `node --test test/mcpCore.test.js test/mcp-audit-wiring.test.js test/ipc-contract.test.js`
Expected: 全 PASS。若 `test/ipc-contract.test.js` 要求「契约通道必须有 handler」，
本任务已同时补 `handle()`，不该红；红了就是漏注册。

- [x] **Step 7: 提交**

```bash
git add src/main/mcp/mcpCore.js src/main/ipc/mcp.js src/shared/ipcContract.js test/mcpCore.test.js test/mcp-audit-wiring.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(mcp): 协议层 onCall 审计钩子 + mcp-audit 契约通道 + 限流计数进状态"
```

---

### Task 4: 连接配置片段（一键接入外部 Agent）

**Files:**
- Create: `src/main/mcp/connectSnippet.js`
- Test: `test/mcp-connect-snippet.test.js`（新建）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `buildConnectSnippet({ port, token, serverName = 'lanyue' }) → { text: string, servers: string[] } | { error: string }`

- [x] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildConnectSnippet, CLIENT_TEMPLATES } = require('../src/main/mcp/connectSnippet');

test('片段是可直接粘贴的 JSON，含 url 与 Bearer 头', () => {
  const r = buildConnectSnippet({ port: 39217, token: 'abc123' });
  assert.ok(!r.error);
  const parsed = JSON.parse(r.text);
  assert.deepStrictEqual(parsed.mcpServers.lanyue, {
    url: 'http://127.0.0.1:39217/mcp',
    headers: { Authorization: 'Bearer abc123' },
  });
});

test('无令牌时不给片段：宁缺不造一个连不上的配置', () => {
  for (const bad of ['', undefined, null]) {
    const r = buildConnectSnippet({ port: 39217, token: bad });
    assert.strictEqual(r.error, '尚未生成访问令牌，请先点「启用服务」');
  }
});

test('端口非法同样拒绝（避免生成 127.0.0.1:NaN 这种配置）', () => {
  assert.ok(buildConnectSnippet({ port: 0, token: 'x' }).error);
  assert.ok(buildConnectSnippet({ port: 70000, token: 'x' }).error);
  assert.ok(buildConnectSnippet({ port: 'abc', token: 'x' }).error);
});

test('每张客户端模板都真的能被自己的片段喂饱（模板与片段同源）', () => {
  const r = buildConnectSnippet({ port: 39217, token: 'abc123' });
  for (const c of CLIENT_TEMPLATES) {
    assert.ok(r.text.includes('mcpServers'), `${c.id} 模板要求 mcpServers 键`);
    assert.ok(c.hint.length > 10, `${c.id} 模板要有落点说明`);
  }
  assert.ok(CLIENT_TEMPLATES.some(c => c.id === 'claude'), '至少覆盖 Claude 系');
  assert.ok(CLIENT_TEMPLATES.some(c => c.id === 'cursor'), '至少覆盖 Cursor');
});

test('serverName 可覆盖但必须过白名单字符（防注入到客户端配置里）', () => {
  assert.ok(JSON.parse(buildConnectSnippet({ port: 1, token: 'x', serverName: 'my_lanyue' }).text).mcpServers.my_lanyue);
  assert.ok(buildConnectSnippet({ port: 1, token: 'x', serverName: 'bad name/../x' }).error);
});
```

- [x] **Step 2: 跑到红**

Run: `node --test test/mcp-connect-snippet.test.js` → Cannot find module

- [x] **Step 3: 实现**

```js
/**
 * MCP 连接配置片段生成（纯函数）
 *
 * 为什么放在主进程侧而不是渲染层拼字符串：片段结构（url + Bearer 头 + mcpServers 键）
 * 是「揽乐作为被接入方」的契约的一部分，写错一个键名，用户的 Agent 就连不上，
 * 而渲染层没有任何测试能发现。这里可被 node --test 直接验证。
 *
 * 令牌来自 mcp-status（已加密存储、仅本机读取），片段只在渲染层临时展示与复制，
 * 不落任何盘 —— 令牌本身在设置页已可复制，复制片段不新增暴露面。
 */

'use strict';

const CLIENT_TEMPLATES = [
  { id: 'claude', label: 'Claude Desktop / Claude Code', hint: '粘贴进配置文件里的 mcpServers 段' },
  { id: 'cursor', label: 'Cursor', hint: '存成项目根目录的 .cursor/mcp.json' },
  { id: 'generic', label: '其它支持 MCP（Streamable HTTP）的客户端', hint: '找「添加 MCP Server / 自定义服务器」处粘贴' },
];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function buildConnectSnippet({ port, token, serverName = 'lanyue' }) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: '端口不合法' };
  if (!token) return { error: '尚未生成访问令牌，请先点「启用服务」' };
  if (!NAME_RE.test(String(serverName))) return { error: '服务名只允许字母数字与 -_' };
  const obj = {
    mcpServers: {
      [String(serverName)]: {
        url: `http://127.0.0.1:${p}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return { text: JSON.stringify(obj, null, 2), servers: CLIENT_TEMPLATES.map(c => c.id) };
}

module.exports = { buildConnectSnippet, CLIENT_TEMPLATES };
```

- [x] **Step 4: 跑到绿**

Run: `node --test test/mcp-connect-snippet.test.js`
Expected: PASS ×5

> 渲染层要用这个纯函数，须经 preload 暴露 ⇒ 在 `src/shared/ipcContract.js` 加
> `'mcp-connect-snippet': { invoke: MAIN }`，并在 `src/main/ipc/mcp.js` 注册：
> ```js
> handle('mcp-connect-snippet', () => {
>   const st = _status();
>   return buildConnectSnippet({ port: st.port, token: st.token });
> });
> ```
> 片段里含令牌，因此**不进日志、不进审计、不进云同步**；`test/mcp-audit-wiring.test.js`
> 已有的 cloudSync 钉不覆盖它，本任务在 wiring 测试里追加一条：
> ```js
> test('连接片段（含令牌）不进审计与云同步', () => {
>   assert.ok(!/mcp-connect-snippet/.test(CLOUD));
>   assert.ok(!/connectSnippet|buildConnectSnippet/.test(MCP_IPC.slice(MCP_IPC.indexOf('handle(\'mcp-audit\''))), '审计通道顺手返回片段会把令牌带进可观测面');
> });
> ```

- [x] **Step 5: 提交**

```bash
git add src/main/mcp/connectSnippet.js test/mcp-connect-snippet.test.js test/mcp-audit-wiring.test.js src/main/ipc/mcp.js src/shared/ipcContract.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(mcp): 连接配置片段生成 —— 接入外部 Agent 不再手抄 JSON"
```

---

### Task 5: 设置页升级（审计视图 + 片段复制 + 端口即时生效）

**Files:**
- Modify: `src/renderer/index.html:1227-1245`（MCP 卡片）
- Modify: `src/renderer/js/views/settings.js:1369-1411` 与 `:1570` 的 window 导出区
- Modify: `src/renderer/js/lang/zh.json`、`src/renderer/js/lang/zh.json` 对应 `en.json`

**Interfaces:**
- Consumes: IPC `mcp-status`（含 `rateLimited`）、`mcp-audit`、`mcp-audit-clear`、`mcp-connect-snippet`、`mcp-set-config`
- Produces: 渲染层函数 `loadMcpAudit()`、`copyMcpSnippet()`、`clearMcpAudit()`、`applyMcpPort()`，并挂到 `window`

- [x] **Step 1: 先补词典（两本都要，键名一致）**

`zh.json` 追加：

```json
  "settings.general.mcpStatusRunning": "运行中：{url}",
  "settings.general.mcpStatusPortBusy": "已设为开机自启，但当前未监听（端口占用？）",
  "settings.general.mcpStatusOff": "未启用",
  "settings.general.mcpSnippetLabel": "接入配置",
  "settings.general.mcpSnippetCopy": "复制配置",
  "settings.general.mcpSnippetHint": "把下面这段粘进支持 MCP 的助手（Claude / Cursor 等）即可让本机 Agent 驱动揽乐",
  "settings.general.mcpAuditTitle": "调用审计",
  "settings.general.mcpAuditHint": "记录本机 Agent 通过 MCP 做过的操作（{count} 条，最多留 {max} 条）。被限流 {rateLimited} 次",
  "settings.general.mcpAuditEmpty": "暂无调用记录",
  "settings.general.mcpAuditClear": "清空审计",
  "toast.mcpSnippetCopied": "接入配置已复制（含访问令牌，请勿外发）",
  "toast.mcpSnippetFailed": "复制失败：{msg}",
  "toast.mcpAuditCleared": "调用审计已清空",
  "toast.mcpPortApplied": "端口已应用"
```

`en.json` 追加对应英文（同键名），例如：

```json
  "settings.general.mcpSnippetCopy": "Copy config",
  "settings.general.mcpAuditTitle": "Call audit",
  "toast.mcpSnippetCopied": "Connection config copied (contains the token — do not share)"
```

- [x] **Step 2: 写门禁测试（先红）**

新建 `test/mcp-settings-ui.test.js`：

```js
/**
 * 设置页 MCP 卡片升级的静态守卫
 *
 * 三条钉：① 新入口都挂在 DOM 上且有 window 导出（漏一条 = 按钮点了没反应）；
 * ② 所有新文案走词典（settings.js 属 CONQUERED，欠账必须为 0）；
 * ③ 端口改动即时生效 —— 修掉既有缺陷：mcpPort 输入框没有 onchange，
 *    用户改完端口只点「启用服务」才应用，改完不点就等于没改。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('src/renderer/index.html');
const SETTINGS = read('src/renderer/js/views/settings.js');
const ZH = JSON.parse(read('src/renderer/js/lang/zh.json'));
const EN = JSON.parse(read('src/renderer/js/lang/en.json'));

test('新增宿主元素齐备且 id 唯一', () => {
  for (const id of ['mcpSnippetBox', 'mcpAuditList', 'mcpAuditLine', 'mcpPort']) {
    const n = (HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `id="${id}" 应恰好一处，实为 ${n}`);
  }
  assert.match(HTML, /onchange="applyMcpPort\(\)"/, '端口输入框没有即时生效入口');
});

test('四个新函数都定义了也都被挂上 window', () => {
  for (const fn of ['applyMcpPort', 'copyMcpSnippet', 'loadMcpAudit', 'clearMcpAudit']) {
    assert.match(SETTINGS, new RegExp(`function ${fn}\\(`), `${fn} 未定义`);
    assert.match(SETTINGS, new RegExp(`window\\.${fn} = ${fn};`), `${fn} 未挂 window，onclick 打不到`);
  }
});

test('设置页新代码不出现中文字面量（CONQUERED 欠账须为 0）', () => {
  const seg = SETTINGS.slice(SETTINGS.indexOf('// ── MCP 本地服务'), SETTINGS.indexOf('// ── 设置项搜索'));
  const bad = (seg.match(/['"`][^'"`\n]*[\u4e00-\u9fff][^'"`\n]*['"`]/g) || [])
    .filter(s => !/^\s*\/\//.test(s));
  assert.deepStrictEqual(bad, [], 'MCP 段落里出现中文字面量，应走 t():\n' + bad.join('\n'));
});

test('用到的词典键在两本词典里都存在（漏一本 = 英文界面显示键名）', () => {
  const keys = [...SETTINGS.matchAll(/t\('([^']+)'/g)].map(m => m[1])
    .concat([...HTML.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]));
  const missing = keys.filter(k => ZH[k] === undefined || EN[k] === undefined);
  assert.deepStrictEqual(missing, [], '缺键：' + missing.join(', '));
});

test('审计与片段走 IPC 而不是渲染层自己拼 JSON/读文件', () => {
  assert.match(SETTINGS, /invoke\('mcp-audit'/);
  assert.match(SETTINGS, /invoke\('mcp-audit-clear'/);
  assert.match(SETTINGS, /invoke\('mcp-connect-snippet'/);
});
```

- [x] **Step 3: 跑到红**

Run: `node --test test/mcp-settings-ui.test.js`
Expected: FAIL — 元素与函数都不存在

- [x] **Step 4: 改 HTML**

把 `src/renderer/index.html` 的 MCP 卡片（`:1227-1245`）里「本地端口」那行改成带 `onchange`，并在 `mcpHint` 行之后追加三段：

```html
            <div class="setting-row">
              <label class="setting-label" data-i18n="settings.general.mcpPortLabel">本地端口</label>
              <input class="setting-input" id="mcpPort" type="number" min="1" max="65535" onchange="applyMcpPort()">
            </div>
```

```html
            <div class="setting-row">
              <label class="setting-label" data-i18n="settings.general.mcpSnippetLabel">接入配置</label>
              <textarea class="setting-input setting-input--wide" id="mcpSnippetBox" rows="6" readonly spellcheck="false"></textarea>
            </div>
            <div class="setting-row setting-row--action">
              <button class="setting-btn" onclick="copyMcpSnippet()" data-i18n="settings.general.mcpSnippetCopy">复制配置</button>
              <span class="setting-hint" data-i18n="settings.general.mcpSnippetHint">把下面这段粘进支持 MCP 的助手（Claude / Cursor 等）即可让本机 Agent 驱动揽乐</span>
            </div>
            <div class="setting-row">
              <label class="setting-label" data-i18n="settings.general.mcpAuditTitle">调用审计</label>
              <span class="setting-hint" id="mcpAuditLine"></span>
            </div>
            <div class="setting-row">
              <pre class="setting-hint" id="mcpAuditList" style="max-height:160px;overflow:auto;margin:0;white-space:pre-wrap"></pre>
            </div>
            <div class="setting-row setting-row--action">
              <button class="setting-btn setting-btn--danger" onclick="clearMcpAudit()" data-i18n="settings.general.mcpAuditClear">清空审计</button>
            </div>
```

- [x] **Step 5: 改 settings.js**

在既有 MCP 段落里（`// ── MCP 本地服务（AI Agent 接入）` 之后）把 `loadMcpConfig` 的硬编码中文换成词典，并补四个函数：

```js
async function loadMcpConfig() {
  try {
    const st = await window.ipcRenderer.invoke('mcp-status');
    const portEl = document.getElementById('mcpPort');
    if (!portEl) return;
    _mcpRunning = !!st.running;
    portEl.value = st.port || '';
    const tokenEl = document.getElementById('mcpToken');
    tokenEl.value = st.token || t('settings.general.mcpTokenPlaceholder');
    tokenEl.readOnly = !!st.token;
    document.getElementById('mcpToggle').textContent = _mcpRunning
      ? t('settings.general.mcpStop') : t('settings.general.mcpStart');
    document.getElementById('mcpStatusLine').textContent = _mcpRunning
      ? t('settings.general.mcpStatusRunning', { url: st.url })
      : (st.enabled ? t('settings.general.mcpStatusPortBusy') : t('settings.general.mcpStatusOff'));
    await loadMcpSnippet();
    await loadMcpAudit();
  } catch (e) {
    logger.error('读取 MCP 状态失败:', e);
  }
}

async function loadMcpSnippet() {
  const box = document.getElementById('mcpSnippetBox');
  if (!box) return;
  try {
    const r = await window.ipcRenderer.invoke('mcp-connect-snippet');
    box.value = r && r.text ? r.text : '';
    box.placeholder = (r && r.error) || '';
  } catch (e) {
    box.value = '';
  }
}

async function loadMcpAudit() {
  const line = document.getElementById('mcpAuditLine');
  const list = document.getElementById('mcpAuditList');
  if (!line || !list) return;
  try {
    const r = await window.ipcRenderer.invoke('mcp-audit', { limit: 20 });
    const items = (r && r.items) || [];
    line.textContent = t('settings.general.mcpAuditHint', {
      count: (r && r.count) || 0, max: (r && r.maxEntries) || 0, rateLimited: (r && r.rateLimited) || 0,
    });
    // 审计文本里含用户检索词与外部 Agent 传入的任意字符串 → 必须走 escQ，
    // 否则设置页成为一个「外部进程往主窗口塞 HTML」的入口（本仓 esc/askConfirm 同族教训）
    list.textContent = items.length
      ? items.map(i => `${new Date(i.ts).toLocaleString()}  ${i.tool}  ${i.ok ? 'OK' : 'FAIL'}${i.summary ? `  ${i.summary}` : ''}${i.err ? `  ${i.err}` : ''}`).join('\n')
      : t('settings.general.mcpAuditEmpty');
  } catch (e) {
    line.textContent = t('settings.general.mcpAuditEmpty');
    list.textContent = '';
  }
}

async function applyMcpPort() {
  await _applyMcpConfig({});
  showToast(t('toast.mcpPortApplied'), 'success', 2000);
}

async function copyMcpSnippet() {
  const box = document.getElementById('mcpSnippetBox');
  if (!box || !box.value) { showToast(t('toast.mcpFailed', { msg: t('settings.general.mcpStatusOff') }), 'error'); return; }
  try {
    await navigator.clipboard.writeText(box.value);
    showToast(t('toast.mcpSnippetCopied'), 'warn', 5000);
  } catch (e) {
    showToast(t('toast.mcpSnippetFailed', { msg: errBrief(e) }), 'error');
  }
}

async function clearMcpAudit() {
  if (!await askConfirm(t('settings.general.mcpAuditClear'))) return;
  const r = await window.ipcRenderer.invoke('mcp-audit-clear');
  if (r && r.success) { showToast(t('toast.mcpAuditCleared'), 'success', 2500); await loadMcpAudit(); }
  else showToast(t('toast.mcpFailed', { msg: (r && r.error) || '' }), 'error');
}
```

`loadMcpConfig` 里用到的 `settings.general.mcpStart/mcpStop/mcpTokenPlaceholder` 若词典还没有，一并在 Step 1 补（同一判据：两本都要）。
window 导出区（`:1570` 附近）加：

```js
window.applyMcpPort = applyMcpPort;
window.copyMcpSnippet = copyMcpSnippet;
window.clearMcpAudit = clearMcpAudit;
```

（`loadMcpAudit` 不需 onclick，但测试钉的是「定义了就要挂 window」——若坚持不挂，
则把该测试的这四元组改成三个 + 单独把 `loadMcpAudit` 列为内部函数。取前者：一致性优先。）

- [x] **Step 6: 跑到绿**

Run: `node --test test/mcp-settings-ui.test.js test/toast-i18n.test.js test/i18n-complete.test.js 2>/dev/null || node --test test/mcp-settings-ui.test.js test/toast-i18n.test.js`
Expected: 全 PASS；若本仓有 i18n 键完整性测试（`grep -l "en.json" test/*.test.js` 找名字），一并跑

- [x] **Step 7: 提交**

```bash
git add src/renderer/index.html src/renderer/js/views/settings.js src/renderer/js/lang/zh.json src/renderer/js/lang/en.json test/mcp-settings-ui.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(settings): MCP 卡片升级 —— 接入配置一键复制 + 调用审计面板 + 端口即时生效"
```

---

### Task 6: 端到端调用测试（当前完全缺失的一层）

**Files:**
- Test: `test/mcp-e2e.test.js`（新建）

**Interfaces:**
- Consumes: `createMcpServer`（Task 2）、`createMcpHandler`（Task 3）、`toolsFromContract`（既有）、`createAuditStore`（Task 1）
- Produces: 无（纯测试）

- [x] **Step 1: 写测试**

```js
/**
 * MCP 端到端：真 HTTP + 真协议层 + 真工具表，只有最底层的 callTool 是假的
 *
 * 为什么这一层非补不可：mcpServer.test.js 用假 handleMessage 只测鉴权壳，
 * mcpCore.test.js 直接调 handler 不经过 HTTP —— 两层各自绿着，但**从未有一次测试
 * 走完 tools/list → tools/call → 参数钳制 → 审计落盘**这条真实通路。
 * 17 个工具的名字、契约参数、审计字段任何一处对不上，今天都没有地方会红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMcpServer } = require('../src/main/mcp/mcpServer');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');
const { toolsFromContract } = require('../src/main/mcp/tools');
const { createAuditStore, summarizeArgs } = require('../src/main/mcp/auditStore');

const TOKEN = 'e2e-token-0123456789abcdef';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-e2e-'));
  const audit = createAuditStore({ filePath: path.join(dir, 'mcp-audit.json') });
  const seen = [];
  const handler = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: '1.0.36',
    source: 'agent',
    onCall: async (e) => { seen.push(e); await audit.record(e); },
    callTool: async (channel, args) => {
      seen.push({ channel, args });
      if (channel === 'search-music') return { songs: [{ id: '1', title: '双截棍' }] };
      if (channel === 'get-lyrics') return { error: '该源无歌词' };
      throw new Error(`未注册通道: ${channel}`);
    },
  });
  const server = createMcpServer({ token: TOKEN, handleMessage: handler, onRejected: () => {} });
  const { port } = await server.start(0);
  return { url: `http://127.0.0.1:${port}/mcp`, stop: server.stop, audit, seen, dir };
}

const rpc = (url, id, method, params) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('e2e: initialize → tools/list 拿到 17 个工具，且不外泄内部 channel 字段', async () => {
  const h = await boot();
  try {
    const i = await rpc(h.url, 1, 'initialize', { protocolVersion: '2025-03-26' });
    assert.strictEqual(i.status, 200);
    assert.strictEqual(i.body.result.serverInfo.name, 'musicdl');
    const l = await rpc(h.url, 2, 'tools/list', {});
    const tools = l.body.result.tools;
    assert.strictEqual(tools.length, 17, '工具数量变了 —— 白名单动过就把这条钉同步');
    assert.ok(tools.every(t => !('channel' in t)), 'channel 属内部字段，绝不能出现在 tools/list');
    assert.ok(tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
  } finally { await h.stop(); }
});

test('e2e: tools/call 成功 → 结果 JSON、isError=false、审计落盘一条', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 3, 'tools/call', { name: 'search_music', arguments: { keyword: '周杰伦', source: 'all', page: 1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.result.isError, false);
    assert.match(r.body.result.content[0].text, /双截棍/);
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].tool, 'search_music');
    assert.strictEqual(items[0].ok, true);
    assert.strictEqual(items[0].summary, '周杰伦');
  } finally { await h.stop(); }
});

test('e2e: 业务失败按 isError 回文本（Agent 能续对话），审计记 ok=false + err', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 4, 'tools/call', { name: 'get_lyrics', arguments: { id: '9' } });
    assert.strictEqual(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /该源无歌词/);
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items[0].ok, false);
  } finally { await h.stop(); }
});

test('e2e: 参数钳制走契约 —— 超长 keyword 被截断而不是原样落到 handler', async () => {
  const h = await boot();
  try {
    await rpc(h.url, 5, 'tools/call', { name: 'search_music', arguments: { keyword: 'x'.repeat(5000) } });
    const call = h.seen.find(s => s.channel);
    assert.ok(call.args[0].length <= 200, `契约里 keyword 是 t.str(200)，实到 ${call.args[0].length}`);
  } finally { await h.stop(); }
});

test('e2e: 洪水调用触发 429，之后恢复；审计里不会留下伪造的成功记录', async () => {
  const h = await boot();
  try {
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(h.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'ping', params: {} }),
      });
      if (res.status === 429) rejected += 1;
    }
    assert.ok(rejected >= 1, `默认容量 120/秒，200 次连打应有拒绝，实为 ${rejected}`);
    assert.strictEqual((await h.audit.list({ limit: 10 })).length, 0, 'ping 不进审计');
    const ok = await rpc(h.url, 999, 'ping', {});
    assert.ok(ok.status === 200 || ok.status === 429);
  } finally { await h.stop(); }
});

test('e2e: 摘要判据与协议层用的是同一份（防第二套敏感参数规则）', () => {
  const s = summarizeArgs({ aiMusicApiKey: 'mk-xxx', keyword: '夜跑' });
  assert.strictEqual(s.summary, '夜跑');
  assert.ok(!JSON.stringify(s).includes('mk-xxx'));
});
```

- [x] **Step 2: 跑到绿（并按需修实现）**

Run: `node --test test/mcp-e2e.test.js`
Expected: 全 PASS。若 `tools/list` 数量不是 17，先 `git diff src/main/mcp/tools.js` 确认白名单**没有**被本程序意外改动（红线：不扩面），再把数字钉成实际值。

- [x] **Step 3: 全量门禁**

Run: `npm run lint && npm run audit:deps && npm run check:dead-deps && node --test --test-concurrency=2 "test/*.test.js" && npm run build && npm run smoke:asar`
Expected: `ℹ fail 0` + build/asar 冒烟全 PASS

- [x] **Step 4: 提交**

```bash
git add test/mcp-e2e.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "test(mcp): 端到端调用链测试 —— tools/list→call→契约钳制→审计落盘+限流，此前两层各自绿着无人走过全链"
```

---

### Task 7: 文档与变更记录同步

**Files:**
- Modify: `SECURITY.md`（§4「本地服务无速率限制」）
- Modify: `README.md:9`、`README.md:44`
- Modify: `CHANGELOG.md`（`## [未发布]` 一节）

**Interfaces:**
- Consumes: 前 6 个任务的实现事实
- Produces: 无代码接口

- [x] **Step 1: 改写 SECURITY.md §4**

现状（`SECURITY.md` §4）：「MCP 服务只靠 Bearer 令牌与 Origin 白名单防误触，没有请求频率限制。」
改为事实描述，并新增一小节「本地服务调用审计」说明：审计文件 `userData/mcp-audit.json`
滚动 200 条、敏感参数只留键名、不进 WebDAV 快照与导出、可在设置页查看与清空。
限流数字要写实际默认值（capacity 120 / refillPerSec 30）与超限响应码 429。
**不要**把它写成「风险已消除」：令牌仍在明文可读的加密存储里、绑定回环只挡局域网，
限流只是把「一个坏客户端写满磁盘/刷爆队列」降级为「短时不可用」。

- [x] **Step 2: README 两处**

`:9` 的行尾「（见设置页，默认关闭）」之后补：「，含调用审计与一键接入配置」；
`:44` 的 🤖 条目补上「令牌桶限流 + 本机调用审计」。数字口径（17 个工具）保持与
`tools.js` 一致 —— 若 Task 6 里工具数变了，两处都要改。

- [x] **Step 3: CHANGELOG 追加（进 `## [未发布]`，别动 1.0.36）**

```markdown
## [未发布]

### 新增
- **AI Agent 接入（MCP）一等公民化**：设置页现在能一键生成 Claude / Cursor 等客户端的
  接入配置片段并复制；新增**调用审计**面板，记录本机 Agent 通过 MCP 做过的每一次
  操作（工具名、耗时、成败、检索词摘要），可查可清空。密钥/令牌/Cookie 类参数
  只记键名不落盘。
- **MCP 请求频率限制**：令牌桶（默认突发 120、稳态 30/秒），超限返回 429 + `Retry-After`。
  此前 SECURITY.md 记为「无速率限制」的已知边界就此闭合（不是风险消除：仍需先拿到令牌）。

### 修复
- **设置页改端口不生效**：端口输入框没有应用入口，改完不点「启用服务」就等于没改；
  现在改动即时应用。
```

- [x] **Step 4: 提交并推 main**

```bash
git add SECURITY.md README.md CHANGELOG.md
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "docs(mcp): SECURITY/README/CHANGELOG 同步 —— 限流闭合、审计面与接入片段写明"
git -c http.proxy= -c https.proxy= push origin HEAD:main
```

推送后确认 CI 绿（`windows-latest` 五层）：
`curl -s -H "Authorization: Bearer $TOK" https://api.github.com/repos/maliang04110233-dot/Lanyue/actions/runs?per_page=3`

---

## Self-Review 记录

- **覆盖**：用户选项「MCP 一等公民化 + 调用审计」的三个承诺（审计、限流、一键接入）
  分别落在 Task 1/3/6（审计）、Task 2（限流 + SECURITY §4 闭合）、Task 4/5（接入片段）；
  「目前没有端到端测试」这一事实由 Task 6 补上。文档同步在 Task 7。
- **未纳入本轨道**（留给轨道 2，避免边界模糊）：助手如何复用工具表、`source: 'assistant'`
  的写入方 —— 本计划只保证 `onCall` 与 `entry.source` 形状允许它。
- **已知取舍**：`_status()` 不返回 `auditCount`（避免每次状态查询读盘），计数由
  `mcp-audit` 返回；`copyMcpSnippet` 复制到的是含令牌的配置，这是接入的必要条件，
  因此 toast 文案明确警告勿外发。
