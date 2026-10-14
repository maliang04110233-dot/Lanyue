# 安全策略

本文件说明揽乐（Lanyue）的安全边界、**已知未闭合项**以及漏洞报告方式。

---

## 一、报告漏洞

**请不要用公开 issue 报告安全问题。**

- 私密渠道：GitHub 仓库的 Security Advisory（`Security` 标签 → `Report a vulnerability`）
- 或直接联系作者：`https://github.com/maliang04110233-dot/Lanyue`

请在报告里给出：

| 项 | 说明 |
|---|---|
| 复现步骤 | 尽量最小化 |
| 影响面 | 例如「渲染层任意 JS」「任意文件写」「凭据泄漏」 |
| 版本 | `设置 → 关于` 里的版本号 |
| 日志 | `设置 → 导出诊断包` 的产物（**已自动脱敏**，仍建议人工过一眼） |
| 发现的途径 | 源码阅读 / 模糊测试 / 实际触发 |

我们会在 7 天内给出初步回应（含是否受理、预计修复节奏）。

---

## 二、支持版本

| 版本 | 修复安全性问题 |
|---|---|
| 1.0.36 及以后 | ✅ |
| 1.0.35 及更早 | ❌ 仅建议升级 |

本项目尚未发布商业化支持窗口；1.0.36 之前的版本不再回补。

---

## 三、当前安全边界（已落实）

以下都是有代码证据的既成事实，位置写出来是为了让报告者能自行核对：

| 面 | 现状 | 位置 |
|---|---|---|
| 渲染层隔离 | `nodeIntegration: false` + `contextIsolation: true`，四处窗口全部一致；二级窗口（迷你播放器 / 桌面歌词）额外禁止一切导航与新开窗 | `src/main/index.js`、`src/main/ipc/window.js`、`src/main/loginWindow.js` |
| 桥接暴露面 | preload 只暴露契约派生出的通道；未授权通道调用只记日志不放行 | `src/main/preload.js`、`src/main/preload-secondary.js` |
| IPC 契约 | 通道必须在 `ipcContract` 登记，主进程入口统一做参数钳制，未声明即启动抛错 | `src/shared/ipcContract.js`、`src/main/ipc/register.js` |
| SSRF | 统一 URL 守卫：IP 编码归一化（十进制/十六进制/八进制）、IPv4-mapped IPv6、NAT64、DNS rebinding pinning、重定向逐跳复检、拒绝 https→http 降级、跨 host 剥离 Cookie/Authorization | `src/utils/urlGuard.js`、`src/api/request.js` |
| 路径沙箱 | 双闸：词法快筛 + `realpath` 复核；无法验证时 **fail-closed**（判否而非放行）；junction 经 `readlinkSync` 逐段解析 | `src/main/approvedDirs.js` |
| 凭据存储 | 三态模型：可用则 DPAPI（Windows `safeStorage`）加密；**系统加密不可用时拒绝写入**，绝不静默明文落盘 | `src/utils/secretStore.js` |
| AI 调用面（外部 Agent + 应用内助手） | MCP 仅监听 `127.0.0.1`，Bearer 令牌 `timingSafeEqual` 比较，Origin 白名单只放行回环，请求体 1 MiB 上限，令牌桶限流（429 + `Retry-After`），工具白名单排除凭据/文件写入/设置/更新安装，写操作在应用内必须逐条确认，调用留审计（`source` 区分 agent/assistant），MCP 服务默认关闭 | `src/main/mcp/`、`src/main/ipc/mcp.js`、`src/main/ipc/ai-assistant.js` |
| XSS | 8 类远端数据逐条转义后入 DOM；内联事件处理器必须用 `escQ`（有全仓守卫 + 别名绕过检测） | `src/renderer/js/utils.js`、`test/inline-handler-escape.test.js` |
| 日志脱敏 | 落盘前统一过一遍：URL 敏感查询参数、Cookie/Authorization/token 形态 | `src/utils/redact.js`、`src/utils/logger.js` |
| 供应链 | `npm audit --omit=dev --audit-level=high` 进 CI；`overrides` 锁上游脆弱子依赖；打包时剔除已验证的死依赖链 | `.github/workflows/ci.yml`、`package.json`、`build/config.cjs` |

---

## 四、已知未闭合项（我们知情，且有缓解措施）

诚实列出来，因为「不知道」比「知道但没修」更危险。

### 1. Windows 代码签名未启用 —— 自动更新的信任根尚未收敛

- 现状：安装包**未做代码签名**，产物 `app-update.yml` 不含 `publisherName`，
  因此 `verifyUpdateCodeSignature` 这个开关不产生实际约束。
- 缓解：第三方镜像兜底已做成 **fail-closed** —— 检测到无 `publisherName` 就直接拒绝切换
  feed 并向用户说明原因，宁可更新失败也不静默安装来路不明的安装包。
