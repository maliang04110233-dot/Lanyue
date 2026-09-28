/**
 * 歌单详情行内 ♥ 红心 + 收藏夹即时同步重渲染
 *
 * renderPlaylistDetailSongs 复用 heartBtnHtml（渲染即 registerFavSong，
 * 点击走 toggleFavoriteByKey 统一路）；收藏夹详情打开时经一次性
 * subscribe('userPlaylists') 按最新收藏歌单重渲染 → 取消收藏行立消失。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};
// heartBtnHtml 依赖渲染层全局 escAttr（utils.js 挂 window）
global.escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function fresh() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

function stubEnv(apiCalls, favKeys) {
  global.getState = (k) => (k === 'favoriteKeys' ? (favKeys || new Set())
    : (k === 'userPlaylists' ? [{ id: 'favorites', songs: [] }] : null));
  global.setState = () => {};
  global.showToast = () => {};
  global.document = { querySelectorAll: () => [] };
  global.api = {
    toggleFavorite: async (source, id, song) => {
      apiCalls.push([source, id, song]);
      return { success: true, favorited: true, playlist: { id: 'favorites', songs: [] } };
    },
  };
}

/** 从渲染出的红心 HTML 提取 data-fav-key（模拟点击链路入口） */
function keyOf(html) {
  const m = /data-fav-key="([^"]*)"/.exec(html);
  assert.ok(m, '红心按钮缺少 data-fav-key: ' + html);
  return m[1];
}

test('详情行红心登记链：heartBtnHtml 渲染即登记，按 HTML 里的键切换可带回完整歌曲', async () => {
  const mod = await fresh();
  const calls = [];
  stubEnv(calls); // heartBtnHtml→isFavorite 也读 favoriteKeys，先立桩
  const song = { id: 7, source: 'netease', title: '夜的第七章', artist: '周杰伦' };
  const key = keyOf(mod.heartBtnHtml(song, 'action-btn'));
  assert.strictEqual(key, '7:netease');
  await mod.toggleFavoriteByKey(key);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['netease', '7']);
  assert.strictEqual(calls[0][2].title, '夜的第七章');
});

test('本地收藏曲在收藏详情的红心：键为 filePath:local，切换触发本地重过滤钩子', async () => {
  const mod = await fresh();
  let hookCalls = 0;
  global.window.onLocalFavToggle = () => { hookCalls++; };
  const calls = [];
  stubEnv(calls);
  const key = keyOf(mod.heartBtnHtml(
    mod.localFavSong({ title: 'A', filePath: 'D:\\song\\b.mp3' }), 'action-btn'));
  assert.strictEqual(key, 'D:\\song\\b.mp3:local');
  await mod.toggleFavoriteByKey(key);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['local', 'D:\\song\\b.mp3']);
  assert.strictEqual(hookCalls, 1, '本地源收藏切换应触发 onLocalFavToggle');
  delete global.window.onLocalFavToggle;
});

test('接线钉桩：playlist.js import 红心模块 + 详情行 ♥ 注入在 ▶ 之前', () => {
  assert.match(PL_JS, /import \{ HEART_ON, heartBtnHtml \} from '\.\.\/favorites\.js';/);
  assert.match(PL_JS, /import \{ FAVORITES_PLAYLIST_ID, subscribe \} from '\.\.\/state\.js';/);
  assert.match(PL_JS,
    /\$\{heartBtnHtml\(song, 'action-btn'\)\}\s*<button class="action-btn" onclick="playPlaylistSong\(\$\{idx\}\)"/);
});

test('接线钉桩：收藏夹详情一次性订阅同步（守卫 _currentPlaylistId + 弹层可见）', () => {
  assert.match(PL_JS, /let _plFavSyncBound = false;/);
  assert.match(PL_JS, /subscribe\('userPlaylists', \(pls\) => \{\r?\n\s*if \(_currentPlaylistId !== FAVORITES_PLAYLIST_ID\) return;/);
  assert.match(PL_JS, /if \(pl\) renderPlaylistDetailSongs\(pl\.songs \|\| \[\]\);/);
  assert.match(PL_JS, /_bindFavDetailSync\(\);\r?\n\s*loadUserPlaylists\(\);/);
});
