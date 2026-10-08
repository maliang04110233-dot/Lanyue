/**
 * 本地曲库「生效筛选外显」行为测试（chip 行 + 单清 + 一键清空）
 *
 * 这轮改的是"看得见"：格式/音质/完整度三轴折进「🔽 筛选 ▾」后，菜单一关，
 * 用户对外只剩一行 chip。所以断言全部落在**真跑出来的 DOM 与真筛出来的行数**上
 * （套具同 chunked-render.test.js：fake-dom + loadView，本仓没有 jsdom），
 * 不读源码做正则匹配。唯一例外是"点档位项不关菜单"——那是菜单留在屏上的前提，
 * 也只有真跑才看得出 cycle 里有没有偷偷 closeTbMenus。
 *
 * 夹具四首（3 首无损容器 / 2 首缺封面），故意让三条轴互相有交集又都不重合：
 * 这样"叠加后还剩几首"能同时证伪"筛了没重过筛"和"chip 报的不是生效的那几条"。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const LOCAL = 'src/renderer/js/views/local.js';

const SONGS = [
  { filePath: 'D:/m/a.flac', title: 'A', artist: 'ar', album: 'al', embeddedLyrics: 'la', cover: true },
  { filePath: 'D:/m/b.mp3', title: 'B', artist: 'ar', album: 'al', embeddedLyrics: 'lb', cover: false },
  { filePath: 'D:/m/c.flac', title: 'C', artist: 'ar', album: 'al', embeddedLyrics: '', cover: false },
  { filePath: 'D:/m/d.wav', title: 'D', artist: 'ar', album: 'al', embeddedLyrics: 'ld', cover: true },
];

async function freshLocal() {
  const state = { localSongs: SONGS.map((s) => ({ ...s })), localFiltered: [], favoriteKeys: new Set() };
  const dom = installBrowserGlobals({
    ids: [
      'localFilter', 'localList', 'localGrid', 'localAlbumWall', 'localAlbumFilterChip',
      'localFilterChips', 'localFilterMenu', 'localFmtBtn', 'localQualBtn', 'localMetaBtn',
      'localFavBtn', 'localSortBtn',
    ],
    extraGlobals: {
      getState: (k) => state[k],
      setState: (k, v) => { state[k] = v; },
    },
  });
  await loadView(LOCAL, dom);
  const chips = dom.element('localFilterChips');
  const shown = () => state.localFiltered.map((s) => s.filePath.split('/').pop());
  const chipTexts = () => [...chips.innerHTML.matchAll(/>([^<>]*?)<span class="filter-chip-x">/g)].map((m) => m[1]);
  return { dom, chips, shown, chipTexts };
}

test('开局没筛：chip 行整行隐藏，空 div 也不占那 14px 的缝（.local-page 是 gap 列）', async () => {
  const { chips, shown } = await freshLocal();
  globalThis.filterLocalSongs();
  assert.strictEqual(shown().length, 4);
  assert.strictEqual(chips.innerHTML, '');
  assert.strictEqual(chips.hidden, true, '没筛选时这行必须真隐藏');
});

test('音质轴走一格：筛的是无损容器，chip 文案就是轴表原文，按钮文案与高亮同步', async () => {
  const { chips, shown, chipTexts, dom } = await freshLocal();
  const { qualModeLabel } = await import(`../src/renderer/js/localQualityFilter.js?v=${Math.random()}`);
  globalThis.cycleLocalQual();
  assert.deepStrictEqual(shown(), ['a.flac', 'c.flac', 'd.wav'], '仅标称无损 ⇒ 三个无损容器');
  assert.strictEqual(chips.hidden, false);
  assert.deepStrictEqual(chipTexts(), [qualModeLabel('nominal')], 'chip 文案必须取自轴表 label，不另立词表');
  assert.strictEqual(dom.element('localQualBtn').textContent, qualModeLabel('nominal'));
  assert.ok(dom.element('localQualBtn').classList.contains('active'), '菜单里那一行也得亮着');
});

test('三轴叠加：chip 顺序恒为 格式→音质→完整度，与启用先后无关', async () => {
  const { chips, shown, chipTexts } = await freshLocal();
  const { qualModeLabel } = await import(`../src/renderer/js/localQualityFilter.js?v=${Math.random()}`);
  const { metaModeLabel } = await import(`../src/renderer/js/localMetaFilter.js?v=${Math.random()}`);
  const { fmtModeLabel, listFormats } = await import(`../src/renderer/js/localFormatFilter.js?v=${Math.random()}`);

  globalThis.cycleLocalQual();          // 音质 = 标称无损
  globalThis.cycleLocalMeta();          // 完整度 = 缺封面
  assert.deepStrictEqual(shown(), ['c.flac'], '无损容器 ∩ 缺封面 = 只剩 c.flac');
  assert.deepStrictEqual(chipTexts(), [qualModeLabel('nominal'), metaModeLabel('no-cover')]);

  globalThis.cycleLocalFmt();           // 格式 = 曲库实际出现的第一个格式
  const first = listFormats(SONGS)[0];
  assert.strictEqual(first, 'flac', '夹具里 flac 该排在前头（否则这条顺序断言没意义）');
  assert.deepStrictEqual(chipTexts(), [fmtModeLabel('flac'), qualModeLabel('nominal'), metaModeLabel('no-cover')],
    '后启用的格式轴要排在最前——chip 顺序跟轴表，不跟点击顺序');
  assert.strictEqual(chips.innerHTML.match(/filter-chip"/g).length, 3);
});

test('点 chip 单清一条轴：只解这一条，另两条继续筛，按钮回到关档文案', async () => {
  const { shown, chipTexts, dom } = await freshLocal();
  const { metaModeLabel } = await import(`../src/renderer/js/localMetaFilter.js?v=${Math.random()}`);
  globalThis.cycleLocalQual();
  globalThis.cycleLocalMeta();
  assert.deepStrictEqual(shown(), ['c.flac']);

  globalThis.resetLocalFilterAxis('qual');
  assert.deepStrictEqual(shown(), ['b.mp3', 'c.flac'], '音质轴清掉后，缺封面还在筛（不该顺手全清）');
  assert.deepStrictEqual(chipTexts(), [metaModeLabel('no-cover')]);
  assert.strictEqual(dom.element('localQualBtn').textContent, '🧪 音质', '清掉的轴按钮要回到关档文案');
  assert.ok(!dom.element('localQualBtn').classList.contains('active'), '关档不许还亮着');
});

test('名单外的 id 清不动：拿 sort 走同一条路，什么也不该变', async () => {
  const { shown, chipTexts } = await freshLocal();
  globalThis.cycleLocalQual();
  const before = shown();
  const beforeChips = chipTexts();
  globalThis.resetLocalFilterAxis('sort');   // 排序轴的关档值不是 'all'
  globalThis.resetLocalFilterAxis('fav');
  globalThis.resetLocalFilterAxis('nope');
  assert.deepStrictEqual(shown(), before, '名单外的轴被写档就是这条测要拦的');
  assert.deepStrictEqual(chipTexts(), beforeChips);
});

test('一键清空：三条轴全回关档，♥ 收藏与关键词一根手指都不碰', async () => {
  const { chips, shown, dom } = await freshLocal();
  globalThis.cycleLocalQual();
  globalThis.cycleLocalMeta();
  globalThis.cycleLocalFmt();
  globalThis.toggleLocalFavOnly();           // ♥ 仅收藏（在折叠之外）
  assert.strictEqual(shown().length, 0, '收藏的本地曲为空 ⇒ 收藏轴此时筛到 0 首');

  globalThis.clearLocalFilters();
  assert.strictEqual(chips.hidden, true, '清完这行就该消失');
  assert.deepStrictEqual(shown(), [], '清空筛选不越权清收藏（那是另一条轴，用户自己关）');

  globalThis.toggleLocalFavOnly();           // 关收藏
  assert.deepStrictEqual(shown(), ['a.flac', 'b.mp3', 'c.flac', 'd.wav'], '三条轴全回关档');
  for (const id of ['localFmtBtn', 'localQualBtn', 'localMetaBtn']) {
    assert.ok(!dom.element(id).classList.contains('active'), `${id} 清完不许还亮着`);
  }
});

test('关键词过滤不长 chip：它是搜索框的事，不该混进"生效筛选"里骗人', async () => {
  const { chips, shown } = await freshLocal();
  globalThis.document.getElementById('localFilter').value = 'B';
  globalThis.filterLocalSongs();
  assert.deepStrictEqual(shown(), ['b.mp3']);
  assert.strictEqual(chips.hidden, true, '关键词不该被报成一条筛选');
});

test('档位项点一次只走一格、菜单不许自己关（连点才能把五态走完）', async () => {
  const { dom } = await freshLocal();
  const menu = dom.element('localFilterMenu');
  // 替身元素默认 hidden=false，而 index.html 里这菜单是带 hidden 属性出生的 —— 先补上初态
  menu.hidden = true;
  globalThis.toggleTbDropdown(null, 'localFilterMenu');
  assert.strictEqual(menu.hidden, false, '下拉该被打开（前提：桥函数还在）');
  globalThis.cycleLocalQual();
  assert.strictEqual(menu.hidden, false, '档位项点完不许自动收菜单——走一格要能接着走');
  globalThis.cycleLocalMeta();
  assert.strictEqual(menu.hidden, false);
});
