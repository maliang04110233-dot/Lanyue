/**
 * 首次启动新手引导
 *
 * prefs.welcomeSeen 非 true 时展示一次性引导浮层：
 * 三条核心用法（剪贴板识别 / 登录解锁音质 / 目录与命名）+ 快捷键提示。
 * 「开始使用」永久关闭；「稍后再说」仅本次关闭，下次启动仍会提示。
 *
 * 键盘叠层纪律：本层的 Esc 是 document-capture 监听、注册早于
 * confirmDialog——capture 队列按注册序执行，182 的围堵罩不到它，所以处理前
 * 必须问 hasOpenConfirm()：确认框开着时这一次 Esc 归最上层，本层让位。
 * 不让位的后果是双抢——按"取消"关个对话框，连没读完的引导被顺手永久关闭。
 *
 * 键盘契约（182 三件套推广到第二个模态）：
 * ① 打开即把焦点送进浮层，落「稍后再说」——回车即走的路径必须指向保守出口，
 *    不能是那颗顺手写 welcomeSeen 的「开始使用」；
 * ② Tab/Shift+Tab 只在浮层 4 颗钮间循环且 preventDefault（焦点陷阱）；
 * ③ 浮层开着时键盘整体封层（stopImmediatePropagation），背景快捷键看不见任何键；
 *    唯一的例外还是 186 的让位：确认框开着时本层连围堵一起收手，键归上面那层；
 * ④ 两条关闭路径（Esc / 按钮）焦点都归还唤起引导的元素；
 * ⑤ Esc 的语义对齐「稍后再说」而非「开始使用」：Esc 是无标记的"退出"，
 *    不该替用户做"永久不再展示"的决定；
 * ⑥ 动作走 data-welcome + 浮层点击委托，不留内联 onclick 全局桥（176 纪律）。
 */

import { hasOpenConfirm } from '../confirmDialog.js';

let _overlay = null;
let _keyHandler = null;
let _opener = null;

function welcomeCard(icon, title, desc, btn) {
  return `
    <div class="welcome-card">
      <div class="welcome-card-icon">${icon}</div>
      <div class="welcome-card-body">
        <div class="welcome-card-title">${title}</div>
        <div class="welcome-card-desc">${desc}</div>
      </div>
      ${btn || ''}
    </div>`;
}

function _focusables() {
  return _overlay ? Array.prototype.slice.call(_overlay.querySelectorAll('button')) : [];
}

function showWelcome() {
  if (_overlay) return;
  _opener = document.activeElement;
  _overlay = document.createElement('div');
  _overlay.className = 'welcome-overlay';
  _overlay.id = 'welcomeOverlay';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  // 浮层注册表：legacy 的 _anyModalOpen 靠 '.welcome-overlay' 类名暗号
  // 认引导层，如今换成属性；Esc 语义住自家 capture 监听（193），不授关闭契约。
  _overlay.setAttribute('data-modal', '');
  _overlay.innerHTML = `
    <div class="welcome-panel">
      <div class="welcome-title">🎧 欢迎使用 揽乐</div>
      <div class="welcome-sub">三步上手，下载无损音乐</div>
      ${welcomeCard('📋', '复制或拖入链接，自动识别',
        '把各音乐平台的歌曲、歌单、专辑链接复制出来（或直接拖进窗口），应用会自动弹出识别条，一键加入队列。')}
      ${welcomeCard('🔐', '登录账号，解锁高音质',
        '部分平台的高音质 / 无损需扫码登录解锁；免登录可直接下载的平台在「设置 → 平台账号」里标出。',
        '<button class="btn welcome-btn" data-welcome="goto:accounts">去登录</button>')}
      ${welcomeCard('📂', '下载目录与命名规则',
        '默认保存到「音乐/MusicDownloader」，可修改目录、文件命名模板、并发数与限速。',
        '<button class="btn welcome-btn" data-welcome="goto:download">去设置</button>')}
      <div class="welcome-hint">💡 小技巧：菜单里的「聚焦搜索」快捷键随时唤起搜索；下载队列支持 ⏫ 置顶和 ⬆⬇ 调整顺序。</div>
      <div class="welcome-actions">
        <button class="btn ghost" data-welcome="later">稍后再说</button>
        <button class="btn primary" data-welcome="start">开始使用</button>
      </div>
    </div>`;
  _overlay.addEventListener('click', (ev) => {
    const t = ev.target;
    const act = t && typeof t.getAttribute === 'function' ? t.getAttribute('data-welcome') : null;
    if (act === 'later') welcomeLater();
    else if (act === 'start') closeWelcome();
    else if (act && act.indexOf('goto:') === 0) welcomeGoto(act.slice(5));
  });
  document.body.appendChild(_overlay);
  _keyHandler = (ev) => {
    // 186 让位优先于 193 围堵：确认框开着时本层什么都不做（连封层也不做），
    // 否则跑在前面的 capture 会把确认框的键盘契约整个掐死。
    if (hasOpenConfirm()) return;
    ev.stopImmediatePropagation();
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      welcomeLater(); // ⑤：Esc = 一次性退出，永久关闭只认「开始使用」
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const list = _focusables();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      const step = ev.shiftKey ? -1 : 1;
      list[((i < 0 ? 0 : i) + step + list.length) % list.length].focus();
    }
  };
  document.addEventListener('keydown', _keyHandler, true);
  // ①：初始焦点落保守出口——键盘用户"回车即走"时不该顺手销毁引导
  const list = _focusables();
  const safe = list.find((b) => b.getAttribute('data-welcome') === 'later') || list[0];
  if (safe) safe.focus();
}

/** 拆层公共路径：解监听、移除、焦点归还 opener（182 规矩，两条关闭路径都走这里） */
function _teardown() {
  if (!_overlay) return;
  document.removeEventListener('keydown', _keyHandler, true);
  _keyHandler = null;
  _overlay.remove();
  _overlay = null;
  if (_opener && typeof _opener.focus === 'function') _opener.focus();
  _opener = null;
}

/** 永久关闭并写入 welcomeSeen——「开始使用」专用 */
function closeWelcome() {
  _teardown();
  try { api.setPref('welcomeSeen', true); } catch (_e) { /* 浏览器开发模式 */ }
}

/** 仅本次关闭：下次启动仍展示（Esc 也走这条，193-⑤） */
function welcomeLater() {
  _teardown();
}

/** 关闭引导并直达设置页签（'accounts' | 'download'） */
function welcomeGoto(tab) {
  closeWelcome();
  if (typeof openSettings !== 'function') return;
  openSettings();
  if (tab && tab !== 'accounts' && typeof switchSettingsTab === 'function') {
    const nav = document.querySelector(`.settings-nav-item[data-tab="${tab}"]`);
    if (nav) switchSettingsTab(tab, nav);
  }
}

/** 应用启动完成后调用：未看过引导才展示 */
async function maybeShowWelcome() {
  try {
    const seen = await api.getPref('welcomeSeen');
    if (seen === true) return;
  } catch (_e) { /* 读不到 prefs 时照常展示 */ }
  showWelcome();
}

window.showWelcome = showWelcome;
window.closeWelcome = closeWelcome;
window.welcomeLater = welcomeLater;
window.welcomeGoto = welcomeGoto;
window.maybeShowWelcome = maybeShowWelcome;
