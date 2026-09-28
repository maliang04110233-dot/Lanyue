/**
 * 睡眠「播完当前歌曲再停」——createEndStop 一次性闩 + 三处接线钉
 *
 * 闩的语义只有两条要守住：命中即自消（不然是"下次播放也莫名停掉"的坑），
 * 以及它必须排在连播/单曲循环之前被消费（否则单曲循环永远等不到停）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const ONEND_JS = read('src/renderer/js/sleepOnEnd.js');
const SLEEP_JS = read('src/renderer/js/sleepTimer.js');
const PLAYER_JS = read('src/renderer/js/player.js');
const PALETTE_JS = read('src/renderer/js/commandPalette.js');

// sleepOnEnd.js → logger.js 顶层碰 window.location（与 sleep-timer.test.js 同款垫片）
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/sleepOnEnd.js?eo=' + Math.random());
}

test('未武装时 consume 回 false 且不回调', async () => {
  const { createEndStop } = await fresh();
  let fired = 0;
  const s = createEndStop({ onFire: () => fired++ });
  assert.equal(s.active(), false);
  assert.equal(s.consume(), false);
  assert.equal(fired, 0);
});

test('arm 后 consume 收口一次：回调触发、闩自消、再 consume 回 false', async () => {
  const { createEndStop } = await fresh();
  let fired = 0;
  const s = createEndStop({ onFire: () => fired++ });
  s.arm();
  assert.equal(s.active(), true);
  assert.equal(s.consume(), true);
  assert.equal(fired, 1);
  assert.equal(s.active(), false, '命中即落闩（一次性，不是常驻开关）');
  assert.equal(s.consume(), false);
  assert.equal(fired, 1, '第二次结束不重复收口');
});

test('arm 后再 cancel 则本次结束照常连播', async () => {
  const { createEndStop } = await fresh();
  let fired = 0;
  const s = createEndStop({ onFire: () => fired++ });
  s.arm();
  s.cancel();
  assert.equal(s.active(), false);
  assert.equal(s.consume(), false);
  assert.equal(fired, 0);
});

test('onFire 抛异常不外溢，且不影响下一轮 arm', async () => {
  const { createEndStop } = await fresh();
  let n = 0;
  const s = createEndStop({ onFire: () => { n++; if (n === 1) throw new Error('boom'); } });
  s.arm();
  assert.equal(s.consume(), true, '异常也要算已收口，否则调用方还会切歌');
  assert.equal(s.active(), false);
  s.arm();
  assert.equal(s.consume(), true);
  assert.equal(n, 2);
});

test('重复 arm 只是同一个闩（幂等，不会攒两次收口）', async () => {
  const { createEndStop } = await fresh();
  let fired = 0;
  const s = createEndStop({ onFire: () => fired++ });
  s.arm();
  s.arm();
  assert.equal(s.consume(), true);
  assert.equal(s.consume(), false);
  assert.equal(fired, 1);
});

test('接线钉：player.js 在连播/单曲循环之前消费闩', () => {
  assert.match(
    PLAYER_JS,
    /if \(typeof window\.consumeSleepEndStop === 'function' && window\.consumeSleepEndStop\(\)\) \{/,
  );
  const consumeAt = PLAYER_JS.indexOf('window.consumeSleepEndStop()');
  const loopAt = PLAYER_JS.indexOf("if (loopMode === 2) {");
  const nextAt = PLAYER_JS.indexOf('updatePlayStatsOnStop();\n  nextSong();');
  assert.ok(consumeAt > 0 && loopAt > consumeAt, '必须先于单曲循环分支');
  assert.ok(nextAt > consumeAt, '必须先于 nextSong 连播');
  assert.match(PLAYER_JS, /consumeSleepEndStop\(\)\) \{\n {4}updatePlayStatsOnStop\(\);\n {4}audio\.pause\(\);\n {4}return;\n {2}\}/,
    '收口分支自己补统计再停，不走 nextSong');
});

test('接线钉：sleepTimer 出菜单项/消费口/徽标，面板出 misc-endstop', () => {
  assert.match(ONEND_JS, /export \{ createEndStop \};/);
  assert.match(SLEEP_JS, /import \{ createEndStop \} from '\.\/sleepOnEnd\.js';/);
  assert.match(SLEEP_JS, /function consumeSleepEndStop\(\) \{\n {2}return _es\(\)\.consume\(\);\n\}/);
  assert.match(SLEEP_JS, /window\.consumeSleepEndStop = consumeSleepEndStop;/);
  assert.match(SLEEP_JS, /window\.toggleEndStop = toggleEndStop;/);
  assert.match(SLEEP_JS, /icon: _es\(\)\.active\(\) \? '✓' : '⏹',\n {4}label: '播完当前歌曲再停',/,
    '菜单项在分隔线之前（111 的 ⌛ 钉靠它定位）');
  assert.match(SLEEP_JS, /if \(_endStop && _endStop\.active\(\)\) parts\.push\('播完停'\);/,
    '档位徽标与分钟倒计时共用同一处渲染');
  assert.ok(SLEEP_JS.indexOf("label: '播完当前歌曲再停'") < SLEEP_JS.indexOf("icon: '⌛'"));
  assert.match(PALETTE_JS, /id: 'misc-endstop'[\s\S]{0,220}_call\('toggleEndStop'\)/);
});
