# MusicDL / 揽乐 代码复审报告（v1.0.35）

> 复审日期：2026-10-13 ｜ 版本：`package.json` 1.0.35
> 范围：`src/` 全量（248 文件 / 52,686 行）+ `test/`（288 文件 / 41,746 行）+ `scripts/` + `build/` 构建配置
> 方法：静态阅读 + 跨文件检索取证 + 分域 SubAgent 走查，全部结论回到源文件原文复核
> 上一版基线：`docs/CODE_REVIEW_2026-09-28.md`（v1.0.33，232 文件 / 52,873 行）与 `docs/CODE_REVIEW_2026-09-17.md`（v1.0.19）
> **本轮不修改任何源码**。P0/P1 修复方案见第六节，待逐条确认后再动手。

---

## 一、结论摘要

| 维度 | 评级 | 变化 | 说明 |
|---|---|---|---|
| 安全边界 | 良 | → | Electron 三件套、IPC 契约单点、凭据三态、MCP 白名单、SSRF 与目录沙箱均仍成立；新增面未见回归。**两处口径偏松**（AI 落盘仍为纯词法判定、library 通道无条件含系统音乐目录），更新签名校验在直连路径上仍为空转 |
| 功能正确性 | 中 | ↓ | 本轮重发现集中于此：**两条 P0**（重启后队列不调度、限速模式下并发槽永久泄漏）+ 下载历史 SQLite 化的两条缺陷 |
| 架构与可维护性 | 中 | → | 巨型文件由 `local.js`/`app.js` 换成 `settings.js`/`playlist.js`；`renderer/index.html` 1466 行仍在。「两套口径」由 `downloadPath.js` 顶部注释自己点名，仍未消缺 |
| 仓库卫生 | 差 | ↓↓ | **源码树不在任何版本控制之下**（第零节）。这是唯一阻断后续所有修复的根问题 |
| 工程链路 | 中 | ↓ | `.github/workflows/ci.yml` 存在但不会被触发（未推送）；`node_modules` 缺失，lint 与单测无法实测 |

**实测数据**

| 指标 | 本轮实测 | 上轮（v1.0.33） |
|---|---|---|
| `src/` 规模 | 248 文件 / 52,686 行 | 232 文件 / 52,873 行 |
| `test/` 规模 | 288 文件 / 41,746 行（其中 `*.test.js` 274 个） | 2195 用例 / 2192 pass |
| `scripts/` / `build/` | 15 文件 / 2,786 行 ／ 1 文件 / 163 行 | — |
| 工作区总占用 | ≈ **4.9 MB**（src 2.3 + test 2.1 + docs 0.2 + build 0.2 + scripts 0.1） | 5.0 GB（`.backup` 1.6G + `release` 2.4G + `node_modules` 989M） |
| 单文件最大 | `styles/content.css` 1688、`views/settings.js` 1526、`views/playlist.js` 1518、`renderer/index.html` 1466 | `views/local.js` 1535、`app.js` 1533 |
| CRLF 文件 | **5 / 588**（3 个 `.bat` 有意保留 + 2 个二进制误判） | 修复后 0（`.bat` 除外） |
| git 状态 | **本项目无 `.git`**；上层 `F:/新建文件夹` 为 0 提交、0 跟踪文件的空仓库 | 上轮记「待提交改动 35 文件」 |
| lint / 单测 | **0 error / 2 warning**；**2741 用例 / 2741 pass / 0 fail**（修复前为 4 fail） | 0 error / 2192 pass |

> 评级口径：本版启用前两版未使用过的 **P0** 级，定义为「在真实用户可触发的前提下必然发生、且用户无法自行恢复的功能失效」。

---

## 二、值得肯定：本版仍然稳固的部分

1. **Electron 安全三件套零漂移**。`src/main/index.js:170-177`（主窗口）、`src/main/ipc/window.js:41-49`（桌面歌词）、`window.js:87-95`（迷你播放器）、`src/main/loginWindow.js:92-99`（登录窗口）四处一致设置 `nodeIntegration:false` / `contextIsolation:true`；二级窗口额外对 `will-navigate` 一律 `preventDefault()` 并 `setWindowOpenHandler(deny)`（`window.js:52-53, 96-97`）。

2. **IPC 契约单点仍具约束力，且 MCP 复用同一条校验链**。这是本版最值得保留的一条：`src/shared/ipcContract.js` 声明方向与参数规格 → `src/main/ipc/register.js:36-49` 在 handler 前统一 `normalizeArgs` 钳制 → 两个 preload 由 `buildContractArg` 派生白名单。**MCP 没有绕过它**：`src/main/mcp/mcpCore.js:19-25` 的 `namedToPositional` 显式复用同一个 `normalizeArgs`，`src/main/mcp/tools.js:134-155` 还在构建工具清单时断言「工具通道必须是 main invoke」。外部 Agent 与渲染层共用同一套钳制，设计正确。

3. **MCP 面做了两层拒绝**。`src/main/mcp/tools.js:8-9` 明确「cookie/登录、文件路径读写、set-pref、对话框、更新安装一律不进白名单」；`src/main/ipc/mcp.js:39-40` 用的是 `tryEncrypt` 而非 `encrypt`——安全存储不可用时返回空令牌、服务干脆不启动，而不是把明文令牌写进 `prefs.json`。

4. **下载落盘沙箱是双闸，且每首歌都走**。`src/main/downloadQueue.js:416`（根目录）与 `:440`（模板渲染出的子目录）两次 `isSaveDirAllowed`。后一道是上版 P1-7 之后补的：模板子目录此前一次都没判过就递归 `mkdir`，根目录里一个链接就能把写入甩到沙箱外。且此处刻意设计成「退回根目录」而不是「下载失败」，取舍合理。

5. **XSS 围栏整体严密**。抽查 8 类远端可控数据（8 平台的歌名/歌手/专辑、歌单名与简介、酷狗 KRC 解密结果、链接解析出的歌名、AI 生成的歌词、剪贴板文本、订阅更新徽标、云同步导入的 id），通向 `innerHTML` 的路径上均有 `esc` / `escQ` / `escAttr`；全渲染层 **`href="${...}"` 零命中**（无 `javascript:` 注入面），两处 `onclick="${...}"` 拼接（`diagnose.js:104`、`localFilterSummary.js:69`）均有正则或白名单前置。二级窗口歌词区已改用 `textContent`（`desktop-lyric.html:149-167`，注释坦承这是从 `<img onerror>` 触发点改过来的）。

6. **「防线未生效」这件事被诚实地写进了代码**。`build/config.cjs:112-131` 用整段注释把「开关开着但不产生实际约束」钉在源码里；`src/main/updateMirror.js:13-23, 66-88` 把镜像信任闸门做成 fail-closed，并用 `UntrustedMirrorError` 把措辞改成「因未签名而停用」，而不是谎称「已试过镜像」。这种「知道自己没做什么」的记录，比声称安全更有价值。

7. **仓库卫生大幅改善**：工作区从 5.0 GB 降到 4.9 MB，`.backup` / `release` / `node_modules` 已清；CRLF 未复发，`.gitattributes` 起效。

---

## 三、第零节 · 前置风险：源码树没有版本控制（须先于任何修复处置）

实测证据：

```
PS> Test-Path 'f:/新建文件夹/Lanyue-1.0.35/.git'    →  False
PS> git rev-parse --show-toplevel                   →  F:/新建文件夹（上层目录）
PS> git -C 'f:/新建文件夹' log --oneline -8         →  fatal: branch 'master' does not have any commits yet
PS> git -C 'f:/新建文件夹' ls-files | Measure       →  0
```

