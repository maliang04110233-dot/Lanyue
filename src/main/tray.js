/**
 * 系统托盘。
 *
 * 从 main/index.js 拆出（阶段 3 主进程模块化）：托盘图标、右键菜单、
 * 「关闭即收进托盘」的退出标志都归这里。主窗口与下载队列引擎以 getter
 * 注入（窗口在 createWindow 后才赋值、引擎在 whenReady 里装配），故所有
 * 回调都惰性取引用，不做构建期快照。
 */
const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const logger = require('../utils/logger');
const ipcWindow = require('./ipc/window');

let tray = null;
let isQuitting = false;
let _getMainWindow = () => null;
let _getDownloadQueueEngine = () => null;

function init(deps = {}) {
  if (typeof deps.getMainWindow === 'function') _getMainWindow = deps.getMainWindow;
  if (typeof deps.getDownloadQueueEngine === 'function') _getDownloadQueueEngine = deps.getDownloadQueueEngine;
}

/** 「退出」菜单项置位：窗口 close 事件据此决定是真退还是收进托盘。 */
function markQuitting() { isQuitting = true; }
function isQuittingApp() { return isQuitting; }

/** 可见则收起、不可见则唤出并抢焦点。托盘点击与「显示/隐藏窗口」全局键共用这一处。 */
function toggleMainWindow() {
  const mainWindow = _getMainWindow();
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // 如果图标加载失败，使用空白图标
      trayIcon = nativeImage.createEmpty();
    } else {
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
  } catch (e) {
    logger.warn('[tray] 图标加载失败:', e.message);
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('揽乐');

  updateTrayMenu();

  tray.on('click', () => {
    toggleMainWindow();
  });

  tray.on('balloon-click', () => {
    const mainWindow = _getMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu(playState = { isPlaying: false, title: '', artist: '' }) {
  if (!tray) return;
  const engine = _getDownloadQueueEngine();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: playState.title ? `🎵 ${playState.title}` : '🎵 揽乐',
      enabled: false,
    },
    {
      label: playState.artist ? `   ${playState.artist}` : '',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: playState.isPlaying ? '⏸ 暂停' : '▶ 播放',
      click: () => {
        const mainWindow = _getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-toggle-play');
        }
      },
    },
    {
      label: '⏮ 上一首',
      click: () => {
        const mainWindow = _getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-prev');
        }
      },
    },
    {
      label: '⏭ 下一首',
      click: () => {
        const mainWindow = _getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-next');
        }
      },
    },
    { type: 'separator' },
    {
      label: '🖼 桌面歌词',
      click: () => {
        try { ipcWindow.createDesktopLyric(); } catch (e) { logger.warn('[tray] 打开桌面歌词失败:', e.message); }
      },
    },
    {
      label: '📐 迷你播放器',
      click: () => {
        try { ipcWindow.createMiniPlayer(); } catch (e) { logger.warn('[tray] 打开迷你播放器失败:', e.message); }
      },
    },
    { type: 'separator' },
    {
      label: '📋 显示主窗口',
      click: () => {
        const mainWindow = _getMainWindow();
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      type: 'checkbox',
      label: '⏸ 暂停下载队列',
      checked: !!(engine && engine.isPaused()),
      click: (mi) => {
        const engineNow = _getDownloadQueueEngine();
        if (!engineNow) return;
        engineNow.setPaused(mi.checked);
        // 同步渲染层按钮状态（queue-updated 不携带 paused，走独立事件）
        const mainWindow = _getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('queue-paused-changed', { paused: mi.checked });
        }
      },
    },
    {
      label: '❌ 退出',
      click: () => {
        markQuitting();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function getTray() { return tray; }

module.exports = { init, markQuitting, isQuittingApp, toggleMainWindow, createTray, updateTrayMenu, getTray };
