# 助手 → AI Agent 升级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把应用内 AI 助手改造成一个有更大工具面、按风险分层决定确认形态、能交整份计划并一次批准的 agent 循环。

**Architecture:** 工具定义只有一处（`src/main/mcp/tools.js` 的登记表），每项带 `risk`（read/write/destructive）与 `audience`（both/app）；外部 MCP Agent 拿过滤后的视图，应用内助手拿全量。执行仍走同一条进程内桥（`agentBridge.js`），确认闸门仍长在的主进程 handler 上，只是判据从 `mutating` 换成 `risk` + 新增的 `scope` 参数。渲染层新增「计划卡」把逐步弹改成整份批准，危险步骤仍单独弹。

**Tech Stack:** Node 22/24（无新依赖）、Electron（主/渲染两层）、`node:test` + `assert`、自研 fake-dom 视图测试替身（本仓无 jsdom）、GitHub Actions windows-latest。

**Spec:** `docs/superpowers/specs/2026-10-15-ai-agent-design.md`

## Global Constraints

- 风险枚举只有三档：`read` | `write` | `destructive`（spec 已砍掉 `billable`，计费工具本轮不进登记表）。
- 外部 MCP Agent 可见面 = `audience==='both' && risk!=='destructive'`；「查询 + 加法动作」这条既有纪律不许放宽。
- **永不进登记表**（spec 第二节列全）：cookie/登录五条、`set-pref`、`ai-provider-save`、`mcp-set-config`、`cloud-sync-config-set`、`import-all-data`、`export-all-data`、`check-for-update`/`download-update`/`restart-and-install`、`system-power`、`open-external`/`open-folder`/`select-dir`、`delete-file`/`rename-file`/`update-id3-tags`/`update-id3-cover`/`write-local-lrc`、`ai-generate-*`、`save-play-queue`、`set-search-history`。
- 主进程回给渲染层的失败**只回 ASCII 令牌**（`NEED_CONFIRM`/`UNKNOWN_TOOL`/`AGENT_SCOPE_MISMATCH`/`APP_ONLY`/…），中文句子的家在 `src/renderer/js/lang/zh.json` 与 `en.json`。
- 界面文本一律 `textContent` 上屏；模型给的任何文本（含新增的 `why`）不许进 `innerHTML`。
- 每回合出网的状态段仍只有 `title/artist/source/id/quality`：歌词与本地路径不出网（既有纪律，由 `test/ai-assistant-context.test.js` 钉着）。
- 不加任何 npm 依赖；不出网跑真请求、不碰用户的 API Key（真供应商那五条金路只能用户本人点）。
- **不 tag、不发版。**
- 提交：`git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "…" -- <显式路径>`；**永不 `git add -A`**（`F:\新建文件夹\` 下还有 15+ 个仓库）。
- 推送一律 `git push origin HEAD:main`（本地分支名是 `release/1.0.36`，推它会白生一个远端分支）。直连失败立刻改 `-c http.proxy=http://127.0.0.1:10809 -c https.proxy=http://127.0.0.1:10809`，不重复探测。
- 每期的收口判据：`npm run lint` + `npm test` 全绿 → 推送 → 用 `https://api.github.com/repos/maliang04110233-dot/Lanyue/commits/<full-sha>/check-runs`（匿名可读，要带 `User-Agent` 头）确认 **Lint & Unit Tests** 与 **Build & Asar Smoke** 两条都 `success`，才许进下一期。

### 工作区注意（动手前先读）

本机工作区里**另一个 session 正在改**这些文件：`src/shared/ipcContract.js`、`test/ipc-contract.test.js`、`package.json`、`package-lock.json`、`src/main/index.js`、`src/renderer/index.html`、`src/renderer/js/app.js`、`src/renderer/js/lang/zh.json`、`src/renderer/js/lang/en.json`、`.github/workflows/ci.yml`、`scripts/*`，并新增了 `songStory*` / `tasteProfile*` 一组文件。

- 那些内容与本计划无关，**不许回退、不许提交、不许改名**。
- 当本计划也要改其中一份（`ipcContract.js` 与两份词典几乎必然撞上），暂存走「HEAD + 自己那一行」配方，别把别人的行一起提交：

```bash
# 1) 先把当前工作区（含别人的改动）整份备份出来
cp src/shared/ipcContract.js /tmp/ipcContract.worktree.bak
# 2) 只提交 HEAD + 本计划那一行：取 HEAD 版本，手工改本计划那一行，暂存
git show HEAD:src/shared/ipcContract.js > src/shared/ipcContract.js
#    （此时用编辑器/脚本把那行改掉，见各任务的代码块）
git add src/shared/ipcContract.js
git diff --cached --stat   # 必须是 1 insertion / 1 deletion，多了就是撞了别人的行
# 3) 把备份原样放回去，别人的改动一个字节都不丢
cp /tmp/ipcContract.worktree.bak src/shared/ipcContract.js
git status --porcelain -- src/shared/ipcContract.js   # 期望：MM（暂存我的 + 工作区还有别人的）
```

- `npm test` 里若出现 `METHODS` 数量、`getSongStory` 之类的红灯，先 `git stash list` 之外**别 stash**（本仓 CRLF 有坑），改用「只跑自己那几枚测试文件 + 在干净树里跑全量（CI 就是干净树）」取证。

## 文件结构（本计划动的东西与各自职责）

| 文件 | 职责 | 期 |
|---|---|---|
| `src/main/mcp/tools.js` | 登记表 + 派生视图：`risk`/`audience`/`mutating` 的唯一出处；`toolsForSource(source)` 决定谁能看见什么 | P1 P2 P3 |
| `src/main/mcp/agentBridge.js` | 装配点：按 caller 身份取工具面 | P1 |
| `src/main/mcp/mcpCore.js` | JSON-RPC 分发；只在 `source==='assistant'` 时接受 `params.auditContext` | P2 |
| `src/main/ipc/ai-assistant.js` | 三条助手通道；**确认闸在这里**；出网脱敏在这里 | P1 P2 P3 |
| `src/shared/outboundScrub.js` | 新增：工具返回值里哪些键不许发给厂商（第二条出网路的闸） | P1 |
| `src/shared/ipcContract.js` | `ai-assistant-tool-call` 加 `scope`/`runId` 两个位置参数 | P2 |
| `src/api/services/aiAssistantService.js` | 协议解析与提示拼装：steps 带 `why`、步数上限、规则段 | P2 |
| `src/renderer/js/assistantPlanCard.js` | 新增：一张纯渲染的计划卡（不含业务、不含取词） | P2 |
| `src/renderer/js/views/ai-assistant.js` | agent 循环：批准形态、整局预算、止损、app 工具执行 | P2 P3 |
| `src/renderer/js/lang/zh.json` / `en.json` | 全部新文案 | P1 P2 P3 |
| `test/agent-tool-registry.test.js` | 新增：登记表形状与两侧视图的门禁 | P1 |
| `test/outbound-scrub.test.js` | 新增：脱敏闸 | P1 |
| `test/ai-assistant-plan-card.test.js` | 新增：计划卡行为 | P2 |
| `test/ai-assistant-agent-loop.test.js` | 新增：循环（批确认、单项确认、预算、止损） | P2 P3 |
| `test/helpers/assistant-boot.js` | 新增：把 `ai-assistant-context.test.js` 里的 `boot()` 抽成公用件 | P2 |

---

# 第一期 P1：地基（风险字段）+ 只读扩面 + 脱敏闸

## Task 1: 登记表加 `risk` / `audience`，`mutating` 改为派生

**Files:**
- Modify: `src/main/mcp/tools.js:18-118`（17 条条目）、`src/main/mcp/tools.js:139-165`（派生函数与导出）
- Test: `test/agent-tool-registry.test.js`（新建）

**Interfaces:**
- Consumes: 无（起点）
- Produces: `RISK_LEVELS`（`string[]`）、`AUDIENCES`（`string[]`）、`toolsFromContract()` 的产物每项多出 `risk`、`audience` 两字段，`mutating` 变成 `risk !== 'read'`

- [ ] **Step 1: 写失败的测试**

新建 `test/agent-tool-registry.test.js`：

```js
/**
 * 工具登记表的形状（P1 起）—— risk/audience 是两侧闸的唯一判据。
 *
 * mutating 从手写改成派生，是因为「一份数据两个出处」正是这类闸最典型的漂法：
 * 以后加一条工具只写 risk 忘了 mutating，闸门就会对着一个 false 放行写操作。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AGENT_TOOLS, RISK_LEVELS, AUDIENCES, toolsFromContract } = require('../src/main/mcp/tools');

test('每条工具都带合法 risk/audience，且 mutating 由 risk 派生', () => {
  for (const def of toolsFromContract()) {
    assert.ok(RISK_LEVELS.includes(def.risk), `${def.name} 的 risk 非法: ${def.risk}`);
    assert.ok(AUDIENCES.includes(def.audience), `${def.name} 的 audience 非法: ${def.audience}`);
    assert.strictEqual(def.mutating, def.risk !== 'read', `${def.name}: mutating 与 risk 在各自说话`);
  }
});

test('工具名唯一、通道也唯一（两条工具指向同一通道就是重复暴露）', () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  assert.strictEqual(new Set(names).size, names.length, `工具有重名: ${names.join(',')}`);
  const chans = AGENT_TOOLS.filter((t) => t.channel).map((t) => t.channel);
  assert.strictEqual(new Set(chans).size, chans.length, '两条工具指向同一通道');
});

test('改造不许悄悄改面：今天恰 17 条、其中 3 条非只读', () => {
  const defs = toolsFromContract();
  assert.strictEqual(defs.length, 17);
  assert.deepStrictEqual(defs.filter((d) => d.mutating).map((d) => d.name).sort(),
    ['add_to_playlist', 'add_to_queue', 'toggle_favorite']);
});

test('risk 非法或漏写时派生直接抛，不许静默当只读', () => {
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms' }]), /risk/);
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms', risk: 'danger' }]), /risk/);
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms', risk: 'read', audience: 'weird' }]), /audience/);
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/agent-tool-registry.test.js`
Expected: FAIL —— `RISK_LEVELS` 是 undefined（`Cannot read properties of undefined (reading 'includes')`）且第 4 枚断言不抛。

- [ ] **Step 3: 最小实现**

在 `src/main/mcp/tools.js` 顶部注释的「白名单纪律」那段之后补两行说明（保留原有措辞），然后：

```js
const RISK_LEVELS = ['read', 'write', 'destructive'];
const AUDIENCES = ['both', 'app'];
```

给现有 17 条条目各加一行 `risk`：14 条查询类（`search_music`、`ai_search_music`、`get_lyrics`、`parse_link`、`search_singer`、`search_album`、`get_singer_songs`、`get_album_songs`、`get_playlist_songs`、`list_platforms`、`source_health`、`query_history`、`history_stats`、`list_playlists`）加 `risk: 'read',`；`add_to_queue`、`add_to_playlist`、`toggle_favorite` 三条把原 `mutating: true,` 换成 `risk: 'write',`。

改 `toolsFromContract` 的 map 体（原来只校验通道，现在先校验分层）：

```js
function toolsFromContract(list = AGENT_TOOLS, channels = CHANNELS) {
  return list.map(tool => {
    if (!RISK_LEVELS.includes(tool.risk)) {
      throw new Error(`[mcp] 工具 ${tool.name} 的 risk 非法: ${String(tool.risk)}（只能是 ${RISK_LEVELS.join('/')}）`);
    }
    const audience = tool.audience || 'both';
    if (!AUDIENCES.includes(audience)) {
      throw new Error(`[mcp] 工具 ${tool.name} 的 audience 非法: ${String(audience)}（只能是 ${AUDIENCES.join('/')}）`);
    }
    const entry = channels[tool.channel];
    if (!entry || !(entry.invoke || []).includes('main')) {
      throw new Error(`[mcp] 工具 ${tool.name} 的通道不是 main invoke: ${tool.channel}`);
    }
    // …（properties 拼装那段一字不动）
    const tdef = {
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties },
      channel: tool.channel,
      risk: tool.risk,
      audience,
      // 派生而不是手写：一份判据只许有一个出处
      mutating: tool.risk !== 'read',
    };
    if (tool.required && tool.required.length) tdef.inputSchema.required = tool.required;
    return tdef;
  });
}
```

删掉原第 163 行的 `MUTATING_TOOL_NAMES`（它由 `AGENT_TOOLS.filter(t => t.mutating)` 造出来，而那些条目已不再有手写 `mutating`），改由派生视图给：

