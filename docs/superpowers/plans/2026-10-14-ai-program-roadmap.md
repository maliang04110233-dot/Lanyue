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
| 1 | MCP 一等公民化 + 调用审计 + 速率限制 | `2026-10-14-mcp-first-class.md` | 无 | 待执行 |
| 2 | 应用内 AI 助手（复用 MCP 工具面做 function-calling） | `2026-10-14-in-app-ai-assistant.md` | 轨道 1 的 `auditStore` / `onCall` 钩子 | 待编写 |
| 3 | AI 智能歌单 / 曲库自动打标 | `2026-10-14-ai-playlist-tagging.md` | 轨道 2 的助手循环（作为它的两个工具落地） | 待编写 |
| 4 | AI 接管研发流水线（CI 归因 + 复审 agent） | `2026-10-14-ai-ci-doctor.md` | 无（与 1-3 并行不冲突） | 待编写 |

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
