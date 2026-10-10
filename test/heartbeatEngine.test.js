/**
 * 单元测试：src/utils/heartbeatEngine.js
 *
 * 跑：npm test -- test/heartbeatEngine.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractSeedArtists, scoreSong, generate } = require('../src/utils/heartbeatEngine');

// ── helpers ───────────────────────────────────────────────────────

let idCounter = 0;
const SOURCES = ['netease', 'qq', 'kugou'];

function mockSong(overrides = {}) {
  idCounter += 1;
  const source = overrides.source || SOURCES[idCounter % SOURCES.length];
  return {
    title: overrides.title || `测试歌曲${idCounter}`,
    artist: overrides.artist || '未知歌手',
    album: overrides.album || '未知专辑',
    source,
    id: overrides.id || `id-${idCounter}`,
    mid: overrides.mid || `mid-${idCounter}`,
    coverUrl: overrides.coverUrl || '',
    rank: overrides.rank || idCounter,
  };
}

function mockGateway({ failBoards = [], failSingerNames = [] } = {}) {
  const neteaseHot = Array.from({ length: 5 }, (_, i) =>
    mockSong({ title: `网易云热歌${i + 1}`, artist: ['周杰伦', '林俊杰', '五月天', '薛之谦', '邓紫棋'][i % 5], source: 'netease', id: `nh-${i + 1}` })
  );
  const qqTop = Array.from({ length: 5 }, (_, i) =>
    mockSong({ title: `QQ热歌${i + 1}`, artist: ['周杰伦', '林俊杰', '五月天', '薛之谦', '邓紫棋'][i % 5], source: 'qq', id: `qt-${i + 1}` })
  );
  const kugouHot = Array.from({ length: 5 }, (_, i) =>
    mockSong({ title: `酷狗热歌${i + 1}`, artist: ['周杰伦', '林俊杰', '五月天', '薛之谦', '邓紫棋'][i % 5], source: 'kugou', id: `kh-${i + 1}` })
  );
  const kugouTop500 = Array.from({ length: 5 }, (_, i) =>
    mockSong({ title: `酷狗Top500-${i + 1}`, artist: ['周杰伦', '林俊杰', '五月天', '薛之谦', '邓紫棋'][i % 5], source: 'kugou', id: `kt-${i + 1}` })
  );

  const boards = { neteaseHot, qqTop, kugouHot, kugouTop500 };

  return {
    async getHomeRecommendations() {
      if (failBoards.includes('ALL')) throw new Error('全部榜单炸了');
      const result = {};
      for (const [k, v] of Object.entries(boards)) {
        result[k] = failBoards.includes(k) ? [] : v;
      }
      // 额外返回一些非目标 key（应该被忽略）
      result.neteaseTops = failBoards.includes('neteaseTops') ? [] : [];
      result.neteaseNew = [];
      result.neteaseOriginal = [];
      result.neteasePlaylists = [];
      result.qqRecommend = [];
      result.qqOfficial = [];
      result.biliRanking = [];
      return result;
    },

    async getSingerSongs(name, limit) {
      if (failSingerNames.includes(name)) throw new Error(`歌手 ${name} 拉不到`);
      const n = Math.min(limit, 5);
      return Array.from({ length: n }, (_, i) =>
        mockSong({
          title: `${name}热门${i + 1}`,
          artist: name,
          source: SOURCES[(idCounter + i) % 3],
          id: `${name}-${i + 1}-${idCounter}`,
        })
      );
    },
  };
}

// ── extractSeedArtists ─────────────────────────────────────────────

test('extractSeedArtists: 当前歌曲 artist 权重 5', () => {
  const currentSong = { title: '双截棍', artist: '周杰伦', source: 'netease', id: 'abc' };
  const seed = extractSeedArtists(currentSong, []);
  assert.strictEqual(seed.weights.get('周杰伦'), 5);
  assert.strictEqual(seed.current, '周杰伦');
});

test('extractSeedArtists: 收藏歌手权重 1 + 去重', () => {
  const currentSong = { title: '双截棍', artist: '周杰伦', source: 'netease', id: 'abc' };
  const favorites = [
    { artist: '林俊杰' },
    { artist: '林俊杰' }, // 重复
    { artist: '五月天' },
  ];
  const seed = extractSeedArtists(currentSong, favorites);
  assert.strictEqual(seed.weights.get('林俊杰'), 1);
  assert.strictEqual(seed.weights.get('五月天'), 1);
  // 林俊杰只出现一次
  const jjEntries = [...seed.weights.entries()].filter(([k]) => k === '林俊杰');
  assert.strictEqual(jjEntries.length, 1);
});

test('extractSeedArtists: 收藏歌手限 20', () => {
  const currentSong = { artist: '周杰伦' };
  const favorites = Array.from({ length: 50 }, (_, i) => ({ artist: `歌手${i}` }));
  const seed = extractSeedArtists(currentSong, favorites);
  // 当前 artist 算 1，加上 20 个收藏 = 21
  assert.strictEqual(seed.weights.size, 21);
  assert.ok(seed.favorites.length <= 20);
});

test('extractSeedArtists: 当前 artist 不进 favorites 数组', () => {
  const currentSong = { artist: '周杰伦' };
  const favorites = [{ artist: '周杰伦' }, { artist: '林俊杰' }];
  const seed = extractSeedArtists(currentSong, favorites);
  assert.ok(!seed.favorites.includes('周杰伦'), '当前 artist 不应出现在 favorites 数组中');
  assert.ok(seed.favorites.includes('林俊杰'));
});

test('extractSeedArtists: 全部空 → weights 空 + current null', () => {
  const seed = extractSeedArtists(null, []);
  assert.strictEqual(seed.weights.size, 0);
  assert.strictEqual(seed.current, null);
  assert.deepStrictEqual(seed.favorites, []);
});

// ── scoreSong ──────────────────────────────────────────────────────

test('scoreSong: 同当前 artist 且 onTopList 得高分 (>5)', () => {
  const seed = extractSeedArtists({ artist: '周杰伦', source: 'netease' }, [{ artist: '林俊杰' }]);
  const song = { artist: '周杰伦', source: 'netease' };
  const score = scoreSong(song, seed, '周杰伦', { onTopList: true });
  // artistScore=5 + topList=2 = 7，同来源 ×1.2 = 8.4
  assert.ok(score > 5, `期望 > 5，实际 ${score}`);
  assert.ok(score >= 7 * 1.19, `应有同来源乘数，实际 ${score}`);
});

test('scoreSong: 收藏 artist 且 onTopList 得中分 (>=3)', () => {
  const seed = extractSeedArtists({ artist: '周杰伦', source: 'qq' }, [{ artist: '林俊杰' }]);
  const song = { artist: '林俊杰', source: 'qq' };
  const score = scoreSong(song, seed, '周杰伦', { onTopList: true });
  // artistScore=1 + topList=2 = 3
  assert.ok(score >= 3, `期望 >= 3，实际 ${score}`);
});

test('scoreSong: 完全无关 artist 得低分 (<1)', () => {
  const seed = extractSeedArtists({ artist: '周杰伦', source: 'netease' }, [{ artist: '林俊杰' }]);
  const song = { artist: '凤凰传奇', source: 'qq' };
  const score = scoreSong(song, seed, '周杰伦', { onTopList: false });
  assert.ok(score < 1, `期望 < 1，实际 ${score}`);
});

// ── generate 端到端 ────────────────────────────────────────────────

test('generate: 正常情况下返回 songs 数组（长度 > 0）', async () => {
  const currentSong = { title: '双截棍', artist: '周杰伦', source: 'netease', id: 'cur-1' };
  const favorites = [{ title: '修炼爱情', artist: '林俊杰', source: 'qq', id: 'fav-1', album: '', mid: '' }];
  const gateway = mockGateway();
  const songs = await generate({ currentSong, favorites, gateway });
  assert.ok(Array.isArray(songs));
  assert.ok(songs.length > 0, `应有候选，实际 ${songs.length}`);
  // 每首必须有 score
  for (const s of songs) {
    assert.ok(typeof s.score === 'number', '每首必须有 score 字段');
  }
  // 排序：分数降序
  for (let i = 1; i < songs.length; i++) {
    assert.ok(songs[i - 1].score >= songs[i].score, '应按 score 降序');
  }
});

test('generate: 当前歌和收藏歌被去重', async () => {
  const currentSong = { title: '双截棍', artist: '周杰伦', source: 'netease', id: 'cur-exact' };
  const favorites = [{ title: '修炼爱情', artist: '林俊杰', source: 'qq', id: 'fav-exact', album: '', mid: '' }];

  // gateway 里故意注入 id 完全一样的候选
  const gw = mockGateway();
  const origGetHome = gw.getHomeRecommendations.bind(gw);
  gw.getHomeRecommendations = async function () {
    const result = await origGetHome();
    result.neteaseHot.push(
      mockSong({ id: 'cur-exact', source: 'netease', artist: '周杰伦', title: '双截棍-重复' }),
      mockSong({ id: 'fav-exact', source: 'qq', artist: '林俊杰', title: '修炼爱情-重复' }),
    );
    return result;
  };

  const songs = await generate({ currentSong, favorites, gateway: gw });
  const hasCur = songs.some(s => s.id === 'cur-exact' && s.source === 'netease');
  const hasFav = songs.some(s => s.id === 'fav-exact' && s.source === 'qq');
  assert.ok(!hasCur, '当前歌应被排除');
  assert.ok(!hasFav, '收藏歌应被排除');
});

test('generate: 网易云榜单失败时不阻塞（部分平台失败隔离）', async () => {
  const currentSong = { title: '双截棍', artist: '周杰伦', source: 'netease', id: 'cur-x' };
  const gateway = mockGateway({ failBoards: ['neteaseHot'] });
  const songs = await generate({ currentSong, favorites: [], gateway });
  assert.ok(Array.isArray(songs));
  assert.ok(songs.length >= 2, `网易云挂了其他榜应该还有候选，实际 ${songs.length}`);
});

test('generate: 空种子（null + []）时靠榜单回落，所有 score >= 2', async () => {
  const gateway = mockGateway();
  const songs = await generate({ currentSong: null, favorites: [], gateway });
  assert.ok(Array.isArray(songs));
  assert.ok(songs.length > 0);
  // 没有 artist 种子，候选都来自榜单 → onTopList=true → 至少 +2
  for (const s of songs) {
    assert.ok(s.score >= 2, `空种子时 score 应 >= 2（榜单加分），实际 ${s.score}`);
  }
});

console.log('[heartbeatEngine.test.js] 11 tests loaded.');
