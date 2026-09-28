/**
 * retry-attempts-setting.test.js — 「单曲失败尝试次数设置」守卫
 *
 * 混合手法（同 per-source-setting 的静态部分 + downloadQueue.test.js 的
 * prefs-patch 运行时部分）：
 *  1. 运行时真调用 engine.getMaxAttempts()——prefs.get 按外部同款 patch，
 *     断言域内取值/字符串数字/越界/脏值/缺省全部按规则回落；
 *  2. 静态钉：循环界与重试条件必须用逐曲快照 maxAttempts（不再是常量），
 *     保证"下载中途改设置不回溯在途任务"的实现形态不被悄悄改回去；
 *  3. 等值钉：UI default/min/max 与引擎 MAX_RETRY 及 (1..5) 域对齐，
 *     GENERAL_PREFS 表行、HTML 输入框、zh/en 双键齐备。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

// ── 1. 运行时：engine.getMaxAttempts() 真调用 ────────────────
function engineWithPrefs(store) {
  const prefs = require('../src/utils/prefs');
  const orig = prefs.get;
  prefs.get = (k) => store[k];
  try {
    const { createDownloadQueueEngine } = require('../src/main/downloadQueue.js');
    return createDownloadQueueEngine({
      userDataDir: () => os.tmpdir(),
      safeSend: () => {},
      getDownloadUrlSmart: async () => { throw new Error('not used'); },
      getLyrics: async () => null,
      downloader: { downloadFileWithRetry: async () => {}, embedId3Tags: async () => {} },
    });
  } finally {
    prefs.get = orig;
  }
}

test('getMaxAttempts：域内整数直接生效，字符串数字被 Number 收编', () => {
  const e = engineWithPrefs({});
  assert.equal(e.getMaxAttempts(), 2, '缺省应回落 MAX_RETRY=2');
  const prefs = require('../src/utils/prefs');
  const orig = prefs.get;
  try {
    prefs.get = (k) => (k === 'maxAttempts' ? 5 : undefined);
    assert.equal(e.getMaxAttempts(), 5, '上界 5 应生效');
    prefs.get = (k) => (k === 'maxAttempts' ? '3' : undefined);
    assert.equal(e.getMaxAttempts(), 3, "UI 存的字符串 '3' 应生效（Number 收编）");
  } finally {
    prefs.get = orig;
  }
});

test('getMaxAttempts：0/6/2.5/abc 等脏值一律回落 2（循环体最少跑一次的保护域）', () => {
  const e = engineWithPrefs({});
  const prefs = require('../src/utils/prefs');
  const orig = prefs.get;
  for (const bad of [0, 6, -1, 2.5, 'abc', NaN, null]) {
    try {
      prefs.get = (k) => (k === 'maxAttempts' ? bad : undefined);
      assert.equal(e.getMaxAttempts(), 2, `脏值 ${String(bad)} 必须回落 2`);
    } finally {
      prefs.get = orig;
    }
  }
});

// ── 2. 静态：重试循环用逐曲快照，不再直引常量 ────────────────
test('downloadQueue.js：循环界/重试条件/日志都走 maxAttempts 快照（MAX_RETRY 仅作回落值）', () => {
  const src = read('src/main/downloadQueue.js');
  assert.match(src, /const maxAttempts = getMaxAttempts\(\);/, '缺少逐曲快照');
  assert.match(src, /attempt <= maxAttempts/, '循环界应使用快照而非常量');
  assert.match(src, /attempt < maxAttempts && isRetriable/, '重试条件应使用快照');
  assert.doesNotMatch(src, /attempt <= MAX_RETRY/, '循环界回退成直引常量——设置将不生效');
  assert.match(src, /getMaxAttempts,\r?\n/, 'getMaxAttempts 应从引擎 API 导出（本测试运行时依赖）');
});

// ── 3. 等值钉：UI 与引擎域对齐 ───────────────────────────────
test('settings.js + index.html + zh/en：maxAttempts 设置四件套齐备且域一致', () => {
  const settings = read('src/renderer/js/views/settings.js');
  assert.match(
    settings,
    /maxAttempts:\s*\{[^}]*key:\s*'maxAttempts'[^}]*default:\s*2[^}]*el:\s*'settingMaxAttempts'/,
    'GENERAL_PREFS 缺行/变形 → 回显、监听、resetAllSettings 三套机制都不接这项'
  );
  const html = read('src/renderer/index.html');
  const tag = html.match(/<input[^>]*id="settingMaxAttempts"[^>]*>/);
  assert.ok(tag, 'index.html 缺 settingMaxAttempts 输入框');
  assert.match(tag[0], /type="number"/);
  assert.match(tag[0], /min="1"/);
  assert.match(tag[0], /max="5"/);
  assert.ok(html.includes('data-i18n="settings.general.maxAttempts"'), 'label 缺 i18n key');
  assert.ok(html.includes('data-i18n="settings.general.maxAttemptsHint"'), 'hint 缺 i18n key');
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  for (const key of ['settings.general.maxAttempts', 'settings.general.maxAttemptsHint']) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh 缺 ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en 缺 ${key}`);
  }
});

test('等值钉：UI default/min/max == 引擎 MAX_RETRY/域界（防"看到的≠生效的"漂移）', () => {
  const src = read('src/main/downloadQueue.js');
  const def = Number(src.match(/const MAX_RETRY = (\d+)/)[1]);
  const range = src.match(/n >= (\d+) && n <= (\d+) \? n : MAX_RETRY/);
  assert.ok(range, 'getMaxAttempts 的整数域校验形态变了，本测试需同步');
  const settings = read('src/renderer/js/views/settings.js');
  const html = read('src/renderer/index.html');
  assert.equal(Number(settings.match(/maxAttempts:\s*\{[^}]*default:\s*(\d+)/)[1]), def, 'UI 默认值与引擎回落漂移');
  assert.equal(Number(html.match(/id="settingMaxAttempts"[^>]*min="(\d+)"/)[1]), Number(range[1]), 'UI min 与引擎下界漂移');
  assert.equal(Number(html.match(/id="settingMaxAttempts"[^>]*max="(\d+)"/)[1]), Number(range[2]), 'UI max 与引擎上界漂移');
});
