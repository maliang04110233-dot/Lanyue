/**
 * toast 计时契约钉 —— 181 记下「toast 计时未经真机验证」的欠账，
 * 这里用 domStub + 小 ttl 真实定时器把它钉进 CI（不 fake 全局 setTimeout：
 * 仓里多路在途用例吃真实计时，动全局属越界）。
 *
 * 契约面（toast.js showToast + utils.js showActionToast，两家共用 #toastContainer）：
 *   ① 到期自散：先挂 toast-out 退场动画，250ms 后真移除——不留"永远挂在屏上"的反馈；
 *   ② 点动作钮 = 就地关闭 + 回调恰一次——撤销/仍要下载这类动作钮不许双触发；
 *   ③ 无容器静默返回——toast 是锦上添花，DOM 缺位时不许把调用方（15 处 await 链）炸穿；
 *   ④ 未知类型回落 info 皮；tone 只认 warn/success 两族（155 结构收口 + 177 开族的时间面）。
 *
 * 治理/回归钉钉的是既有不变量，落地即绿属预期（口径同 177/178/181）；
 * 非空转靠三枚变异验证：摘 remove → ①红、摘 onConfirm 调用 → ②红、摘容器 guard → ③红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 DOM 桩：两条 toast 实现真用到的面（getElementById/createElement/
//    appendChild/remove/children/click 监听/style）─────────────────

function stubEl(tag) {
  return {
    tag, parent: null, children: [], className: '', textContent: '', style: {}, _l: {},
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    },
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); },
    click() { (this._l.click || []).forEach((fn) => fn({ type: 'click', target: this })); },
  };
}

const container = stubEl('div');
const doc = {
  createElement: (tag) => stubEl(tag),
  getElementById: (id) => (id === 'toastContainer' && doc._hasContainer ? container : null),
  _hasContainer: true,
};
globalThis.document = doc;
globalThis.window = {}; // toast.js/utils.js 顶层挂 window.* 桥；translateMessage 缺席=中文默认态

const { showToast } = await import(pathToFileURL(R('js', 'toast.js')).href);
const { showActionToast } = await import(pathToFileURL(R('js', 'utils.js')).href);

// ── ① 到期自散 ───────────────────────────────────────────

test('showToast：duration 到点先挂 toast-out 退场动画，250ms 后真从容器移除（到期自散契约）', async () => {
  container.children.length = 0;
  showToast('自散测试', 'info', 20);
  assert.equal(container.children.length, 1, '入容器即上屏');
  await sleep(60);
  const el = container.children[0];
  assert.ok(/toast-out/.test(el.style.animation || ''), '退场先行：到点先挂动画而不是瞬间消失');
  assert.equal(container.children.length, 1, '动画期间还在屏上');
  await sleep(400);
  assert.equal(container.children.length, 0, '动画 250ms 后必须真移除');
});

// ── ② 点击即关 + 恰一次 ──────────────────────────────────

test('showActionToast：点动作钮=就地关闭且回调恰一次，ttl 到点不二次触发（撤销钮不许双触发）', async () => {
  container.children.length = 0;
  let confirms = 0;
  showActionToast({ text: '已删除歌单', btnLabel: '撤销', onConfirm: () => { confirms += 1; }, ttl: 120 });
  const el = container.children[0];
  const btn = el.children.find((c) => c.className === 'toast-action-btn');
  assert.ok(btn, '动作钮必须存在（155 结构收口的行为面）');
  btn.click();
  assert.equal(confirms, 1, '点击即回调');
  assert.equal(container.children.length, 0, '点击即关，不等 ttl');
  await sleep(300);
  assert.equal(confirms, 1, 'ttl 到点不得把回调再触发一次');
  assert.equal(container.children.length, 0);
});

// ── ② 的另一半：没人按也一样离场，但不许碰回调 ──────────

test('showActionToast：没人按也到期自散，且回调不顺手触发（到点消失≠替你决定）', async () => {
  container.children.length = 0;
  let confirms = 0;
  showActionToast({ text: '没人按', btnLabel: '仍要下载', onConfirm: () => { confirms += 1; }, ttl: 20 });
  await sleep(450);
  assert.equal(container.children.length, 0, 'ttl 到点必须自散');
  assert.equal(confirms, 0, '自散不是确认——过期后撤销窗口关闭，回调保持沉默');
});

// ── ③ 无容器静默返回 ─────────────────────────────────────

test('无 #toastContainer 时两种 toast 都静默返回（toast 是锦上添花，不许把调用方炸穿）', () => {
  doc._hasContainer = false;
  try {
    assert.doesNotThrow(() => showToast('没容器', 'error', 10));
    assert.doesNotThrow(() => showActionToast({ text: '没容器', btnLabel: '钮', onConfirm: () => {} }));
  } finally {
    doc._hasContainer = true;
  }
});

// ── ④ 类型/tone 回落 ─────────────────────────────────────

test('未知 type 回落 info 皮；tone 只认两族：默认 warn、177 庆祝 success（类名钉死在 base.css 既有族）', async () => {
  container.children.length = 0;
  showToast('怪类型', 'no-such-type', 10);
  assert.equal(container.children[0].className, 'toast toast-info', '未知类型必须落到有皮的 info');
  showActionToast({ text: '警告族', btnLabel: '钮' });
  showActionToast({ text: '庆祝族', btnLabel: '钮', tone: 'success' });
  const [warnEl, okEl] = container.children.slice(1);
  assert.equal(warnEl.className, 'toast toast-warn toast-action');
  assert.equal(okEl.className, 'toast toast-success toast-action');
  warnEl.remove(); okEl.remove(); // 收摊：不等 6 秒默认 ttl
});
