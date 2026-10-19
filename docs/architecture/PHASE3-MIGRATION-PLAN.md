# 阶段 3 施工计划：11 个调用方迁移到播放引擎

> 状态：**待批准** ｜ 日期：2026-10-19 ｜ 前置：Sprint 1 已完成（commit `f1ce3a9`）
> 依据：`docs/architecture/PLAYBACK-ENGINE.md` 第 5 节阶段 3、第 7 节风险登记
> 本文只定**边界与顺序**，不含实现。批准后按 P0→P5 逐批执行。

---

## 0. 已就位的资产（Sprint 1 交付）

| 资产 | 状态 |
|---|---|
| `src/renderer/js/playback/engine.js`（591 行） | 状态机 + 事件总线 + 20 方法公开面 + 幂等音频图，零 DOM 依赖 |
| `test/playback-engine.test.js` | 21 条接口契约全绿 |
| 全量回归 | 3328/3328 绿，0 fail |
| 生产文件 | **零改动**（引擎仍是旁路） |
| git 回滚点 | `f1ce3a9` |
| git 钩子 | 已安装（`core.hooksPath=hooks`），此前从未生效 |

---

## 1. 迁移的硬约束（违反即回滚）

1. **每个 PR 只迁一个文件**，`git diff --stat` 必须只含预期文件。
2. **每迁一个文件，全量 `npm test` 不得新增红**。基线 3328 绿；Sprint 1 记录的两个既有偶发超时（backup-eq-channel / export-scrub）单独跑复核，不计入新增红。
3. **`smoke:asar` 的 window 公开面断言必须同步更新**，且**每次改渲染层必须先重新 `package` 再跑 smoke**——REFACTOR_PLAN 记载过「旧 asar 给旧结论」的坑，曾导致误判「守卫没生效」。
4. **用户可见行为零变化**：播放/暂停/seek/切歌/队列/歌词/桌面歌词/迷你播放器/托盘全部照旧。
5. **不得新增 window 挂载**（除非 HTML 内联事件确实需要，且要在基线 JSON 里登记理由）。

---

## 2. 迁移顺序（按风险从低到高）

顺序不是按文件大小排的，是按**「改错了会不会立刻被测试抓住」**排的。

### P0 · 建立引擎实例（唯一必须先做的一步）

**改哪**：`src/renderer/js/app.js`（仅在 `init()` 里新增约 20 行）
**做什么**：在 `_audio = document.getElementById('audioPlayer')` 之后创建引擎实例并暴露给需要它的模块。

```js
// app.js:214-219 附近
_audio = document.getElementById('audioPlayer');
playbackEngine = createPlaybackEngine({
  audio: _audio,
  resolveTrack: (song, quality) => api.getDownloadUrlSmart(song, quality),
  proxyPlay: (url, referer, refresh) => api.proxyPlay(url, referer, refresh),
  saveProgress: (song, sec) => api.setPref('playProgressMap', ...), // 复用既有进度记忆
  loadProgress: (song) => api.getPref('playProgressMap').then(...),
  logger,
});
```

**验收**：
- 引擎实例创建成功，`getSnapshot()` 返回 `state: 'idle'`
- **现有播放行为完全不变**（引擎此刻只被创建，还没有任何消费者）
- 全量测试绿

**风险**：低。这是纯新增，不改任何既有调用。

---

### P1 · 音频图接管（解锁 Sprint 1 延期的 t3）

**改哪**：`src/renderer/js/player/eq.js`
**做什么**：`ensureEqGraph()` 的建图部分改为向引擎要图；保留 `_gains` / 预设 / bypass / 持久化四块业务逻辑。

**为什么必须先做**：这是 Sprint 1 唯一延期项。做完它，`createMediaElementSource` 全仓才真正唯一。

**关键约束**：
- eq.js 不再出现 `createMediaElementSource` / `createGain` / `createBiquadFilter`
- `test/eq-behaviour.test.js` 的守卫期望值收紧为**只剩 engine.js 一处**
- EQ 行为零变化：`test/eq-behaviour.test.js`(13) / `eq-preset-highlight` / `eq-clip-guard` / `eq-reset` 全绿

**风险**：中。EQ 是用户可感知功能，改错了会「静默无声」。缓解：先跑 EQ 全套测试，再手动验证一次「切预设听得出变化」。

---

### P2 · 媒体会话与频谱（只读消费者）

**改哪**：`player/mediaSession.js`、`player/visualizer.js`
**做什么**：改为 `engine.subscribe(snapshot => ...)` + `engine.getAudioGraph().analyser`。

