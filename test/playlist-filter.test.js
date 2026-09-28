/**
 * 歌单过滤纯函数测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/playlistFilter.js?ck=${Math.random()}`);

const S = (title, artist, album) => ({ title, artist, album });

test('空关键词返回全量原始下标 pairs', async () => {
  const { filterPlaylistSongs } = await mod();
  const songs = [S('a', 'x'), S('b', 'y')];
  assert.deepEqual(filterPlaylistSongs(songs, ''), [{ song: songs[0], i: 0 }, { song: songs[1], i: 1 }]);
  assert.deepEqual(filterPlaylistSongs(songs, '   ').map(p => p.i), [0, 1]);
  assert.deepEqual(filterPlaylistSongs(null, ''), []);
});

test('命中保留原始下标（过滤不重排）', async () => {
  const { filterPlaylistSongs } = await mod();
  const songs = [S('晴天', '周杰伦'), S('安静', '周杰伦'), S('海阔天空', 'Beyond')];
  const r = filterPlaylistSongs(songs, '海阔');
  assert.equal(r.length, 1);
  assert.equal(r[0].i, 2);
});

test('多词 AND 组合 + 大小写不敏感 + 标题/歌手/专辑全字段', async () => {
  const { filterPlaylistSongs } = await mod();
  const songs = [S('Hello', 'Adele', '25'), S('Hello', 'Lionel Richie')];
  assert.deepEqual(filterPlaylistSongs(songs, 'hello adele').map(p => p.i), [0]);
  assert.deepEqual(filterPlaylistSongs(songs, 'HELLO').map(p => p.i), [0, 1]);
  assert.deepEqual(filterPlaylistSongs(songs, '25').map(p => p.i), [0]); // 专辑命中
});

test('缺字段/脏数据行不炸且不命中', async () => {
  const { filterPlaylistSongs } = await mod();
  const songs = [null, {}, S('只有标题')];
  assert.deepEqual(filterPlaylistSongs(songs, '只有').map(p => p.i), [2]);
  assert.deepEqual(filterPlaylistSongs(songs, 'x').map(p => p.i), []);
});
