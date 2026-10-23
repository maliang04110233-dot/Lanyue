# P0 · 换源参数化设计

> 状态：**已实现**（`resolveTrackService.js` + `api/index.js` facade + 18 个新用例）
> 参考：GitHub 项目 spotube 的 `isRefresh` / `allowToggleSource` / `onToggleSource` 三参数
> 依据：Lanyue v1.0.35 换源链路的实际代码
> 测试：新增 `test/resolveTrackOptions.test.js` 18/18 通过；全量 3379/3379 通过（零回归）

---

## 一、先说结论：三个参数里两个已经有了

读完 `src/api/services/resolveTrackService.js` 与 `src/api/services/fallbackPolicy.js` 后，
**spotube 的三个参数在 Lanyue 里都已有对应物，只是命名与形态不同**：

| spotube 参数 | Lanyue 现状 | 差距 |
|---|---|---|
| `allowToggleSource` | `crossSourceAutoFallback`（prefs，全局） | 只有全局开关，**无 per-call 覆盖** |
| `onToggleSource` | 结果对象上的 `matchedFrom` / `matchedSong` / `fromAltMemory` 字段 + `fallbackNotice.js` UI | 数据面有，**无回调钩子**给程序化消费方 |
| `isRefresh` | 无显式参数。签名 URL 过期由 `streamProtocol.js` 的 `refreshUpstreamOn403` **被动**重取 | **无「主动要求重解析」的入口** |

所以这一项不是「从零实现三个参数」，而是**把已有的隐式行为显式化**。

---

## 二、现有换源链路（实读）

### 2.1 入口

```
src/api/index.js:169   getDownloadUrlSmart(song, quality)
    └─► resolveTrack.resolve(song, quality)
```

`getDownloadUrlSmart` 只是 facade，签名与返回形状与重构前完全一致（零回归）。

### 2.2 resolve() 的四步（`resolveTrackService.js:251`）

```
0. 跨源换源总开关（crossSourceOn()）关闭 ⇒ 跳过步骤 1 与 3
1. _altSource 记忆命中 —— 上次换源成功的源先试（lx toggleMusicInfo 模式）
2. 本源取流
3. 失败且 shouldFallbackToOtherSource(result) ⇒ 跨源候选 → 按健康度重排 → 逐个试
4. 全失败 ⇒ 返回本源原始错误（保证 UI 文案与「没换源时」一致）
```

### 2.3 依赖注入面（`resolveTrackService.js:155-163`）

```js
createResolveTrackService({
  getUrl,                    // (id, source, quality) => Promise<TrackResult>
  searchFn,                  // (platformId, keyword, page?) => Promise<Array>
  hasCookie,                 // (platformId) => boolean
  findCandidates,            // (deps, song) => Promise<Array>
  sourceHealth,              // { recordResult, rankByHealth }
  probeUrl,                  // 候选直链预检（可选）
  getDisabledPlatforms,      // 换源禁用平台清单（prefs 原始值）
  fallbackEnabled,           // 跨源换源总开关（prefs）
})
```

**这是一个很好的可测设计** —— 单测用桩就能覆盖「本源失败→换源成功／全失败／记忆命中」全部分支。
新参数应当**沿这个注入面加**，而不是另起一套。

### 2.4 产品口径（`fallbackPolicy.js:14-25`，2026-10-20 改版）

> **播放源无效时自动换源**。旧口径「搜索结果里的歌 = 它自己平台的音源，拿不到就诚实失败」
> 的顾虑（别家同名整曲可能是现场版/翻唱）由 UI 兜住：换源成功时 `fallbackNotice`
> 明示「已从 X 切到 Y」+ 播放条源徽章显示实际来源。

**关键**：`crossSourceEnabled()` 的容错是「只有显式 `false` 才关；未初始化/未设置/垃圾值一律默认开」。
新参数必须遵守同一容错纪律 —— 读盘故障不该让本来能换源听到的歌播不了。

---

## 三、参数设计

### 3.1 `allowToggleSource`（per-call 覆盖）

**现状**：`fallbackEnabled` 是 prefs getter，每次 `resolve()` 至多读一次
（`_fallbackCache`，`:194-203`）。所有调用方共享同一个全局开关。

**问题**：有些场景**不该**换源 —— 例如用户从「我的歌单」点了一首明确标记了源的歌，
或者下载链路里已经换过一次源（再换就是无限套娃）。

