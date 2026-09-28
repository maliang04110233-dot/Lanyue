# MusicDL / 揽乐 代码复审报告

> 复审日期：2026-09-28 ｜ 版本：`package.json` 1.0.33 ｜ 提交：`7286f17`（release: v1.0.33，2026-09-23）
> 范围：`src/` 全量（232 文件 / 52,873 行）+ 构建配置 + 测试套件 + 打包产物抽样
> 方法：静态阅读 + 自动化实测（`node --test`、ESLint、签名状态探测、产物/工作区丈量、与上一版审查报告对账）
> 上一版基线：`docs/CODE_REVIEW_2026-09-17.md`（v1.0.19，133 文件 / 23,258 行）
> **修复状态见第六节**（P1-2 / P3-1 / P3-3 已修；P1-1 按选定方案只补守卫测试）

---

## 一、结论摘要

| 维度 | 评级 | 变化 | 说明 |
|---|---|---|---|
| 安全边界 | 良 | ↑ 但有一处未闭合 | 传输层/路径/凭据多维加固到位；**更新签名校验的开关是开的，但因缺证书而实际不生效**（见 P1-1，现已有守卫测试钉住该事实） |
| 测试 | 良 | ↑ | 修复后 2195 用例 / 2192 pass / 0 fail；CRLF 平台耦合已消除（见 P1-2） |
| 代码健康 | 中 | ↓ | ESLint 0 error；但巨型文件进一步膨胀，最大 1535 行（上版 1099 行） |
| 仓库卫生 | 中 | ↑ | 换行约定已入库（`.gitattributes`）；工作区仍 5.0 GB，根目录畸形文件残留待清 |
| 工程链路 | 良 | ↑ | 已接入 CI（lint / audit / dead-deps / test / build-smoke），上版此项为空缺 |

**实测数据**

| 指标 | 实测值 |
|---|---|
| 测试用例 | 修复前 2180 / 2176 pass / 1 fail；**修复后 2195 / 2192 pass / 0 fail** |
| ESLint | 0 error / 0 warning（`npx eslint src/ test/` 退出码 0） |
| 源码规模 | 232 文件 / 52,873 行（较上版 133 文件 / 23,258 行翻倍） |
| 单文件最大 | `src/renderer/js/views/local.js` 1535 行、`app.js` 1533 行 |
| 打包体积 | `app.asar` 33.8 MB；安装包 ~121 MB |
| CRLF 文件 | 修复前 git 跟踪文件中 97 个工作树为 CRLF；**修复后 0 个**（`.bat` 一族有意保留） |
| 工作区占用 | 5.0 GB（`.backup` 1.6 G + `release` 2.4 G + `node_modules` 989 M） |
| 待提交改动 | 35 文件，+1062 / −609 行 |

---

## 二、值得肯定：安全加固是真落地了

上一版审查指出的方向，这一版有实打实的代码证据，不是纸上方案。

**1. SSRF 防护做到了工程级**（`src/utils/urlGuard.js`，236 行）。这不是常见的 `hostname` 正则黑名单，而是：

- 归一化十进制（`2130706433`）/ 十六进制（`0x7f.0.0.1`）/ 八进制（`0177.0.0.1`）IP 编码 — 这些恰恰是绕过朴素正则的标准手法；
- 覆盖 IPv4-mapped IPv6 的两种书写形态（`::ffff:127.0.0.1` 与 Node URL 会规范化成的 `::ffff:7f00:1`），并额外拒绝 NAT64 段；
- DNS rebinding 用 `makePinnedLookup` 闭合：校验时解析出的 IP 列表被固定到连接阶段，SNI/Host 仍用原域名；且同时支持 Node 20+ `autoSelectFamily` 的 `{all:true}` 双形态回调 —— 这个兼容点写错就会在 Node 24 上抛 `ERR_INVALID_IP_ADDRESS`；
- 重定向在 `src/api/request.js:104-125` **逐跳**再过一遍 guard，并额外拒绝 `https→http` 协议降级、跨 host 时剥离 `Cookie/Authorization`。

