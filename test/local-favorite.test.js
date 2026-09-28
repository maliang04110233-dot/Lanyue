/**
 * 本地曲库行「♥ 收藏」（localFavSong 键映射 + 行菜单接线，零新 IPC 通道）
 *
 * 本地歌收藏复用 toggle-favorite：source 固定 'local'、id 用 filePath，
 * 收藏条目保留 filePath，播放走 player 的 file:// 本地分支。
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
const MENU_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/localRowMenu.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

const LOCAL_SONG = { title: 'A', artist: 'B', filePath: 'C:\\music\\a.mp3' };

test('localFavSong：纯映射 source=local + id=filePath；缺路径/空对象一律 null', async () => {
  const { localFavSong } = await fresh();
  const s = localFavSong({ ...LOCAL_SONG, source: 'whatever', id: 42 });
  assert.strictEqual(s.source, 'local');
  assert.strictEqual(s.id, 'C:\\music\\a.mp3');
  assert.strictEqual(s.title, 'A');
  assert.strictEqual(s.filePath, 'C:\\music\\a.mp3');
  assert.strictEqual(localFavSong({ title: 'x' }), null);
  assert.strictEqual(localFavSong(null), null);
});

test('isLocalFavorite：按 filePath:local 键查派生集合，跨目录不同文件不误判', async () => {
  const { isLocalFavorite } = await fresh();
  global.getState = (k) => (k === 'favoriteKeys'
    ? new Set(['C:\\music\\a.mp3:local']) : null);
  assert.strictEqual(isLocalFavorite(LOCAL_SONG), true);
  assert.strictEqual(isLocalFavorite({ ...LOCAL_SONG, filePath: 'C:\\music\\b.mp3' }), false);
  assert.strictEqual(isLocalFavorite({ title: 'no path' }), false);
});

test('toggleLocalFavorite：先登记再走 toggleFavoriteByKey→api(local,filePath,带回富化song)；缺路径只 warn', async () => {
  const { toggleLocalFavorite } = await fresh();
  const apiCalls = [], toasts = [];
  global.getState = (k) => (k === 'userPlaylists' ? [] : null);
  global.setState = () => {};
  global.showToast = (msg, type) => toasts.push([type, msg]);
  global.document = { querySelectorAll: () => [] };
  global.api = {
    toggleFavorite: async (source, id, song) => {
      apiCalls.push([source, id, song.filePath]);
      return { success: true, favorited: true, playlist: { id: 'favorites', songs: [] } };
    },
  };
  await toggleLocalFavorite({ title: 'no path' });
  assert.strictEqual(apiCalls.length, 0);
  assert.deepStrictEqual(toasts[0], ['warn', '收藏失败：歌曲缺少文件路径']);
  await toggleLocalFavorite(LOCAL_SONG);
  assert.deepStrictEqual(apiCalls, [['local', 'C:\\music\\a.mp3', 'C:\\music\\a.mp3']]);
});

test('接线钉桩：favorites 桥 + local.js fav/favOn 注入 + 行菜单 ♥ 收藏项', () => {
  assert.match(FAV_JS, /window\.toggleLocalFavorite = toggleLocalFavorite;/);
  assert.match(FAV_JS, /registerFavSong\(s\);\r?\n\s*return toggleFavoriteByKey\(favKey\('local', s\.filePath\)\);/);
  // 90 起 import 追加 localFavSong/heartBtnHtml，用宽松尾匹配
  assert.match(LOCAL_JS, /import \{ isLocalFavorite, toggleLocalFavorite[\s\S]{0,80}?\} from '\.\.\/favorites\.js';/);
  // 90 起重过滤走 favorites.js 统一钩子，菜单动作回归裸调用
  assert.match(LOCAL_JS, /fav: \(song\) => toggleLocalFavorite\(song\)/);
  assert.match(LOCAL_JS, /favOn: isLocalFavorite\(s\)/);
  assert.match(MENU_JS, /actions\.favOn \? '💔' : '♥'/);
});
