# 应用内 AI 助手（轨道二）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在揽乐里加一个「AI 助手」页：用户说人话，LLM 选择并调用**本应用已经暴露给外部 Agent 的那 17 个工具**完成任务（找歌、加队列、加歌单、红心……），写操作逐条人工确认，每一次调用都进同一份 MCP 审计。

**Architecture:** LLM 回合留在主进程（沿用 `src/api/ai-music.js` 现成的 MiniMax 传输层与 `prefs.aiMusicApiKey`），**编排循环放在渲染层** —— 只有 UI 拿得到确认框，把确认协议做进主进程↔渲染层的往返是凭空多一层。工具执行复用 `createMcpHandler({ source: 'assistant' })`：参数钳制、错误语义、审计形状与外部 Agent 完全同一条码，助手不是第二套执行面。

**Tech Stack:** 零新依赖（`node:http` 客户端 + 原生 DOM + `node --test`）。

**Spec:** `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`（程序级约束与四轨划分）；轨道一已落地的事实在 `docs/superpowers/plans/2026-10-14-mcp-first-class.md`。

## Global Constraints

- `FEATURES.ai` 必须保持 `false`（`src/renderer/js/features.js:14`，被 `test/ai-feature-flag.test.js:33` 钉死）。助手**不挂** `data-feature`，也不进 `TAB_FEATURES` —— 它的可用性取决于「配没配 API Key」，与 `nl-search-music` 同源（应用内 AI 搜索在 AI 创作关着的情况下照用）。
- 工具白名单不扩：cookie/登录、文件路径读写、set-pref、对话框、更新安装一律不进（红线依据 `docs/archive/AI_MUSIC_RESEARCH_2026-09-19.md:66`）。助手只能用那 17 个，多一个都要先改白名单再改代码。
- 令牌 / API Key / Cookie 绝不进日志、审计、云同步。审计的敏感参数判据只有 `auditStore.js` 一份实现，任何新调用面必须复用它。
- 计费 LLM 调用禁自动重试：`request(..., { retries: 0 })`。
- 渲染层新文件从出生起零硬编码中文反馈文案：加入 `test/toast-i18n.test.js` 的 `CONQUERED` 与 `CONQUERED_VIEWS` 两张表，取词走 `import { t } from '../i18n.js'`，键必须中英齐备且 `{占位符}` 同集合。
- 五层闸门每次提交前全跑：`npm run lint`（0 error，2 条既有 warning 可留）→ `npm run audit:deps` → `npm run check:dead-deps` → `node --test --test-concurrency=2 "test/*.test.js"` → `npm run build && npm run smoke:asar`。
- 提交一律 `git -c user.name=CodeBuddy -c user.email=codebuddy@local commit`；推送 `git -c http.proxy= -c https.proxy= push origin HEAD:main`。
- 文档与测试里不得出现「增量NNN」式编号（`test/no-increment-numbering.test.js` 连文档一起扫），要引用历史就用 7 位 git short hash。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/main/mcp/tools.js` | 工具白名单 + 「哪个工具是写操作」的唯一登记表 | Modify |
| `src/main/mcp/auditSink.js` | 审计落点（userData 定位 + 单例 + fire-and-forget 写） | Create |
| `src/main/mcp/agentBridge.js` | 「AI 调用方如何在本进程执行一个白名单工具」的唯一实现 | Create |
| `src/main/ipc/mcp.js` | 外部 Agent 的 HTTP 服务接线（改为复用上面两个模块） | Modify |
| `src/main/ipc/ai-assistant.js` | 助手侧三个通道：目录 / 回合 / 单步执行（含确认硬门） | Create |
| `src/shared/ipcContract.js` | 三条新通道的参数规格 | Modify |
| `src/api/ai-music.js` | MiniMax 客户端：新增 `assistantChat()` | Modify |
| `src/api/services/aiAssistantService.js` | 纯编排：系统提示、容错解析、历史裁剪、回合函数 | Create |
| `src/renderer/js/views/ai-assistant.js` | 循环 + 确认 + 渲染（视图模块，自挂 window 导出） | Create |
| `src/renderer/index.html` | 侧栏入口 + 页面骨架 | Modify |
| `src/renderer/js/app.js` | `switchTab` 认得新页面 | Modify |
| `src/renderer/styles/content.css` | 助手页样式（页面级，非弹层） | Modify |
| `src/renderer/js/lang/zh.json` / `en.json` | 全部文案 | Modify |
| `test/*.test.js` | 见各任务 | Create/Modify |

---

### Task 1: 工具面登记「写操作」

**Files:**
- Modify: `src/main/mcp/tools.js`（三个动作工具加 `mutating: true`；导出 `MUTATING_TOOL_NAMES`；`toolsFromContract` 透传该字段）
- Test: `test/mcp-tools-mutating.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `AGENT_TOOLS[i].mutating?: boolean`、`MUTATING_TOOL_NAMES: Set<string>`、`toolsFromContract()` 输出项多出 `mutating: boolean` 字段（`mcpCore` 的 `publicTools` 只取 `{name, description, inputSchema}`，因此**不会**外泄给 `tools/list`）。Task 3 的确认闸门与 Task 5 的渲染层都读这个字段。

- [x] **Step 1: 写失败的测试**

新建 `test/mcp-tools-mutating.test.js`：

```js
/**
 * 「哪些工具是写操作」的登记表
 *
 * 助手（轨道二）与外部 Agent（轨道一）共用同一张工具表白名单，但助手多一条规矩：
 * 写操作必须用户点过确认才放行。这条规矩的地基是「 mutating 标记」，
 * 所以它必须在**工具表**里，而不是在助手里另写一份工具名清单 ——
 * 两份清单迟早漂移成「助手以为要确认、其实不用」或反过来。
 */
const test = require('node:test');
const assert = require('node:assert');

const { AGENT_TOOLS, MUTATING_TOOL_NAMES, toolsFromContract } = require('../src/main/mcp/tools');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');

// 这三个是红线内侧仅有的「会让外部世界发生变化」的动作，增删都要先想清楚
const EXPECTED = ['add_to_queue', 'add_to_playlist', 'toggle_favorite'];

test('mutating 标记恰好覆盖三个写操作，且都真的在白名单里', () => {
  assert.deepStrictEqual([...MUTATING_TOOL_NAMES].sort(), EXPECTED.slice().sort());
  const flagged = AGENT_TOOLS.filter(t => t.mutating).map(t => t.name).sort();
  assert.deepStrictEqual(flagged, EXPECTED.slice().sort(), '标记与集合必须是同一份事实');
  for (const n of EXPECTED) {
    assert.ok(AGENT_TOOLS.some(t => t.name === n), `${n} 不在白名单里却被标成写操作`);
  }
  // 查询类一律不得标 mutating：标了就是给助手凭空加确认负担，也说明登记表漂了
  for (const t of AGENT_TOOLS) {
    if (!EXPECTED.includes(t.name)) assert.ok(!t.mutating, `${t.name} 不该被标为写操作`);
  }
});

test('toolsFromContract 透传 mutating（渲染层与主进程读同一份，不各写一份清单）', () => {
  const tools = toolsFromContract();
  assert.strictEqual(tools.find(t => t.name === 'search_music').mutating, false);
  assert.strictEqual(tools.find(t => t.name === 'add_to_queue').mutating, true);
});

test('mutating 不外泄给 MCP tools/list（协议面只有 name/description/inputSchema）', async () => {
  const handle = createMcpHandler({
    tools: toolsFromContract(), serverVersion: '1.0.0', callTool: async () => ({}),
  });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  for (const t of r.result.tools) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'],
      `工具面多返回了字段: ${Object.keys(t)}`);
  }
});
```

- [x] **Step 2: 跑测试确认它失败**

Run: `node --test test/mcp-tools-mutating.test.js`
Expected: FAIL —— `MUTATING_TOOL_NAMES` 是 undefined（`toolsFromContract` 那枚还会报 `find(...).mutating` 读不到）。

- [x] **Step 3: 实现**

`src/main/mcp/tools.js`：给三个动作工具各加一行 `mutating: true`（放在 `paramDocs` 之前，与 `required` 同级）：

```js
  {
    name: 'add_to_queue', channel: 'add-to-queue',
    description: '把一首歌加入下载队列（song 对象直接传 search_music 的结果项）。',
    required: ['song'],
    mutating: true,
    paramDocs: { song: '搜索结果里的歌曲对象（需含 id/source/title/artist）' },
  },
```

`add_to_playlist`、`toggle_favorite` 同样加 `mutating: true`。文件末尾导出区改为：

```js
const MUTATING_TOOL_NAMES = new Set(AGENT_TOOLS.filter(t => t.mutating).map(t => t.name));

