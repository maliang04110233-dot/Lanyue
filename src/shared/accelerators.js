'use strict';
/**
 * 全局快捷键的判据之家
 *
 * 改造前这四枚绑定写死在 src/main/index.js 的函数体字面量里，设置页只有一枚总开关：
 * 用户能做的只有「全用」或「全不用」。笔记本普遍没有媒体键，于是「全局快捷键」对大半
 * 用户等于不存在；而想把 ⏯ 让给别人的人只能整个关掉。
 *
 * 现在：主进程、设置页 HTML、渲染层 prefs 表三方共用这一张目标清单，由
 * test/global-shortcuts.test.js 逐字对账。白名单就是安全边界 —— 全局热键会抢走其它
 * 程序的按键，所以只放行媒体键与 Ctrl+Alt 组合，且一个动作只能占一枚键（先到先得）。
 */

/** 未绑定。空串同时是 <option value=""> 的形状，渲染层不需要额外的哨兵 */
const UNBOUND = '';

/**
 * 允许注册的 accelerator 白名单。
 * 不放 Ctrl+字母（与浏览器/系统的既有语义撞车）、不放单键、不放 F1-F12（系统保留多）。
 */
const ALLOWED_ACCELERATORS = [
  'MediaPlayPause',
  'MediaPreviousTrack',
  'MediaNextTrack',
  'MediaStop',
  'Ctrl+Alt+Space',
  'Ctrl+Alt+Left',
  'Ctrl+Alt+Right',
  'Ctrl+Alt+Up',
  'Ctrl+Alt+Down',
  'Ctrl+Alt+P',
  'Ctrl+Alt+B',
  'Ctrl+Alt+H',
];

/**
 * 可绑定的动作清单。**顺序即优先级**：两个动作撞上同一枚键时，排在前面的拿到键，
 * 后面的不注册 —— Electron 对同一 accelerator 重复注册会让后一个回调静默失效。
 *
 * channel=null 表示这是主进程自己的动作（窗口显隐），不借道 IPC ⇒ 不新增通道。
 */
const SHORTCUT_TARGETS = [
  { id: 'playPause', prefKey: 'shortcutPlayPause', channel: 'tray-toggle-play', default: 'MediaPlayPause' },
  { id: 'prev', prefKey: 'shortcutPrev', channel: 'tray-prev', default: 'MediaPreviousTrack' },
  { id: 'next', prefKey: 'shortcutNext', channel: 'tray-next', default: 'MediaNextTrack' },
  { id: 'showHide', prefKey: 'shortcutShowHide', channel: null, default: UNBOUND },
];

/**
 * 归一一枚键：白名单内原样放行，主动解绑（空串）保留，其余（垃圾值/大小写不符/带空格）
 * 一律回落到该动作的默认键。宁可回到出厂绑定，也不替用户抢下别的应用的键。
 */
function normalizeAccelerator(raw, fallback) {
  if (raw === UNBOUND) return UNBOUND;
  if (typeof raw === 'string' && ALLOWED_ACCELERATORS.includes(raw)) return raw;
  return ALLOWED_ACCELERATORS.includes(fallback) ? fallback : UNBOUND;
}

/** 出厂 prefs 表（prefKey → 默认 accelerator）。每次给新对象：调用方会就地改它。 */
function defaultShortcutPrefs() {
  const out = {};
  for (const target of SHORTCUT_TARGETS) out[target.prefKey] = target.default;
  return out;
}

/**
 * 解析出真正要注册的绑定。
 * @param {(key: string) => any} getPref 取值器（主进程传 prefs.get 的包装）
 * @returns {{accelerator: string, id: string, channel: string|null}[]}
 */
function readBindings(getPref) {
  const taken = new Set();
  const bindings = [];
  for (const target of SHORTCUT_TARGETS) {
    const accel = normalizeAccelerator(getPref(target.prefKey), target.default);
    if (accel === UNBOUND || taken.has(accel)) continue;
    taken.add(accel);
    bindings.push({ accelerator: accel, id: target.id, channel: target.channel });
  }
  return bindings;
}

module.exports = {
  UNBOUND,
  ALLOWED_ACCELERATORS,
  SHORTCUT_TARGETS,
  normalizeAccelerator,
  defaultShortcutPrefs,
  readBindings,
};
