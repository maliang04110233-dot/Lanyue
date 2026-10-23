# P0 · 交叉淡入淡出（Crossfade）设计与实现记录

> 状态：**基础设施已落地**（编排层 + 实例池 + 引擎多实例支持），**接线待前置条件满足**
> 依据：对 4 个 GitHub 项目（lx-music-desktop / pear-desktop / spotube / YesPlayMusic）
> 源码的研读，以及 Lanyue v1.0.35 实际代码的核实。
> 本文档区分「已实现」与「待接线」——**不要把待接线当成已完成**。
> ⚠️ 关键前置条件见第 3.0 节：**引擎尚未接入生产播放路径**，现在接线不会生效。

---

## 一、先纠正一个前提错误

初版方案把 crossfade 列为「队列切歌有断音缺口」。读完 `src/renderer/js/player/fade.js`
后，**这个前提是错的**：Lanyue 已有完整的单实例淡入淡出。

- 档位 `FADE_STEPS = [0, 500, 1000, 2000]`
- 淡入：新曲起播 / 暂停恢复（`shouldFadeIn`）
- 淡出：**缓停**——音量降到 0 才真 `pause()`，收尾前还原滑条音量
  （否则下次淡入取到 0，永久静音）
- 三处暂停入口接线：切歌暂停、睡眠到点、媒体键 stop
- 纯函数导出，`test/player-fade.test.js` 有 6 个用例 + 接线钉

**真正的缺口是「无缝」**，不是「淡入淡出」：

| | 现有 fade.js | crossfade 目标 |
|---|---|---|
| 实例数 | 1 个 `<audio>` | 2 个，交替使用 |
| 时间轴 | 淡出(1s) → **静默间隙** → 淡入(1s) | 淡出与淡入**重叠** |
| 听感 | 歌曲间有 1-2 秒空白 | 无缝连播 |
| 内存 | 1 份 | 2 份 |

---

## 二、已实现的部分

### 2.1 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/renderer/js/playback/eqBands.js` | 新建 | EQ 五段频段的**唯一事实来源**（零 DOM 依赖） |
| `src/renderer/js/playback/audioPool.js` | 新建 | 双实例池 + 按元素缓存的音频图 |
| `src/renderer/js/playback/crossfade.js` | 新建 | 编排层（零 DOM 依赖，纯逻辑） |
| `src/renderer/js/playback/engine.js` | 改造 | 支持 `audioPool` / 多实例 / `setInstanceGain`；旧签名兼容 |
| `src/renderer/js/player/eq.js` | 改造 | 从 `eqBands.js` 引入，不再内联复制 |
| `test/playback-crossfade.test.js` | 新建 | 28 个用例（纯函数 + 接线钉） |

### 2.2 关键设计决策

**① EQ_BANDS 收敛为单一事实来源**

原 `engine.js` 内联复制了一份，注释写着「必须与 eq.js 逐字一致，靠守卫测试盯」。
crossfade 引入了第三个使用方，复制会变三份。正解是把纯数据抽到零依赖模块，
三方都 import —— 漂移从「靠测试盯」变成「结构上不可能」。

频段数值一字未改（改它等于改 EQ 曲线手感）。

**② 图按元素缓存，不按实例 id**

`createMediaElementSource` 对同一元素**只能调用一次**，第二次抛
`InvalidStateError`。旧 `eq.js` 用 try/catch 吞掉，表现为「EQ 明明开了却没效果，
控制台一行报错都没有」（`engine.js:502-506` 记录的事故）。

`audioPool.js` 用 `WeakMap` 做「元素 → 图」映射 + `WeakSet` 做失败幂等标志，
**绝不靠 try/catch 兜幂等** —— try/catch 只负责把真实失败变成「可观察的 null + 日志」。

**③ 音量单主人铁律（engine.js 铁律 3）**

engine.js 铁律 3：「音量与倍速只有引擎一个主人」。crossfade 若直接写
`audio.volume`，就出现第二个音量主人。

解法：**实际音量 = 用户音量 × 实例交叉增益**。

