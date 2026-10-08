/**
 * 电台取数（3-A 主进程侧）
 *
 * 为什么复用 search-music 而不是 get-singer-songs
 * ---------------------------------------------
 * 看似该走「按歌手取热门作品」，但那条路要 singerMid / artistId，
 * 而**各平台搜索结果里只有歌手名、没有歌手 id**（netease 只映射
 * `artists[].name`、kugou 只给 `SingerName`、qq 只给 `singer[].name`）。
 * 于是必须先 search-singer 换 id、再 get-singer-songs，多两次请求且
 * 只覆盖部分平台。
 *
 * 直接用「歌手 + 歌名」当关键词走现成的聚合搜索，一跳拿到可播条目，
 * 8 个平台通吃，还能顺带跨源。代价是结果里可能混进别的歌手/别的歌，
 * 交给 radio.js 的纯函数按 trackKey 过滤即可。
 */

const logger = require('../utils/logger');

/** 一次取多少候选（够电台随手挑，不必每次都请求） */
const DEFAULT_RADIO_POOL = 30;

/** 歌手名清洗：去掉 feat./ft. 之类，免得搜不准 */
function cleanArtistName(artist) {
  return String(artist || '')
    .split(/\s*(?:feat\.|ft\.|featuring|with)\s*/i)[0]
    .split('/')[0]
    .trim();
}

/**
 * 取某位歌手的候选曲目（用于电台续播）
 *
 * @param {Object} seed 刚播完的曲目 { source, id, title, artist, duration }
 * @param {Object} [opts]
 * @param {number} [opts.limit] 取多少条（默认 30，上限 100）
 * @param {string} [opts.source] 只在该平台搜；不给则跨源聚合
 * @param {Object} [deps] 注入依赖（单测用）：{ searchMusic }
 * @returns {Promise<{songs:Array, artist:string, reason:string}>}
 *   reason: 'ok' | 'no-artist' | 'search-failed' | 'empty'
 */
async function fetchRadioPool(seed, opts, deps) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const d = (deps && typeof deps === 'object') ? deps : {};

  const artist = cleanArtistName(seed && seed.artist);
  if (!artist) {
    // 拿不到歌手名就别猜——宁可电台停下，也不要放一堆不相干的歌
    return { songs: [], artist: '', reason: 'no-artist' };
  }

  const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0
    ? Math.min(Math.floor(Number(o.limit)), 100)
    : DEFAULT_RADIO_POOL;

  const search = typeof d.searchMusic === 'function'
    ? d.searchMusic
    : (kw, src) => require('../api').searchMusic(kw, src, 1);

  let res;
  try {
    // 歌手 + 歌名 拼在一起当关键词：只搜歌手名会被同名歌手与各种翻唱淹没
    const kw = seed && seed.title ? `${artist} ${seed.title}` : artist;
    res = await search(kw, o.source || 'all');
  } catch (e) {
    logger.warn('[radio] 取同歌手作品失败:', e && e.message);
    return { songs: [], artist, reason: 'search-failed' };
  }

  const songs = Array.isArray(res && res.songs) ? res.songs : [];
  if (!songs.length) return { songs: [], artist, reason: 'empty' };

  return { songs: songs.slice(0, limit), artist, reason: 'ok' };
}

module.exports = { fetchRadioPool, cleanArtistName, DEFAULT_RADIO_POOL };