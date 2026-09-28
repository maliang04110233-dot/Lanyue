/**
 * per-source-setting.test.js — 「单平台并发上限设置入口」守卫
 *
 * 手法沿用 eq-behaviour.test.js：无 jsdom，故静态扫描源码文本断言结构。
 *
 * 钉住四件事：
 *  1. settings.js 的 GENERAL_PREFS 表有 perSourceConcurrency 行
 *     （loadGeneralSettings / setupGeneralSettingListeners / resetAllSettings
 *      三套机制都靠这张表自动接入——缺行 = 设置项成死 UI）；
 *  2. index.html 有对应 id 的 number 输入框，min/max 与引擎接受域一致；
 *  3. zh/en 两词典对称含 label+hint 两个 key（platform-contract 有同款
 *     全量校验，这里只对本增量做定向锚点）；
 *  4. 等值钉：UI 默认值 == 引擎 getPerSourceCap 的 fallback（2），
 *     UI max == 引擎上界（10）。漂移 = 用户看到的默认值≠实际生效值。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

const SETTINGS_SRC = read('src/renderer/js/views/settings.js');
const HTML_SRC = read('src/renderer/index.html');
const ZH = JSON.parse(read('src/renderer/js/lang/zh.json'));
const EN = JSON.parse(read('src/renderer/js/lang/en.json'));
const QUEUE_SRC = read('src/main/downloadQueue.js');

test('settings.js: GENERAL_PREFS 含 perSourceConcurrency 表行（default 2 + el 指向 HTML id）', () => {
  assert.match(
    SETTINGS_SRC,
    /perSourceConcurrency:\s*\{[^}]*key:\s*'perSourceConcurrency'[^}]*default:\s*2[^}]*el:\s*'settingPerSourceConcurrency'/,
    'GENERAL_PREFS 缺行/变形 → loadGeneralSettings 不回显、监听不接线、resetAllSettings 不重置该项'
  );
});

test('index.html: settingPerSourceConcurrency 为 number 输入，min=1 max=10 与引擎域一致', () => {
  const m = HTML_SRC.match(/<input[^>]*id="settingPerSourceConcurrency"[^>]*>/);
  assert.ok(m, 'index.html 缺少 id="settingPerSourceConcurrency" 的输入框');
  const tag = m[0];
  assert.match(tag, /type="number"/, '并发上限应为 number 输入');
  assert.match(tag, /min="1"/, 'min 应为 1（引擎 (v>=1) 才接受）');
  assert.match(tag, /max="10"/, 'max 应为 10（引擎 v<=10 才接受，超界回退 2）');
});

test('index.html: label 与 hint 都挂 data-i18n key', () => {
  assert.ok(HTML_SRC.includes('data-i18n="settings.general.perSourceConcurrency"'), 'label 缺 i18n key');
  assert.ok(HTML_SRC.includes('data-i18n="settings.general.perSourceConcurrencyHint"'), 'hint 缺 i18n key');
});

test('zh/en 词典对称含本增量两个 key，且均非空', () => {
  for (const key of ['settings.general.perSourceConcurrency', 'settings.general.perSourceConcurrencyHint']) {
    assert.ok(typeof ZH[key] === 'string' && ZH[key].length > 0, `zh.json 缺 ${key}`);
    assert.ok(typeof EN[key] === 'string' && EN[key].length > 0, `en.json 缺 ${key}`);
  }
});

test('等值钉：UI 默认值/上界 == downloadQueue.js getPerSourceCap 的 fallback/上界', () => {
  const capFn = QUEUE_SRC.slice(QUEUE_SRC.indexOf('function getPerSourceCap'));
  assert.ok(capFn.length > 0 && capFn.indexOf('function getPerSourceCap') >= 0, '引擎 getPerSourceCap 消失');
  const range = capFn.match(/v\s*>=\s*(\d+)\s*&&\s*v\s*<=\s*(\d+)\s*\)\s*\?\s*v\s*:\s*(\d+)/);
  assert.ok(range, 'getPerSourceCap 的 (v>=min && v<=max) ? v : fallback 形态变了，本测试需同步');
  const [, min, max, fallback] = range.map(Number);
  assert.equal(min, 1, '引擎下界不再是 1：HTML min 需同步');
  assert.equal(max, 10, '引擎上界不再是 10：HTML max 需同步');
  assert.equal(fallback, 2, '引擎 fallback 不再是 2：GENERAL_PREFS default 需同步');
  const uiDefault = Number(SETTINGS_SRC.match(/perSourceConcurrency:\s*\{[^}]*default:\s*(\d+)/)[1]);
  assert.equal(uiDefault, fallback, 'UI 默认值与引擎 fallback 漂移（用户看到的≠实际生效的）');
  const uiMax = Number(HTML_SRC.match(/id="settingPerSourceConcurrency"[^>]*max="(\d+)"/)[1]);
  assert.equal(uiMax, max, 'UI max 与引擎上界漂移');
});