```js
function applyVolumeTo(instanceId) {
  const g = instanceGains.get(instanceId) ?? 1;
  el.volume = clampVolume(volume * g);   // ← 唯一的 audio.volume 写点
}
```

交叉层只调 `setInstanceGain(id, g)`，引擎仍是唯一写手。

**④ Media Session 在交叉点切换**

交叉点 = `min(fadeOutMs, fadeInMs) / 2`。理由：两段斜坡**同时开始**，
短的那段先走完；交叉点必须落在**两段都还在进行**的窗口内，否则那不是交叉，
是「淡出 + 延时淡入」。

过早切换会让系统媒体键显示错的歌。

**⑤ 零 DOM 依赖**

`crossfade.js` 与 `audioPool.js` 都不出现 `document`，音频元素与时间源全部注入。
这让它们能在 `node:test` 里被直接单测（28 个用例全绿）。

### 2.3 验收结果

- `test/playback-crossfade.test.js`：**28/28 通过**
- 播放相关既有测试：**164/164 通过**
- 全量测试：**3359/3359 通过**（零回归）

3 个既有守卫测试的宿主从 `engine.js` 改为 `audioPool.js`（建图点下沉），
不变量完全保留：
- `eq-behaviour.test.js`：音频图创建点全仓唯一 → 仍唯一，只是路径变了
- `eq-clip-guard.test.js`：preamp 在链首、analyser 在链尾 → 仍成立
- `visualizer.test.js`：analyser 串入图尾 → 仍成立

### 2.4 streamProtocol.js 并发 Range 结论

**已核实：无需改动。**

`src/main/streamRegistry.js` 按 key 存条目，`resolveStream` 逐请求查表；
`streamProtocol.js:289` 的 `protocol.handle` 每次都独立解析 Range
（`:117-138` `normalizeRangeHeader` → 转发），**登记簿里不缓存 Range 状态**。
两个 `<audio>` 实例各拉各的 Range 请求，天然隔离。

唯一注意项：`MAX_ENTRIES = 20`（`streamRegistry.js:23`）。预载下一首会多登记一条，
20 条上限对「当前 + 下一首」的用法仍宽裕，但若后续加「预载队列」需重新评估。

---

## 三、待接线的部分（未完成）

### 3.0 ⚠️ 前置条件未满足 —— 现在接线不会生效

**`docs/architecture/PLAYBACK-ENGINE.md` 明确记载：引擎是「旁路建好的缝」，
尚未接入生产链路，阶段 3 才迁移 11 个调用方。**

实测确认（2026-10-21）：

- `src/renderer/js/player.js` 的 `loadAndPlay()`（`:214`）直接写模块级 `audio.src`
  与 `audio.play()`，**完全不走引擎**
- 引擎实例在 `app.js:246` 被创建并挂到 `window.__playbackEngine`，
  但只有 `eq.js` / `mediaSession.js` / `lyrics.js` / `immersive.js` / `shortcuts.js`
  / `player-controls.js` 六个模块从它读快照 —— **没有任何模块驱动它**

所以「接线 `player.js` 的 `nextSong()`」在今天是**做不到的**：
改了也不会生效，因为那条路径根本不经过引擎。

### 3.1 正确顺序

```
阶段 3 · 把播放路径迁到引擎（11 个调用方，见 PLAYBACK-ENGINE.md:277）
    │  引擎获得 DOM 装配职责（现在连 <audio> 元素都是注入的）
    ▼
实现引擎的 crossfadeTo（engine.js 已留好占位 + 说明）
    │  届时 audioPool 的多实例能力与 crossfade 编排层都已就位
    ▼
mediaSession.js 订阅交叉点事件
    ▼
设置项（prefs 键白名单在 src/main/ipc/prefs.js）
```

### 3.2 为什么不做半成品

我尝试过在引擎里直接实现 `crossfadeTo`，随即撞上两个硬阻碍并**回退**了：

