# 架构全景

面向「第一次读这个仓库的人」与「要改某个链路但不确定边界在哪的人」。
具体的平台接入细则见 `ADD-A-PLATFORM.md`，插件契约见 `platform-plugin-v3.md`。

---

## 一、进程与窗口模型

```
┌──────────────────────── 主进程（Node，= UI 线程）─────────────────────────┐
│                                                                          │
│  index.js ──── app ready ──► 窗口装配 / 托盘 / 全局快捷键 / 剪贴板监听    │
│     │                                                                    │
│     ├─ registerAllIpcHandlers()   ← 契约声明的全部通道在这里注册          │
│     │    ├─ ipc/search        搜索 / 歌词 / 首页 / 源可用性探针           │
│     │    ├─ ipc/download      入队 / 取消 / 重试 / 批量 / 取流代理        │
│     │    ├─ ipc/library       本地曲库扫描 / 标签 / 歌词 / 转码 / 删除    │
│     │    ├─ ipc/playlist      用户歌单 / 红心                             │
│     │    ├─ ipc/cookie        平台 Cookie（登录 / 校验 / 清除）           │
│     │    ├─ ipc/ai-music      AI 生成（音乐 / 歌词 / 翻译）                │
│     │    ├─ ipc/cloudSync     WebDAV 快照同步 / 导入导出                   │
│     │    ├─ ipc/mcp           本地 MCP 服务的启停与令牌                    │
│     │    └─ …（共 15 个模块，见 src/main/ipc/）                          │
│                                                                          │
│  downloadQueue.js   下载引擎：状态机 + 并发钳制 + 续传 + 终态落盘         │
│  streamProtocol.js   自定义 stream:// 协议：跨域音频代理给 <audio> 播放     │
│  updater.js         自动更新（镜像兜底为 fail-closed）                     │
│  rejectionGuard.js  全局未捕获拒绝归口（按栈帧分流，避免误伤业务日志）      │
│                                                                          │
│  ── utils/（纯 Node，可单测）───────────────────────────────────────────  │
│  downloader / audioConvert / history(SQLite) / webdav / syncMerge          │
│  urlGuard(SSRF) / approvedDirs(沙箱) / secretStore / logger / atomicFile  │
└──────────────────────────────────────────────────────────────────────────┘
              │ IPC（契约派生白名单）              │ stream://
┌─────────────▼─────────────┐          ┌───────────▼──────────────────────┐
│ 主窗口 renderer/index.html │          │ 二级窗口（最小 preload）          │
│  views/*.js 无框架 ESM     │          │  · 迷你播放器 mini-player.html     │
│  utils.js 挂 window.esc 等 │          │  · 桌面歌词 desktop-lyric.html    │
└───────────────────────────┘          │  两者只拿到 7~9 个通道，           │
                                       │  且禁止一切导航/新开窗             │
                                       └──────────────────────────────────┘
```

要点：

- **渲染层无框架**（原生 ES Module），全局桥只用于少量工具（`esc`、`t()`、`api`），
  业务状态在各 view 自己的模块作用域里。
- **二级窗口按「最小特权」设计**：它们渲染远端歌词/歌名，XSS 面更大，因此 preload
  与契约里 `win: 'secondary'` 单独收窄。
- `cookie-helper.html` 用于在浏览器里取 Cookie，**不是**应用的一部分，只在需要手工
  辅助登录时用。

---

## 二、IPC：一份契约，两个方向

```
src/shared/ipcContract.js   ← 唯一事实来源（方向 + 可见窗口 + 参数规格）
        │
        ├─► buildContractArg('main')      ─► preload.js         （~90 通道）
        └─► buildContractArg('secondary')  ─► preload-secondary.js（7~9 通道）
        │
        └─► register.js handle()/on()      ─► 入口统一 normalizeArgs 钳制
                │
                └─► getInvokeHandler()     ─► MCP 工具面（同一批 handler）
```

四个必须记住的性质：