- 关闭条件：配置代码签名证书（`win.certificateFile` / `certificateSubjectName`），
  `publisherName` 出现后闸门自动放行。
- 设置页常驻提示「当前更新包未启用安装包签名校验，请仅从官方渠道获取」。

### 2. 本地 API 依赖上游第三方 SDK

- `NeteaseCloudMusicApi` / `qq-music-api` 为第三方维护，其安全性不在本项目控制范围内。
- 缓解：`overrides` 锁定其脆弱子依赖；打包剔除已验证从不被加载的死依赖链；
  审计门禁（见下）对未豁免的 high/critical 仍然红灯。

### 3. 依赖漏洞的显式豁免清单

`npm audit` 会把「lock 里有漏洞」与「这份代码会被执行」混为一谈，而这两类情况的正确
处理方式相反：不可达的包升级它没有收益（只把发版永久堵死），可达但上游锁死的包则
根本修不了。因此审计门禁改为 `scripts/audit-gate.cjs`：读 `scripts/audit-allowlist.json`
的显式豁免，**剩余的 high/critical 仍然阻断**。

豁免分三类，每条都带理由与核查日期（缺任一字段门禁直接失败 —— 豁免必须是可复核的
判断，不是黑名单）：

| 分组 | 包 | 依据 |
| --- | --- | --- |
| `unreachable_excluded` | `jade` `constantinople` `uglify-js` `transformers` `clean-css` | 运行时插桩与源码静态引用（`scripts/check-dead-deps.cjs` 的判据）均未命中，且 `build/config.cjs` 已把它们排除出 asar —— 不在发布产物里 |
| `unreachable_but_packaged` | `useragent` | 同上判据未命中；差别是会打进产物，故单列以示区分 |
| `upstream_locked` | `NeteaseCloudMusicApi` `express` `body-parser` `path-to-regexp` `node-forge` `basic-ftp` `get-uri` `pac-proxy-agent` | **可达**（运行时插桩确认该 SDK 确实起了 express 服务，不是死代码），但 `NeteaseCloudMusicApi@4.32.0` 已是最新，修复需跨大版本升级其内置依赖，会破坏它的 HTTP 服务行为 |

配套约束：

- 能安全升级的已经升了（`overrides`：`proxy-addr@^2.0.8`、`moment@^2.31.0`、`qs@^6.16.0`
  —— 同大版本或 patch 级），升级后 2816 条单测与 `check:dead-deps` 均通过。
- 豁免清单里若有条目**当前已无对应漏洞**，门禁会报错要求移除 —— 豁免不得只增不减，
  否则它会变成掩盖新问题的集合。
- `unreachable_*` 的依据是可达性判据，与 `check:dead-deps` 配套：任何人把这些包加回
  运行路径，那条检查会红。
- 复核触发点：`NeteaseCloudMusicApi` 发布新版本时重新评估 `upstream_locked` 组。

残余风险：`upstream_locked` 那批是**真实可达**的依赖，其漏洞并未消除，只是当前无
可行的修复路径。已确认的实际缓解面：出网请求统一过 `utils/urlGuard.js` 的
SSRF 校验（scheme/userinfo/DNS 全记录/内网 IP 判定），且不可达的模板引擎链已
从产物中移除。

### 4. 本地服务的频率限制（已闭合，但风险没有消除）

- 现状：MCP 传输层有令牌桶（默认突发 `capacity 120`、稳态 `refillPerSec 30`/秒），
  超限返回 **429 + `Retry-After`**，批量 JSON-RPC 按整批计一次。
- 计量口径：只有**通过鉴权与 Origin 校验**的请求才吃桶。否则任何本机进程都能拿垃圾
  请求把合法 Agent 饿死——那等于把「无速率限制」换成「拒绝服务」。
- 这不是风险消除：令牌仍存在本机可读的加密存储里，绑定回环只挡得住局域网，
  拿到令牌的进程依然能调用白名单内的工具。限流只是把「一个写坏的客户端刷满磁盘 /
  刷爆下载队列」降级为「短时不可用」。
- 位置：`src/main/mcp/mcpServer.js`，行为钉在 `test/mcp-rate-limit.test.js`（注入时钟，不靠 sleep）。

### 5. 本地服务调用审计

Agent 通过 MCP 做的每一次 `tools/call` 都写一条审计：`userData/mcp-audit.json`，
滚动保留最近 **200** 条，设置页可查看与清空。

- 记什么：工具名、来源、耗时、成败、错误摘要，以及检索词类参数的**截断摘要**（60 字）。
- 不记什么：密钥 / 令牌 / Cookie / 密码 / session 一类参数**只留键名，值不落盘**
  （判定规则见 `auditStore.js` 的 `isSensitiveArg`，按驼峰与下划线拆词后整词匹配，
  因此 `keyword` 不会被误伤、`aiMusicApiKey` 一定会被拦下）。
