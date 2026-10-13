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
 * 刷屏防护（2026-10-13）
 *
 * 此前 showToast 无条件 appendChild，到期才逐条移除 ⇒ **同时在屏条数无上限**。
 * 自动跳曲场景下一句失败文案会在两三秒内连来十几条（用户截图实证：整个界面被
 * toast 糊住、不可操作）。两条闸：
 *   ① 同文案在同一条还在屏上时重复 → 合并成「原文 ×N」，不新起一条；
 *   ② 超过 MAX_VISIBLE 条 → 立即踢掉最早那条（被挤掉的没有资格慢慢退场）。
 *
 * 两条闸都只动"重复的/多余的"，单条 toast 的到期退场契约一字未改
 * （test/toast-timing.test.js 的 ①②③④ 仍绿）。
 */
const MAX_VISIBLE = 6;
const _recent = new Map(); // msg -> { el, count, timer }

/** 从去重表里摘掉某个元素（元素已离场必须摘，否则同文案会被误判成"还在屏上"） */
function _forget(el) {
  for (const [k, v] of _recent) {
    if (v.el === el) { clearTimeout(v.timer); _recent.delete(k); }
  }
}

/**
 * 到期退场：先挂退场动画，250ms 后真移除（契约①，见 test/toast-timing.test.js）
 *
 * 刻意**不做"是否还在屏上"的前置判断**：remove() 本身幂等，对已离场的元素再调
 * 一次无害。此前这里写的是 `if (!el || !el.parent) return;` —— 真实 DOM 的元素
 * **没有 parent 属性**（只有 parentElement / parentNode），于是每次到期都
 * `undefined` 提前返回，**toast 永远不会消失**（2026-10-13 用户实测发现）。
 *
 * 之所以能一路绿灯：测试桩 stubEl 恰好带一个 parent 字段。真实运行时与桩不一致，
 * 是本轮第三次踩同一类坑（登记簿 key 归一化、CSP 注释字样、这里的 parent）。
 */
function _dismiss(el) {
  if (!el) return;
  _forget(el);
  el.style.animation = 'toast-out .25s ease forwards';
  setTimeout(() => el.remove(), 250);
}

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
  const dur = duration !== undefined ? duration : cfg.duration;

  // ① 同文案重复 → 合并计数，不新起一条。
  //    判据用 container.contains() 而不是 el.parent —— 后者在真实 DOM 里不存在，
  //    会让"这条还在屏上吗"永远答否（要么永不合并，要么永不消失）。
  const prev = _recent.get(msg);
  if (prev && prev.container && prev.container.contains(prev.el)) {
    prev.count += 1;
    prev.el.textContent = `${msg} ×${prev.count}`;
    clearTimeout(prev.timer);
    prev.timer = setTimeout(() => _dismiss(prev.el), dur);
    return;
  }

  const el = document.createElement('div');
  el.className = `toast ${cfg.className}`;
  el.textContent = msg;
  container.appendChild(el);
  const rec = { el, count: 1, timer: null, container };
  rec.timer = setTimeout(() => _dismiss(el), dur);
  _recent.set(msg, rec);

  // ② 在屏上限：踢最早的（立即移除，不等退场动画）
  while (container.children.length > MAX_VISIBLE) {
    const oldest = container.children[0];
    _forget(oldest);
    oldest.remove();
  }
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