**2. 目录沙箱是双闸而非单闸**（`src/main/approvedDirs.js`）。词法快筛 + `realpath` 复核，专门堵「批准目录内的符号链接指向 System32」这条逃逸路径；`realpathDeep` 对尚不存在的目标逐级回退到最近已存在祖先，兼顾「新建目录」场景。注释里还明确写出了残留的 TOCTOU 窗口和彻底关闭的代价 —— 这种「知道自己没做什么」的注释比声称安全更有价值。

**3. 凭据三态模型**（`src/utils/secretStore.js`）。把「不在 Electron 里」（单测/CLI，明文透传是合理的）和「在 Electron 里但 DPAPI 不可用」（真实用户危险态，必须拒绝写入）区分开，修正了旧实现两者混同导致「加密坏了照样明文落盘」的问题。`insecure` 态刻意不缓存，因为 `isEncryptionAvailable()` 在 `app ready` 前会误报 false。

**4. Electron 安全三件套齐备且一致**：`nodeIntegration: false` / `contextIsolation: true` / `webSecurity: true` 在 `main/index.js`、`ipc/window.js`（两个子窗口）、`loginWindow.js` 四处全部正确设置，渲染层无 `fetch`/`XMLHttpRequest`。

**5. MCP 本地服务的边界处理克制**（`src/main/mcp/mcpServer.js`）。仅绑 `127.0.0.1`、Bearer token 走 `timingSafeEqual`、Origin 白名单只放行回环主机、请求体 1 MiB 上限；工具白名单明确排除 cookie/登录、文件路径读写、set-pref、更新安装 —— 理由写得很清楚：「外部 Agent 的可信度低于渲染层」。

**6. IPC 契约单点**（`src/main/ipc/register.js` + `src/shared/ipcContract.js`）。参数在主进程入口统一校验/钳制，未声明通道启动即抛错，`assertContractCoverage()` 对账「声明了却没人注册」的通道；`send` 型通道补齐了同步/异步双错误边界 —— 主进程即 UI 线程，一次 handler 抛错原本就是整个窗口失联。

**7. CORS 白名单的细节没写错**。后缀匹配坚持带前导点，使 `evil-douyinvod.com` 无法通过 `endsWith('.douyinvod.com')`；且白名单由平台 manifest 派生而非手写。`onHeadersReceived` 里修正了「拿 `details.url` 自身 origin 判定并回填」的原缺陷，改为反射发起方。

**8. 已接入 CI**（`.github/workflows/ci.yml`）。`npm ci`（lock 漂移即失败）+ lint + `npm audit --omit=dev --audit-level=high` + dead-deps + test，第二层 Windows runner 跑真实构建与 asar 冒烟。上一版「无 CI、无依赖扫描」的问题已闭环。

---

## 三、问题清单

### P1-1 · 更新签名校验开着，但实际不生效（安全，需发版前明确处置）

> **修复状态：按选定方案「只补守卫测试」处置完成**（见第六节）。代码行为未变，
> 但「开关开着却不生效」这一事实已由 `test/update-signature-guard.test.js`
> 钉进测试，不可能再被静默改变。

这是本次复审最需要决策的一项。

`build/config.cjs:117` 设置了 `verifyUpdateCodeSignature: true`，注释也写明了理由之重：「配合第三方镜像兜底（ghproxy / gh.ddlc），等于把更新包由谁提供」的信任根交给中间人。增量 209 的提交信息把这一项列为 **P0**。**但实测这条防线目前是空转的**：

证据链三条，互相印证：

1. `electron-updater` 的校验逻辑（`node_modules/electron-updater/out/NsisUpdater.js:84-99`）先读 `app-update.yml` 的 `publisherName`，**取不到就直接 `return null`**：
   ```js
   publisherName = (await this.configOnDisk.value).publisherName;
   if (publisherName == null) { return null; }
   ```
2. 调用方（同文件 `:52-56`）只在返回值**非 null** 时才抛 `ERR_UPDATER_INVALID_SIGNATURE`。即 `null` 语义是「无签名信息 → 放行」，不是「拒绝」。
3. 实测打包产物 `release/win-unpacked/resources/app-update.yml` 内容只有 `owner / repo / provider / private / releaseType / updaterCacheDirName` —— **没有 `publisherName`**。且 `Get-AuthenticodeSignature 'release/MusicDL-Setup-1.0.33.exe'` 返回 **`Status: NotSigned`**。