即：项目里的 `.gitattributes`、`.gitignore`、`.github/workflows/ci.yml` 三个文件内容都在，**但它们从未进入任何仓库**。`.git` 位于上层 `F:/新建文件夹`，是一个执行过 `git init` 却从未提交的空仓库，且 `git status` 把 `Lanyue-1.0.35/`、`Lanyue-main.zip` 以及 14 个无关的工作区目录并列为未跟踪项。

直接后果：

- 本轮及后续任何修复都**没有回滚点、没有 `git diff`、没有 `blame`**；第六节的每一处改动一旦落地就不可逆。
- 上一版报告引用的提交 `7286f17`、`674634a` 在本机无从验证，历史叙述只能靠文档自述。
- `.github/workflows/ci.yml`（lint / audit / dead-deps / test / 构建 + asar 冒烟）**永远不会运行**。上版「已接入 CI」的收益在当前状态下并未兑现。
- 上层仓库一旦有人 `git add -A`，会把 16 个无关目录（含其它客户端工作区与 zip 包）一并入库。

**建议（不含代码改动）**：在项目根目录单独 `git init` 并提交首个基线；若必须保留上层仓库，至少确认其 `.gitignore` 排除同级目录，避免误纳。这一步不通过，下面 P0 修复的风险不可接受。

---

## 四、问题清单

### P0-1 · 重启后恢复的下载队列永远不开始下载

`src/main/index.js:595-600` 只恢复了数据，之后没有调度：

```595:600:src/main/index.js
  // 启动时恢复队列
  try {
    await downloadQueueEngine.loadPersistedQueue();
  } catch (e) {
    logger.warn('[index] 恢复队列失败:', e.message);
  }
```

全仓 `processQueue()` 的调用点只有：`src/main/ipc/download.js:147 / 191 / 321`（新增单曲、重试、批量入队）、`src/main/subscriptions.js:221`（订阅自动下载）、`src/main/downloadQueue.js:674 / 711`（内部重入与解除暂停）。而 `loadPersistedQueue()` 内部（`downloadQueue.js:298-337`）只做 `downloadQueue.push(item)`，一次都不碰调度。

恢复后引擎的真实状态是 `activeDownloads = 0`、`_processQueueRunning = false`、无 `processTimer` ⇒ **引擎从不自行启动首轮**。

- 触发路径：崩溃、强杀或正常退出 → 重启 → `queue.json` 里的 pending 条目回到队列 → 界面显示「排队中 N 首」→ 一首都不下。
- 唯一的恢复出口是用户再手动加一首歌、点某首重试、或切一次暂停/继续。用户若只是等待，这些任务会在 24 小时后被 `STALE_PENDING_MS`（`downloadQueue.js:322-324`）判死为「排队超过 24 小时未启动」。
- 与 README 宣称的「重启续传」不符：数据续上了，行为没续上。

> 附带约束：`registerAllIpcHandlers()` 在 `index.js:613` 才执行，补调度必须放在它之后，否则恢复的任务落到尚未注册的 handler 上。

### P0-2 · 开启限速时响应流出错不会 settle，并发槽永久泄漏（队列彻底停摆）

```411:413:src/utils/downloader.js
      const throttle = speedLimit > 0 ? createThrottleStream(speedLimit) : null;
      const dataStream = throttle ? res.pipe(throttle) : res;
```
```426:427:src/utils/downloader.js
      dataStream.on('error', (e) => { reject(e); });
      dataStream.pipe(writeStream);
```

`src/utils/downloader.js` 全文**没有任何 `res.on('error')`**。Node 的 `pipe()` 既不转发源流的 `error`，也不会因为源流销毁而结束下游：

- `speedLimit === 0`：`dataStream === res`，第 426 行的监听生效 ✓ —— 这也解释了这条缺陷为何长期未被发现。
- `speedLimit > 0`：`dataStream === throttle`。此时源 `res` 出错（连接重置、中途断流）→ 无监听者 → 要么抛未捕获异常（主进程即 UI 线程），要么 `throttle` 既收不到 `end` 也收不到 `error` → `writeStream` 永不 `finish`（`:429`）→ `downloadFileWithRetry` 的 Promise 永不 settle。

后果链：`downloadQueue.js:476` 的 `await` 不返回 → `processOneSong` 的 promise 不 settle → **`:663` 的 `.finally()` 永不执行** → `activeDownloads--` 不发生、`_processing` 不清除。泄漏的槽攒满 `concurrency` 后 `_processQueueRunning` 停在 `true`，`:649` 的重入守卫永久拒绝调度；该任务在界面上永久「下载中」，取消与移除双双失效（`requestCancel` 只置标记，协程根本走不到下一个检查点 `:361`）。

### P1-1 · 更新签名校验：镜像路径已 fail-closed，直连路径仍为空转

结论：**这不是回归，而是上一版 P1-1 未闭合的部分现在看得更清楚了**。

- 仍空转：`build/config.cjs` 依旧**没有任何代码签名配置**（无 `certificateFile` / `certificateSubjectName` / `signtool`），因此产物 `app-update.yml` 不含 `publisherName`，`verifyUpdateCodeSignature: true`（`config.cjs:131`）也就没有可校验的对象。`updateMirror.js:41-57` 自己写明了这条机制；本轮未构建产物，证据链用的是「无证书配置」这一代码事实加上述机制说明。
- 已缓解（本版新增）：`src/main/updateMirror.js:83-88` 的 `isMirrorFeedTrusted()` 在无 `publisherName` 时抛 `UntrustedMirrorError`，`src/main/updater.js:174-180` 收到后整轮放弃镜像。也就是说**第三方镜像兜底当前处于半撤状态**，「信任根交给中间人」那条路径已经堵上。
- 残留：走 GitHub 直连时（`updater.js:196`），安装包同样在没有 `publisherName` 的情况下被执行安装（`updater.js:237-240`）。此路径的实际信任降级为「TLS + GitHub 域名」，而非「本仓库自有证书」。

这与 `build/config.cjs:118-130` 的自述一致（作者清楚现状），这里只是把「残留在哪一侧」补全。采购证书之前不建议恢复镜像兜底。

### P1-2 · SQLite 降级为内存库时仍重命名旧 `history.json` ⇒ 历史永久丢失

```167:193:src/utils/history.js
function _ensure() {
  if (_db) return;
  if (!_userDataPath) {
    _db = _openDb(':memory:');
    _count = 0;
    return;
  }
  ...
  try {
    _db = _openDb(file);
  } catch (e) {
    // db 损坏/被占用 → 备份重建，仍失败则退内存库
    ...
    try {
      _db = _openDb(file);
    } catch (e2) {
      logger.warn('[history] 重建仍失败，退化为内存历史（本次会话不落盘）:', e2.message);
      _db = _openDb(':memory:');
    }
  }
  _importLegacy(_db, path.join(_userDataPath, 'history.json'));
```

两个事实叠在一起构成丢数据：

1. 走到 `:189` 的内存库之后，`:192` 的 `_importLegacy` **无条件执行**。内存库写入必然成功，于是 `:160` 的 `fs.renameSync(jsonPath, jsonPath + '.imported')` 照常发生。
2. 内存库不落盘 ⇒ 进程退出即丢；而 `.imported` 不再被任何代码读取 ⇒ 下一次启动只会看到空库与一个无人认领的 `.imported` 文件。

触发条件：`userData` 只读、杀软锁住 `-wal`、或 DB 损坏且备份重命名也失败。正确处置应当是：内存库这一态下**不做 `:160` 的重命名**（旧文件是当时唯一的幸存副本）。