module.exports = { AGENT_TOOLS, MUTATING_TOOL_NAMES, TOOLS_VERSION_HINT: '2025-03-26', toolsFromContract, specToJsonSchema };
```

`toolsFromContract` 里 `const tdef = {` 那一块加一行（紧跟 `channel: tool.channel`）：

```js
      channel: tool.channel,
      mutating: tool.mutating === true,
```

头部注释的设计段补一句（说明为什么这个标记长在工具表上）：

```
 *   - mutating 标记：会改变外部世界（入队/改歌单/收藏）的动作。助手在执行前
 *     必须拿到用户确认（轨道二），外部 Agent 靠白名单本身兜着。
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/mcp-tools-mutating.test.js test/mcp-e2e.test.js test/mcpCore.test.js`
Expected: 全绿 —— `mcp-e2e` 里那枚「不外泄 channel」的断言仍成立（`mutating` 同样被 `publicTools` 剔除）。

- [x] **Step 5: 提交**

```bash
git add src/main/mcp/tools.js test/mcp-tools-mutating.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(mcp): 工具表白名单登记哪三个是写操作 —— 助手的确认闸门要读它，不能在界面侧另攒一份"
```

---

### Task 2: 审计落点与进程内执行抽成共享模块

**Files:**
- Create: `src/main/mcp/auditSink.js`
- Create: `src/main/mcp/agentBridge.js`
- Modify: `src/main/ipc/mcp.js`（删掉本地 store 单例与本地 `callTool`，改为复用）
- Modify: `test/mcp-audit-wiring.test.js`（`onCall` 的家搬了，静态钉跟着搬）
- Test: `test/mcp-agent-bridge.test.js`（新建）

**Interfaces:**
- Consumes: `createAuditStore`/`AUDIT_FILE_NAME`（`auditStore.js`）、`createMcpHandler`（`mcpCore.js`）、`toolsFromContract`（`tools.js`）、`getInvokeHandler`（`src/main/ipc/register.js`）
- Produces: `auditSink.store() → AuditStore|null`、`auditSink.record(entry) → Promise<void>`、`auditSink._setUserDataDirForTest(dir)`；`agentBridge.createAgentBridge({ source, serverVersion?, onCall? }) → handle(msg)`、`agentBridge.callTool(channel, args)`。Task 3 用 `createAgentBridge({ source:'assistant' })`，`ipc/mcp.js` 用 `createAgentBridge({ source:'agent' })`。

- [x] **Step 1: 写失败的测试**

新建 `test/mcp-agent-bridge.test.js`：

```js
/**
 * AI 调用方的「进程内执行面」只许有一个家
 *
 * 外部 Agent（HTTP）与应用内助手（IPC）跑的是同一批工具、同一套契约钳制、
 * 同一份审计。如果两边各自 require 一遍 createMcpHandler 并各自写 callTool，
 * 就会出现「改了一边、另一边静默失效」的经典漂移（例如助手侧忘了接审计）。
 * 本文件钉住：桥 = 唯一装配点；审计默认自动挂上；两个 source 都落进同一个文件。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentBridge } = require('../src/main/mcp/agentBridge');
const auditSink = require('../src/main/mcp/auditSink');

test('桥默认自动接审计：不传 onCall 也会落盘，且 source 原样写进入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  auditSink._setUserDataDirForTest(dir);
  const handle = createAgentBridge({ source: 'assistant' });
  // search_music 是查询类，用假 callTool 免触网
  const r = await handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_music', arguments: { keyword: '夜跑' } },
  });
  assert.ok(r.result, JSON.stringify(r));
  const items = await auditSink.store().list({ limit: 10 });
  assert.strictEqual(items.length, 1, '审计没落到共享落点');
  assert.strictEqual(items[0].source, 'assistant');
  assert.strictEqual(items[0].tool, 'search_music');
});

test('显式 onCall 覆盖默认落点（HTTP 层要数限流，得自己挂）', async () => {
  const seen = [];
  const handle = createAgentBridge({ source: 'agent', onCall: (e) => seen.push(e) });
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'history_stats' } });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].source, 'agent');
});

test('未知工具在桥这一层就是 isError，不会漂到 callTool 里', async () => {
  const handle = createAgentBridge({ source: 'assistant', onCall: () => {} });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } });
  assert.strictEqual(r.error.code, -32602);
});

test('装配点唯一：ipc/mcp.js 不得再自己攒一份 createMcpHandler / createAuditStore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'mcp.js'), 'utf8');
  assert.ok(!/createMcpHandler\(/.test(src), 'HTTP 侧应改用 createAgentBridge');
  assert.ok(!/createAuditStore\(/.test(src), '审计单例的家是 auditSink');
  assert.match(src, /createAgentBridge\(\{[\s\S]{0,200}source:\s*'agent'/, 'HTTP 侧没走桥');
});
```

- [x] **Step 2: 跑测试确认它失败**

Run: `node --test test/mcp-agent-bridge.test.js`
Expected: FAIL —— `Cannot find module '../src/main/mcp/agentBridge'`。

- [x] **Step 3: 建 `src/main/mcp/auditSink.js`**

```js
/**
 * 审计落点（userData 里的那一个文件）
 *
 * 「谁在写审计」有两个 caller（HTTP Agent、应用内助手），「审计存在哪」只有一个答案。
 * 定位、单例、写盘失败不影响调用这三件事都住在这里：caller 只管 record(entry)。
 *
 * userData 在 app ready 之前取不到：此时 store() 返回 null、record() 静默跳过，
 * 服务照跑（可观测性不该变成可用性前置条件），下次调用再试一次。
 */

const path = require('path');
const logger = require('../../utils/logger');
const { createAuditStore, AUDIT_FILE_NAME } = require('./auditStore');

let _dirOverride = '';
let _store = null;
let _storePath = '';

function _userDataDir() {
  if (_dirOverride) return _dirOverride;
  try { return require('electron').app.getPath('userData'); } catch (_e) { return ''; }
}

function store() {
  const dir = _userDataDir();
  if (!dir) return null;
  const filePath = path.join(dir, AUDIT_FILE_NAME);
  if (_store && _storePath === filePath) return _store;
  _storePath = filePath;
  _store = createAuditStore({ filePath });
  return _store;
}

/** 审计是可观测性，绝不影响调用结果：写盘失败（磁盘满、权限）只记一条 warn */
function record(entry) {
  const s = store();
  if (!s) return Promise.resolve();
  return s.record(entry).catch((e) => logger.warn('[mcp] 审计写入失败:', e));
}

function _setUserDataDirForTest(dir) {
  _dirOverride = dir || '';
  _store = null;
  _storePath = '';
}

module.exports = { store, record, AUDIT_FILE_NAME, _setUserDataDirForTest };
```

- [x] **Step 4: 建 `src/main/mcp/agentBridge.js`**

```js
/**
 * AI 调用方的进程内执行面（外部 Agent 与应用内助手共用）
 *
 * 一个桥 = 工具白名单 + 契约钳制 + 审计 + 「落到主进程 handler」四件事的装配点。
 * 装配只有一处，两个 caller 就不可能漂成两套规矩（助手的参数钳制比外部 Agent
 * 松、或者助手不写审计，都是这类漂移的实锤形态）。
 *
 * callTool 的 event 传 null：白名单里的 handler 均不依赖 sender（依赖 sender 的
 * 通道不进白名单，这条纪律由 test/ai-assistant-gate.test.js 的白名单钉兜住）。
 */

const { getInvokeHandler } = require('../ipc/register');
const { createMcpHandler } = require('./mcpCore');
const { toolsFromContract } = require('./tools');
const auditSink = require('./auditSink');

async function callTool(channel, args) {
  const fn = getInvokeHandler(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args);
}

/**
 * @param {Object} deps
 * @param {'agent'|'assistant'} deps.source 调用方身份，写进审计
 * @param {string} [deps.serverVersion]
 * @param {(entry:Object)=>void} [deps.onCall] 覆盖默认落点（HTTP 层要顺手数限流）
 */
function createAgentBridge({ source, serverVersion = '0.0.0', onCall = null }) {
  return createMcpHandler({
    tools: toolsFromContract(),
    callTool,
    source,
    serverVersion,
    onCall: onCall || ((entry) => { auditSink.record(entry); }),
  });
}

module.exports = { createAgentBridge, callTool };
```

- [x] **Step 5: `src/main/ipc/mcp.js` 改为复用**

删除 `const path = require('path');`、`const { createAuditStore, AUDIT_FILE_NAME } = require('../mcp/auditStore');` 两处 require（`path` 若别处未用就一并删），加上：

```js
const { createAgentBridge } = require('../mcp/agentBridge');
const auditSink = require('../mcp/auditSink');
```

`_auditStore()` 整个函数换成一行委托（保留函数名：`mcp-audit` / `mcp-audit-clear` 两个 handler 与既有测试都通过它取 store）：

```js
/** 审计的家在 auditSink；这里只是本模块的读取口 */
function _auditStore() {
  return auditSink.store();
}
```

`_start()` 里 `const handleMessage = createMcpHandler({ ... });` 整块（含 `tools`/`source`/`serverVersion`/`onCall`/`callTool` 五项）换成：

```js
  const handleMessage = createAgentBridge({
    source: 'agent',
    serverVersion: (() => {
      try { return require('electron').app.getVersion(); } catch (_e) { return '0.0.0'; }
    })(),
  });
```

`createMcpHandler` 的 require 也随之删掉（`mcpCore` 不再被本模块直接引用），`./register` 的 `getInvokeHandler` 也一并去掉（callTool 的家搬进桥了）。
限流拒绝的计数不在这里：`onRejected` 仍挂在 `createMcpServer({...})` 上，与审计回调互不相干。

- [x] **Step 6: 搬 `test/mcp-audit-wiring.test.js` 的第一枚钉**

`onCall` 的家从 `ipc/mcp.js` 搬到 `agentBridge.js`，第一枚测试改成：

```js
test('桥是审计的装配点：默认落盘 + 摘要判据复用 auditStore（不许第二套判据）', () => {
  const bridge = read('src/main/mcp/agentBridge.js');
  assert.match(bridge, /auditSink\.record/, '桥没把调用接到审计落点 —— 审计文件永远为空');
  assert.match(bridge, /source,/ , '桥没把调用方身份传给协议层');
  const core = read('src/main/mcp/mcpCore.js');
  assert.match(core, /require\('\.\/auditStore'\)/, '协议层没有复用 auditStore 的参数摘要');
  assert.ok(!/SENSITIVE_ARG_RE\s*=/.test(core), '协议层另写了一份敏感参数判据');
});
```

其余四枚不动（契约声明、云同步、限流计数、片段不外泄仍然在 `ipc/mcp.js` 里）。

- [x] **Step 7: 跑测试确认通过**

Run: `node --test test/mcp-agent-bridge.test.js test/mcp-audit-wiring.test.js test/mcp-audit-store.test.js test/mcp-e2e.test.js`
Expected: 全绿。

- [x] **Step 8: 提交**

```bash
git add src/main/mcp/auditSink.js src/main/mcp/agentBridge.js src/main/ipc/mcp.js test/mcp-agent-bridge.test.js test/mcp-audit-wiring.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "refactor(mcp): 审计落点与进程内执行面抽成共享模块 —— 助手要接的是同一份，不能各攒各的"
```

---

### Task 3: 助手侧三个通道 + 确认闸门长在契约层

**Files:**
- Modify: `src/shared/ipcContract.js`（MCP 区块加 3 条 invoke）
- Create: `src/main/ipc/ai-assistant.js`
- Modify: `src/main/index.js:39`（require）与 `:758` 之后（register）
- Modify: `test/ipc-contract.test.js:99`（`MAIN_INVOKE.size` 105 → 108）
- Test: `test/ai-assistant-gate.test.js`（新建）

**Interfaces:**
- Consumes: `createAgentBridge`（Task 2）、`toolsFromContract`/`MUTATING_TOOL_NAMES`（Task 1）
- Produces: 契约通道 `ai-assistant-tools` → `{tools:[{name,description,mutating}]}`；`ai-assistant-plan`（Task 4 才实现 handler 体，本任务先落 `ai-assistant-tools` 与 `ai-assistant-tool-call`）；`ai-assistant-tool-call(name, args, confirmed)` → `{ok, text, isError, error?}`，错误码是 ASCII 令牌 `UNKNOWN_TOOL` / `NEED_CONFIRM`（**不是中文句子** —— 文案的家在渲染层词典）。Task 5 的渲染层消费这三条。

- [x] **Step 1: 写失败的测试**

新建 `test/ai-assistant-gate.test.js`：

```js
/**
 * 助手的确认闸门与白名单（静态 + 半真跑）
 *
 * 「写操作要先问用户」如果只长在界面上，就等于没长：任何绕过界面的调用方
 * （以后新增的快捷键、命令面板、或者助手自己拼的 invoke）都能不确认就改歌单。
 * 所以闸门在主进程的 handler 上，且确认状态是**参数**（confirmed === true），
 * 不是「渲染层已经问过了」这种口头承诺。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const ASSISTANT = read('src/main/ipc/ai-assistant.js');
const CONTRACT = read('src/shared/ipcContract.js');
const { AGENT_TOOLS } = require('../src/main/mcp/tools');

test('三条助手通道都在契约里且 invoke 给 main', () => {
  for (const ch of ['ai-assistant-tools', 'ai-assistant-plan', 'ai-assistant-tool-call']) {
    assert.match(CONTRACT, new RegExp(`'${ch}':\\s*\\{\\s*invoke:\\s*MAIN`), `${ch} 未声明进契约`);
    assert.match(ASSISTANT, new RegExp(`handle\\('${ch}'`), `${ch} 未注册 handler`);
  }
});

test('确认闸门长在 handler 里：写操作不带 confirmed===true 直接拒', () => {
  assert.match(ASSISTANT, /tool\.mutating && confirmed !== true/, '闸门不在了');
  assert.match(ASSISTANT, /NEED_CONFIRM/, '拒绝要回可判定的令牌，不是中文句子');
  // 拒绝路径也必须走桥的审计？不 —— 未执行的调用不进桥。但令牌化错误必须存在，
  // 否则渲染层只能靠中文子串猜为什么失败。
  assert.ok(!/askConfirm/.test(ASSISTANT), '主进程不该出现确认框：确认是 UI 的事');
});

test('错误文案不出中文字面量（主进程只发令牌，词典在渲染层）', () => {
  const body = ASSISTANT.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const cjk = body.match(/['"`]([^'"`]*)['"`]/g) || [];
  const offenders = cjk.filter(s => /[\u4e00-\u9fa5]/.test(s));
  assert.deepStrictEqual(offenders, [], '主进程里出现中文字面量: ' + offenders.join(' | '));
});

test('助手不扩白名单：可用工具名恰等于 MCP 白名单', () => {
  const names = new Set(toolsNames());
  for (const t of AGENT_TOOLS) assert.ok(names.has(t.name), `${t.name} 不在助手可用面里`);
  assert.strictEqual(names.size, AGENT_TOOLS.length, '助手侧多出来了工具');

  function toolsNames() {
    const { toolsFromContract } = require('../src/main/mcp/tools');
    return toolsFromContract();
  }
});

test('助手入口不受 FEATURES.ai 管（AI 创作关掉时助手仍可用）', () => {
  const html = read('src/renderer/index.html');
  const seg = html.slice(html.indexOf('data-tab="assistant"') - 200, html.indexOf('data-tab="assistant"') + 200);
  assert.ok(!/data-feature="ai"/.test(seg), '助手入口挂上了 AI 开关就等于被关掉');
  const features = read('src/renderer/js/features.js');
  assert.ok(!/assistant/.test(features), 'TAB_FEATURES 里不该登记 assistant');
  assert.match(features, /ai:\s*false/, 'FEATURES.ai 必须仍是 false');
});
```

- [x] **Step 2: 跑测试确认它失败**

Run: `node --test test/ai-assistant-gate.test.js`
Expected: FAIL —— `Cannot find module '.../src/main/ipc/ai-assistant.js'`。

- [x] **Step 3: 契约加三条**

`src/shared/ipcContract.js` 的「MCP 本地服务（invoke）」区块，`'mcp-connect-snippet'` 之后追加：

```js
  // ── 应用内 AI 助手（invoke）───────────────────────
  // 助手与外部 Agent 共用工具表白名单（src/main/mcp/tools.js），差别只在：
  // 写操作必须由渲染层拿到用户确认后把 confirmed 传成 true，否则这里直接拒。
  'ai-assistant-tools': { invoke: MAIN },
  'ai-assistant-plan':  { invoke: MAIN, args: [['messages', t.arr(24)]] },
  'ai-assistant-tool-call': { invoke: MAIN, args: [['name', t.str(64)], ['args', t.obj()], ['confirmed', t.bool()]] },
```

`messages` 用 `t.arr(24)`：这是**防巨型数组的上限**，不是裁剪策略 —— `coerceVal` 的 arr 分支是 `slice(0, max)`，留的是**前** 24 条（丢最新），所以真正的「只保留最近若干条」必须长在渲染层与 `trimHistory`（上限 20，恒小于 24，生产路径碰不到这根栅栏）。

- [x] **Step 4: 建 `src/main/ipc/ai-assistant.js`**

```js
/**
 * 应用内 AI 助手 IPC（轨道二）
 *
 * 三条通道 = 助手能做的事的全部面：
 *   ai-assistant-tools      目录（含 mutating），渲染层据此决定何时弹确认
 *   ai-assistant-plan       一次 LLM 回合（主进程出网，编排循环在渲染层）
 *   ai-assistant-tool-call  执行一个白名单工具，走与外部 Agent 同一条桥
 *
 * 为什么循环在渲染层：确认框只有 UI 拿得到。把它做成主进程↔渲染层的往返
 * （send 问、invoke 答、超时、孤儿请求）是拿三层新机制换一句「先问用户」，
 * 而闸门本身只需要一个布尔参数 —— 谁调都要确认，界面上的按钮只是它的来源。
 *
 * 错误一律回 ASCII 令牌：主进程不产文案，文案的家是渲染层词典（toast-i18n 的规矩）。
 */

const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { createAgentBridge } = require('../mcp/agentBridge');
const { toolsFromContract } = require('../mcp/tools');
const { planAssistantTurn } = require('../../api/services/aiAssistantService');
const { assistantChat } = require('../../api/ai-music');

let _bridge = null;
function _handle() {
  if (_bridge) return _bridge;
  _bridge = createAgentBridge({
    source: 'assistant',
    serverVersion: (() => {
      try { return require('electron').app.getVersion(); } catch (_e) { return '0.0.0'; }
    })(),
  });
  return _bridge;
}

function register() {
  handle('ai-assistant-tools', () => ({
    tools: toolsFromContract().map(({ name, description, mutating }) => ({ name, description, mutating })),
  }));

  handle('ai-assistant-plan', async (_, messages) => {
    const apiKey = prefs.get('aiMusicApiKey');
    if (!apiKey) return { ok: false, error: 'NO_KEY' };
    try {
      return await planAssistantTurn({
        messages: Array.isArray(messages) ? messages : [],
        tools: toolsFromContract(),
        chat: (m) => assistantChat({ messages: m, apiKey }),
      });
    } catch (e) {
      logger.warn('[assistant] 回合失败:', e && e.message ? e.message : e);
      return { ok: false, error: 'LLM_FAILED' };
    }
  });

  handle('ai-assistant-tool-call', async (_, name, args, confirmed) => {
    const tool = toolsFromContract().find(t => t.name === name);
    if (!tool) return { ok: false, error: 'UNKNOWN_TOOL' };
    if (tool.mutating && confirmed !== true) return { ok: false, error: 'NEED_CONFIRM' };
    const msg = await _handle()({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args && typeof args === 'object' ? args : {} },
    });
    if (msg && msg.error) return { ok: false, error: 'TOOL_FAILED', text: String(msg.error.message || '').slice(0, 200) };
    const content = (msg && msg.result && msg.result.content && msg.result.content[0]) || null;
    const text = content ? String(content.text || '') : '';
    return { ok: !(msg && msg.result && msg.result.isError), isError: !!(msg && msg.result && msg.result.isError), text: text.slice(0, 8000) };
  });
}

