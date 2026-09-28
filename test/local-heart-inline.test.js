/**
 * 本地曲库行内 ♥ 红心 + 收藏切换统一钩子
 *
 * 行内红心复用 heartBtnHtml(localFavSong(s))；收藏变化后的重过滤从
 * 「各调用方 finally」收敛为 favorites.js 成功后回调 window.onLocalFavToggle
 * 一条路（行菜单与行内红心共用）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/local.js'), 'utf8'
);
const FAV_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/favorites.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};
// heartBtnHtml 依赖渲染层全局 escAttr（utils.js 挂 window），测试环境补齐
global.escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function fresh() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

const LOCAL_SONG = { title: 'A', artist: 'B', filePath: 'C:\\music\\a.mp3' };

function stubEnv(favKeys) {
  global.getState = (k) => (k === 'favoriteKeys' ? favKeys : (k === 'userPlaylists' ? [] : null));
  global.setState = () => {};
  global.showToast = () => {};
  global.document = { querySelectorAll: () => [] };
}

test('行内红心：heartBtnHtml(localFavSong(s)) 键为 filePath:local，♥/♡ 随 favoriteKeys', async () => {
  const { localFavSong, heartBtnHtml } = await fresh();
  stubEnv(new Set());
  const off = heartBtnHtml(localFavSong(LOCAL_SONG), 'action-btn');
  assert.match(off, /data-fav-key="C:\\+music\\+a\.mp3:local"/);
  assert.ok(off.includes('♡') && !off.includes('♥'));
  assert.ok(off.includes('heart-btn') && off.includes('action-btn'));

  const { heartBtnHtml: h2 } = await fresh();
  stubEnv(new Set(['C:\\music\\a.mp3:local']));
  const on = h2(localFavSong(LOCAL_SONG), 'action-btn');
  assert.ok(on.includes('♥') && !on.includes('♡'));
  assert.match(on, /fav-on/);
});

test('统一钩子：本地歌收藏切换成功后调 window.onLocalFavToggle；非 local 源不调', async () => {
  const { toggleLocalFavorite, registerFavSong, toggleFavoriteByKey } = await fresh();
  let calls = 0;
  global.window.onLocalFavToggle = () => { calls++; };
  stubEnv(new Set());
  global.api = {
    toggleFavorite: async (source) => ({
      success: true, favorited: true,
      playlist: { id: 'favorites', songs: source === 'local' ? [LOCAL_SONG] : [] },
    }),
  };
  await toggleLocalFavorite(LOCAL_SONG);
  assert.strictEqual(calls, 1);

  const NETEASE = { id: 7, source: 'netease', title: 'N' };
  registerFavSong(NETEASE);
  await toggleFavoriteByKey('7:netease');
  assert.strictEqual(calls, 1, '非本地源不应触发本地重过滤钩子');
  delete global.window.onLocalFavToggle;
});

test('接线钉桩：_renderLocalRow 动作组首位注入行内红心，缺 filePath 渲染空串', () => {
  assert.match(LOCAL_JS,
    /const favs = localFavSong\(s\); return favs \? heartBtnHtml\(favs, 'action-btn'\) : '';/);
});

test('接线钉桩：favorites.js 成功后回调钩子 + local.js 定义 onLocalFavToggle 重过滤', () => {
  assert.match(FAV_JS, /typeof window\.onLocalFavToggle === 'function'/);
  assert.match(FAV_JS, /window\.onLocalFavToggle\(\);/);
  assert.match(LOCAL_JS, /window\.onLocalFavToggle = \(\) => \{ if \(_localFavOnly\) filterLocalSongs\(\); \};/);
});
