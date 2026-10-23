# P1 · 用户自定义音源插件机制设计

> 状态：**部分实现**（静态分析器 + hostApi 白名单已完成，沙箱运行时待做）
> 参考：GitHub 项目 lx-music-desktop 的隐藏窗口脚本沙箱（已读其源码）
> 依据：Lanyue v1.0.35 的 manifest 插件体系 + IPC 契约 + MCP 工具面的实际代码
>
> 已完成（2026-10-22，测试 3439/3439 全绿）：
> - `src/main/userSourceValidator.js` — 静态分析器（36 个用例）
> - `src/api/userSources/hostApi.js` — 宿主 API 白名单（16 个用例）
>
> 待做：沙箱运行时（utilityProcess / 隐藏窗口）、registry、preload、MCP 工具面

---

## 一、先说结论：不要照抄 lx-music

读完 lx-music 的 `src/main/modules/userApi/main.ts` 后，它的做法是：

- `show:false` 的隐藏 `BrowserWindow` 跑用户 JS 脚本
- `contextIsolation:true` / `nodeIntegration:false` / `sandbox:false`
  / `webgl:false` / `images:false` / `disableDialogs:true`
- `webContents` 事件黑名单：`will-navigate` / `will-redirect` /
  `will-attach-webview` / `will-prevent-unload` / `media-started-playing`
- `setPermissionRequestHandler` 一律 reject；`setWindowOpenHandler` 一律 deny
- 关闭时 `clearAuthCache` + `clearStorageData` + `clearCache` 三清
- **内置音源目录已清空，改由用户导入脚本**（规避法律风险）

**Lanyue 不应照抄**，三个理由：

1. **模型不匹配**：Lanyue 的 manifest 是**静态声明式**（能力位 / 域名 / 链接模式），
   用户脚本是**动态行为**。硬塞进 manifest 会破坏现有推导体系
   （`pluginRegistry.js:25-46` 的 `CAPABILITY_METHODS` 由**方法存在性**推导）。
2. **出网通道必须收口**：Lanyue 已有 `gateway.js`（SSRF 白名单 + 限频）与
   `request.js`（逐跳重定向 guard + 退避重试 + 日志脱敏）。用户脚本若能直接 `fetch`，
   这套防护形同虚设。
3. **进程隔离层级不够**：隐藏窗口仍在**主进程内**。用户脚本死循环 / 内存膨胀
   会拖垮整个应用 —— 而 Lanyue 的主进程就是 UI 线程（`OVERVIEW.md` 第一节）。

---

## 二、现有架构的复用点

Lanyue 的 v3 插件体系已经相当成熟，**用户插件应当复用它的骨架，而不是另起一套**。

### 2.1 可直接复用的层

| 层 | 文件 | 复用方式 |
|---|---|---|
| 能力推导 | `src/api/pluginRegistry.js:25-46` | 用户脚本**静态分析出能力声明**后，走同一套推导 |
| 出网通道 | `src/api/gateway.js` | 用户脚本**只能**经 `hostApi` 调用，不得自己 `fetch` |
| HTTP 层 | `src/api/request.js` | 重定向 guard / 退避重试 / 脱敏 自动生效 |
| 健康度 | `src/utils/sourceHealth.js` | 用户源同样记账、同样参与换源排序 |
| 契约 | `src/shared/ipcContract.js` | 新增通道，**自动派生 MCP 工具** |
| 审计 | `src/main/mcp/auditStore.js` | 用户源的每次调用同样入审计 |
| 凭据 | `src/utils/secretStore.js` | Cookie 加密存储，**脚本看不到明文** |

### 2.2 关键设计：把动态行为压成静态声明

lx-music 的困境在于「用户脚本是动态的，manifest 是静态的」。Lanyue 的解法：

```
用户脚本 (JS)
    │
    ├─► 静态分析（src/main/userSourceValidator.js）
    │     · 调用了哪些 hostApi 方法 → 推导能力位
    │     · 声明的域名 → hosts.origins
    │     · 是否含 fetch / require / eval / XMLHttpRequest → 拒绝
    │
    └─► 产出 manifest（与内置平台同构）
          │
          └─► 走 pluginRegistry 的同一套 decorate() 与能力推导
```

**这样用户插件与内置 8 源在下游完全同构** —— 换源排序、探针、CORS、
聚合条数、MCP 工具面，全部自动生效，零处硬编码。

---

## 三、沙箱设计

### 3.1 进程模型：`utilityProcess` 而非隐藏窗口

| 方案 | 隔离级别 | 主进程影响 | 结论 |
|---|---|---|---|
| 隐藏 BrowserWindow（lx-music） | 渲染进程，主进程内 | 崩溃/膨胀拖垮 UI | **不采用** |
| `utilityProcess` | 独立进程 | 主进程只收结构化结果 | **采用** |

