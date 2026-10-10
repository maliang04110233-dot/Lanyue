/**
 * 应用菜单（从 index.js 拆出）
 *
 * 契约测试 regex: webContents\.send\(\s*['"]([\w-]+)['"]
 * 菜单 click handler 里必须直接写 mainWindow.webContents.send('channel') 字面量，
 * 不能包成 send('channel') 变量——否则守卫扫描不到通道目标。
 */

const { Menu } = require('electron');

module.exports = function createMenuModule({ getMainWindow }) {
  function buildAppMenu() {
    const isMac = process.platform === 'darwin';
    const reload = () => {
      const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.reload();
    };

    const template = [
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: '文件',
        submenu: [
          { label: '刷新', accelerator: 'CmdOrCtrl+R', click: reload },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          {
            label: '聚焦搜索 🔍',
            accelerator: 'CmdOrCtrl+K',
            click: () => {
              const w = getMainWindow();
              if (w && !w.isDestroyed()) w.webContents.send('focus-search');
            },
          },
          { type: 'separator' },
          {
            label: '⏰ 定时停止',
            submenu: [
              { label: '🛑 取消定时', click: () => { const w = getMainWindow(); w && !w.isDestroyed() && w.webContents.send('sleep-timer', null); } },
              { type: 'separator' },
              { label: '⏰ 15 分钟后', click: () => { const w = getMainWindow(); w && !w.isDestroyed() && w.webContents.send('sleep-timer', 15); } },
              { label: '⏰ 30 分钟后', click: () => { const w = getMainWindow(); w && !w.isDestroyed() && w.webContents.send('sleep-timer', 30); } },
              { label: '⏰ 60 分钟后', click: () => { const w = getMainWindow(); w && !w.isDestroyed() && w.webContents.send('sleep-timer', 60); } },
              { label: '⏰ 90 分钟后', click: () => { const w = getMainWindow(); w && !w.isDestroyed() && w.webContents.send('sleep-timer', 90); } },
            ],
          },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '切换全屏' },
        ],
      },
      {
        label: '窗口',
        submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  return { build: buildAppMenu };
};
