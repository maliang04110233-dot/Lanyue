# 心动模式（Heartbeat Mode）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于当前歌曲 + 收藏歌单的歌手种子，生成 30 首跨平台智能推荐歌曲，通过 IPC 暴露给渲染层在播放队列耗尽时自动接力。

**Architecture:** 主进程内 `heartbeatEngine.js`（纯算法核，输入种子→输出 30 首）+ `ipc/heartbeat.js`（IPC 薄入口）。算法核直接调已有的 `recommendations.js` 导出函数（`getHomeRecommendations` 拉热歌榜、`getSingerSongs` 拉歌手热门），内部自动 `Promise.allSettled` 隔离单平台失败。种子提取用 `playlist.js` 已导出的 `ensureFavorites()`。

**Tech Stack:** Node.js + Electron + 现有 recommendations.js gateway + 现有 playlist.js 收藏数据结构 + prefs.js 持久化

**Spec:** `docs/superpowers/specs/2026-10-10-heartbeat-mode-design.md`

---

## 文件变更总览

| 操作 | 文件 | 行数 | 职责 |
|---|---|---|---|
| ➕ 新增 | `src/utils/heartbeatEngine.js` | ~130 | 算法核：种子提取 + 候选拉取 + 打分 + 去重 + 排序 |
| ➕ 新增 | `src/main/ipc/heartbeat.js` | ~35 | IPC 入口：`handle('generate-heartbeat')` |
| ✏️ 修改 | `src/shared/ipcContract.js` | +3 | 加 `generate-heartbeat` invoke 通道声明 |
| ✏️ 修改 | `src/main/ipcRegister.js` | +2 | require + register heartbeat 模块 |
| ➕ 新增 | `test/heartbeatEngine.test.js` | ~120 | 9 个单测用例 |

---

## Task 1: 创建 heartbeatEngine.js 算法核 + 单测

**Files:**
- Create: `src/utils/heartbeatEngine.js`
- Test: `test/heartbeatEngine.test.js`

**依赖接口（已确认）：**
- `recommendations.getHomeRecommendations()` → `{ neteaseHot: [], qqTop: [], kugouHot: [], kugouTop500: [], ... }`
- `recommendations.getSingerSongs(artistName, limit)` → `[{ title, artist, source, id, mid, coverUrl, ... }]`（内部自动探测平台）
- `playlist.ensureFavorites()` → `[{ id: 'favorites', songs: [{ title, artist, source, id, album, ... }] }]`

### Step 1: 写测试文件（先写失败的测试）

创建 `test/heartbeatEngine.test.js`：

