/**
 * 播放队列行 ♥ 收藏（queueFavSong 键对齐 + 行尾红心）
 *
 * 队列里的本地行 id 未必是 filePath，直接出红心会和本地曲库的
 * filePath:local 键分裂成两条 —— queueFavSong 统一换算；无 id 行不出红心。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/app.js'), 'utf8'
);
const FAV_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/favorites.js'), 'utf8'
);
const PLAYER_CSS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/styles/player.css'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};
global.escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function fresh() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

test('queueFavSong：在线行原样直传；本地行换算 filePath 键；坏数据不出红心', async () => {
  const { queueFavSong } = await fresh();
  const netease = { id: 7, source: 'netease', title: 'N' };
  assert.strictEqual(queueFavSong(netease), netease);
  const localRow = { source: 'local', id: 3, title: 'L', filePath: 'E:\\m\\l.mp3' };
  const mapped = queueFavSong(localRow);
  assert.strictEqual(mapped.id, 'E:\\m\\l.mp3');
  assert.strictEqual(mapped.source, 'local');
  assert.strictEqual(mapped.title, 'L');
  assert.strictEqual(queueFavSong({ source: 'local', title: 'no path' }), null);
  assert.strictEqual(queueFavSong({ source: 'qq', title: 'no id' }), null);
  assert.strictEqual(queueFavSong(null), null);
});

test('队列本地行红心点击链：键 filePath:local，收藏成功触发本地重过滤钩子', async () => {
  const mod = await fresh();
  let hookCalls = 0;
  global.window.onLocalFavToggle = () => { hookCalls++; };
  global.getState = (k) => (k === 'favoriteKeys' ? new Set()
    : (k === 'userPlaylists' ? [] : null));
  global.setState = () => {};
  global.showToast = () => {};
  global.document = { querySelectorAll: () => [] };
  const calls = [];
  global.api = {
    toggleFavorite: async (source, id, song) => {
      calls.push([source, id, song.filePath]);
      return { success: true, favorited: true, playlist: { id: 'favorites', songs: [] } };
    },
  };
  const favS = mod.queueFavSong({ source: 'local', id: 3, filePath: 'E:\\m\\l.mp3' });
  const m = /data-fav-key="([^"]*)"/.exec(mod.heartBtnHtml(favS, 'pq-fav'));
  assert.strictEqual(m[1], 'E:\\m\\l.mp3:local');
  await mod.toggleFavoriteByKey(m[1]);
  assert.deepStrictEqual(calls, [['local', 'E:\\m\\l.mp3', 'E:\\m\\l.mp3']]);
  assert.strictEqual(hookCalls, 1);
  delete global.window.onLocalFavToggle;
});

test('接线钉桩：app.js import queueFavSong + 队列行尾条件注入 pq-fav 红心', () => {
  assert.match(APP_JS, /import \{ heartBtnHtml, queueFavSong \} from '\.\/favorites\.js';/);
  assert.match(APP_JS, /const favS = queueFavSong\(s\);/);
  assert.match(APP_JS, /\+ \(favS \? heartBtnHtml\(favS, 'pq-fav'\) : ''\)\s*\+ '<\/div>'/);
});

test('接线钉桩：queueFavSong 导出 + 队列行红心复位样式落位', () => {
  assert.match(FAV_JS, /export function queueFavSong\(s\) \{/);
  assert.match(PLAYER_CSS, /\.pq-item \.heart-btn\.pq-fav \{[^}]*background: none;/);
});
