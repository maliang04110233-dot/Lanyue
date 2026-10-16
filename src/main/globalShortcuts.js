/**
 * 全局快捷键（可自定义）。
 *
 * 从 main/index.js 拆出（阶段 3 主进程模块化）：动作清单、accelerator
 * 白名单、默认值与「一键一动作」的去重规则全在 src/shared/accelerators.js
 * （设置页与主进程同源，由 test/global-shortcuts.test.js 对账）；本模块
 * 只负责注册 / 注销与按键派发。通道沿用托盘那几条 tray-*，不新增 IPC。
 * prefs.globalShortcuts 是总开关（默认开），四个 shortcut* 键是每枚动作的绑法。
 *
 * 主窗口与「显示/隐藏窗口」动作以 getter 注入：窗口在 createWindow 后才
 * 赋值，回调须惰性取引用，不做构建期快照。
 */
const { globalShortcut } = require('electron');
const { readBindings } = require('../shared/accelerators');
const prefs = require('../utils/prefs');
const logger = require('../utils/logger');

let _getMainWindow = () => null;
let _toggleMainWindow = () => {};

function init(deps = {}) {
  if (typeof deps.getMainWindow === 'function') _getMainWindow = deps.getMainWindow;
  if (typeof deps.toggleMainWindow === 'function') _toggleMainWindow = deps.toggleMainWindow;
}

function sendToMainWindow(channel) {
  const mainWindow = _getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

function runShortcutAction(binding) {
  if (binding.channel) sendToMainWindow(binding.channel);
  else _toggleMainWindow();
}

function registerGlobalShortcuts() {
  if (prefs.get('globalShortcuts') === false) return; // 默认开
  const bindings = readBindings((key) => prefs.get(key));
  let registered = 0;
  for (const binding of bindings) {
    try {
      // 注册失败（键已被系统或其它应用抢走）时 Electron 只回 false，不抛
      if (globalShortcut.register(binding.accelerator, () => runShortcutAction(binding))) registered++;
      else logger.warn(`[shortcuts] ${binding.accelerator} 注册失败（可能已被系统或其它应用占用）`);
    } catch (e) {
      logger.warn(`[shortcuts] 注册 ${binding.accelerator} 失败:`, e.message);
    }
  }
  if (registered > 0) logger.log(`[shortcuts] 全局快捷键已注册 ${registered}/${bindings.length}`);
}

function unregisterGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_e) { /* 退出路径忽略 */ }
}

function updateGlobalShortcutsEnabled(enabled) {
  try {
    globalShortcut.unregisterAll();
    if (enabled !== false) registerGlobalShortcuts();
  } catch (e) {
    logger.warn('[shortcuts] 切换失败:', e.message);
  }
}

module.exports = { init, registerGlobalShortcuts, unregisterGlobalShortcuts, updateGlobalShortcutsEnabled };
