/**
 * 心动模式（Heartbeat Mode）算法核
 *
 * 纯函数 + 薄状态，完全独立于主进程 —— 所有平台访问通过注入的 gateway。
 * 三条公开路径：extractSeedArtists → scoreSong → generate。
 */

const logger = require('./logger');

/** 当前歌曲 artist 的权重（强烈锚点） */
const CURRENT_ARTIST_WEIGHT = 5;
/** 收藏歌单 artist 的基础权重 */
const FAVORITE_ARTIST_WEIGHT = 1;
/** 收藏 artist 上限，防止爆炸 */
const MAX_FAVORITE_ARTISTS = 20;
/** 收藏歌手拉取候选时的并发上限 */
const MAX_FAVORITE_SINGER_FETCH = 5;
/** 当前歌手拉取数量 */
const CURRENT_SINGER_LIMIT = 30;
/** 收藏歌手每人拉取数量 */
const FAVORITE_SINGER_LIMIT = 10;
/** 榜单命中加分 */
const TOPLIST_BONUS = 2;
/** 同来源乘数 */
const SAME_SOURCE_FACTOR = 1.2;
/** 部分匹配 artist 分数 */
const PARTIAL_MATCH_SCORE = 2;
/** 最终输出截断 */
const FINAL_LIMIT = 30;

/** 需要纳入候选池的 4 条热歌榜 key */
const TARGET_BOARD_KEYS = ['neteaseHot', 'qqTop', 'kugouHot', 'kugouTop500'];

// ── 内部工具 ───────────────────────────────────────────────────────

async function safeCall(label, fn, fallback) {
  try {
    const r = await fn();
    return r != null ? r : fallback;
  } catch (e) {
    logger.warn(`[heartbeat] ${label} 失败:`, e.message);
    return fallback;
  }
}

function songKey(s) {
  return `${s.id}:${s.source}`;
}

// ── 三条公开函数 ───────────────────────────────────────────────────

/**
 * 从当前歌曲和收藏歌单提取「种子艺术家」及权重表。
 *
 * @param {{ artist?: string, source?: string } | null} currentSong
 * @param {Array<{ artist?: string }>} favorites
 * @returns {{
 *   current: string|null,
 *   favorites: string[],
 *   weights: Map<string, number>,
 *   currentSource: string|null   // 扩展字段：供 scoreSong 做同来源判定
 * }}
 */
function extractSeedArtists(currentSong, favorites) {
  const weights = new Map();
  let currentArtist = null;
  let currentSource = null;

  if (currentSong && currentSong.artist) {
    currentArtist = currentSong.artist;
    currentSource = currentSong.source || null;
    weights.set(currentArtist, CURRENT_ARTIST_WEIGHT);
  }

  const favArtists = [];
  if (Array.isArray(favorites)) {
    for (const fav of favorites) {
      if (!fav || !fav.artist) continue;
      const a = fav.artist;
      if (a === currentArtist) continue;          // 不重复进 favorites
      if (weights.has(a)) continue;               // 已见过（可能在之前的 fav 里重复）
      weights.set(a, FAVORITE_ARTIST_WEIGHT);
      favArtists.push(a);
      if (favArtists.length >= MAX_FAVORITE_ARTISTS) break;
    }
  }

  return { current: currentArtist, favorites: favArtists, weights, currentSource };
}

/**
 * 为单首候选歌打分。
 *
 * @param {{ artist?: string, source?: string }} song
 * @param {ReturnType<typeof extractSeedArtists>} seed
 * @param {string|null} currentArtist   // 当前歌曲 artist（字符串或 null）
 * @param {{ onTopList: boolean }} flags
 * @returns {number}
 */
