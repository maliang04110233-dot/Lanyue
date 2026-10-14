# AI×揽乐 升级计划集（Program Roadmap）

> **For agentic workers:** 本文件只是索引与切分理由。每份轨道计划都是独立可交付、
> 独立可测试的单元，按编号顺序执行；执行某条轨道时用 superpowers:subagent-driven-development
> 或 superpowers:executing-plans，逐任务实现。

**目标（用户原话）**：AI与项目结合升级当前项目。

**为什么拆成四份**：这四条轨道落在四个互不依赖的子系统上 —— MCP 服务面
（`src/main/mcp/` + `src/main/ipc/mcp.js`）、渲染层新面板（`src/renderer/js/views/` + 新 tab）、
曲库/历史数据面（`src/utils/historyStore` + 歌单）、CI 工具链（`.github/workflows/` + `scripts/`）。
合成一份计划会让每份交付物都失去「独立可测试」的边界，也让 reviewer 无法
「驳回后一条而放行前一条」。

| # | 轨道 | 计划文件 | 依赖 | 状态 |
|---|------|----------|------|------|
| 1 | MCP 一等公民化 + 调用审计 + 速率限制 | `2026-10-14-mcp-first-class.md` | 无 | 已落地（收尾 e5320a1） |
| 2 | 应用内 AI 助手（复用 MCP 工具面做 function-calling） | `2026-10-14-in-app-ai-assistant.md` | 轨道 1 的 `auditStore` / `onCall` 钩子 | 已落地（3dcd2a5 起六枚提交，收尾 b8e8059）；推送+CI 已绿（`e44df72` 两条 job success），界面实测：机制四条已在真 DOM 点到（只读直连、写前真弹层、取消零执行、回复含标签只当文本），欠账只剩「真供应商回复形态」一层，待用户 Key |
| 3 | AI 智能歌单（**打标已砍**，见下方说明） | 无计划文件：范围收到一处 bounded 改动，直接按 TDD 落地 | 轨道 2 的出网通道 `assistantChat` 与严格 JSON 协议 | 已落地（4e28237）；行为单测 16 枚 + CDP 真点离线链，CI 同上一条一起绿 |
| 4 | AI 接管研发流水线（CI 归因 + 复审 agent） | 无计划文件：归因是一处 bounded 改动（只碰 `.github/workflows/` 与新脚本），直接按 TDD 落地 | 无（与 1-3 并行不冲突） | 归因侧已落地并在 runner 上验绿（`1302f35` → `05e31ed` → `84fa480` → `dec890b`，两个 job 全成功）；复审 agent 未动 —— 它必然要出网花钱，与归因半侧无共享写入点，另立计划再说 |

**轨道 4 为什么先只做归因**：归因引擎已定**纯确定性规则，CI 不出网、不花钱**
（2026-10-14 用户选定；LLM 摘要与本地 agent 两个备选都否了）。它读的是一段已经被
`bb5cfba` 完整搬进 annotation 的 TAP 文本 —— 判据来自本轮红四天的现场：同一个 `not ok`
可以是真回归、可以是异步泄漏误归属、可以是测试偷偷出网、可以是指纹漂移、也可以压根不是
代码问题，这五种的正确处置方向相反，靠人对着原文分辨就是把归因推回给人。
落地时顺带清掉三处旧账：详情窗口从「not ok 后 26 行」改成「前 3 行 + 后 26 行」（node 把
用例结束后的异步活动报成整文件级失败，真凶地址写在**前面**那行 `# Error:` 里，只取后文必然丢掉）；
`73a7ce7` 的 probe 调试行删掉（它每次绿跑都发一条 `::error::`，是训练「红了也忽略」）；
步骤体首行强令控制台 UTF-8（不设则落盘的 TAP 里中文静默损坏 —— 回显时按同一码页编回去，
看起来一切正常）。两条 workflow 的命令体现在逐行相同，由 `test/ciDoctor.test.js` 的形状钉守着 ——
分叉过一次，代价是那条 probe 行只在一侧被删掉、在另一侧又活了四天。
归因引擎还补了一处死角：`scripts/` 整目录不过 lint，而 CI 里其他脚本都被某条步骤**执行**过、
语法错误当场就炸 —— 只有它在绿跑里跑不到（`passed on attempt 1` 直接 exit 0），坏掉的时间点
恰好是唯一需要它的时刻，所以它被单独纳进 `npm run lint`。
**留白（不是遗漏）**：红路（三次尝试全红后才调归因）至今没在真 runner 上跑过一次 —— 落地后
唯一的红是 `84fa480` 那次，红在 lint 步、压根走不到单测步。本地是用真 TAP + 真 PowerShell
模拟验过的，另有一条测试守住「归因全程不产生任何对外连接」。要拿到 runner 侧证据得故意让 main 红一次，
那是给别人看的噪音，不值得为一条已三重覆盖的路径去制造 —— 记下即可。
复审 agent 不同：它得读 diff 之外的东西（需求、历史、运行时行为），不出网做不到，
于是与本轨道的「零成本、零出网」口径直接冲突。

