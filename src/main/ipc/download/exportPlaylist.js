/**
 * 下载 IPC —— 歌单导出
 *
 * 注册：export-playlist（m3u / pls 落盘，经系统保存对话框）
 * 拆分说明（等价迁移）：自 ipc/download.js 的 register 提出。
 */

const { handle } = require('../register');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../../utils/fsAsync');

function register() {
  // ── 导出播放列表 ──────────────────────────────────────────
  handle('export-playlist', async (_, params) => {
    const { dialog } = require('electron');

    try {
      const { songs, format = 'm3u', name = 'Lanyue' } = params;
      if (!songs || !songs.length) return { error: '没有可导出的歌曲' };

      const ext = format === 'pls' ? 'pls' : 'm3u';
      const filters = [
        { name: '播放列表', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ];

      const result = await dialog.showSaveDialog({
        defaultPath: `${name}.${ext}`,
        filters,
      });

      if (result.canceled) return { canceled: true };

      let content = '';
      if (ext === 'm3u') {
        content = '#EXTM3U\n';
        for (const song of songs) {
          const duration = Math.round((song.duration || 0) / 1000);
          content += `#EXTINF:${duration},${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `${song.filePath || song.url || ''}\n`;
        }
      } else {
        content = '[playlist]\n';
        songs.forEach((song, i) => {
          content += `File${i + 1}=${song.filePath || song.url || ''}\n`;
          content += `Title${i + 1}=${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `Length${i + 1}=${Math.round((song.duration || 0) / 1000)}\n`;
        });
        content += `NumberOfEntries=${songs.length}\n`;
      }

      await fsa.writeText(result.filePath, content);
      return { success: true, path: result.filePath };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { register };