```js
const MUTATING_TOOL_NAMES = new Set(toolsFromContract().filter(t => t.mutating).map(t => t.name));

module.exports = {
  AGENT_TOOLS, MUTATING_TOOL_NAMES, TOOLS_VERSION_HINT: '2025-03-26',
  toolsFromContract, specToJsonSchema, RISK_LEVELS, AUDIENCES,
};
```

顺手把文件头注释里「mutating 标记」那两行改成：

```
 *   - risk 分层（唯一判据）：read 只读 / write 改数据但可逆 / destructive 删、清空、覆盖盘
 *   - mutating 由 risk 派生（risk !== 'read'）：谁都不许再手写它，两处各写一遍迟早飘
 *   - audience：both = 主进程有 handler、两侧都能执行；app = 只能在渲染层执行（播放控制）
```

- [ ] **Step 4: 跑到绿（含既有测试不许坏）**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-gate.test.js test/ai-assistant-e2e.test.js test/mcp-agent-bridge.test.js test/mcp-e2e.test.js`
Expected: 全绿。若 `mcp-e2e` 断言了 `tools/list` 的字段集合，按 Step 3 的新形状改它并说明为什么。

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 5: 提交**

```bash
git add test/agent-tool-registry.test.js
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "refactor(mcp): 工具登记表有了 risk/audience 两层标记，mutating 改成从 risk 派生 —— 一份判据只留一个出处" -- src/main/mcp/tools.js test/agent-tool-registry.test.js
```

## Task 2: 按 caller 身份给视图（外部 Agent 看不到 destructive / app-only）

**Files:**
- Modify: `src/main/mcp/tools.js`（新增两函数并导出）
- Modify: `src/main/mcp/agentBridge.js:29-38`
- Test: `test/agent-tool-registry.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `toolsFromContract()` 形状
- Produces: `visibleToAgent(def) => boolean`、`toolsForSource(source, list?, channels?) => Array`

- [ ] **Step 1: 写失败的测试**

追加到 `test/agent-tool-registry.test.js`：

```js
const { toolsForSource, visibleToAgent } = require('../src/main/mcp/tools');

// 合成条目用假 channels：这里测的是过滤判据，不是契约形状（契约形状 Step 1 那几枚已经钉过）
const CH = { 'get-platforms': { invoke: ['main'], args: [] } };
const SYNTH = [
  { name: 'r', channel: 'get-platforms', description: '只读', risk: 'read' },
  { name: 'w', channel: 'get-platforms', description: '可逆写', risk: 'write' },
  { name: 'd', channel: 'get-platforms', description: '删除', risk: 'destructive' },
  { name: 'a', channel: 'get-platforms', description: '只能在渲染层', risk: 'write', audience: 'app' },
];

test('外部 Agent 的面 = 主进程可执行且不是 destructive（「查询 + 加法动作」一字不放宽）', () => {
  assert.deepStrictEqual(toolsForSource('agent', SYNTH, CH).map((t) => t.name), ['r', 'w']);
});

test('应用内助手看得见全部（含 destructive 与 app-only），确认形态才轮得到界面去决定', () => {
  assert.deepStrictEqual(toolsForSource('assistant', SYNTH, CH).map((t) => t.name), ['r', 'w', 'd', 'a']);
});

test('判据只有一处：visibleToAgent 与 toolsForSource("agent") 对同一条给出同一个答案', () => {
  for (const def of toolsFromContract()) {
    assert.strictEqual(visibleToAgent(def), toolsForSource('agent').some((x) => x.name === def.name),
      `${def.name} 的两侧视图与判据不一致`);
  }
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/agent-tool-registry.test.js`
Expected: FAIL —— `toolsForSource is not a function`。

- [ ] **Step 3: 最小实现**

`src/main/mcp/tools.js` 里 `toolsFromContract` 之后加：

```js
/**
 * 外部 Agent 能看到的工具 —— 判据只有这一处。
 * destructive（删、清空）与 app（主进程根本没法执行）都不给：前者外部 Agent 的可信度
 * 撑不起「一次批准就跑删除」，后者给它是个永远调用不通的工具名。
 */
function visibleToAgent(def) {
  return def.audience === 'both' && def.risk !== 'destructive';
}

/** @param {'agent'|'assistant'} source */
function toolsForSource(source, list = AGENT_TOOLS, channels = CHANNELS) {
  const all = toolsFromContract(list, channels);
  return source === 'agent' ? all.filter(visibleToAgent) : all;
}
```

导出加上 `visibleToAgent, toolsForSource`。`src/main/mcp/agentBridge.js` 改为按身份取面：

```js
const { toolsForSource } = require('./tools');
…
function createAgentBridge({ source, serverVersion = '0.0.0', onCall = null }) {
  return createMcpHandler({
    // 外部 Agent 与助手共用这一处装配，但**面按 caller 身份过滤**：
    // destructive 与 app-only 连 byName 都进不去，指名调用它们拿到的是「未知工具」，
    // 而不是「看得见但调不动」——少一处能被绕开的地方。
    tools: toolsForSource(source),
    callTool,
    source,
    serverVersion,
    onCall: onCall || ((entry) => { auditSink.record(entry); }),
  });
}
```

- [ ] **Step 4: 跑到绿**

Run: `node --test test/agent-tool-registry.test.js test/mcp-e2e.test.js test/mcp-agent-bridge.test.js test/mcp-audit-wiring.test.js`
Expected: 全绿（`tools/list` 的 17 条现在对两侧都还是 17 条，因为 P1 尚无 destructive/app-only 条目 —— 这枚事实由 `test/mcp-e2e.test.js` 的目录断言继续守住，别放宽它）。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(mcp): 工具面按 caller 身份过滤 —— destructive 与只在渲染层执行的那些，外部 Agent 连名字都拿不到" -- src/main/mcp/tools.js src/main/mcp/agentBridge.js test/agent-tool-registry.test.js
```

## Task 3: 只读扩面（4 条新工具）

**Files:**
- Modify: `src/main/mcp/tools.js`（查询区末尾插入 4 条）
- Modify: `test/agent-tool-registry.test.js`（计数钉）、`test/ai-assistant-ui.test.js:89`（17 那枚）、`test/ai-assistant-e2e.test.js:73-77`（目录那枚）
- Test: 同 `test/ai-assistant-e2e.test.js`

**Interfaces:**
- Consumes: Task 1/2 的形状
- Produces: 新工具名 `list_subscriptions`、`list_download_templates`、`get_play_queue`、`aggregate_library`

- [ ] **Step 1: 写失败的测试**

`test/ai-assistant-e2e.test.js` 里把「目录：17 个工具…」那枚整体换成下面这版（非只读集合仍只有原三条 —— P1 只加只读，这条断言就是「P1 没顺手放宽」的证据）：

```js
test('目录：21 个工具且恰好 3 个非只读（P1 只加只读面）', async () => {
  const r = await handlerOf('ai-assistant-tools')();
  assert.strictEqual(r.tools.length, 21);
  assert.deepStrictEqual(r.tools.filter(t => t.mutating).map(t => t.name).sort(),
    ['add_to_playlist', 'add_to_queue', 'toggle_favorite']);
  assert.deepStrictEqual(r.tools.filter(t => t.risk === 'destructive').map(t => t.name), [],
    'P1 不该出现 destructive');
});
```

`test/agent-tool-registry.test.js` 里那枚「今天恰 17 条」改成 21 条并补点名：

```js
test('P1 新增的只读面：订阅、模板、播放队列、聚合曲库', () => {
  const defs = toolsFromContract();
  for (const n of ['list_subscriptions', 'list_download_templates', 'get_play_queue', 'aggregate_library']) {
    const d = defs.find((x) => x.name === n);
    assert.ok(d, `少了 ${n}`);
    assert.strictEqual(d.risk, 'read', `${n} 必须是只读`);
    assert.strictEqual(d.audience, 'both', `${n} 主进程有 handler，两侧都能给`);
  }
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js`
Expected: FAIL —— 数量 17 ≠ 21、`少了 list_subscriptions`。

- [ ] **Step 3: 最小实现**

在 `tools.js` 的 `list_playlists` 条目之后插入（描述里如实写明「路径不回给你」，那不是客套而是 Task 4 那道闸的行为契约）：

```js
  {
    name: 'list_subscriptions', channel: 'subscribe-list', risk: 'read',
    description: '列出用户订阅的歌手/歌单/账号订阅项。',
  },
  {
    name: 'list_download_templates', channel: 'get-download-templates', risk: 'read',
    description: '列出下载目录模板与当前启用项。模板的存储路径不会回给你（本机路径不出网），只看得到名字与是否 active。',
  },
  {
    name: 'get_play_queue', channel: 'load-play-queue', risk: 'read',
    description: '读持久化的播放队列（上次会话留下的那份）。返回 {queue:[{id,source,title,artist,…}]}。',
  },
  {
    name: 'aggregate_library', channel: 'aggregate-cross-source', risk: 'read',
    description: '跨源聚合用户的自建歌单与红心单。opts:{markDuplicates:boolean}。返回按曲目合并的清单。',
    paramDocs: { opts: '聚合选项对象' },
  },
```

- [ ] **Step 4: 跑到绿**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js test/ai-assistant-ui.test.js test/ai-assistant-gate.test.js test/mcp-e2e.test.js`
Expected: 全绿。`test/ai-assistant-ui.test.js:89` 那枚 `AGENT_TOOLS.length` 改成 21，并在同一次改动里确认 SECURITY/README 的口径由 Task 5 一起改（那枚钉的报错文案就是提醒这件事）。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(mcp): 订阅、下载模板、播放队列、跨源聚合四条只读能力进了登记表 —— 助手与外部 Agent 同时能看到" -- src/main/mcp/tools.js test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js test/ai-assistant-ui.test.js
```

## Task 4: 第二条出网路的闸（工具返回值脱敏）

**Files:**
- Create: `src/shared/outboundScrub.js`
- Modify: `src/main/ipc/ai-assistant.js:79-83`
- Test: `test/outbound-scrub.test.js`（新建）

**Interfaces:**
- Consumes: `ai-assistant-tool-call` 里桥返回的 `text`（`mcpCore` 保证是 `JSON.stringify` 的产物）
- Produces: `LEAK_KEYS`（`string[]`）、`scrubOutbound(value)`、`scrubToolText(text) => string`

- [ ] **Step 1: 写失败的测试**

新建 `test/outbound-scrub.test.js`：

```js
/**
 * 发给厂商的文本里不许出现本机路径与凭据（spec 第五节）。
 *
 * 为什么要一道新闸而不是「渲染层少塞点」：上下文那条出网路（_appContext）已经守住了
 * 歌词与本地路径，但工具返回值是**第二条**路 —— 返回值由主进程的 handler 产出，
 * 形状不归界面管（聚合曲库与播放队列里每条都可能带 path/localPath）。
 * 判据放在桥的出口一处：这样加新工具不必各自记得剥，也不存在「剥了两份、各漏一处」。
 *
 * 刻意不含 `lyric`：`get_lyrics` 的存在理由就是把歌词取回来给用户看，
 * 把它一起剥掉是砍功能不是堵泄漏。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LEAK_KEYS, scrubOutbound, scrubToolText } = require('../src/shared/outboundScrub');

test('键名黑名单是那份唯一清单，且都是「本机路径 / 凭据」类', () => {
  for (const k of ['path', 'localPath', 'filePath', 'dir', 'cookie', 'token', 'apiKey', 'secret']) {
    assert.ok(LEAK_KEYS.includes(k), `少了 ${k}`);
  }
  assert.ok(!LEAK_KEYS.includes('lyric'), 'get_lyrics 的正文不许被剥');
});

test('递归剥：数组里、嵌套对象里的黑名单键一律消失', () => {
  const out = scrubOutbound({
    queue: [{ title: '晚风', path: 'D:\\MUSIC\\a.mp3', nested: { localPath: 'D:\\b.mp3', id: 7 } }],
    active: { name: '默认', dir: 'D:\\MUSIC' },
  });
  const text = JSON.stringify(out);
  assert.ok(!/D:\\\\MUSIC/.test(text), text);
  assert.ok(text.includes('晚风') && text.includes('"id":7'), '该留的业务字段被一起剥了');
});

test('不改动原对象（审计与真 handler 的返回值还要用）', () => {
  const src = { songs: [{ title: 'x', path: 'D:\\p' }] };
  scrubOutbound(src);
  assert.strictEqual(src.songs[0].path, 'D:\\p', '脱敏写回了原对象');
});

test('不是 JSON 就当没有可读：回空串，不许把原文丢给厂商', () => {
  assert.strictEqual(scrubToolText('这不是 JSON，里面有 D:\\SECRET.mp3'), '');
});

test('出口只走 scrubToolText：解析成功给脱敏后的 JSON 文本', () => {
  assert.deepStrictEqual(JSON.parse(scrubToolText('{"songs":[{"title":"晚风","localPath":"D:\\a.mp3"}]}')),
    { songs: [{ title: '晚风' }] });
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/outbound-scrub.test.js`
Expected: FAIL —— `Cannot find module '../src/shared/outboundScrub'`。

- [ ] **Step 3: 最小实现**

新建 `src/shared/outboundScrub.js`（头注抄上面测试文件里那段「为什么」的四行要点，别复制整段）：

```js
'use strict';
/** 发给大模型厂商的文本里不许出现的键名（本机路径与凭据类）。唯一出处。 */
const LEAK_KEYS = ['path', 'localPath', 'filePath', 'dir', 'cookie', 'cookies', 'token', 'accessToken', 'apiKey', 'secret'];

function scrubOutbound(value) {
  if (Array.isArray(value)) return value.map(scrubOutbound);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (LEAK_KEYS.includes(k)) continue;
      out[k] = scrubOutbound(v);
    }
    return out;
  }
  return value;
}

