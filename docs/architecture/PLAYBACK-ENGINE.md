# 播放引擎重构蓝图（Playback Engine Blueprint）

> 状态：**待评审** ｜ 日期：2026-10-19 ｜ 适用版本：1.1.x
> 定位变更：产品身份从「多平台音乐下载器」转为「**以播放器为主体**的本地/在线音乐播放器」，下载降为附属能力。
> 前置输入：架构走查报告（8 维度，deletion test 全量取证）+ 播放器定位诊断 + platform-plugin-v3.md 方法论
> 本文是**施工图**，不是提案。审完即可按第 6 节开工。

---

## 1. 一句话目标

**给渲染层造一个播放引擎，让 `<audio>` 元素有唯一所有者、播放状态有显式状态机、播放能力有可测接口——先建缝，再搬实现，不动用户可见行为。**

为什么先做引擎而不是先「去 window 化」：走查证明 `window.*` 全局桥（~282 挂载）是其它四个 Top 级摩擦的**共同放大器**，但它是被「HTML onclick 兼容」这一个需求塑造的，直接拆会同时引爆 282 个挂载点。播放引擎是环上**边界最清晰、痛感最集中、且天然产生 seam** 的一环——引擎建好后，摸 audio 的 11 个文件改为「调引擎/订阅引擎」，window 桥在这条路径上被自然穿透，不需要专门发起运动。

---

## 2. 现状取证（为什么必须做）

全部为 2026-10-19 实测，非历史文档转述。

### 2.1 audio 元素无主

| 事实 | 数据 |
|---|---|
| 直接 `getElementById('audioPlayer')` 的文件 | **12 个**（player.js / audio-events.js / player-sync.js / player-controls.js / player/eq.js / player/fade.js / player/lyrics.js / player/mediaSession.js / player/resumeSeek.js / shortcuts.js / app.js×2 处） |
| `audio.*` 调用点 | **122 处** |
| `timeupdate` 监听 | audio-events.js:32（驱动进度+迷你+桌面歌词）、player.js:549（预取）——**两个** |
| `pause` 监听 | audio-events.js:99、fade.js:130、mediaSession.js:109——**三个，语义各不相同** |
| `playing` 监听 | audio-events.js:94（熔断归零）、:133（移除 buffering 类）、eq.js:309（建音频图）——**三个** |

已知事故（代码注释自述）：
- `audio-events.js:30-31`：「此前注册了两个 timeupdate，updateProgress 每帧跑两遍」
- `player.js:103-108`：pause 每次换歌都触发，导致顶栏被错写成「已暂停」，修法是加 `refreshPlayerState()` 只看 audio 真实状态——**这是对「事件所有权不清」的补偿，不是修复**
- `fade.js:5` 注释：「目标音量取淡入瞬间的 audio.volume」——因为 fade 不知道真正的用户音量（音量有 3 个主人：player.js:711/742、fade.js:99-120、shortcuts.js:134）

### 2.2 播放状态四个所有者、四个竞态序号

| 所有者 | 写什么 |
|---|---|
| `player.js:436` | `setState('currentPlaying'/'playIdx'/'playQueue')`（playSongByIdx/nextSong/prevSong） |
| `app.js:1027-1053` | `clearPlayQueue`/`removePqItem`/`removeCheckedFromQueue` 同一批键 |
| `player-sync.js:119-123` | `restorePlayQueueFromSaved` |
| `init.js:34-71` | 四个订阅自动持久化——**同一段代码抄四遍**（playQueue/playIdx/loopMode/isShuffled 各一份，只差键名） |

四个竞态序号，各守一条异步链，无统一原语：
- `player.js:193` `_lyricRequestId`（歌词）
- `player.js:212` `_loadSeq`（换 src + 进度恢复）
- `player.js:434` `_playRequestId`（取流 + 代理）
- `app.js:566` `_plModalPlayRequestId`（歌单弹层点播）