### P1-3 · AI 音乐落盘的 `saveDir` 仍是纯词法判定（符号链接可逃逸沙箱）

```158:174:src/main/ipc/ai-music.js
        const isInside = (base, target) => {          // ← 本地重写的纯词法版本
          const rel = path.relative(base, target);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        };
        const allowedBaseDirs = [
          path.resolve(defaultDownloadDir(app.getPath('music'))),
          path.resolve(app.getPath('userData')),
        ];
        ...
        const isAllowed = allowedBaseDirs.some(base => isInside(base, saveDir));
```

这正是 `src/utils/downloadPath.js:29-35` 顶部注释遗留下来的那一份，**本版仍未修**（注释还留在原地）：

> ⚠️ 遗留（不在本次范围内，留给后续）：`src/main/ipc/ai-music.js` 里另有一份纯词法的 isInside（ai-generate-music 的 saveDir 校验），同样只做 path.relative 判定，没过 realpath 复核……下载路径模板这侧已拒、AI 音乐落盘那侧仍放行。

而 `src/main/approvedDirs.js:97-114` 的正规实现是双闸（词法快筛 + `realpathDeep` 复核），专门封堵「批准目录内的链接指向外部」。此处把同样的判定换皮重写 ⇒ 若 `saveDir` 是（或经由）符号链接，AI 生成的 `.mp3` 会落到链接目标，即沙箱外的任意目录。写入内容来自远端模型返回，文件名则可由 `params.title` 控制（仅滤掉 `\/:*?"<>|`），配合固定后缀 `_<时间戳>.mp3` 可落到任意目录。

同一段还藏着一个独立缺陷（`:164-171`）：允许基目录只有 `defaultDownloadDir(music)` 与 `userData`，**不包含 `aiMusicSaveDir` 这个目录型偏好**（该键确实存在于 `approvedDirs.js:35` 的 `DIR_PREF_KEYS` 与 `prefs.js:69` 的白名单，渲染层 `views/ai-music.js:87, 495` 会读会写）。而主进程全仓没有读取 `aiMusicSaveDir` 的地方 ⇒ **用户在 AI 页选择的保存目录会被静默忽略**，歌曲一律落到默认目录。

### P1-4 · 取消/移除不真正中止在途协程：照常写文件、写历史、弹通知

取消检查点在每轮 attempt 的顶部只有一次：

```359:364:src/main/downloadQueue.js
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 取消 / 任务已被移出队列（如重试等待期被 splice）→ 终止协程，不再取流落盘
      if (song._cancelRequested || !downloadQueue.includes(song)) {
```

此后的 await 链——`:367` `evaluatePolicy`、`:388` `getDownloadUrlSmart`、`:476` `downloadFileWithRetry`、`:494-497` `getLyrics`、`:502` `embedId3Tags`、`:538` `history.add`——全程不再检查。而 `src/main/ipc/download.js:201-211 / 247-258` 的移除与清空是先 `cancelInFlight` 再 `splice`；`cancelInFlight` 只能销毁已登记到 `_inflightReqs` 的请求（`downloader.js:309-316`）。若此刻协程正卡在前面几个 await，或已进入歌词/ID3 阶段，就只是置了一个没人再看的子标记。

后果：已被移除的歌跑完带宽 → 落到正式文件名 → 写 `history.add({status:'done'})` → 弹桌面通知。由于对象已被 splice，这些动作对用户完全不可见，磁盘上出现用户没有要过的文件。

### P1-5 · 缺少 Content-Length 校验：半截文件被判定为下载成功

```390:409:src/utils/downloader.js
      const isResume = res.statusCode === 206 && resumeOffset > 0;
      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      ...
      const writeStream = fs.createWriteStream(tmpPath, { flags: isResume ? 'a' : 'w' });
```
```429:434:src/utils/downloader.js
      writeStream.on('finish', () => {
        fs.rename(tmpPath, savePath, (err) => {
```

`content-length` 只被用来算进度（`:417-419`），`downloaded` 与 `fullSize` **从未比对**，也没有 `res.complete` 判定；`'finish'` 一到就 rename。服务端给出 `content-length` 后中途关闭且未报错时 ⇒ 半截文件转正名 ⇒ 嵌 ID3 ⇒ `history.add({status:'done'})`（size 取自 stat，看起来正常）⇒ 用户拿到播一半就断的歌，且后续去重与历史都会认为「已下载」（`ipc/download.js:132-142` 会据此跳过）。

对照来看：同一文件 `:403-407` 已经做了「200 + text/html 错误页」拦截，说明作者意识到了 CDN 的坏数据形态，只是短包这种更隐蔽的形态没覆盖到。

### P2-1 · 下载进度 IPC 无节流，且每条都触发一次全队列扫描

- `downloader.js:415-421`：每个 `data` chunk 回调一次 `onProgress`；
- `downloadQueue.js:476-490` 的进度回调里**无条件** `safeSend('download-progress')`；
- `src/main/context.js:21-23` 每条 `download-progress` 还额外触发 `taskbarProgress.refresh()` → `taskbarProgress.js:70-72` 再对整个队列扫描一遍。

无限速时每首每秒可达数百至数千条 IPC 与同等次数的全表扫描，并发 N 首线性放大。值得一提：`src/renderer/js/queueSummary.js:9` 的注释写着「main 端已节流」——**与实现不符**，这条注释本身就是误导源。

### P2-2 · `library.js` 的路径沙箱无条件放宽到系统音乐目录（两套口径）

```53:65:src/main/ipc/library.js
function isInAllowedDir(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (approvedDirs.isApprovedDir(resolved)) return true;
    const bases = [];
    const localDir = prefs.get('localDirPath') || '';
    if (localDir) bases.push(localDir);
    const saveDir = prefs.get('saveDir') || '';
    if (saveDir) bases.push(saveDir);
    bases.push(app.getPath('music'));          // ← 无条件纳入
    return approvedDirs.isInsideRealAny(bases, resolved);
```

即便 prefs 全空、用户从未批准任何目录，`isInAllowedDir` 仍放行 `%USERPROFILE%\Music` 下的**任意**路径。而同一仓库里 `ipc/window.js:220`（打开文件夹）与 `downloadQueue.js:416/440`（下载落盘）用的都是严格版 `isApprovedDir`。本函数覆盖 `delete-file` / `write-local-lrc` / `update-id3-tags` / `rename-file` / `read-local-metadata` / `scan-local-library` 等十余条通道。

对比：`index.js:530` 批准的是 `defaultDownloadDir(app.getPath('music'))`，即加了子目录的那个路径，范围窄得多。此处把宽了几档的写法单独留给了本地音乐库模块。

### P2-3 · WebDAV 合并无墓碑：删除永不传播，且越同步越稳（已知取舍，记录）

`src/utils/syncMerge.js:8-11` 头部坦承没有墓碑机制；`:59-65` 取 `updatedAt` 较新者为基底后，把旧方独有的歌曲按 songKey 并入 ⇒ A 端刚删的歌只要还在 B 端旧版本里，就会被确定性地并回来；删歌单同理（`:53-57`：远端有而本地无 ⇒ push）。整体趋向并集最大化。

与上版一致，这属于快照合并方案的固有取舍（文件里写明「与 lx-music-desktop 的行为一致」）。**不建议改算法**，但界面应当明示「同步只合并不删除」，否则用户「删了又被变回来」的困惑无从解释。

### P2-4 · 412 冲突重试的第二次 PUT 不带 ETag ⇒ 无锁无条件覆盖