**设计**：在 `resolve(song, quality, options)` 上加第三参：

```js
/**
 * @param {object} [options]
 * @param {boolean} [options.allowToggleSource]  覆盖全局开关。
 *        缺省 ⇒ 读注入的 fallbackEnabled（现有行为，零回归）
 */
async function resolve(rawSong, quality, options = {}) {
  // ...
  const allowToggle = typeof options.allowToggleSource === 'boolean'
    ? options.allowToggleSource
    : crossSourceOn();
```

**必须显式区分「未传」与「传 false」** —— 用 `typeof === 'boolean'` 判定，
不要用 `??`（`null` 会被当成「未传」）。

**步骤 1（_altSource 记忆）也要过这个开关** —— 否则 per-call 关了换源，
记忆路径仍会把歌换走。

### 3.2 `onToggleSource`（换源回调）

**现状**：换源成功时 `:335` 有一行 `logger.log`，结果对象带
`matchedFrom` / `matchedSong` 字段，UI 层 `fallbackNotice.js` 据此提示。

**问题**：**程序化消费方拿不到事件**。MCP 工具（`src/main/mcp/`）与 AI 助手
调用 `getDownloadUrlSmart` 时，只能拿到最终结果，无法知道「中间换过源」。
对 AI 场景这是实打实的缺陷 —— 助手说「正在播放网易云的 X」，实际响的是酷狗的。

**设计**：

```js
/**
 * @param {(event: {type: 'toggled', from: string, to: string, matchedSong?: object}) => void} [options.onToggleSource]
 */
```

**只在真正发生切换时回调**（步骤 1 记忆路径 + 步骤 3 候选路径），
**不回调「本源成功」** —— 否则消费方会被噪音淹没。

**回调抛错不得影响取流**：包 try/catch，与 `record()` 的容错纪律一致
（`:172-176`「统计不可用不影响取流主流程」）。

**与 `fallbackNotice` 的关系**：UI 层继续从结果字段读（`matchedFrom` 等），
**不改**。回调是给程序化消费方的额外通道，两条路并存。

### 3.3 `isRefresh`（跳过记忆，强制重新解析）—— ⚠️ 初版设计有误，已修正

**初版判断（错）**：「`isRefresh` = 绕过 URL 缓存」。

**实测事实**：Lanyue 的取流链路**没有 URL 缓存层**。
- `gateway.getUrl`（`src/api/gateway.js:165`）每次都重新调平台插件解析直链
- 渲染层的预取缓存（`playPrefetch.js:88` `take()`）是**取用即失效** ——
  一条直链只用一次，不存在「复用已过期 URL」

所以「绕过 URL 缓存」在这里**没有可绕的缓存**。

**真正需要强制重解析的是 `_altSource` 记忆**（`resolve()` 步骤 1）：
上次换源成功的源会被优先尝试，而那条链可能已经失效
（平台改了签名算法、换了 CDN、歌曲下架重上）。

**修正后的语义**：

```js
/**
 * @param {boolean} [options.isRefresh] 跳过 _altSource 记忆，强制走本源重新解析。
 *        调用方明确表示「记忆里那条链不行了，重新找」。
 *        注意：跳过记忆**不是**禁掉换源 —— 本源失败后照常走跨源候选。
 */
```

**与现有机制的关系**（**重要，别重复造**）：

| 层 | 现有机制 | 职责 |
|---|---|---|
| 流代理 | `refreshUpstreamOn403`（`streamProtocol.js:350`） | 播放中 403 → 同源重取（主进程内，不跨进程） |
| 取流解析 | `resolve()` 步骤 1-2 | 解析歌曲 → URL（渲染层链路） |
| 新参数 | `isRefresh` | 跳过**记忆**（`_altSource`），强制重新解析 |

`isRefresh` 不替代 `refreshUpstreamOn403`，它解决的是**另一个时机**：
「我还没开始播，但我怀疑记忆里那条链不行」。
**两者不得互相调用。**

---

## 四、改动文件清单

