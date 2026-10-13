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
| 本地服务 | MCP 仅监听 `127.0.0.1`，Bearer 令牌 `timingSafeEqual` 比较，Origin 白名单只放行回环，请求体 1 MiB 上限，工具白名单排除凭据/文件写入/设置/更新安装，默认关闭 | `src/main/mcp/`、`src/main/ipc/mcp.js` |
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

### 4. 本地服务无速率限制

- MCP 服务只靠 Bearer 令牌与 Origin 白名单防误触，没有请求频率限制。
- 影响面限于**本机**（监听回环），且需要先拿到令牌。

---

## 五、应用自身的数据边界

- 平台 Cookie 与 API Key 用系统加密存储在 `userData` 下，**不进 WebDAV 快照、不进导出备份**
- WebDAV 密码与 MCP 令牌同样加密；日志落盘前脱敏
- WebDAV 快照只含歌单 / 下载模板 / 下载历史，不含目录等本机设置
- 导出诊断包前会对偏好值再做一次脱敏（`aiMusicApiKey` 等键一律剔除）

---

## 六、用户自查清单

1. 只从官方渠道获取安装包（项目主页 Releases），不要用第三方镜像的安装包
2. 若启用了 MCP，记住它是一个**本机 HTTP 服务**；不用时在设置里关掉
3. 分享日志或诊断包前扫一眼：虽然已脱敏，但你的歌名/路径仍属于个人信息
4. 升级前看 `CHANGELOG.md` 的「安全」小节
