/**
 * 搜索 / 歌词 / 推荐 IPC
 *
 * 注册：search-music / get-lyrics / get-home-recommendations / get-playlist-songs
 * 参数形状校验（keyword 截断、page/limit 钳制）已上移至 IPC 契约
 * （src/shared/ipcContract.js，经 ./register 的 handle 统一执行），
 * handler 只接收规范化后的位置参数。
 */

const api = require('../../api');
const logger = require('../../utils/logger');
const prefs = require('../../utils/prefs');
const { rewriteSearchQueries } = require('../../api/ai-music');
const { chatConfigFrom } = require('../../api/aiProviders');
const { searchByPhrase } = require('../../api/services/nlSearchService');
const { handle } = require('./register');

function register() {
  handle('search-music', async (_, keyword, source, page) => {
    try {
      return await api.searchMusic(keyword, source, page);
    } catch (e) {
      return { error: e.message, songs: [] };
    }
  });

  // 自然语言搜索（P0-A）：LLM 把口语需求改写成 1~3 个关键词，
  // 并行扇出走 'all' 聚合搜索再合并去重。改写失败退回原句，功能不回归。
  handle('nl-search-music', async (_, phrase) => {
    const { apiKey } = chatConfigFrom((k) => prefs.get(k));
    if (!apiKey) {
      return { songs: [], queries: [], error: '请先在「AI 音乐」中配置 API Key' };
    }
    try {
      return await searchByPhrase({
        phrase,
        rewrite: (p) => rewriteSearchQueries({ phrase: p, apiKey }),
        searchAll: async (k) => {
          const r = await api.searchMusic(k, 'all', 1);
          return r.songs || [];
        },
      });
    } catch (e) {
      logger.warn('AI 搜索失败:', e.message || e);
      return { songs: [], queries: [], error: e.message };
    }
  });

  handle('get-lyrics', async (_, id, source, title, artist) => {
    try {
      return await api.getLyrics(id, source, title, artist);
    } catch (e) {
      logger.warn('获取歌词失败:', e.message || e);
      return { lrc: '', error: e.message || e };
    }
  });

  handle('get-home-recommendations', async () => {
    try {
      return await api.getHomeRecommendations();
    } catch (e) {
      logger.warn('获取推荐内容失败:', e.message);
      return { netease: { tops: [], playlists: [] }, qq: { playlists: [] }, error: e.message };
    }
  });

  handle('get-home-section', async (_, section) => {
    try {
      return await api.getHomeSection(section);
    } catch (e) {
      return { ok: false, section, data: [], error: e.message || String(e) };
    }
  });

  handle('get-playlist-songs', async (_, platform, id, limit) => {
    try {
      return await api.getPlaylistSongs(platform, id, limit);
    } catch (e) {
      logger.warn('获取歌单歌曲失败:', e.message);
      return [];
    }
  });

  handle('search-singer', async (_, keyword, source, page) => {
    try {
      return await api.searchSinger(keyword, source, page);
    } catch (e) {
      logger.warn('搜索歌手失败:', e.message);
      return { singers: [], total: 0 };
    }
  });

  handle('get-singer-songs', async (_, singerMid, limit) => {
    try {
      return await api.getSingerSongs(singerMid, limit);
    } catch (e) {
      logger.warn('获取歌手歌曲失败:', e.message);
      return [];
    }
  });

  handle('get-singer-albums', async (_, singerMid, source, pageNo, pageSize) => {
    try {
      return await api.getSingerAlbums(singerMid, source || 'qq', pageNo, pageSize);
    } catch (e) {
      logger.warn('获取歌手专辑失败:', e.message);
      return { albums: [], total: 0 };
    }
  });

  handle('get-album-songs', async (_, platform, albumMid, limit) => {
    try {
      return await api.getAlbumSongs(platform, albumMid, limit);
    } catch (e) {
      logger.warn('获取专辑歌曲失败:', e.message);
      return [];
    }
  });

  handle('search-album', async (_, keyword, source, page) => {
    try {
      return await api.searchAlbum(keyword, source || 'qq', page);
    } catch (e) {
      return { albums: [], total: 0, error: e.message };
    }
  });

  // 粘贴链接智能识别：文本 → { matched, song? | link?, shortLink?, error? }
  handle('get-song-by-link', async (_, text) => {
    try {
      return await api.getSongByLink(String(text || ''));
    } catch (e) {
      logger.warn('链接识别失败:', e.message || e);
      return { matched: false, error: e.message || e };
    }
  });

  // ── 平台清单（v3）───────────────────────────────
  // 渲染层的平台名 / 图标 / 徽标配色 / 下拉选项 / 能力全部由这一次调用驱动。
  // 渲染层不再持有任何平台 id 清单，新增平台无需改动渲染层一行。
  handle('get-platforms', () => {
    try {
      return api.registry.toClientPayload();
    } catch (e) {
      logger.warn('获取平台清单失败:', e.message || e);
      return [];
    }
  });

  // ── 源可用性探针（P2）─────────────────────────────
  // 被动健康度快照：getDownloadUrlSmart 各环节记的滑动窗口统计
  handle('get-source-health', () => {
    // 探针源清单由 registry 派生（原先此数组在本文件被手抄两遍）
    return api.getSourceHealthMap(api.registry.getProbeSources());
  });

  // 主动探测：各源搜一首公共曲并尝试取流。搜索通=源可达；取流通=源健康。
  // 探测结果记入 sourceHealth 滑动窗口（与真实下载共用同一分数）。
  handle('probe-sources', async () => {
    const PROBE_SOURCES = api.registry.getProbeSources();
    const KEYWORD = '周杰伦 晴天';
    const withTimeout = (p) => Promise.race([
      p,
      new Promise(r => setTimeout(() => r({ error: 'timeout' }), 8000)),
    ]);
    const probes = [];
    for (const src of PROBE_SOURCES) {
      let ok = false;
      let stage = 'search';
      let error = null;
      try {
        const r = await withTimeout(api.searchMusic(KEYWORD, src, 1));
        const songs = (r && r.songs) || [];
        if (songs.length > 0) {
          stage = 'getUrl';
          const u = await withTimeout(api.getDownloadUrl(songs[0].id, src, 'standard'));
          ok = !!(u && u.url);
          if (!ok) error = (u && (u.error || u.code)) || 'no-url';
        } else {
          error = (r && r.error) || 'empty-result';
        }
      } catch (e) {
        error = e.message || 'probe-error';
      }
      // 搜索通但取流失败：可达但不健康（VIP/登录墙），记 fail 供换源排序参考
      api.recordProbeResult(src, ok);
      probes.push({ source: src, ok, stage, error, latency: null });
    }
    return { probes, health: api.getSourceHealthMap(PROBE_SOURCES) };
  });
}

module.exports = { register };