module.exports = { register, _bridgeForTest: _handle };
```

`src/main/index.js`：`const ipcMcp = require('./ipc/mcp');`（:39）之后加一行

```js
const ipcAssistant = require('./ipc/ai-assistant');
```

`ipcMcp.register();`（:758）之后加一行（桥是惰性的，注册顺序不影响，但保持在 MCP 之后与文档口径一致）：

```js
  ipcAssistant.register();
```

- [x] **Step 5: 更新通道计数钉**

`test/ipc-contract.test.js:99` 改成（追加本轮三个的理由，别动既有的历史理由）：

```js
  assert.strictEqual(MAIN_INVOKE.size, 108); // +aggregate-cross-source（3-B 跨源聚合） // +ai-cancel-generation（AI 生成中断） // +mcp-audit +mcp-audit-clear（MCP 调用审计） +mcp-connect-snippet（接入配置片段）；+ai-assistant-tools/plan/tool-call（应用内助手）；余项：-flush-prefs -flush-history（无人调用的僵尸通道）
```

`METHODS` 那枚（:104）**仍是 106**：助手与 `mcp-*` 一样走 `ipcRenderer.invoke`，不进语法糖表。

- [x] **Step 6: 跑测试确认通过**

Run: `node --test test/ai-assistant-gate.test.js test/ipc-contract.test.js test/mcp-agent-bridge.test.js`
Expected: 全绿。此时 `ai-assistant-plan` 的 handler 已经 require 了 Task 4 才建的 `aiAssistantService` —— **本步若报 `Cannot find module`，就现在把 Task 4 的 Step 3、Step 4 做完再回来**（Task 3 与 4 有真实依赖，顺序按此执行，别留半截）。

- [x] **Step 7: 提交**

```bash
git add src/shared/ipcContract.js src/main/ipc/ai-assistant.js src/main/index.js test/ai-assistant-gate.test.js test/ipc-contract.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(assistant): 助手三条通道 + 确认闸门落在主进程 —— 界面自觉不算门，参数才是门"
```

---

### Task 4: LLM 回合（系统提示 + 容错解析 + 纯编排）

**Files:**
- Modify: `src/api/ai-music.js`（新增 `assistantChat()`，并把三处重复的模型字面量收成一个常量）
- Create: `src/api/services/aiAssistantService.js`
- Test: `test/ai-assistant-service.test.js`（新建）

**Interfaces:**
- Consumes: `request()`（`ai-music.js` 内部传输层，含 AbortSignal 与「计费调用禁自动重试」纪律）、`toolsFromContract()` 的产物
- Produces: `assistantChat({ messages, apiKey }) → Promise<string>`；`planAssistantTurn({ messages, tools, chat }) → Promise<{ok:true, reply:string, steps:Array<{tool,args}>} | {ok:false, error:string}>`；常量 `MAX_STEPS_PER_TURN=4`、`MAX_HISTORY_MESSAGES=20`、`MAX_RESULT_CHARS=4000`；纯函数 `buildSystemPrompt`、`parseAssistantReply`、`trimHistory`、`formatToolResults`。Task 3 的 `ai-assistant-plan` handler 消费 `planAssistantTurn`，Task 5 的渲染层消费 `reply`/`steps` 形状。

- [x] **Step 1: 写失败的测试**

新建 `test/ai-assistant-service.test.js`：

```js
/**
 * 助手编排：纯函数 + 依赖注入（与 nlSearchService 同一模式，单测不触网）
 *
 * 这一层的存在理由有三条，每条都是一枚测试：
 *   ① 模型给的 JSON 经常带毛刺（解释文字、代码块）——解析必须容错，且解析失败
 *      要退成「把这段话当回复」而不是整轮报错（nlSearch 的兜底同构）；
 *   ② steps 是**执行指令**，工具名不在白名单里就必须丢掉，不能等到执行时才拒；
 *   ③ 历史与工具结果会吃 token，裁剪规则要长在纯函数里，不能散在界面里。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildSystemPrompt, parseAssistantReply, planAssistantTurn, trimHistory, formatToolResults,
  MAX_STEPS_PER_TURN, MAX_HISTORY_MESSAGES,
} = require('../src/api/services/aiAssistantService');
const { toolsFromContract } = require('../src/main/mcp/tools');

const TOOLS = toolsFromContract();

test('系统提示带全部白名单工具名，且写明严格 JSON 协议', () => {
  const p = buildSystemPrompt(TOOLS);
  for (const t of TOOLS) assert.ok(p.includes(t.name), `提示里没有 ${t.name}`);
  assert.match(p, /"steps"/);
  assert.match(p, /只输出/);
});

test('解析：干净 JSON、带解释文字、带代码块三种毛刺都要能吃下', () => {
  const a = parseAssistantReply('{"reply":"帮你找","steps":[{"tool":"search_music","args":{"keyword":"夜跑"}}]}');
  assert.strictEqual(a.reply, '帮你找');
  assert.strictEqual(a.steps.length, 1);

  const b = parseAssistantReply('好的！\n```json\n{"reply":"ok","steps":[]}\n```');
  assert.strictEqual(b.reply, 'ok');
  assert.deepStrictEqual(b.steps, []);

  // 解析不出 JSON ⇒ 整段当回复，steps 为空（功能不回归，用户至少看到话）
  const c = parseAssistantReply('我还不能理解这句话');
  assert.strictEqual(c.reply, '我还不能理解这句话');
  assert.deepStrictEqual(c.steps, []);
});

test('steps 里的非白名单工具、args 非对象、超上限都要被丢掉', () => {
  const fake = [
    { tool: 'rm_rf', args: {} },                       // 不在白名单
    { tool: 'search_music', args: '不是对象' },          // args 形状非法
    { tool: 'search_music', args: { keyword: 'a' } },
    { tool: 'get_lyrics', args: { id: '1' } },
    { tool: 'list_platforms', args: {} },
    { tool: 'history_stats', args: {} },
    { tool: 'source_health', args: {} },                // 第 5 个 → 截断
  ];
  const r = parseAssistantReply(JSON.stringify({ reply: 'x', steps: fake }));
  assert.strictEqual(r.steps.length, MAX_STEPS_PER_TURN);
  assert.deepStrictEqual(r.steps.map(s => s.tool), ['search_music', 'get_lyrics', 'list_platforms', 'history_stats']);
});

test('trimHistory：只留末尾 N 条，且首条必须是 user（孤立的工具结果开头会让模型误读）', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: i % 3 === 0 ? 'user' : (i % 3 === 1 ? 'assistant' : 'user'), content: `m${i}` });
  const out = trimHistory(msgs, 6);
  assert.ok(out.length <= 6);
  assert.strictEqual(out[0].role, 'user');
});

test('formatToolResults：结果作为一条 user 消息回喂，单条截断到上限', () => {
  const m = formatToolResults([
    { tool: 'search_music', ok: true, text: 'x'.repeat(9000) },
    { tool: 'get_lyrics', ok: false, text: 'boom' },
  ]);
  assert.strictEqual(m.role, 'user');
  const parsed = JSON.parse(m.content);
  assert.strictEqual(parsed.tool_results.length, 2);
  assert.ok(parsed.tool_results[0].text.length <= 4000);
  assert.strictEqual(parsed.tool_results[1].ok, false);
});

test('planAssistantTurn：注入假 chat，跑通「系统提示 + 历史 + 解析」全链', async () => {
  let got = null;
  const r = await planAssistantTurn({
    messages: [{ role: 'user', content: '来点夜跑的歌' }],
    tools: TOOLS,
    chat: async (m) => { got = m; return '{"reply":"找好了","steps":[{"tool":"search_music","args":{"keyword":"夜跑 中文"}}]}'; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reply, '找好了');
  assert.strictEqual(got[0].role, 'system');
  assert.strictEqual(got[1].content, '来点夜跑的歌');
});

test('planAssistantTurn：chat 抛错时回 ok:false 且不吞掉原因的长度上限', async () => {
  const r = await planAssistantTurn({
    messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
    chat: async () => { throw new Error('401 unauthorized'); },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /401/);
  assert.ok(r.error.length <= 200);
});
```

- [x] **Step 2: 跑测试确认它失败**

Run: `node --test test/ai-assistant-service.test.js`
Expected: FAIL —— `Cannot find module '../src/api/services/aiAssistantService'`。

- [x] **Step 3: 建 `src/api/services/aiAssistantService.js`**

```js
/**
 * 应用内 AI 助手编排（轨道二）—— 纯函数 + 依赖注入，单测不触网
 *
 * 协议刻意用「严格 JSON 的一段话」而不是厂商的 function-calling 字段：
 *   ① 现用的 MiniMax 兼容端点是否支持 tools/tool_responses 不在本仓控制范围，
 *      把它当**必需能力**写死 = 换个上游就整体失灵；
 *   ② 白名单校验、步数上限、参数钳制本来就在主进程那侧（契约 + 桥），
 *      JSON 协议让这些防线一处都不必搬；
 *   ③ 与 parseSearchQueries（P0-A 的关键词改写）同构，容错口径已有先例。
 *
 * 循环在渲染层：本模块只做「一次回合」——把历史喂给模型、拿回 reply 与 steps。
 */