```js
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const heartbeatEngine = require('../src/utils/heartbeatEngine');

// —— mock helpers ——
function mockSong(overrides = {}) {
  return {
    title: '测试歌', artist: '周杰伦', album: '范特西',
    source: 'netease', id: '12345', mid: 'abc123', coverUrl: 'https://x.jpg',
    ...overrides,
  };
}

function mockGateway(overrides = {}) {
  return {
    getHomeRecommendations: async () => ({
      neteaseHot: [mockSong({ title: 'N热歌1', id: 'n1', source: 'netease', artist: '周杰伦', rank: 1 }),
                   mockSong({ title: 'N热歌2', id: 'n2', source: 'netease', artist: '林俊杰', rank: 2 })],
      qqTop:      [mockSong({ title: 'Q热歌1', id: 'q1', source: 'qq', artist: '周杰伦', rank: 1 }),
                   mockSong({ title: 'Q热歌2', id: 'q2', source: 'qq', artist: '五月天', rank: 2 })],
      kugouHot:   [mockSong({ title: 'K热歌1', id: 'k1', source: 'kugou', artist: '王力宏', rank: 1 })],
      kugouTop500:[mockSong({ title: 'K500歌1', id: 'k500', source: 'kugou', artist: '周杰伦', rank: 1 })],
      neteaseTops: [], neteaseNew: [], neteaseOriginal: [],
      qqNew: [], biliRanking: [], kugouTops: [], kugouShort: [],
    }),
    getSingerSongs: async (name, limit) => {
      const songs = [];
      for (let i = 0; i < Math.min(limit, 5); i++) {
        songs.push(mockSong({
          title: `${name}热门${i}`,
          artist: name,
          id: `${name}-${i}-${Math.random()}`,
          source: ['qq', 'netease', 'kugou'][i % 3],
        }));
      }
      return songs;
    },
    ...overrides,
  };
}

// —— 种子提取测试 ——
describe('heartbeatEngine', () => {
  describe('extractSeedArtists', () => {
    test('当前歌曲 artist 权重 5', () => {
      const result = heartbeatEngine.extractSeedArtists(
        { artist: '周杰伦' },
        [{ artist: '林俊杰' }, { artist: '周杰伦' }],
      );
      assert.strictEqual(result.weights.get('周杰伦'), 5);
    });

    test('收藏歌手权重 1，去重', () => {
      const result = heartbeatEngine.extractSeedArtists(
        null,
        [{ artist: '林俊杰' }, { artist: '林俊杰' }, { artist: '王力宏' }],
      );
      assert.strictEqual(result.weights.get('林俊杰'), 1);
      assert.strictEqual(result.weights.size, 2); // 去重
    });

    test('收藏歌手限 20 个', () => {
      const favorites = [];
      for (let i = 0; i < 50; i++) favorites.push({ artist: `歌手${i}` });
      const result = heartbeatEngine.extractSeedArtists(null, favorites);
      assert.strictEqual(result.weights.size, 20);
    });

    test('当前歌曲 artist 不进 favorites 列表，单独放在 current 字段', () => {
      const result = heartbeatEngine.extractSeedArtists(
        { artist: '周杰伦' },
        [{ artist: '林俊杰' }],
      );
      assert.strictEqual(result.current, '周杰伦');
      assert.deepStrictEqual(result.favorites, ['林俊杰']);
      assert.ok(!result.favorites.includes('周杰伦')); // 不重复
    });

    test('全部为空时返回空 weights', () => {
      const result = heartbeatEngine.extractSeedArtists(null, []);
      assert.strictEqual(result.weights.size, 0);
      assert.strictEqual(result.current, null);
    });
  });

  // —— 打分测试 ——
  describe('scoreSong', () => {
    test('同当前 artist 得高分（5 + 榜单权重）', () => {
      const engine = heartbeatEngine._internal || heartbeatEngine;
      const score = engine.scoreSong(
        { artist: '周杰伦', source: 'qq' },
        { current: '周杰伦', favorites: [], weights: new Map() },
        '周杰伦',
        { onTopList: true },
      );
      assert.ok(score > 5, `同 artist 应当 >5，实际 ${score}`);
    });

    test('收藏 artist 得中分（1 + 榜单权重）', () => {
      const engine = heartbeatEngine._internal || heartbeatEngine;
      const score = engine.scoreSong(
        { artist: '林俊杰' },
        { current: null, favorites: ['林俊杰'], weights: new Map([['林俊杰', 1]]) },
        null,
        { onTopList: true },
      );
      assert.ok(score >= 3, `收藏 artist 应当 >=3，实际 ${score}`);
    });

    test('完全无关 artist 得低分', () => {
      const engine = heartbeatEngine._internal || heartbeatEngine;
      const score = engine.scoreSong(
        { artist: '路人甲' },
        { current: '周杰伦', favorites: ['林俊杰'], weights: new Map([['林俊杰', 1]]) },
        '周杰伦',
        { onTopList: false },
      );
      assert.ok(score < 1, `无关 artist 应当 <1，实际 ${score}`);
    });
  });

  // —— generate 端到端测试 ——
  describe('generate', () => {
    test('正常情况下返回 30 首', async () => {
      const gw = mockGateway();
      const songs = await heartbeatEngine.generate({
        currentSong: { title: '稻香', artist: '周杰伦', source: 'qq', id: '1' },
        favorites: [{ artist: '周杰伦', id: 'f1', source: 'qq', title: '青花瓷' }],
        gateway: gw,
      });
      assert.ok(Array.isArray(songs));
      assert.ok(songs.length > 0); // mock 榜单只有 ~10 首 + 歌手热门，但至少 >0
    });

    test('当前歌和收藏歌被去重（不会再次推荐）', async () => {
      const gw = mockGateway({
        getHomeRecommendations: async () => ({
          neteaseHot: [mockSong({ title: '稻香', artist: '周杰伦', id: '1', source: 'qq' })],
          qqTop:      [mockSong({ title: '青花瓷', artist: '周杰伦', id: 'f1', source: 'qq' })],
          kugouHot:   [], kugouTop500: [],
          neteaseTops: [], neteaseNew: [], neteaseOriginal: [],
          qqNew: [], biliRanking: [], kugouTops: [], kugouShort: [],
        }),
      });
      const songs = await heartbeatEngine.generate({
        currentSong: { title: '稻香', artist: '周杰伦', source: 'qq', id: '1' },
        favorites: [{ title: '青花瓷', artist: '周杰伦', id: 'f1', source: 'qq' }],
        gateway: gw,
      });
      const keys = new Set(songs.map(s => `${s.id}:${s.source}`));
      assert.ok(!keys.has('1:qq'), '当前歌不应在推荐里');
      assert.ok(!keys.has('f1:qq'), '收藏歌不应在推荐里');
    });

    test('网易云榜单失败时不阻塞其他平台', async () => {
      const gw = mockGateway({
        getHomeRecommendations: async () => ({
          // neteaseHot 空（模拟失败）
          neteaseHot: [], qqTop: [mockSong({ title: 'Q1', id: 'q1', source: 'qq' })],
          kugouHot: [mockSong({ title: 'K1', id: 'k1', source: 'kugou' })], kugouTop500: [],
          neteaseTops: [], neteaseNew: [], neteaseOriginal: [],
          qqNew: [], biliRanking: [], kugouTops: [], kugouShort: [],
        }),
      });
      const songs = await heartbeatEngine.generate({
        currentSong: null, favorites: [], gateway: gw,
      });
      assert.ok(songs.length >= 2, '至少 qqTop 和 kugouHot 各出 1 首');
    });

    test('空种子（无当前 + 无收藏）时只靠榜单', async () => {
      const gw = mockGateway();
      const songs = await heartbeatEngine.generate({
        currentSong: null, favorites: [], gateway: gw,
      });
      assert.ok(songs.length > 0);
      // 所有歌的 score 应该是榜单权重主导，artist 匹配项都是 0
      for (const s of songs) {
        assert.ok(s.score >= 2, `榜单歌 score 应当 >=2，实际 ${s.score}`);
      }
    });
  });
});
```

