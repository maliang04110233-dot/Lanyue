/**
 * 歌曲行右键「所属专辑」操作（albumMenuItems 纯组装 + 接线钉桩）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SONG_MENU = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/songMenu.js'), 'utf8'
);
const SEARCH_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/search.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/songMenu.js?tc=' + Math.random());
}

test('无 albumMid / 空 song：一项都不出（本地曲库等无专辑 ID 的行不加噪声）', async () => {
  const { albumMenuItems } = await fresh();
  const acts = { openAlbum: () => {}, downloadAlbum: () => {} };
  assert.deepStrictEqual(albumMenuItems({ id: 1, source: 'netease' }, acts), []);
  assert.deepStrictEqual(albumMenuItems(null, acts), []);
  assert.deepStrictEqual(albumMenuItems({ albumMid: 'A1' }, {}), []);
});

test('有 albumMid：段首分隔线 + 💿/⬇️ 两项按序；只注入一个动作时也只带分隔线', async () => {
  const { albumMenuItems } = await fresh();
  const song = { id: 1, source: 'qq', albumMid: 'AL1', album: 'X' };
  const both = albumMenuItems(song, { openAlbum: () => {}, downloadAlbum: () => {} });
  assert.strictEqual(both.length, 3);
  assert.strictEqual(both[0].sep, true);
  assert.strictEqual(both[1].icon, '💿');
  assert.strictEqual(both[2].icon, '⬇️');
  const one = albumMenuItems(song, { openAlbum: () => {} });
  assert.strictEqual(one.length, 2);
  assert.strictEqual(one[0].sep, true);
});

test('onClick 回调把整行 song 带回注入动作（闭包取 albumMid/source 由调用方负责）', async () => {
  const { albumMenuItems } = await fresh();
  const song = { id: 7, source: 'netease', albumMid: 'AL7', album: 'Y' };
  let opened = null, dl = null;
  const items = albumMenuItems(song, {
    openAlbum: (s) => { opened = s; },
    downloadAlbum: (s) => { dl = s; },
  });
  items[1].onClick();
  items[2].onClick();
  assert.strictEqual(opened, song);
  assert.strictEqual(dl, song);
});

test('接线钉桩：openSongRowMenu 注入的动作走既有 window 桥且有 typeof 守卫', () => {
  assert.match(SONG_MENU, /items\.push\(\.\.\.albumMenuItems\(song, \{/);
  assert.match(SONG_MENU, /typeof window\.openAlbumView === 'function'\) window\.openAlbumView\(s\.albumMid, s\.source, s\.album\)/);
  assert.match(SONG_MENU, /typeof window\.downloadAlbum === 'function'\) window\.downloadAlbum\(s\.albumMid, s\.source\)/);
  assert.match(SEARCH_JS, /window\.downloadAlbum = downloadAlbum;/);
});