/**
 * 桥返回的 text 是 JSON 文本；解析不动就回空串 —— 一条读不出来的返回值
 * 不该带着看不见的原文出网。截断仍由调用方那枚 8000 的闸管，这里只负责剥。
 */
function scrubToolText(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  try {
    return JSON.stringify(scrubOutbound(JSON.parse(text)));
  } catch (_e) {
    return '';
  }
}

module.exports = { LEAK_KEYS, scrubOutbound, scrubToolText };
```

`src/main/ipc/ai-assistant.js`：顶部 `require` 加 `const { scrubToolText } = require('../../shared/outboundScrub');`，把原来那段

```js
    const content = (result && result.content && result.content[0]) || null;
    const text = content ? String(content.text || '') : '';
```

改成

```js
    const content = (result && result.content && result.content[0]) || null;
    // 工具返回值是第二条出网路：它下一步就要进模型上下文，所以在本进程就剥干净，
    // 不留给渲染层「记得剥」这件事（它会）。外部 Agent 那条不剥——那是本机程序在读本机数据。
    const text = scrubToolText(content ? String(content.text || '') : '');
```

- [ ] **Step 4: 跑到绿（含真 handler 的既有形状）**

Run: `node --test test/outbound-scrub.test.js test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js test/mcp-agent-bridge.test.js`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 工具返回值出网前先过一道脱敏 —— 本机路径与凭据类键只在一个出口被剥掉" -- src/shared/outboundScrub.js src/main/ipc/ai-assistant.js test/outbound-scrub.test.js
```

## Task 5: P1 收口（文档 + 本地全量闸门 + CI 取证）

**Files:**
- Modify: `SECURITY.md`（第五节助手那条 bullet 与第六节自查清单）
- Modify: `CHANGELOG.md`（`[未发布] → 新增`）
- Modify: `README.md`（助手条目）

**Interfaces:**
- Consumes: P1 的 21 条工具面与脱敏闸
- Produces: 与代码同口径的文档；一枚可推的提交

- [ ] **Step 1: 写文档（先写，让它对着代码找不齐的地方）**

`SECURITY.md` 第五节里助手那条 bullet 之后补一条：

```markdown
- 助手在 P1（2026-10-15）起还多出四条**只读**能力：订阅列表、下载目录模板、持久化播放队列、
  跨源聚合曲库。它们的返回值在发给厂商前先过一道键名闸（`src/shared/outboundScrub.js`）：
  `path/localPath/filePath/dir/cookie/token/apiKey/secret` 一律剥掉，所以
  **模板的存储路径不会出现在发给厂商的文本里**。歌词正文不在闸内（`get_lyrics` 的存在理由就是取歌词）
```

第六节加一段：

```markdown
工具返回值与应用状态摘要是**两条**出网路，两处都不带本机文件路径；
新增只读工具时脱敏不用重写（闸在主进程出口一处），新增**写**工具才需要重新想确认形态。
```

`CHANGELOG.md` 的 `[未发布] → 新增` 里加一条（口径写「四条只读」与「模板路径不回给模型」）；`README.md` 助手那条补一句「现在它还能读订阅、下载模板、播放队列与跨源聚合的曲库」。

- [ ] **Step 2: 全量本地闸门**

Run: `npm run lint` → 无 error
Run: `npm test` → 全绿（若红灯属于另一 session 的 `ipc-contract`/`songStory`，按「工作区注意」取证：记下红灯文件名与报错，用 `git show HEAD:<file>` 版跑一遍证明与本计划无关，别去改它）
Run: `npm run build && npm run smoke:asar` → 绿

- [ ] **Step 3: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "docs(security,changelog): P1 的四条只读面与那条出网闸写进文档 —— 模板路径不回给模型这件事得有个地方说清" -- SECURITY.md CHANGELOG.md README.md
```

- [ ] **Step 4: 推送并取 runner 证据**

```bash
git push origin HEAD:main   # 失败就换代理那条，见 Global Constraints
node -e "/* 用 full sha 打一次 check-runs，两条 job 都要 success */"
```

Expected: `Lint & Unit Tests` 与 `Build & Asar Smoke` 均 `success`，annotation 只剩 warning。
把「两条 job + full sha」记进 `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md` 新增的轨道五那行（若该行还没有，就在表里加一行指向本计划文件）。

---

# 第二期 P2：风险闸 + 计划卡 + 整局预算

## Task 6: 契约加 `scope`，主进程闸改成按 `risk` 判

**Files:**
- Modify: `src/shared/ipcContract.js:194`（`ai-assistant-tool-call` 那行；**共享文件，按配方暂存**）
- Modify: `src/main/ipc/ai-assistant.js:67-84`
- Modify: `test/ai-assistant-gate.test.js:31-36`（那枚钉着 `tool.mutating && confirmed !== true` 的）
- Test: `test/ai-assistant-e2e.test.js`（追加风险闸四路）

**Interfaces:**
- Consumes: Task 1 的 `risk`
- Produces: `ai-assistant-tool-call` 的位置参数变成 `(name, args, confirmed, scope)`；新令牌 `AGENT_SCOPE_MISMATCH`

- [ ] **Step 1: 写失败的测试**

追加进 `test/ai-assistant-e2e.test.js`（先给登记表塞一条 destructive 的合成工具不方便，所以这里用真实的 `clear-all-queue` 通道 + 在 Step 3 之后才存在的工具？不行 —— 本任务不新增工具。做法：用 `toolsFromContract()` 传进来的合成表测**闸函数**，闸从 handler 里抽出来）：

```js
test('风险闸（纯函数）：read 无条件、write 要 confirmed、destructive 还要 scope=single', () => {
  const { gateAssistantCall } = require('../src/main/ipc/assistantGate');
  const R = (risk, audience) => ({ name: 'x', risk, audience: audience || 'both' });
  assert.strictEqual(gateAssistantCall(R('read'), { confirmed: false, scope: 'single' }), null);
  assert.strictEqual(gateAssistantCall(R('write'), { confirmed: false }), null === null ? 'NEED_CONFIRM' : '',
    'write 无确认必须拒');
  assert.strictEqual(gateAssistantCall(R('write'), { confirmed: true, scope: 'batch' }), null);
  assert.strictEqual(gateAssistantCall(R('destructive'), { confirmed: true, scope: 'batch' }), 'AGENT_SCOPE_MISMATCH');
  assert.strictEqual(gateAssistantCall(R('destructive'), { confirmed: true, scope: undefined }), 'AGENT_SCOPE_MISMATCH',
    '没声明 scope 的裸调用不许当成单项确认');
  assert.strictEqual(gateAssistantCall(R('destructive'), { confirmed: true, scope: 'single' }), null);
  assert.strictEqual(gateAssistantCall(R('write', 'app'), { confirmed: true, scope: 'single' }), 'APP_ONLY');
});
```

> 上面第二枚用 `null === null ? 'NEED_CONFIRM' : ''` 只是为了把「必须拒」写在同一行读得顺；执行时按 Step 1 的实际语义写成 `assert.strictEqual(gateAssistantCall(R('write'), { confirmed: false }), 'NEED_CONFIRM')`。

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-e2e.test.js`
Expected: FAIL —— `Cannot find module '../src/main/ipc/assistantGate'`。

- [ ] **Step 3: 实现闸 + 接线 + 契约**

新建 `src/main/ipc/assistantGate.js`：

```js
/**
 * 助手工具调用的确认闸（纯函数，主进程侧唯一的判据）
 *
 * 抽成函数而不是写在 handler 里，是因为它的四种组合必须能被逐条断言 ——
 * 写在 handler 里就得为了测一个分支去起整条桥。
 * 返回 null = 放行；返回字符串 = ASCII 令牌，由渲染层查词典成人话。
 */
function gateAssistantCall(tool, { confirmed, scope }) {
  if (tool.audience === 'app') return 'APP_ONLY';   // 主进程没有执行它的能力
  if (tool.risk !== 'read' && confirmed !== true) return 'NEED_CONFIRM';
  // destructive 只认单项确认：批量令牌换不到「删/清空」。真 IPC 路径下 scope 缺省是
  // 'single'（契约里 t.enum 的默认值），所以 undefined 只可能来自绕过契约的裸调用 —— 拒。
  if (tool.risk === 'destructive' && scope !== 'single') return 'AGENT_SCOPE_MISMATCH';
  return null;
}

module.exports = { gateAssistantCall };
```

`src/main/ipc/ai-assistant.js`：

```js
  handle('ai-assistant-tool-call', async (_, name, args, confirmed, scope) => {
    const tool = toolsFromContract().find(t => t.name === name);
    if (!tool) return { ok: false, error: 'UNKNOWN_TOOL' };
    const deny = gateAssistantCall(tool, { confirmed, scope });
    if (deny) return { ok: false, error: deny };
    // …（下面桥调用那几行一字不动）
```

`src/shared/ipcContract.js` 那一行（用「工作区注意」的暂存配方改这一行）：

```js
  'ai-assistant-tool-call': { invoke: MAIN, args: [['name', t.str(64)], ['args', t.obj()], ['confirmed', t.bool()], ['scope', t.enum(['single', 'batch'], 'single')]] },
```

`test/ai-assistant-gate.test.js` 那枚「确认闸门长在 handler 里」改成：

```js
test('确认闸门在主进程且按 risk 判：判据只有一处', () => {
  assert.match(ASSISTANT, /gateAssistantCall\(tool, \{ confirmed, scope \}\)/, 'handler 没调用那道闸');
  assert.match(ASSISTANT, /error: deny/, '拒了要回令牌');
  assert.ok(!/askConfirm/.test(ASSISTANT), '主进程不该出现确认框：确认是 UI 的事');
  const gate = read('src/main/ipc/assistantGate.js');
  assert.match(gate, /tool\.risk !== 'read' && confirmed !== true/, 'write 的确认判据不在了');
  assert.match(gate, /scope !== 'single'/, '批量令牌换不到 destructive 的那道拒不在场');
});
```

- [ ] **Step 4: 跑到绿**

Run: `node --test test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js test/ipc-contract.test.js`
Expected: 全绿。`test/ipc-contract.test.js` 若报参数数量与 handler 形参不符，说明 Step 3 的形参少写了 `scope`。

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/assistantGate.js test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js
# ipcContract 那一行走「HEAD + 自己那一行」配方单独暂存
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 确认闸从 mutating 布尔升级成 risk + scope 两把 —— 批量令牌换不到删除与清空" -- src/main/ipc/assistantGate.js src/main/ipc/ai-assistant.js src/shared/ipcContract.js test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js
```

## Task 7: 审计带上 scope / risk / runId（外部 caller 不许伪造）

**Files:**
- Modify: `src/main/mcp/mcpCore.js:86-108`
- Modify: `src/main/ipc/ai-assistant.js`（第 5 个位置参数 `runId` 与 `params.auditContext`）
- Modify: `src/shared/ipcContract.js`（`ai-assistant-tool-call` 那行加 `['runId', t.str(32)]`）
- Test: `test/ai-assistant-e2e.test.js`、`test/mcp-e2e.test.js`

**Interfaces:**
- Consumes: Task 6 的 `scope`
- Produces: 审计条目多出 `scope` / `risk` / `runId` 三个字段，且仅 `source==='assistant'` 时接受

- [ ] **Step 1: 写失败的测试**

追加进 `test/ai-assistant-e2e.test.js`：

```js
test('审计里能看出「这一步是谁批准的、什么形态、几档风险、哪一轮」', async () => {
  auditSink._setUserDataDirForTest(tmpDir());
  register.handle('add-to-queue', async () => ({ ok: true }));
  await handlerOf('ai-assistant-tool-call')('add_to_queue', { song: { id: '1', title: 'x' } }, true, 'batch', 'run-42');
  const items = await flushAudit();
  assert.strictEqual(items[0].scope, 'batch');
  assert.strictEqual(items[0].risk, 'write');
  assert.strictEqual(items[0].runId, 'run-42');
});

