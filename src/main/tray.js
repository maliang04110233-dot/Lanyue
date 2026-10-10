/**
 * 系统托盘（从 index.js 拆出）
 *
 * 依赖通过 deps 注入，避免 require 循环：
 *   getMainWindow()   —— 主窗口 getter
 *   getIsQuitting()   —— 是否正在退出（托盘退出按钮不能误点）
 */

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const logger = require('../utils/logger');

module.exports = function createTrayModule({ getMainWindow, getIsQuitting, setIsQuitting }) {
  let tray = null;
  // 惰性获取引擎（index.js 在 app.whenReady() 里才赋值）
  let _engineGetter = () => null;

  function setDownloadQueueEngine(engineOrGetter) {
    _engineGetter = typeof engineOrGetter === 'function' ? engineOrGetter : () => engineOrGetter;
  }

  function _engine() { return _engineGetter(); }

  function toggleMainWindow() {
    const win = getMainWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.focus(); }
  }

  function createTray() {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    let trayIcon;
    try {
      trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
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
    tray.on('click', () => { toggleMainWindow(); });
    tray.on('balloon-click', () => {
      const win = getMainWindow();
      if (win) { win.show(); win.focus(); }
    });
  }

  function destroyTray() {
    if (tray) {
      try { tray.destroy(); } catch (_e) { /* 退出路径忽略 */ }
    }
    tray = null;
  }

  function updateTrayMenu(playState = { isPlaying: false, title: '', artist: '' }) {
    if (!tray) return;
    const win = getMainWindow();
    const send = (ch, data) => {
      if (win && !win.isDestroyed()) win.webContents.send(ch, data);
    };
    // 契约测试 regex: webContents\.send\(\s*['"]([\w-]+)['"]
    // 以下每条 click handler 直接调 win.webContents.send('channel') 以便守卫扫描
    const contextMenu = Menu.buildFromTemplate([
      { label: playState.title ? `🎵 ${playState.title}` : '🎵 揽乐', enabled: false },
      { label: playState.artist ? `   ${playState.artist}` : '', enabled: false },
      { type: 'separator' },
      { label: playState.isPlaying ? '⏸ 暂停' : '▶ 播放', click: () => win && !win.isDestroyed() && win.webContents.send('tray-toggle-play') },
      { label: '⏮ 上一首', click: () => win && !win.isDestroyed() && win.webContents.send('tray-prev') },
      { label: '⏭ 下一首', click: () => win && !win.isDestroyed() && win.webContents.send('tray-next') },
      { type: 'separator' },
      {
        label: '🖼 桌面歌词',
        click: () => { try { send('tray-desktop-lyric'); } catch (e) { logger.warn('[tray] desktop-lyric 失败:', e.message); } },
      },
      {
        label: '📐 迷你播放器',
        click: () => { try { send('tray-mini-player'); } catch (e) { logger.warn('[tray] mini-player 失败:', e.message); } },
      },
      { type: 'separator' },
      {
        label: '📋 显示主窗口',
        click: () => { const w = getMainWindow(); if (w) { w.show(); w.focus(); } },
      },
      {
        type: 'checkbox',
        label: '⏸ 暂停下载队列',
        checked: !!(_engine() && _engine().isPaused()),
        click: (mi) => {
          const e = _engine();
          if (!e) return;
          e.setPaused(mi.checked);
          win && !win.isDestroyed() && win.webContents.send('queue-paused-changed', { paused: mi.checked });
        },
      },
      { type: 'separator' },
      {
        label: '❌ 退出',
        click: () => {
          if (!getIsQuitting()) {
            setIsQuitting(true);
            const { app } = require('electron');
            app.quit();
          }
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }

  function getTray() { return tray; }

  return { createTray, destroyTray, updateTrayMenu, setDownloadQueueEngine, toggleMainWindow, getTray };
};
