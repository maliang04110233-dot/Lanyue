const { app, BrowserWindow, session, Notification, protocol } = require('electron');
const { buildContractArg } = require('../shared/ipcContract');
const { defaultDownloadDir } = require('../shared/downloadDefaults');
const path = require('path');
const { setCookieStore } = require('../api');
const logger = require('../utils/logger');
const { installRejectionGuard } = require('../utils/rejectionGuard');
const cookieStore = require('../utils/cookieStore');
const { setOnlineLrcNotifier } = require('../utils/onlineLrc');
const { getDownloadUrlSmart, getLyrics } = require('../api');
const { safeSend: ctxSafeSend } = require('./context');
const { assertContractCoverage } = require('./ipc/register');
const taskbarProgress = require('./taskbarProgress');
const { createDownloadQueueEngine } = require('./downloadQueue');
const playCache = require('./playCache');
const { registerStreamScheme, STREAM_SCHEME } = require('./streamProtocol');
const streamRegistry = require('./streamRegistry');
const approvedDirs = require('./approvedDirs');
const history = require('../utils/history');
const prefs = require('../utils/prefs');
const { getPolicyFactsForQueue } = require('./qualityPolicyFacts');
// 主进程即 UI 线程：文件 IO 走异步封装（见 utils/fsAsync.js）
const fsa = require('../utils/fsAsync');
const subscriptions = require('./subscriptions');
const clipboardWatch = require('./clipboardWatch');

// 修复 B15：使用 context.js 提供的统一 safeSend，避免代码漂移
const safeSend = ctxSafeSend;

// ─── 全局未捕获拒绝归口 ─────────────────────────────────
// 「为什么需要它、为什么按栈帧分流」见 utils/rejectionGuard.js 顶部说明。
installRejectionGuard({ logger });

// 在 app ready 之前声明：Electron 要求特权 scheme 只能在 ready 前注册。
// 少了 standard，Chromium 不会按媒体语义对这个 scheme 发 Range 请求，
// 流式播放就退化成"只能从头顺播"，seek 依旧不可用 —— 这正是根因 1。
protocol.registerSchemesAsPrivileged([
  {
    scheme: STREAM_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

let mainWindow;
let isQuitting = false;

// ── 下载队列引擎（Sprint C：已从本文件抽到 main/downloadQueue.js）──
// 队列状态 / 持久化 / 并发调度 / 单曲处理（取流→落盘→ID3→歌词→历史→通知）
// 全部归 downloadQueue.js；本文件只负责组装依赖并接进 context。
let downloadQueueEngine = null;
/** 队列引用：引擎创建后与其内部数组同一引用，供 context / IPC 消费 */
let downloadQueue = [];

// ─── 单实例锁 ──────────────────────────────────────────
// 没有它时每次启动都是一个完全独立的进程：各自的托盘图标、各自的下载队列，
// 且共同读写 userData 下的 queue.json / play-queue.json / history.json ——
// atomicWriteJson 防文件损坏但不防后写覆盖先写，两个窗口的队列会互相清空。
// 全局媒体键也只有一份归属（register 后到的静默失败），按键会打到错误实例。
// 因此第二次启动直接退出，并把焦点还给已开着的窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    // 主窗口平时「关闭」只是 hide 到托盘，这里要把它捞回来
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
  });
}

// ── 拆出的模块（tray / shortcuts / menu / windowManager / playQueueStore）────
const createTrayModule = require('./tray');
const createShortcutsModule = require('./shortcuts');
const createMenuModule = require('./menu');
const createWindowManager = require('./windowManager');
const createPlayQueueStore = require('./playQueueStore');

const playQueueStore = createPlayQueueStore({ getUserDataDir: () => app.getPath('userData') });
// 向后兼容的别名（registerAllIpcHandlers 和退出清理仍引用原函数名）
const persistPlayQueue = (d) => playQueueStore.persist(d);
const flushPlayQueueNow = () => playQueueStore.flush();
const loadPersistedPlayQueue = () => playQueueStore.load();

const trayModule = createTrayModule({
  getMainWindow: () => mainWindow,
  getIsQuitting: () => isQuitting,
  setIsQuitting: (v) => { isQuitting = v; },
});
trayModule.setDownloadQueueEngine(() => downloadQueueEngine);

const shortcutsModule = createShortcutsModule({ getMainWindow: () => mainWindow });

