/**
 * node ESM 解析钩子：把模块图里**任何** `i18n.js` 换成测试替身；
 * 把 `confirmDialog.js` 换成可被测试控制的替身。
 *
 * 为什么用钩子而不是在入口文件里改源码：改源码只能救入口那一个文件，
 * 而它 import 的任何一层若也碰 i18n.js 就会照旧炸在 JSON import 上。
 * 钩子作用在**解析**这一层，整张图一次覆盖。
 *
 * 只认 URL 尾段 `/js/i18n.js`（真身只有那一个），换成同目录的 i18n-stub.js。
 * confirmDialog 同理：视图静态 import 它，测试里想控制「用户点了确定还是取消」
 * 必须在解析层换掉（extraGlobals 兜不住静态 import）。
 *
 * confirm-dialog-stub 读全局开关 `globalThis.__TEST_CONFIRM__`：
 *   - 默认（未设/为 true）恒同意；
 *   - 设为函数则逐次调用它（测试可计数、可按内容决定）；
 *   - 设为 false 恒拒绝。
 */
const I18N_STUB = new URL('./i18n-stub.js', import.meta.url).href;
const CONFIRM_STUB = new URL('./confirm-dialog-stub.js', import.meta.url).href;

// 钩子跑在独立 loader 线程，测试进程里的 globalThis 在这里不可见；
// 开关只能由注册方经 register(..., { data }) 一次性传进来（见 view-module.js）。
// 每个测试文件是独立进程，互不影响。
let STUB_CONFIRM = false;

export async function initialize(data) {
  STUB_CONFIRM = !!(data && data.stubConfirm);
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (typeof resolved.url === 'string') {
    if (/\/js\/i18n\.js$/.test(resolved.url)) {
      return { ...resolved, url: I18N_STUB, shortCircuit: true };
    }
    if (STUB_CONFIRM && /\/js\/confirmDialog\.js$/.test(resolved.url)) {
      return { ...resolved, url: CONFIRM_STUB, shortCircuit: true };
    }
  }
  return resolved;
}