```54:59:src/utils/cloudSyncCore.js
    if (put && put.ok === false && put.conflict) {
      conflictRetried = true;
      const remote2 = await fetchSnapshot(config);
      merged = mergeSnapshotData(merged, _remoteDataOrThrow(remote2));
      put = await pushSnapshot(config, _envelope(merged, now), {});   // ← 丢了 etag
    }
```

首次 PUT（`:51`）正确地带了 `{ etag: remote1.etag }`，`webdav.js` 因此会加 `If-Match`；第二次传 `{}` ⇒ `webdav.js:189` 因 `opts.etag` 为空而省略 `If-Match` ⇒ 变成无锁覆盖。若此刻有第三台设备也在写，它的修改会被静默覆盖且**不产生任何冲突提示**（最后一写赢）。这与文件头声称的「412 时重拉、重并、再推一次」不符——既然重拉了，就应该重新上锁。

### P2-5 · `history.importEntries` 给导入条目分配最小 seq ⇒ 本机满 5000 条时刚导入的立即被淘汰，且计数虚报

`src/utils/history.js:339` 取 `below = min(seq)`、`:353` 逐条 `below -= 1` ⇒ 导入条目拿到的是**当前最小**的 seq；而 `_trim()`（`:206-212`）按 `ORDER BY seq DESC LIMIT MAX_ENTRIES(5000)` 保留 ⇒ 新导入的条目排在最旧的一侧，会被第一批淘汰。`added` 计数（`:361`）照加，`src/main/ipc/cloudSync.js:169` 据此提示「下载历史：导入 N 条」——用户看到的数字是假的。

### P2-6 · `repairIds` 的模块级计数器会在冲突重试里给同一条目生成两个 id ⇒ 重复歌单

`src/utils/syncMerge.js:33-43`：`_fixedSeq` 是全局递增的，id 形如 `${prefix}_fixed_${i}_${seq}`。首次合并（`cloudSyncCore.js:48`）把远端坏 id 修成 `..._seqA`；412 之后第二次合并（`:57`）的 `local` 是首次合并的结果（id 已安全，不再改写），但 `remote2` 里那条仍是原始坏 id（首次 PUT 并未成功写入远端）⇒ 修成 `..._seqB` ⇒ `mergePlaylists` 按 id 做并集（`:53`）⇒ 一条变两条，并随下次同步继续扩散。

### P2-7 · 健康度「一击垫底」，且手动探测会反向惩罚自己

`src/utils/sourceHealth.js:19-32`：一次失败 ⇒ `arr=[false]` ⇒ `getHealthScore() = 0/1 = 0`；`:56-62` 的 `rankByHealth` 把 0 分排在所有「无数据 = 1 分」的源之后 ⇒ 排在末尾的源很难被优先选中 ⇒ 新样本进不来，需要连续约 20 次成功才能爬回 1.0。窗口为 20 且不做时间衰减（`:13` 自述「窗口本身就限制了旧样本的影响」），因此单次失败的影响在整个会话内长期存在。

叠加 `src/main/ipc/search.js:185`：`probe-sources` 对每个源调用 `api.recordProbeResult(src, ok)`，弱网或被限流时，一次「源可用性实测」会把**全部源**打到 0 分并重新排到末尾。该循环还是串行的（`166-187`），每源两跳各 8 秒上限。

> 已核实此处**没有除零/NaN**：`getHealthScore` 对 `arr.length` 有守卫。

### P2-8 · 转码失败或取消后不清理已写出的半成品，重试再留第二份

`src/utils/audioConvert.js:391-399`：`proc.on('close')` 的非零分支只拼错误消息，**没有 `unlink(outputPath)`**；`abort()`（`:356-362`）kill 之后同样不清理。ffmpeg 以 `-y` 直写 `outputPath`（无 tmp + rename）⇒ 输出目录留下 0 字节或半截文件；再次重试时 `resolveOutputPath`（`:212-214`）因 `existsSync` 命中而改成 `_1` 命名 ⇒ 留下第二个残件，本地曲库扫描会把坏文件当曲目收进来。

> 关于「是否会删除或覆盖源文件」：**未能确认**这样的路径——`-i inputPath` 与 `-y outputPath` 是两个不同路径，且名字避让会加成 `_1`。风险只在产出侧残留。

### P2-9 · `history.findDownloaded` 在主线程做同步 `existsSync`，且被放进批量循环

`src/utils/history.js:265`（配合 `:258-268`）每次调用都同步 `fs.existsSync`；而 `src/main/ipc/download.js:298`（批量入队，逐首）与 `src/main/subscriptions.js:206`（订阅轮询，逐首）都在循环里逐条调用。仓库自己的规矩写在 `src/main/ipc/history.js:14`、`src/main/ipc/library.js:29`：「主进程即 UI 线程：判活必须异步 stat」——这里没有走 `utils/fsAsync`。网络盘或离线 NAS 上一次 stat 可达数十毫秒，几百首批量时窗口卡顿。

### P2-10 · 损坏的 `history.json` 永不自愈，每次冷启动重演一遍

`src/utils/atomicFile.js:59-66` 的 `safeReadJson` 只对坏文件做 `copyFileSync` 成 `.bak`，不删也不改原名；`history.js:131` 遇到 `!res.ok` 就直接 `return` ⇒ `.bak` 被反复覆盖、坏 json 永久共存，那段历史永远进不了 DB，而且每次启动都多做一次整文件读 + 拷贝。

### P2-11 · KRC 解码：无 magic 校验、inflate 无输出上限、时间轴不排序

`src/utils/krcCodec.js:37-45`：

- `:39` 先跳过 4 字节「魔数」再 XOR，**从不校验是否为 `krc1`**；内容被截断导致解码后不足 4 字节时，`subarray(4)` 得到空 Buffer，`inflateSync` 抛错（由 `:43-44` 包成 Error 抛出；`decodeKrc` 本身不 catch，靠 `platforms/kugou.js:162-166` 兜住）。
- `:42` `zlib.inflateSync(buf)` **没有 `maxOutputLength`**。对照 `src/utils/webdav.js:31` 的 `MAX_RESPONSE_BYTES` 防护，这里缺一道：构造的压缩炸弹可在主进程（UI 线程）一次性吃满内存。
- `:58-63 / :81 / :103-105`：行与字的时间轴**完全不排序**，只按文本出现顺序 push；用户可见症状是逐行歌词回跳。
- `:60` `.replace(/\[language:[\w=+/]+\]\n/, '')` 只删标记行本身（且无 `/g`），不跳过翻译块正文——与文件头 `:12` 宣称的「此处跳过翻译块」不符；`test/krcCodec.test.js` 没有排序断言，fixture 里 `language` 零命中 ⇒ 该分支完全无覆盖。

### P2-12 · AI 请求超时会排出两条重试定时器 ⇒ 重复请求、重复计费

`src/api/ai-music.js:134-142`：`req.on('timeout')` 里的 `req.destroy()`（`:135`）会随即在同一 `req` 上触发 `'error'` ⇒ 走到 `:126-133` 的 `scheduleRetry(retryCount)`；两条路径使用的是同一个 `retryCount`，而 `retryTimer` 变量被后一次赋值覆盖 ⇒ 前一个定时器没有 `clearTimeout`，到点后 `doRequest(retryCount+1)`（`:105`）会执行两次。`settle`（`:92-97`）只保证 Promise 单次结算，拦不住已发出的第二跳。当前 `generateLyrics` / `generateMusic` 显式传了 `retries: 0`（`:308 / :526`）才躲开——**任何将来复用这个请求包装且未显式关掉重试的调用方都会踩**。

### P2-13 · 自然语言多关键词搜索：单个关键词失败被静默吞成空列表