test('外部 Agent 那条路不许把 auditContext 塞进审计（日志投毒）', async () => {
  auditSink._setUserDataDirForTest(tmpDir());
  const { createAgentBridge } = require('../src/main/mcp/agentBridge');
  register.handle('search-music', async () => ({ songs: [] }));
  const h = createAgentBridge({ source: 'agent', serverVersion: '9.9.9', onCall: (e) => auditSink.record(e) });
  await h({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_music', arguments: { keyword: 'x', page: 1 }, auditContext: { scope: 'single', risk: 'destructive', runId: 'forged' } } });
  const items = await flushAudit();
  assert.ok(!('scope' in items[0]) && !('runId' in items[0]), 'agent 身份下 auditContext 必须被忽略');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-e2e.test.js`
Expected: FAIL —— `items[0].scope` 是 undefined。

- [ ] **Step 3: 实现**

`mcpCore.js` 的 `audit` 前加一行来源约束，`tools/call` 分支把上下文并进 base：

```js
      case 'tools/call': {
        // auditContext 是**进程内**给助手用的扩展字段（哪一轮、批量还是单项、几档风险）：
        // 外部 Agent 的 JSON-RPC 体里也能塞这个键，所以只在 source==='assistant' 时采信。
        const auditContext = (source === 'assistant' && params && params.auditContext
          && typeof params.auditContext === 'object') ? params.auditContext : null;
        const base = { ts: Date.now(), tool: name, ...(auditContext ? auditContext : {}) };
```

`src/main/ipc/ai-assistant.js`：

```js
  handle('ai-assistant-tool-call', async (_, name, args, confirmed, scope, runId) => {
    …
    const msg = await _handle()({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name, arguments: args && typeof args === 'object' ? args : {},
        auditContext: { scope: scope || 'single', risk: tool.risk, runId: runId || '' },
      },
    });
```

契约那行末尾补 `['runId', t.str(32)]`（仍走「HEAD + 自己那一行」配方）。

- [ ] **Step 4: 跑到绿**

Run: `node --test test/ai-assistant-e2e.test.js test/mcp-e2e.test.js test/mcp-audit-wiring.test.js test/ai-assistant-gate.test.js`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 审计里能回看这一步是批量还是单项批准、几档风险、属于哪一轮 —— 只认助手自己那份上下文" -- src/main/mcp/mcpCore.js src/main/ipc/ai-assistant.js src/shared/ipcContract.js test/ai-assistant-e2e.test.js
```

## Task 8: 协议层：steps 带 `why`、每回合上限 4→8、规则段改口

**Files:**
- Modify: `src/api/services/aiAssistantService.js:16`（`MAX_STEPS_PER_TURN`）、`:52-58`（规则段）、`:72-83`（`_coerceSteps`）
- Test: `test/ai-assistant-service.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `risk`（提示里要按档说明确认形态）
- Produces: `parseAssistantReply` 与 `planAssistantTurn` 返回的每个 step 形如 `{tool, args, why?}`

- [ ] **Step 1: 写失败的测试**

追加进 `test/ai-assistant-service.test.js`：

```js
test('steps 带 why：文本截到 120 字，缺省或非法就不带这个键（不给界面留空串分支）', () => {
  const longWhy = '解'.repeat(300);
  const p = parseAssistantReply(JSON.stringify({
    reply: '好',
    steps: [
      { tool: 'add_to_queue', args: { song: { id: 1 } }, why: longWhy },
      { tool: 'list_playlists', args: {} },
      { tool: 'list_playlists', args: {}, why: 42 },
    ],
  }));
  assert.strictEqual(p.steps[0].why.length, 120);
  assert.ok(!('why' in p.steps[1]), '没给 why 就不该造一个空 why');
  assert.ok(!('why' in p.steps[2]), '非字符串 why 必须当没给');
});

test('每回合上限从 4 抬到 8（整局预算在渲染层，不在这里）', () => {
  assert.strictEqual(MAX_STEPS_PER_TURN, 8);
  const many = Array.from({ length: 12 }, () => ({ tool: 'list_playlists', args: {} }));
  assert.strictEqual(parseAssistantReply(JSON.stringify({ reply: 'x', steps: many })).steps.length, 8);
});

test('提示里按 risk 说清三种确认形态，且仍然只有一句协议指令', () => {
  const prompt = buildSystemPrompt(toolsFromContract());
  assert.match(prompt, /只输出一个 JSON 对象/);
  assert.strictEqual((prompt.match(/只输出一个 JSON 对象/g) || []).length, 1);
  assert.match(prompt, /计划卡/);
  assert.match(prompt, /单独弹确认/);
  assert.match(prompt, /"why"/);
  assert.ok(prompt.indexOf('删除、清空') > 0, 'destructive 的说法要在提示里');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-service.test.js`
Expected: FAIL —— `p.steps[0].why` undefined、`MAX_STEPS_PER_TURN` 仍是 4。

- [ ] **Step 3: 实现**

`MAX_STEPS_PER_TURN = 8`；`_coerceSteps` 里 push 之前：

```js
    const why = typeof s.why === 'string' ? s.why.trim().slice(0, 120) : '';
    out.push(why ? { tool: String(s.tool), args: s.args, why } : { tool: String(s.tool), args: s.args });
```

`buildSystemPrompt` 的规则段整块换成下面这版（`_section(...)` 那行照旧留在末尾）：

```
规则：
- 不需要动手就 "steps":[]。
- 一次最多 ${MAX_STEPS_PER_TURN} 个 steps；拿不准先查后动。
- 每个 step 都要带 "why"：一句给用户看的中文，说清这一步在他应用里做什么。界面会把它们列在一张计划卡上。
- 确认的三种形态照这个来，别自己替用户决定：查询类直接跑；会改数据但可逆的（入队、加歌单、订阅、取消/重试下载）整份计划一次性请用户批准；会删或清空的（删歌单、清空队列与历史、移除订阅）会单独弹确认。
- 未列出的工具就是没有；不要编造歌曲 id / 歌单 id。
- 用户没给具体歌手/歌名时，用 search_music 或 ai_search_music 找。
- 「这首」「刚才那首」这类指代，只在下面有状态段时才按状态回答；没有状态段就是不知道，该问清楚别猜。
- reply 用中文，一句话说清你做了什么或需要什么信息，不要复述 JSON。
```

- [ ] **Step 4: 跑到绿**

Run: `node --test test/ai-assistant-service.test.js test/ai-assistant-gate.test.js test/ai-assistant-context.test.js test/smart-playlist-*.test.js`
Expected: 全绿。若 `test/ai-assistant-context.test.js` 里「提示与今天逐字节相同」那类断言失败，检查是不是把状态段拼错了位置 —— 那枚断言测的是 `buildSystemPrompt(TOOLS, ctx) === buildSystemPrompt(TOOLS)` 之外的事，不该因为规则段换字而红（它比的是同一次改动后的两份）。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 协议里每个 step 都要带一句 why，每回合上限抬到 8，提示按 risk 说清三种确认形态" -- src/api/services/aiAssistantService.js test/ai-assistant-service.test.js
```

## Task 9: 计划卡（纯渲染模块）

**Files:**
- Create: `src/renderer/js/assistantPlanCard.js`
- Test: `test/ai-assistant-plan-card.test.js`（新建）

**Interfaces:**
- Consumes: `toolsFromContract()` 经 `ai-assistant-tools` 递给界面的条目 `{name, description, mutating, risk, audience}`
- Produces: `renderPlanCard({ host, steps, tools, labels })` → `{ el, rows, selected(), counts() }`。**取词一律由调用方以 `labels` 传入**（这样 `assistant.*` 键的字面量都留在视图文件里，被 `test/ai-assistant-ui.test.js:46` 那枚「中英齐备」的既有钉覆盖）

- [ ] **Step 1: 写失败的测试**

新建 `test/ai-assistant-plan-card.test.js`：

```js
/**
 * 计划卡的行为（不测长相，测「批准了什么」这份数据）。
 *
 * 三枚最容易回退的性质：去掉勾选后 selected() 恰好少那一步（顺序与形状不许变）、
 * 危险步骤默认不被 selected() 收进来（默认勾着不等于默认批准，视图那里还要单独弹）、
 * 模型的 why 只当文本上屏（它可能写着 <img>）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const CARD = 'src/renderer/js/assistantPlanCard.js';
const TOOLS = [
  { name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' },
  { name: 'add_to_queue', description: '加入下载队列', mutating: true, risk: 'write', audience: 'both' },
  { name: 'clear_all_queue', description: '清空下载队列', mutating: true, risk: 'destructive', audience: 'both' },
];
const LABELS = {
  riskRead: '只读', riskWrite: '会改数据', riskDestructive: '会删除',
  approve: '批准并执行', readOnly: '只跑只读那几步', cancel: '取消',
  summary: (n, w) => `批准 ${n} 步，其中 ${w} 步会改数据`,
};

async function boot(steps) {
  const dom = installBrowserGlobals({ ids: ['asstHost'] });
  const mod = await loadView(CARD, dom);
  const host = dom.element('asstHost');
  const card = mod.renderPlanCard({ host, steps, tools: TOOLS, labels: LABELS });
  return { dom, host, card };
}

const el = (node, pred) => {
  if (pred(node)) return node;
  for (const c of node.children || []) { const hit = el(c, pred); if (hit) return hit; }
  return null;
};
const buttons = (card) => el(card.el, (n) => n.dataset && /^asstDecide/.test(n.dataset.asstDecide || ''));
const boxes = (card) => card.rows.map((r) => r.checkbox);

test('每步一行：行里带上模型的 why 与工具的人话说明', async () => {
  const { card } = await boot([{ tool: 'search_music', args: { keyword: '晨跑' }, why: '先搜一批' }]);
  assert.strictEqual(card.rows.length, 1);
  assert.ok(card.el.children.length >= 1);
  assert.deepStrictEqual(card.counts(), { total: 1, writes: 0, destructive: 0 });
});

test('取消勾选 → selected() 恰好少那一步（顺序与形状不许变）', async () => {
  const steps = [
    { tool: 'search_music', args: { keyword: 'a' } },
    { tool: 'add_to_queue', args: { song: { id: 1 } }, why: '入队' },
  ];
  const { card } = await boot(steps);
  assert.deepStrictEqual(card.selected().map((s) => s.tool), ['search_music', 'add_to_queue']);
  const cb = boxes(card)[1];
  cb.checked = false;
  cb.dispatch('change');
  assert.deepStrictEqual(card.selected().map((s) => s.tool), ['search_music']);
  assert.strictEqual(card.selected()[0].args.keyword, 'a', '选中项的 args 被改写过');
});

test('counts(): 非只读算 writes、destructive 另记一笔（视图那句总账靠它）', async () => {
  const { card } = await boot([
    { tool: 'search_music', args: {} },
    { tool: 'add_to_queue', args: {} },
    { tool: 'clear_all_queue', args: {} },
  ]);
  assert.deepStrictEqual(card.counts(), { total: 3, writes: 2, destructive: 1 });
});

test('why 只当文本：含尖括号的 why 不许变成标签', async () => {
  const { card } = await boot([{ tool: 'search_music', args: {}, why: '<img src=x onerror=alert(1)>' }]);
  const node = el(card.el, (n) => n.textContent === '<img src=x onerror=alert(1)>');
  assert.ok(node, 'why 没按原文上屏');
  assert.ok(!card.el.innerHTML.includes('<img'), 'innerHTML 里不该出现模型给的标签');
});

test('三个动作按钮都在，且各自标了 dataset.asstDecide 供界面接线', async () => {
  const { card } = await boot([{ tool: 'search_music', args: {} }]);
  const root = card.el;
  const seen = [];
  (function walk(n) { if (n.dataset && n.dataset.asstDecide) seen.push(n.dataset.asstDecide); (n.children || []).forEach(walk); }(root));
  assert.deepStrictEqual(seen.sort(), ['approve', 'cancel', 'readOnly']);
  assert.ok(buttons(card), 'buttons 找不到');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-plan-card.test.js`
Expected: FAIL —— 文件不存在（`Cannot find module`… 实为 `loadView` 里的 import 报错）。

- [ ] **Step 3: 实现**

新建 `src/renderer/js/assistantPlanCard.js`：

```js
/**
 * 助手的一张计划卡 —— 纯渲染，不取词、不问人、不执行。
 *
 * 为什么单独一个文件：视图那边 `_round` 已经有循环、预算、止损三层职责，
 * 再塞进 DOM 拼装就没人读得动它了；而「批准了哪几步」这份数据正是最容易写错的部分，
 * 单独一个模块能让它被逐条断言（见 test/ai-assistant-plan-card.test.js）。
 * 取词函数从外面传：这样 `assistant.*` 这些键的字面量都留在视图文件里，
 * test/ai-assistant-ui.test.js 那枚「中英齐备」的静态钉才扫得到它们。
 */

const RISK_CLASS = { read: 'asst-risk-read', write: 'asst-risk-write', destructive: 'asst-risk-destructive' };

function _mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function renderPlanCard({ host, steps, tools, labels }) {
  const root = _mk('div', 'asst-plan-card');
  const rows = [];
  const list = _mk('div', 'asst-plan-rows');
  root.appendChild(list);

  for (const step of steps) {
    const meta = (tools || []).find((x) => x.name === step.tool) || { name: step.tool, risk: 'read' };
    const row = _mk('label', 'asst-plan-row');
    const checkbox = _mk('input', 'asst-plan-check');
    checkbox.checked = true;
    row.appendChild(checkbox);
    row.appendChild(_mk('span', `asst-risk ${RISK_CLASS[meta.risk] || RISK_CLASS.read}`,
      meta.risk === 'destructive' ? labels.riskDestructive : (meta.risk === 'read' ? labels.riskRead : labels.riskWrite)));
    row.appendChild(_mk('span', 'asst-plan-tool', String(step.tool)));
    if (step.why) row.appendChild(_mk('span', 'asst-plan-why', step.why));
    const box = { step, meta, checkbox, row };
    checkbox.addEventListener('change', () => { box.checked = checkbox.checked !== false; });
    box.checked = true;
    rows.push(box);
    list.appendChild(row);
  }

  const counts = () => {
    let writes = 0;
    let destructive = 0;
    for (const r of rows) {
      if (r.meta.risk !== 'read') writes += 1;
      if (r.meta.risk === 'destructive') destructive += 1;
    }
    return { total: rows.length, writes, destructive };
  };

  const foot = _mk('div', 'asst-plan-foot');
  foot.appendChild(_mk('div', 'asst-plan-summary', labels.summary(counts().total, counts().writes)));
  const decide = (kind) => {
    const btn = _mk('button', `asst-plan-btn asst-plan-${kind}`);
    btn.dataset.asstDecide = kind;
    btn.textContent = kind === 'approve' ? labels.approve : (kind === 'readOnly' ? labels.readOnly : labels.cancel);
    foot.appendChild(btn);
    return btn;
  };
  const buttons = { approve: decide('approve'), readOnly: decide('readOnly'), cancel: decide('cancel') };
  root.appendChild(foot);
  if (host) host.appendChild(root);

  return {
    el: root,
    rows,
    buttons,
    // 顺序与 step 对象原样：视图拿它直接喂给执行循环，不在这里重排或复制字段
    selected: () => rows.filter((r) => r.checked !== false).map((r) => r.step),
    counts,
  };
}
```

> 注：`checkbox.checked = true` 之后 `box.checked = true` 是两份状态 —— 界面读的是 `box.checked`，测试改的是 `checkbox.checked` 再 `dispatch('change')`。这是 fake-dom 与真 DOM 的一致做法（真 DOM 里 `checked` 就在 input 上），执行者若嫌两份，可把 `box.checked` 删成 `get checked() { return this.checkbox.checked !== false; }`，两种写法测试都要过。

- [ ] **Step 4: 跑到绿**

Run: `node --test test/ai-assistant-plan-card.test.js`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 助手多了一张计划卡 —— 整份计划一次批准，勾选就是它交给循环的那份数据" -- src/renderer/js/assistantPlanCard.js test/ai-assistant-plan-card.test.js
```

## Task 10: 循环改造：整局预算、止损、批确认、危险步骤单独弹

**Files:**
- Modify: `src/renderer/js/views/ai-assistant.js`（`_round` 整段 + 新常量 + 新 ERR_KEYS + labels）
- Create: `test/helpers/assistant-boot.js`（把 `test/ai-assistant-context.test.js` 的 `boot()` 抽出来共用）
- Modify: `test/ai-assistant-context.test.js`（改 require）
- Test: `test/ai-assistant-agent-loop.test.js`（新建）、`test/ai-assistant-ui.test.js:92`（`MAX_TURNS=3` 那枚）

**Interfaces:**
- Consumes: Task 6 的 `scope`/`runId` 参数、Task 8 的 `why`、Task 9 的 `renderPlanCard`
- Produces: `MAX_TURNS=6`、`MAX_RUN_CALLS=24`、`MAX_RUN_MUTATIONS=12`；`invoke('ai-assistant-tool-call', name, args, confirmed, scope, runId)`

- [ ] **Step 1: 先做共用 boot，再写失败的测试**

把 `test/ai-assistant-context.test.js` 里的 `boot(state, {plan, tool})` 与 `send(dom, text)` 原样搬进 `test/helpers/assistant-boot.js`（`module.exports = { boot, send, IDS, SONG }`），context 测试改成 `const { boot, send, IDS, SONG } = require('./helpers/assistant-boot');`，并让它支持第三参 `opts.tools`（默认仍是原来那条 17/21 条里挑一条的合成表）。

Run: `node --test test/ai-assistant-context.test.js`
Expected: 全绿（这一步只是搬家，不许改断言）。

新建 `test/ai-assistant-agent-loop.test.js`：

```js
/**
 * agent 循环的行为：批准形态、预算、止损。
 *
 * 每条都从 invoke 实际收到的参数反查 —— 测的是「界面到底把什么交给了主进程」，
 * 不是「界面看起来怎么样」。批量令牌与单项令牌如果发错，主进程那道闸拦得住用户，
 * 但拦不住「界面以为批过了」的静默丢步骤，所以这里必须有牙齿。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, send, SONG } = require('./helpers/assistant-boot');

const TOOLS = [
  { name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' },
  { name: 'add_to_queue', description: '加入下载队列', mutating: true, risk: 'write', audience: 'both' },
  { name: 'clear_all_queue', description: '清空下载队列', mutating: true, risk: 'destructive', audience: 'both' },
];

const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
/** 找到卡上那个按钮并点它（不 await 住循环，让 sendAssistant 的 Promise 继续跑） */
async function decide(dom, kind) {
  const log = dom.element('assistantLog');
  const card = log.children[log.children.length - 1];
  const btn = walk(card).find((n) => n.dataset && n.dataset.asstDecide === kind);
  assert.ok(btn, `计划卡上找不到 ${kind} 按钮`);
  await btn.dispatch('click');
}

test('整份计划一次批准：write 步骤拿到的 scope 是 batch，且全程只问一次', async () => {
  const calls = [];
  const h = await boot({ playQueue: [SONG('q1', '晚风')] }, {
    tools: TOOLS,
    plan: () => '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}},"why":"入队"},{"tool":"list_platforms","args":{}}]}',
    tool: (name, args, confirmed, scope, runId) => { calls.push({ name, confirmed, scope, runId }); return { ok: true, text: '{"songs":[]}' }; },
  });
  const p = send(h.dom, '把这首加进下载队列');
  await h.tick(3);
  await decide(h.dom, 'approve');
  await p;
  assert.strictEqual(calls.filter((c) => c.name === 'add_to_queue').length, 1);
  assert.strictEqual(calls[0].scope, 'batch', '批确认那步该发 batch');
  assert.strictEqual(calls[0].confirmed, true);
  assert.ok(calls[0].runId, 'runId 必须带上，审计才能把一整轮串起来');
});

test('取消：一步都不执行，且这一轮不再问第二次', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}}}]}',
    tool: (...a) => { calls.push(a); return { ok: true, text: '{}' }; },
  });
  const p = send(h.dom, '随便做点');
  await h.tick(3);
  await decide(h.dom, 'cancel');
  await p;
  assert.deepStrictEqual(calls, [], '取消后不该有任何工具调用');
});