1. **未声明即抛错**：裸 `ipcMain.handle` 一个没登记的通道，应用启动就崩（这是设计）。
2. **参数只做形状校验**：类型钳制/截断/默认值，不改合法值的语义；业务合法性仍在
   handler 里（错误文案是产品约定）。
3. **契约是 MCP 的上游**：`src/main/mcp/tools.js` 从契约派生工具清单，所以 MCP
   与渲染层走同一套参数钳制，不会因为"多一个入口"而多一份校验。
4. **注册覆盖对账**：`assertContractCoverage()` 在启动时点名「声明了却没人注册」的通道。

---

## 三、平台插件（v3）

```
src/api/platforms/<name>.js   自描述 manifest（id/名称/能力位/域名/链接模式…）
src/api/pluginRegistry.js     自动发现 + 派生各类清单（探针/换源/CORS/链接）
src/api/gateway.js            平台无关的调用网关：限频、SSRF 白名单、能力推导
src/api/request.js            统一 HTTP 层：逐跳重定向 guard、退避重试、日志脱敏
```

**能力位驱动一切**：搜索 / 取流 / 歌词 / 换源候选 / 跨源换源 / CORS 白名单 / 链接识别
全部从 manifest 派生，新增平台不需要改网关、不需要改 UI。新增平台的完整步骤见
`ADD-A-PLATFORM.md`；设计取舍见 `platform-plugin-v3.md`。

---

## 四、下载链路（最复杂的一条）

```
渲染层 add-to-queue
   └─► ipc/download.js
        ├─ 查重 1：队列内在途任务
        ├─ 查重 2：历史里已下载且文件仍在（findDownloadedAsync，异步判活）
        └─► downloadQueue.push(...)
             └─ processQueue()  ── 并发钳制（全局 + 分平台）
                  └─ processOneSong(song)
                       ├─ evaluatePolicy（跳过已存在的歌）
                       ├─ getDownloadUrlSmart ──► 跨源换源（Range 预检 + 健康度排序）
                       ├─ 沙箱复核 ×2（根目录 + 模板子目录），失败退回根目录
                       ├─ downloader.downloadFileWithRetry（续传 / 重试 / 短包校验）
                       ├─ 歌词 → ID3 嵌入 → rename → LRC 旁文件
                       ├─ history.add（SQLite）
                       └─ 终态立即落盘（queue.json，防崩溃窗口丢终态）
```

这条链路上有三处**反直觉但必要**的设计，改动前务必读注释：

- **重试只对 403/404/410**：这三个是签名 URL 过期，重拿 URL 再下才有效；
  其他错误重试没有意义。
- **沙箱复核不过时退回根目录，而不是让下载失败**：「目录不安全」不该变成「下载失败」。
- **终态必须 immediate 落盘**：等防抖窗口的话，崩溃即丢终态（用户看到下完的歌消失）。

---

## 五、数据与状态（`userData` 下）

| 文件 | 内容 | 写入方式 |
|---|---|---|
| `prefs.json` | 偏好设置（含加密后的凭据引用） | 原子写 + 300ms 防抖；目录型键过沙箱 |
| `queue.json` | 下载队列（含终态） | 原子写 + 500ms 防抖，**终态立即** |
| `history.db` | 下载/播放历史（SQLite，含去重索引 `assets`） | `node:sqlite` 即时提交，退出前 WAL checkpoint |
| `library-index.json` | 本地曲库索引（每首歌一条） | 增量扫描后整表原子写 |
| `logs/main.log` | 运行日志（已脱敏） | 内存缓冲 500ms 批量 append，8MB 轮转一代 |
| `cookies.json` / `ai` 相关 | 平台 Cookie / AI 配置 | 敏感值经 `secretStore` 加密 |

删除语义注意：删历史**不动** `assets` 去重索引（徽标语义是「文件还在」），
由 `findDownloaded*` 在文件确实消失时自愈回收。

---