根因：`build/config.cjs` 与 `package.json` 中均无 `certificateFile` / `certificateSubjectName` / `signtool` 等签名配置，安装包未做代码签名，因此 electron-builder 不会写入 `publisherName`，`verifyUpdateCodeSignature` 这个开关就没有可校验的对象。

**影响**：当前状态下，即便开关为 `true`，镜像 feed 或链路被劫持仍可让应用静默接受并安装未签名的更新包 —— 增量 209 声称已关闭的 P0 风险实际仍然敞开。同时「未签名安装包」本身也会触发 SmartScreen 警告，影响分发体验。

**处置建议（三选一，需明确记录结论）**：
- **A（推荐，若长期分发）**：购置代码签名证书，配置 `win.certificateFile`/`certificateSubjectName`。签名后 `publisherName` 会自动进入 `app-update.yml`，开关才真正生效。
- **B（过渡）**：既然签名依赖尚未就绪，考虑**先撤掉第三方镜像兜底**（`src/main/updateMirror.js` 的 `MIRROR_PREFIXES`），把信任根收回到本仓库 GitHub Releases 直连 + 官方签名渠道；镜像的可用性收益与「未签名可静默安装」的风险需要权衡，不能两头都要。
- **C（最低限度）**：若不打算改代码，至少把这一条从「P0 已修复」改记为「已知未闭合」，避免后续维护者据此误判风险已关闭 —— 当前注释和提交信息都会让人以为防线已经立起来。

> 顺带一提：`test/retry.test.js` 有守卫禁止 `updater.js` 出现 `setFeedURL` 字面量，这个思路很好；但同类守卫没有覆盖「签名校验是否真生效」——建议补一条测试，断言 `build/config.cjs` 的 `verifyUpdateCodeSignature: true` **必须伴随**签名配置存在，否则报警。

### P1-2 · 一个测试用例在 Windows 上必然失败（CRLF 平台耦合）

> **修复状态：已修复**。新增 `.gitattributes` 统一按 LF 存库/检出，
> 并把工作树里 94 个 CRLF 文本文件归一化为 LF（内容零变化，见第六节）。
> 该用例现为绿。

```
test at test\subscription-new-dl.test.js:71:1
✖ 接线钉：徽标渲染/逐首入队/防抖重渲染/palette/CSS 全部就位
  AssertionError: 防抖重渲染订阅徽标
```

命中的是这条断言（`:71`）：

```js
assert.match(SUB_JS, /addDlChangeListener\(\(\) => \{\n {2}if \(!_subsLoaded\) return;\n {2}.../,
  '防抖重渲染订阅徽标');
```

正则里硬编码了 `\n`，而 `src/renderer/js/views/subscriptions.js` 在磁盘上是 **CRLF**。复现验证：

```
has CRLF: true
regex on raw:        false   ← 磁盘原文不匹配
regex on normalized: true    ← 归一化换行后匹配
.gitattributes:      false   ← 仓库没有换行约定
```

源码本身是正确的（`:113-117` 的防抖逻辑确实在位），**失败纯粹由换行符造成**。根本原因是仓库没有 `.gitattributes`，而 `src/` 下 232 个文本文件里有 52 个是 CRLF —— git 在 Windows checkout 时按 `core.autocrlf` 转换，于是同一份代码在 Linux CI 上绿、在 Windows 本地红。

**危害不只是「一条用例红」**：这类断言一旦在某平台恒红，团队就会习惯性忽略测试结果，真实回归就混在里面被无视了。修复二选一：

- 治标：断言前 `normalize` 换行，例如读取时 `readFileSync(...).replace(/\r\n/g, '\n')`；
- 治本（推荐）：加 `.gitattributes` 钉死换行（`* text=auto eol=lf`），并给存量 CRLF 文件做一次归一化提交。这同时能消除其他 20 多个同类「接线钉」测试的潜在雷。

