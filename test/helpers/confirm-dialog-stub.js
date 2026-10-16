/**
 * confirmDialog.js 的测试替身：视图静态 import 它，钩子（i18n-redirect-hooks.js）
 * 在解析层把真身换成本文件。
 *
 * 控制口是全局 `globalThis.__TEST_CONFIRM__`：
 *   - 未设 / true：恒同意（保持既有测试的默认行为不变）；
 *   - 函数：逐次调用 `(opts)`，测试用来计数、按内容决定、或恒拒；
 *   - false：恒拒绝。
 * 每次调用把 opts 记进 `globalThis.__TEST_CONFIRM_CALLS__`（数组），
 * 用例结束后可断言「弹了几次、问了什么」。
 */
export async function askConfirm(opts) {
  const g = globalThis;
  const calls = (g.__TEST_CONFIRM_CALLS__ = g.__TEST_CONFIRM_CALLS__ || []);
  calls.push(opts);
  const mode = g.__TEST_CONFIRM__;
  if (typeof mode === 'function') return !!(await mode(opts));
  return mode !== false;
}

// 真身还导出其它名（confirmDanger 等），替身给恒同意的兜底，避免 import 侧炸掉
export async function confirmDanger(opts) { return askConfirm(opts); }
