# 心动模式（Heartbeat Mode）设计稿

**日期**: 2026-10-10
**作者**: 原作者 + Agent
**状态**: 已批准 → 转计划
**范围**: MVP（后端算法 + IPC 入口 + 自动接力逻辑 + 单元测试；**不含渲染层 UI**）

---

## 1. 问题与目标

### 现状
揽乐作为**下载 + 跨平台搜索播放**一体的客户端，播放队列由用户手动填充（搜索结果 → 加入队列 / 下载完成 → 加入队列）。队列播完后要么停，要么循环，无主动续播能力。

### 目标
在**不增加新外部依赖**的前提下，让应用具备：

> 「当前歌曲快播完时，自动基于**当前歌曲 + 收藏歌手**生成 30 首智能推荐，追加到播放队列尾部，无缝接力下一首」

### 成功判据
1. 收藏歌单有 ≥ 5 首时，生成的 30 首里至少 15 首来自收藏歌手的热门单曲
2. 收藏为空时，自动回落到跨平台热歌榜 Top 100
3. 网关任意一个平台失败不阻塞其他平台（返回空列表而非抛错）
4. 已在当前播放队列 / 收藏里的歌**不会**再次出现在推荐里
5. 每次追加 30 首，**只追加、不替换**，用户可随时停止
6. 单测覆盖：种子提取、候选拉取、打分、去重、排序、空种子回落

---

## 2. 方案选型

三个方案对比后选定 **方案 A（主进程心跳引擎）**：

| | A. 主进程心跳引擎 ✅ | B. 全渲染层 | C. 主进程被动 + 渲染层主动 |
|---|---|---|---|
| 结构 | `heartbeatEngine.js` 算法核 + `ipc/heartbeat.js` IPC | 渲染层直接调 API | 主进程只暴露 `generateRecommendations` IPC |
| 种子提取 | 主进程读 prefs/playlist store（天然可测） | 渲染层跨 preload 多次调用（逻辑散） | 渲染层拼种子（职责错位） |
| 测试 | 纯函数，输入种子 → 输出 30 首，极简 | 要 mock 渲染层 | 同 A |
| 自动接力 | 主进程监听队列长度（和 downloadQueue 同风格） | 渲染层监听进度条（复杂易抖） | 渲染层轮询 |
| 风险 | 0 | 渲染层职责膨胀 | 低但种子逻辑错位 |

---

## 3. 架构