test('只跑只读那几步：非只读步骤一条都不发，只读的照发', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}}},{"tool":"list_platforms","args":{}}]}',
    tool: (name, args, confirmed, scope) => { calls.push({ name, confirmed, scope }); return { ok: true, text: '{}' }; },
  });
  const p = send(h.dom, '看看有什么平台');
  await h.tick(3);
  await decide(h.dom, 'readOnly');
  await p;
  assert.deepStrictEqual(calls.map((c) => c.name), ['list_platforms']);
});

test('destructive 即使在批确认里也单独弹，且发出的 scope 是 single', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"好","steps":[{"tool":"clear_all_queue","args":{}}]}',
    tool: (name, args, confirmed, scope) => { calls.push({ name, confirmed, scope }); return { ok: true, text: '{}' }; },
    confirm: () => true,
  });
  const p = send(h.dom, '把下载队列清空');
  await h.tick(3);
  await decide(h.dom, 'approve');
  await p;
  assert.deepStrictEqual(calls[0], { name: 'clear_all_queue', confirmed: true, scope: 'single' });
  assert.strictEqual(h.confirms, 1, '危险步骤该且只该弹一次模态确认');
});

test('整局预算：到了 MAX_RUN_CALLS 就停，并把停的原因上屏', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"再来一轮","steps":[{"tool":"list_platforms","args":{}}]}',
    tool: () => ({ ok: true, text: '{}' }),
  });
  const p = send(h.dom, '一直查');
  await h.tick(3);
  for (let i = 0; i < 40 && !h.settled(); i += 1) { await decide(h.dom, 'approve').catch(() => {}); await h.tick(2); }
  await p;
  assert.ok(h.calls.tool.length <= 24, `整局调用数越界: ${h.calls.tool.length}`);
  const texts = h.dom.element('assistantLog').children.map((c) => c.textContent);
  assert.ok(texts.some((x) => /上限/.test(x)), '停在预算上要有一句人话');
});

test('止损：同一步连续失败两次就不再试它，把错误摊给用户', async () => {
  let n = 0;
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"再试","steps":[{"tool":"list_platforms","args":{}}]}',
    tool: () => { n += 1; return { ok: false, error: 'TOOL_FAILED', text: 'boom' }; },
  });
  const p = send(h.dom, '查平台');
  await h.tick(3);
  for (let i = 0; i < 12 && !h.settled(); i += 1) { await decide(h.dom, 'approve').catch(() => {}); await h.tick(2); }
  await p;
  assert.strictEqual(n, 2, `同一步只该被试到第 2 次就止损，实得 ${n}`);
});
```

> boot 需要多提供三样：`tick`（`require('./helpers/fake-dom').tick`）、`confirms` 计数与 `confirm` 桩（覆盖 `askConfirm`）、`settled()`（`sendAssistant` 的 Promise 落地与否）。搬 boot 时一并加上，`ipcRenderer.invoke('ai-assistant-tool-call', ...)` 的桩要接住 6 个形参。

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-agent-loop.test.js`
Expected: FAIL —— 没有计划卡（`计划卡上找不到 approve 按钮`），`scope` 全是 undefined。

- [ ] **Step 3: 实现（视图那段整块替换，注释要留下「为什么」）**

`src/renderer/js/views/ai-assistant.js` 顶部常量区：

```js
const MAX_TURNS = 6;
const MAX_RUN_CALLS = 24;
const MAX_RUN_MUTATIONS = 12;
const CTX_QUEUE = 8;
const CTX_SONGS = 5;

let _history = [];
let _tools = null;
let _busy = false;
let _runId = '';

/** 一轮（用户的一句话到循环收束）的编号：审计靠它把同一步的几次调用串起来 */
function _newRunId() {
  const c = globalThis.crypto;
  return (c && typeof c.randomUUID === 'function')
    ? String(c.randomUUID()).slice(0, 32)
    : `r${Date.now().toString(36)}`;
}
```

ERR_KEYS 补三行（`AGENT_SCOPE_MISMATCH`、`APP_ONLY`、`NEED_CONFIRM` 已有）：

```js
  AGENT_SCOPE_MISMATCH: 'assistant.errScopeMismatch',
  APP_ONLY: 'assistant.errAppOnlyTool',
```

`_round` 与新增的两个内部函数：

