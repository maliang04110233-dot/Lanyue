/**
 * 守卫：3-B 跨源聚合视图的渲染层接线
 *
 * 后端两层已在 crossSourceAggregate.test.js / -wiring.test.js 钉过；
 * 本文件钉渲染层：
 *   1. 侧栏入口存在且形态合规（data-tab + switchTab onclick）；
 *   2. switchTab 认得 aggregate 页（否则点入口切不过去 / 页面不隐藏）；
 *   3. 视图已 import 且 window 导出齐全（inline onclick 靠 window 找函数）；
 *   4. 双语文案齐备且是**扁平点分键**（本仓语言包约定）；
 *   5. 占位符双语一致（{count}/{names} 这些不能一边有一边没有）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('src/renderer/index.html');
const APP = read('src/renderer/js/app.js');
const VIEW = read('src/renderer/js/views/aggregate.js');
const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
const en = JSON.parse(read('src/renderer/js/lang/en.json'));

/** 侧栏 data-tab 序列 */
function sidebarTabs() {
  const sb = HTML.slice(HTML.indexOf('<div class="sidebar">'), HTML.indexOf('<div class="content">'));
  return [...sb.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
}

// ── 1. 侧栏入口 ───────────────────────────────────────

test('侧栏：aggregate 入口存在', () => {
  assert.ok(sidebarTabs().includes('aggregate'), '侧栏应有 aggregate 入口');
});

test('侧栏：入口带 switchTab onclick（否则 ⌘K 反查与高亮都会漂）', () => {
  assert.match(HTML, /onclick="switchTab\('aggregate',this\)"/, '入口缺 switchTab onclick');
});

test('侧栏：入口带 i18n 键（标题不许硬编码）', () => {
  assert.match(HTML, /data-i18n="nav\.aggregate"/, '入口标题应走 data-i18n');
});

// ── 2. switchTab 接线 ─────────────────────────────────

test('switchTab：认得 aggregatePage（取出、隐藏、显示三处齐全）', () => {
  assert.match(APP, /getElementById\('aggregatePage'\)/, '未取 aggregatePage');
  assert.match(APP, /aggregatePage\.style\.display\s*=\s*'none'/, '切页时未隐藏聚合页');
  assert.match(APP, /aggregatePage\.style\.display\s*=\s*'flex'/, '未显示聚合页');
});

test('switchTab：首次进入才拉数据（反复切页不该反复打 IPC）', () => {
  assert.match(APP, /_aggLoaded/, '应有「已加载」标志');
  assert.match(APP, /if\s*\(!_aggLoaded\)/, '加载应受标志保护');
});

// ── 3. 视图模块 ───────────────────────────────────────

test('视图：已被 app.js import', () => {
  assert.match(APP, /import '\.\/views\/aggregate\.js';/, 'app.js 未 import 聚合视图');
});

test('视图：inline handler 用到的函数都有 window 导出', () => {
  const used = new Set();
  // HTML 里的 inline 调用
  for (const m of HTML.matchAll(/on(?:click|change|input)="(loadAggregated|renderAggregated|onAggFilter|onAggKeyword)\(/g)) {
    used.add(m[1]);
  }
  for (const fn of used) {
    assert.match(VIEW, new RegExp(`window\\.${fn} = ${fn};`),
      `${fn} 被 inline handler 调用但没导出到 window ⇒ 点击即 ReferenceError`);
  }
});

test('视图：getAggregatedState 已导出（诊断/测试要读快照）', () => {
  assert.match(VIEW, /window\.getAggregatedState = getAggregatedState;/);
});

// ── 4. 文案 ───────────────────────────────────────────

test('文案：聚合相关键双语齐备且非空', () => {
  const keys = Object.keys(zh).filter((k) => k === 'nav.aggregate' || k.startsWith('aggregate.'));
  assert.ok(keys.length >= 12, `聚合文案键太少: ${keys.length}`);
  for (const k of keys) {
    assert.equal(typeof zh[k], 'string', `zh 缺 ${k}`);
    assert.equal(typeof en[k], 'string', `en 缺 ${k}`);
    assert.ok(zh[k].trim().length, `zh 的 ${k} 是空串`);
  }
});

test('文案：占位符双语一致（{count}/{names} 不能一边有一边没有）', () => {
  const ph = (s) => (String(s).match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []).sort();
  for (const k of Object.keys(zh)) {
    if (!(k === 'nav.aggregate' || k.startsWith('aggregate.'))) continue;
    assert.deepEqual(ph(zh[k]), ph(en[k]), `${k} 占位符不一致`);
  }
});

test('文案：en 不含中文', () => {
  const CJK = /[\u4e00-\u9fff]/;
  for (const k of Object.keys(en)) {
    if (!(k === 'nav.aggregate' || k.startsWith('aggregate.'))) continue;
    assert.ok(!CJK.test(en[k]), `en 的 ${k} 含中文: ${en[k]}`);
  }
});

test('文案：视图与 HTML 引用的键都真实存在', () => {
  const used = new Set();
  for (const m of VIEW.matchAll(/t\('(aggregate\.[a-zA-Z]+|nav\.aggregate)'\)/g)) used.add(m[1]);
  for (const m of HTML.matchAll(/data-i18n="(aggregate\.[a-zA-Z.]+|nav\.aggregate)"/g)) used.add(m[1]);
  assert.ok(used.size >= 5, `应引用多处文案键，实得 ${used.size}`);
  for (const k of used) {
    assert.equal(typeof zh[k], 'string', `引用了 ${k} 但语言包里没有`);
  }
});

// ── 5. 降级与只读纪律在视图层也成立 ───────────────────

test('视图：聚合失败要降级为空态（不得让异常冒到 UI 之外）', () => {
  assert.match(VIEW, /catch\s*\(/, 'loadAggregated 缺 catch');
  assert.match(VIEW, /aggregate\.empty/, '应有空态文案');
});

test('视图：不得直接写 prefs 或本地曲库（聚合是只读视图）', () => {
  assert.ok(!/api\.setPref\(/.test(VIEW), '聚合视图不该写 prefs');
  assert.ok(!/toggleFavorite|saveUserPlaylist/.test(VIEW), '聚合视图不该改红心/歌单');
});