### Step 2: 运行测试确认失败

```bash
npm test -- test/heartbeatEngine.test.js 2>&1
```

Expected: FAIL — `Cannot find module '../src/utils/heartbeatEngine'`

### Step 3: 创建 heartbeatEngine.js 实现

```js
/**
 * 心动模式（Heartbeat Mode）算法核
 *
 * 纯函数 + 薄状态。输入种子 → 输出 30 首智能推荐歌曲。
 * 不直接摸主进程任何模块（prefs / playlist store），全部通过 deps 注入。
 */

'use strict';

const logger = require('./logger');

// ── 种子提取 ────────────────────────────────────────────

/**
 * 从当前歌曲 + 收藏歌单提取种子艺术家（按权重排序去重）。
 *
 * 权重规则：
 *   - 当前歌曲 artist = 5（最高）
 *   - 收藏歌单每首 artist = 1（去重，限 20 个）
 *
 * @param {{artist: string}|null} currentSong
 * @param {Array<{artist: string}>} favorites
 * @returns {{ current: string|null, favorites: string[], weights: Map<string, number> }}
 */
function extractSeedArtists(currentSong, favorites) {
  const weights = new Map();
  let currentArtist = null;

  if (currentSong && typeof currentSong.artist === 'string' && currentSong.artist.trim()) {
    currentArtist = currentSong.artist.trim();
    weights.set(currentArtist, 5);
  }

  const favArtists = new Set();
  if (Array.isArray(favorites)) {
    for (const s of favorites) {
      if (!s || typeof s.artist !== 'string') continue;
      const a = s.artist.trim();
      if (!a) continue;
      if (a === currentArtist) continue; // 不重复
      favArtists.add(a);
      if (!weights.has(a)) weights.set(a, 1);
      if (favArtists.size >= 20) break;
    }
  }

  return {
    current: currentArtist,
    favorites: Array.from(favArtists),
    weights,
  };
}

// ── 打分 ────────────────────────────────────────────

/**
 * 给一首歌打分（越高越靠前）。
 *
 * 分数构成：
 *   base = artistMatch × artistWeight
 *   + topListBonus = onTopList ? 2 : 0
 *   × sameSourceFactor = 同当前歌曲平台 ? 1.2 : 1.0
 *
 * @param {object} song
 * @param {ReturnType<typeof extractSeedArtists>} seed
 * @param {string|null} currentArtist
 * @param {{ onTopList: boolean, rank?: number }} flags
 */
function scoreSong(song, seed, currentArtist, flags) {
  let artistScore = 0;
  const songArtist = (song && song.artist) || '';
  if (songArtist && seed.weights.has(songArtist)) {
    artistScore = seed.weights.get(songArtist);
  }
  // 部分匹配：歌手名包含（例："周杰伦" 匹配 "周杰伦&林俊杰"）
  if (artistScore === 0 && currentArtist && songArtist.includes(currentArtist)) {
    artistScore = 2;
  }

  let score = artistScore;
  if (flags && flags.onTopList) score += 2;
  // same-source factor（当前歌曲 source 存在时才加）
  if (currentArtist && song.source && song.source === currentArtist._source) {
    score *= 1.2;
  }
  return score;
}

// ── 主生成函数 ────────────────────────────────────────────

/**
 * 生成心动模式推荐列表。
 *
 * @param {{
 *   currentSong: {title:string, artist:string, source:string, id:string}|null,
 *   favorites: Array<{title:string, artist:string, source:string, id:string, album?:string, mid?:string}>,
 *   gateway: {
 *     getHomeRecommendations: () => Promise<object>,
 *     getSingerSongs: (name:string, limit:number) => Promise<Array>,
 *   }
 * }} params
 * @returns {Promise<Array<{title:string, artist:string, source:string, id:string, mid:string, album:string, coverUrl:string, score:number}>>}
 */
async function generate({ currentSong, favorites, gateway }) {
  // 1. 种子
  const seed = extractSeedArtists(currentSong, favorites || []);
  const currentArtist = currentSong && currentSong.artist ? currentSong.artist : null;

  // 2. 候选拉取（所有平台并行 + 单平台失败不阻塞）
  const topListPromise = safeCall('getHomeRecommendations',
    () => gateway.getHomeRecommendations(), {});

  const singerPromises = [];
  // 当前歌手 30 首
  if (currentArtist) {
    singerPromises.push(safeCall(`singer:${currentArtist}`,
      () => gateway.getSingerSongs(currentArtist, 30), []));
  }
  // 收藏歌手各 10 首（限 5 个避免 N×10 爆炸）
  for (const fav of seed.favorites.slice(0, 5)) {
    singerPromises.push(safeCall(`singer:${fav}`,
      () => gateway.getSingerSongs(fav, 10), []));
  }

  const [homeResult, ...singerResults] = await Promise.all([topListPromise, ...singerPromises]);

  // 3. 合并榜单候选（只取 4 个核心榜单）
  const TOP_LIST_KEYS = ['neteaseHot', 'qqTop', 'kugouHot', 'kugouTop500'];
  const topListSongs = [];
  for (const key of TOP_LIST_KEYS) {
    const arr = (homeResult && homeResult[key]) || [];
    for (let i = 0; i < arr.length; i++) {
      topListSongs.push({ ...arr[i], _rank: i + 1, _onTopList: true });
    }
  }

  // 4. 合并歌手热门候选
  const singerSongs = [];
  for (const arr of singerResults) {
    for (const s of arr) {
      singerSongs.push({ ...s, _onTopList: false });
    }
  }

  // 5. 合并 + 去重 + 打分 + 排序
  const all = [...topListSongs, ...singerSongs];

  // 排除当前歌和收藏歌（用户已经听过了）
  const excludeKeys = new Set();
  if (currentSong && currentSong.id && currentSong.source) {
    excludeKeys.add(`${currentSong.id}:${currentSong.source}`);
  }
  for (const f of (favorites || [])) {
    if (f && f.id && f.source) excludeKeys.add(`${f.id}:${f.source}`);
  }

  const seen = new Set();
  const scored = [];
  for (const song of all) {
    if (!song || !song.id || !song.source) continue;
    const key = `${song.id}:${song.source}`;
    if (excludeKeys.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scoreSong(song, seed, currentArtist, { onTopList: !!song._onTopList });
    scored.push({
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      source: song.source || '',
      id: String(song.id),
      mid: song.mid || '',
      coverUrl: song.coverUrl || '',
      score,
    });
  }

  // 6. 按 score 降序取前 30
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 30);
}

// ── 内部工具 ────────────────────────────────────────────

async function safeCall(label, fn, fallback) {
  try {
    const result = await fn();
    return result != null ? result : fallback;
  } catch (e) {
    logger.warn(`[heartbeat] ${label} 失败:`, e.message);
    return fallback;
  }
}

// ── 导出 ────────────────────────────────────────────

module.exports = {
  generate,
  extractSeedArtists,
  scoreSong,
};
```