`src/api/services/nlSearchService.js:37-39`：`Promise.all(queries.map(q => Promise.resolve(searchAll(q)).catch(() => [])))` ⇒ 某个关键词超时或报错时落成 `[]`，而 `queries`（`:55`）原样返回 ⇒ 界面完全看不出有 1~2 个关键词挂了，用户以为结果就这么多。去重键 `` `${id}:${source}` ``（`:47`）本身是正确的，不会丢同曲。

> API Key 是否入日志：**未能确认泄漏路径**。`ipc/search.js:43`、`api/ai-music.js:416/563/697` 都只打 `e.message`，Key 只进 `Authorization` 头；导出侧 `NONPORTABLE_PREF_KEYS`（`ipc/cloudSync.js:29-30`）把它剔出了备份。此项判为「未见异常」。

### P2-14 · `.tmp` 永久残留，而跨进程续传从未真正生效

`downloader.js:423-425` 刻意保留 `.tmp` 以支持续传，但续传偏移 `resumeOffset` 是**进程内的局部变量**（`downloader.js:620`）⇒ 只对单次进程内的重试有效，重启后从 0 开始。于是「保留 .tmp」付出的代价（下载目录里的 `<目标>.mp3.tmp` 永久残留）换来了拿不到的收益：每首传输失败或半途取消的歌都会留下一个无人清理的临时文件（重下时 `flags:'w'` 覆盖同名，所以不累积，但失败歌曲的残留永久存在）。

### P2-15 · `_approved` 集合只增不删，放大每次判定的同步系统调用

`src/main/approvedDirs.js:37` 的 `_approved` 全仓没有 `delete` 或清空；`window.js:193`、`index.js:528/530/531`、`library.js:358` 持续追加。代价是：`isApprovedDir`（`:97-114`）= 词法快筛 O(|_approved|) 次 `path.relative` + `isInsideRealAny`（`:117-125`）对每个成员各做一次 `realpathDeep(base)`（每次至少 1 次 `realpathSync`；路径不存在时逐级回退，每层一次）。

实测量化（单曲下载路径）：`downloadQueue.js:416` 仅在渲染层传了 `song.saveDir` 时触发；`:440` 每次 attempt 必触发一次（此时 `mkdir` 尚未执行，目录通常不存在 ⇒ 走回退循环）。故单曲约 2~12 次 `realpathSync`，重试到上限时约 8~24 次，且 `_approved` 越大越贵。

> 已核实 `download-progress` 回调内**不**触发任何 `realpath` 或 `notifyQueueChanged`（`downloadQueue.js:476-490` 只有赋值、`speedMeter.nextSpeed` 与 `safeSend`），这条不必担心。

### P2-16 · 监听器只注册不注销

`src/main/preload.js:61 / 70 / 96` 与 `preload-secondary.js` 用 `ipcRenderer.on` 生成订阅方法，**未暴露 `removeListener`**；渲染层侧 `src/renderer/js/dlStatus.js:22` 的 `_listeners` 数组只 push、没有 remove 出口（只有测试用的 `_resetDlStatus`）。当前各视图是模块顶层一次性注册（`app.js`、`search.js:955`、`playlist.js:531`、`views/subscriptions.js:113`），尚不会累积；但窗口重建或模块被重复执行时会线性增长。

### P2-17 · 队列终态同步全表落盘落在主线程

`downloadQueue.js:663-667` → `writeQueueNow`（`:267-275`）→ `src/utils/atomicFile.js:33-37` 的 `fs.writeFileSync` + `fs.renameSync`，内容是 `JSON.stringify(整个队列)`（上限 `MAX_RESTORED_TASKS=20000`，`:63`）。批量下载集中完成时，主线程按任务数串行执行整表同步写，界面抖动。

> 另：`dispose()`（`downloadQueue.js:737-747`）只在已有 `queuePersistTimer` 时才补写，`index.js:691` 的 `window-all-closed` 之外**没有 `before-quit` / SIGINT 兜底**。

---

## 五、与两份历史基线的逐条对账

| 上版编号 | 议题 | 状态 | 本轮判据 |
|---|---|---|---|
| 09-28 P1-1 | 更新签名校验空转 | **部分闭合** | 镜像路径已 fail-closed（`updateMirror.js:83-88`，本版新增；`updater.js:174-180` 收到即放弃整轮），直连路径仍空转（`build/config.cjs` 无任何证书配置）⇒ 降为 P1-1 保留 |
| 09-28 P1-2 | CRLF 导致 Windows 必然失败 | **已修且未复发** | 实测 588 个文本文件中仅 5 个含 CRLF：3 个 `.bat`（有意）+ 2 个二进制误判 |
| 09-28 P2-1 | 巨型文件继续膨胀 | **持平（结构性未解）** | 最大者换成 `settings.js` 1526 / `playlist.js` 1518 / `index.html` 1466；原头名 `local.js` 1535→1386、`app.js` 1533→1489 有下降。文件数 232→248，总行数基本持平 |
| 09-28 P2-2 | 工作区 5.0 GB + 根目录畸形文件 | **已修** | 实测工作区约 4.9 MB，`.backup` / `release` / `node_modules` 均已不存在，根目录无畸形残留 |
| 09-28 P3-1 | 生产日志静默影响排障 | **已修** | `utils/logger.js` 已接主进程落盘，各处沿用异步惯例 |
| 09-28 P3-2 | 第三方音乐 API 供应链薄弱 | **未处理（可接受）** | `NeteaseCloudMusicApi` / `qq-music-api` 仍在 `dependencies`，靠 `package.json:47-58` 的 `overrides` 锁脆弱子依赖，并靠 `build/config.cjs:67-97` 剔除 jade 链。风险面仍在，但当前没有更优替代 |
| 09-28 P3-3 | 迷你播放器 CSP 多余的 `file:` | **已修** | 本轮未发现回归 |
| 09-28 P2-3 | 内联事件处理器 XSS 转义误用 | **已修，但留下新隐患** | 本轮复核 8 类远端数据均有转义；新增隐患见 P3-1 / P3-2 |
| 09-17 / 09-28 其余项 | `downloadPath.js:29-35` 自己点名的「AI 落盘两套口径」 | **未修** | 见 P1-3 |
| 本轮新增 | 源码树无版本控制 | **新增（第零节）** | 实测三条 git 证据 |
| 本轮新增 | 重启队列不调度 / 限速下并发槽泄漏 | **新增 P0** | 见 P0-1 / P0-2 |

### 附带：两条新的 P3

- **P3-1 · `esc()` 不转义单引号，与 `escAttr` 口径不一致**。`src/renderer/js/utils.js:26` 的 `esc` 缺 `'`；`:46` 的 `escAttr` 才处理了 `&#39;`。当前唯一把变量塞进单引号 JS 字面量的地方（`views/search.js:387`）恰好用了吃单引号的 `escQ`（`:35-42`），所以现在是安全的；但只要有人照「元素内容用 esc」的习惯写出 `title='${esc(x)}'`，单引号即可闭合属性并挂上 `onmouseover=`。这是最可能先破的一道缝。
- **P3-2 · `window.esc` 缺失时降级为恒等函数**。`songGroups.js:77`、`views/nameBatch.js:121` 的写法是 `typeof esc === 'function' ? esc : (s => String(s))`。`window.esc` 由 `utils.js` 在运行时赋值，而该文件自身还有动态 import ⇒ 一旦加载次序错乱，远端歌名就会以原文进入 `innerHTML`。当前运行次序正常，但与 `views/` 里绝大多数直接调用 `esc` 的写法不一致，属「缺失单一事实源」。

---

## 六、待确认修复方案（逐条确认后才动代码）