```js
/** 把界面词全部在视图里取好再传进卡：本文件里的 assistant.* 字面量才扫得到那枚中英齐备的钉 */
function _cardLabels() {
  return {
    riskRead: t('assistant.riskRead'),
    riskWrite: t('assistant.riskWrite'),
    riskDestructive: t('assistant.riskDestructive'),
    approve: t('assistant.planApprove'),
    readOnly: t('assistant.planReadOnly'),
    cancel: t('assistant.planCancel'),
    summary: (n, w) => t('assistant.planSummary', { n, w }),
  };
}

/** 等用户在卡上做一个决定。resolve 之后卡就不再接受第二次点击。 */
function _awaitDecision(card) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (kind) => {
      if (done) return;
      done = true;
      for (const b of Object.values(card.buttons)) b.disabled = true;
      resolve(kind);
    };
    card.buttons.approve.addEventListener('click', () => settle('approve'));
    card.buttons.readOnly.addEventListener('click', () => settle('readOnly'));
    card.buttons.cancel.addEventListener('click', () => settle('cancel'));
  });
}

/**
 * 执行一批步骤。三种确认形态在这里分岔，而**判据在主进程**（assistantGate）：
 * 界面只负责发出正确的 scope/confirmed 组合，发错了主进程拒，拒了界面如实上屏。
 */
async function _execSteps(steps, tools, grant, run) {
  const results = [];
  for (const step of steps) {
    if (run.calls >= MAX_RUN_CALLS) {
      results.push({ tool: step.tool, ok: false, text: t('assistant.planStoppedBudget') });
      _push('asst-step asst-step-failed', t('assistant.planStoppedBudget'));
      run.outOfBudget = true;
      break;
    }
    const meta = tools.find((x) => x.name === step.tool) || { risk: 'read', audience: 'both' };
    const isWrite = meta.risk !== 'read';
    if (isWrite && run.mutations >= MAX_RUN_MUTATIONS) {
      results.push({ tool: step.tool, ok: false, text: t('assistant.planStoppedBudget') });
      _push('asst-step asst-step-failed', t('assistant.planStoppedBudget'));
      run.outOfBudget = true;
      break;
    }
    let confirmed = false;
    let scope = grant;
    if (meta.risk === 'destructive') {
      // 危险步骤即使在批确认里也单独弹。askConfirm 仍是本文件里唯一的模态确认入口 ——
      // test/ai-assistant-ui.test.js 那枚「恰好一处 await askConfirm」就是它还在的证据。
      scope = 'single';
      confirmed = await askConfirm({
        text: t('assistant.confirmText', { tool: step.tool, args: JSON.stringify(step.args).slice(0, 200) }),
      });
      if (!confirmed) {
        const declined = t('assistant.toolDeclined', { tool: step.tool });
        results.push({ tool: step.tool, ok: false, text: declined });
        _push('asst-step', declined);
        continue;
      }
    } else {
      confirmed = isWrite;   // 只读不需要批准；非只读需要「这一批被批准了」那个事实
    }
    run.calls += 1;
    if (isWrite) run.mutations += 1;
    _push('asst-step', t('assistant.toolRunning', { tool: step.tool }));
    const out = await window.ipcRenderer.invoke(
      'ai-assistant-tool-call', step.tool, step.args, confirmed, scope, run.id);
    const ok = !!(out && out.ok);
    if (!ok) {
      run.failures = run.failures || Object.create(null);
      const key = `${step.tool}|${JSON.stringify(step.args)}`;
      run.failures[key] = (run.failures[key] || 0) + 1;
    }
    results.push({ tool: step.tool, ok, text: ok ? out.text : _errText(out && out.error, out && out.text) });
    _push(ok ? 'asst-step' : 'asst-step asst-step-failed',
      ok ? t('assistant.toolDone', { tool: step.tool })
        : t('assistant.toolFailed', { tool: step.tool, msg: errBrief(out && out.text) }));
  }
}

/** 同 tool + 同 args 连续失败两次就停：模型会对着一个坏工具反复试，那是刷额度不是思考 */
function _stuck(run) {
  return Object.values(run.failures || {}).some((n) => n >= 2);
}

async function _round(userText) {
  _history.push({ role: 'user', content: userText });
  const tools = await _ensureTools();
  const run = { calls: 0, mutations: 0, id: _newRunId(), failures: Object.create(null) };
  let stopHint = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const thinking = _push('asst-msg-assistant', t('assistant.thinking'));
    const plan = await window.ipcRenderer.invoke('ai-assistant-plan', _history, _appContext());
    if (thinking) thinking.remove();
    if (!plan || plan.ok !== true) { stopHint = _errText(plan && plan.error, plan && plan.text); break; }
    // 模型的上一轮输出必须原样回到上下文，否则下一轮它会重复同一步
    _history.push({ role: 'assistant', content: JSON.stringify({ reply: plan.reply, steps: plan.steps }) });
    if (plan.reply) _push('asst-msg-assistant', plan.reply);
    if (!plan.steps.length) return '';

    const card = renderPlanCard({ host: _log(), steps: plan.steps, tools, labels: _cardLabels() });
    const kind = await _awaitDecision(card);
    if (kind === 'cancel') {
      _push('asst-step', t('assistant.planCancelled'));
      return '';
    }
    const chosen = kind === 'readOnly'
      ? card.selected().filter((s) => ((tools.find((x) => x.name === s.tool) || {}).risk === 'read'))
      : card.selected();
    if (!chosen.length) { _push('asst-step', t('assistant.planCancelled')); return ''; }
    const results = await _execSteps(chosen, tools, kind === 'approve' ? 'batch' : 'readOnly', run);
    _history.push(formatToolResults(results));
    if (run.outOfBudget) { stopHint = t('assistant.planStoppedBudget'); break; }
    if (_stuck(run)) { stopHint = t('assistant.planStoppedRepeat'); break; }
    stopHint = t('assistant.loopStopped');
  }
  return stopHint;
}
```

再补 import 与 `formatToolResults` 的接线：视图顶部 `import { renderPlanCard } from '../assistantPlanCard.js';` 与 `import { formatToolResults } from '../../../api/services/aiAssistantService.js';`。

> 若渲染层打包路径取不到那个 service 模块（它 require 了 `../../main/mcp/tools`，是主进程代码），就**不要**跨层 import：改成界面自己拼这一条消息 —— `{ role:'user', content: JSON.stringify({ tool_results: results.map(r => ({ tool: r.tool, ok: r.ok === true, text: String(r.text||'').slice(0, MAX_RESULT_CHARS_LOCAL) })) }) }`，并把 `MAX_RESULT_CHARS_LOCAL = 4000` 与本文件同处声明，同时在 `test/ai-assistant-gate.test.js` 加一枚「渲染层那份 4000 与服务侧 MAX_RESULT_CHARS 必须同数」的静态钉（与 `MAX_CONTEXT_CHARS` 那枚同法）。**这一步先做，别到绿灯之后再补。**

- [ ] **Step 4: 跑到绿（含既有钉）**

Run: `node --test test/ai-assistant-agent-loop.test.js test/ai-assistant-plan-card.test.js test/ai-assistant-ui.test.js test/ai-assistant-context.test.js test/ai-assistant-e2e.test.js`
Expected: 全绿。`test/ai-assistant-ui.test.js` 里两处要改：`MAX_TURNS\s*=\s*3` → `=\s*6`；「写操作确认：mutating 步骤必须先 await askConfirm」那枚改成按 risk 的说法：

```js
test('危险步骤仍走模态：askConfirm 恰一处，且判据是 risk === destructive', () => {
  assert.strictEqual((VIEW.match(/await\s+askConfirm\(/g) || []).length, 1, '助手页应恰有一处 await askConfirm(');
  assert.match(VIEW, /meta\.risk === 'destructive'/, '单项弹确认的判据不在了');
  assert.match(VIEW, /scope = 'single'/, '危险步骤必须发 single，批量令牌换不到它');
});
```

新增词典键（`zh.json` / `en.json` 各一份，紧跟既有 `assistant.loopStopped` 之后）：
`assistant.riskRead`、`assistant.riskWrite`、`assistant.riskDestructive`、`assistant.planApprove`、`assistant.planReadOnly`、`assistant.planCancel`、`assistant.planCancelled`、`assistant.planSummary`（占位符 `{n}`/`{w}`）、`assistant.planStoppedBudget`、`assistant.planStoppedRepeat`、`assistant.errScopeMismatch`、`assistant.errAppOnlyTool`。
zh 建议：`assistant.planSummary` = 「批准 {n} 步，其中 {w} 步会改数据」；`assistant.planStoppedRepeat` = 「同一步连失败两次，先停下来」；`assistant.errScopeMismatch` = 「这一步需要单独确认，已在批量批准里跳过」；`assistant.errAppOnlyTool` = 「这个能力只能在界面里执行，助手没走通」。en 同义，占位符集合必须与 zh 一致（`test/ai-assistant-ui.test.js:46` 那枚钉在管这件事）。

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 5: 提交**

```bash
git add test/helpers/assistant-boot.js test/ai-assistant-agent-loop.test.js test/ai-assistant-ui.test.js src/renderer/js/views/ai-assistant.js
# 两份词典是共享文件：按「HEAD + 自己那几行」配方暂存
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 助手改成真 agent 循环 —— 整份计划一次批准、危险步骤单独弹、整局有调用与改写预算" -- src/renderer/js/views/ai-assistant.js test/helpers/assistant-boot.js test/ai-assistant-context.test.js test/ai-assistant-agent-loop.test.js test/ai-assistant-ui.test.js src/renderer/js/lang/zh.json src/renderer/js/lang/en.json
```

## Task 11: P2 工具面（11 条 write + 7 条 destructive）

**Files:**
- Modify: `src/main/mcp/tools.js`（插入 18 条）
- Modify: `test/agent-tool-registry.test.js`、`test/ai-assistant-e2e.test.js`、`test/ai-assistant-ui.test.js:89` 的计数
- Test: 一条「外部 Agent 指名 destructive 得到未知工具」的 e2e

**Interfaces:**
- Consumes: Task 1 的分层、Task 2 的过滤、Task 6 的闸
- Produces: 登记表 39 条，其中 `risk==='destructive'` 7 条

- [ ] **Step 1: 写失败的测试**

`test/agent-tool-registry.test.js` 追加：

```js
test('P2 面：39 条工具，destructive 恰 7 条，且都进不了外部 Agent 的面', () => {
  const defs = toolsFromContract();
  assert.strictEqual(defs.length, 39);
  const destructive = defs.filter((d) => d.risk === 'destructive').map((d) => d.name).sort();
  assert.deepStrictEqual(destructive, [
    'clear_all_downloads', 'clear_finished_downloads', 'clear_history', 'delete_download_template',
    'delete_user_playlist', 'remove_history', 'unsubscribe',
  ]);
  const agentView = toolsForSource('agent');
  for (const n of destructive) {
    assert.ok(!agentView.some((d) => d.name === n), `外部 Agent 不该看到 ${n}`);
  }
});

test('P2 的写面点名（少了哪条、多了哪条都算红）', () => {
  const writes = toolsFromContract().filter((d) => d.risk === 'write').map((d) => d.name).sort();
  assert.deepStrictEqual(writes, [
    'add_playlist_to_downloads', 'add_to_playlist', 'add_to_queue', 'cancel_download', 'remove_from_playlist',
    'remove_queue_item', 'reorder_queue_item', 'retry_download', 'save_download_template',
    'set_download_queue_paused', 'subscribe_add', 'subscribe_mark_seen', 'toggle_favorite',
  ]);
});
```

`test/ai-assistant-e2e.test.js` 追加（这条是「少一处能绕开的地方」的证据）：

```js
test('指名 destructive 也不给外部 Agent 跑：byName 里没有它，回的是「未知工具」', async () => {
  const { createAgentBridge } = require('../src/main/mcp/agentBridge');
  let executed = 0;
  register.handle('clear-all-queue', async () => { executed += 1; return { ok: true }; });
  const h = createAgentBridge({ source: 'agent', serverVersion: '9.9.9', onCall: () => {} });
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clear_all_downloads', arguments: {} } });
  assert.strictEqual(r.error.code, -32602);
  assert.strictEqual(executed, 0, '被拒的破坏性操作一次都不该落到 handler');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js`
Expected: FAIL —— 数量 21 ≠ 39。

- [ ] **Step 3: 实现**

`tools.js` 里在 `add_playlist_to_queue` 之类的位置插入下面 18 条。通道名与参数规格全部取自 `src/shared/ipcContract.js`（不要改契约）：