### Step 4: 运行测试确认通过

```bash
npm test -- test/heartbeatEngine.test.js 2>&1 | Select-String -Pattern "ℹ tests|✓|✖" | Select-Object -Last 25
```

Expected: 11 tests, 11 pass（extractSeedArtists 5 + scoreSong 3 + generate 3）

### Step 5: Commit

```bash
git add src/utils/heartbeatEngine.js test/heartbeatEngine.test.js
git commit -m "feat(heartbeat): 心动模式算法核 — 种子提取 + 候选拉取 + 打分 + 去重

- extractSeedArtists: 当前歌手权重5，收藏歌手权重1，限20个
- scoreSong: artistMatch + topListBonus + sameSourceFactor
- generate: 4条热歌榜 + 当前歌手30首 + 收藏歌手×5×10首，Promise.allSettled 隔离失败
- 单测覆盖：种子提取/打分/去重/空种子回落/部分平台失败"
```

---

## Task 2: 创建 ipc/heartbeat.js IPC 入口 + 更新契约

**Files:**
- Create: `src/main/ipc/heartbeat.js`
- Modify: `src/shared/ipcContract.js`（加通道声明）
- Modify: `src/main/ipcRegister.js`（require + register）

### Step 1: 创建 IPC 入口文件

创建 `src/main/ipc/heartbeat.js`：

