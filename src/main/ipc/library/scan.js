/**
 * 本地音乐库 IPC · 扫描域
 * 注册：scan-local-library / load-library-index
 */

const { handle } = require('../register');
const {
  scanDirectory,
  readAudioMetadata,
} = require('../../../utils/localLibrary');
const { incrementalScan, loadIndex } = require('../../../utils/libraryIndex');
const logger = require('../../../utils/logger');
const { reconcileScannedRefs } = require('../../../utils/fileRelink');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../../utils/fsAsync');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register() {
  // 扫描本地目录（增量扫描：缓存索引 + 只处理变更文件）
  handle('scan-local-library', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', songs: [] };
      // C1: 未批准/未配置目录不可枚举（原实现可扫全盘任意目录）
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', songs: [] };
      if (!await fsa.exists(dirPath)) return { error: '目录不存在', songs: [] };

      // 扫描成功即（重新）武装目录监听：用户换目录后 watcher 自动跟随
      try {
        const { setLibraryWatchDir } = require('../../context').getCtx();
        if (typeof setLibraryWatchDir === 'function') setLibraryWatchDir(dirPath);
      } catch (_e) { /* watcher 未就绪不影响扫描 */ }

      // 尝试增量扫描（不再推扫描进度：渲染层无人订阅该事件，通道已随空发一并清理；
      // 扫描期间本地页有 _scanRunning 防重入）
      const result = await incrementalScan(
        dirPath,
        scanDirectory,
        readAudioMetadata,
      );

      // 用户在 app 外面改过文件名时，下载历史指向的旧路径已经失联。
      // 刚扫到的文件清单就是磁盘真相，拿它对账一次并接回（失败不影响扫描本身）。
      let relinked = { fixed: 0, ambiguous: 0 };
      try {
        relinked = await reconcileScannedRefs(result.songs);
      } catch (e) {
        logger.warn('[scan-local-library] 外部改名对账失败:', e.message);
      }

      return { songs: result.songs, count: result.songs.length, incremental: true, relinked };
    } catch (e) {
      logger.warn('[Library] 增量扫描失败，回退全量扫描:', e.message);

      // 回退到全量扫描
      try {
        const filePaths = await scanDirectory(dirPath);
        const songs = [];
        const BATCH = 20;
        for (let i = 0; i < filePaths.length; i += BATCH) {
          const batch = filePaths.slice(i, i + BATCH);
          const metas = await Promise.allSettled(batch.map(fp => readAudioMetadata(fp)));
          for (const r of metas) {
            if (r.status === 'fulfilled') songs.push(r.value);
            else logger.warn('读取元数据失败:', r.reason?.message);
          }
          await new Promise(r => setImmediate(r));
        }
        // 回退路径同样对账：漏了它等于"只有增量扫描才修得好"，那是半残功能
        let relinked = { fixed: 0, ambiguous: 0 };
        try {
          relinked = await reconcileScannedRefs(songs);
        } catch (e) {
          logger.warn('[Library] 外部改名对账失败:', e.message);
        }
        return { songs, count: songs.length, incremental: false, relinked };
      } catch (e2) {
        return { error: e2.message, songs: [] };
      }
    }
  });

  // 读取缓存索引（启动时秒加载）
  handle('load-library-index', async () => {
    try {
      const index = await loadIndex();
      return { songs: index.songs || [], dirPath: index.dirPath, lastScan: index.lastScan };
    } catch (e) {
      return { songs: [], dirPath: '', lastScan: 0 };
    }
  });
}

module.exports = register;