新增一条异步链就要新增一个序号——`playSongByIdx`（player.js:436-498）一个函数里就有 `_playRequestId` 与 `_loadSeq` 两个。

### 2.3 播放链路复用下载语义

`getDownloadUrlSmart`（下载专用取流+换源）被播放链路调用，**全仓 29 处**，四个播放入口全走它：
[player.js:465](src/renderer/js/player.js#L465)、[home.js:762](src/renderer/js/views/home.js#L762)、[search.js:793](src/renderer/js/views/search.js#L793)、[playlist/playback.js:33](src/renderer/js/views/playlist/playback.js#L33)。

播放不需要保存路径、不需要质量策略落库、不需要查重——但复用下载函数意味着这些语义全部跟着进来。`playSongByIdx` 内部还要自己判断 `hit.quality !== resolveQuality(...)` 弃用预取缓存（player.js:452）。

### 2.4 测试钉在源码文本上

`test/play-prefetch.test.js:9` 用 `readFileSync` 读 player.js 源码，正则断言 `reqId !== _playRequestId` 存在。**player.js 一重构（哪怕只是把 `_startPrefetch` 挪文件）这个测试立刻红，而行为没变。** 同类：11 个测试文件读 `commandPalette.js` 源码。

---

## 3. 目标架构

### 3.1 分层

```
┌─ 播放引擎（新增 · src/renderer/js/playback/）──────────────────┐
│                                                                │
│  engine.js         唯一 audio 元素所有者 + 播放状态机 + 事件总线 │
│   接口（唯一公开面，约 12 个方法）：                             │
│     loadTrack(song, {url, referer, quality}) → 进入 loading     │
│     play() / pause() / toggle() / stop()                        │
│     seek(sec) / seekBy(sec)                                     │
│     setVolume(v) / getVolume() / toggleMute()                   │
│     next() / prev() / playAt(idx)      ← 队列策略在引擎内        │
│     subscribe(fn) → unsubscribe    ← 唯一的状态订阅入口          │
│     getSnapshot() → {state, song, position, duration, volume}   │
│                                                                │
│  state machine      idle → loading → playing ⇄ paused → error   │
│                     （每次转移 broadcast，UI 只读不写）           │
│                                                                │
│  event bus          取代「各模块各挂各的 addEventListener」       │
│                     engine 内部只挂一份，按语义分发给订阅者        │
│                                                                │
├─ 能力挂载层（改为「注入引擎」或「订阅引擎」，不再摸 audio）─────────┤
│  queue.js       队列与切歌策略（顺序/随机/单曲/列表循环）          │
│  resolver.js    取流调用（resolveTrack —— 与下载共用的中性服务）   │
│  audioGraph.js  EQ + 淡入淡出 + 音量（挂在引擎建的那张图上）       │
│  lyricsSync.js  歌词同步（订阅 position，不自己挂 timeupdate）     │
│  progressMem.js 断点续播 + 进度记忆（订阅 position）              │
│  broadcast.js   媒体会话/托盘/迷你/桌面歌词（订阅 snapshot）       │
└──────────────────────┬─────────────────────────────────────────┘
                       │ 全部通过 engine.subscribe / engine.xxx
┌─ 消费层（UI，只读状态）─────────────────────────────────────────┐
│  播放卡片 · 进度条 · 歌词区 · 队列列表 · 命令面板 · 快捷键        │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 三个关键设计决策

**D1 · audio 元素所有权收归引擎，且只此一处。**

全仓 `document.getElementById('audioPlayer')` 只允许出现在 `engine.js`。其余 11 个文件改为：
- 需要**驱动**播放的 → 调 `engine.play()/seek()/setVolume()`
- 需要**响应**播放的 → `engine.subscribe(snapshot => ...)`
- 需要音频图的（EQ/fade）→ 由引擎在建图时把节点交出去（`engine.getAudioGraph()`），而不是自己 `createMediaElementSource`

这一条直接消灭 2.1 节全部已知事故：timeupdate 只有引擎挂一份；pause 只有引擎分发给订阅者且语义明确（「用户暂停」vs「换歌导致的中断」由状态机区分）；音量只有引擎一个主人，fade 改为「请求引擎做淡出」而不是自己改 `audio.volume`。

**D2 · 播放状态显式化，UI 从「写状态」变「读状态」。**

现在是「audio.paused + state.currentPlaying + 一堆 window 函数互相猜」。目标是一个显式状态机：

```
        loadTrack()          play()              pause()
  idle ───────────► loading ───────► playing ◄────────► paused
   ▲                   │                 │                  │
   │                error()           ended()               │
   │                   ▼                 ▼                  │
   └──────────────── error ◄─────── (ended 后由队列策略决定)
                              stop()
```

每次转移 `broadcast(snapshot)`。所有 UI（播放卡片、托盘、迷你播放器、桌面歌词、任务栏进度）**订阅同一个 snapshot**，不再各写一份同步函数——这同时消掉 `player-sync.js` 里「两份半窗口同步」和托盘「第三份同步逻辑」。

**D3 · 取流服务中性化，播放与下载各自做副作用。**

新增 `resolveTrack(song, quality)` 作为**中性取流用例**（下载与播放共用）：
- 播放侧副作用：换源通知、`_altSource` 记忆、预取缓存
- 下载侧副作用：保存路径、查重、质量策略落库、历史

`getDownloadUrlSmart` 保留为下载门面（内部转调 resolveTrack），播放链路停止调用它。29 处引用中，4 个播放入口改走 `resolver.js`，其余 25 处是下载域不受影响。

### 3.3 明确不进引擎的东西

| 不进引擎 | 理由 |
|---|---|
| HTML/DOM 渲染 | 引擎零 DOM 依赖（audio 元素由外部注入），这样才能在 node:test 里跑 |
| 歌词时间轴解析 | 纯数据变换，已有 `krcCodec.js`，订阅 position 即可 |
| 窗口创建/生命周期 | Electron 主进程职责 |
| 队列持久化 | 已有 `save-play-queue`/`load-play-queue` 通道，引擎只负责内存队列策略 |

**引擎零 DOM 依赖（除注入的 audio 元素）是硬约束**——它决定了引擎能不能被单测。

---

## 4. 接口草案（不写实现，先对齐形状）

```js
// src/renderer/js/playback/engine.js
export function createPlaybackEngine({
  audio,            // 注入的 HTMLAudioElement（唯一一处 getElementById 的结果）
  resolveTrack,     // 注入：中性取流用例 (song, quality) => Promise<TrackResult>
  proxyPlay,        // 注入：流式代理注册 (url, referer, refresh) => Promise<{fileUrl}>
  saveProgress,     // 注入：进度记忆 (song, sec) => void
  loadProgress,     // 注入：(song) => Promise<sec>
  logger,
}) {
  // 状态机 + 事件总线 + 队列 + 音频图装配
  return {
    // ── 驱动 ──
    loadTrack(song), play(), pause(), toggle(), stop(),
    seek(sec), seekBy(delta),
    setVolume(v), getVolume(), toggleMute(),
    setRate(r), getRate(),
    // ── 队列 ──
    setQueue(songs, startIdx), playAt(idx), next(), prev(),
    setMode(mode),            // 'order' | 'shuffle' | 'single' | 'list-loop'
    // ── 观察 ──
    subscribe(fn),            // => unsubscribe；fn(snapshot)
    getSnapshot(),            // => { state, song, position, duration, volume, rate, mode, queueIdx }
    // ── 音频图（EQ/fade 用，引擎建图后交出节点）──
    getAudioGraph(),          // => { ctx, source, preamp, filters, analyser, destination } | null
  };
}
```

**Snapshot 形状**（所有 UI 的唯一数据源）：

```js
{
  state: 'idle'|'loading'|'playing'|'paused'|'error',
  song: Song|null,
  error: { code, message }|null,
  position: number,      // 秒
  duration: number,      // 秒，NaN 表示未知
  volume: number,        // 0..1
  muted: boolean,
  rate: number,
  mode: string,
  queueIdx: number,
  queueLength: number,
}
```

**错误码**（换源/重试决策的依据，从既有 `fallbackCodes.js` 与 `playError.js` 收敛，不新造）：
`ABORTED` / `NETWORK` / `NO_AUDIO` / `VIP_REQUIRED` / `LOGIN_REQUIRED` / `SOURCE_UNAVAILABLE` / `DECODE_ERROR`

---

## 5. 迁移路径（5 阶段，每阶段独立可验收、可回滚）

> 方法论与 platform-plugin-v3 完全一致：**先建边界，再迁实现；先加守卫，再改调用方；每阶段 git diff --stat 自证「只改了预期文件」。**

### 阶段 0 · 基线与守卫（不改行为）

**实现状态（2026-10-19，S1 完成）**：
- 基线落盘 `.preview/playback-baseline.json`（schema `playback-baseline/1`，64KB），含三项 + `testBaseline` / `lintBaseline` / `workingTreeAtCollection`。
- `test/playback-engine.test.js`（322 行）20 条接口契约用例，**20/20 红且全部 `ERR_MODULE_NOT_FOUND`**——红在「引擎接口不存在」，证明测的是新接口而非旧实现镜像。
- 全量基线实测 **3307/3307 绿**（任务书预期 3300，实际 3307，已在 JSON 注明）；加入骨架后 3327 tests / 3307 pass / 20 fail，新增红全部来自本骨架。既有 2 个偶发超时单独复核通过（backup-eq-channel 4/4、export-scrub 5/5）。

**S1 取得的关键数据（直接影响后续阶段）**：

| 发现 | 数据 | 用途 |
|---|---|---|
| window 挂载收窄空间 | player.js 46 个挂载中，**20 个被 HTML 内联事件直接调用（必须保留）**、4 个仅被其它模块经 window 读、**22 个零消费点（删除候选）** | 阶段 4 的逐条对账单已在基线 JSON 里（`bridgeVerdict` 字段），收窄目标从「~282 降到最小集」精确为「播放域 46 → 20+4」 |
| 播放/下载共用取流面 | `get-download-url-smart` 与 `proxy-play` 各 5 个渲染层消费点（player.js / app.js / views/home.js / views/search.js / views/playlist/playback.js） | 阶段 2 的 `resolver.js` 只需改这 10 处，蓝图 2.3 的 29 处引用中其余 19 处属下载域不动 |
| 播放测试构成 | 93 个播放相关测试：**interface 34 / source-text 59** | source-text 类（读 `readFileSync` 的）是阶段 4 的迁移删除对象，清单已附证据 |
| 托盘/桌面歌词通道 | `tray-update-play-state` / `tray-next` / `tray-prev` / `tray-toggle-play` / `desktop-lyric-update` 在**渲染层无直接消费者**（主进程侧消费） | 阶段 3-9 迁移 player-sync.js 时需保留这些 send 通道，不得误删 |

⚠️ **基线文件的可复现性决策**：`.preview/` 被 `.gitignore:55` 忽略（既有规则，注释「本地验证与重构前备份」），因此该 JSON **不进版本库、不可复现**。据此确立两条纪律（沿用 platform-plugin-v3 §6-4 的同款决策）：
1. 阶段 4 的守卫测试**必须把关键冻结值内联进测试文件**，不得在 `npm test` 里读 `.preview/`；
2. `.preview/playback-baseline.json` 仅作开发期人工查账用，任何「派生结果 == 基线」的断言都要有测试内联的副本。

### 阶段 1 · 引擎核心（最小可播）

1. 新建 `src/renderer/js/playback/engine.js`：状态机 + 事件总线 + audio 注入 + `loadTrack/play/pause/seek/setVolume/subscribe/getSnapshot`。
2. **只接一条最小链路**：本地文件播放（`loadTrack` 直接给 url，不经过取流/代理）。
3. 音频图（EQ）在引擎内装配，`getAudioGraph()` 交出节点——`player/eq.js` 改为从引擎拿图，不再自己 `createMediaElementSource`。

**S1 对阶段 1 的输入修正**：
- 接口以 `test/playback-engine.test.js` 的 20 条契约为准（蓝图第 4 节的具象化）；如实现时发现契约有误，**改契约要先改测试并说明理由**，不得默默放宽断言。
- `getAudioGraph()` 的契约已被测试钉为「无图时返回 null」——这与 R2 的降级路径一致：若音频图与 `stream://` 冲突，引擎返回 null 即可让测试保持绿，EQ 独立保留。
- 工作区在 S1 接手前已有 23 个 M 文件（历史改动，含 `ipcContract.js` / `playlistAudit` / `songStory` / `tasteProfile` / `player.css`），清单已存于基线 JSON 的 `workingTreeAtCollection`。**做 `git diff --stat` 时以那份清单为分母**，避免把历史改动误计入本阶段。

**验收**：
- 引擎接口测试全绿（node:test，无 DOM 依赖，除注入的 fake audio 元素）
- 本地文件播放行为与改动前逐字节一致（用一个 fake audio 元素驱动，断言状态转移序列）
- `git diff --stat` 证明只新增 `playback/engine.js` + 测试，**未改任何现有文件**
- ⚠️ 本阶段引擎**尚未接入生产链路**——它是「旁路建好的缝」

**实现状态（2026-10-19，S2 + S2b 完成，主控接管交付）**：

> 背景：成员 engine-builder 两次命中 `QUOTA_EXCEEDED`（`step-5-preview` 全部账号限流至 2026-10-20 10:26），用户批准主控接管。

- 产物 `src/renderer/js/playback/engine.js`（约 470 行，ESM，**零 import、零 DOM 依赖**）
- 公开面 20 个方法全齐：驱动 12（loadTrack/play/pause/toggle/stop/seek/seekBy/setVolume/getVolume/toggleMute/setRate/getRate）+ 队列 5（setQueue/playAt/next/prev/setMode）+ 观察 3（subscribe/getSnapshot/getAudioGraph）
- 状态机五态全转移（idle/loading/playing/paused/error），同态去重防事件风暴
- 队列四模式：`order` 与 `list-loop` 均回绕（与既有 `nextPrefetchIdx` 语义一致）、`single` 停自己、`shuffle` 不重复自己
- **音频图幂等装配**：`source → preamp → 5×Biquad → analyser → destination`，与 eq.js:141-184 链序一致；幂等由 `audioGraph` / `audioGraphAttempted` 显式标志负责，**不靠 try/catch 吞 InvalidStateError**
- 三处按现状取证做的设计决策：
  1. 换 `src` 期间用 `suppressAudioEvents` 抑制音频事件——浏览器赋新 src 必先触发 pause，不抑制会把换歌误判成「用户暂停」（player.js:103-108 记录的旧事故）
  2. `paused` 只在 `state === 'playing'` 时进入——同上的语义消歧
  3. `timeupdate` 全模块只挂一份——旧代码 audio-events.js 与 player.js 各挂一个，导致 updateProgress 每帧跑两遍
- 测试：`test/playback-engine.test.js` **21/21 全绿**（20 条原契约 + 1 条音频图幂等契约，后者用假 AudioContext 工厂断言「工厂只调一次、createMediaElementSource 只调一次」）
- 全量回归：**3327/3327 通过，0 失败**（S1 基线 3307 绿 + 21 条新契约；实测基线比任务书预估的 3300 多 7 条）
- `npm run lint` exit 0；`git diff --stat` 为空（**零 tracked 文件改动**，生产链路一行未动）

**阶段 1 的延期项（重要）**：original S3（eq.js 改为消费引擎音频图）**延期到阶段 3**，不是放弃。理由：eq.js 要「向引擎要图」，前提是生产里存在一个引擎实例提供 `getAudioGraph()`；而 Sprint 1 的硬约束是「引擎旁路建设、零用户可见行为变化」。强行现在就做只有两种结果——要么 EQ 立刻失效（无人提供图），要么被迫在 app.js 创建引擎（那是阶段 3 的活）。阶段 3 与「app.js 创建引擎 + 注册 graph provider」同批完成，届时只需接线。



1. `queue.js`：把 `nextSong/prevSong/playSongByIdx/cyclePlayMode/toggleShuffle/toggleLoop` 的队列决策逻辑迁入引擎（纯策略，可单测）。
2. `resolver.js`：包装 `resolveTrack` + `proxyPlay` + 预取，**四个竞态序号收敛为一个**（引擎内部的请求代次）。
3. 预取逻辑（`playPrefetch.js` + `player.js:507-547`）改为引擎内部能力。

**验收**：
- 新增队列策略单测：顺序/随机/单曲/列表循环四种模式的 next/prev 索引正确性（现在这些逻辑散在 player.js:388-428，只能静态断言）
- 「快速连切 5 首」用例：断言只有最后一次取流的结果被采用，且**只有引擎内部一个代次变量**（删掉 `_playRequestId`/`_loadSeq`/`_lyricRequestId` 三个）
- `getDownloadUrlSmart` 在播放链路的 4 处引用清零（静态守卫）

### 阶段 3 · 11 个调用方改为调引擎/订阅引擎（一处一改）

按风险从低到高，每改一处立即跑全量测试 + `smoke:asar`：

| 序 | 文件 | 改为 | 风险 |
|---|---|---|---|
| 1 | `player/eq.js` | `engine.getAudioGraph()` 取图 | 低（图已在阶段 1 建好） |
| 2 | `player/fade.js` | 调 `engine.fadeOut()/fadeIn()`（引擎提供，内部管 volume） | 低 |
| 3 | `player/mediaSession.js` | 订阅 snapshot | 低 |
| 4 | `player/lyrics.js` | 订阅 position（去掉自己的 `getElementById('audio')`） | 中 |
| 5 | `player/resumeSeek.js` | 订阅 `loadedmetadata` 语义事件 | 中 |
| 6 | `player-controls.js` | 调 `engine.seekBy/toggle` | 低 |
| 7 | `shortcuts.js` | 调 `engine.setVolume/toggleMute` | 低 |
| 8 | `audio-events.js` | **删除**（事件绑定全部收归引擎） | 中 |
| 9 | `player-sync.js` | 三个 syncTo* 改为订阅 snapshot 的统一 broadcast | 中 |
| 10 | `player.js` | 拆解：驱动类调引擎、UI 类订阅 snapshot、EQ 簇 re-export 保留 | **高** |
| 11 | `app.js` | `_audio` 引用与两处 pause 改为引擎调用 | 中 |

**验收（每个文件）**：
- `git diff --stat` 只含预期文件
- 全量 `npm test` 无新增红（允许阶段 0 记录的既有 2 个偶发超时）
- `npm run smoke:asar` 的 window 公开面断言同步更新（**每次改渲染层必须先重新 package 再跑 smoke**——REFACTOR_PLAN 记载过「旧 asar 给旧结论」的坑）
- 无头验证台（如有播放器截图脚本）通过

### 阶段 4 · 收敛与守卫（这一步才让重构成立）

1. **window 桥收窄**：HTML onclick 仍然需要 window 桥（这部分保留），但模块间通信全部走 import/引擎。`player.js:1024-1069` 的 46 个挂载中，只有「HTML 真在调的」保留，其余删除——用 `check-window-bridge.mjs` 逐条对账。
2. **不得新增 window 挂载守卫**：仿照 `platform-contract.test.js` 的「无硬编码守卫」，新增「渲染层新代码不得新增 window.* 挂载」的静态守卫（白名单豁免 HTML 确需的）。
3. **播放状态所有权守卫**：断言 `state.currentPlaying/playIdx/playQueue` 的写者只有引擎（静态扫描 setState 调用点）。
4. **旧源码测试处置**：`test/play-prefetch.test.js` 等读 player.js 源码的测试，迁移为引擎接口测试后删除（这是「新接口测试先行，旧源码测试最后处理」的收尾）。
5. 文档同步：`OVERVIEW.md` 第八节技术债表更新（audio 无主/竞态序号泛滥两条标记已闭合）；新增 `docs/architecture/PLAYBACK-ENGINE.md`。

**验收**：
- 引擎接口测试 ≥ 40 例（状态机全转移、队列四模式、竞态单代次、音量单主人、音频图装配）
- window 挂载数从 ~282 降到「HTML 实际需要的最小集」
- `npm run verify` 全绿（lint + test + dead-deps + attack-surface + icons + build + asar smoke）
- 用户可见行为零变化（播放/暂停/seek/切歌/队列/歌词/桌面歌词/迷你播放器/托盘）

---

## 6. 第一批任务（Sprint 1，可直接派工）

| # | 任务 | 产出 | 验收 |
|---|---|---|---|
| S1 | 冻结播放基线 + 建引擎接口测试骨架 | `.preview/playback-baseline.json` + `test/playback-engine.test.js`（红） | 基线含 window 公开面/IPC/测试三项；测试红且红在接口不存在 |
| S2 | 引擎核心：状态机 + 总线 + loadTrack/play/pause/seek/volume/subscribe | `src/renderer/js/playback/engine.js` | S1 的接口测试转绿；零现有文件改动 |
| S3 | 音频图收归引擎 + eq.js 改为取图 | engine 内建图 + `player/eq.js` 改造 | EQ 行为不变（`test/eq-behaviour.test.js` 等 35 例仍绿） |

S2 完成时，「缝是真的」就得到了证明——**那是决定阶段 3 是否按计划全量迁移的决策点。**

---

## 7. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **引擎接口设计有误，阶段 3 全量迁移时返工** | 🔴 高 | 阶段 1-2 旁路验证 + S3 小范围实测后再迁 11 个文件；Sprint 1 结束设决策门 |
| R2 | **`createMediaElementSource` 与 stream:// 代理播放冲突** | 🟢 **已消除（静态定论）** | **实测结论（2026-10-19 主控核实）**：`eq.js:141-184 ensureEqGraph()` 已经对同一个 `audioPlayer` 元素调用 `createMediaElementSource` 并接到 `destination`，而 `audio.src` 全程是 `proxyPlay` 返回的 `stream://` 地址——**两者在生产代码里已共存**，R2 不存在。**但换来一条更硬的约束**：`createMediaElementSource` 对同一元素**只能调用一次**，第二次抛 `InvalidStateError`，而 `ensureEqGraph` 的 `try/catch`（`:177-183`）会把它**静默吞掉并返回 false**——表现为「EQ 无声失效且无任何报错」。因此引擎接管音频图时，`eq.js` 必须**彻底停止调用**，全仓只留引擎一处 |
| R3 | 渲染层 tree-shake 导致引擎/挂载断链 | 🟡 中 | 每阶段跑 `smoke:asar` 公开面断言，且**必须先重新 package**（REFACTOR_PLAN 记载：旧 asar 会给旧结论，曾导致误判「守卫没生效」） |
| R4 | 偶发测试超时被误判为回归 | 🟢 低 | 阶段 0 记录的 2 个既有偶发超时（backup-eq-channel / export-scrub）单独跑复核，不计入新增红 |
| R5 | 「用户可见行为零变化」无法客观证明 | 🟡 中 | 用 fake audio 元素驱动引擎，把「播放/切歌/seek」的状态转移序列固化为快照断言；无头验证台补充截图级验证 |

---

## 8. 明确不做（YAGNI）

- ❌ **不做框架迁移**（React/Vue）：引擎与框架无关，且 platform-plugin-v3 §9 已论证不做运行时插件；引擎是纯 ESM，将来若要迁移框架，引擎是**最容易被复用的那一层**。
- ❌ **不重写主进程**：主进程 api 层通过 deletion test（registry/gateway/service/atomicFile/approvedDirs 全部深），播放引擎只解决渲染层。
- ❌ **不改平台协议**：8 个平台的实现一行不动。
- ❌ **不做「去 window 化」运动**：HTML onclick 需要 window 桥，这部分保留并有守卫；只消灭「模块间通信走 window」那一类。
- ❌ **不动下载引擎**：`downloadQueue.js` 是深模块，只有 `getDownloadUrlSmart` 门面内部转调 resolveTrack 时顺带接触。

---

## 9. 与其它重构线的关系

| 线 | 关系 |
|---|---|
| 主进程零 service 层（走查 Top 2） | **不在本蓝图内**，但引擎的 `resolver.js` 会依赖中性的 `resolveTrack`——若届时主进程侧仍无 service，`resolveTrack` 先以 `src/api/services/resolveTrackService.js` 的扩展形态存在（它已经在了） |
| app.js 拆分（走查 Top 3） | 引擎就位后，app.js 的播放队列 UI（约 300 行）随阶段 3-10 一并拆出；**不单独发起** |
| 转义 5 份（走查 Top 5） | 与引擎无关，可随时单独修（删 4 份、统一 import escapeFallback + 加「不得新增第 N 份」守卫）。**建议插入 Sprint 间隙，不占引擎关键路径** |
| 命令面板 11 个读源码测试 | 引擎就位后，命令面板的播放类命令改调引擎，届时可给命令面板造「注册表接口」，那 11 个测试才有迁移目标 |

**排序原则：引擎 → 借引擎收敛播放相关 → 其它 Top 级摩擦各自单独立项。** 走查的结论在此复用：「修 Top 1 之前，修 Top 2-5 都会复发」——但直接修 Top 1（282 挂载）风险过高，引擎是 Top 1 的**可验证子集**。

---

## 10. 决策记录（待拍板）

| # | 问题 | 建议 | 状态 |
|---|---|---|---|
| 1 | 阶段 3 是否全量迁移 11 个文件 | **有实证支持按计划迁移**：引擎接口 21 条契约全绿、全量 3327 回归零红、生产文件零改动；Sprint 1 的决策门已通过 | 建议批准（待用户确认） |
| 2 | 音频图是否进引擎（R2） | **已决：进**。R2 已静态消除（createMediaElementSource 与 stream:// 生产里早已共存）；引擎已实现幂等建图（21/21），阶段 3 只需接线 | 已定 |
| 3 | `resolveTrack` 放渲染层还是主进程 | 先扩展既有 `src/api/services/resolveTrackService.js`（渲染层经 IPC 调），主进程 service 层另立项 | 待定 |
| 4 | 下载功能的产品定位 | 保留全部现有能力，UI 主次关系调整（播放优先）——**纯产品决策，不影响引擎** | 待用户拍板 |
| 5 | 旧源码测试（play-prefetch 等）删除时机 | 阶段 4，接口测试覆盖后删 | 已定（用户已选「新接口测试先行，旧源码测试最后处理」） |
| 6 | eq.js 改造（原 t3）何时做 | **延期到阶段 3**：前提是引擎已接入生产并提供 graph provider，否则 EQ 会立刻失效 | 已定（2026-10-19） |
| 7 | 独立审查（t4）何时做 | 成员配额 2026-10-20 10:26 恢复后由 reviewer 执行；**不接受主控自审替代**（权责分离） | 已定（2026-10-19） |
