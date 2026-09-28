/**
 * 歌单拖拽排序纯函数测试
 * playlistSort.js 无 DOM / window 依赖，动态 import 加缓存戳避免污染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/playlistSort.js?ck=${Math.random()}`);

test('moveInList 向下移动：占据目标位置', async () => {
  const { moveInList } = await mod();
  const r = moveInList(['a', 'b', 'c', 'd'], 0, 2);
  assert.deepEqual(r, ['b', 'c', 'a', 'd']);
});

test('moveInList 向上移动', async () => {
  const { moveInList } = await mod();
  const r = moveInList(['a', 'b', 'c'], 2, 0);
  assert.deepEqual(r, ['c', 'a', 'b']);
});

test('moveInList 不修改原数组', async () => {
  const { moveInList } = await mod();
  const src = ['a', 'b', 'c'];
  moveInList(src, 0, 2);
  assert.deepEqual(src, ['a', 'b', 'c']);
});

test('moveInList 无效输入返回 null（同位/越界/短列表/非数组）', async () => {
  const { moveInList } = await mod();
  assert.equal(moveInList(['a', 'b'], 1, 1), null);
  assert.equal(moveInList(['a', 'b'], -1, 1), null);
  assert.equal(moveInList(['a', 'b'], 0, 2), null);
  assert.equal(moveInList(['a'], 0, 0), null);
  assert.equal(moveInList(null, 0, 1), null);
  assert.equal(moveInList('ab', 0, 1), null);
});

// ── 视图级排序 ────────────────────────────────

const P = (i, song) => ({ song, i });

test('nextPlSortMode 四档循环，坏值回落到默认序的下一档', async () => {
  const { nextPlSortMode } = await mod();
  assert.equal(nextPlSortMode(''), 'title');
  assert.equal(nextPlSortMode('title'), 'artist');
  assert.equal(nextPlSortMode('artist'), 'added');
  assert.equal(nextPlSortMode('added'), '');
  assert.equal(nextPlSortMode('bogus'), 'title');
});

test('sortPlaylistPairs 默认序原样返回且不动入参', async () => {
  const { sortPlaylistPairs } = await mod();
  const src = [P(2, { title: 'c' }), P(0, { title: 'a' })];
  const out = sortPlaylistPairs(src, '');
  assert.deepEqual(out.map((p) => p.i), [2, 0]);
  assert.notEqual(out, src);
  assert.equal(sortPlaylistPairs(null, 'title').length, 0);
});

test('sortPlaylistPairs 标题中文拼音序、缺失垫底、同键稳定', async () => {
  const { sortPlaylistPairs } = await mod();
  const out = sortPlaylistPairs([
    P(3, { title: '红色' }), P(1, { title: '白色' }),
    P(4, { title: '蓝色' }), P(5, {}), P(0, { title: '' }),
  ], 'title');
  assert.deepEqual(out.map((p) => p.i), [1, 3, 4, 0, 5]); // 白<红<蓝；''/缺失垫底且保序
});

test('sortPlaylistPairs 歌手排序', async () => {
  const { sortPlaylistPairs } = await mod();
  const out = sortPlaylistPairs([
    P(0, { artist: '张三' }), P(1, { artist: '李四' }), P(2, { artist: '王五' }),
  ], 'artist');
  assert.deepEqual(out.map((p) => p.i), [1, 2, 0]); // 李<王<张（ICU zh 拼音序）
});

test('sortPlaylistPairs 添加时间升序、缺 addedAt 垫底', async () => {
  const { sortPlaylistPairs } = await mod();
  const out = sortPlaylistPairs([
    P(0, { title: 'x' }), P(1, { addedAt: 200 }), P(2, { addedAt: 100 }),
  ], 'added');
  assert.deepEqual(out.map((p) => p.i), [2, 1, 0]);
});

// ── 歌单页卡片排序 ─────────────────────────────

test('nextPlCardSortMode 四档循环、坏值回落', async () => {
  const { nextPlCardSortMode } = await mod();
  assert.equal(nextPlCardSortMode(''), 'name');
  assert.equal(nextPlCardSortMode('name'), 'count');
  assert.equal(nextPlCardSortMode('count'), 'recent');
  assert.equal(nextPlCardSortMode('recent'), '');
  assert.equal(nextPlCardSortMode('nope'), 'name');
});

test('sortPlaylists 默认序仅剔脏 + 收藏置顶不参与', async () => {
  const { sortPlaylists } = await mod();
  const sys = { id: 'F', name: '收藏', system: true };
  const r = sortPlaylists([{ id: 'a' }, null, sys, { id: 'b' }], '');
  assert.deepEqual(r.map((p) => p.id), ['F', 'a', 'b']);
  assert.deepEqual(sortPlaylists(null, 'name'), []);
});

test('sortPlaylists 名称 zh 拼音序', async () => {
  const { sortPlaylists } = await mod();
  const r = sortPlaylists([{ name: '红色歌单' }, { name: '白色歌单' }], 'name');
  assert.deepEqual(r.map((p) => p.name), ['白色歌单', '红色歌单']);
});

test('sortPlaylists 曲数降序、缺 songs 视为 0', async () => {
  const { sortPlaylists } = await mod();
  const mk = (n) => ({ songs: Array.from({ length: n }, () => 1) });
  const r = sortPlaylists([{ id: 'a', ...mk(2) }, { id: 'b' }, { id: 'c', ...mk(5) }], 'count');
  assert.deepEqual(r.map((p) => p.id), ['c', 'a', 'b']);
});

test('sortPlaylists 最近更新降序、缺时间戳垫底', async () => {
  const { sortPlaylists } = await mod();
  const r = sortPlaylists([
    { id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 300 }, { id: 'c' },
  ], 'recent');
  assert.deepEqual(r.map((p) => p.id), ['b', 'a', 'c']);
});

test('filterPlaylists：名称/描述多词 AND 匹配，大小写不敏感', async () => {
  const { filterPlaylists } = await mod();
  const pls = [
    { id: 'a', name: 'Road Trip 精选', desc: '开车听的' },
    { id: 'b', name: '晨跑', desc: 'road running' },
    { id: 'c', name: '睡前', desc: '轻音乐' },
  ];
  assert.deepEqual(filterPlaylists(pls, 'road').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(filterPlaylists(pls, 'ROAD 精选').map((p) => p.id), ['a']);
  assert.deepEqual(filterPlaylists(pls, 'road 不存在'), []);
});

test('filterPlaylists：空词透传原引用；过滤态剔除 null；非数组返回空', async () => {
  const { filterPlaylists } = await mod();
  const pls = [{ id: 'a', name: 'x' }, null];
  assert.equal(filterPlaylists(pls, ''), pls);
  assert.equal(filterPlaylists(pls, '   '), pls);
  assert.deepEqual(filterPlaylists(pls, 'x'), [{ id: 'a', name: 'x' }]);
  assert.deepEqual(filterPlaylists(null, 'x'), []);
  assert.deepEqual(filterPlaylists('nope', 'x'), []);
});

test('filterPlaylists+sortPlaylists 组合：系统单命中才参与置顶', async () => {
  const { filterPlaylists, sortPlaylists } = await mod();
  const pls = [
    { id: 'f', name: '收藏', system: true, desc: '通勤必听' },
    { id: 'a', name: '通勤路上' },
    { id: 'b', name: '跑步' },
  ];
  const shown = sortPlaylists(filterPlaylists(pls, '轻音乐'), '');
  assert.deepEqual(shown.map((p) => p.id), []);
  const both = sortPlaylists(filterPlaylists(pls, '通勤'), 'name');
  // f 经 desc 命中且系统单置顶，a 经 name 命中
  assert.deepEqual(both.map((p) => p.id), ['f', 'a']);
});
