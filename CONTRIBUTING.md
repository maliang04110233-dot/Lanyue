# 贡献指南

感谢你愿意动手。这个项目有些**不太常见但很重要**的约定，第一次提交前请读完「铁律」一节 ——
它们不是风格偏好，而是被真实事故教出来的。

---

## 一、铁律（违反会被 CI 或 review 打回）

### 1. 主进程即 UI 线程 —— 文件 IO 必须异步

主进程没有独立线程池，它就是 UI 线程。一次 `fs.readFileSync` 卡住，表现为整窗无响应。

- 用 `src/utils/fsAsync.js`（`exists` / `statOrNull` / `ensureDir` / `removeQuiet` / `writeJson` …）
- 例外只有两处，且都必须在注释里写明理由：应用启动早期（事件循环还没跑）、
  退出路径（窗口已在关闭、同步写反而更确定）
- 已有反面教材：`utils/history.js` 的 `findDownloaded` 曾用同步 `existsSync`，被放进批量循环后
  在网络盘上卡住整个窗口（已修，并留了守卫测试）

### 2. 单一事实来源 —— 不要复制判据

本项目被同一条 bug 反复咬过：「路径包含判定」「HTML 转义」「JSON 原子写」都曾经存在
两份实现，然后各自漂移。凡是判「X 是不是 Y」「怎么把 X 编码进 Z」，一律复用既有模块：

| 需要什么 | 唯一入口 |
|---|---|
| 路径是否在允许目录内 | `src/main/approvedDirs.js`（`isApprovedDir`，双闸：词法 + realpath） |
| 真实路径复核 | 同上 `isInsideReal` / `isInsideRealAny`（fail-closed） |
| HTML/JS 转义 | `src/renderer/js/utils.js`（`esc` / `escQ` / `escAttr`）；拿不到全局版时用 `escapeFallback.js` |
| 原子写 JSON | `src/utils/atomicFile.js` |
| 日志 | `src/utils/logger.js`（分级 + 缓冲 + 轮转，**不要**直接 `console.log` 业务信息） |
| 默认下载目录 | `src/shared/downloadDefaults.js`（目录名字面量只允许出现在这里） |

### 3. 通道必须先在契约里登记

`src/shared/ipcContract.js` 是主进程与 preload 的唯一事实来源。新增/修改任何 IPC 通道：

1. 在 `CHANNELS` 里声明方向（`invoke` / `send` / `receive`）、可见窗口、参数规格
2. 主进程用 `src/main/ipc/register.js` 的 `handle` / `on` 注册（裸 `ipcMain.handle` 启动即抛错）
3. 渲染层用契约派生出的 `musicAPI.xxx` / `miniAPI.xxx`
4. 需要暴露给外部 Agent（MCP）时，再在 `src/main/mcp/tools.js` 显式加一行

未声明就注册 → 启动即抛；声明了没人注册 → `assertContractCoverage()` 在启动时点名。

### 4. 平台能力走 manifest，不要写死平台名

新增平台或改能力，读 `docs/architecture/ADD-A-PLATFORM.md`。能力位、探针清单、CORS 白名单、
换源候选、链接模式全部由 manifest 派生。

### 5. 换行一律 LF，入库前归一化

`.gitattributes` + `.editorconfig` + `test/encoding-guard.test.js` 三方钉死。
2026-09 那次「一个用例在 Windows 上必然失败」就是因为源码在磁盘上是 CRLF 而测试用正则
硬编码了 `\n`。**别用 PowerShell 的 `Get-Content`/`Set-Content`/`Out-File` 改文件**
（默认按 ANSI 码页解码，会写坏中文），要改用编辑器或显式 `-Encoding utf8`。

---

## 二、开发流程

```bash
npm install          # 首次
npm run dev          # 开发模式（含 DevTools）

npm run lint         # ESLint：src/ + test/ + scripts/ci-doctor.cjs
npm test             # node:test，全部离线（约 350 文件 / 3.4k 用例，约 55s；以 # tests 实跑为准）
npm run test:coverage# 带覆盖率
npm run bench        # 性能基准（有基线对比）
npm run verify       # 全链路闸门（七项串联，唯一权威）：
                     # lint → test → check:dead-deps → check:attack-surface
                     # → check:icons → build → smoke:asar
```

**提交前**：至少跑 `npm run lint && npm test`。改动落在 `src/main`、`src/utils`、`src/api`
时建议跑完整 `npm run verify`。

**提交信息**：祈使句 + 范围，如 `fix(queue): 取消后不再写历史`、`docs: 补架构全景`。
正文写「为什么」，不写「改了什么」——后者看 diff 就知道。

**要交付一个需求（而不只是改一段代码）**：走 [`docs/process/`](docs/process/README.md) 的流程规范。
选路看索引，档位判定看 `DEMAND.md`（L1/L2/L3 三档 + Q1–Q8 判定表），交接与门禁看
`COLLABORATION.md`、`DELIVERY.md`，编码与验收细则看 `ENGINEERING.md`、`QA.md`。

> 本文件的五条铁律是**编码纪律**（代码长什么样），`docs/process/` 是**流转纪律**（事情怎么走完）。
> 两者不重叠、不互替：铁律不过，代码不能合；流程不过，需求不能签收。

---

## 三、测试怎么写

- 框架是 `node:test`，零测试依赖。文件放 `test/*.test.js`（`npm test` 的 glob 只收这一层）
- **不触网**：单测必须可离线跑。需要网络的逻辑靠依赖注入（`deps` 对象）替换
- 渲染层模块**不在单测里 import**（依赖 `window`/`document` 会炸链），改用：
  ① 纯函数抽到独立模块再测；② 静态断言源码文本；③ 把源码读出来 `new Function` 求值
  （见 `test/escape-fallback.test.js`）
- Electron 主进程模块（顶层 `require('electron')`）同样无法 require，用静态守卫 + 注入
- 新增/修改行为 → 必须有用例。新增「不得再犯」的坑 → 加**守卫测试**并写清它在防什么

仓库里有一批守卫测试是这个思路的产物，值得先读一遍再动手：
`test/inline-handler-escape.test.js`、`test/encoding-guard.test.js`、`test/toast-i18n.test.js`、
`test/import-whitelist.test.js`、`test/update-signature-guard.test.js`。

---

## 四、改名与国际化

- 中文文案优先收编进 `src/renderer/js/lang/zh.json` + `en.json`（键同名）
- 暂时来不及收编的，`test/toast-i18n.test.js` 的「欠账台账」要求你把数字改对 ——
  这个测试的用意正是让「随手加中文」必须留痕（变多=欠账，变少=要去钉小）

---

## 五、代码风格

以 `.prettierrc.json` 为准（2 空格、单引号、`printWidth: 100`、es5 尾逗号）。
注释写「为什么」，不写「做了什么」——尤其是反直觉的取舍，本项目大量注释在解释
「为什么不用 A 而用 B」，这类注释是资产，不要删。

---

## 六、报告问题

请读 `SECURITY.md`：**安全问题不要开公开 issue**，走私下披露渠道。

普通 bug：GitHub Issues，附上
- 版本号
- 复现步骤
- `设置 → 导出诊断包` 产出的日志（已自动脱敏，见 `docs/architecture/OVERVIEW.md`）