> 说明：本轮**未修改任何文件**。以下每项给出最小改法与回归测试建议，请逐条确认。由于当前没有 `node_modules`，验证环节需要先执行 `npm install`（属写操作，需另行授权）。

| # | 优先级 | 修复要点 | 回归测试建议 |
|---|---|---|---|
| F1 | P0-1 | 在 `index.js:613` 的 `registerAllIpcHandlers()` **之后**补一次 `downloadQueueEngine.processQueue()`；更稳妥的做法是让 `loadPersistedQueue()` 在恢复出 pending 条目后自行发起首轮调度 | 新增 `test/queue-resume.test.js`：构造含 pending 的 queue.json → 调用 loadPersistedQueue → 用注入的 spy 断言发生了调度 |
| F2 | P0-2 | 在 `downloader.js:413` 之后补 `res.on('error', e => reject(e))`，并把 `res.pipe(throttle)` 换成 `stream.pipeline`（自动转发错误与清理），`throttle` 也要单独挂 error | 新增用例：假 res 中途 emit error 且 `speedLimit>0` → 断言 Promise reject 且 `activeDownloads` 归零；另加「槽必被回收」断言防复发 |
| F3 | P1-1 | 二选一：(a) 采购代码签名证书，在 `build/config.cjs` 配 `certificateFile` / `certificateSubjectName`（推荐，届时 `updateMirror` 的闸门自动放行）；(b) 不动代码，把设置页文案与注释更新为「直连路径亦未启用签名校验」，避免误判 | 已有 `test/update-signature-guard.test.js`；若选 (a) 需同步修改 `RECORDED_STATE` |
| F4 | P1-2 | `history.js:192` 之前加判别：仅当使用的是**文件库**（非 `:memory:`）时才执行 `_importLegacy` 的重命名分支 | 新增用例：DB 连续两次打开均失败 → 断言 `history.json` 未被 rename，且告警日志出现「退化为内存历史」 |
| F5 | P1-3 | 删除 `ai-music.js:160-171` 的本地 `isInside`，改为调用 `approvedDirs.isApprovedDir(saveDir)`；同时把 `aiMusicSaveDir` 纳入允许基目录（顺带修「用户选择的 AI 保存目录被忽略」） | 新增用例：saveDir 为指向沙箱外的符号链接 → 断言回落到默认目录；`aiMusicSaveDir` 已设且已批准 → 断言落在其中 |
| F6 | P1-4 | 把 `!downloadQueue.includes(song) || song._cancelRequested` 抽成 `shouldAbort(song)`，在每个 await 之后补检查点；并在终态分支加「若任务已不在队列则不写历史、不弹通知」 | 新增用例：下载中移除任务 → 断言不写 history、不 rename、计数释放 |
| F7 | P1-5 | `downloader.js:429` 的 `finish` 处补 Content-Length 一致性校验（或改用 `res.complete`）：不符则 reject 并保留 .tmp 供续传 | 新增用例：声明 1000 字节却只写 300 字节后正常 end → 断言 reject 而非 rename |
| F8 | P2-4 | `cloudSyncCore.js:58` 改为传 `{ etag: remote2.exists ? remote2.etag : undefined }` | 新增用例：首次 412 → 断言第二次 PUT 带 `If-Match` |
| F9 | P2-5 | `history.importEntries` 改为站在当前最大 seq 之上分配，或在导入后先 trim 再统计 `added` | 新增用例：本机已满 5000 条 → 导入 10 条 → 断言 10 条仍在且 added=10 |
| F10 | P2-6 | `repairIds` 改为确定性 id（对原始 id 做哈希，而非全局递增计数），保证同一输入两次修复结果一致 | 新增用例：同一远端快照连续合并两次 → 断言不产生重复 id |
| F11 | P2-11 | `krcCodec.js:39` 校验 magic；`:42` 加 `maxOutputLength` 上限；`:81 / :103-105` 对时间轴排序；修正 `:60` 的翻译块剔除逻辑并补 fixture | 新增用例：非法 magic / 行序打乱 / 压缩炸弹超限 / 含 `[language:]` 块 |
| F12 | P2-1 / P2-17 / P2-2 | ① 进度上报节流（至少 100ms 或按百分比变化）；② 队列终态写盘考虑给 `atomicFile` 增加异步分支（注意保持崩溃窗口语义）；③ `library.js:63` 的 `app.getPath('music')` 改为仅在其已被批准后纳入 | 新增用例：N 个 chunk 断言 IPC 条数受限；抽样断言修正后的 `isInAllowedDir` 拒绝未批准路径 |
| F13 | P2-8 / P2-14 | 转码失败或取消时 `unlink(outputPath)`；给 `.tmp` 增加老化清理（超期删除） | 新增用例：伪造 ffmpeg 非零退出 → 断言 outputPath 不存在 |

**建议记录但不修复**：P2-3（无墓碑属快照合并的固有取舍，建议改界面文案说明「同步只合并不删除」）；P2-7 的健康度算法（建议改为有限惩罚而非直接归零，但会影响换源行为，宜单独立项）；P2-12 / P2-13（触发概率低，且当前调用方已通过传参规避）。

---

## 七、复审方法自述与边界

- 报告阶段（第四、五节）**没有构建**，结论全部靠静态阅读取证，每条都附了可打开文件核对的行号。分域走查产出的结论已逐项回到源文件复核；其中一条（「`history.js:170` 内存库分支缺少 return，将导致 `path.join(undefined)` 崩溃」）经重读原文后确认 `:173` 确实存在 `return`，故**已撤回**，未写入清单。
- 修复阶段（第八节）在 `npm install` 之后跑了 `npx eslint src/ test/` 与 `node --test "test/*.test.js"`，结果见第八节。
- 未能确认、不宜据此下结论的点已在正文标注：转码是否删除或覆盖源文件、API Key 是否进入日志、批量转码是否并发导致 `resolveOutputPath` 的 TOCTOU。
- 平台插件层（8 个）本轮只抽样核实了酷狗（因 KRC）及其到网关的路径；单个插件上发现的问题尚未横向推广到其余 7 个，建议在改动 AI / KRC 相关代码时补一轮横向排查。

---

## 八、本轮修复记录（2026-10-13，报告确认后实施）

**前置**：项目原本不在任何版本控制之下（第零节）。修复前先在项目根 `git init` 并提交基线 `0be2a99`（590 个文件），此后每一处改动都可 diff、可回滚。

### 8.0 F14（复审中新发现，先于原计划修复）· `approvedDirs` 的 fail-open

修复前 `npm test` 有 4 个失败用例（`approved-dirs` / `download-path-symlink` / `open-folder-sandbox`）。根因不是测试环境问题，而是**真实的设计缺陷**：实测本机对 junction 的 `stat` / `realpathSync` 一律返回 `UNKNOWN(-4094)`，而 `realpathDeep` 把**所有**失败都当成「路径不存在」→ 逐级回退到最近祖先的真实路径再拼回剩余段。于是 `D:\Music\link\evil.dll`（link 指向沙箱外）被算成它自己，判定「在沙箱内」——**第二道闸在这种环境下从未生效，且失败得毫无痕迹**。

- `src/main/approvedDirs.js`：`realpathDeep` 只对 `ENOENT` / `ENOTDIR` 回退，其余错误上抛；新增 `_realpathViaLink()` 在 `realpathSync` 失败时用 `readlinkSync` 逐段解析链接（junction 的 readlink 可用），保证「用户把下载目录本身选成 junction」这种合法用法不被误伤；`isInsideReal` / `isInsideRealAny` 统一把异常转成**判否**（fail-closed），不冒泡成 IPC 异常。
- 回归测试：`test/realpath-failclosed.test.js`（3 例：无法验证⇒判否且不冒泡 / ENOENT 仍放行 / 链接指向外部⇒判否）。
- 结果：4 个红用例全绿；与同批修复合计后全量 **2724 pass / 0 fail**。

