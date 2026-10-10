/**
 * 主窗口创建与导航防护（从 index.js 拆出）
 *
 * 职责：BrowserWindow 实例化 + 导航拦截 + DevTools 快捷键屏蔽 + 关闭→托盘
 *
 * 依赖注入：
 *   buildContractArg()   —— IPC 契约（shared/ipcContract.js 提供）
 *   trayModule           —— 关闭事件需 tray.displayBalloon()
 *   getIsQuitting()      —— 关闭时判断是真退出还是 hide
 *   setIsQuitting(v)     —— menu 退出入口会把 isQuitting 置 true 后触发 close
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const logger = require('../utils/logger');

module.exports = function createWindowManager({ buildContractArg, trayModule, getIsQuitting, setIsQuitting, app }) {
  let mainWindow = null;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 900,
      minHeight: 600,
      frame: false,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true, // 启用安全策略，CORS 通过 session.defaultSession.webRequest 头部处理
        preload: path.join(__dirname, '../preload/preload.js'),
        // sandbox preload 不能 require 应用文件：IPC 契约经 argv 序列化注入
        additionalArguments: [buildContractArg('main')],
      },
      titleBarStyle: 'hidden',
      icon: path.join(__dirname, '../../assets/icon.png'),
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')).then(() => {
      logger.log('[main] loadFile done');
    }).catch(err => {
      logger.warn('[main] loadFile failed:', err);
      // 开发模式下可能 dist/renderer 还没构建好
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      if (devUrl) {
        logger.log('[main] trying dev server URL:', devUrl);
        mainWindow.loadURL(devUrl).catch(e => logger.warn('[main] loadURL also failed:', e));
      }
    });

    // 导航防护：主窗口只加载本地内容，任何远程/file 导航一律拒绝
    // （渲染层一旦有脚本注入，window.open / location 跳转可把窗口导向
    // 钓鱼页或本地文件协议，此处统一拦截）
    const denyNav = (url) => {
      logger.warn('[main] 拒绝主窗口导航:', url);
    };
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
      if (!u) { denyNav(url); event.preventDefault(); return; }
      // M1: file: 导航只放行应用自身包内文件 —— 原先任意本机 HTML 都能载入
      // 这个挂着全量特权 IPC 的窗口（与下载目录写入组合即完整攻击链）
      const { fileURLToPath } = require('url');
      const isLocal = (() => {
        if (u.protocol !== 'file:') return false;
        try {
          const fp = fileURLToPath(u);
          const rel = path.relative(path.resolve(app.getAppPath()), path.resolve(fp));
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        } catch (_) { return false; }
      })();
      // 同源 http(s) 导航放行（dev 模式下 vite 服务器整页刷新）。
      // 不能直接比 u.origin === current.origin：file: 页的 origin 恒为
      // 字符串 'null'，会把所有 file: 导航误判成同源。
      const cur = (() => {
        try { return new URL(mainWindow.webContents.getURL()); } catch (_) { return null; }
      })();
      const sameHttpOrigin = !!cur
        && (cur.protocol === 'http:' || cur.protocol === 'https:')
        && u.protocol === cur.protocol && u.host === cur.host;
      if (!isLocal && !sameHttpOrigin) {
        denyNav(url);
        event.preventDefault();
      }
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      denyNav(url);
      return { action: 'deny' };
    });

    // 拦截 F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+U 防止误开
    const blockList = new Set(['F12']);
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (blockList.has(input.key)) {
        event.preventDefault();
        return;
      }
      if (input.control && input.shift && ['I', 'i', 'J', 'j', 'C', 'c'].includes(input.key)) {
        event.preventDefault();
        return;
      }
      if (input.control && ['U', 'u'].includes(input.key)) {
        event.preventDefault();
        return;
      }
      // Ctrl+R 刷新页面（保留）
      if (input.key === 'r' && (input.control || input.meta)) {
        event.preventDefault();
        mainWindow.webContents.reload();
      }
    });

    // 窗口关闭时最小化到托盘（不是真的关闭）
    mainWindow.on('close', (event) => {
      if (!getIsQuitting()) {
        event.preventDefault();
        mainWindow.hide();
        const t = trayModule.getTray();
        if (t) {
          t.displayBalloon({ title: '揽乐', content: '已最小化到托盘，点击恢复' });
        }
      }
    });
  }

  function getWindow() { return mainWindow; }

  return { createWindow, getWindow };
};