**轨道 2 剩下的三条为什么没拿本地假端点代跑**：要绕过 Key 把「找歌 / 入队确认 / 取消」跑完，
唯一的路是给 `MINIMAX_API_BASE`（`src/api/ai-music.js`）加一条 env 覆盖。刻意没做，两个理由：
① 那条请求带着 Bearer 计密钥，把它的目的地做成环境变量可指 = 给「谁能让这台机器起一个进程」
多开一条凭据外泄通道，与 `SECURITY.md` 的口径相反；② 换来的覆盖是重复的 ——
`planAssistantTurn` 的 `chat` 本来就是注入的，协议解析、白名单钳制、确认闸门、审计落点都已有
拿假 chat 跑过的单测，真没验的只剩「模型按协议答话时上游通不通」，那只有真 Key 答得出。

**机制半侧已在真 DOM 里点过**（2026-10-14，不出网、不要 Key）：脚手架是一个静态服务
`src/renderer` 的一次性 harness，把 `window.ipcRenderer` 按 preload 的真实语义打桩 —— 未授权通道
返回 `undefined`（生产就是这么静默）、信封已由 preload 解过所以桩返回渲染层实际拿到的东西、
白名单直接取主进程注入的同一份 `buildContractArg('main')` 而不是另攒一份。四条结论：
只读步骤不弹确认、`confirmed` 传 `false`；写步骤先弹**真**确认框（标题「助手想执行：add_to_queue」，
参数原样列在正文），点确认后才有那一次 `confirmed=true`；点取消则该步零次 tool-call、
上屏「已取消：toggle_favorite」且循环继续走到下一回合；模型回复塞 `<img src=x onerror=…>` 时
消息节点零子元素、文档里零注入 `img`。harness 用完即删 —— 它换到的是「界面侧断言从源码形状钉
升到真 DOM 观察」，重建做法已写在这段里。欠账因此收窄成一层：**真供应商的回复形态**。

**轨道 3 为什么只剩一半**：曲库自动打标原计划把标签写进 `library-index.json`，
读时再 join 回歌单。动手前对着源码否掉了 —— `incrementalScan` 在文件 mtime 变化时执行
`existingTracks[idx] = meta`（`src/utils/libraryIndex.js:164`），整条索引条目被元数据读取器
的返回值**原样覆盖**，标签活不过一次重新扫描；换目录时更是整个索引清空（同文件 103 行）。
要活下去它就得变成第三份存储 + 第二套 join，那是为"顺手加个字段"付出的永久性复杂度。
智能生成歌单不依赖打标，且它自身就是用户要的那件事，于是留下它、砍掉打标。

**依赖方向的唯一理由**：轨道 2 的助手要把每次 LLM 工具调用记进同一份审计
（用户在设置页里能看到「AI 助手替我做了什么」），所以 `auditStore` 与
`createMcpHandler` 的 `onCall` 钩子必须先存在。其余轨道彼此无共享写入点。

## 全程序硬约束（每条轨道都受用）

- **零新增依赖**：`package.json` 的 dependencies 不许因为这几条轨道变长
  （`docs/archive/AI_MUSIC_RESEARCH_2026-09-19.md:51,54` 已写明离线 whisper/demucs、
  CLAP 语义检索因体积与 GPU 依赖**不做**）。
- **不迁框架、不上 TS、不改进程模型**：`docs/REFACTOR_PLAN_2026-09-17.md:10`。
- **MCP 工具白名单红线**：cookie/登录、文件路径读写、set-pref、对话框、更新安装
  一律不进工具面（`src/main/mcp/tools.js:8-9`、`SECURITY.md`、研究文档 `:66`）。
- **AI 翻唱/人声转换不做**（版权+表演者权风险，研究文档 `:55`）。
- **IPC 契约是唯一事实来源**：新通道先声明进 `src/shared/ipcContract.js`，
  再在 `src/main/ipc/register.js` 的 `handle()` 注册；preload 白名单自动派生。
- **文案必须进词典**：`src/renderer/js/lang/zh.json` 与 `en.json` 同步加键；
  `src/renderer/js/views/settings.js` 属 `test/toast-i18n.test.js` 的 `CONQUERED`（欠账 0），
  新代码不许往 `showToast()` 里塞中文字面量，否则台账与门禁一起翻脸。
- **开关值只准一处**：`src/renderer/js/features.js` 的 `FEATURES`；`ai: false`（AI 创作）
  是 4ffa7ea 里定下的**产品决定**，任何轨道都不许顺手翻它。
- **只发 Windows**：`release.yml:16-18`；不做代码签名（`SECURITY.md §4`）。
- **五层闸门必须全绿**：`npm run lint`（0 error）→ `npm run audit:deps` →
  `npm run check:dead-deps` → `node --test --test-concurrency=2 "test/*.test.js"` →
  `npm run build` → `npm run smoke:asar`。单测在本机汇总为 `ℹ tests N / ℹ pass N / ℹ fail N`，
  判绿只认 `ℹ fail 0`（管道 grep 会吞退出码，见项目记忆）。
- **本机 git 无全局身份**：提交用 `git -c user.name=CodeBuddy -c user.email=codebuddy@local commit`。
- **推送需要代理覆盖**：`git -c http.proxy= -c https.proxy= push`（全局配置指向 127.0.0.1:10809 且通常没开）。