### P2-1 · 巨型文件较上版进一步膨胀

| 文件 | 本版行数 | 上版（v1.0.19） |
|---|---|---|
| `src/renderer/js/views/local.js` | 1535 | — |
| `src/renderer/js/app.js` | 1533 | 1099 |
| `src/renderer/js/views/playlist.js` | 1445 | — |
| `src/renderer/js/views/search.js` | 1423 | — |
| `src/renderer/index.html` | 1411 | — |
| `src/renderer/js/views/settings.js` | 1401 | — |

上一版把「5 个文件超 800 行，最大 1099」列为 P2；本版源码量翻倍的同时，最大单文件涨到 1535 行，且超 1000 行的文件已有 9 个。考虑到 `views/` 目录已经出现（本版新引入的按视图拆分），拆分范式的方向是对的，只是 `app.js` 这类老文件还没跟上。建议按既有 `views/` 范式逐步外迁，不必一次性大改。

### P2-2 · 工作区 5.0 GB，且根目录有畸形文件名残留

```
1.6G  .backup
2.4G  release
989M  node_modules
5.0G  合计
```

`.backup/` 下是 24 个按日期命名的快照目录（`release-1.0.13-20260917` … `ui-redesign-20260917`），`release/` 下堆积了 1.0.23 至 1.0.33 共十余个约 121 MB 的安装包。上一版已提示过（当时 4.5 GB），本版还在增长。

更值得注意的是根目录这批畸形文件 —— 它们是「路径被当成文件名」的产物：

```
C:Users59443AppDataLocalTemppreload_asar.js
C:Users59443AppDataLocalTemppreload_check.js
Users59443AppDataLocalTempasar_final/          （目录）
UsersadminAppDataLocalTempkill-musicdl.ps1
```

外加 `build-log-full.txt`（531 KB）、`mpv.zip` + `mpv.net-portable.zip`（合计 13 MB）、以及 6 个 `test-*.js` 一次性探针。提交历史显示 a6fe9e6 已把「根目录一次性探针/启动 bat」取消 git 跟踪，但这些畸形文件和压缩包仍在磁盘上。建议清理磁盘产物，并把 `*.zip`、`build-log-*.txt`、`C:*` 形态补进 `.gitignore`。

### P3-1 · 生产环境日志静默影响了排障

> **修复状态：已修复**。`utils/logger.js` 新增可选文件落盘（异步 + 定时合并，
> 默认关闭、未启用时行为与从前逐字节一致），主进程在 app ready 后启用
> `userData/logs/main.log`，退出时同步冲刷。见第六节。

`src/utils/logger.js` 在 `NODE_ENV === 'production'` 时只输出 `error`，`warn` 全部静默。这对「不给用户刷屏」是合理的，但本版新增的许多关键降级路径用的是 `logger.warn`：更新镜像兜底失败（`updater.js:151`）、队列恢复放弃脏记录（`downloadQueue.js:267`）、目录规划回落（`downloadPath.js`）、`send` 通道异步失败在 `register.js` 用的是 `logger.error`（正确）。当用户报「下载目录模板没生效」「更新一直失败」时，现场没有任何日志可看。

建议：为 warn 级别的降级事件引入可选的文件落盘（`userData/logs/`，滚动保留），或至少在设置页提供「导出诊断日志」。`src/renderer/js/diagnose.js` 已有诊断能力，可以复用其出口。

### P3-3 · 迷你播放器 CSP 存在无用的 `file:` 放宽（已修）

三个渲染页面的 CSP 大体一致且收敛得不错，但 `src/renderer/mini-player.html:5`
的 `media-src` 比其他两页多一个 `file:`。核查确认该窗口**不含任何
`<audio>`/`<video>` 元素**（播放由主窗口负责，min-player 只接收
`mini-player-update` 推送的标题/封面/进度），封面走 `img-src`
（网络歌 `http(s)`、本地歌 base64 → `data:`）。`file:` 从未被使用，
属无谓的攻击面放宽，已移除并在 HTML 内注明理由。

### P3-2 · 平台 API 依赖仍是供应链薄弱点

