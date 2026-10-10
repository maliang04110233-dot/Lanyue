/**
 * 全局快捷键（从 index.js 拆出）
 *
 * 所有快捷键注册失败/冲突场景降级为 warn 日志（Electron 抢占键位只回 false，
 * 不抛错），不阻塞启动。快捷键清单在 src/shared/accelerators.js 统一声明，
 * 此处只负责 readBindings + 注册/注销。
 */

const { globalShortcut } = require('electron');
const logger = require('../utils/logger');
const prefs = require('../utils/prefs');
const { readBindings } = require('../shared/accelerators');

module.exports = function createShortcutsModule({ getMainWindow }) {
  function send(channel) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  }

  function runShortcutAction(binding) {
    if (binding.channel) send(binding.channel);
    else {
      // 通用"切换主窗口"动作（没指定 channel）
      const win = getMainWindow();
      if (!win) return;
      if (win.isVisible()) win.hide();
      else { win.show(); win.focus(); }
    }
  }

  function registerGlobalShortcuts() {
    if (prefs.get('globalShortcuts') === false) return 0;
    const bindings = readBindings((key) => prefs.get(key));
    let registered = 0;
    for (const binding of bindings) {
      try {
        if (globalShortcut.register(binding.accelerator, () => runShortcutAction(binding))) {
          registered++;
        } else {
          logger.warn(`[shortcuts] ${binding.accelerator} 注册失败（可能已被系统或其它应用占用）`);
        }
      } catch (e) {
        logger.warn(`[shortcuts] 注册 ${binding.accelerator} 失败:`, e.message);
      }
    }
    if (registered > 0) logger.log(`[shortcuts] 全局快捷键已注册 ${registered}/${bindings.length}`);
    return registered;
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

  return {
    register: registerGlobalShortcuts,
    unregister: unregisterGlobalShortcuts,
    setEnabled: updateGlobalShortcutsEnabled,
  };
};