## 六、云同步（WebDAV）

单文件快照 + 合并，而非双向实时同步：

```
fetch(远端) ──► mergeSnapshotData(本地, 远端) ──► push(If-Match: etag)
                                              │
                              412 ⇒ 重拉 → 重并 → **带新 ETag** 再推一次
                                              │
                                         applyMerged(回写本地)
```

- 冲突语义：最后一写赢，**删除不传播**（无墓碑机制，A 端删的歌只要 B 端旧快照里还在就会回来）。
  这是快照合并的固有取舍，界面已明确告知用户。
- 快照只含歌单 / 下载模板 / 下载历史；凭据与目录类设置被排除。
- 外部快照里的 `id` 一律经过 `repairIds`（确定性哈希）修复后才落库。

---

## 七、可观测性

| 面 | 现状 |
|---|---|
| 日志 | `utils/logger.js`：`log/info/warn/error` 四级；生产环境控制台只出 error，**但 warn/error 落盘**（降级路径全靠它） |
| 落盘 | 缓冲 + 定时合并（500ms）+ 触顶立即冲刷 + 8MB 轮转一代 + 退出路径同步冲刷 |
| 脱敏 | 落盘前统一过 `utils/redact.js`（URL 敏感查询参数、Cookie/Authorization/token 形态） |
| 崩溃 | `utils/rejectionGuard.js` 全局归口未捕获拒绝与异常，按栈帧分流 |
| 诊断包 | 设置页「导出诊断包」：版本 / 环境 / 偏好摘要（凭据剔除）/ 日志 |
| 反馈 | 设置页直连 GitHub Issues |

> 设计取向：**宁可落盘也不丢**。所有降级路径（更新镜像失败、队列恢复丢弃脏记录、
> 目录模板未生效、statfs 预检跳过）都写 warn，因为它们依赖特定网络/文件状态，
> 事后极难复现。

---

## 八、已知技术债（按影响排序）

| 债务 | 现状 | 为什么没动 |
|---|---|---|
| 渲染层巨型文件 | `settings.js` 1526 / `playlist.js` 1518 / `app.js` 1489 / `index.html` 1466 行 | 体量大、回归面广；拆分需要逐块补测试，不适合与功能修复混在同一批 |
| 更新签名 | 见 `SECURITY.md` 第四节 | 需采购证书；已有 fail-closed 闸门兜底 |
| 队列终态同步写盘 | 每个终态一次 `writeFileSync` + `renameSync`（整表） | 与「退出 flush」「崩溃窗口不丢终态」两条语义耦合，改异步要重新论证 |
| 无墓碑合并 | 删除不跨设备传播 | 快照合并方案的固有取舍，改算法要引入墓碑与冲突面，收益不匹配 |
| `_approved` 只增不删 | 批准目录集合无回收，越用越大 | 每次判定的 `realpathSync` 次数随之线性上升；需要一个「批准集合持久化 + 失效淘汰」的设计 |
| preload 监听器无注销 | `ipcRenderer.on` 不暴露 `removeListener` | 当前调用点都是页面级一次性注册，尚未累积成实际泄漏 |

---

## 九、想改某个东西，从哪读起

| 你想改 | 先读 |
|---|---|
| 加一个 IPC 通道 | 本文第二节 + `src/shared/ipcContract.js` 顶部约定 |
| 加一个音乐平台 | `ADD-A-PLATFORM.md` |
| 改下载/重试/续传行为 | `src/utils/downloader.js` 顶部注释 + 本文第四节 |
| 改搜索或换源排序 | `src/api/gateway.js`、`src/utils/sourceHealth.js` |
| 改设置页 | `src/main/ipc/prefs.js` 的键白名单（渲染层用的每个键都必须在其中） |
| 改云同步合并规则 | `src/utils/syncMerge.js` 顶部「合并语义」块 |
| 加测试 | `CONTRIBUTING.md` 第三节 + 读一个既有守卫测试 |
