/**
 * MusicDL Toast 通知系统
 *
 * 多级类型、自动消失。错误码文案不住这里：唯一住处是 diagnose.js 的码表
 * 反馈文案的住处是语言包：这里不写中文字面量，也不做句子拼接。
 *
 * ES Module — export 供其他模块 import，同时保留 window 全局供 HTML onclick
 */

// ── Toast 类型映射 ───────────────────────────────────
const TYPE_CONFIG = {
  info:    { icon: 'ℹ️',  duration: 3000, className: 'toast-info' },
  success: { icon: '✅',  duration: 3000, className: 'toast-success' },
  warn:    { icon: '⚠️',  duration: 4000, className: 'toast-warn' },
  error:   { icon: '❌',  duration: 5000, className: 'toast-error' },
};

/**
 * 显示 Toast 通知
 * @param {string} msg - 消息内容
 * @param {string} [type='info'] - info | success | warn | error
 * @param {number} [duration] - 显示时长 ms（覆盖默认）
 */
function showToast(msg, type = 'info', duration) {
  // 自动翻译（英文模式下）
  if (typeof window.translateMessage === 'function') {
    msg = window.translateMessage(msg);
  }
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.info;
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast ${cfg.className}`;
  el.textContent = msg;
  container.appendChild(el);

  const dur = duration !== undefined ? duration : cfg.duration;
  setTimeout(() => {
    el.style.animation = 'toast-out .25s ease forwards';
    setTimeout(() => el.remove(), 250);
  }, dur);
}

/**
 * 显示下载错误（根据 fatal 区分样式）
 *
 * 整句进词典而不是"前缀 + 内容"拼接：拼接出来的半截中文躲得过任何按实参扫的巡扫，
 * 且中文的「：」分隔形状会渗进英文界面。
 * 两个分支各写一次 translate('字面量')：键名必须是带引号的字面量，守护测试才认得出它的消费方（974fe2f 同律）。
 *
 * 取词函数按参数注入而不是 `import { t } from './i18n.js'`：本文件要被 node 的测试直接
 * import（toast-timing.test.js），而 i18n.js 静态导入语言包 JSON —— node 要求那种写法带
 * import attribute，本仓 eslint 的 espree 又解析不了 attribute（两条路都堵，见 toast-i18n.test.js）。
 * 约定与 listAccess.js / home.js 的 term 参数同源：**可测文件不拖 JSON 进图**。
 * translate 不给默认值：漏传时当场炸，比悄悄把键名印在界面上好（c65a888 的"静默空值"同一课）。
 */
function showDownloadError(title, error, fatal, translate) {
  if (fatal) {
    showToast(translate('toast.dlFatal', { title, error }), 'error', 5000);
    return;
  }
  showToast(translate('toast.dlError', { title, error }), 'error', 5000);
}

// ── ES Module 导出 ──────────────────────────────────────
export { showToast, showDownloadError };

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.showToast = showToast;
window.showDownloadError = showDownloadError;
