/**
 * 无依赖的 HTML/JS 转义兜底（2026-10-13 复审 P3-2）
 *
 * 为什么需要这个模块：
 *
 * `src/renderer/js/utils.js` 把 esc / escQ / escAttr 挂到 `window` 上供各视图
 * 直接用（渲染层无框架，模块之间靠全局桥连接）。但 utils.js 自身有动态
 * `import()`（errBrief 等），它把全局挂上之前，同一批依赖这些全局的模块**可能
 * 已经求值并渲染过**。历史上就是靠下面这种写法兜底的：
 *
 *     const esc_ = typeof esc === 'function' ? esc : (s => String(s));
 *
 * 降级目标是 `String(s)` —— 也就是**恒等**：一旦走到这条分支，远端歌名会以原文
 * 进入 innerHTML，在 contextIsolation 已开启的前提下等于渲染层任意 JS，
 * 而渲染层握着约 90 个 IPC 通道的调用权。恒等降级比没有降级更危险，因为它看起来
 * 是「做了处理」。
 *
 * 所以把兜底放进一个**零依赖**的小模块，由调用点静态 import：
 *
 *   1. 静态 import 不受加载顺序影响 —— 本模块求值时一定可用；
 *   2. 兜底实现本身就是安全转义，而不是恒等；
 *   3. 每次调用时再看全局版有没有就绪 —— 就绪就用全局版（保证与全站口径一致，
 *      将来 esc 改了这里自动跟随），没就绪才用等价兜底。
 *
 * 语义严格对应 utils.js：escHtml ≡ esc、escJsString ≡ escQ。
 */

/** HTML 实体转义（对应 utils.js 的 escAttr / esc） */
export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 内联事件属性里 JS 字符串字面量的转义（对应 utils.js 的 escQ）。
 *
 * 顺序不能改：先转义反斜杠，否则 `foo\` 会把后面的 `\'` 变成 `\'` 的转义义，
 * 单引号照样逃出字符串。
 */
export function escJsString(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 文本/属性位置的转义：全局版就绪就用全局版，否则用等价兜底 */
export function escSafe(s) {
  const f = globalThis.esc;
  return typeof f === 'function' ? f(s) : escHtml(s);
}

/**
 * 内联事件处理器里 JS 字符串字面量的转义。
 *
 * ⚠️ 这里**不能**退化成 escSafe：浏览器会先做 HTML 实体解码再执行 JS，
 * 实体化的 `&#39;` 解码后又是裸单引号。详见 test/inline-handler-escape.test.js。
 */
export function escQSafe(s) {
  const f = globalThis.escQ;
  return typeof f === 'function' ? f(s) : escJsString(s);
}
