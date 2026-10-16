/**
 * 应用菜单。
 *
 * 从 main/index.js 拆出（阶段 3 主进程模块化）：自定义菜单的唯一职责是
 * 「去掉默认菜单里所有开发者工具入口及其加速键」。模板本身无副作用，
 * 唯一的外部依赖是主窗口引用 —— 因此以 getter 注入，点击时现取，
 * 使窗口重建（macOS activate）后菜单回调仍指向当前窗口。
 */
const { Menu } = require('electron');

function buildAppMenu({ getMainWindow }) {
  // 自定义菜单，移除所有「开发者工具」相关项（默认菜单的 Ctrl+Shift+I 加速键也无法触发）
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => { const w = getMainWindow(); return w && w.webContents.reload(); } },
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
        { label: '聚焦搜索 🔍', accelerator: 'CmdOrCtrl+K', click: () => { getMainWindow()?.webContents.send('focus-search'); } },
        { type: 'separator' },
        { label: '⏰ 定时停止', submenu: [
          { label: '🛑 取消定时', click: () => getMainWindow()?.webContents.send('sleep-timer', null) },
          { type: 'separator' },
          { label: '⏰ 15 分钟后', click: () => getMainWindow()?.webContents.send('sleep-timer', 15) },
          { label: '⏰ 30 分钟后', click: () => getMainWindow()?.webContents.send('sleep-timer', 30) },
          { label: '⏰ 60 分钟后', click: () => getMainWindow()?.webContents.send('sleep-timer', 60) },
          { label: '⏰ 90 分钟后', click: () => getMainWindow()?.webContents.send('sleep-timer', 90) },
        ]},
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

module.exports = { buildAppMenu };