`utilityProcess` 是 Electron 的实用进程（无窗口、无渲染），
主进程与它通过 `MessageChannelMain` 通信。

### 3.2 webPreferences（若必须用 BrowserWindow 承载）

```
sandbox: true              // 与 lx-music 相反 —— 我们要真隔离
contextIsolation: true
nodeIntegration: false
webSecurity: true
partition: 'user-source:<id>'   // 独立会话，与主窗口隔离
```

**注意 lx-music 设的是 `sandbox:false`**（因为它需要 preload 有 Node 权限）。
Lanyue 若走 `utilityProcess`，这个问题自然消失。

### 3.3 事件黑名单（沿用 lx-music 清单并扩展）

```
will-navigate          will-redirect        did-start-navigation
will-attach-webview    web-contents-created
ipc-message（限定来源）  permission-request
setWindowOpenHandler → deny
```

### 3.4 宿主 API（preload 暴露面，最小特权）

```js
// src/api/userSources/hostApi.js
const ALLOWED_METHODS = Object.freeze([
  'platformFetch',      // 唯一出网通道，经 gateway（SSRF 白名单 + 限频）
  'platformGetLyrics',
  'platformSearch',
  'platformGetUrl',
]);
```

**只有 `platformFetch` 能触网**，且必须经 `gateway.js` 的 SSRF 白名单 ——
用户脚本写 `fetch('http://169.254.169.254/...')` 会被白名单拒绝并记审计。

### 3.5 与最小特权 preload 的关系

Lanyue 已有先例：`preload-secondary.js`（`buildContractArg('secondary')`，7~9 通道）
用于二级窗口（mini-player / desktop-lyric）。

用户源沙箱可沿用同一思路做**第三个档位**，但**建议直接走 `utilityProcess`** ——
二级窗口需要 DOM（渲染歌词），用户源不需要，用 BrowserWindow 是过度授权。

---

## 四、安全边界

| 威胁 | 防护 |
|---|---|
| **SSRF** | 脚本只能调 `hostApi.platformFetch`，经 `gateway.js` 白名单 + `request.js` 逐跳重定向 guard |
| **读本机文件** | 沙箱无 `fs` / `require`；`sandbox:true` 时 preload 的 Node 能力也被剥离 |
| **读凭据** | Cookie 由**宿主在 gateway 层按平台自动附加**，脚本见不到明文（见 §5） |
| **拖垮主进程** | 独立 `utilityProcess` + **超时** + **输出上限**；崩溃则回落内置源 |
| **污染主渲染层** | 独立 `partition`；`ipc-message` 限定来源 |
| **无限循环** | 主进程设 wall-clock 超时，超时即终止进程 |
| **日志注入** | 用户源返回值一律过 `utils/redact.js` 脱敏后才落盘 |

---

## 五、Cookie 处理（最关键的一条）

**绝不把原始 Cookie 交给用户脚本。**

lx-music 的做法是脚本自己管 Cookie（`clearAuthCache` 三清说明它在管会话）。
Lanyue 已有 `secretStore` 加密存储 + `cookies.json`。

正确设计：

```
用户脚本请求某平台
    │  只声明「我需要 kuwo 的登录态」
    ▼
hostApi.platformFetch(url, { needsCookie: 'kuwo' })
    │
    ▼
gateway 层：查 secretStore 取 kuwo Cookie → 附加到请求 → 转发
    │
    ▼
脚本拿到的是**响应**，不是 Cookie
```

**好处**：
- 脚本泄露不会带走用户凭据
- 凭据轮换（重新登录）对脚本透明
- 审计能记录「哪个用户源用了哪个平台的凭据」

---

## 六、MCP 工具面扩展

Lanyue 的 MCP 从契约派生（`OVERVIEW.md` 第二节）：
`ipcContract.js` 是唯一事实来源 → `buildContractArg()` 派生 preload →
`src/main/mcp/tools.js` 从契约派生工具清单。

**这意味着新增契约通道会自动成为 MCP 工具**，无需改 `tools.js`。

新增通道（带 `sourceId`）：

```js
// src/shared/ipcContract.js
userSource: {
  list:    'user-source.list',
  search:  'user-source.search',    // 参数含 sourceId
  download:'user-source.download',  // 参数含 sourceId
  getLyrics:'user-source.lyrics',
}
```

**自动继承**：参数钳制（`register.js` 的 `normalizeArgs`）、
令牌桶限流、本机调用审计、写操作前确认、返回厂商前剥除本机路径与凭据。

---

## 七、文件清单

### 已完成（2026-10-22）

| 文件 | 动作 | 测试 |
|---|---|---|
| `src/main/userSourceValidator.js` | 新建 | `test/userSourceValidator.test.js` 36 个用例 |
| `src/api/userSources/hostApi.js` | 新建 | `test/hostApi.test.js` 16 个用例 |