`NeteaseCloudMusicApi@4.32.0` 与 `qq-music-api@1.1.2` 仍是核心依赖，均为第三方非官方实现。本版已通过 `overrides` 压制了若干传递依赖漏洞，CI 也加了 `npm audit --omit=dev --audit-level=high`，这比上版好很多。但这两个包本身的上游协议随时可能失效或被投毒，建议保留定期核查节奏，并确认 `src/api/pluginRegistry.js` 的适配器层能在上游失效时给出可读降级（`src/api/services/fallbackCodes.js` 已有这套码表，方向正确）。

> 附带一条观察（未修，属工程纪律）：两个包都用 `^` 语义化版本，`package-lock.json`
> 只在 CI `npm ci` 时才被严格使用；本地 `npm install` 拉到的树可能与 CI/打包
> 的树不同。若希望本地与产物完全一致，可考虑钉死精确版本。

### P2-3 · 内联事件处理器里的 XSS 转义误用（已修，本轮最严重的发现）

**这是真实可利用的 DOM XSS，不是风格问题。**

模式：

```js
onclick="subscriptionRemove('${escAttr(e.key)}')"
                               ^^^^^^^ 错：应用 escQ
```

**为什么 escAttr 在这里失效**（两步语义）：

1. 内联事件属性 `onclick="..."` 的值，浏览器要**先做 HTML 实体解码，再当 JS 源码解析**；
2. `escAttr` 把 `'` 转成 `&#39;` —— 它防住了「HTML 属性层被闭合」，但**解码之后 `&#39;` 又变回裸的 `'`**，JS 字符串因此被提前闭合；
3. `e.key` 形如 `type:platform:targetId`，其中 targetId 是**平台接口返回的外部数据**（`subscribe-add` 契约只限长度 128，无字符集校验）。

实测载荷 `x');alert(1);//` 经 escAttr 后，浏览器实际执行：

```js
subscriptionRemove('x');alert(1);//')   ← alert(1) 已在字符串之外，直接执行
```

而 `escQ` 先转义反斜杠、再把 `'` 转成 `\'`，解码后仍是 `\'`：

```js
subscriptionRemove('x\');alert(1);//')  ← 单引号留在字符串内
```

**影响位置（已全部修复）**：`views/subscriptions.js` 6 处、`views/ai-music.js` 1 处
（AI 生成的音频文件名可含任意字符）、`views/history.js` 1 处（当前值来自代码内常量，
不可利用，但同模式一并统一）。

**最危险的一点**：`test/subscription-new-dl.test.js:62` 原先把这个**错误写法当正确**
钉住（`assert.match(..., /escAttr\(e\.key\)/ , 'onclick 键控传参全转义')`）——
测试反而保护了 bug。这也是新守卫必须存在的理由：光修不够，得防止下次再犯。

**新增守卫** `test/inline-handler-escape.test.js`：全仓扫描 `on{event}="..."` 内
单引号 JS 字符串中的 `${...}`，凡用 HTML-only 转义函数（escAttr/esc/escHtml…）即
违规；含扫描器自检与「escAttr vs escQ 语义差异」的对照用例（后者用状态机判定
`alert(` 是否落在字符串之外 —— 注意不能简单用 `includes("');")`，因为 `x\');`
里也含这三个字符）。已用变异测试验证：把任一 escQ 改回 escAttr 即红灯。

---

## 四、复核确认的既有优点（抽查未发现回归）

- 下载文件名净化链条完整：`renderFileName` → `sanitizeFilename`（`downloadQueue.js:69`）→ `planDownloadDir` 的 `isInsideDir` 兜底，且模板渲染对 `$&`/`$'` 做了函数式替换防注入；
- 队列恢复逐条 `sanitizeRestoredTask` + `MAX_RESTORED_TASKS = 20000` 上限，一条脏记录不会毁掉整批；
- 分平台并发钳制（`getPerSourceCap` 不超过全局 `concurrency`）确有实现，不是注释里说说；
- `history.js` 全部 SQL 走 prepared statement，唯一拼接的 `orderBy` 来自 `resolveSortOrder` 白名单，`PRAGMA user_version` 的插值是内部递增整数 —— SQL 注入面无问题；
- WebDAV 明文 http + 携带凭据时默认拒绝（`webdav.js:65`），仅 loopback 或显式 `allowInsecure` 放行；
- 未知平台/未知通道/非法参数在主进程入口统一拒绝，渲染层拿不到「未校验的桥」。