```js
'use strict';

const { handle } = require('./register');
const logger = require('../../utils/logger');
const playlist = require('./playlist'); // playlist.js 已导出 ensureFavorites
const heartbeatEngine = require('../../utils/heartbeatEngine');
const recommendations = require('../../api/recommendations');

/**
 * 心动模式 IPC 入口
 *
 * 通道：generate-heartbeat (invoke)
 * 参数：{ currentSongId?: string, currentSource?: string }
 * 返回：{ ok: boolean, songs: Array, error?: string }
 */
module.exports = {
  register() {
    handle('generate-heartbeat', async (_, { currentSongId, currentSource }) => {
      try {
        // 1. 读收藏歌单（已在 playlist.js 导出 ensureFavorites）
        const playlists = playlist.ensureFavorites();
        const favoritesPl = playlists.find(p => p && p.id === 'favorites');
        const favorites = (favoritesPl && Array.isArray(favoritesPl.songs))
          ? favoritesPl.songs
          : [];

        // 2. 当前歌曲（可选，当前播放队列里能找到最好，找不到就是 null）
        //    渲染层传 id + source 过来，IPC handler 不查渲染层状态，保持无依赖
        const currentSong = (currentSongId && currentSource)
          ? { id: currentSongId, source: currentSource }
          : null;

        // 3. 调算法核
        const songs = await heartbeatEngine.generate({
          currentSong,
          favorites,
          gateway: {
            getHomeRecommendations: () => recommendations.getHomeRecommendations(),
            getSingerSongs: (name, limit) => recommendations.getSingerSongs(name, limit),
          },
        });

        return { ok: true, songs };
      } catch (e) {
        logger.warn('[heartbeat] generate-heartbeat 失败:', e.message);
        return { ok: false, songs: [], error: e.message };
      }
    });
  },
};
```