```js
  // ── 可逆写（应用内整批批准；外部 Agent 仍可单独调用）──
  { name: 'cancel_download', channel: 'cancel-download', risk: 'write',
    description: '取消一个下载任务（taskId 来自下载队列）。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'retry_download', channel: 'retry-download', risk: 'write',
    description: '重试一个已失败的下载任务。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'remove_queue_item', channel: 'remove-queue-item', risk: 'write',
    description: '从下载队列里移掉一个任务（不删已下好的文件）。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'reorder_queue_item', channel: 'reorder-queue-item', risk: 'write',
    description: '调整下载队列顺序。action: up/down/top。', required: ['taskId', 'action'],
    paramDocs: { taskId: '任务 id', action: 'up | down | top' } },
  { name: 'set_download_queue_paused', channel: 'set-queue-paused', risk: 'write',
    description: '暂停或继续整个下载队列。', required: ['paused'], paramDocs: { paused: 'true=暂停' } },
  { name: 'add_playlist_to_downloads', channel: 'add-playlist-to-queue', risk: 'write',
    description: '把一个歌单整体加入下载队列。payload 是界面那条批量对象（含歌曲清单与质量）。',
    required: ['payload'], paramDocs: { payload: '批量入队对象' } },
  { name: 'save_download_template', channel: 'save-download-template', risk: 'write',
    description: '新增或更新一个下载目录模板（template:{id?,name,path}）。模板的存储路径由界面给定。',
    required: ['template'], paramDocs: { template: '模板对象' } },
  { name: 'remove_from_playlist', channel: 'remove-from-user-playlist', risk: 'write',
    description: '从用户歌单里移掉一首歌（歌单本身还在）。', required: ['playlistId', 'songId'],
    paramDocs: { playlistId: '歌单 id', songId: '歌曲 id', source: '平台 id' } },
  { name: 'subscribe_add', channel: 'subscribe-add', risk: 'write',
    description: '新增一个订阅项（歌手/歌单/账号）。type 与 platform 见 list_platforms。',
    required: ['type', 'platform', 'targetId'], paramDocs: { type: '订阅类型', platform: '平台 id', targetId: '目标 id', name: '显示名' } },
  { name: 'subscribe_mark_seen', channel: 'subscribe-mark-seen', risk: 'write',
    description: '把一个订阅项标记为已读（清掉「有新内容」的角标）。', required: ['key'], paramDocs: { key: '订阅键' } },
  // ── 破坏性（只在应用内、且必须单项确认；外部 Agent 看不到）──
  { name: 'clear_finished_downloads', channel: 'clear-finished-queue', risk: 'destructive',
    description: '把下载队列里已完成/失败的条目从列表里清掉（不动磁盘上的文件）。' },
  { name: 'clear_all_downloads', channel: 'clear-all-queue', risk: 'destructive',
    description: '清空整个下载队列（未完成的会一起被取消）。' },
  { name: 'delete_download_template', channel: 'delete-download-template', risk: 'destructive',
    description: '删掉一个下载目录模板。', required: ['templateId'], paramDocs: { templateId: '模板 id' } },
  { name: 'delete_user_playlist', channel: 'delete-user-playlist', risk: 'destructive',
    description: '删掉一个用户自建歌单（里面的歌会一起从歌单里消失）。', required: ['playlistId'],
    paramDocs: { playlistId: '歌单 id' } },
  { name: 'unsubscribe', channel: 'subscribe-remove', risk: 'destructive',
    description: '移除一个订阅项。', required: ['key'], paramDocs: { key: '订阅键' } },
  { name: 'clear_history', channel: 'clear-history', risk: 'destructive',
    description: '清空全部下载/播放历史记录。' },
  { name: 'remove_history', channel: 'remove-history', risk: 'destructive',
    description: '按条目移除历史记录。entries 是 query_history 返回的项。', required: ['entries'],
    paramDocs: { entries: '历史条目数组' } },
```

同步把三处计数钉改成 39（`test/agent-tool-registry.test.js` 的 P1 那枚保留但把「17/21」断言并入新那枚，别留两把尺子）、`test/ai-assistant-e2e.test.js:73` 改成「39 个工具、非只读 21 条、其中 destructive 7 条」，`test/ai-assistant-ui.test.js:89` 的 `AGENT_TOOLS.length` 改 39。

- [ ] **Step 4: 跑到绿**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js test/ai-assistant-ui.test.js test/ai-assistant-gate.test.js test/ai-assistant-agent-loop.test.js test/mcp-e2e.test.js`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 队列、歌单、订阅、历史 18 条能力进了登记表 —— 可逆的给两侧，会删的只给应用内且必须单项确认" -- src/main/mcp/tools.js test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js test/ai-assistant-ui.test.js
```

## Task 12: P2 收口（文档 + 闸门 + CI）

**Files:**
- Modify: `SECURITY.md`、`CHANGELOG.md`、`README.md`

- [ ] **Step 1: 文档**

`SECURITY.md` 第 8 小节（MCP 工具面白名单那句）改为：「给外部 Agent 的 32 条工具」→ **按实际数**：`toolsForSource('agent').length`。用一条命令算出来再写进文档，别手算：

```bash
node -e "const {toolsForSource}=require('./src/main/mcp/tools');console.log(toolsForSource('agent').length, toolsForSource('assistant').length)"
```

第五节加一条（照实写三种确认形态 + 「批量令牌换不到删除」那句）；第六节自查清单加一句「删/清空一类即使在批量批准里也还会单独弹一次」。`CHANGELOG.md` 的 `[未发布] → 新增` 写「AI 助手从问答变成了 agent」那条，含 39 条能力、整份计划一次批准、整局 24 次调用上限。

- [ ] **Step 2: 全量本地闸门**

Run: `npm run lint` → 干净
Run: `npm test` → 全绿（同 Task 5 的处置：别人的红灯不替别人修）
Run: `npm run build && npm run smoke:asar` → 绿

- [ ] **Step 3: 提交、推送、取 runner 证据**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "docs(security,changelog): P2 的三种确认形态与外部面白名单数落进文档" -- SECURITY.md CHANGELOG.md README.md
git push origin HEAD:main
```

Expected: 两条 job 均 `success`，annotation 只剩 warning；roadmap 轨道五那行补上这枚 full sha。

---

# 第三期 P3：播放控制（`audience:'app'`，外部 Agent 永远看不到）

## Task 13: 登记表允许没有通道的工具 + `APP_ONLY` 令牌

**Files:**
- Modify: `src/main/mcp/tools.js`（`toolsFromContract` 的通道校验分支 + 6 条 app 条目）
- Modify: `src/main/ipc/ai-assistant.js`（`ai-assistant-tools` 载荷多出 `action`）
- Test: `test/agent-tool-registry.test.js`、`test/ai-assistant-e2e.test.js`

**Interfaces:**
- Consumes: Task 2 的 `visibleToAgent`（已排除 `audience==='app'`）
- Produces: 6 条 app 工具：`play_toggle`、`play_next`、`play_prev`、`set_play_volume`、`play_search_result`、`open_app_page`；派生条目多出 `action`

- [ ] **Step 1: 写失败的测试**

```js
const { CHANNELS } = require('../src/shared/ipcContract');

test('P3：6 条只在渲染层执行的能力，主进程调不动、外部 Agent 看不见', () => {
  const appOnly = toolsFromContract().filter((d) => d.audience === 'app');
  assert.deepStrictEqual(appOnly.map((d) => d.name).sort(), [
    'open_app_page', 'play_next', 'play_prev', 'play_search_result', 'play_toggle', 'set_play_volume',
  ]);
  for (const d of appOnly) {
    assert.strictEqual(d.channel, null, `${d.name} 不该有通道`);
    assert.ok(d.action, `${d.name} 要有渲染层的 action 键`);
    assert.ok(!toolsForSource('agent').some((x) => x.name === d.name));
  }
});

test('app 工具的参数规格也走契约那套原语（同一份词汇，不另立形状）', () => {
  const vol = toolsFromContract().find((d) => d.name === 'set_play_volume');
  assert.strictEqual(vol.inputSchema.properties.value.maximum, 100);
  const page = toolsFromContract().find((d) => d.name === 'open_app_page');
  assert.deepStrictEqual(page.inputSchema.properties.tab.enum,
    ['home', 'search', 'download', 'local', 'aggregate', 'playlist', 'subscription', 'assistant']);
});

test('没有通道的条目不许被拿去查 CHANNELS（否则派生会抛「不是 main invoke」）', () => {
  const d = toolsFromContract().find((x) => x.audience === 'app');
  assert.ok(d, '本计划该有至少一条 app 工具');
  assert.ok(!(d.name in CHANNELS), 'app 工具不是 IPC 通道');
});
```

`test/ai-assistant-e2e.test.js` 追加：

```js
test('主进程对 app-only 工具回 APP_ONLY，一次桥都不碰', async () => {
  const r = await handlerOf('ai-assistant-tool-call')('play_toggle', {}, false, 'single', 'run-x');
  assert.deepStrictEqual(r, { ok: false, error: 'APP_ONLY' });
});