---

## 五、建议处置顺序

| 优先级 | 事项 | 类型 | 状态 |
|---|---|---|---|
| 1 | P1-1 明确更新签名方案（买证书 / 撤镜像 / 改记为已知未闭合） | 安全决策 | 守卫测试已补（见六）；**证书与服务取舍仍待你决定** |
| 2 | P1-2 加 `.gitattributes` 归一化换行，修掉唯一红测 | 测试可信度 | ✅ 已修复 |
| 3 | P3-1 生产环境 warn 落盘，保住降级路径的可观测性 | 可运维性 | ✅ 已修复 |
| 4 | P3-3 迷你播放器 CSP 去掉无用 `file:` | 安全收紧 | ✅ 已修复 |
| 5 | P2-2 清理 5 GB 工作区与畸形文件名残留 | 仓库卫生 | 待处理（需你确认后可代劳） |
| 6 | P2-1 按 `views/` 范式继续拆巨型文件 | 长期维护 | 待排期 |
| 7 | P3-2 持续核查平台 API 依赖 | 供应链 | 持续 |

---

## 六、本次修复记录（2026-09-28）

改动共 4 个文件、2 个新增测试文件，另加 1 个换行约定文件。

### 6.1 `.gitattributes`（新增）—— 治愈 CRLF 平台耦合（P1-2）

**根因**：仓库原先没有换行约定，而本机 `core.autocrlf=true`。git 索引里存的是
LF（`i/lf`），checkout 到工作树却变成 CRLF（97 个跟踪文件为 `w/crlf`）。测试里
凡「读取源码 + 用带 `\n` 的正则匹配」的断言，在 Linux CI 绿、Windows 本地红。

**处置**：
- 新增 `.gitattributes`，`* text=auto eol=lf` + 逐类显式声明，统一按 LF 存库/检出；
- `*.bat` / `*.cmd` / `*.ps1` **有意保留 CRLF**（cmd.exe 对 LF-only 批处理的
  多行 `goto`/label 处理不稳），这是设计上的例外并已在文件内注明理由；
- 二进制类型显式标 `binary`，防 git 误做转换；
- 工作树中 94 个 CRLF 文本文件归一化为 LF。

**安全校验**：转换前记录每个文件的 SHA256 与行数；转换逻辑强制断言
「唯一变化只能是 `\r\n` → `\n`」，不满足则跳过。转换后 `git diff --stat`
的 `+1062 / −609` 与转换前**逐字一致**，证明内容零损失。

**效果**：`test/subscription-new-dl.test.js` 的「防抖重渲染订阅徽标」由红转绿；
同类脆弱断言（另有 34 个文件使用相同写法）一并解除隐患。

### 6.2 `test/update-signature-guard.test.js`（新增）—— 钉住签名校验的真实状态（P1-1）

按选定方案「只补守卫测试」实施，**不改代码行为**。

**设计要点**：若直接断言「`verifyUpdateCodeSignature: true` ⇒ 必须有证书」，
当下即为假 —— CI 会永久红灯，而这正是本报告批评的毛病（恒红的用例会训练
团队忽略测试结果）。故改为**事实钉**：把当前真实状态显式记录在
`RECORDED_STATE` 里（开关为 true、无证书、校验实际不生效），断言配置与记录一致。
于是风险状态**不可能被静默改变**：

| 若有人…… | 结果 |
|---|---|
| 加了签名证书 | 测试红 → 提示把 `codeSigningConfigured`/`verificationEffective` 改为 true，并回来清理文档措辞 |
| 把开关改成 `false` | 测试红（P0 回归） |
| 删掉证书配置 | 测试红 |
| 上游改了「null 即放行」语义 | 测试红（依赖源码断言） |