```
┌──────────────────────────────────────────────────────────────┐
│  渲染层 player.js（MVP 后做）                                  │
│  - 监听播放进度 → 剩 10s 时发 'generate-heartbeat' IPC        │
│  - 追加返回的 songs 到播放队列尾部                              │
└──────────────────────────┬───────────────────────────────────┘
                           │ IPC
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  src/main/ipc/heartbeat.js（新）                              │
│  handle('generate-heartbeat', { currentSongId })             │
│    1. 从 playlist store 读收藏歌单                            │
│    2. 从 window.currentPlayback 拿当前歌曲                     │
│    3. 调 heartbeatEngine.generate({...})                      │
│    4. 返回 { ok: true, songs: [] }                            │
└──────────────────────────┬───────────────────────────────────┘
                           │ require
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  src/utils/heartbeatEngine.js（新，纯算法核）                  │
│  generate({ currentSong, favorites, gateway })                │
│    → 种子提取 → 候选拉取 → 打分 → 去重 → 排序 → 前 30 首     │
│                                                               │
│  ┌──────────────────────────────────────────────┐             │
│  │  src/api/recommendations.js（已存在，零改）    │             │
│  │  gateway.fanOut / getTopList / getSingerSongs │             │
│  └──────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

**启动装配**：在 `bootstrap.js` 里注册 `ipcHeartbeat.register()`（走现有 ipcRegister 工厂），engine 用 recommendations.js 自己的 `gw()` 网关（无需额外注入）。

---

## 4. 模块设计

### 4.1 `src/utils/heartbeatEngine.js`（算法核）

**导出一个纯函数** `generate(params)`：

```js
async function generate({ currentSong, favorites, gateway }) {
  // 种子
  const seedArtists = extractSeedArtists(currentSong, favorites);

  // 候选（并行为主，fanOut 失败降级为空）
  const candidates = await Promise.allSettled([
    // 各平台热歌榜 4 条（兜底）
    gw.getTopList('netease', '热歌榜', 50),
    gw.getTopList('qq',      4,          50),
    gw.getTopList('kugou',   '网络热歌榜', 50),
    gw.getTopList('kugou',   'TOP500',    50),
    // 当前歌手热门（3 家，各取 30）
    ...(currentArtist ? [
      gw.getSingerSongs(currentArtist, 30, 'netease'),
      gw.getSingerSongs(currentArtist, 30, 'qq'),
      gw.getSingerSongs(currentArtist, 30, 'kugou'),
    ] : []),
    // 收藏歌手 top 10（限 5 个 × 3 平台 = 150，避免爆炸）
    ...favoriteArtists.slice(0, 5).flatMap(a => [
      gw.getSingerSongs(a, 10, 'qq'),
      gw.getSingerSongs(a, 10, 'netease'),
      gw.getSingerSongs(a, 10, 'kugou'),
    ]),
  ]);

  // 合并 + 去重（songKey = id + ':' + source）
  const merged = candidates.map(r => r.status === 'fulfilled' ? r.value : [])
    .flat()
    .filter(Boolean);

  const seen = new Set();
  const dedup = [];
  for (const song of merged) {
    const k = song.id + ':' + song.source;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push({ ...song, score: scoreSong(song, seedArtists, currentArtist) });
  }

  // 打分 + 排序 + 取前 30
  dedup.sort((a, b) => b.score - a.score);
  return dedup.slice(0, 30).map(s => ({
    title: s.title, artist: s.artist, album: s.album || '',
    source: s.source, id: s.id, mid: s.mid || '',
    coverUrl: s.coverUrl || '',
    reason: s.reason || '', score: s.score,
  }));
}
```

**种子提取** `extractSeedArtists(currentSong, favorites)`：
- 当前歌曲 artist → 权重 5
- 收藏歌单每首的 artist（去重，限 20） → 权重 1
- 返回 `{ current: string, favorites: [string], weights: Map<string, number> }`

**打分** `scoreSong(song, seedArtists, currentArtist)`：
```
score = (artistMatch(song.artist) * artistWeight)
      + (songIsFromTopList(song) ? 2 : 0)
      + (sameSourceAsCurrent(song, currentArtist) ? 1.2 : 1.0)
artistMatch = 5 if song.artist === currentArtist, else (weights.get(song.artist) || 0)
```

**空种子回落**：当 `favorites` 空且无 `currentSong` 时，`extractSeedArtists` 返回空集合 → `artistMatch` 全部为 0 → 热歌榜候选胜出（榜单权重 2）。这正是期望行为。

### 4.2 `src/main/ipc/heartbeat.js`（IPC 入口）

```js
const { handle } = require('./register');
const heartbeatEngine = require('../utils/heartbeatEngine');
const { default: recommendations } = require('../api/recommendations');
const logger = require('../utils/logger');