### 已完成

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/api/services/resolveTrackService.js` | 改造 | `resolve()` 加第三参 `options`；三处消费新参数 |
| `src/api/index.js` | 改造 | `getDownloadUrlSmart(song, quality, options)` 透传 |
| `test/resolveTrackOptions.test.js` | 新建 | 18 个用例（参数语义 + 脏入参 + 回归守卫） |

### 待做（消费方接线）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/shared/ipcContract.js` | 改造 | 通道参数规格加 `options` 形状（**必须过契约钳制**） |
| `src/main/ipc/download/stream.js` | 改造 | `proxy-play` 调用点透传 options |
| `src/renderer/js/playback/wire.js` | 改造 | `resolveTrack` 注入 options |
| `src/main/mcp/tools.js` | 改造 | MCP 工具面透传 options + 把 `onToggleSource` 事件写入审计 |

**注意**：`onToggleSource` 是**函数**，不能穿过 IPC 契约（契约只传可结构化克隆的数据）。
所以 IPC 通道上能透传的是 `allowToggleSource` 与 `isRefresh`，
而 `onToggleSource` 只能在**同进程内**使用（渲染层 → `api/index.js`），
或在主进程侧由 MCP 工具自己构造一个回调并把事件写进审计。

---

## 五、验收标准

### 单测（`test/resolveTrackOptions.test.js`，18 个，已全绿）

1. `allowToggleSource === false` 时，**步骤 1 与步骤 3 都跳过**（记忆路径也要关）
2. `allowToggleSource === true` 时，全局开关关着也能换源（反向覆盖）
3. `allowToggleSource` 未传：行为与今天**逐字一致**（回归守卫）
4. `allowToggleSource` 传 `null`：按「未传」处理（**不得被当成 false**）
5. `allowToggleSource` 传脏值（字符串/数字/NaN/对象）：按「未传」处理，不炸
6. `allowToggleSource === false`：本源成功不受影响（开关只管跨源）
7. `onToggleSource` 在**换源成功时被调用一次**，参数含 `from`/`to`
8. `onToggleSource` 在**记忆路径换源时也触发**（那也是一次切换）
9. `onToggleSource` 在**本源成功时不调用**（不制造噪音）
10. `onToggleSource` 在**全候选失败时不调用**（没真的切换）
11. `onToggleSource` **抛错时取流仍成功**（容错纪律：回调是观察者不是控制者）
12. `isRefresh: true`：**跳过 `_altSource` 记忆**，直接走本源
13. `isRefresh` 未传：记忆路径照旧生效（回归守卫）
14. `isRefresh: true`：记忆失败后**仍会走跨源候选**（不是彻底禁掉换源）
15. `isRefresh` 传非 true 值：按未传处理
16. `isRefresh` 与 `allowToggleSource:false` 叠加：记忆与候选都被挡

### 回归守卫

17. 不传 `options` 时，`getDownloadUrlSmart` 的返回形状与今天**完全一致**
    （既有 `test/resolveTrackService.test.js` 全部用例未改动且仍全绿）
18. `crossSourceAutoFallback` 全局开关仍然生效（新参数是**覆盖**，不是替代）

### 全量

19. **3379/3379 通过，0 失败**（基线 3361 + 新增 18）

---

## 六、与 crossfade 的接口

crossfade 的 `wire.js` 已经注入 `resolveTrack`。crossfade 预载下一首时，
**应当传 `allowToggleSource: true`** —— 预载的目的就是提前找到能播的源，
关掉换源会让预载失去意义。

但**预载失败时不应触发换源风暴**：crossfade 的 `hardCut` 降级路径
（见 `P0-crossfade.md` 第 3.5 节）只应**硬切**，不应再发起一轮跨源搜索。

---

## 七、风险

| 风险 | 规避 |
|---|---|
| 契约钳制漏掉 `options` | `src/shared/ipcContract.js` 是唯一事实来源，必须同步；`assertContractCoverage()` 会在启动时对账 |
| per-call 开关与全局开关语义混淆 | 注释明确「覆盖」；单测 3 钉住未传时的行为 |
| 回调成为新的性能负担 | 只在真正切换时回调；不回调成功路径 |
| `onToggleSource` 试图穿过 IPC | 函数不可结构化克隆；IPC 通道只传 `allowToggleSource` / `isRefresh`（见 §4） |
| `isRefresh` 与 `refreshUpstreamOn403` 职责重叠 | 本文档第 3.3 节已划清时机边界；实现时不得让两者互相调用 |
| `isRefresh` 被误解为「清缓存」 | 语义已改为「跳过记忆」；代码注释与本文档 §3.3 同步 |
