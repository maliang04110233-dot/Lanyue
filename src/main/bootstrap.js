/**
 * Electron 应用启动初始化（从 index.js 拆出）
 *
 * 职责：在 app.whenReady() 之后串行完成所有一次性初始化：
 *   1. stream scheme 注册
 *   2. cookieStore / prefs / history / logger / approvedDirs 基础服务
 *   3. 下载队列引擎装配（**必须在 IPC register 前**，handler 通过 context 拿引擎引用）
 *   4. play_cache 临时文件清理（后台不阻塞）
 *   5. 在线拉歌词通知回调
 *   6. 恢复持久化队列 + 播放队列
 *   7. IPC handler 注册 + 契约对账
 *   8. 自动更新初始化
 *   9. play_cache GC + 订阅调度 + 剪贴板嗅探 + 菜单 + CORS 白名单
 *  10. createWindow / tray / taskbar / shortcuts（最后启动）
 *
 * 依赖注入（全部 getter，避免模块间 require 循环或未就绪时序）：
 */

const { Notification, shell } = require('electron');
const path = require('path');
const logger = require('../utils/logger');
const { registerStreamScheme } = require('./streamProtocol');
const { defaultDownloadDir } = require('../shared/downloadDefaults');

module.exports = async function bootstrap(deps) {
  const {
    app, protocol, session, safeSend,
    cookieStore, setCookieStore,
    prefs, history, logger: loggerSvc,
    approvedDirs, defaultDownloadDir: dd,
    createDownloadQueueEngine,
    getDownloadUrlSmart, getLyrics, getPolicyFactsForQueue,
    playCache, setOnlineLrcNotifier,
    loadPersistedPlayQueue,
    registerAllIpcHandlers,
    assertContractCoverage,
    trayModule, menuModule, taskbarProgress, shortcutsModule, windowManager,
    subscriptions, clipboardWatch,
    fsa,
  } = deps;

  const userDataDir = () => app.getPath('userData');

  // 1. 流式播放 scheme 就位
  registerStreamScheme(protocol, (u) => {
    const streamRegistry = require('./streamRegistry');
    return streamRegistry.resolveStream(u);
  });

  // 2. 基础服务初始化
  cookieStore.init(userDataDir());
  setCookieStore(cookieStore);
  prefs.init(userDataDir());
  try { loggerSvc.initLogFile(path.join(userDataDir(), 'logs', 'main.log')); }
  catch (e) { logger.warn('[main] 日志落盘初始化失败:', e.message); }

  for (const k of approvedDirs.DIR_PREF_KEYS) {
    const v = prefs.get(k);
    if (v) approvedDirs.approve(v);
  }
  approvedDirs.approve(dd(app.getPath('music')));
  approvedDirs.approve(dd(userDataDir()));
  history.init(userDataDir());

  // 3. 下载队列引擎（**必须在 registerAllIpcHandlers 之前**）
  let downloadQueueEngine = createDownloadQueueEngine({
    userDataDir,
    getDefaultDownloadDir: () => dd(app.getPath('music')),
    safeSend,
    getDownloadUrlSmart,
    getLyrics,
    isSaveDirAllowed: (p) => approvedDirs.isApprovedDir(p),
    getPolicyFacts: getPolicyFactsForQueue,
    onQueueChanged: () => {
      try { trayModule.updateTrayMenu(); } catch (_e) { /* 托盘未就绪可忽略 */ }
    },
    notifier: {
      notifyDownloadDone: (song, savePath) => {
        const n = new Notification({
          title: '下载完成',
          body: `${song.title} - ${song.artist || '未知艺术家'}`,
          silent: false,
        });
        n.on('click', () => { shell.showItemInFolder(savePath); });
        n.show();
      },
    },
  });
  let downloadQueue = downloadQueueEngine.getQueue();

  // 4. 确保默认下载目录存在
  const defaultDir = prefs.get('saveDir') || dd(app.getPath('music'));
  await fsa.ensureDir(defaultDir);

  // 不 await：play_cache 清理是尽力而为，不该拖慢启动
  playCache.cleanupStaleFiles(userDataDir()).catch((e) => {
    logger.warn('[playCache] 清理陈旧缓存失败:', e.message);
  });

  // 5. 在线拉歌词通知回调（惰性拿 mainWindow，此时尚未 createWindow）
  setOnlineLrcNotifier(({ filePath, lrc, source }) => {
    try {
      const mw = windowManager.getWindow();
      if (mw && !mw.isDestroyed()) safeSend('local-lrc-fetched', { filePath, lrc, source });
    } catch (e) { logger.warn('[online-lrc] 推送事件失败:', e.message); }
  });

  // 6. 恢复持久化队列
  try { await downloadQueueEngine.loadPersistedQueue(); }
  catch (e) { logger.warn('[index] 恢复队列失败:', e.message); }

  try {
    const saved = await loadPersistedPlayQueue();
    if (saved && saved.queue && saved.queue.length) safeSend('play-queue-restored', saved);
  } catch (e) { logger.warn('[PlayQueue] 恢复播放队列失败:', e.message); }

  // 7. IPC 注册 + 契约对账
  registerAllIpcHandlers();

  // 8. 自动更新
  try { const { initUpdater } = require('./updater'); initUpdater(); }
  catch (_e) { logger.warn('[Updater] init failed:', _e.message); }

  try { assertContractCoverage(); }
  catch (e) { logger.warn('[ipc] 契约覆盖检查失败:', e.message); }

  // 9. 后台定时器
  const gcTimer = setInterval(() => {
    playCache.cleanupExpired().catch((e) => logger.warn('[playCache] GC 失败:', e.message));
  }, playCache.PLAY_CACHE_GC_INTERVAL);
  if (gcTimer.unref) gcTimer.unref();
  subscriptions.startScheduler();
  clipboardWatch.start();

  menuModule.build();

  // CORS 白名单（test/platform-contract.test.js 的集合相等断言守住，不允许新增）
  const LOCAL_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
  const { origins: platformOrigins, suffixes: platformSuffixes } =
    require('../api').registry.getAllowedOrigins();
  const ALLOWED_ORIGINS = new Set([...LOCAL_ORIGINS, ...platformOrigins]);
  const ALLOWED_ORIGIN_SUFFIXES = [...platformSuffixes];
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    let targetOrigin = '';
    try { targetOrigin = new URL(details.url).origin; } catch (_e) { /* noop */ }
    const isAllowed = ALLOWED_ORIGINS.has(targetOrigin)
      || ALLOWED_ORIGIN_SUFFIXES.some((sfx) => targetOrigin.endsWith(sfx));
    const headers = { ...details.responseHeaders };
    const hasACAO = Object.keys(headers).some(k => k.toLowerCase() === 'access-control-allow-origin');
    if (isAllowed && !hasACAO) {
      const initiator = details.initiator && /^https?:\/\//.test(details.initiator)
        ? new URL(details.initiator).origin : 'null';
      headers['Access-Control-Allow-Origin'] = [initiator];
      headers['Access-Control-Allow-Methods'] = ['GET', 'HEAD', 'OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['Range', 'Referer'];
    }
    callback({ responseHeaders: headers });
  });

  // 10. 启动窗口 + 托盘 + 快捷键（最后才启动，前面的初始化全部就绪）
  windowManager.createWindow();
  trayModule.createTray();
  taskbarProgress.init({
    getWindows: () => {
      const mw = windowManager.getWindow();
      return (mw && !mw.isDestroyed()) ? [mw] : [];
    },
    getTray: () => trayModule.getTray(),
  });
  shortcutsModule.register();

  // 对外暴露引擎引用（退出清理等需要）
  return { downloadQueueEngine, downloadQueue };
};
