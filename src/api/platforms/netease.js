/**
 * 网易云音乐平台实现
 *
 * 依赖：
 *   - ncm: NeteaseCloudMusicApi 第三方 SDK
 *   - getCookie(platform): 从 cookieStore 读 cookie
 */

const ncm = require('NeteaseCloudMusicApi');
const logger = require('../../utils/logger');
const { asSong } = require('../songShape');
const { AppError } = require('../../shared/errors');

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page
 * @param {string} cookie
 * @returns {Promise<Array>}
 */
async function neteaseSearch(keyword, page = 1, cookie = '') {
  if (!keyword || typeof keyword !== 'string') return [];
  const res = await ncm.search({
    keywords: keyword,
    limit: 30,
    offset: (page - 1) * 30,
    ...(cookie ? { cookie } : {}),
  });
  const songs = res?.body?.result?.songs || [];
  return songs.map((s) => asSong({
    id: String(s.id),
    title: s.name,
    artist: (s.artists || []).map(a => a.name).join(' / '),
    album: s.album ? s.album.name : '',
    albumMid: s.album ? String(s.album.id || '') : '',
    cover: s.album && s.album.picUrl ? s.album.picUrl + '?param=300y300' : '',
    duration: s.duration,
    source: 'netease',
    fee: s.fee,
  }));
}

/**
 * 获取下载 URL（自动降级链：lossless → hq → standard）
 * @param {string} id
 * @param {string} quality - lossless | hq | standard
 * @param {string} cookie
 * @returns {Promise<{url,ext,br,size,requestedBr}|{error,code,fatal}>}
 */
async function neteaseGetUrl(id, quality, cookie = '') {
  // 自动降级链
  const qualityChain = {
    lossless: [999000, 320000, 128000],
    hq: [320000, 128000],
    standard: [128000],
  }[quality] || [128000];

  for (const br of qualityChain) {
    try {
      const res = await ncm.song_url({
        id: parseInt(id),
        br,
        ...(cookie ? { cookie } : {}),
      });
      const d = res?.body?.data?.[0];
      if (d && d.url) {
        return { url: d.url, ext: d.type || 'mp3', br: d.br, size: d.size, requestedBr: br };
      }
      if (d && d.url === null) {
        // 修复 B12：区分 VIP（fee=1）和下架/无版权（fee=0）
        // d.fee: 0=免费, 1=VIP, 4=专辑, 8=低品质免费
        if (d.fee === 1) {
          return AppError.vipRequired('网易云');
        }
        // fee=0 但 url=null：下架 / 版权限制 / 地区限制
        return AppError.copyright('网易云');
      }
    } catch (e) {
      logger.warn(`[netease] getPlayUrl 失败 (id=${id}, br=${br}):`, e.message);
    }
  }
  // 所有品质都失败 — 标记 fatal
  return AppError.unavailable('网易云');
}

/**
 * 按 id 拉单曲详情（粘贴链接智能识别用）
 * @param {string} id 歌曲 id
 * @returns {Promise<object|null>} 标准歌曲对象（与 searchMusic 返回项同构），拉不到返回 null
 */
async function neteaseGetSongDetail(id) {
  try {
    const res = await ncm.song_detail({ ids: String(id) });
    const s = res?.body?.songs?.[0];
    if (!s) return null;
    return {
      id: String(s.id),
      title: s.name || '',
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || '',
      cover: s.al?.picUrl ? s.al.picUrl + '?param=300y300' : '',
      duration: s.dt || 0,
      source: 'netease',
    };
  } catch (e) {
    logger.warn(`[netease] song_detail 失败 (id=${id}):`, e.message || e);
    return null;
  }
}

/**
 * 获取歌词
 * @param {string} id
 * @returns {Promise<string>}
 */
async function neteaseGetLyrics(id) {
  try {
    const res = await ncm.lyric({ id: parseInt(id) });
    if (res?.body?.lrc?.lyric) return res.body.lrc.lyric;
  } catch (e) {
    logger.warn('[netease] getLyrics 失败:', e.message);
  }
  return '';
}

/**
 * 验证 Cookie
 * @param {string} cookie
 * @returns {Promise<{valid, nickname, vip}>}
 */