function scoreSong(song, seed, currentArtist, flags) {
  if (!song || !song.artist) return 0;

  let artistScore = 0;
  if (seed && seed.weights && seed.weights.has(song.artist)) {
    artistScore = seed.weights.get(song.artist);
  } else if (currentArtist && typeof currentArtist === 'string'
             && song.artist.includes(currentArtist)) {
    artistScore = PARTIAL_MATCH_SCORE;
  }

  let base = artistScore;

  if (flags && flags.onTopList) {
    base += TOPLIST_BONUS;
  }

  if (seed && seed.currentSource && song.source === seed.currentSource) {
    base = base * SAME_SOURCE_FACTOR;
  }

  return Math.round(base * 100) / 100;
}

/**
 * 心动模式主流程：拉候选 → 打分 → 去重 → 截断。
 *
 * @param {{
 *   currentSong: { title?: string, artist?: string, source?: string, id?: string } | null,
 *   favorites: Array<{ title?: string, artist?: string, source?: string, id?: string }>,
 *   gateway: {
 *     getHomeRecommendations(): Promise<object>,
 *     getSingerSongs(name: string, limit: number): Promise<Array>
 *   }
 * }} param0
 * @returns {Promise<Array<{ title, artist, album, source, id, mid, coverUrl, score }>>}
 */
async function generate({ currentSong, favorites, gateway }) {
  const seed = extractSeedArtists(currentSong, favorites || []);
  const currentArtist = seed.current;

  // 1) 并行拉候选（全部 safeCall，单平台失败不阻塞）
  const recPromise = safeCall('homeRecommendations', () => gateway.getHomeRecommendations(), {});

  const currentSingerPromise = currentArtist
    ? safeCall(`singerSongs:${currentArtist}`,
        () => gateway.getSingerSongs(currentArtist, CURRENT_SINGER_LIMIT), [])
    : Promise.resolve([]);

  // 收藏歌手各 10 首（限 5 个）
  const favSingerArtists = seed.favorites.slice(0, MAX_FAVORITE_SINGER_FETCH);
  const favSingerPromises = favSingerArtists.map(name =>
    safeCall(`singerSongs:${name}`,
      () => gateway.getSingerSongs(name, FAVORITE_SINGER_LIMIT), [])
  );

  const [recResult, currentSingerResult, ...favSingerResults] = await Promise.all([
    recPromise, currentSingerPromise, ...favSingerPromises,
  ]);

  // 2) 提取 4 条目标榜单候选，打 _onTopList=true
  const toplistCandidates = [];
  for (const key of TARGET_BOARD_KEYS) {
    const arr = recResult[key];
    if (Array.isArray(arr)) {
      for (const s of arr) {
        toplistCandidates.push({ ...s, _onTopList: true });
      }
    }
  }

  // 3) 歌手热门候选（非榜单），打 _onTopList=false
  const singerCandidates = [];
  const allSingerArrays = [currentSingerResult, ...favSingerResults];
  for (const arr of allSingerArrays) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      singerCandidates.push({ ...s, _onTopList: false });
    }
  }

  // 4) 合并
  let all = [...toplistCandidates, ...singerCandidates];

  // 5) 排除当前歌 + 所有收藏歌（id+source key）
  const excludedKeys = new Set();
  if (currentSong && currentSong.id) {
    excludedKeys.add(songKey({ id: currentSong.id, source: currentSong.source || '' }));
  }
  if (Array.isArray(favorites)) {
    for (const f of favorites) {
      if (f && f.id) excludedKeys.add(songKey({ id: f.id, source: f.source || '' }));
    }
  }

  // 6) 按 songKey 去重
  const seen = new Set();
  const deduped = [];
  for (const s of all) {
    const k = songKey(s);
    if (excludedKeys.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
  }

  // 7) 打分 + 排序
  const withScore = deduped.map(s => ({
    title: s.title,
    artist: s.artist,
    album: s.album,
    source: s.source,
    id: s.id,
    mid: s.mid,
    coverUrl: s.coverUrl,
    score: scoreSong(s, seed, currentArtist, { onTopList: !!s._onTopList }),
  }));

  withScore.sort((a, b) => b.score - a.score);

  // 8) 取前 N
  return withScore.slice(0, FINAL_LIMIT);
}

module.exports = { generate, extractSeedArtists, scoreSong };