### 待做

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/main/userSourceSandbox.js` | 新建 | 进程管理、超时、输出限额 |
| `src/api/userSources/registry.js` | 新建 | 注册、信任、启停 |
| `src/api/userSources/preload.js` | 新建 | 沙箱 preload（若走 BrowserWindow） |
| `src/shared/ipcContract.js` | 改造 | 新增 `userSource.*` 通道 |
| `src/main/mcp/tools.js` | 可能不改 | 从契约派生，应自动生效；若需 `sourceId` 枚举则补 |
| `src/api/pluginRegistry.js` | 改造 | 支持「外部 manifest 源」（用户注册） |

### 实现细节（供后续接手者参考）

**静态分析器的判定原则**：宁可误杀不可放行。14 条危险原语（fetch / require / eval /
process / fs / child_process / Buffer / window / globalThis / __dirname / ...），
每条都附「为什么必须拦」的 reason。注释与字符串里的危险词不误判
（`stripComments` + `stripStrings` 两步剥离后再扫）。

**hostApi 的自检机制**：`createHostApi()` 返回前会断言导出面与
`HOST_API_METHODS` 精确一致 —— 不一致直接抛错。两处导出（validator 与
hostApi）也用测试钉住不漂移。

**设计取舍**：`[\s\S]` 是 src/ 的口径禁令（`test/modelJson.test.js:58`），
只准 modelJson.js 用。静态分析器改用 `(?:.|\n)` 等价表达，并在注释里写明原因。

---

## 八、生命周期与状态流转

```
导入（用户粘贴脚本）
  │  静态分析失败 → 拒绝，提示具体违规项
  ▼
待启用
  │  用户启用
  ▼
运行中 ──── 崩溃/超时 ──► 已停止（自动回落内置源）
  │  用户停用
  ▼
已停用
  │  用户卸载
  ▼
已移除（进程终止 + 会话清理 + 审计留痕）
```

**崩溃恢复**：主进程捕获 `utilityProcess` 的 `exit` 事件，
标记该源为「不可用」并触发 `sourceHealth.recordResult(id, false)`，
换源排序自动降权 —— **与内置源完全同一条路径**。

---

## 九、验收标准

### 单测（`test/user-source-sandbox.test.js`）

1. 含 `fetch` / `require` / `eval` / `XMLHttpRequest` 的脚本被**拒绝**，且错误信息指出具体违规项
2. 静态分析能从「调用 `hostApi.platformSearch`」推导出 `search: true`
3. 用户脚本请求内网地址被 SSRF 白名单拦截
4. 沙箱超时后主进程存活、该源标记不可用、**内置源接管成功**
5. 用户脚本拿不到 Cookie 明文（断言 `hostApi` 的返回值不含 `cookie` 字段）
6. 用户源调用计入 `auditStore`（断言审计记录含 `sourceId`）
7. 用户源的搜索/下载经 MCP 暴露时，同样受令牌鉴权与写操作确认约束
8. **版本兼容**：脚本声明 `minHostVersion` 高于当前版本时拒绝加载

### 回归守卫

9. 用户源机制**关闭**时，8 个内置源行为**逐字不变**
10. 用户源不参与 `fallbackDisabledPlatforms` 的默认值（用户源的禁用应单独管理）

---

## 十、合规与许可证

- Lanyue 自身 **MIT**。用户导入的脚本由**用户自行获取与管理**，
  Lanyue 提供的是**机制**而非脚本分发 —— 这与 lx-music 清空内置音源的思路一致。
- 这为 Lanyue 提供了一条路径：**逐步下线高风险内置源**而不损失核心能力。
  （`README.md` 的源状态表当前 8 源全绿；若后续某个源的法律风险升高，
  可把它移到「用户脚本」而不影响其余 7 源。）
- **注意**：这不等于鼓励盗版。用户脚本的分发责任在用户，
  但 Lanyue 应在导入界面明确提示合规边界。

---

## 十一、风险与规避

| 风险 | 规避 |
|---|---|
| 静态分析被绕过（动态构造 `fetch`） | 分析失败即拒绝；运行时 `hostApi` 白名单是第二道闸 |
| 用户源拖慢搜索聚合 | 用户源参与 `aggregateLimit` 与超时；超时即跳过 |
| 用户源与内置源同名冲突 | 用户源 id 带 `user:` 前缀，manifest 校验拒绝与内置 id 冲突 |
| 凭据泄露 | 脚本见不到 Cookie 明文（§5） |
| 审计缺失 | 每次调用强制入 `auditStore`，与 MCP 同一条路 |
| 契约漏项 | `assertContractCoverage()` 启动时对账，漏注册即崩（这是设计） |