async function neteaseVerifyCookie(cookie) {
  try {
    const res = await ncm.login_status({ cookie });
    const profile = res?.body?.profile;
    if (profile && profile.userId) {
      return { valid: true, nickname: profile.nickname || '用户', vip: false };
    }
  } catch (e) {
    logger.warn('网易云 Cookie 验证失败:', e.message || e);
  }
  return { valid: false };
}

/**
 * 获取歌单详情
 * @param {string} id
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function neteaseGetPlaylistDetail(id, limit = 200, cookie = '') {
  const res = await ncm.playlist_detail({
    id: parseInt(id),
    limit,
    ...(cookie ? { cookie } : {}),
  });
  const tracks = (res?.body?.playlist?.tracks || []).slice(0, limit);
  return tracks.map(t => ({
    id: String(t.id),
    title: t.name,
    artist: (t.ar || []).map(a => a.name).join(' / '),
    album: t.al?.name || '',
    albumMid: String(t.al?.id || ''),
    cover: t.al?.picUrl ? t.al.picUrl + '?param=300y300' : '',
    duration: t.dt,
    source: 'netease',
  }));
}

/**
 * 网易云排行榜列表（静态 ID 映射）
 */
const NETEASE_TOP_MAP = {
  飙升榜: 19723756,
  热歌榜: 3778678,
  新歌榜: 3779629,
  原创榜: 2884035,
};

async function neteaseGetTopList(name, limit = 10) {
  const id = NETEASE_TOP_MAP[name];
  if (!id) return [];
  return neteaseGetPlaylistDetail(id, limit);
}

async function neteaseGetRecommendPlaylists(limit = 6) {
  try {
    const res = await ncm.personalized({ limit });
    const rawList = res?.body?.result || res?.result || res?.body || [];
    return (Array.isArray(rawList) ? rawList : []).map(p => ({
      id: String(p.id),
      name: p.name,
      cover: p.picUrl || '',
      playCount: p.playCount,
      source: 'netease',
    }));
  } catch (e) {
    logger.warn('[netease] playlist 失败:', e.message);
    return [];
  }
}

/**
 * 搜索专辑
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{albums: Array, total: number, page: number}>}
 */
async function neteaseSearchAlbum(keyword, page = 1) {
  const res = await ncm.search({
    keywords: keyword,
    type: 10, // 专辑
    limit: 30,
    offset: (page - 1) * 30,
  });
  const albums = res?.body?.result?.albums || [];
  const total = res?.body?.result?.albumCount || 0;
  return {
    albums: albums.map(a => ({
      id: String(a.id),
      mid: String(a.id),
      title: a.name,
      artist: a.artist?.name || '',
      cover: a.picUrl ? a.picUrl + '?param=300y300' : '',
      songCount: a.size || 0,
      publishTime: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : '',
      source: 'netease',
    })),
    total,
    page,
  };
}

/**
 * 搜索歌手
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{singers: Array, total: number, page: number}>}
 */
async function neteaseSearchSinger(keyword, page = 1) {
  const res = await ncm.search({
    keywords: keyword,
    type: 100, // 歌手
    limit: 20,
    offset: (page - 1) * 20,
  });
  const artists = res?.body?.result?.artists || [];
  const total = res?.body?.result?.artistCount || 0;
  return {
    singers: artists.map(a => ({
      id: String(a.id),
      mid: String(a.id),
      name: a.name,
      avatar: a.picUrl || '',
      songCount: a.musicSize || 0,
      albumCount: a.albumSize || 0,
      mvCount: a.mvSize || 0,
      source: 'netease',
    })),
    total,
    page,
  };
}

/**
 * 获取歌手热门歌曲（前 50 首）
 */
async function neteaseGetSingerSongs(singerId, limit = 50, cookie = '') {
  const res = await ncm.artists({
    id: parseInt(singerId),
    limit: Math.min(limit, 100),
    ...(cookie ? { cookie } : {}),
  });
  const songs = res?.body?.hotSongs || [];
  return songs.slice(0, limit).map(s => ({
    id: String(s.id),
    title: s.name,
    artist: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al?.name || '',
    albumMid: String(s.al?.id || ''),
    cover: s.al?.picUrl ? s.al.picUrl + '?param=300y300' : '',
    duration: s.dt || 0,
    source: 'netease',
  }));
}

