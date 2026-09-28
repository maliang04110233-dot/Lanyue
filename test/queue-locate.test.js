/**
 * 播放队列面板 🎯 定位正在播放（resolvePlayingIndex 防漂移 + app.js/面板/命令面板接线）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/app.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function loadMod() {
  return import(`../src/renderer/js/locatePlaying.js?ck=${Math.random()}`);
}

test('声明索引可信（同引用）时直接命中，不做全量匹配', async () => {
  const { resolvePlayingIndex } = await loadMod();
  const a = { id: 1, source: 'net' };
  const b = { id: 2, source: 'net' };
  assert.strictEqual(resolvePlayingIndex([a, b], b, 1), 1);
});

test('playIdx 漂移：声明位不是同引用时退回 source|id 全量匹配', async () => {
  const { resolvePlayingIndex } = await loadMod();
  const list = [
    { id: '7', source: 'net', title: 'X' },
    { id: 7, source: 'net', title: 'X' }, // 浅拷贝：与 cur 引用不同但身份相同
  ];
  assert.strictEqual(resolvePlayingIndex(list, list[1], 0), 1);
});

test('非法 declaredIdx（负数/越界/非数字）不崩溃，一律回退匹配', async () => {
  const { resolvePlayingIndex } = await loadMod();
  const cur = { id: 3, source: 'qq' };
  const list = [{ id: 9 }, cur];
  assert.strictEqual(resolvePlayingIndex(list, cur, -1), 1);
  assert.strictEqual(resolvePlayingIndex(list, cur, 99), 1);
  assert.strictEqual(resolvePlayingIndex(list, cur, undefined), 1);
});

test('脏输入 -1：cur 为 null / 列表非数组（未播放或空队列）', async () => {
  const { resolvePlayingIndex } = await loadMod();
  assert.strictEqual(resolvePlayingIndex([{ id: 1 }], null, 0), -1);
  assert.strictEqual(resolvePlayingIndex(undefined, { id: 1 }, 0), -1);
});

test('接线齐备：app.js 导入+自动展开+data-pqidx 闪烁+bridge；面板按钮；命令面板 pq-locate', () => {
  const MOD = fs.readFileSync(
    path.join(__dirname, '../src/renderer/js/locatePlaying.js'), 'utf8'
  );
  assert.match(MOD, /export function resolvePlayingIndex\(list, cur, declaredIdx\)/);
  assert.match(APP_JS, /import \{ resolvePlayingIndex, flashRow \} from '\.\/locatePlaying\.js';/);
  assert.match(APP_JS, /function locatePlayingInQueue\(\)/);
  assert.match(APP_JS, /if \(!_pqVisible\) window\.togglePlayQueue\(\);/);
  assert.match(APP_JS, /#pqList \.pq-item\[data-pqidx="\$\{idx\}"\]/);
  assert.match(APP_JS, /window\.locatePlayingInQueue = locatePlayingInQueue;/);
  assert.match(HTML, /onclick="locatePlayingInQueue\(\)"[^>]*>🎯 定位<\/button>/);
  assert.match(PALETTE, /id: 'pq-locate'[\s\S]*?_call\('locatePlayingInQueue'\)/);
});