**为什么排这么前**：它们**只读**播放状态，不改播放行为——改错了最多是「锁屏不显示曲目」，不会让播放坏掉。

**风险**：低。

---

### P3 · 窗口同步收敛（消掉「两份半」）

**改哪**：`player-sync.js`
**做什么**：三个 `syncTo*` 改为订阅引擎 snapshot 的统一广播；`_mpLastSongKey` / `_dlLastLyricSongId` 两份「换曲才推整份」的重复优化收敛为一份。

**为什么值得做**：这是架构诊断里的摩擦点 3——同一概念两份实现，各自维护一个模块级 `let _lastSongKey`。

**风险**：中。托盘/迷你播放器/桌面歌词三个窗口的同步一旦错位，用户会看到「窗口显示上一首」。

**验收**：开三个窗口，切歌 10 次，三处显示一致；快速连切 5 次不串台。

---

### P4 · 播放驱动与歌词（核心链路）

**改哪**：`player-controls.js`、`shortcuts.js`、`player/lyrics.js`、`player/resumeSeek.js`
**做什么**：
- `player-controls.js` → `engine.seekBy()` / `engine.toggle()`
- `shortcuts.js` → `engine.setVolume()` / `engine.toggleMute()`
- `lyrics.js` → 订阅 position，去掉自己的 `getElementById('audio')`
- `resumeSeek.js` → 订阅 `loadedmetadata` 语义事件

**风险**：**中高**。这是用户最常触达的路径。每个文件单独提交。

**验收**：手动跑一遍完整播放流程（播放/暂停/拖进度/切歌/快捷键调音量/歌词跟随/断点续播）。

---

### P5 · 删掉重复的事件绑定层（收口）

**改哪**：`audio-events.js`（**删除**）、`player.js`（拆解）
**做什么**：
- `audio-events.js` 的 11 个事件监听全部收归引擎 → 文件删除
- `player.js`：驱动类调引擎、UI 类订阅 snapshot、EQ 簇 re-export 保留
- 四个竞态序号（`_lyricRequestId` / `_loadSeq` / `_playRequestId` / `_plModalPlayRequestId`）收敛为引擎内部的请求代次

**为什么最后做**：`player.js` 是 897 行的核心，动它风险最高。前面 P1-P4 已经把周边清干净，此时它才适合动。

**风险**：**高**。必须单独一个 PR，且必须有无头验证台兜底。

---

## 3. 不做的事（YAGNI）

| 不做 | 理由 |
|---|---|
| 改 `app.js` 的歌单弹层（450 行） | 与播放引擎无关，属走查 Top 3 的另一条线 |
| 去 window 化（597 处） | HTML onclick 需要它；只消灭「模块间通信走 window」那一类 |
| 改主进程 | 主进程 api 层通过 deletion test，本轮只动渲染层 |
| 改平台协议 | 8 个平台实现一行不动 |
| 删旧源码测试 | 阶段 4 的事（用户已定「新接口测试先行，旧源码测试最后处理」） |

---

## 4. 每批的验收闸门

每批完成后必须全部通过才算完成：

```
node --test "test/*.test.js"     →  3328+ 绿，0 新增红
npm run lint                      →  exit 0
git diff --stat                   →  只含本批预期文件
```

P1 / P3 / P4 额外需要：
```
npm run package && npm run smoke:asar   →  window 公开面断言通过（必须先重新 package）
```

---

## 5. 回滚策略

每批一个 commit，独立可回滚：

```bash
git revert <该批 commit>     # 只回退这一批，不影响其它
```

回滚点 `f1ce3a9` 是 Sprint 1 的完整状态，任何时候可回到「引擎就位但未接入」。

---

## 6. 待你拍板

| # | 问题 | 建议 |
|---|---|---|
| 1 | 是否按 P0→P5 全做，还是先做 P0-P2（引擎接入 + 音频图 + 只读消费者）看效果 | **先 P0-P2**：风险最低、能立刻解锁 Sprint 1 的 t3、且能验证「引擎接入生产」这条路走不走得通 |
| 2 | P5（删 audio-events.js + 拆 player.js）要不要拆成两个 PR | **拆**：删文件与改 897 行核心是两件事，混在一起无法定位回归 |
| 3 | 每批完成后是否要等 reviewer 审查再进下一批 | **建议等**：但 reviewer 配额 2026-10-20 10:26 才恢复，可先做 P0-P2 并累积待审 |
