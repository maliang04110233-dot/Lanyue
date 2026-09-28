/**
 * 歌单「📋 另存副本」—— plDuplicate.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/playlist.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

function fresh() {
  return import('../src/renderer/js/plDuplicate.js?tc=' + Math.random());
}

test('dupPlaylistName：副本 → 副本2 → 副本3 撞名逐个让位', async () => {
  const { dupPlaylistName } = await fresh();
  assert.equal(dupPlaylistName('通勤', []), '通勤 (副本)');
  assert.equal(dupPlaylistName('通勤', ['通勤 (副本)']), '通勤 (副本2)');
  assert.equal(dupPlaylistName('通勤', ['通勤 (副本)', '通勤 (副本2)']), '通勤 (副本3)');
  assert.equal(dupPlaylistName('  周末  ', []), '周末 (副本)', '首尾空白先清');
  assert.equal(dupPlaylistName('', []), '歌单 (副本)', '空名兜底');
  assert.equal(dupPlaylistName(null, undefined), '歌单 (副本)', '脏入参不炸');
});

test('dupPlaylistPayload：无 id 键（带 id 会覆盖原单）+ songs 换数组不换元素', async () => {
  const { dupPlaylistPayload } = await fresh();
  const s1 = { id: 1, source: 'netease' };
  const pl = { id: 'pl-7', name: '通勤', desc: 'D', cover: 'https://c', songs: [s1, { id: 2 }] };
  const p = dupPlaylistPayload(pl, '通勤 (副本)');
  assert.deepEqual(p, { name: '通勤 (副本)', desc: 'D', cover: 'https://c', songs: [s1, { id: 2 }] });
  assert.ok(!('id' in p), '载荷必须无 id：无 id 即新建');
  assert.notEqual(p.songs, pl.songs, '数组要浅拷贝');
  assert.equal(p.songs[0], s1, '元素保持引用');
  assert.deepEqual(dupPlaylistPayload({}, 'X'), { name: 'X', desc: '', cover: '', songs: [] }, '缺字段兜底');
});

test('接线钉：视图函数/实时重拉/桥/HTML 按钮/palette 全部就位', () => {
  assert.match(PL_JS, /import \{ dupPlaylistName, dupPlaylistPayload \} from '\.\.\/plDuplicate\.js';/);
  assert.match(PL_JS, /async function duplicateCurrentPlaylist\(\) \{/);
  assert.match(PL_JS, /const all = \(await api\.getUserPlaylists\(\)\) \|\| \[\];\n\s+const pl = all\.find\(p => p && p\.id === _currentPlaylistId\);/, '实时重拉防脏 state');
  assert.match(PL_JS, /dupPlaylistName\(pl\.name, all\.map\(p => p && p\.name\)\.filter\(Boolean\)\)/);
  assert.match(PL_JS, /api\.saveUserPlaylist\(dupPlaylistPayload\(pl, newName\)\)/, '副本载荷直发既有通道');
  assert.match(PL_JS, /let _plDupBusy = false;/, '防重入闩');
  assert.match(PL_JS, /window\.duplicateCurrentPlaylist = duplicateCurrentPlaylist;/);
  assert.match(HTML, /onclick="duplicateCurrentPlaylist\(\)">📋 副本/);
  assert.match(PALETTE_JS, /\{ id: 'pl-dup'/);
  assert.match(PALETTE_JS, /_call\('duplicateCurrentPlaylist'\)/);
});
