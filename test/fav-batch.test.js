/**
 * 测试：搜索页「♥ 批量收藏」
 *
 * planBatchFav 纯函数直调（红心是 toggle 语义，判重是批量收藏的命门）；
 * toggleFavoriteByKey 的 silent/返回值是新增契约，旧调用方（单曲红心、
 * 命令面板、本地切换）缺省路径必须逐字不变；接线走静态钉。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FAV_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/favorites.js'), 'utf8'
);
const SEARCH_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/search.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);
const BATCH_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/favBatch.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function freshBatch() {
  return import('../src/renderer/js/favBatch.js?v=' + Math.random());
}
async function freshFav() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

const keyOf = (s) => String(s.id) + ':' + String(s.source || '');

test('planBatchFav：Set/数组键皆可、已收藏剔除计数、无 id 静默丢、保持原序', async () => {
  const { planBatchFav } = await freshBatch();
  const songs = [
    { id: 1, source: 'netease' },
    { id: 2, source: 'netease' },
    { id: 3, source: 'qq' },
    null,
    { source: 'qq' },
    { id: 4, source: '' },
  ];
  const r = planBatchFav(songs, new Set(['2:netease', '4:']), keyOf);
  assert.deepEqual(r.toFav.map(s => s.id), [1, 3], '已收藏与无 id 都不进 toFav，顺序不变');
  assert.equal(r.already, 2, '4: 命中（source 空串归一）');
  // 数组键（favoriteKeys 理论上是 Set，容错面）
  assert.deepEqual(planBatchFav(songs, ['1:netease'], keyOf).toFav.map(s => s.id), [2, 3, 4]);
  // 脏输入
  assert.deepEqual(planBatchFav(null, null, keyOf), { toFav: [], already: 0 });
  assert.deepEqual(planBatchFav(undefined, undefined, keyOf), { toFav: [], already: 0 });
});

test('favSkipSuffix：0 省略、N 成句', async () => {
  const { favSkipSuffix } = await freshBatch();
  assert.equal(favSkipSuffix(0), '');
  assert.equal(favSkipSuffix(3), '（跳过 3 首已收藏）');
});

test('toggleFavoriteByKey：silent 不弹单曲 toast，成败看返回值；缺省路径 toast 如旧', async () => {
  const { registerFavSong, toggleFavoriteByKey } = await freshFav();
  const toasts = [];
  global.getState = (k) => (k === 'userPlaylists' ? [] : null);
  global.setState = () => {};
  global.showToast = (m) => toasts.push(m);
  global.document = { querySelectorAll: () => [] };
  global.api = {
    toggleFavorite: async () => ({ success: true, favorited: true, playlist: { id: 'favorites', songs: [] } }),
  };
  registerFavSong({ id: 9, source: 'netease', title: 'T' });
  assert.equal(await toggleFavoriteByKey('9:netease', true), true, 'silent 成功回 true');
  assert.equal(toasts.length, 0, 'silent 不弹 toast');
  assert.equal(await toggleFavoriteByKey('9:netease'), true);
  assert.equal(toasts.length, 1, '缺省仍弹旧 toast');
  assert.match(toasts[0], /^已收藏/);
  // 未登记键：false + warn（silent 时连 warn 都不弹）
  assert.equal(await toggleFavoriteByKey('404:x', true), false);
  assert.equal(toasts.length, 1);
  // api 报失败：false，错误经旧路 toast、silent 闭嘴
  global.api = { toggleFavorite: async () => ({ success: false, error: '盘满' }) };
  assert.equal(await toggleFavoriteByKey('9:netease', true), false);
  assert.equal(toasts.length, 1);
  assert.equal(await toggleFavoriteByKey('9:netease'), false);
  assert.deepEqual(toasts.slice(1), ['盘满']);
});

test('接线钉：favBatch 形状、search/favorites/HTML/面板落位、旧单曲链不动', () => {
  assert.match(BATCH_JS, /export function planBatchFav\(songs, favKeys, keyOf\) \{/);
  assert.ok(!/\bdocument\b/.test(BATCH_JS) && !/\bwindow\b/.test(BATCH_JS), 'favBatch 顶层不得碰 DOM');
  assert.match(SEARCH_JS, /import \{ planBatchFav, favSkipSuffix \} from '\.\.\/favBatch\.js';/);
  assert.match(SEARCH_JS, /import \{ heartBtnHtml, registerFavSong, toggleFavoriteByKey \} from '\.\.\/favorites\.js';/);
  assert.match(SEARCH_JS, /async function batchFavorite\(\) \{/);
  assert.match(SEARCH_JS, /window\.batchFavorite = batchFavorite;/);
  assert.ok(SEARCH_JS.includes("showToast('请先勾选要收藏的歌曲', 'warn')"));
  assert.match(HTML, /<button class="batch-btn" onclick="batchFavorite\(\)"[^>]*>♥ 收藏<\/button>/);
  assert.match(PALETTE_JS, /id: 'sr-batchfav'[\s\S]{0,220}?_call\('batchFavorite'\)/);
  // silent 是加参不是改道：单曲调用点保持单参
  assert.match(FAV_JS, /export async function toggleFavoriteByKey\(key, silent\) \{/);
  assert.match(FAV_JS, /return toggleFavoriteByKey\(favKey\('local', s\.filePath\)\);/);
  assert.equal((FAV_JS.match(/toggleFavoriteByKey\(/g) || []).length, 4,
    '定义 + 本地切换/当前曲/红心点击 3 个旧调用点（批量调用在 search.js）');
});