/**
 * 获取歌手专辑列表
 */
async function neteaseGetSingerAlbums(singerId, pageNo = 1, pageSize = 20) {
  const res = await ncm.artist_album({
    id: parseInt(singerId),
    limit: pageSize,
    offset: (pageNo - 1) * pageSize,
  });
  const albums = res?.body?.hotAlbums || [];
  const total = res?.body?.artist?.albumSize || albums.length;
  return {
    albums: albums.map(a => ({
      id: String(a.id),
      mid: String(a.id),
      title: a.name,
      artist: a.artist?.name || '',
      cover: a.picUrl ? a.picUrl + '?param=300y300' : '',
      songCount: a.size || 0,
      publishTime: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : '',
      source: 'netease',
    })),
    total,
    page: pageNo,
  };
}

/**
 * 获取专辑内歌曲
 */
async function neteaseGetAlbumSongs(albumId, limit = 999, cookie = '') {
  const res = await ncm.album({
    id: parseInt(albumId),
    ...(cookie ? { cookie } : {}),
  });
  const songs = res?.body?.songs || [];
  return songs.slice(0, limit).map(s => ({
    id: String(s.id),
    title: s.name,
    artist: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al?.name || '',
    cover: s.al?.picUrl ? s.al.picUrl + '?param=300y300' : '',
    duration: s.dt || 0,
    source: 'netease',
  }));
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'netease',
  name: '网易云音乐',
  nameEn: 'NetEase',
  icon: '🎵',
  badge: { bg: 'rgba(230,50,50,.15)', fg: 'var(--c-danger)', border: 'rgba(230,50,50,.2)' },
  hosts: { origins: ['https://music.163.com'] },
  linkPatterns: [
    // 歌曲：/song?id=123 或 /song/#/123（旧版 hash 路由）
    { type: 'song', re: /music\.163\.com\/song(?:\/#\/|#\/)?(?:\?id=|\/)?(\d{4,15})/, extract: m => m[1] },
    // 专辑：/album?id=123 或 /album/123
    { type: 'album', re: /music\.163\.com\/album(?:\?id=|\/)(\d{4,15})/, extract: m => m[1] },
    // 歌单：/playlist?id=123（当作专辑处理——上层逐首入队）
    { type: 'playlist', re: /music\.163\.com\/playlist(?:\?id=|\/)(\d{4,15})/, extract: m => m[1] },
  ],
  // aggregateLimit 10：首位源（原先由数组下标 i===0/1 隐式决定的 10 条，
  // 改为显式声明，避免插入新平台时静默改变聚合条数）
  policies: { order: 10, fallbackSource: true, probeable: true, aggregateLimit: 10 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: neteaseSearch,
  getUrl: neteaseGetUrl,
  getLyrics: neteaseGetLyrics,
  getSongDetail: neteaseGetSongDetail,
  verifyCookie: neteaseVerifyCookie,
  searchAlbum: neteaseSearchAlbum,
  getAlbumSongs: neteaseGetAlbumSongs,
  searchSinger: neteaseSearchSinger,
  getSingerSongs: neteaseGetSingerSongs,
  getSingerAlbums: neteaseGetSingerAlbums,
  // 歌单 / 推荐域（v3 阶段 1 收尾：正式纳入 manifest，
  // 使 gateway 与 capabilities 可从方法存在性推导，不再靠硬编码映射表）
  getPlaylistSongs: neteaseGetPlaylistDetail,
  getTopList: neteaseGetTopList,
  getRecommendPlaylists: neteaseGetRecommendPlaylists,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  neteaseSearch,
  neteaseGetUrl,
  neteaseGetLyrics,
  neteaseGetSongDetail,
  neteaseVerifyCookie,
  neteaseGetPlaylistDetail,
  neteaseGetTopList,
  neteaseGetRecommendPlaylists,
  neteaseSearchAlbum,
  neteaseSearchSinger,
  neteaseGetSingerSongs,
  neteaseGetSingerAlbums,
  neteaseGetAlbumSongs,
  NETEASE_TOP_MAP,
};