const menuModule = createMenuModule({ getMainWindow: () => mainWindow });

const windowManager = createWindowManager({
  buildContractArg,
  trayModule,
  getIsQuitting: () => isQuitting,
  setIsQuitting: (v) => { isQuitting = v; },
  app,
});
// createWindow 内赋值给 windowManager 内部的 mainWindow；
// 这里同步回写到 index.js 自己的 mainWindow 变量（供 activate 等旧引用使用）
function createWindow() {
  windowManager.createWindow();
  mainWindow = windowManager.getWindow();
}

// 向下兼容的导出
module.exports = { updateTrayMenu: trayModule.updateTrayMenu };

// ── 启动初始化（已拆到 main/bootstrap.js）─────────────────────────────
const bootstrap = require('./bootstrap');

app.whenReady().then(async () => {
  const result = await bootstrap({
    app, protocol, session, safeSend,
    cookieStore, setCookieStore,
    prefs, history, logger,
    approvedDirs, defaultDownloadDir,
    createDownloadQueueEngine,
    getDownloadUrlSmart, getLyrics, getPolicyFactsForQueue,
    playCache, setOnlineLrcNotifier,
    loadPersistedPlayQueue,
    registerAllIpcHandlers,
    assertContractCoverage,
    trayModule, menuModule, taskbarProgress, shortcutsModule, windowManager,
    subscriptions, clipboardWatch,
    fsa,
  });
  downloadQueueEngine = result.downloadQueueEngine;
  downloadQueue = result.downloadQueue;
});

app.on('window-all-closed', () => {
  // 下载队列引擎：立即落盘待写队列 + 停定时器（防抖窗口内的最后一次变更会丢）
  try { if (downloadQueueEngine) downloadQueueEngine.dispose(); } catch (e) {
    logger.warn('[index] 队列引擎清理失败:', e.message);
  }
  try { if (ipcRegister.getLibraryWatcher()) ipcRegister.getLibraryWatcher().stop(); } catch (_e) { /* 停止监听允许失败 */ }
  // 防抖窗口内挂起的播放队列变更立即落盘（dispose 同时做 flush + clearInterval）
  try { playQueueStore.dispose(); } catch (e) { logger.warn('[index] 播放队列退出清理失败:', e.message); }
  subscriptions.stopScheduler();
  clipboardWatch.stop();
  shortcutsModule.unregister();
  try { prefs.flush(); } catch (e) { logger.warn('prefs.flush 失败:', e.message); }
  try { history.flush(); } catch (e) { logger.warn('history.flush 失败:', e.message); }
  // 日志缓冲同步冲刷：异步写在 app.quit() 后可能来不及落盘（同上方的队列/偏好）
  try { logger.flushSyncOnExit(); } catch (_e) { /* 退出路径不再抛 */ }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC 处理（已拆到 main/ipcRegister.js）───────────────────────────
const createIpcRegister = require('./ipcRegister');
const ipcRegister = createIpcRegister({
  app,
  getMainWindow: () => mainWindow,
  getDownloadQueue: () => downloadQueue,
  downloadQueueEngine,
  persistPlayQueue,
  loadPersistedPlayQueue,
  prefs,
  trayModule,
  shortcutsModule,
});
function registerAllIpcHandlers() { ipcRegister.registerAll(); }

// ⚠️ 新增 IPC 请写进 src/main/ipc 下的模块，并通过 register.js 的 handle/on 注册：
// 通道与参数规格统一声明在 src/shared/ipcContract.js（契约未声明会启动即抛，
// test/ipc-contract.test.js 常驻对账，勿再裸用 ipcMain）

// ─── 下载队列调度（Sprint C：已抽到 main/downloadQueue.js）───────────────────
// processQueue / processOneSong / sanitizeFilename 的完整实现见
// src/main/downloadQueue.js（引擎在 bootstrap 处装配并接进 context）。
// 这样「下载」这条核心链路可被独立阅读与测试，不再与窗口/托盘/生命周期混居。

// ⚠️ 此处下方的旧本地音乐库 IPC（scan-local-library / read-local-metadata /
//   read-local-lrc / update-id3-tags / update-id3-cover）+ LRC 解码函数
// 已在 P2-1 拆分到 src/main/ipc/library.js
// 此处不再重复定义，避免 IPC handler channel 重复注册
