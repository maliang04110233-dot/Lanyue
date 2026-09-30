/**
 * 测试：filterCycle —— 「循环过滤/排序档位」按钮的共通动作
 *
 * 从本地曲库四枚循环按钮（🧪 音质 / 🏷 完整度 / 🎞 格式 / ↕ 排序）收敛而来。
 * 档位表与文案词表留在各自卫星（那边另有直调单测），这里钉的是**落按钮的动作**：
 *   ① 走一格后档位被写回（setMode 收到 next 的结果）；
 *   ② 按钮文案 = label(新档)，.active = isActive(新档)，两者一处算；
 *   ③ 换完必回调 onChange（即重新过筛——漏调则按钮点了没反应）；
 *   ④ next 可以带额外上下文（格式档要看全集实际格式表），由 getExtra 按次取。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mod = () => import(`${pathToFileURL(path.join(REPO, 'src/renderer/js/filterCycle.js')).href}?t=${Math.random()}`);

/** 默认兜底 document：查不到按钮就返回 null（sync 会安全早退）。 */
globalThis.document = { getElementById: () => null };

function fakeBtn() { return { style: {}, textContent: '', classList: { _on: false, toggle(_k, v) { this._on = !!v; } } }; }

function mountBtn(id) {
  const btn = fakeBtn();
  globalThis.document = { getElementById: (q) => (q === id ? btn : null) };
  return btn;
}

const MODES = ['all', 'a', 'b'];
const nextOf = (m) => MODES[(MODES.indexOf(m) + 1) % MODES.length];
const labelOf = (m) => 'L:' + m;

test('cycle：走一格 → 写回档位 → 刷文案+高亮 → 回调，三件事都做', async () => {
  const { createCycleButton } = await mod();
  const btn = mountBtn('qBtn');
  let mode = 'all';
  let refiltered = 0;
  const c = createCycleButton({
    btnId: 'qBtn',
    getMode: () => mode,
    setMode: (m) => { mode = m; },
    next: nextOf, label: labelOf,
    onChange: () => { refiltered++; },
  });
  c.cycle();
  assert.equal(mode, 'a', '档位应被写回');
  assert.equal(btn.textContent, 'L:a', '按钮文案应随新档');
  assert.equal(btn.classList._on, true, '非 all 应高亮');
  assert.equal(refiltered, 1, '换完必须回调（重过筛）');
  c.cycle();
  assert.equal(mode, 'b');
  assert.equal(refiltered, 2);
});

test('默认高亮判据 = 非 all；显式 isActive 可覆盖', async () => {
  const { createCycleButton } = await mod();
  const btn = mountBtn('qBtn');
  let mode = 'all';
  const c = createCycleButton({
    btnId: 'qBtn', getMode: () => mode, setMode: (m) => { mode = m; },
    next: nextOf, label: labelOf, onChange: () => {},
  });
  c.init();                       // all 态：默认判据下不高亮
  assert.equal(btn.classList._on, false, 'all 态默认不高亮');
  c.cycle();                      // 走到 a
  assert.equal(btn.classList._on, true, '非 all 高亮');

  // 纯排序轴那种"只显文案不打卡"：isActive 恒 false
  const btn2 = mountBtn('sBtn');
  let m2 = 'x';
  const s = createCycleButton({
    btnId: 'sBtn', getMode: () => m2, setMode: (v) => { m2 = v; },
    next: () => 'y', label: () => 'SY', isActive: () => false, onChange: () => {},
  });
  s.cycle();
  assert.equal(btn2.textContent, 'SY');
  assert.equal(btn2.classList._on, false, '显式 isActive:()=>false 时永不高亮');
});

test('next 的额外上下文由 getExtra 按次取（不存成状态）', async () => {
  const { createCycleButton } = await mod();
  mountBtn('fBtn');
  let mode = 'all';
  let seen = null;
  let extraCalls = 0;
  const c = createCycleButton({
    btnId: 'fBtn', getMode: () => mode, setMode: (m) => { mode = m; },
    // 模拟 nextFmtMode(mode, formats)
    next: (m, formats) => { seen = formats; return 'x'; },
    label: labelOf,
    getExtra: () => { extraCalls++; return [['mp3', 'flac']]; },
    onChange: () => {},
  });
  c.cycle();
  assert.deepEqual(seen, ['mp3', 'flac'], 'next 应收到 getExtra 的返回值');
  assert.equal(extraCalls, 1, '每次 cycle 取一次额外上下文');
});

test('按钮不存在时 cycle 不炸（DOM 契约未就位也安全）', async () => {
  const { createCycleButton } = await mod();
  globalThis.document = { getElementById: () => null };
  let mode = 'all';
  let called = 0;
  const c = createCycleButton({
    btnId: 'missing', getMode: () => mode, setMode: (m) => { mode = m; },
    next: nextOf, label: labelOf, onChange: () => { called++; },
  });
  c.cycle();
  assert.equal(mode, 'a', '即便没有按钮，档位与回调照常推进');
  assert.equal(called, 1);
});