1. `loadTrack()` 只认 `activeAudio()`（主实例），不接受实例 id ——
   写出来的「预载」实际会把歌载进主实例，**预载静默失效**
2. 创建第二个 `<audio>` 需要 DOM，会破坏 `engine.js` 的硬约束
   「零 DOM 依赖、可在 node:test 单测」（`PLAYBACK-ENGINE.md:251`）

硬塞进来只有两种结果：要么功能假生效，要么破坏引擎可测性。**两者都比不做更糟。**

`engine.js:357-381` 现在留了一个**诚实的占位**：`crossfadeTo()` 返回 `null`
并 warn，注释里写明了为什么不做、什么条件下才做。调用方可安全降级为硬切。

### 3.3 `mediaSession.js` 交叉点切换（待做）

`src/renderer/js/player/mediaSession.js` 的 `_syncNow()` 当前立即写
`navigator.mediaSession.metadata`。需要在交叉点才切换。

注意它现在**从引擎快照读**（`:77-78`）—— 引擎成为播放路径后，这条路自然成立。

### 3.4 设置项（待做）

复用 `FADE_STEPS` 档位表，新增一个「无缝交叉」开关。
**注意**：prefs 键白名单在 `src/main/ipc/prefs.js`，渲染层用的每个键都必须在其中。

### 3.5 降级路径（已实现于编排层）

| 风险 | 降级 |
|---|---|
| 预载失败 | `planCrossfade` 返回 `mode:'hardCut'`，由调用方直接切 |
| 时长为 0 | 同上（`FADE_STEPS[0]` 就是「关」） |
| 无 Web Audio | 退回 `fade.js` 单实例斜坡（有间隙但可用） |
| 用户中途切歌/暂停 | `controller.abort()` 立即归位（主实例满音量、副实例归零） |
| EQ 图装配冲突 | 沿用 `audioPool` 显式幂等标志，失败返回 null 并 warn，**不静默** |

---

## 四、不要碰的地方

- **下载链路**：`docs/architecture/OVERVIEW.md` 第四节列了三处「反直觉但必要」的设计
  （重试只对 403/404/410、沙箱复核不过退回根目录而非失败、终态必须 immediate 落盘）。
  crossfade 是**播放试听**特性，与下载链路完全无关。
- **`fade.js`**：未启用 crossfade 时它仍是兜底，不要删。
- **AudioContext 生命周期**：归引擎/池管，`eq.js` 与 `visualizer.js` 都不得 close 它
  （`eq.js:315` 已有明令）。
- **`engine.js` 的零 DOM 铁律**：`PLAYBACK-ENGINE.md:251` 明载「ESM，零 import、
  零 DOM 依赖」。不要为了接 crossfade 往引擎里塞 `document.createElement` ——
  预载所需的第二个 `<audio>` 应当由**引擎的调用方**（未来的阶段 3 迁移层）
  创建后注入，引擎只管调度。
- **引擎的旁路纪律**：在阶段 3 完成前，不要把生产播放路径改到引擎上。
  本仓对引擎的规划是「旁路建缝 → 分批迁移 → 收口」，本方案不改变这个节奏。

---

## 五、这一轮的教训（写给下一个人）

**动手接线前，先确认被接线的东西真的在那条路上。**

我最初读 `mediaSession.js` 看到它「从引擎快照读」，就推断「引擎已经是播放路径」。
实际上 `player.js` 的 `loadAndPlay()` 直接写 `audio.src`，引擎只是被六个模块
**只读**快照的旁路设施。差点按错误前提写完整个接线层。

`docs/architecture/PLAYBACK-ENGINE.md` 里「旁路建好的缝」这句话就是答案 ——
它写在第 245 行和第 264 行，**读架构文档比读代码更快**。

第二个教训：**写了跑不通就先回退，别留半成品**。
`crossfadeTo` 的第一版有「预载静默失效」的问题（`loadTrack` 不认实例 id）。
我把它删掉，改成返回 `null` 的诚实占位 + 注释说明 —— 这比留一个看起来能用、
实际不工作的函数安全得多。
