/**
 * 窗口控制 / 文件系统 / 迷你播放器 / 桌面歌词 IPC
 *
 * 注册：window-minimize / window-maximize / window-close / select-dir /
 *      get-default-dir / open-folder / open-external /
 *      open-mini-player / mini-toggle-play / mini-next / mini-prev / mini-close /
 *      open-desktop-lyric / desktop-lyric-close / desktop-lyric-lock /
 *      desktop-lyric-update / desktop-lyric-sync
 */

const { BrowserWindow, dialog, shell, app } = require('electron');
const { handle, on } = require('./register');
const { buildContractArg } = require('../../shared/ipcContract');
const { defaultDownloadDir } = require('../../shared/downloadDefaults');
const path = require('path');
const { getMainWindow } = require('../context');
const playCache = require('../playCache');
const approvedDirs = require('../approvedDirs');
const logger = require('../../utils/logger');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');

let miniPlayerWin = null;
let desktopLyricWin = null;

// ── 桌面歌词窗口 ──────────────────────────────────────────
function createDesktopLyric() {
  if (desktopLyricWin && !desktopLyricWin.isDestroyed()) {
    desktopLyricWin.focus();
    return;
  }
  desktopLyricWin = new BrowserWindow({
    width: 760, height: 120,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    // 点击穿透：正文区域 setIgnoreMouseEvents(true)，控制条区域在渲染层
    // 用 mouseenter/leave 切回 false（锁定的拖动条始终可点）
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // C4/M2: 本窗口渲染远端歌词 —— 用最小 preload（只含歌词通道），
      // 不再暴露主窗口的 delete-file/save-cookie 等特权 IPC
      preload: path.join(__dirname, '../../preload/preload-secondary.js'),
      // sandbox preload 不能 require 应用文件：IPC 契约经 argv 序列化注入
      additionalArguments: [buildContractArg('secondary')],
    },
  });
  // 二级窗口只加载本地固定页面，任何导航/弹窗一律拒绝
  desktopLyricWin.webContents.on('will-navigate', (event) => event.preventDefault());
  desktopLyricWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  desktopLyricWin.loadFile(path.join(__dirname, '../../renderer/desktop-lyric.html'));
  desktopLyricWin.webContents.on('did-finish-load', () => {
    // 通知主窗口推送当前播放状态（含 parsedLyrics）到歌词窗口
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('sync-desktop-lyric');
    }
  });
  desktopLyricWin.on('closed', () => { desktopLyricWin = null; });
}

/** 向桌面歌词窗口推送状态（主窗口渲染层经 desktop-lyric-update 转发） */
function syncDesktopLyric(data) {
  if (desktopLyricWin && !desktopLyricWin.isDestroyed()) {
    desktopLyricWin.webContents.send('desktop-lyric-data', data);
  }
}

function createMiniPlayer() {
  if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
    miniPlayerWin.focus();
    return;
  }
  const main = getMainWindow();
  const [mx, my] = main ? main.getPosition() : [100, 100];
  miniPlayerWin = new BrowserWindow({
    width: 320, height: 72,
    x: mx, y: my,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // C4/M2: 迷你播放器渲染远端歌名/封面 —— 只暴露播放控制最小通道
      preload: path.join(__dirname, '../../preload/preload-secondary.js'),
      // sandbox preload 不能 require 应用文件：IPC 契约经 argv 序列化注入
      additionalArguments: [buildContractArg('secondary')],
    },
  });
  miniPlayerWin.webContents.on('will-navigate', (event) => event.preventDefault());
  miniPlayerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  miniPlayerWin.loadFile(path.join(__dirname, '../../renderer/mini-player.html'));
  miniPlayerWin.webContents.on('did-finish-load', () => {
    // 通知主窗口推送当前播放状态到迷你播放器
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('sync-mini-player');
    }
  });
  miniPlayerWin.on('closed', () => { miniPlayerWin = null; });
}

/** 向迷你播放器推送当前播放状态 */
function syncMiniPlayer(data) {
  if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
    miniPlayerWin.webContents.send('mini-player-update', data);
  }
}