另含守卫自检（`detectCodeSigning` 对空配置/三种签名键形态的识别）——防正则写坏后
守卫静默失效。**已用变异测试验证**：把 `verifyUpdateCodeSignature` 改成 `false`
后该用例立刻失败；恢复后通过。

### 6.3 `src/utils/logger.js` + `src/main/index.js` —— 生产日志落盘（P3-1）
**问题**：生产环境控制台只留 `error`，全仓 **155 处 `logger.warn`** 随之静默 ——
而它们记录的正是所有降级路径。用户报「更新一直失败」「目录模板没生效」时现场无日志。

**处置**：`logger` 新增可选文件落盘能力，主进程在 app ready 后启用
`userData/logs/main.log`。设计约束（主进程即 UI 线程，每条都有代价）：

- **未调用 `initLogFile` 时行为与从前逐字节一致**（单测/CLI/打包脚本依赖此语义）；
- 全异步 `appendFile` + 500ms 定时合并，绝不阻塞事件循环；
- 缓冲上限 200 行触顶即冲刷；单行截断 4000 字符；单文件 8 MB 轮转为 `.1`；
- 落盘失败只吞不抛并停用开关（日志系统不能成为故障源）；
- 定时器 `unref()`；退出时 `flushSyncOnExit()` 同步冲刷（异步写在 `app.quit()`
  后可能来不及，与 `prefs.flush` 同款取舍）。

**过程中被自己的测试抓到一个真实缺陷**：初版用 `if (_writing) return;` 做单飞，
当「缓冲触顶冲刷」与「定时冲刷」并发时，后者抢先拿到标志会让新入缓冲滞留内存
直到下一个 500ms —— 若此时退出就丢了。已改为共享排空循环（`_drainPromise`），
任何调用方 `await` 到的都是「此刻已入缓冲的内容都已写出」。

### 6.4 `src/renderer/mini-player.html` —— CSP 去掉无用 `file:`（P3-3）

该窗口不含任何 `<audio>`/`<video>` 元素，封面走 `img-src`（本地歌为 base64 →
`data:`），`media-src` 的 `file:` 确认从未被使用，已移除并注明理由。

### 6.5 `views/subscriptions.js` / `views/ai-music.js` / `views/history.js`（+ 新守卫）—— 修 XSS 转义误用（P2-3）

共修 8 处内联事件处理器：`subscriptions.js` 6 处（`escAttr(e.key)` → `escQ(e.key)`，
含 `String(s.id)`）、`ai-music.js` 1 处（`escAttr(res.filePath)` → `escQ(...)`）、
`history.js` 1 处（`data-hst` 用 `escAttr`、onclick 用 `escQ`）。

同时**修正了一个把 bug 当正确的测试**：`test/subscription-new-dl.test.js:62`
原断言 `escAttr(e.key)` 并标注「onclick 键控传参全转义」——已改为断言 `escQ` 并注明原因。

新增 `test/inline-handler-escape.test.js`（全仓守卫 + 扫描器自检 + 语义对照），
已用变异测试验证有效性。

### 6.6 验证结果

| 检查 | 结果 |
|---|---|
| `node --test test/*.test.js` | **2223 tests / 2220 pass / 0 fail / 3 skipped**（修复前 2180 / 2176 / 1 fail） |
| `npx eslint src/ test/` | 0 error（退出码 0） |
| `npm run build` | 成功 |
| `npm run smoke:asar` | **13/13 通过** |
| `npm run check:dead-deps` | 31 个排除项均未被运行时加载，安全 |
| `npm run check:icons` | 20 项全通过 |
| 守卫变异测试 | 改配置 / 改回 escAttr 即红灯，均已恢复 |
| 内容零损失校验 | 换行转换前后 `git diff --stat` 逐字一致 |

> 说明：本次审查为静态阅读 + 自动化实测，未运行打包产物做真机安装验证，也未做平台 API 的在线可用性探测（相关链路需要真实 Cookie 与外网）。P1-1 的结论来自配置、依赖源码与产物三方的交叉验证，如需 100% 确证，可在测试机上用被篡改的安装包做一次端到端升级演练。