- 边界：审计文件不进 WebDAV 快照、不进导出备份；写入是 fire-and-forget，写盘失败只记
  警告，绝不拖慢或阻塞 Agent 的响应。
- 位置：`src/main/mcp/auditStore.js`、`src/main/ipc/mcp.js`，端到端链路在 `test/mcp-e2e.test.js`。

### 6. 两个调用方，一张白名单（外部 Agent 与应用内 AI 助手）

应用内助手（侧栏「AI 助手」）不是第二套权限：它能看到、能调用的就是外部 Agent 那
**17 个工具**，且执行走**同一条进程内桥**（`src/main/mcp/agentBridge.js`），因此参数钳制、
契约拒绝语义与审计落点两边一致 —— 助手侧比 Agent 松就是实锤的漂移，钉在
`test/ai-assistant-e2e.test.js`。

差异只有一处，且是收紧不是放宽：**改动曲库或队列的三个写操作**
（`add_to_queue` / `add_to_playlist` / `toggle_favorite`）在应用内必须逐条经用户确认，
判据是主进程 handler 上的 `confirmed === true` 参数（`src/main/ipc/ai-assistant.js`），
不是「界面已经问过了」这种口头承诺；被拒的调用不进桥，因此不出现在审计里。
助手的审计与 Agent 的写在同一个文件，靠 `source` 字段区分（`agent` / `assistant`）。

### 7. AI 智能歌单（轨道三）：只读生成，写库仍是那一下点击

「说一句主题 → 从你已有的歌里挑 → 存成普通歌单」走一条**新的 invoke 通道**
`smart-playlist-generate`（`src/main/ipc/smart-playlist.js`），它**不在** MCP 的 17 个工具白名单里，
也不产生审计条目 —— 因为它什么都不改。边界由三处共同保证：

- 主进程侧只读 `prefs` 里的 `userPlaylists`（不用 `ensureFavorites()`，那个在缺单时会建单落盘），
  只出网**一次**，返回的是候选清单里挑出来的**原歌曲对象**；
  钉在 `test/smart-playlist-primary.test.js`：生成前后 `userPlaylists` 必须逐字相等。
- 渲染层侧「存为歌单」是唯一落库出口，走既有 `save-user-playlist` 通道，
  并且只收用户勾上的那些行；钉在 `test/smart-playlist-ui.test.js`：
  `api.saveUserPlaylist(` 在整个视图文件里恰好出现一次，且不在生成函数内。
- 候选上限 **400 行**（`序号 标题 歌手`），超出部分如实回传 `truncated` 并显示在界面上 ——
  不让人以为模型读完了整个曲库。

挑选范围只有三类，全部是「你已经攒下、且能播」的歌：全部歌单的并集、只看红心、只看某一单。
**刻意不含本地文件库**（`library-index.json`）：那里的条目只有 `filePath` 没有 `id`/`source`，
而歌单行的播放路径是 `getDownloadUrlSmart(song)`，存进去就是一排播不动的死行。

一次生成会把你的**歌名与歌手**（上限 400 行）连同主题发给 MiniMax（`api.minimaxi.com`）；
这是本条功能唯一的出网面，返回的歌单只在界面内存里，落库后与你手建的歌单同一份存储。


---

## 五、应用自身的数据边界

- 平台 Cookie 与 API Key 用系统加密存储在 `userData` 下，**不进 WebDAV 快照、不进导出备份**
- WebDAV 密码与 MCP 令牌同样加密；日志落盘前脱敏
- WebDAV 快照只含歌单 / 下载模板 / 下载历史，不含目录等本机设置，也不含 MCP 调用审计
- 导出诊断包前会对偏好值再做一次脱敏（`aiMusicApiKey` 等键一律剔除）
- 应用内 AI 助手会把你的对话文本与工具返回的歌曲标题发给 MiniMax（`api.minimaxi.com`）；
  对话只存在界面内存里（不写盘、不同步），调用记录落本机 `userData/mcp-audit.json`，
  两者都不进 WebDAV 快照与导出备份
- AI 智能歌单会把挑选范围内最多 400 行的**歌名与歌手**（不含文件路径、不含 Cookie）
  连同主题发给 MiniMax；生成的结果只在界面内存里，只有你点「存为歌单」才落本机 prefs

---

## 六、用户自查清单

1. 只从官方渠道获取安装包（项目主页 Releases），不要用第三方镜像的安装包
2. 若启用了 MCP，记住它是一个**本机 HTTP 服务**；不用时在设置里关掉
3. 分享日志或诊断包前扫一眼：虽然已脱敏，但你的歌名/路径仍属于个人信息
4. 升级前看 `CHANGELOG.md` 的「安全」小节
