/**
 * 睡眠定时「⌛ 自定义分钟」—— parseSleepMinutes 纯函数 + 弹层接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLEEP_JS = readFileSync(path.join(ROOT, 'src/renderer/js/sleepTimer.js'), 'utf8');

// sleepTimer.js 顶层有 window 桥（与 sleep-timer.test.js 同款垫片）
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/sleepTimer.js?tc=' + Math.random());
}

test('parseSleepMinutes：1..1440 整数收，其余（0/负/小数/文字/空/超界/null）全 null', async () => {
  const { parseSleepMinutes, MAX_SLEEP_MIN } = await fresh();
  assert.equal(MAX_SLEEP_MIN, 1440);
  assert.equal(parseSleepMinutes('1'), 1);
  assert.equal(parseSleepMinutes(' 120 '), 120);
  assert.equal(parseSleepMinutes('1440'), 1440);
  assert.equal(parseSleepMinutes('0'), null);
  assert.equal(parseSleepMinutes('-5'), null);
  assert.equal(parseSleepMinutes('20.5'), null);
  assert.equal(parseSleepMinutes('9999'), null);
  assert.equal(parseSleepMinutes('abc'), null);
  assert.equal(parseSleepMinutes(''), null);
  assert.equal(parseSleepMinutes(null), null);
  assert.equal(parseSleepMinutes(undefined), null);
});

test('接线钉：菜单出 ⌛ 自定义项、弹层骨架、Enter/确认提交先关层再 _arm', async () => {
  assert.match(SLEEP_JS, /items\.push\(\{ icon: '⌛', label: '自定义分钟…', onClick: \(\) => openSleepCustomDialog\(\) \}\);\n {2}items\.push\(\{ sep: true \}\);/, '自定义项在分隔线前');
  assert.match(SLEEP_JS, /overlay\.id = 'sleepCustomOverlay';\n {2}overlay\.className = 'edit-overlay';/);
  assert.match(SLEEP_JS, /input\.id = 'sleepCustomInput';\n {2}input\.type = 'number';/);
  assert.match(SLEEP_JS, /const m = parseSleepMinutes\(input\.value\);\n {4}if \(m === null\) \{ showToast\(/);
  assert.match(SLEEP_JS, /_closeCustomDialog\(\);\n {4}_arm\(m\);/, '先关弹层再武装');
  assert.match(SLEEP_JS, /input\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter'\) submit\(\); \}\);/);
  assert.match(SLEEP_JS, /window\.openSleepCustomDialog = openSleepCustomDialog;/);
});

test('注入面守：弹层全程 createElement/textContent，本文件不允许出现 innerHTML', async () => {
  assert.ok(!SLEEP_JS.includes('innerHTML'), '自定义弹层保持零 innerHTML');
});