const MAX_STEPS_PER_TURN = 4;
const MAX_HISTORY_MESSAGES = 20;
const MAX_RESULT_CHARS = 4000;

/** 工具目录 → 系统提示（名字、说明、参数键名都来自契约派生的同一份工具表） */
function buildSystemPrompt(tools) {
  const lines = tools.map((t) => {
    const props = Object.entries((t.inputSchema && t.inputSchema.properties) || {})
      .map(([k, v]) => `${k}${v && v.type ? `:${v.type}` : ''}`);
    const req = ((t.inputSchema && t.inputSchema.required) || []).join(',');
    return `- ${t.name}(${props.join(', ')})${req ? ` 必填:${req}` : ''} —— ${t.description}`;
  });
  return `你是桌面音乐下载应用「揽乐」内置的助手，只能通过下列工具做事，不能编造歌曲 id / 歌单 id。

可用工具（名字必须完全一致，未列出的能力就是没有）：
${lines.join('\n')}

回答方式：只输出一个 JSON 对象，不要 markdown 代码块之外的任何解释文字。形如：
{"reply":"给用户看的一句话","steps":[{"tool":"search_music","args":{"keyword":"轻快 中文 晨跑"}}]}

规则：
- 不需要动手就 "steps":[]。
- 一次最多 ${MAX_STEPS_PER_TURN} 个 steps；拿不准先查后动。
- 查询类工具可以直接执行；加入队列、加入歌单、红心收藏这三类会改动用户的东西，主进程会逐条向用户请求确认，你照常提交即可。
- 用户没给具体歌手/歌名时，用 search_music 或 ai_search_music 找。
- reply 用中文，一句话说清你做了什么或需要什么信息，不要复述 JSON。`;
}

function _coerceSteps(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    if (!allowed.has(s.tool)) continue;            // 白名单外的指令在这里就消失
    if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) continue;
    out.push({ tool: String(s.tool), args: s.args });
    if (out.length === MAX_STEPS_PER_TURN) break;
  }
  return out;
}

