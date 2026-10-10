/**
 * 主进程 IPC 统一注册（从 index.js 拆出）
 *
 * 职责：initContext → libraryWatcher → 各 ipc.*.register() → 尾部内联 IPC
 *
 * 依赖注入（全部 getter，避免 createWindow / createDownloadQueueEngine 之后
 * 才赋值时子模块里拿到 undefined）：
 */

const logger = require('../utils/logger');
const { initContext } = require('./ipc/register');
const ipcHandle = require('./ipc/register').handle;
const ipcOn = require('./ipc/register').on;
const { safeSend } = require('./ipc/register');
const createLibraryWatcher = require('../utils/libraryWatcher');

// 各 ipc 模块
const ipcWindow = require('./ipc/window');
const ipcSearch = require('./ipc/search');
const ipcDownload = require('./ipc/download');
const ipcCookie = require('./ipc/cookie');
const ipcLibrary = require('./ipc/library');
const ipcPrefs = require('./ipc/prefs');
const ipcCheckLocal = require('./ipc/check-local');
const ipcHistory = require('./ipc/history');
const ipcAiMusic = require('./ipc/ai-music');
const ipcPlaylist = require('./ipc/playlist');
const ipcDownloadTemplates = require('./ipc/download-templates');
const ipcCloudSync = require('./ipc/cloud-sync');
const ipcSubscriptions = require('./ipc/subscriptions');
const ipcMcp = require('./ipc/mcp');

module.exports = function createIpcRegister(deps) {
  // deps: {
  //   app, getMainWindow, getDownloadQueue,
  //   downloadQueueEngine, persistPlayQueue, loadPersistedPlayQueue,
  //   prefs, trayModule, shortcutsModule,
  // }

  let libraryWatcher = null;

  function registerAll() {
    const { app, getMainWindow, getDownloadQueue, downloadQueueEngine,
            persistPlayQueue, loadPersistedPlayQueue, prefs,
            trayModule, shortcutsModule } = deps;

    // ── initContext（各 handler 通过 getCtx() 拿共享状态）──
    initContext({
      getMainWindow:    getMainWindow,
      app,
      getDownloadQueue: getDownloadQueue,
      persistQueue:     () => downloadQueueEngine.persistQueue(),
      persistPlayQueue,
      loadPersistedPlayQueue,
      processQueue:     () => downloadQueueEngine.processQueue(),
      requestCancelDownload: (taskId) => downloadQueueEngine.requestCancel(taskId),
      setQueuePaused:   (v) => downloadQueueEngine.setPaused(v),
      queueIsPaused:    () => downloadQueueEngine.isPaused(),
      setLibraryWatchDir: (dir) => { if (libraryWatcher) libraryWatcher.setDir(dir); },
    });

    // ── 本地曲库目录监听 ──
    libraryWatcher = createLibraryWatcher({
      emit: () => safeSend('local-library-changed', {}),
      logger,
    });
    try { libraryWatcher.setDir(prefs.get('localDirPath')); } catch (_e) { /* 无历史目录则不监听 */ }

    // ── 各 ipc 模块 register ──
    ipcWindow.register();
    ipcSearch.register();
    ipcDownload.register();
    ipcCookie.register();
    ipcLibrary.register();
    ipcPrefs.register();
    ipcCheckLocal.register();
    ipcHistory.register();
    ipcAiMusic.register();
    ipcPlaylist.register();
    ipcDownloadTemplates.register();
    ipcCloudSync.register();
    ipcSubscriptions.register();
    ipcMcp.register();
    // MCP 依赖各 ipc 模块已把 handler 挂进注册表，必须在全部 register 之后自启
    ipcMcp.startIfEnabled().catch(e => logger.warn('[mcp] 自启失败:', e));

    // ── 播放队列持久化 IPC ─────────────────────────────
    ipcHandle('save-play-queue', (_, data) => {
      persistPlayQueue(data);
      return { ok: true };
    });
    ipcHandle('load-play-queue', () => {
      return loadPersistedPlayQueue() || { queue: [] };
    });

    // ── 系统托盘 IPC ───────────────────────────────────
    ipcOn('tray-update-play-state', (_, playState) => {
      trayModule.updateTrayMenu(playState);
    });

    // ── 全局快捷键开关（设置页实时切换）─────────────────
    ipcOn('set-global-shortcuts', (_, enabled) => {
      shortcutsModule.setEnabled(!!enabled);
      logger.log(`[shortcuts] 全局媒体键: ${enabled ? '已启用' : '已停用'}`);
    });

    // ── 版本查询 IPC ───────────────────────────────────
    ipcHandle('get-version', () => {
      const pkg = require('../../package.json');
      const version = pkg.version || '1.0.0';
      const commit = process.env.npm_config_git_commit || '';
      return commit ? `${version} (${commit.slice(0, 7)})` : version;
    });
  }

  function getLibraryWatcher() { return libraryWatcher; }

  return { registerAll, getLibraryWatcher };
};
