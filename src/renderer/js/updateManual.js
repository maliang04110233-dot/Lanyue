/**
 * 更新失败弹层的内容生成（纯函数，无 DOM）
 *
 * 之前失败弹层把 `result.error` 直接插进 innerHTML，三处各拼一份 ——
 * 一处漏转义就是一个 XSS 面（releaseNotes 那条已经踩过，见 updater.js 里
 * handleUpdateAvailable 的注释）。现在文案统一由这里生成，规则只有一条：
 *
 *   **URL 绝不进 HTML。**
 *
 * 手动下载地址来自打包资源 app-update.yml（外部可控），若把它插进
 * `onclick="openUpdateManualPage('${url}')"`，注入与否就只剩"某个 esc 有没有被
 * 记得调用"这一层保护。所以按钮只带一颗无值的 data-update-manual 标记（内联桥在
 * node 里点不动，走委托才有真行为测——176/193 同一条"内联桥不留"的纪律），URL 交给调用方存在模块变量里，
 * 点击时再取 —— 注入面从"被转义了"变成"根本不存在"。
 */

const DEFAULT_LABEL = '更新失败';

const escDefault = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function manualEntryHtml() {
  return '<button data-update-manual="" ' +
    'style="margin-top:10px;width:100%;padding:8px;background:var(--neon-cyan);' +
    'color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">' +
    '🌐 打开下载页</button>';
}

/**
 * @param {{label?:string, message?:string, manualUrl?:string|null, esc?:Function}} [opts]
 * @returns {{html:string, manualUrl:string|null}} manualUrl 原样交回，由调用方保管
 */
export function buildUpdateFailure(opts = {}) {
  const { label = DEFAULT_LABEL, message, manualUrl = null } = opts;
  // 打包环境用全局 esc（与弹层其余分支同一支），node 单测下没有 window → 自带等价实现
  const esc = opts.esc || (typeof window !== 'undefined' && window.esc) || escDefault;
  const text = esc(message || '未知错误');
  return {
    html: `<div style="color:var(--neon-orange);">${esc(label)}：${text}</div>` +
      (manualUrl ? manualEntryHtml() : ''),
    manualUrl: manualUrl || null,
  };
}