module.exports = {
  register() {
    handle('generate-heartbeat', async (_, { currentSongId, currentSource }) => {
      try {
        // 1. 从 playlist store 读收藏
        const favorites = ensureFavorites().songs;  // ← 用 playlist.js 的函数
        // 2. 从当前播放队列找当前歌曲
        const currentSong = findSongInQueue(currentSongId, currentSource);
        // 3. 调算法核
        const songs = await heartbeatEngine.generate({
          currentSong,
          favorites,
          gateway: recommendations.setGateway && recommendations._gw(),  // gw() 延迟 getter
        });
        return { ok: true, songs };
      } catch (e) {
        logger.warn('[heartbeat] 生成失败:', e.message);
        return { ok: false, songs: [], error: e.message };
      }
    });
  },
};
```

**依赖 playlist store 的 `ensureFavorites` 函数**：从 `src/main/ipc/playlist.js` 导出（目前是模块内私有函数 `const ensureFavorites = ...`，需要加一行 `module.exports`）。

### 4.3 新增 IPC 通道声明

`src/shared/ipcContract.js` 加一行：
```js
'generate-heartbeat': { direction: 'renderer→main', params: { currentSongId: 'string', currentSource: 'string' }, returns: '{ ok: boolean, songs: [] }' },
```

---

## 5. 非目标（YAGNI）

- ❌ 渲染层 UI（心动开关、偏好设置、手动触发按钮）—— **下一个迭代**
- ❌ 跨设备同步心跳模式开关 —— 本地 prefs 即可
- ❌ 历史播放作为种子 —— MVP 只用收藏 + 当前歌曲，足够稳定
- ❌ 同歌单/同专辑扩展候选 —— 复杂度高、专辑质量参差
- ❌ 用户权重偏好设置（"我更爱听 QQ vs 网易云"）—— 硬编码为榜单为主 + 收藏歌手点缀

---

## 6. 测试

### `test/heartbeatEngine.test.js`

| 测试 | 输入 | 期望 |
|---|---|---|
| 种子提取：当前歌曲 artist 权重 5 | currentSong={artist='周杰伦'} | weights.get('周杰伦') === 5 |
| 种子提取：收藏歌手权重 1 | favorites=[{artist='周杰伦'},{artist='林俊杰'}] | weights.get('林俊杰') === 1 |
| 种子提取：收藏歌手去重限 20 | 50 首收藏 40 个歌手 | weights.size === 20 |
| 候选拉取：所有平台正常 | mock gateway 全返回 | songs.length === 30 |
| 候选拉取：网易云失败 | netease getTopList 抛错 | 其他平台结果仍返回，songs.length > 0 |
| 去重：当前歌和收藏歌被排 | 候选含 favorites 里的歌 | songs 里 0 首与 favorites 重复 |
| 打分：同 artist 高分 | 榜单里同名歌手 song | song.score > 2 |
| 空种子回落：收藏空且无当前 | 空 currentSong + favorites=[] | songs 全来自热歌榜 |
| 打分排序：高分在前 | song.score=[5,3,1] | 返回按 score 降序 |

### `test/ipc-contract.test.js`（自动对账）

- 契约声明了 `generate-heartbeat` → 自动遍历 `ipc/heartbeat.js` 确认 `handle('generate-heartbeat')` 存在
- 无需额外手写断言

---

## 7. 文件变更清单

| 操作 | 文件 | 说明 |
|---|---|---|
| ➕ 新增 | `src/utils/heartbeatEngine.js` | 算法核（~120 行） |
| ➕ 新增 | `src/main/ipc/heartbeat.js` | IPC 入口（~30 行） |
| ✏️ 修改 | `src/main/ipc/playlist.js` | 导出 `ensureFavorites` 函数（+1 行 module.exports） |
| ✏️ 修改 | `src/main/ipcRegister.js` | require + register heartbeat 模块 |
| ✏️ 修改 | `src/shared/ipcContract.js` | 加 `generate-heartbeat` 通道声明 |
| ✏️ 修改 | `src/shared/ipcContract.js`（或新文件） | 加返回结构校验 |
| ➕ 新增 | `test/heartbeatEngine.test.js` | 9 个测试用例 |

**总计**：新增 ~150 行实现 + 9 个测试；修改 4 处各 1-3 行。

---

## 8. 实现计划

按 Superpowers writing-plans skill 流程执行（**下一个 skill**）。

```
T1: 创建 heartbeatEngine.js 算法核 + 单测（先写测试，再实现）
T2: 修改 playlist.js 导出 ensureFavorites
T3: 创建 ipc/heartbeat.js IPC 入口
T4: 修改 ipcRegister.js 注册 + ipcContract.js 加声明
T5: 全量验证 lint + test
```
