# 应用内 AI 助手 → AI Agent 升级设计

**日期**：2026-10-15
**状态**：已与用户逐节对齐（用户回「行」），待写实现计划
**目标（用户原话）**：「我需要把AI助手改成AI Agent 赋予更多的权限和工具调用能力」

## 摘要

把现在的「一次问 → 最多 12 次调用」的助手，改成一个有更大工具面、能交整份计划、
按风险分层决定确认形态、并允许跑到 24 次调用的 agent 循环。工具定义**只有一份**：
`src/main/mcp/tools.js` 的登记表同时供外部 MCP Agent 与应用内助手读，两份视图按风险与
执行位置过滤，而不是分叉成两张表。确认形态从「每个写操作各弹一次」改成
「整份计划预览 + 一次批确认」，真正危险的那类即使在批确认里也单独弹。

## 已锁的两条定调（用户 2026-10-15 选定）

1. **一张表两边一起扩**：新增工具只登记一次，MCP 侧与应用内助手侧共用；每个工具带风险级，
   低危自动执行、高危在应用内确认、过 MCP 的直接拒。
2. **计划预览 + 一次批确认**：模型先交整份多步计划，用户批一次后自动跑；改数据那类不再逐个弹，
   危险那类（删、清空）即使在批确认里也逐条弹。

## 事实基线（不是估计，是量出来的）

- 主进程 `invoke: MAIN` 的通道在 `92e5ffd` 上共 **111 条**（`src/shared/ipcContract.js`，本机数出来的），
  其中 **17 条**已在工具白名单里，**94 条没露出**。
- `add_to_queue` 早已是工具，它落在 `src/main/ipc/download.js:125` 的**下载**队列上 ——
  所以「助手不能发起下载」是假前提。真正没有通道的是**播放控制**。
- 执行面已收敛到一处：`src/main/mcp/agentBridge.js` 装配「白名单 + 契约钳制 + 审计 + 落 handler」，
  两个 caller 共用；写操作闸在主进程（`tool.mutating && confirmed !== true → NEED_CONFIRM`）。
- 助手循环在渲染层（`src/renderer/js/views/ai-assistant.js`），因为只有界面有 `askConfirm`。
- 每回合出网前已注入应用状态（`92e5ffd`）：正在播放 / 待播队列 / 本次搜索，1600 字符闸。
- 模型输出解析只有一份口径：`src/api/services/modelJson.js`（配平扫描取最后一个合形候选），
  并由 `test/ai-assistant-gate.test.js` 那道「`src/` 里不许冒出第四份 `[\s\S]` 取法」的门禁守着。

## 一、登记表：风险分层 + 执行位置

`src/main/mcp/tools.js` 每项新增两个字段：

- `risk`：`read` | `write` | `destructive`
  - `read` —— 只读，不改本机任何状态
  - `write` —— 改数据、可逆（入队、加歌单、标记已读）
  - `destructive` —— 删、清空、覆盖磁盘
  - （第四类「出网花钱」本轮**不建字段**：`ai-generate-*` 压根不进登记表，见第二节。
    与其留一个没有取值的枚举，不如等真要接计费工具那期再加。）
- `audience`：`both` | `app`
  - `both` —— 主进程有对应 handler，两侧都能执行
  - `app` —— 只能在渲染层执行（播放控制一类）

对「不分叉」的必要澄清：一份定义 ≠ 两边都调得到。播放控制在主进程里没有对应能力，
所以它是 `audience:'app'`，外部 Agent 永远看不到它 —— 这不是分叉，因为**定义仍只有一处**。

`mutating` 不再手写，由 `risk !== 'read'` 派生；一条测试钉住这两个字段不许各自说话。

### 两侧视图

- **MCP `tools/list`**：过滤掉 `audience==='app'` 与 `risk === 'destructive'`。
  外部 Agent 新增的面只有只读工具，既有的「查询 + 加法动作」纪律一字不动。
- **应用内助手**：全部可见，`risk` 决定确认形态。

### 信任边界仍在主进程

`ai-assistant-tool-call` 契约加第三个参数 `scope: 'batch' | 'single'`：

| risk | 放行条件 |
|---|---|
| `read` | 无条件 |
| `write` | `confirmed === true`（`batch` 或 `single` 均可） |
| `destructive` | `confirmed === true && scope === 'single'` |

渲染层出 bug 也伪造不出「一次批准跑掉删除」：批量令牌在主进程换不到危险步骤。
拒绝时仍回 ASCII 令牌（新增 `AGENT_SCOPE_MISMATCH`、`AGENT_RISK_REFUSED`），措辞在词典里。

## 二、新工具清单（分四期，每期独立可交付）

### P1 只读扩面（`risk:'read'`、`audience:'both'`）

`subscribe-list`、`get-download-templates`、`load-play-queue`、`aggregate-cross-source`、`probe-sources`。

### P2 应用内写

- `write`：`cancel-download`、`retry-download`、`remove-queue-item`、`reorder-queue-item`、
  `set-queue-paused`、`clear-finished-queue`、`add-playlist-to-queue`、`remove-from-user-playlist`、
  `subscribe-add`、`subscribe-mark-seen`、`save-play-queue`
- `destructive`：`clear-all-queue`、`clear-history`、`remove-history`、`delete-user-playlist`、
  `subscribe-remove`、`delete-download-template`、`clear-play-cache`

### P3 播放控制（`audience:'app'`）

