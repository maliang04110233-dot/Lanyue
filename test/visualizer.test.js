/**
 * visualizer.test.js — 频谱可视化守卫
 *
 * computeBars 运行时真测（模块顶层零 DOM，node 可直接 import；
 * 其 eq.js 依赖也是 node-safe 的）+ 接线/所有权静态钉。
 * 所有权约束：一个 <audio> 只能 createMediaElementSource 一次，
 * 全仓音频节点创建必须唯一收口在 player/eq.js —— visualizer.js
 * 出现任何 create* 节点即红（含 createAnalyser）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

async function fresh() {
  return import(`../src/renderer/js/player/visualizer.js?ck=${Math.random()}`);
}

test('computeBars：满格 255 → 1.0、全 0 → 0，长度=bars', async () => {
  const { computeBars } = await fresh();
  const full = new Uint8Array(128).fill(255);
  const zero = new Uint8Array(128).fill(0);
  const a = computeBars(full, 16);
  const b = computeBars(zero, 16);
  assert.equal(a.length, 16);
  assert.ok(a.every((v) => v === 1), `全 255 应得满格，实得 ${a.join(',')}`);
  assert.ok(b.every((v) => v === 0));
});

test('computeBars：按组均值映射，前强后弱分布正确且 0..1 封顶', async () => {
  const { computeBars } = await fresh();
  const freq = new Uint8Array(128);
  freq.fill(255, 0, 64);
  const bars = computeBars(freq, 4);
  assert.deepEqual(bars.map((v) => (v > 0.9 ? 1 : v)), [1, 1, 0, 0]);
  const mid = new Uint8Array(128).fill(64); // 64/255 → sqrt ≈ 0.5（clamp 内）
  const m = computeBars(mid, 2);
  assert.ok(m[0] > 0.4 && m[0] < 0.6, `均值 64 应约 0.5，实得 ${m[0]}`);
});

test('computeBars：脏输入容错（null 数据 / 0 或负 bars → 空或全 0）', async () => {
  const { computeBars } = await fresh();
  assert.deepEqual(computeBars(null, 8), new Array(8).fill(0));
  assert.deepEqual(computeBars(new Uint8Array(128), 0), []);
  assert.deepEqual(computeBars(new Uint8Array(128), -3), []);
});

test('所有权钉：visualizer.js 不创建任何音频节点（图唯一主是 eq.js）', async () => {
  const src = read('src/renderer/js/player/visualizer.js');
  assert.doesNotMatch(
    src,
    /\.(createAnalyser|createBiquadFilter|createMediaElementSource|createGain|AudioContext)\s*\(?/,
    'visualizer 自造音频节点会与 eq.js 的图双主冲突（element 只能挂一次源）'
  );
});

test('eq.js：analyser 已串入图尾（filters→analyser→destination）并导出访问器', () => {
  const src = read('src/renderer/js/player/eq.js');
  assert.match(src, /createAnalyser\s*\(\s*\)/, '图中缺 AnalyserNode');
  assert.match(src, /node\.connect\(analyserNode\)/, 'analyser 未接在滤波链尾');
  assert.match(src, /analyserNode\.connect\(audioCtx\.destination\)/, 'analyser 未桥到 destination（会哑音）');
  assert.match(src, /export function ensureAudioGraph/, 'ensureAudioGraph 未导出');
  assert.match(src, /export function getAnalyser/, 'getAnalyser 未导出');
});

test('接线钉：app.js 副作用 import、index.html canvas+按钮、命令面板入口齐备', () => {
  assert.match(read('src/renderer/js/app.js'), /import '\.\/player\/visualizer\.js';/, 'app.js 未引入 visualizer（onclick 会 ReferenceError）');
  const html = read('src/renderer/index.html');
  assert.match(html, /<canvas id="vizCanvas" class="viz-canvas"/, '缺频谱 canvas');
  assert.match(html, /id="btnVisualizer"[^>]*onclick="toggleVisualizer\(\)"/, '缺 📊 开关按钮');
  assert.match(html, /id="btnVisualizer"[^>]*aria-pressed="false"/, '按钮缺 aria-pressed 初值');
  assert.match(read('src/renderer/js/commandPalette.js'), /id: 'viz-toggle'/, '命令面板缺 viz-toggle');
  assert.match(read('src/renderer/styles/player.css'), /\.viz-canvas\s*\{/, 'player.css 缺 .viz-canvas 规则');
});