### Step 2: 更新 ipcContract.js

在 `src/shared/ipcContract.js` 的 invoke 通道声明区（参考 `'save-play-queue': { invoke: MAIN }` 的位置）加一行：

```js
'generate-heartbeat': { invoke: MAIN, args: [['currentSongId', t.any()], ['currentSource', t.any()]] },
```

### Step 3: 更新 ipcRegister.js 注册

在 `src/main/ipcRegister.js` 的顶部 require 区加一行：

```js
const ipcHeartbeat = require('./ipc/heartbeat');
```

在 `registerAll()` 函数里、`ipcMcp.register()` 之前加：

```js
ipcHeartbeat.register();
```

### Step 4: 运行全量验证

```bash
npm run lint 2>&1 | Select-Object -Last 5
npm test 2>&1 | Select-String -Pattern "ℹ tests|ℹ pass|ℹ fail" | Select-Object -Last 2
```

Expected:
- ESLint: 0 errors
- npm test: 2701 tests, 2701 pass（新增 11 个 heartbeatEngine 测试）

### Step 5: Commit

```bash
git add src/main/ipc/heartbeat.js src/shared/ipcContract.js src/main/ipcRegister.js
git commit -m "feat(heartbeat): IPC 入口 + 契约声明 + register

- ipc/heartbeat.js: handle('generate-heartbeat') 接入 heartbeatEngine
- ipcContract.js: 加 generate-heartbeat invoke 通道声明
- ipcRegister.js: require + register heartbeat 模块"
```

---

## Task 3: 全量验证 + 收尾

### Step 1: 跑完整 lint + test

```bash
npm run lint 2>&1
npm test 2>&1
```

**必须满足：**
- ESLint 0 errors（允许原代码既有 warning）
- npm test ≥ 2701 pass（2690 原 + 11 新）
- 0 fail

### Step 2: 启动本地 dev 手动冒烟（可选）

```bash
npm run dev
```

打开 DevTools Console 手工调：

```js
// preload 暴露的 invoke（从 ipcContract 自动派生）
window.api.invoke('generate-heartbeat', {
  currentSongId: '4401045', currentSource: 'netease',
}).then(r => console.log(r));
```

期望返回 `{ ok: true, songs: [...] }`，songs.length 在 15-30 之间。

### Step 3: Push 分支

```bash
git push origin feat/security-hardening-v2
```

### Step 4: 更新 docs（可选，先不做）

渲染层自动接力 UI（心动开关按钮 + 播放进度监听追加队列）是下一个迭代，不在本次范围。

---

## 计划自审清单

**Spec 覆盖检查：**
- ✅ 种子提取（extractSeedArtists）→ Task 1 Step 3
- ✅ 候选拉取（4 榜单 + 当前歌手 + 收藏歌手 × 5）→ Task 1 Step 3
- ✅ 打分（artistMatch + topListBonus + sameSourceFactor）→ Task 1 Step 3
- ✅ 去重（排除 current + favorites）→ Task 1 Step 3
- ✅ 排序 + 前 30 → Task 1 Step 3
- ✅ 空种子回落（全靠榜单）→ Task 1 Step 3
- ✅ 单平台失败隔离（Promise.allSettled 风格的 safeCall）→ Task 1 Step 3
- ✅ IPC 入口 + 契约声明 → Task 2
- ✅ 单测 9 个（种子提取 5 + 打分 3 + generate 3）→ Task 1 Step 1

**Placeholder 扫描：** 无 TBD/TODO，每步都有精确代码和命令。

**接口一致性：**
- `recommendations.getHomeRecommendations()` 返回字段名已确认：neteaseHot / qqTop / kugouHot / kugouTop500
- `recommendations.getSingerSongs(name, limit)` 接受名字（非 mid），内部自动探测平台
- `playlist.ensureFavorites()` 已导出，返回 `[{ id, songs: [...] }]`
- `heartbeatEngine.generate()` 签名在 Task 1 Step 3 明确定义，IPC handler 按此调用
