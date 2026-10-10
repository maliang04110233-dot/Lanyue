'use strict';

const { handle } = require('./register');
const logger = require('../../utils/logger');
const playlist = require('./playlist');
const heartbeatEngine = require('../../utils/heartbeatEngine');
const recommendations = require('../../api/recommendations');

/**
 * 心动模式 IPC 入口
 *
 * 通道：generate-heartbeat (invoke)
 * 参数：{ currentSongId?: string, currentSource?: string }
 * 返回：{ ok: boolean, songs: Array, error?: string }
 *
 * MVP 只暴露算法核，渲染层监听进度条追加队列下一个迭代做。
 */
module.exports = {
  register() {
    handle('generate-heartbeat', async (_, { currentSongId, currentSource }) => {
      try {
        // 1. 读收藏歌单（playlist.js 已导出 ensureFavorites）
        const playlists = playlist.ensureFavorites();
        const favoritesPl = playlists.find(p => p && p.id === 'favorites');
        const favorites = (favoritesPl && Array.isArray(favoritesPl.songs))
          ? favoritesPl.songs
          : [];

        // 2. 当前歌曲（可选）
        const currentSong = (currentSongId && currentSource)
          ? { id: String(currentSongId), source: String(currentSource) }
          : null;

        // 3. 调算法核（注入 gateway 薄包装）
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