test('目录把 action 与 risk 一起递给界面（渲染层据此接线并决定确认形态）', async () => {
  const r = await handlerOf('ai-assistant-tools')();
  const d = r.tools.find((x) => x.name === 'play_toggle');
  assert.strictEqual(d.audience, 'app');
  assert.strictEqual(d.action, 'play.toggle');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js`
Expected: FAIL —— `toolsFromContract` 对 app 条目抛「通道不是 main invoke」，或 `appOnly` 长度为 0。

- [ ] **Step 3: 实现**

`toolsFromContract` 里通道校验加分支（**只**允许 `audience==='app'` 没有通道）：

```js
    let properties = {};
    if (audience === 'app') {
      // 渲染层能力没有 IPC 通道可派生：参数规格就地声明，但用的还是契约那套 t.* 原语，
      // 于是「参数怎么钳制」这条链上的词汇仍是唯一一份。
      for (const [name, spec] of tool.argSpecs || []) {
        const prop = specToJsonSchema(spec);
        if (tool.paramDocs && tool.paramDocs[name]) prop.description = tool.paramDocs[name];
        properties[name] = prop;
      }
    } else {
      const entry = channels[tool.channel];
      if (!entry || !(entry.invoke || []).includes('main')) {
        throw new Error(`[mcp] 工具 ${tool.name} 的通道不是 main invoke: ${tool.channel}`);
      }
      for (const [name, spec] of entry.args || []) { /* 原样 */ }
    }
```

`tdef` 多出 action：`channel: audience === 'app' ? null : tool.channel, ...(tool.action ? { action: tool.action } : {})`。

`tools.js` 顶部 require 补 `t`：`const { CHANNELS, t } = require('../../shared/ipcContract');`，末尾（`list_playlists` 之后、加法动作之前）插：

```js
  // ── 只在渲染层执行（audience:'app'）──────────────────
  // 播放/切歌/音量/开页这些能力根本不在主进程里：状态与 audio 元素都长在渲染层，
  // 为它们造一条 IPC 只是把一次函数调用换成三层往返，还多一处可绕过的口子。
  // 因此它们**不进外部 Agent 的面**（toolsForSource 已按 audience 排除），
  // 执行者是助手视图自己的一份 action 表 —— 见 views/ai-assistant.js 的 APP_ACTIONS。
  { name: 'play_toggle', action: 'play.toggle', audience: 'app', risk: 'write',
    description: '继续或暂停当前播放。' },
  { name: 'play_next', action: 'play.next', audience: 'app', risk: 'write',
    description: '切到下一首。' },
  { name: 'play_prev', action: 'play.prev', audience: 'app', risk: 'write',
    description: '切到上一首。' },
  { name: 'set_play_volume', action: 'play.volume', audience: 'app', risk: 'write',
    description: '把播放音量设成 value（0-100）。', required: ['value'],
    argSpecs: [['value', t.int(50, 100)]], paramDocs: { value: '音量百分比' } },
  { name: 'play_search_result', action: 'play.result', audience: 'app', risk: 'write',
    description: '播放「本次搜索」列表里的第 index 首（从 1 数，索引来自状态段）。', required: ['index'],
    argSpecs: [['index', t.int(1, 50)]], paramDocs: { index: '序号，从 1 开始' } },
  { name: 'open_app_page', action: 'ui.open', audience: 'app', risk: 'write',
    description: '把应用切到某个页面，方便用户看到结果。', required: ['tab'],
    argSpecs: [['tab', t.enum(['home', 'search', 'download', 'local', 'aggregate', 'playlist', 'subscription', 'assistant'], 'home')]],
    paramDocs: { tab: '页面 id' } },
```

`src/main/ipc/ai-assistant.js` 的目录通道载荷补两个字段（Task 9/10 的界面要用 `risk` 出徽章、用 `action` 接线）：

```js
    tools: toolsFromContract().map(({ name, description, mutating, risk, audience, action }) =>
      ({ name, description, mutating, risk, audience, ...(action ? { action } : {}) })),
```

- [ ] **Step 4: 跑到绿**

Run: `node --test test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js test/ai-assistant-gate.test.js test/mcp-e2e.test.js`
Expected: 全绿。计数钉改到 45 条（`ai-assistant-ui.test.js:89` 与 e2e 那枚）；「恰好一处 await askConfirm」那枚不许放宽（P3 不新增确认入口）。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(mcp): 登记表第一次允许「没有 IPC 通道」的能力 —— 6 条播放控制只在渲染层执行，外部 Agent 连名字都看不到" -- src/main/mcp/tools.js src/main/ipc/ai-assistant.js test/agent-tool-registry.test.js test/ai-assistant-e2e.test.js
```

## Task 14: 渲染层执行 app 工具（action 表）

**Files:**
- Modify: `src/renderer/js/views/ai-assistant.js`
- Test: `test/ai-assistant-agent-loop.test.js`（追加）

**Interfaces:**
- Consumes: Task 13 的 `action` 字段、渲染层既有全局函数 `window.togglePlay` / `window.nextSong` / `window.prevSong` / `window.setVolume` / `window.playSong` / `window.switchTab`
- Produces: `_execSteps` 对 `audience==='app'` 的步骤**不发 IPC**，改为本地执行并如实记结果

- [ ] **Step 1: 写失败的测试**

追加进 `test/ai-assistant-agent-loop.test.js`：

```js
test('app 工具不发 IPC：播放控制走渲染层自己的全局函数', async () => {
  const seen = { ipc: [], play: 0, vol: null };
  const h = await boot({}, {
    tools: [{ name: 'play_toggle', description: '播放/暂停', mutating: true, risk: 'write', audience: 'app', action: 'play.toggle' },
      { name: 'set_play_volume', description: '设音量', mutating: true, risk: 'write', audience: 'app', action: 'play.volume' }],
    plan: () => '{"reply":"好","steps":[{"tool":"play_toggle","args":{}},{"tool":"set_play_volume","args":{"value":30}}]}',
    tool: (...a) => { seen.ipc.push(a); return { ok: true, text: '{}' }; },
    extraGlobalsHook: (g) => { g.window.togglePlay = () => { seen.play += 1; }; g.window.setVolume = (v) => { seen.vol = v; }; },
  });
  const p = send(h.dom, '暂停一下，音量调到 30');
  await h.tick(3);
  await decide(h.dom, 'approve');
  await p;
  assert.deepStrictEqual(seen.ipc, [], 'app 工具一条 IPC 都不该发（主进程帮不上）');
  assert.strictEqual(seen.play, 1);
  assert.strictEqual(seen.vol, 30);
});

test('渲染层没有那个函数时如实报错，不许静默当成功', async () => {
  const h = await boot({}, {
    tools: [{ name: 'play_next', description: '下一首', mutating: true, risk: 'write', audience: 'app', action: 'play.next' }],
    plan: () => '{"reply":"好","steps":[{"tool":"play_next","args":{}}]}',
    tool: () => ({ ok: true, text: '{}' }),
    // 不装 window.nextSong —— 真应用里它也可能在别的页面尚未注册，那种时候必须报失败
  });
  const p = send(h.dom, '下一首');
  await h.tick(3);
  await decide(h.dom, 'approve');
  await p;
  const texts = h.dom.element('assistantLog').children.map((c) => c.textContent);
  assert.ok(texts.some((x) => /play_next/.test(x) && !/完成/.test(x)), '该有一条失败上屏而不是假绿');
});

test('app 工具的观察结果里带上界内值：音量被钳到 0-100、序号越界不执行', async () => {
  const got = [];
  const h = await boot({}, {
    tools: [{ name: 'set_play_volume', description: '音量', mutating: true, risk: 'write', audience: 'app', action: 'play.volume' },
      { name: 'play_search_result', description: '播第 index 首', mutating: true, risk: 'write', audience: 'app', action: 'play.result' }],
    plan: () => '{"reply":"好","steps":[{"tool":"set_play_volume","args":{"value":900}},{"tool":"play_search_result","args":{"index":0}}]}',
    tool: () => ({ ok: true, text: '{}' }),
    extraGlobalsHook: (g) => { g.window.setVolume = (v) => got.push(['vol', v]); g.window.playSong = (i) => got.push(['play', i]); },
  });
  const p = send(h.dom, '音量 900，播第 0 首');
  await h.tick(3);
  await decide(h.dom, 'approve');
  await p;
  assert.deepStrictEqual(got, [['vol', 100]], '音量要钳到上限；序号 0（从 1 数）不该执行');
});
```

- [ ] **Step 2: 跑到红**

Run: `node --test test/ai-assistant-agent-loop.test.js`
Expected: FAIL —— app 步骤发出了 IPC 且 `seen.ipc` 非空。

- [ ] **Step 3: 实现**

视图里加一份 action 表（放在 `_appContext` 之前，注释照抄理由）：

```js
/**
 * 只在渲染层执行的能力。每一条都是**包一层 typeof 守卫**再调界面自己那个全局函数：
 * 这些函数按页面/模块加载顺序才存在（views/search.js 才装 playSong），没装就是没这个能力，
 * 此时必须如实报失败而不是让助手以为做了 —— 静默成功会让模型继续往上报「已经在放了」。
 */
const APP_ACTIONS = {
  'play.toggle': () => (typeof globalThis.togglePlay === 'function' ? (globalThis.togglePlay(), '已切换播放/暂停') : null),
  'play.next': () => (typeof globalThis.nextSong === 'function' ? (globalThis.nextSong(), '已切到下一首') : null),
  'play.prev': () => (typeof globalThis.prevSong === 'function' ? (globalThis.prevSong(), '已切到上一首') : null),
  'play.volume': (a) => {
    const v = Math.max(0, Math.min(100, Number(a && a.value) || 0));
    if (typeof globalThis.setVolume !== 'function') return null;
    globalThis.setVolume(v);
    return `音量 ${v}`;
  },
  'play.result': (a) => {
    const n = Number(a && a.index);
    // 状态段里的序号从 1 数，playSong 的数组下标从 0 数：越界就当没这回事，不执行
    if (!Number.isInteger(n) || n < 1 || n > 50) return null;
    if (typeof globalThis.playSong !== 'function') return null;
    globalThis.playSong(n - 1);
    return `开始播放第 ${n} 首结果`;
  },
  'ui.open': (a) => {
    const tab = String((a && a.tab) || '');
    if (typeof globalThis.switchTab !== 'function' || !tab) return null;
    globalThis.switchTab(tab);
    return `已切到页面 ${tab}`;
  },
};
```

`_execSteps` 在算完 `isWrite` 的预算之后、发 IPC 之前插一段：

```js
    if (meta.audience === 'app') {
      run.calls += 1;
      if (isWrite) run.mutations += 1;
      const fn = APP_ACTIONS[meta.action || ''];
      let done = null;
      try { done = fn ? fn(step.args) : null; } catch (e) { done = null; }
      const ok = typeof done === 'string';
      results.push({ tool: step.tool, ok, text: ok ? done : t('assistant.errAppOnlyTool') });
      _push(ok ? 'asst-step' : 'asst-step asst-step-failed',
        ok ? t('assistant.toolDone', { tool: step.tool }) : t('assistant.toolFailed', { tool: step.tool, msg: errBrief(t('assistant.errAppOnlyTool')) }));
      if (!ok) {
        const key = `${step.tool}|${JSON.stringify(step.args)}`;
        run.failures[key] = (run.failures[key] || 0) + 1;
      }
      continue;
    }
```

（`fn` 找不到 / 返回 `null` 都算失败，与止损共用同一份 `run.failures`。）

- [ ] **Step 4: 跑到绿**

Run: `node --test test/ai-assistant-agent-loop.test.js test/ai-assistant-plan-card.test.js test/ai-assistant-context.test.js test/ai-assistant-ui.test.js`
Expected: 全绿。boot 需要支持 `extraGlobalsHook`（在 `installBrowserGlobals` 之后往 `globalThis` 上挂函数即可 —— 本仓的 fake-dom 里 `window === globalThis`）。

- [ ] **Step 5: 提交**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "feat(ai): 助手能动手放歌了 —— 播放/切歌/音量/开页走渲染层那一份 action 表，一条 IPC 都不发" -- src/renderer/js/views/ai-assistant.js test/ai-assistant-agent-loop.test.js test/helpers/assistant-boot.js
```

## Task 15: P3 收口（提示、文档、CI、roadmap）

**Files:**
- Modify: `src/api/services/aiAssistantService.js`（规则段加一句播放控制）、`test/ai-assistant-service.test.js`
- Modify: `SECURITY.md`、`CHANGELOG.md`、`README.md`、`docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`

- [ ] **Step 1: 写失败的测试**

`test/ai-assistant-service.test.js` 追加：

```js
test('提示里说清「播放控制这一类只能在应用里做」，且它不构成对状态的指令', () => {
  const prompt = buildSystemPrompt(toolsFromContract());
  assert.match(prompt, /播放|音量/, '新面要在提示里有名字');
  assert.strictEqual((prompt.match(/只输出一个 JSON 对象/g) || []).length, 1);
});
```

- [ ] **Step 2: 跑到红 → 实现**

Run: `node --test test/ai-assistant-service.test.js`
Expected: FAIL（当前规则段没提播放控制）。

`buildSystemPrompt` 规则段那条「未列出的工具就是没有」之前插一行：

```
- 播放、暂停、切歌、音量、切页面这几类只在应用里能做成，未列出的能力就是没有。
```

Run: `node --test test/ai-assistant-service.test.js` → 绿

- [ ] **Step 3: 文档**

- `SECURITY.md` 第五节：助手那条补「助手现在也能操作播放器（播放/暂停/切歌/音量/切页面），这些只在渲染层执行、不进外部 Agent 的面，也不经任何新增 IPC」；外部 Agent 面白名单数用 `node -e` 现算再写。
- `CHANGELOG.md` `[未发布] → 新增` 合并成一条完整的「AI 助手 → AI Agent」，含 45 条能力、risk 三档、整份计划一次批准、24 次调用预算、播放控制；`→ 安全` 加一条「外部 Agent 的面从 17 条只增加到只读那 4 条，会删/清空一类它永远看不到」。
- `README.md` 助手条目改成一句能力概述。
- `docs/superpowers/plans/2026-10-14-ai-program-roadmap.md`：轨道五那行写「已落地（三枚收尾提交 + 三期各自 runner 证据）」。

- [ ] **Step 4: 全量本地闸门**

Run: `npm run lint && npm test && npm run check:dead-deps && npm run check:icons && npm run build && npm run smoke:asar`
Expected: 全绿。

- [ ] **Step 5: 提交、推送、取证据、并如实记下「只有用户能验的那一层」**

```bash
git -c user.name=Codebuddy -c user.email=codebuddy@local commit -m "docs: 助手变成 agent 这件事在文档里有三份口径 —— 外部面、确认形态、只在渲染层的那一类能力" -- SECURITY.md CHANGELOG.md README.md docs/superpowers/plans/2026-10-14-ai-program-roadmap.md
git push origin HEAD:main
```

Expected: 两条 job `success`。收口后必须写清（roadmap 那行与提交信息都要）：**真供应商下的批确认金路只能用户本人在应用里点**，agent 侧的证据到 CI 绿为止 —— 别把这枚增量读成「已验证」。

## 自审对照（写计划的人自己跑一遍）

- spec 六节 → 任务映射：一分层=Task 1/2，二清单=Task 3/11/13（不落地那半写在 Global Constraints），三协议=Task 8，四界面=Task 9/10，五数据边界=Task 4/7/15，六测试=每任务的 Step 1 与各期收口。无遗漏。
- 计划里出现的每个字段名（`risk`/`audience`/`action`/`scope`/`runId`/`why`）都在定义它的那个任务里被产出，签名一致。
- 无 TBD；两处「执行者自己选一种写法」的地方（Task 9 的 `box.checked`、Task 10 的 `formatToolResults` 跨层 import）都给了明确判据与必须补的测试。

## 交付顺序与停止条件

P1（Task 1-5）→ P2（Task 6-12）→ P3（Task 13-15）。每期以「两条 job success」为闸门，红着不进下期。
任何一期里如果发现 spec 的判据不够（比如某个通道其实依赖 `event.sender`），**停下来回到 brainstorming**，不要在计划里就地放宽白名单纪律。
