/**
 * 命令面板「♥ 收藏/取消当前播放的歌」
 *
 * 五个行面红心377a837–5943b4a 只覆盖列表行；正在播放的歌（主播放器/迷你窗/
 * 桌面词）没有列表行可点心。本增量补一条命令面板可达的当前曲收藏入口：
 * currentPlaying → queueFavSong 键对齐（本地=filePath:local / 在线=source:id）
 * → registerFavSong 登记 → toggleFavoriteByKey 复用整条切换+播报链，零新 IPC。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FAV_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/favorites.js'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/favorites.js?tc=' + Math.random());
}

function envStub(save) {
  const calls = { toggle: [], toasts: [] };
  global.getState = (k) => (k === 'currentPlaying' ? save.cur : (k === 'userPlaylists' ? [] : null));
  global.setState = () => {};
  global.showToast = (m, t) => calls.toasts.push([t, m]);
  global.document = { querySelectorAll: () => [] };
  global.api = {
    toggleFavorite: async (source, id, song) => {
      calls.toggle.push([source, id, song && (song.filePath || song.title)]);
      return { success: true, favorited: true, playlist: { id: 'favorites', songs: [] } };
    },
  };
  return calls;
}

test('toggleFavoriteCurrent：在线曲走 source:id 键，先登记再切，成功复用 toggleFavoriteByKey 链', async () => {
  const { toggleFavoriteCurrent } = await fresh();
  const calls = envStub({ cur: { source: 'netease', id: 42, title: 'T', artist: 'A' } });
  await toggleFavoriteCurrent();
  assert.strictEqual(calls.toggle.length, 1);
  assert.strictEqual(calls.toggle[0][0], 'netease');
  assert.strictEqual(calls.toggle[0][1], '42');
});

test('toggleFavoriteCurrent：本地曲折叠到 filePath:local 键（与本地库红心同源不分裂）', async () => {
  const { toggleFavoriteCurrent } = await fresh();
  const calls = envStub({ cur: { source: 'local', id: 'raw', title: 'T', filePath: 'C:\\m\\a.mp3' } });
  await toggleFavoriteCurrent();
  assert.strictEqual(calls.toggle.length, 1);
  assert.strictEqual(calls.toggle[0][0], 'local');
  assert.strictEqual(calls.toggle[0][1], 'C:\\m\\a.mp3', '本地键折叠到 filePath');
});

test('toggleFavoriteCurrent：无可收藏曲（未播放/缺 id/本地缺路径）只提示不触 api', async () => {
  const { toggleFavoriteCurrent } = await fresh();
  for (const cur of [null, { source: 'netease' }, { source: 'local', id: 'x', title: 'T' }]) {
    const calls = envStub({ cur });
    await toggleFavoriteCurrent();
    assert.strictEqual(calls.toggle.length, 0, '坏数据不触后端：' + JSON.stringify(cur));
    assert.deepStrictEqual(calls.toasts[0], ['info', '当前没有可收藏的歌']);
  }
});

test('接线钉桩：favorites 桥 + 命令面板 pl-fav 项落位', () => {
  assert.match(FAV_JS, /window\.toggleFavoriteCurrent = toggleFavoriteCurrent;/);
  assert.match(FAV_JS, /export async function toggleFavoriteCurrent\(\) \{/);
  assert.match(PALETTE_JS, /id: 'pl-fav'[\s\S]{0,200}?_call\('toggleFavoriteCurrent'\)/);
});