/** 容错解析：整段 JSON → 抠第一个 {…} → 退化为纯文本回复 */
function parseAssistantReply(text) {
  const fallback = { reply: typeof text === 'string' ? text.trim() : '', steps: [] };
  if (typeof text !== 'string' || !text.trim()) return { reply: '', steps: [] };
  const allowed = ALLOWED_CACHE; // 见文件末尾：默认白名单，测试可另传
  let obj = null;
  try {
    obj = JSON.parse(text.trim());
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (_e) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return fallback;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : (fallback.reply || '');
  return { reply, steps: _coerceSteps(obj.steps, allowed) };
}

/** 只留末尾 max 条；若截出来的第一条是「工具结果」则丢掉它 —— 孤立结果开头会让模型把上下文读反 */
function trimHistory(messages, max = MAX_HISTORY_MESSAGES) {
  const list = Array.isArray(messages) ? messages.slice(-max) : [];
  while (list.length && (list[0].role !== 'user' || typeof list[0].content !== 'string'
    || list[0].content.startsWith('{"tool_results"'))) {
    list.shift();
  }
  return list;
}

/** 一轮执行结果回喂成一条 user 消息（协议里没有 tool role，就用用户口吻把 JSON 递回去） */
function formatToolResults(results, max = MAX_RESULT_CHARS) {
  return {
    role: 'user',
    content: JSON.stringify({
      tool_results: (results || []).map(r => ({
        tool: String(r.tool || ''),
        ok: r.ok === true,
        text: String(r.text || '').slice(0, max),
      })),
    }),
  };
}

/**
 * @param {Object} deps
 * @param {Array} deps.messages - 不含 system 的历史
 * @param {Array} deps.tools    - toolsFromContract() 的产物（name + inputSchema）
 * @param {(messages:Array)=>Promise<string>} deps.chat - 一次出网：messages → 模型文本
 */
async function planAssistantTurn({ messages, tools, chat }) {
  const history = trimHistory(messages);
  if (!history.length) return { ok: false, error: 'EMPTY' };
  const sys = { role: 'system', content: buildSystemPrompt(tools) };
  let text;
  try {
    text = await chat([sys, ...history]);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
  const { reply, steps } = parseAssistantReply(text);
  if (!reply && !steps.length) return { ok: false, error: 'EMPTY_REPLY' };
  return { ok: true, reply, steps };
}

// 默认校验面 = 真实工具白名单（单测与主进程读同一份，不各攒一份）
const { toolsFromContract } = require('../../main/mcp/tools');
const ALLOWED_CACHE = new Set(toolsFromContract().map(t => t.name));

module.exports = {
  buildSystemPrompt, parseAssistantReply, planAssistantTurn, trimHistory, formatToolResults,
  MAX_STEPS_PER_TURN, MAX_HISTORY_MESSAGES, MAX_RESULT_CHARS,
};
```

`parseAssistantReply` 用模块级 `ALLOWED_CACHE` 而非入参：工具名合法与否**只有一个答案**，如果做成参数就会出现「测试传了小表所以通过、生产传大表所以放行」的两套判据；代价是纯函数依赖了 tools 模块，`aiAssistantService` 因此 require `../../main/mcp/tools`（从 `src/api/services/` 往上两级才到 `src/`）—— 这条 require 是纯数据（`ipcContract` 的派生表），不拉 electron，`check:dead-deps` 与单测都不受影响。

- [x] **Step 4: `src/api/ai-music.js` 加助手回合的出网函数**

文件顶部常量区（`MINIMAX_API_BASE` 附近）加，并把 `:330`、`:698`、`:775` 三处 `model: 'MiniMax-Text-01'` 改为 `model: CHAT_MODEL`（三处重复的字面量收成一处，否则改模型要记三件事）：

```js
const CHAT_MODEL = 'MiniMax-Text-01';
```

`rewriteSearchQueries` 之后加：

```js
/**
 * 应用内助手的一轮对话（非流式）。
 * 计费调用：retries 必须为 0 —— 一次超时换两跳就是双倍扣费（见 request 的 H3 注释）。
 * @param {Object} params
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {string} params.apiKey
 * @returns {Promise<string>} 模型文本（解析由 aiAssistantService 负责）
 */
async function assistantChat({ messages, apiKey }) {
  if (!apiKey) throw new Error('NO_KEY');
  const result = await request(`${MINIMAX_API_BASE}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    retries: 0,
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: {
      model: CHAT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 800,
    },
  });
  if (result.status !== 200 || !result.data || !result.data.choices) {
    throw new Error((result.data && result.data.error && result.data.error.message) || 'LLM_HTTP_' + result.status);
  }
  return (result.data.choices[0] && result.data.choices[0].message && result.data.choices[0].message.content) || '';
}
```

导出区 `module.exports = {` 里加 `assistantChat,`。

- [x] **Step 5: 跑测试确认通过**

Run: `node --test test/ai-assistant-service.test.js test/ai-assistant-gate.test.js test/nl-search*.test.js`
Expected: 全绿（`nl-search` 那组证明模型字面量换成常量没碰坏既有断言）。

- [x] **Step 6: 提交**

```bash
git add src/api/ai-music.js src/api/services/aiAssistantService.js test/ai-assistant-service.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(assistant): 回合编排纯函数 + MiniMax 助手出网口 —— 严格 JSON 协议、容错解析、白名单与步数上限都在这一层"
```

---

### Task 5: 渲染层助手页（循环 + 逐条确认 + 全走词典）

**Files:**
- Create: `src/renderer/js/views/ai-assistant.js`
- Modify: `src/renderer/index.html`（侧栏入口 + 页面骨架）、`src/renderer/js/app.js`（`switchTab` 三处 + `import './views/ai-assistant.js';`）、`src/renderer/styles/content.css`（页面样式）、`src/renderer/js/lang/zh.json`、`src/renderer/js/lang/en.json`
- Test: `test/ai-assistant-ui.test.js`（新建，静态守卫）

**Interfaces:**
- Consumes: `ai-assistant-tools` / `ai-assistant-plan` / `ai-assistant-tool-call`（Task 3）、`askConfirm`（`../confirmDialog.js`）、`showToast`（`../toast.js`）、`t`（`../i18n.js`）、`errBrief`（`../errBrief.js`）
- Produces: 页面 `#aiAssistantPage`、消息流 `#assistantLog`、输入 `#assistantInput`、函数 `sendAssistant()` / `clearAssistant()` / `toggleAssistantSendKey()`，以及 `window.sendAssistant` 等导出（内联 onclick 只认 window）

- [x] **Step 1: 写失败的静态守卫**

新建 `test/ai-assistant-ui.test.js`：

```js
/**
 * 助手页的接线纪律（静态守卫）
 *
 * 助手是「模型能替你动手」的界面，三类事故最容易漏：
 *   ① 写操作没弹确认（界面上漏 await，或 await 忘了写 —— 不 await 的确认框等于没有确认）；
 *   ② 把远端/模型文本用 innerHTML 拼进 DOM（歌名与模型回复都可能含尖括号）；
 *   ③ 界面里攒中文，英文界面就漏（本仓 toast-i18n 台账的老账）。
 * 真行为在 node 下起不了 DOM（本仓无 jsdom），所以这三条都按源码形状钉，
 * 再加一条「可用通道恰为白名单」的集合钉防扩权。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');
const VIEW = read('js', 'views', 'ai-assistant.js');
const HTML = read('index.html');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'lang', 'zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'lang', 'en.json'), 'utf8'));

function dig(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

test('写操作确认：mutating 步骤必须先 await askConfirm，且拒绝时不执行', () => {
  const calls = VIEW.match(/await\s+askConfirm\(/g) || [];
  assert.strictEqual(calls.length, 1, '助手页应恰有一处 await askConfirm(');
  assert.match(VIEW, /if\s*\(meta\s*&&\s*meta\.mutating\)/, '没按 mutating 判定就不该弹确认');
  assert.match(VIEW, /if\s*\(!\s*await\s+askConfirm|const okAsk = await askConfirm[\s\S]{0,200}if\s*\(!okAsk\)/,
    '确认返回 false 必须跳过这一步');
  assert.ok(VIEW.includes("import { askConfirm } from '../confirmDialog.js';"));
});

test('模型/歌曲文本一律 textContent 上屏，不许拼进 innerHTML', () => {
  const bad = VIEW.split('\n').filter(l => /innerHTML\s*=/.test(l) && /\$\{/.test(l));
  assert.deepStrictEqual(bad, [], 'innerHTML 里禁止插动态文案: ' + bad.join(' | '));
});

test('助手页用到的 assistant.* / toast.* 键必须中英齐备且占位符同集合', () => {
  const keys = new Set();
  for (const m of VIEW.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)) {
    if (m[1].includes('.')) keys.add(m[1]);
  }
  for (const m of HTML.matchAll(/data-i18n="((?:assistant|nav)\.[^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size >= 12, `取词太少（${keys.size}），接线大概没走词典`);
  for (const k of keys) {
    const a = dig(zh, k), b = dig(en, k);
    assert.ok(typeof a === 'string' && a.trim(), `zh 缺键 ${k}`);
    assert.ok(typeof b === 'string' && b.trim(), `en 缺键 ${k}`);
    const pa = (a.match(/\{(\w+)\}/g) || []).sort().join(','), pb = (b.match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.strictEqual(pa, pb, `${k} 中英占位符不同集合: ${pa} vs ${pb}`);
  }
});

test('助手可用面 = MCP 白名单，一条通道都不多', () => {
  const { AGENT_TOOLS } = require('../src/main/mcp/tools');
  const used = new Set([...VIEW.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]));
  for (const ch of ['ai-assistant-tools', 'ai-assistant-plan', 'ai-assistant-tool-call']) {
    assert.ok(used.has(ch), `助手页应调用 ${ch}`);
  }
  // 除这三条自身，界面侧不得再 invoke 别的工具通道（扩权要么走白名单要么走不通）
  const others = [...used].filter(c => !c.startsWith('ai-assistant-'));
  assert.deepStrictEqual(others, [], '助手页绕道调了别的通道: ' + others.join(', '));
  assert.strictEqual(AGENT_TOOLS.length, 17, '工具数变了：SECURITY/README/本钉三处口径要一起改');
});

test('循环有上界：回合数与步数都封顶，否则坏回复能刷爆队列', () => {
  assert.match(VIEW, /MAX_TURNS\s*=\s*3/);
  assert.match(VIEW, /_turn\s*<\s*MAX_TURNS/, '循环必须有上界');
});

test('入口与页面：侧栏 assistant 条目、switchTab 三处、window 导出齐全', () => {
  assert.match(HTML, /data-tab="assistant"[\s\S]{0,120}onclick="switchTab\('assistant',this\)"/);
  assert.match(HTML, /data-i18n="nav\.assistant"/);
  const APP = read('js', 'app.js');
  assert.match(APP, /getElementById\('aiAssistantPage'\)/);
  assert.match(APP, /aiAssistantPage\.style\.display\s*=\s*'none'/);
  assert.match(APP, /aiAssistantPage\.style\.display\s*=\s*'flex'/);
  assert.match(APP, /import '\.\/views\/ai-assistant\.js';/);
  for (const fn of ['sendAssistant', 'clearAssistant']) {
    assert.match(VIEW, new RegExp(`function ${fn}\\(`), `缺函数 ${fn}`);
    assert.match(VIEW, new RegExp(`window\\.${fn} = ${fn};`), `${fn} 没挂 window（内联 onclick 只认 window）`);
  }
});
```

- [x] **Step 2: 跑测试确认它失败**

Run: `node --test test/ai-assistant-ui.test.js`
Expected: FAIL —— `ai-assistant.js` 读不到。

- [x] **Step 3: 文案键（zh/en 各一份，同一提交里加，避免「键存在性」钉红着）**

`src/renderer/js/lang/zh.json`（放在 `toast.*` 之前的 `assistant` 对象；与既有词典风格一致：键名英文、值中文）：

```json
  "assistant": {
    "title": "AI 助手",
    "empty": "说一句你想听什么、想下什么，助手会调用本应用的能力替你做完。写操作（入队、加歌单、红心）会先跟你确认。",
    "placeholder": "例：把周杰伦的晴天加进「通勤」歌单",
    "send": "发送",
    "clear": "清空对话",
    "thinking": "助手在想…",
    "toolRunning": "正在执行：{tool}",
    "toolDone": "{tool} 完成",
    "toolFailed": "{tool} 失败：{msg}",
    "toolDeclined": "已取消：{tool}",
    "confirmText": "助手想执行：{tool}\n参数：{args}\n这一步会改动你的曲库或队列，确认后再动手。",
    "errNoKey": "请先在「设置 → AI 音乐」里配置 MiniMax API Key",
    "errNeedConfirm": "该操作未确认，已跳过",
    "errUnknownTool": "助手请求了不存在的能力，已忽略",
    "errLlmFailed": "助手请求失败：{msg}",
    "errEmpty": "助手没给出可用回复，换个说法试试",
    "loopStopped": "连续三步仍没结论，先停在这里"
  },
```

`toast` 段加三条（`showToast` 的文案必须走 `toast.*`，这是 toast-i18n 的判据口径）：

```json
    "assistantCleared": "对话已清空",
    "assistantSendFailed": "发送失败：{msg}",
    "assistantNoAnswer": "助手暂时没回答"
```

`src/renderer/js/lang/en.json` 对应位置给独立译文（不得照抄中文，`test/toast-i18n.test.js` 的 D3 会比对）：

```json
  "assistant": {
    "title": "AI Assistant",
    "empty": "Say what you want to hear or download; the assistant uses this app's own capabilities. Write actions (queue, playlist, favorite) ask first.",
    "placeholder": "e.g. Add Sunny Jay to my Commute playlist",
    "send": "Send",
    "clear": "Clear chat",
    "thinking": "Thinking…",
    "toolRunning": "Running: {tool}",
    "toolDone": "{tool} done",
    "toolFailed": "{tool} failed: {msg}",
    "toolDeclined": "Cancelled: {tool}",
    "confirmText": "The assistant wants to run: {tool}\nArguments: {args}\nThis changes your library or queue. Confirm to proceed.",
    "errNoKey": "Set your MiniMax API key in Settings → AI Music first",
    "errNeedConfirm": "Unconfirmed action, skipped",
    "errUnknownTool": "The assistant asked for a tool that does not exist, ignored",
    "errLlmFailed": "Assistant request failed: {msg}",
    "errEmpty": "No usable answer, try rephrasing",
    "loopStopped": "No conclusion after three turns, stopping here"
  },
```

`toast` 段：

```json
    "assistantCleared": "Chat cleared",
    "assistantSendFailed": "Send failed: {msg}",
    "assistantNoAnswer": "The assistant did not answer"
```

- [x] **Step 4: 侧栏入口 + 页面骨架**

`src/renderer/index.html` 「工具」分组内、`data-tab="ai-music"` 那条**之后**插入（顺序决定 `renderer-audit` 那张表，Task 6 要同步）：

```html
    <button class="nav-item" data-tab="assistant" onclick="switchTab('assistant',this)">
      <span class="icon">&#129302;</span> <span data-i18n="nav.assistant">AI 助手</span>
    </button>
```

`id="aggregatePage"` 那块之前（页面顺序与侧栏顺序不必一致，但集中放在其它页面旁更好维护）加骨架 —— 沿用既有页面写法：外层 `style` 只管显隐与布局，细节样式在 `content.css`：

```html
    <div id="aiAssistantPage" style="display:none;flex-direction:column;gap:12px;height:100%;padding:16px;">
      <div class="asst-head">
        <span class="asst-title" data-i18n="assistant.title">AI 助手</span>
        <button class="btn-secondary" onclick="clearAssistant()" data-i18n="assistant.clear">清空对话</button>
      </div>
      <div class="asst-log" id="assistantLog">
        <div class="asst-empty" data-i18n="assistant.empty">说一句你想听什么、想下什么，助手会调用本应用的能力替你做完。写操作（入队、加歌单、红心）会先跟你确认。</div>
      </div>
      <div class="asst-input-row">
        <textarea class="asst-input" id="assistantInput" rows="2" data-i18n="assistant.placeholder" placeholder="例：把周杰伦的晴天加进「通勤」歌单"></textarea>
        <button class="btn-primary" id="assistantSendBtn" onclick="sendAssistant()" data-i18n="assistant.send">发送</button>
      </div>
    </div>
```

`nav.assistant` 也加进两份词典（`nav` 段的既有键按字母序排在 `aggregate` 之后）：`"assistant": "AI 助手"` / `"assistant": "AI Assistant"`。
textarea 的 `data-i18n` 不是笔误：`i18n.js:53-57` 对 INPUT/TEXTAREA 写的是 `.placeholder` 而不是 textContent，所以占位文案就用 `data-i18n="assistant.placeholder"`，静态 `placeholder` 属性留中文兜底。

- [x] **Step 5: `src/renderer/js/app.js` 三处接线**

`import './views/subscriptions.js';`（:56）之后加：

```js
import './views/ai-assistant.js';
```

`switchTab` 里取页面的那一段（`const subscriptionPage = ...` 附近）加：

```js
  const aiAssistantPage = document.getElementById('aiAssistantPage');
```

统一隐藏那一段加：

```js
  if (aiAssistantPage) aiAssistantPage.style.display = 'none';
```

显示分支（照 `aggregate` 那条的写法，在同级 `else if` 链里加）：

```js
  } else if (tab === 'assistant') {
    if (aiAssistantPage) aiAssistantPage.style.display = 'flex';
  }
```

- [x] **Step 6: 样式（`src/renderer/styles/content.css` 末尾）**

只用设计令牌，不裸写色值（`test/confirm-dialog.test.js` 与既有的令牌纪律）：

```css
/* ── AI 助手页（轨道二）──────────────────────────── */
.asst-head { display: flex; align-items: center; gap: var(--sp-2); }
.asst-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--neon-text); }
.asst-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.asst-empty { color: var(--neon-dim); font-size: 12.5px; line-height: 1.7; }
.asst-msg { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.asst-msg-user { color: var(--neon-text); }
.asst-msg-assistant { color: var(--text); }
.asst-step { font-size: 12px; color: var(--neon-dim); }
.asst-step-failed { color: var(--red); }
.asst-input-row { display: flex; gap: var(--sp-2); align-items: flex-end; }
.asst-input {
  flex: 1;
  resize: none;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-family: inherit;
}
.asst-input:focus { outline: none; border-color: var(--neon-cyan); }
```

- [x] **Step 7: 视图模块 `src/renderer/js/views/ai-assistant.js`**

```js
/**
 * 应用内 AI 助手（轨道二）
 *
 * 分工：主进程负责「一次出网」与「执行一个工具」，本文件负责**循环与确认**。
 * 循环放界面侧不是因为这里逻辑高级，而是因为确认框只有 UI 拿得到 ——
 * 换成主进程驱动就得发明一套 send/invoke 往返加超时与孤儿请求，换到的只是
 * 同一个 `confirmed === true` 的闸门。闸门本身在主进程（见 ipc/ai-assistant.js）。
 *
 * 纪律：写操作逐条 askConfirm 且必须 await（不 await 的确认框等于没有确认）；
 * 文本一律 textContent 上屏（歌名与模型回复都可能含尖括号）；文案全部走词典；
 * 循环有上界（MAX_TURNS），坏回复不该把用户的 API Key 刷爆。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { showToast } from '../toast.js';
import { askConfirm } from '../confirmDialog.js';

const MAX_TURNS = 3;

let _history = [];      // [{role:'user'|'assistant', content:string}]
let _tools = null;      // 助手可见目录（含 mutating）
let _busy = false;

function _log() { return document.getElementById('assistantLog'); }

function _push(cls, text) {
  const box = _log();
  if (!box) return null;
  const empty = box.querySelector('.asst-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `asst-msg ${cls}`;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

/** 工具目录惰性拉取：切页不该反复打 IPC（与 aggregate 的 _aggLoaded 同路数） */
async function _ensureTools() {
  if (_tools) return _tools;
  const r = await window.ipcRenderer.invoke('ai-assistant-tools');
  _tools = (r && r.tools) || [];
  return _tools;
}

const ERR_KEYS = {
  NO_KEY: 'assistant.errNoKey',
  NEED_CONFIRM: 'assistant.errNeedConfirm',
  UNKNOWN_TOOL: 'assistant.errUnknownTool',
  LLM_FAILED: 'assistant.errLlmFailed',
  EMPTY: 'assistant.errEmpty',
  EMPTY_REPLY: 'assistant.errEmpty',
};

function _errText(code, msg) {
  const key = ERR_KEYS[code];
  if (!key) return t('assistant.errLlmFailed', { msg: errBrief(code || msg || 'unknown') });
  return key === 'assistant.errLlmFailed'
    ? t(key, { msg: errBrief(msg || '') })
    : t(key);
}

/** 一个回合：问 → （确认 →）执行 → 结果回喂再问，直到没有 steps 或触上界 */
async function _round(userText) {
  _history.push({ role: 'user', content: userText });
  const tools = await _ensureTools();
  let stopHint = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const el = _push('asst-msg-assistant', t('assistant.thinking'));
    const plan = await window.ipcRenderer.invoke('ai-assistant-plan', _history);
    if (el) el.remove();
    if (!plan || plan.ok !== true) {
      stopHint = _errText(plan && plan.error, plan && plan.text);
      break;
    }
    _history.push({ role: 'assistant', content: JSON.stringify({ reply: plan.reply, steps: plan.steps }) });
    if (plan.reply) _push('asst-msg-assistant', plan.reply);
    if (!plan.steps.length) return '';

    const results = [];
    for (const step of plan.steps) {
      const meta = tools.find(x => x.name === step.tool);
      if (meta && meta.mutating) {
        const argsText = JSON.stringify(step.args).slice(0, 200);
        const okAsk = await askConfirm({
          text: t('assistant.confirmText', { tool: step.tool, args: argsText }),
        });
        if (!okAsk) {
          results.push({ tool: step.tool, ok: false, text: t('assistant.toolDeclined', { tool: step.tool }) });
          _push('asst-step', t('assistant.toolDeclined', { tool: step.tool }));
          continue;
        }
      }
      _push('asst-step', t('assistant.toolRunning', { tool: step.tool }));
      const out = await window.ipcRenderer.invoke('ai-assistant-tool-call', step.tool, step.args, meta && meta.mutating === true);
      const ok = !!(out && out.ok);
      results.push({ tool: step.tool, ok, text: ok ? out.text : _errText(out && out.error, out && out.text) });
      _push(ok ? 'asst-step' : 'asst-step asst-step-failed',
        ok ? t('assistant.toolDone', { tool: step.tool }) : t('assistant.toolFailed', { tool: step.tool, msg: errBrief(out && out.text) }));
    }
    _history.push({ role: 'user', content: JSON.stringify({ tool_results: results.map(r => ({ tool: r.tool, ok: r.ok, text: (r.text || '').slice(0, 4000) })) }) });
    stopHint = t('assistant.loopStopped');
  }
  return stopHint;
}

async function sendAssistant() {
  if (_busy) return;
  const input = document.getElementById('assistantInput');
  const text = (input && input.value || '').trim();
  if (!text) return;
  _busy = true;
  const btn = document.getElementById('assistantSendBtn');
  if (btn) btn.disabled = true;
  if (input) input.value = '';
  _push('asst-msg-user', text);
  try {
    const hint = await _round(text);
    if (hint) _push('asst-step', hint);
  } catch (e) {
    showToast(t('toast.assistantSendFailed', { msg: errBrief(e) }), 'error', 5000);
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
    if (input) input.focus();
  }
}

function clearAssistant() {
  _history = [];
  const box = _log();
  if (box) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'asst-empty';
    d.textContent = t('assistant.empty');
    box.appendChild(d);
  }
  showToast(t('toast.assistantCleared'), 'success');
}

// 回车发送、Shift+回车换行 —— 与搜索栏的既有手感一致
function _bindInput() {
  const input = document.getElementById('assistantInput');
  if (!input || input.dataset.asstBound === '1') return;
  input.dataset.asstBound = '1';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAssistant(); }
  });
}

document.addEventListener('DOMContentLoaded', _bindInput);
if (document.readyState !== 'loading') _bindInput();

window.sendAssistant = sendAssistant;
window.clearAssistant = clearAssistant;
```

`_round` 把助手的每一步（含 `reply` 与 steps）以 JSON 文本回喂进 `_history`：模型的上一轮输出必须**原样**回到上下文里，否则下一轮它会重复同一步 —— 这是与 `formatToolResults` 同一套「协议里没有 tool role」的口径，两处都写成 `{"tool_results":…}` / `{"reply":…,"steps":…}` 的 user 消息，`trimHistory` 靠这个前缀判断「不能开头」。

- [x] **Step 8: 跑静态守卫**

Run: `node --test test/ai-assistant-ui.test.js test/toast-i18n.test.js`
Expected: `ai-assistant-ui` 全绿；`toast-i18n` 此时仍绿（新文件还没进 `CONQUERED`，Task 6 收编）。

- [ ] **Step 9: 手动验证（起应用真点一遍）**

```bash
npm run dev   # 或本仓既有的启动方式
```

在设置页「AI 音乐」里配好 Key（没有 Key 先验「请先配置」这条文案能出），然后：
① 「找几首适合夜跑的中文歌」→ 应看到 `search_music` 跑完并列出结果文本；
② 「把第一首加进下载队列」→ 应先弹确认，确认后 `add_to_queue` 成功；
③ 同一句再点「取消」→ 日志应显示「已取消」，且设置页的 MCP 审计里**不该**出现这条被拒的执行（NEED_CONFIRM 不进桥），但助手页不该崩；
④ 清空对话按钮可用；⑤ 切英文界面重复 ①，不得漏中文。
若无法起界面（CI 环境），在提交信息里如实写明「未做界面实测」。

- [x] **Step 10: 提交**

```bash
git add src/renderer/js/views/ai-assistant.js src/renderer/index.html src/renderer/js/app.js src/renderer/styles/content.css src/renderer/js/lang/zh.json src/renderer/js/lang/en.json test/ai-assistant-ui.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "feat(assistant): 应用内 AI 助手页 —— 循环在界面、确认逐条弹、写操作与非写操作分口径"
```

---

### Task 6: 台账收编（五张表一次对齐）

**Files:**
- Modify: `test/toast-i18n.test.js`（`CONQUERED` :361、`CONQUERED_VIEWS` :430）
- Modify: `test/confirm-dialog.test.js`（`ASK_SITES` :135-145、总数 :158、标题 :147）
- Modify: `test/renderer-audit.test.js`（侧栏 tabs 列表 :500、「工具」段 :521）
- Test: `test/ai-assistant-e2e.test.js`（新建，真桥 + 假 callTool 的全链）

**Interfaces:**
- Consumes: Task 1-5 的落地事实
- Produces: 无新接口；五张台账与代码逐字相等

- [x] **Step 1: toast-i18n 收编**

`CONQUERED` 数组末尾加一行（顺序即收编史，新增放最后）：

```js
  // 轨道二出生即零欠账：助手页从第一版起文案全走词典
  'src/renderer/js/views/ai-assistant.js',
```

`CONQUERED_VIEWS` 同样加 `'src/renderer/js/views/ai-assistant.js',`（该文件已 `import { t } from '../i18n.js'`，且不出现 `window.t(`）。

- [x] **Step 2: 确认框台账 17 → 18**

`ASK_SITES` 末尾加 `['views/ai-assistant.js', 1],`；`assert.equal(total, 17, '调用点总数必须等于 17——…')` 改为 18（含提示语里的数字）；测试标题 `'17 处不可逆操作…'` 改为 `'18 处…'`；上方分节注释 `// ── 接线钉：17 个调用点…` 同步。

- [x] **Step 3: 侧栏台账**

`test/renderer-audit.test.js:500` 的期望序列在 `'ai-music'` 之后插入 `'assistant'`：

```js
  assert.deepStrictEqual(tabs, ['home', 'download', 'local', 'playlist', 'aggregate', 'subscription', 'ai-music', 'assistant', 'converter'],
```

测试标题「七个 data-tab」改成实际条目数（现在 9 个）：把 `侧边栏条目：七个 data-tab …` 改为 `侧边栏条目：九个 data-tab …`。
`:521` 的「工具」段改为 `['ai-music', 'assistant', 'converter']`。
理由注释保持原样（条目增删会破坏 switchTab 兜底查询与 ⌘K 反查 —— 本轮正是这种改动，所以台账必须跟着动，别改 HTML 蒙过它）。

- [x] **Step 4: 写全链测试（真桥 + 假 handler，含审计两路 source）**

新建 `test/ai-assistant-e2e.test.js`：

```js
/**
 * 助手全链：目录 → 回合 → 确认闸门 → 桥执行 → 审计
 *
 * 为什么还要一枚 e2e：前面每层各自绿过（桥会审计、闸门会拒、服务会解析），
 * 「助手页真的走过这条链」却没人钉过 —— 轨道一的教训就是两层各自绿着、
 * 全链无人走过（见 test/mcp-e2e.test.js 的来由）。
 *
 * 这里不起渲染层（无 jsdom），用主进程的真实通道 handler：
 * register.js 的 handler 表在测试里手工灌一个假 search-music，
 * 于是参数钳制、错误语义、审计形状全是真的，只有网络是假的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ── Electron 打桩（与 test/crossSourceAggregate-primary.test.js 同一套路）──
// ipc/register 顶部 require('electron')，纯 node 下拿到的是「二进制路径字符串」，
// ipcMain 是 undefined —— 不打桩的话 register.handle() 第一行就崩，
// 测试会误判成「助手没接上」而其实是装载失败。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-e2e-el-'));
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => stubDir, getVersion: () => '1.0.0' },
    };
  }
  return originalLoad.apply(this, arguments);
};

const register = require('../src/main/ipc/register');
const auditSink = require('../src/main/mcp/auditSink');
const assistant = require('../src/main/ipc/ai-assistant');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'asst-e2e-')); }

/**
 * 取「主进程内部复用」的那条路：getInvokeHandler 给的是**未包装**的原始 handler
 * （不经 ipcMain 的信封与 normalizeArgs）—— 助手的桥自己会做 normalizeArgs，
 * 所以这里要的就是原始 handler，等价于「渲染层 invoke 之后主进程真正跑的那段」。
 * 调用时首位传 null 当 event：白名单里的 handler 不依赖 sender。
 */
function handlerOf(ch) {
  const fn = register.getInvokeHandler(ch);
  if (!fn) throw new Error(`测试取不到 handler: ${ch}`);
  return (...args) => fn(null, ...args);
}

test('目录：17 个工具且恰好 3 个标着 mutating', async () => {
  assistant.register();
  const r = await handlerOf('ai-assistant-tools')();
  assert.strictEqual(r.tools.length, 17);
  assert.deepStrictEqual(r.tools.filter(t => t.mutating).map(t => t.name).sort(),
    ['add_to_playlist', 'add_to_queue', 'toggle_favorite']);
});

test('闸门：写操作不带确认直接拒，带确认才落到 handler', async () => {
  const dir = tmpDir();
  auditSink._setUserDataDirForTest(dir);
  let executed = 0;
  register.handle('add-to-queue', async () => { executed += 1; return { ok: true }; });

  const denied = await handlerOf('ai-assistant-tool-call')('add_to_queue', { song: { id: '1', title: 'x' } }, false);
  assert.deepStrictEqual(denied, { ok: false, error: 'NEED_CONFIRM' });
  assert.strictEqual(executed, 0, '被拒的调用不该执行');

  const allowed = await handlerOf('ai-assistant-tool-call')('add_to_queue', { song: { id: '1', title: 'x' } }, true);
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(executed, 1);

  const items = await auditSink.store().list({ limit: 10 });
  assert.strictEqual(items.length, 1, '被拒的调用不进桥，因此审计只有一行');
  assert.strictEqual(items[0].source, 'assistant');
  assert.strictEqual(items[0].tool, 'add_to_queue');
});

test('未知工具：令牌化拒绝，不碰桥', async () => {
  const r = await handlerOf('ai-assistant-tool-call')('delete_all_playlists', {}, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'UNKNOWN_TOOL');
});

test('参数钳制与外部 Agent 同一条码：超长 keyword 被截到 200', async () => {
  const dir = tmpDir();
  auditSink._setUserDataDirForTest(dir);
  let seen = null;
  register.handle('search-music', async (_e, keyword) => { seen = keyword; return { songs: [] }; });
  const r = await handlerOf('ai-assistant-tool-call')('search_music', { keyword: 'K'.repeat(500) }, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.length, 200, '助手侧的钳制比外部 Agent 松 = 两套规矩');
});

test('没有 API Key：回合通道回 NO_KEY 且不出网', async () => {
  const prefs = require('../src/utils/prefs');
  prefs.set('aiMusicApiKey', '');
  const r = await handlerOf('ai-assistant-plan')([{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(r, { ok: false, error: 'NO_KEY' });
});
```

注意：本文件对 `register.js` 的用法（打桩后 `register.handle(...)` 灌假 handler）与 `test/mcp-e2e.test.js` 里对 `createMcpHandler` 的用法是两条不同路径 —— 前者验**通道这一层**（闸门 + 令牌 + 审计落点），后者验**协议层**（tools/list + 限流）。`handle()` 对同一通道重复注册在桩里是覆盖语义（真实 `ipcMain` 会抛，桩只存 Map），所以本文件里灌假 `add-to-queue` / `search-music` 不会影响别的测试文件（node --test 每个文件一个进程）。

- [x] **Step 5: 跑全链**

Run: `node --test test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js test/ai-assistant-ui.test.js test/confirm-dialog.test.js test/toast-i18n.test.js test/renderer-audit.test.js`
Expected: 全绿。

- [x] **Step 6: 提交**

```bash
git add test/ai-assistant-e2e.test.js test/toast-i18n.test.js test/confirm-dialog.test.js test/renderer-audit.test.js
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "test(assistant): 助手全链 + 五张台账收编 —— 出生即零中文欠账，确认框与侧栏条目跟着动"
```

---

### Task 7: 文档口径 + 推送 + CI

**Files:**
- Modify: `SECURITY.md`（§三 表格「本地服务」行；新增 §4 之外的一小节说明助手与 Agent 同一白名单）
- Modify: `README.md:9`（What's New）与 `:44` 附近（特性清单）
- Modify: `CHANGELOG.md` 的 `## [未发布]`
- Modify: `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`（轨道二状态）

**Interfaces:**
- Consumes: 前 6 个任务的事实（17 工具、3 写操作、MAX_TURNS=3、`source:'assistant'`）
- Produces: 无代码接口

- [x] **Step 1: SECURITY.md**

§三 表格「本地服务」那行的「现状」改为同时覆盖两个 caller：

```
| AI 调用面（外部 Agent + 应用内助手） | MCP 仅监听 `127.0.0.1`，Bearer 令牌 `timingSafeEqual` 比较，Origin 白名单只放行回环，请求体 1 MiB 上限，令牌桶限流（429 + `Retry-After`），工具白名单排除凭据/文件写入/设置/更新安装，写操作在应用内必须逐条确认，调用留审计（`source` 区分 agent/assistant），MCP 服务默认关闭 | `src/main/mcp/`、`src/main/ipc/mcp.js`、`src/main/ipc/ai-assistant.js` |
```

§五 数据边界补一行（助手会向 MiniMax 出网，这是**新的事实**，必须写明）：

```
- 应用内 AI 助手会把你的对话文本与工具返回的歌曲标题发给 MiniMax（`api.minimaxi.com`）；对话与调用记录只存本机，不进 WebDAV 快照与导出备份
```

- [x] **Step 2: README**

`:9` 那条之后新增一条：

```
- **AI 助手（应用内）** — 说一句人话，助手调用本应用自己的 17 个工具去查、去下、去加歌单；写操作逐条要你确认，调用记录进同一份审计
```

- [x] **Step 3: CHANGELOG（`## [未发布]` 的「新增」段末尾追加）**

```markdown
- **应用内 AI 助手**：侧栏新增「AI 助手」页，说人话即可驱动本应用的能力（找歌、查词、入队、加歌单、红心）。
  它用的就是外部 Agent 那 17 个工具，**没有第二套权限**；凡是要改动你曲库或队列的动作，执行前都会弹确认，
  取消就跳过。对话只存在内存，调用记录与 Agent 一起进本机审计（用 `source` 区分是谁调的）。
  需要先在「设置 → AI 音乐」里配置 MiniMax API Key；「AI 创作」页仍是关着的，这个开关不受它管。
```

- [x] **Step 4: roadmap 状态更新**

`docs/superpowers/plans/2026-10-14-ai-program-roadmap.md` 的轨道二条目改为「已落地」并指向本计划与各提交哈希（引用提交用 7 位 short hash，不许写「增量NNN」—— `test/no-increment-numbering.test.js` 连文档一起扫）。

- [x] **Step 5: 五层闸门全跑**

```bash
npm run lint && npm run audit:deps && npm run check:dead-deps \
  && node --test --test-concurrency=2 "test/*.test.js" \
  && npm run build && npm run smoke:asar
```

Expected: lint 0 error（2 条既有 warning）、审计与死依赖检查通过、`node --test` 全绿（本轮净增约 25 枚测试）、build+asar 13/13。

- [ ] **Step 6: 提交、推送、看 CI**

```bash
git add SECURITY.md README.md CHANGELOG.md docs/superpowers/plans/2026-10-14-ai-program-roadmap.md docs/superpowers/plans/2026-10-14-in-app-ai-assistant.md
git -c user.name=CodeBuddy -c user.email=codebuddy@local commit -m "docs(assistant): 助手写进安全边界与变更日志 —— 出网对象、权限口径、确认闸门都说明白"
git -c http.proxy= -c https.proxy= push origin HEAD:main
```

推送后取 token 并轮询（token 只读不打印）：

```bash
TOK=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.github.com/repos/maliang04110233-dot/Lanyue/actions/runs?per_page=3"
```

Expected: 本轮 `CI` run `conclusion: success`。若红，先读 annotation（轨道一已把单测失败暴露成 annotation），不要靠猜。

---

## Self-Review 记录

- **覆盖**：轨道二四个承诺 —— 复用 MCP 工具面（Task 1/2/3：同一张 `tools.js`、同一条桥、同一份审计）、function-calling（Task 4：严格 JSON 协议 + 容错解析，不赌厂商的 tools 字段）、写操作逐条确认（Task 3 闸门 + Task 5 弹层 + Task 6 台账）、不翻 `FEATURES.ai`（Task 3 的入口钉 + Task 5 的 HTML 不挂 `data-feature`）。
- **未纳入本轨道**：智能歌单/打标（轨道三）用同一套 `source` 与审计，但它的批处理入口与 LLM 用量预算不在本计划里；CI 归因（轨道四）与本轨道无文件冲突（只碰 `.github/workflows/` 与新脚本）。
- **已知取舍**：① 编排循环在渲染层 —— 换来的是「确认框只有 UI 拿得到」这条物理事实下最少的机制，代价是助手页要自己管 `MAX_TURNS`；② `assistantChat` 复用 MiniMax 现端点而非引入 provider SDK —— 零依赖路线，且换上游只需改一个函数；③ 严格 JSON 协议在弱模型上会退化成「只出不含 steps 的话」，这时功能不回归（用户看到话、界面无动作），比误执行安全。
- **实施中发现的依赖倒置**：Task 3 的 handler require 了 Task 4 才建的 `aiAssistantService`，Step 6 已写明「需要就现在把 Task 4 的 Step 3/4 做完」，不留半截可红状态。