### 8.1 P0-1 · 重启后恢复的队列自启动

- `src/main/downloadQueue.js`：新增 `resumeRestoredQueue()`，只调度 `pending`（`error` 的语义是等用户决定，不自动重跑），并单独导出以便单测——「加载是纯数据动作、调度是行为动作」合成一个方法就没法测「恢复后到底开没开跑」。
- `src/main/index.js`：在 `registerAllIpcHandlers()` **之后**调用（取流/歌词等上下文在那段装配里才就绪）。
- 回归测试：`test/queue-resume.test.js`（4 例，含一条静态接线钉：断言调用点在恢复之后、在注册之后）。

### 8.2 P0-2 · 限速模式下响应流错误不 settle

- `src/utils/downloader.js`：给**源流** `res` 单独挂 `error` 监听（限速流自身也挂），让传输层错误一定能让 Promise settle。
- **一处回撤值得记录**：最初改用 `stream.pipeline`，结果 `test/downloader.test.js` 的「瞬时中断后保留 .tmp，重试带 Range 断点续传」立刻变红——pipeline 在任一环出错时会销毁其余所有流，包括目标 `writeStream`，已落盘的前缀被一起冲掉，断点续传随之失效。续传要的正是「出错时把已落盘的字节留住」，所以最终坚持手工接线：只让错误**通知**调用方，不让错误**摧毁**已落盘的数据。代码注释里记了这个取舍，免得下一个维护者再"顺手升级成 pipeline"。
- 回归测试：`test/downloader-stream.test.js`（5 例，含「限时 race 判悬挂」与正常路径对照）。

### 8.3 P1-1 ~ P1-5

| 项 | 改动 | 回归测试 |
|---|---|---|
| P1-1 签名校验 | **未改代码**：设置页中英文文案（`renderer/index.html:1261`、`lang/zh.json:326`、`lang/en.json:326`）已准确表述「当前更新包未启用安装包签名校验，请仅从官方渠道获取」，方案 (b) 已落地。剩下的仍是「采购证书」这一决策项 | — |
| P1-2 历史丢数据 | `history.js`：`_openDb` 记录当前句柄是否内存库；`_ensure()` 在内存库这一态**跳过** `_importLegacy`（它末尾会把 `history.json` 改名成 `.imported`，而内存库不落盘 ⇒ 历史永久蒸发）。附带订正了本报告初稿里一处误判：`:173` 的 `return` 确实存在 | `test/history-volatile.test.js`（2 例：mock `DatabaseSync` 构造失败 → 旧文件原样保留；正常路径仍改名迁移） |
| P1-3 AI 落盘沙箱 | `ipc/ai-music.js`：删掉本地重写的纯词法 `isInside`，改调 `approvedDirs.isApprovedDir`。顺带修掉一个功能 bug：旧允许基目录不含 `aiMusicSaveDir`，用户在 AI 页选的保存目录被静默忽略、每首都落回默认目录 | `test/ai-music-savepath.test.js`（3 例静态守卫）+ `utils/downloadPath.js` 里那段已过时的「遗留」注释同步改写 |
| P1-4 取消不中止 | `downloadQueue.js`：抽出 `shouldAbort(song)`，在**取流后 / 传输完成后 / 终态落笔前**三个检查点补判据。传输完成后被取消时保留已落盘文件（移除队列项 ≠ 删除文件），但不再嵌标签、写历史、弹通知 | `test/queue-abort.test.js`（3 例，含正常路径对照） |
| P1-5 短包判成功 | `downloader.js`：`writeStream` 的 `finish` 里比对 `downloaded < fullSize`，不符即判失败且**保留 .tmp** 供 Range 续传 | `test/downloader-stream.test.js`（3 例：绝不出正名 + 静态守卫钉住兜底分支 + 长度相符对照） |

### 8.4 P2-4 ~ P2-13

| 项 | 改动 | 回归测试 |
|---|---|---|
| P2-4 412 丢锁 | `cloudSyncCore.js`：第二次 `pushSnapshot` 带上重拉到的 `etag`。**同时纠正了一条把缺陷钉成规范的既有测试**（原断言「重试为无条件 PUT」） | `test/cloudSyncCore.test.js`（改写 1 例 + 新增「远端已删除时退回无条件 PUT」1 例） |
| P2-5 导入即淘汰 | `history.js`：`importEntries` 从「当前最小 seq 往下递减」改为「当前最大 seq 往上递增」，被淘汰的只会是本机最旧条目 | `test/history-import-trim.test.js`（2 例：满额 5000 条后导入 10 条仍在且计数如实；导入项排在最新一侧） |
| P2-6 id 不幂等 | `syncMerge.js`：`repairIds` 的全局递增计数改为「原始 id 的哈希 + 列表内去重后缀」，同一坏 id 无论修几次都得到同一个新 id，412 重试不再把一条拆成两条 | `test/syncMerge.test.js`（改写 1 例 + 新增确定性 1 例、重试收敛 1 例） |
| P2-11 KRC 加固 | `krcCodec.js`：校验 4 字节魔数（内容被截断时能与「KRC 损坏」区分开）；`inflateSync` 加 `maxOutputLength`（8 MiB，全仓唯一没有上限的解压点，且跑在 UI 线程）；`[language:]` 翻译块**整块**跳过（原来只删标记行）；行按时间戳排序 | `test/krcCodec-hardening.test.js`（6 例）。**一处自我修正**：最初连词的绝对时间也排了序，测试立刻抓到——KRC 里词的顺序就是逐字显示顺序，重排会把「句中尾」显示成「中尾句」。最终只排行、不动词序 |
| P2-1 进度洪泛 | `downloadQueue.js`：新增 `PROGRESS_THROTTLE_MS = 120`（约 8 fps），100% 那一拍总是发出去。`renderer/js/queueSummary.js` 里那条「main 端已节流」的注释过去与实现不符，现在名副其实 | `test/queue-progress-throttle.test.js`（3 例：200 个 chunk 的 IPC 收敛 + 两条守卫钉）。**第二次自我修正**：节流判据最初写成「时间窗 **且** 百分比相同」，等于没节流（每个 chunk 的百分比几乎都是新的），测试直接量出 102 条 |
| P2-2 库通道沙箱 | `ipc/library.js`：删掉无条件 `bases.push(app.getPath('music'))`。默认下载目录（`defaultDownloadDir(music)`）在 `index.js` 启动时已 approve、`get-default-dir` 展示的也是它，所以首次使用不受影响，无需额外开口子 | `test/queue-progress-throttle.test.js` 内含守卫钉；`test/library*.test.js` 等 35 例照常通过 |
| P2-8 转码残件 | `audioConvert.js`：失败 / 取消 / spawn 失败三条路径统一 `removeOutput()`（`-y` 直写目标、没有 tmp+rename，失败会留 0 字节或半截文件，还会被曲库扫描当成曲目） | `test/audioConvert.test.js` 23 例照常通过 |
| P2-14 .tmp 残留 | `downloader.js`：`downloadFileWithRetry` 在重试耗尽与用户取消时删掉 `.tmp`（`resumeOffset` 是进程内局部变量，下一次任务从 0 开始并不会真去续它，所以这个文件已经没主人） | 由既有 `downloader.test.js` 与新增 stream 用例共同覆盖 |

### 8.5 未做的部分（记录在案）