function register() {
  on('window-minimize', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.minimize();
  });
  on('window-maximize', () => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  on('window-close', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.close();
  });

  // ── 迷你播放器 ──────────────────────────────────────
  on('open-mini-player', () => createMiniPlayer());

  // 渲染器推送状态到迷你播放器
  on('mini-player-update', (_, data) => syncMiniPlayer(data));

  on('mini-toggle-play', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-toggle-play');
  });
  on('mini-next', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-next');
  });
  on('mini-prev', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-prev');
  });
  on('mini-close', () => {
    if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
      miniPlayerWin.close();
    }
  });

  // ── 桌面歌词 ────────────────────────────────────────
  on('open-desktop-lyric', () => createDesktopLyric());

  // 主窗口渲染层推送状态到歌词窗口（歌词/进度/播放态）
  on('desktop-lyric-update', (_, data) => syncDesktopLyric(data));

  on('desktop-lyric-close', () => {
    if (desktopLyricWin && !desktopLyricWin.isDestroyed()) {
      desktopLyricWin.close();
    }
  });

  // 锁定切换：锁定=拖动条常驻可拖，解锁=正文穿透鼠标、悬停控制条才恢复点击
  on('desktop-lyric-lock', (_, locked) => {
    if (desktopLyricWin && !desktopLyricWin.isDestroyed()) {
      if (locked === false) {
        desktopLyricWin.setIgnoreMouseEvents(true, { forward: true });
      } else {
        desktopLyricWin.setIgnoreMouseEvents(false);
      }
    }
  });

  // 点击穿透切换（渲染层 mouseenter/leave 控制条时调用）
  on('desktop-lyric-set-ignore-mouse', (_, ignore) => {
    if (desktopLyricWin && !desktopLyricWin.isDestroyed()) {
      desktopLyricWin.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // 选择下载目录
  handle('select-dir', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    // C1: 经原生选器确认的目录登记为「用户批准」，下载/扫描/歌词写入
    // 等通道只接受批准集合内的路径
    approvedDirs.approve(result.filePaths[0]);
    return result.filePaths[0];
  });

  // 默认下载目录（UI 展示与真实落盘兜底同源，字面量收表 shared/downloadDefaults）
  handle('get-default-dir', () => {
    return defaultDownloadDir(app.getPath('music'));
  });

  // 打开目录 / 外部链接（渲染层经 musicAPI invoke 调用，需 handle）
  const openFolderImpl = async (folder) => {
    if (!folder || typeof folder !== 'string') return { ok: false };
    // H11: 拒绝带协议前缀的伪路径（file:/http:/javascript:），仅放行
    // Windows 盘符（"C:\x"）与普通本地路径；原实现把两类判断写反了
    if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(folder) && !/^[a-zA-Z]:[\\/]/.test(folder)) {
      return { ok: false, error: '非法路径' };
    }
    // P1-9：协议前缀只挡"伪路径"，挡不住"合法盘符路径"——渲染层可以拿
    // `D:\` 这类任意路径做存在性探测（返回 ok 差异）并把资源管理器拉到任意
    // 目录。同一仓库 library.js 的 15 处路径通道都过了沙箱，只有这条漏网。
    //
    // 复用 approvedDirs 的既有判据（词法快筛 + 真实路径复核），不另起一套：
    // 渲染层真会送进来的目录 —— saveDir / localDirPath / aiMusicSaveDir /
    // convertOutputDir 这几个目录型偏好，以及原生选器选过的目录 —— 启动时
    // 都被 index.js seed 进了注册表（见 DIR_PREF_KEYS），所以收窄到注册表
    // 内不会误伤任何一条真实调用点。
    const resolved = path.resolve(folder);
    if (!approvedDirs.isApprovedDir(resolved)) {
      return { ok: false, error: '路径不可访问' };
    }
    try {
      if (await fsa.exists(resolved)) {
        shell.showItemInFolder(resolved);
      }
    } catch (e) {
      logger.warn('[window] open-folder 失败:', e.message);
    }
    return { ok: true };
  };
  const openExternalImpl = (url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { ok: true };
  };
  handle('open-folder', (_, folder) => openFolderImpl(folder));
  handle('open-external', (_, url) => openExternalImpl(url));

  // 缓存管理
  handle('get-cache-size', async () => {
    const size = await playCache.getCacheSize(app.getPath('userData'));
    return playCache.formatCacheSize(size);
  });
  handle('clear-play-cache', async () => {
    await playCache.clearAllCache(app.getPath('userData'));
    return { cleared: true };
  });

  // 队列完成后动作：只接受枚举白名单，命令全部为常量，无任何用户可控拼接
  handle('system-power', async (_event, action) => {
    if (action === 'quit') {
      app.quit();
      return { ok: true };
    }
    if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持关机/睡眠' };
    const { exec } = require('child_process');
    if (action === 'shutdown') {
      exec('shutdown /s /t 0', (err) => { if (err) logger.warn('[system-power] 关机调用失败:', err.message); });
      return { ok: true };
    }
    if (action === 'sleep') {
      exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (err) => { if (err) logger.warn('[system-power] 睡眠调用失败:', err.message); });
      return { ok: true };
    }
    return { ok: false, error: '未知动作' };
  });
}

module.exports = { register, syncMiniPlayer, createMiniPlayer, createDesktopLyric };
