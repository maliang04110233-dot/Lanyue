/**
 * 测试：listAxes —— 「列表过滤/排序轴」声明式装配
 *
 * 钉的是装配这件事本身：一张表进来，一组按钮出去，cycle(id) 走对应那条轴，
 * init() 只同步不换档，各轴共用同一个 onChange。不钉 local.js 的具体写法
 * （那是接线钉的事），这里钉可复用的机制。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mod = () => import(`${pathToFileURL(path.join(REPO, 'src/renderer/js/listAxes.js')).href}?t=${Math.random()}`);

globalThis.document = { getElementById: () => null };

function fakeBtn() { return { style: {}, textContent: '', classList: { _on: false, toggle(_k, v) { this._on = !!v; } } }; }
function mountBtns(ids) {
  const map = {};
  for (const id of ids) map[id] = fakeBtn();
  globalThis.document = { getElementById: (q) => map[q] || null };
  return map;
}

test('wireAxes：一组轴装配出各自按钮，cycle(id) 只走对应那条', async () => {
  const { wireAxes } = await mod();
  const btns = mountBtns(['axA', 'axB']);
  const modes = { a: 'all', b: 'x' };
  let refiltered = 0;
  const MODES = ['all', '1', '2'];
  const nextOf = (m) => MODES[(MODES.indexOf(m) + 1) % MODES.length];
  const g = wireAxes([
    { id: 'a', btnId: 'axA', get: () => modes.a, set: (m) => { modes.a = m; }, next: nextOf, label: (m) => 'A:' + m },
    { id: 'b', btnId: 'axB', get: () => modes.b, set: (m) => { modes.b = m; }, next: () => 'y', label: () => 'B', isActive: () => false },
  ], () => { refiltered++; });

  g.cycle('a');
  assert.equal(modes.a, '1', 'a 轴走一格');
  assert.equal(btns.axA.textContent, 'A:1', 'a 轴按钮文案更新');
  assert.equal(btns.axA.classList._on, true, 'a 轴高亮（非 all）');
  assert.equal(modes.b, 'x', 'b 轴不受影响');
  assert.equal(btns.axB.textContent, '', 'b 轴按钮未被碰');
  assert.equal(refiltered, 1, '共用 onChange 被调一次');
});

test('wireAxes：init() 只同步按钮，不换档不回调', async () => {
  const { wireAxes } = await mod();
  const btns = mountBtns(['axA']);
  let mode = 'all';
  let refiltered = 0;
  const g = wireAxes([
    { id: 'a', btnId: 'axA', get: () => mode, set: (m) => { mode = m; }, next: (m) => 'zzz', label: (m) => 'L:' + m },
  ], () => { refiltered++; });
  g.init();
  assert.equal(mode, 'all', 'init 不得换档');
  assert.equal(btns.axA.textContent, 'L:all', 'init 应把按钮同步成当前档');
  assert.equal(refiltered, 0, 'init 不该触发 onChange');
});

test('wireAxes：cycle(未知 id) 安全静默（不抛）', async () => {
  const { wireAxes } = await mod();
  mountBtns(['axA']);
  const g = wireAxes([{ id: 'a', btnId: 'axA', get: () => 'x', set: () => {}, next: () => 'y', label: () => 'z' }], () => {});
  assert.doesNotThrow(() => g.cycle('nope'));
});

test('wireAxes：getExtra 的上下文透传到对应轴的 next', async () => {
  const { wireAxes } = await mod();
  mountBtns(['axA']);
  let seen = null;
  const g = wireAxes([
    { id: 'a', btnId: 'axA', get: () => 'm', set: () => {}, next: (m, extra) => { seen = extra; return 'n'; }, label: () => 'L', getExtra: () => ['CTX'] },
  ], () => {});
  g.cycle('a');
  // getExtra() 的返回值被展开进 next 的位置参数，故 extra 形参拿到的是首元素
  assert.equal(seen, 'CTX');
});