播放/暂停、下一首、上一首、设音量、播放队列第 i 首、打开某个页面。
**零新 IPC**：状态本来就在渲染层，代价是新增一份「app 工具 → 渲染层函数」的映射表；
它不进 MCP，也不走 `ai-assistant-tool-call`（主进程帮不上）。

### 明确不落地（写下来是为了别被当成漏网）

- **P4 文件类高危**（`delete-file`、`rename-file`、`update-id3-tags`、`write-local-lrc`）：
  这些通道的参数是任意绝对路径，模型编一个路径就是删盘。要做必须先有一道主进程闸
  「路径必须出现在本会话观察到的候选集里」，那道闸本身值一期，不值得排在前面。
- **计费类**（`ai-generate-music`、`ai-generate-lyrics`、`ai-translate-lyrics`）：
  用户已定调 agent 不代花额度，这轮不进工具面。
- **永不露出**：cookie/登录五条、`set-pref`、`ai-provider-save`（Key）、`mcp-set-config`、
  `cloud-sync-config-set`、`import-all-data`、`export-all-data`、更新安装三步、`system-power`、
  `open-external`、`open-folder`、`select-dir`。

## 三、协议：继续用私有严格 JSON

不换厂商原生 function calling。理由：`src/api/aiProviders.js` 刚接进来的多家国内厂商，
工具调用的支持与参数风格参差不齐，而本仓的模型输出解析刚收成一份 `modelJson.js` 加一道
「不许有第四份口径」的门禁；换协议等于按厂商分叉。

计划形态（在既有 `steps` 上加 `why`）：

```json
{"reply":"…","steps":[{"tool":"search_music","args":{"keyword":"…"},"why":"给用户看的一句话"}]}
```

- 执行完把观察结果当一条 user 消息回喂，循环到 `steps` 为空或触预算。
- `why` 是批确认面板上唯一的人话来源：必须截断、只当文本渲染（沿用既有那套「含标签也只当文本」管法）。
- 上限：`MAX_TURNS` 3 → 6、`MAX_STEPS_PER_TURN` 4 → 8，新增整局 `MAX_RUN_CALLS = 24`、
  `MAX_RUN_MUTATIONS = 12`。
- 止损：同 tool + 同 args 连续失败两次即停止，把错误摊给用户，不许打转。

## 四、界面：计划卡 + 一次批确认

模型出计划 → 渲一张计划卡：

- 每行 = 工具人话名 + args 摘要 + `why` + 风险徽章（读 / 写 / 删），复选框默认全勾。
  勾选与执行载荷的一致性做法复用 AI 智能歌单那套（已在真 DOM 验过）。
- 底部一句总账：「批准 5 步，其中 2 步会改数据」。
- 三个动作：批准并执行 / 只跑只读那几步 / 取消。
- `destructive` 的行不进批量队列 —— 跑到那一行才单独弹（`scope:'single'`）。
- 执行中每行原地更新 ✓/✗ 与结果摘要（截断）；单步失败不中断后续，除非触止损。

## 五、数据边界

- 新只读工具会把订阅名、队列内容、跨源结果发给厂商：`SECURITY.md` 第五节那条 bullet 逐字段重写。
- **喂回模型的观察结果走同一份字段白名单**（`title`/`artist`/`id`/`source`/`duration`，
  剥掉 `localPath`/`lyrics`/cookie/token）。工具返回值是**第二条出网路**，
  现在「歌词与本地路径不出网」只守住了上下文那条 —— 脱敏必须落在桥里一处，不许各调用方自己剥。
- 审计每条步留 `runId` / `scope` / `risk` / `approved`；限流按 run 计。
- CHANGELOG、README、SECURITY 同步。

## 六、测试策略

1. 两侧视图门禁：`audience==='app'` 或 `risk === 'destructive'` 的工具
   **绝不出现在 MCP `tools/list`**。
2. `mutating` 与 `risk` 不许分叉；`risk` 取值必须在允许集合内；非 `read` 必须有确认路径。
3. scope 闸：伪造 `{confirmed:true, scope:'batch'}` 调 `destructive` → 仍 `NEED_CONFIRM`。
4. 观察结果脱敏：返回值里塞 `localPath`/`lyrics`/cookie 假标记，喂回模型的文本里必须找不到。
5. 界面行为（headless harness）：取消后零执行；去掉勾选后执行载荷恰好少那一步；
   `why` 里的 `<img>` 只当文本。
6. 契约不漂：每个工具的 `channel` 必须在 `CHANNELS` 且参数规格由契约派生（既有做法）。
7. 金路只能用户本人在应用里点（真供应商），这一层不在 agent 的完成判据里。

## 交付顺序

P1 → P2 → P3，每期独立可交付、CI 两条 job 绿了才进下期。P4 与计费类默认不做，
要做得由用户重新拍板并先补「路径必须来自本会话观察」那道闸。

## 代价与风险

- 契约新增第三个参数与两个错误令牌，`test/ai-assistant-gate.test.js` 那批钉要跟着改。
- 渲染层循环变长（最多 6 回合 × 8 步），出网次数与 token 开销同比上升。
- `audience:'app'` 是登记表的第一个「两侧执行位置不同」的字段，读代码的人要多带一个前提：
  看到工具名 ≠ 它能从主进程调到。
- 观察结果脱敏集中到桥里，会改变既有工具返回的形态（模型看到的字段变少了）；
  这是刻意的收紧，不是回归。
