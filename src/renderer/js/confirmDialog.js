/**
 * 不可逆操作确认弹层（起工时记 174、落库时让号为 176）
 *
 * 全应用「确认一下再动手」的唯一家：替换浏览器原生确认框——
 * 原生窗是系统灰白外观（与霓虹深色主题割裂）、带 file:// 技术标题行，
 * 还会把多行点名文案压平成一行（157/159 写的 F2 纪律 bullet 全被吃掉）。
 *
 * 分工：confirmDetails 是纯模型（文案归一化，node 可测）；
 * askConfirm 只管 DOM 与Promise，弹层样式全部在 overlays.css 的
 * .confirm-dialog* 类里（161 纪律：CSS 进 css 文件，JS 不裸写样式）。
 *
 * 同一时刻只有一个确认框：confirm 本来就是单例阻塞语义；
 * 双击/连按第二个调用复用同一个 Promise，不会出现两层弹层各等一次决定。
 *
 * 键盘围堵契约（182，aria-modal 的行为面）：弹层开着时 Enter 归聚焦的那颗钮
 * （浏览器原生激活，我们不代劳）、Tab 只在取消/确认间循环、Esc 即取消，
 * 其余按键一律封在弹层内不外漏给后台快捷键；关闭后焦点归还唤起弹层的元素。
 *
 * 让位契约（186，围堵的镜像面）：capture 队列按注册序执行，围堵罩不到比本模块
 * 早注册的监听（如 welcome 引导层的 Esc）——那些抢跑者须自觉先问 hasOpenConfirm()，
 * 确认框开着即让位。两侧的规矩合起来才是完整的"最上层赢"。
 */

export const CONFIRM_FALLBACK_TITLE = '确认执行该操作？';

/** 把调用方入参归一成弹层模型 { title, lines, okLabel, cancelLabel, danger } */
export function confirmDetails(opts) {
  let o = opts;
  if (o == null || typeof o === 'number' || typeof o === 'boolean') {
    o = { text: String(o ?? CONFIRM_FALLBACK_TITLE) };
  } else if (typeof o === 'string') {
    o = { text: o };
  }
  const raw = o.text != null ? String(o.text)
    : (o.title != null ? String(o.title) : CONFIRM_FALLBACK_TITLE);
  const parts = raw.split(/\r?\n/);
  // 显式给了 title 时，text 整段都是正文；否则首行当标题
  const hasTitle = o.title != null && String(o.title).trim() !== '';
  const title = hasTitle ? String(o.title).trim() : (parts[0].trim() || CONFIRM_FALLBACK_TITLE);
  const bodyLines = hasTitle ? parts : parts.slice(1);
  const lines = (Array.isArray(o.lines) && o.lines.length ? o.lines : bodyLines)
    .map((l) => String(l).trim())
    .filter(Boolean);
  return {
    title,
    lines,
    okLabel: o.okLabel || '确认',
    cancelLabel: o.cancelLabel || '取消',
    danger: o.danger === true,
  };
}

let _current = null; // { el, promise, done }

/**
 * 确认框此刻是否开着——叠层键盘归属契约的问话接口。
 * capture 相监听按注册序执行，比确认框晚注册的会被 182 的围堵罩住；
 * 比它早注册的（如 welcome 的引导层 Esc）跑在前面，围堵鞭长莫及——
 * 这类"抢跑者"处理按键前必须先问 hasOpenConfirm()，开着即让位。
 */
export function hasOpenConfirm() {
  return _current != null;
}

/**
 * 弹一个确认框，返回 Promise<boolean>（true=点确认，false=取消/Esc/点遮罩）。
 * 调用处必须 await——不 await 的确认框等于没有确认。
 */
export function askConfirm(opts) {
  if (_current) return _current.promise;
  const model = confirmDetails(opts);
  // 182 契约：关闭后焦点要还给唤起弹层的元素，键盘用户不丢位置
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';
  overlay.setAttribute('data-modal', '');
  const box = document.createElement('div');
  box.className = 'confirm-dialog' + (model.danger ? ' danger' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.className = 'confirm-dialog-title';
  title.textContent = model.title;
  box.appendChild(title);

  if (model.lines.length) {
    const body = document.createElement('div');
    body.className = 'confirm-dialog-body';
    for (const line of model.lines) {
      const row = document.createElement('div');
      row.className = 'confirm-dialog-line';
      row.textContent = line; // 文案可能点名含尖括号的歌单/文件名，只走 textContent
      body.appendChild(row);
    }
    box.appendChild(body);
  }

  const footer = document.createElement('div');
  footer.className = 'confirm-dialog-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'setting-btn confirm-dialog-cancel';
  cancelBtn.textContent = model.cancelLabel;
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'setting-btn confirm-dialog-ok';
  okBtn.textContent = model.okLabel;
  footer.appendChild(cancelBtn);
  footer.appendChild(okBtn);
  box.appendChild(footer);
  overlay.appendChild(box);

  let done = null;
  const promise = new Promise((resolve) => { done = resolve; });
  _current = { el: overlay, promise, done };

  const focusables = [cancelBtn, okBtn];
  const close = (val) => {
    if (!_current) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    _current = null;
    if (opener && typeof opener.focus === 'function') opener.focus();
    done(val);
  };
  // 182 契约（aria-modal 的行为面）：弹层开着，键盘事件就只属于弹层——
  // ① 围堵：任何 keydown 都 stopImmediatePropagation，后台全局快捷键（空格播放、⌘K）
  //    不得越过模态去动背后的页面；
  // ② Enter 不再全局代按确认钮：Enter 的激活归浏览器原生"按下聚焦的那颗钮"，
  //    我们代劳就会做出"焦点在取消、回车却执行不可逆删除"这种事；
  // ③ Tab 在取消/确认间循环且 preventDefault——三键小键盘不出弹层就是完整的陷阱。
  const onKey = (ev) => {
    ev.stopImmediatePropagation();
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
    else if (ev.key === 'Tab') {
      ev.preventDefault();
      const i = focusables.indexOf(document.activeElement);
      focusables[(i + 1) % focusables.length].focus();
    }
  };
  okBtn.addEventListener('click', () => close(true));
  cancelBtn.addEventListener('click', () => close(false));
  // 点遮罩=取消：危险级也允许——原生 confirm 点遮罩本就取消，不另设门槛
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  // 焦点给取消：键盘用户回车即确认、Esc/空格即离开，两条路都在指边
  cancelBtn.focus();
  return promise;
}
