/**
 * 测试：listSelection —— 列表多选的动作逻辑（单一事实源）
 *
 * 覆盖的是从四个列表里收敛出来的那套动作语义。收敛前的等价性由
 * bulk-selection.test.js 钉住接线（锚点态 / onclick 传 event / import 到
 * isRangeClick 的来源），本文件钉**行为**：勾选、Shift 连选（只并入不清空）、
 * 全选所见即所得、清空后锚点失效、选中条随模式位显隐。
 *
 * 状态由视图持有（钩子注入），工厂不复制状态 —— 所以这里用一组闭包变量扮演
 * 视图，断言的是「动作把视图状态改成什么」，而不是工厂内部字段。
 *
 * 与 selectionRange.js 的分工：区间数学在那儿（那边另有直调单测），这里只验
 * 「把数学用对了」——用哪个视图序、锚点取谁、并入还是替换。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mod = () => import(`${pathToFileURL(path.join(REPO, 'src/renderer/js/listSelection.js')).href}?t=${Math.random()}`);

/** 默认兜底 document：让不关心 DOM 的用例也能跑（选中条同步只是查不到元素就返回）。 */
globalThis.document = { getElementById: () => null };

/** 极简 document 桩：把传入的元素对象**按引用**交给 getElementById，
 *  这样工厂改的就是测试断言的同一个对象。 */
function installDoc(els) {
  globalThis.document = {
    getElementById(id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
  };
}

/** 用一组闭包变量扮演「视图持有的状态」，返回工厂实例 + 状态句柄。 */
function harness(viewKeys) {
  let mode = false;
  const set = new Set();
  let anchor = null;
  const state = {
    get mode() { return mode; },
    get set() { return set; },
    get anchor() { return anchor; },
  };
  return { state, cfg: {
    isMode: () => mode,
    setMode: (v) => { mode = v; },
    getSet: () => set,
    getAnchor: () => anchor,
    setAnchor: (k) => { anchor = k; },
    getViewKeys: () => viewKeys.slice(),
    barId: 'xSelectionBar',
    countId: 'xSelectionCount',
    cbPrefix: 'xcb_',
  } };
}

test('enter/exit：切模式时清空整批并把锚点归零', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b']);
  const s = createListSelection(h.cfg);
  s.enter();
  s.toggle(0, 'a', {});
  s.toggle(1, 'b', {});
  assert.equal(h.state.mode, true);
  assert.equal(h.state.set.size, 2);
  assert.equal(h.state.anchor, 'b');
  s.exit();
  assert.equal(h.state.mode, false);
  assert.equal(h.state.set.size, 0, '退出应清空选中');
  assert.equal(h.state.anchor, null, '退出应把锚点归零');
});

test('toggle：点一下选中、再点取消，锚点跟着最后一次点击', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b', 'c']);
  const s = createListSelection(h.cfg);
  s.toggle(0, 'a', {});
  assert.deepEqual([...h.state.set], ['a']);
  assert.equal(h.state.anchor, 'a');
  s.toggle(0, 'a', {});
  assert.deepEqual([...h.state.set], [], '再点一次应取消');
  assert.equal(h.state.anchor, 'a', '取消后锚点仍指向这一行（range 起点语义）');
});

test('toggle + Shift：连选只并入不清空，区间取「锚点→本次」闭区间', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b', 'c', 'd']);
  const s = createListSelection(h.cfg);
  s.toggle(0, 'a', {});          // 锚点 = a
  s.toggle(3, 'd', { shiftKey: true }); // a..d 整段并入
  assert.deepEqual([...h.state.set].sort(), ['a', 'b', 'c', 'd']);
  // 再按住 Shift 点 b：并入 b（已在选态），不清掉别的
  s.toggle(1, 'b', { shiftKey: true });
  assert.equal(h.state.set.size, 4, 'Shift 是「延伸选择」，不清既有勾选');
});

test('toggle + Shift：锚点已被过滤掉时退化为只点这一行（宁可不连）', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b']);      // 视图序已不含锚点 'z'
  const s = createListSelection(h.cfg);
  h.cfg.setAnchor('z');               // 锚点指向已被过滤掉的行
  s.toggle(0, 'a', { shiftKey: true });
  assert.deepEqual([...h.state.set], ['a'], '锚点不在视图里应只并本行');
});

test('selectAll：只选当前视图序（所见即所得），不看全集', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b']);
  const s = createListSelection(h.cfg);
  s.selectAll();
  assert.deepEqual([...h.state.set].sort(), ['a', 'b']);
});

test('deselectAll：清空整批且把锚点归零（锚点行已不在选态）', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b']);
  const s = createListSelection(h.cfg);
  s.toggle(0, 'a', {});
  s.deselectAll();
  assert.equal(h.state.set.size, 0);
  assert.equal(h.state.anchor, null);
});

test('选中条：未进模式隐藏、进模式显形并显示计数', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b', 'c']);
  const bar = { style: {}, textContent: '' };
  const count = { style: {}, textContent: '' };
  installDoc({ xSelectionBar: bar, xSelectionCount: count });
  const s = createListSelection(h.cfg);
  s.syncBar();                       // 未进模式
  assert.equal(bar.style.display, 'none');
  s.enter();
  assert.equal(bar.style.display, 'flex');
  s.toggle(0, 'a', {});
  s.toggle(1, 'b', {});
  assert.equal(count.textContent, '2', '计数应等于选中集大小');
  s.exit();
  assert.equal(bar.style.display, 'none', '退出后重新隐藏');
});

test('toggle：只同步被点那一行的勾选框（局部更新，不重绘整表）', async () => {
  const { createListSelection } = await mod();
  const h = harness(['a', 'b']);
  const cb0 = { style: {}, checked: false };
  const cb1 = { style: {}, checked: false };
  installDoc({ xSelectionBar: { style: {} }, xSelectionCount: { style: {}, textContent: '' }, xcb_0: cb0, xcb_1: cb1 });
  const s = createListSelection(h.cfg);
  s.toggle(0, 'a', {});
  assert.equal(cb0.checked, true, '被点行的框应勾上');
  assert.equal(cb1.checked, false, '未点的行不受影响');
});