- **F3（采购代码签名证书）**：属决策而非改码。设置页文案已如实表述，直连路径的信任降级问题只能靠证书关闭；采购前不建议恢复镜像兜底（闸门是 fail-closed 的，会拦住）。
- **F12-2（队列终态写盘异步化）**：`atomicFile.js` 的同步 `writeFileSync + renameSync` 保留现状。它同时服务「退出前 flush」与「崩溃窗口不丢终态」两处语义，改成异步要重新论证这两条，收益（批量完成时的轻微卡顿）不足以换取这个风险。
- **P2-3（无墓碑导致删除复活）**：属快照合并的固有取舍，建议改界面文案说明「同步只合并不删除」，未改算法。
- **P2-7（健康度一击垫底）**、**P2-12/P2-13（AI 重试双发、多关键词静默吞）**：均为低概率且当前调用方已规避，留待单独立项。

### 8.6 验证结果

```
npx eslint src/ test/          → 0 error / 2 warning（与修复前同，2 条均为既有 warning）
node --test "test/*.test.js"    → tests 2724 / pass 2724 / fail 0 / duration 31.6s
```

修复前的同一命令是 **4 fail**（全部为符号链接沙箱用例）。新增测试文件 7 个、既有测试改写 3 个：
`test/realpath-failclosed.test.js`、`test/queue-resume.test.js`、`test/downloader-stream.test.js`、`test/history-volatile.test.js`、`test/ai-music-savepath.test.js`、`test/queue-abort.test.js`、`test/history-import-trim.test.js`、`test/krcCodec-hardening.test.js`、`test/queue-progress-throttle.test.js`。

> 一处需要复核的连带修改：`test/encoding-guard.test.js` 的白名单按**行号**登记，`library.js` 删掉 2 行 require 后行号从 481 移到 488，已同步更新并留注释说明。这正是「过期即红」想要的效果。

### 8.7 第二批修复（同日继续，处理 8.5 里留下的可修项）

| 项 | 改动 | 回归测试 |
|---|---|---|
| P3-1 `esc` 少一个单引号 | `utils.js`：`esc` 直接委托 `escAttr`。旧实现与 `escAttr` 差一个 `'`，于是「内容用 esc、属性用 escAttr」的惯例留着裂缝——照着写出 `title='${esc(x)}'` 就能闭合属性挂事件。文本节点里 `&#39;` 会正常显示为 `'`，可见文本零影响。保留两个名字是为了调用点自解释 | `test/escape-fallback.test.js` |
| P3-2 恒等降级 | 新增 `src/renderer/js/escapeFallback.js`（**零依赖**静态 import，彻底不受 `window.esc` 挂载时序影响），提供 `escSafe` / `escQSafe`：全局版就绪就用全局版，否则用等价实现——而不是旧代码里的 `(s => String(s))`。**顺带修掉一处真实漏洞**：`songGroups.js` 的 `locateSongRow('${esc_(it.id)}')` 里 `esc_` 是本地别名（全局缺失时降级成恒等），而它位于 onclick 的 JS 字符串字面量中，正是内联处理器守卫点名禁止的用法。守卫原先只按精确函数名扫描，**别名整条绕过**；判据已放宽为「名字里带 esc/escape」 | `test/escape-fallback.test.js`（含「别名绕过也必须被抓」的自检）+ `test/inline-handler-escape.test.js` 扩展 |
| P2-12 AI 超时双发重试 | `ai-music.js`：同一跳最多排一次重试（`hopRetryScheduled`）。旧实现里 `timeout` 分支的 `req.destroy()` 会让同一 `req` 随即发 `'error'`，两个分支各排一个定时器，而 `retryTimer` 被后一次赋值覆盖 ⇒ 前一个没被 `clear` ⇒ 一次超时换两次请求、两次计费。当前生产调用方都传了 `retries: 0`（计费接口禁重试）所以未爆发，但任何将来复用该包装的调用方都会踩 | `test/ai-search-resilience.test.js`（起本地「黑洞」服务数连接数：期望 1+2=3，旧实现是 1+2+2=5）。为此把内部 `request` 加入导出——不导出就无法验证这条不变量，因为危害全发生在重试通道上而生产把它关掉了 |
| P2-13 多关键词静默吞 | `nlSearchService.js`：失败收进 `failedQueries`（成功结果一条不丢），`search.js` 弹一条「N/M 个关键词没搜到，结果可能不全」的提示。旧实现的 `.catch(() => [])` 让用户把「3 个关键词挂了 2 个」误读成「LLM 就改写出这几首」 | `test/ai-search-resilience.test.js`（4 例，含「全部成功时不吐空字段」与「失败与截断互不影响」） |
| P2-10 损坏历史不自愈 | `history.js`：损坏的 `history.json` 改名为 `.corrupt-<ts>` 隔离（`.bak` 保留供手工抢救）。旧实现只把它复制成 `.bak`、原名留着，于是每次冷启动都重演一遍整文件读+复制，坏文件与 `.bak` 长期共存 | `test/history-async-and-corrupt.test.js`（含「合法文件仍按旧约定改名 `.imported`」的对照） |
| P2-9 判活同步 stat | 新增 `history.findDownloadedAsync`（判活走 `fsa.exists`，SQLite 查询保持同步——那是内存内的库），并把 `download.js`（单曲入队 + 批量入队）与 `subscriptions.js`（订阅轮询）**全部**换成异步版。`_autoEnqueue` 因此变成 async，调用方已加 `await` | `test/history-async-and-corrupt.test.js`（两版语义一致：命中/文件已删自愈/无记录）+ 守卫钉（这两个文件里不许再出现同步调用） |
| P2-7 健康度一击垫底 | `sourceHealth.js`：① 分数改**拉普拉斯平滑** `(ok+1)/(len+2)`——一次失败只是降权（1/3），20 连败才沉底（≈0.045）；旧口径 `ok/len` 一次失败即 0 分，被排到所有「无数据=1 分」的源之后，新样本进不来，要连赢约 20 次才爬得回来。② **探测与真实下载分桶**：`recordProbeResult` 进独立窗口，只出现在 `healthMap.probe` 供展示，不参与 `rankByHealth`。`api/index.js` 的 `recordProbeResult` 原本直接调 `recordResult` —— 弱网下点一次「源可用性实测」会把全部源一起打到 0 分并重排到末尾：用户为诊断点的按钮反而把源都降权了 | `test/sourceHealth.test.js`（改写 2 处精确分数口径 + 新增 2 例：单次失败不归零、探测不进排序但仍可见） |
| P2-3 云同步文案 | `lang/zh.json` + `lang/en.json` 的 `settings.general.webdavHint` 补明「同步只做合并、不传播删除：任一设备删掉的歌/歌单，如果另一台还留着旧快照，下次同步会再回来（想彻底清掉请在所有设备上都删）」。算法不动（无墓碑属快照合并的固有取舍），改的是用户预期 | `test/toast-i18n.test.js` 的欠账台账需同步（见下） |

> 一处连带修改：`test/toast-i18n.test.js` 的「欠账台账」逐字统计各视图里未收编进词典的中文字面量。新增的那条 AI 搜索提示让 `search.js` 从 36 变 37，按台账家法「新增欠账要改表」已把数字钉住并注明来由——**该测试的用意正是让「随手加中文文案」这件事必须留痕**。

**第二批验证**

```
npx eslint src/ test/          → 0 error / 2 warning（两条均为既有 warning）
node --test "test/*.test.js"    → tests 2741 / pass 2741 / fail 0
```

新增测试文件 3 个：`test/escape-fallback.test.js`、`test/ai-search-resilience.test.js`、`test/history-async-and-corrupt.test.js`。
