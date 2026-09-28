/**
 * EQ 输出级 trim + 命令面板 EQ 条目
 *
 * trim：正增益抬升会让整首歌跟着变响 —— 纯函数 preampTrimDb 由有效增益现推
 * 固定 trim dB（= -最大单段正增益，非正曲线为 0），镜像到**链首**的 preamp
 * GainNode。曲线变 → trim 变，不写第四把 pref（零新 IPC）。
 * 名字不是 clipGuardDb：它看的是一条静态增益曲线，不是真实峰值，挡不住相位
 * 叠加出来的过载 —— 「削波保护」是它兑现不了的承诺，详见 eq.js 同名注释。
 *
 * 链序：source → preamp → 5×BiquadFilter → analyser → destination。
 * preamp 必须在滤波链**首**：串在 filters 之后虽然同样等效于输出衰减，却让
 * analyser（频谱可视化的唯一抽头）读到被自己抵消后的信号 —— bass 预设的 +6dB
 * 低架配上 −6dB trim，图上低频比 flat 还低，EQ 效果在图里被自己抹掉。
 * 挪到链首后 analyser 落在滤波链尾，量到的是 EQ 本身。
 *
 * 命令面板：fade/visualizer 有入口，EQ 没有 —— 补 eq-cycle / eq-bypass /
 * eq-reset 三条，复用既有 window 桥（cycleEqPreset 新挂）。
 *
 * 手法沿用 eq-behaviour：纯函数 node 直测 + 源码钉（无 jsdom）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const freshEq = () => import(`../src/renderer/js/player/eq.js?tc=${Math.random()}`);
const EQ_SRC = read('src/renderer/js/player/eq.js');
const EQ_CODE = stripComments(EQ_SRC);
const PALETTE = read('src/renderer/js/commandPalette.js');
const PLAYER = stripComments(read('src/renderer/js/player.js'));

// ── 纯函数：preampTrimDb ─────────────────────────────

test('preampTrimDb：平坦/全负 → 0（不额外衰减），正增益 → 反数 trim', async () => {
  const { preampTrimDb } = await freshEq();
  assert.equal(typeof preampTrimDb, 'function', 'eq.js 应导出 preampTrimDb');
  assert.equal(preampTrimDb([0, 0, 0, 0, 0]), 0);
  assert.equal(preampTrimDb([-4, -2, 0, 0, 0]), 0, '只有负增益不需要 trim');
  assert.equal(preampTrimDb([6, 3, -1, -1, 0]), -6, 'trim = -最大单段正增益');
  assert.equal(preampTrimDb([2, 3, 1, 2, 3]), -3);
  assert.equal(preampTrimDb([12, 0, 0, 0, 0]), -12);
});

test('preampTrimDb：脏输入安全（null/非数组/非数元素不抛错）', async () => {
  const { preampTrimDb } = await freshEq();
  assert.equal(preampTrimDb(null), 0);
  assert.equal(preampTrimDb(undefined), 0);
  assert.equal(preampTrimDb('flat'), 0);
  assert.equal(preampTrimDb([]), 0, '空数组不是「全正增益」，trim 0');
  assert.equal(preampTrimDb([NaN, 'x', 4, null, 5]), -5, '坏元素跳过，好的仍参与');
});

// 反向钉：名字不许回退。clipGuardDb 承诺「削波保护」而它做的是听感取向的固定 trim，
// 那个名字一旦复活就等于把「它挡不住相位叠加的过载」这件事重新藏起来。
test('eq.js: 老名字 clipGuardDb 不得复活（名字承诺的比它能做的多）', () => {
  assert.doesNotMatch(EQ_SRC, /\bclipGuardDb\b\s*[(:=]/, 'clipGuardDb 又被用起来了 —— 先解释它凭什么还叫削波保护');
  assert.doesNotMatch(EQ_SRC, /防削波/, '「防削波」的说法同罪：它防不住任何真实过载');
});

// ── 图接线：链首 preamp GainNode ───────────────────────

test('eq.js: 图内有 createGain preamp 节点，且由 preampTrimDb(_effective) 驱动', () => {
  assert.match(EQ_CODE, /createGain\s*\(/, '缺 preamp GainNode');
  assert.match(EQ_CODE, /preampTrimDb\s*\(/, 'preamp 增益必须走纯函数，不许就地心算第二份');
  assert.match(EQ_CODE, /_effective\s*\(\)/, 'trim 应基于有效增益（bypass 时增益全 0 → trim 0）');
  // sole-owner 钉已允许 createGain 只出现在 eq.js
  assert.ok(
    !/createGain\s*\(/.test(stripComments(read('src/renderer/js/player/visualizer.js'))),
    'visualizer 仍不得自造节点'
  );
});

test('eq.js: preamp 串在滤波链首、analyser 落在链尾（source → preamp → filters → analyser → destination）', () => {
  // ensureEqGraph 内的三段顺序钉（靠下标先后，不靠注释）：
  // ① 建 preamp 并接在 source 之后   ② 五段 biquad 接在 preamp 之后
  // ③ analyser 接在最后一个 biquad 之后并直通 destination
  const at = EQ_CODE.indexOf('function ensureEqGraph');
  assert.ok(at > -1, '未找到 ensureEqGraph');
  const body = EQ_CODE.slice(at, EQ_CODE.indexOf('\n}', at));
  const preamp = body.indexOf('node.connect(preampNode)');
  const loop = body.indexOf('for (const band of EQ_BANDS)');
  const analyser = body.indexOf('node.connect(analyserNode)');
  const toDest = body.indexOf('analyserNode.connect(audioCtx.destination)');
  assert.ok(preamp > -1, 'preamp 未串入图');
  assert.ok(loop > -1, '五段 biquad 循环不见了');
  assert.ok(analyser > -1, 'analyser 未接在当前 node 尾');
  assert.ok(toDest > -1, 'destination 桥不得断');
  assert.ok(preamp < loop, 'preamp 必须排在滤波链**首**（排到 filters 之后会让频谱读到被 trim 抵消的信号）');
  assert.ok(loop < analyser, 'analyser 必须排在五段滤波之后 —— 它是频谱抽头，不是链首');
  assert.ok(analyser < toDest, 'destination 必须接在 analyser 之后（断桥即哑音）');
  // 反向钉：preamp 一旦被挪到 analyser 之后（= 回到 filters 尾），上面的下标序会立刻破
  assert.ok(
    !/analyserNode\.connect\(\s*preampNode\s*\)/.test(EQ_CODE),
    'preamp 接到了 analyser 之后 = 频谱又变回「含 trim 的真输出」，与链首决定相悖'
  );
});

// ── cycleEqPreset（命令面板入口）─────────────────────

test('cycleEqPreset：按预设表循环，自定义/未知从 flat 起，走 applyEqPreset', async () => {
  const eq = await freshEq();
  assert.equal(typeof eq.cycleEqPreset, 'function', '缺 cycleEqPreset 导出');
  const src = EQ_CODE;
  const at = src.indexOf('function cycleEqPreset');
  assert.ok(at > -1, '未找到 cycleEqPreset');
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  assert.match(body, /applyEqPreset\s*\(/, '循环必须委派 applyEqPreset（三键/高亮/bypass 的唯一家）');
  assert.ok(!/setPref\s*\(/.test(body), 'cycle 不该绕开 saveEqSettings 直写 pref');
});

test('cycleEqPreset 行为：flat→pop→rock…，手调自定义后下一档回到表首', async () => {
  // 桩 DOM + api（同 eq-reset 手法：无 Web Audio 也能跑状态机）
  const prefs = {};
  const mk = (o = {}) => Object.assign({
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) {
        if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        else if (on) this._s.add(c); else this._s.delete(c);
      },
      contains(c) { return this._s.has(c); },
    },
    style: {},
    dataset: {},
    value: '0',
    textContent: '',
  }, o);
  const sliders = [0, 1, 2, 3, 4].map(() => mk());
  const labels = [0, 1, 2, 3, 4].map(() => mk());
  const bypassBtn = mk();
  const hint = mk();
  const presetBtns = ['flat', 'pop', 'rock', 'classic', 'vocal', 'dance', 'jazz', 'bass']
    .map((n) => { const b = mk(); b.dataset.eqPreset = n; return b; });

  global.window = global.window || {};
  global.window.addEventListener = global.window.addEventListener || (() => {});
  global.document = {
    getElementById(id) {
      if (id === 'eqBypassBtn') return bypassBtn;
      if (id === 'eqCustomHint') return hint;
      if (/^eq_\d+$/.test(id)) return sliders[+id.slice(3)] || null;
      if (/^eq_val_\d+$/.test(id)) return labels[+id.slice(7)] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.eq-preset-btn') return presetBtns;
      if (sel === '#eqPanel input[type=range]') return sliders;
      if (sel === '#eqPanel [id^=eq_val_]') return labels;
      return [];
    },
    addEventListener() {},
    readyState: 'complete',
  };
  global.api = {
    getPref: async (k) => prefs[k],
    setPref: async (k, v) => { prefs[k] = JSON.parse(JSON.stringify(v)); return true; },
  };

  const eq = await freshEq();
  eq.applyEqPreset('flat');
  eq.cycleEqPreset();
  assert.equal(prefs.eqPreset, 'pop', 'flat 之后应是 pop');

  eq.cycleEqPreset();
  assert.equal(prefs.eqPreset, 'rock');

  // 手调成自定义 → 下一档从表首（flat）起，不卡死
  // 手调本身**不许**落盘：eqPreset 仍是上一档 rock、eqGains 仍是 rock 的曲线。
  // 之前这里写的是 `prefs.eqPreset === undefined ? null : null` —— 三目两个分支
  // 都是 null，恒等于 null，于是「setEqBand 不写 pref」这句话一个字节都没验到。
  // 恒真断言比缺断言更坏：它给「这条不变量有人守着」的假绿。
  eq.setEqBand(0, 7);
  assert.strictEqual(prefs.eqPreset, 'rock', 'setEqBand 不写 pref —— 曲线名应仍是上一档 rock');
  assert.deepStrictEqual(prefs.eqGains, [4, 2, -1, 1, 3], 'setEqBand 不写 pref —— eqGains 也不该被手调值污染');
  eq.cycleEqPreset();
  // 认不出曲线时 matchPresetName 返回 null，idx=-1 → order[0]。
  // 原断言只验「落在 8 个预设之内」—— 换成任意一张映射表都能过，验不到「表首」二字。
  assert.strictEqual(prefs.eqPreset, 'flat', '自定义后下一档必须回到表首 flat（不是表内任意一条）');
  assert.deepStrictEqual(prefs.eqGains, [0, 0, 0, 0, 0], '落到表首 = 真的换成了 flat 曲线');
});

// ── player.js 桥 + 命令面板 ──────────────────────────

test('player.js: cycleEqPreset 进 import / re-export / window（palette _call 依赖）', () => {
  const m = PLAYER.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player\/eq\.js'/);
  assert.ok(m, '缺 eq.js import');
  assert.ok(m[1].includes('cycleEqPreset'), 'import 未含 cycleEqPreset');
  assert.match(PLAYER, /export\s*\{[^}]*cycleEqPreset[^}]*\}/, 're-export 缺 cycleEqPreset');
  assert.match(PLAYER, /window\.cycleEqPreset\s*=/, 'window 桥缺 cycleEqPreset');
});

test('命令面板: eq-cycle / eq-bypass / eq-reset 三条齐备且指向既有桥', () => {
  assert.match(PALETTE, /\{ id: 'eq-cycle'[\s\S]{0,240}?_call\('cycleEqPreset'\)/, '缺 eq-cycle');
  assert.match(PALETTE, /\{ id: 'eq-bypass'[\s\S]{0,240}?_call\('toggleEqBypass'\)/, '缺 eq-bypass');
  assert.match(PALETTE, /\{ id: 'eq-reset'[\s\S]{0,240}?_call\('resetEq'\)/, '缺 eq-reset');
  // 三条都该在「播放」组，关键词带 eq/均衡器 可搜
  for (const id of ['eq-cycle', 'eq-bypass', 'eq-reset']) {
    const line = PALETTE.split('\n').find((l) => l.includes(`id: '${id}'`));
    assert.ok(line, `找不到 ${id} 行`);
    assert.ok(line.includes("group: '播放'"), `${id} 应在播放组`);
    assert.ok(/eq|均衡/i.test(line), `${id} 关键词应含 eq/均衡`);
  }
});

// ── 导出面 ───────────────────────────────────────────

test('eq.js: 导出面含 preampTrimDb 与 cycleEqPreset（两个 ESM-only 纯函数）', () => {
  assert.match(EQ_CODE, /export\s+(?:async\s+)?function\s+preampTrimDb\b/, '缺 preampTrimDb 导出');
  assert.match(EQ_CODE, /export\s+(?:async\s+)?function\s+cycleEqPreset\b/, '缺 cycleEqPreset 导出');
});

test('零新 IPC：eq.js 契约外 api 方法/通道仍为空', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  const used = [...EQ_SRC.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]).filter((k) => k !== 'invoke');
  assert.deepEqual(used.filter((k) => !(k in METHODS)), []);
  const invoked = [...EQ_SRC.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(invoked.filter((c) => !(c in CHANNELS)), []);
});
