/**
 * playlist-merge.test.js — 歌单合并纯函数
 *
 * 手法同 playlist-export.test.js：CJS + ?ck 缓存爆破 fresh import，
 * 纯函数无 DOM 依赖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

async function fresh() {
  return import(`../src/renderer/js/playlistMerge.js?ck=${Math.random()}`);
}

test('mergeKeyOf：source:id 且 id 用 String 归一（number/string 混用同键）', async () => {
  const { mergeKeyOf } = await fresh();
  assert.equal(mergeKeyOf({ source: 'qq', id: 123 }), 'qq:123');
  assert.equal(mergeKeyOf({ source: 'qq', id: '123' }), 'qq:123');
  assert.equal(mergeKeyOf({ source: 'netease', id: null, title: 'Hey Jude', artist: 'The Beatles' }),
    't:hey jude|the beatles');
  assert.equal(mergeKeyOf(null), null);
  assert.equal(mergeKeyOf({}), null);
});

test('mergeKeyOf：兜底键大小写/多余空白归一，标题也缺则无键', async () => {
  const { mergeKeyOf } = await fresh();
  assert.equal(mergeKeyOf({ title: '  NOBODY  ', artist: ' A  B ' }), 't:nobody|a b');
  assert.equal(mergeKeyOf({ title: '   ', artist: 'x' }), null);
  assert.equal(mergeKeyOf({ id: 5 }), null); // 无 source 不成主键，落兜底再落 null（无 title）
});

test('mergeSongLists：目标序保持、新歌按源序追加、dup/added 计数正确', async () => {
  const { mergeSongLists } = await fresh();
  const base = [
    { source: 'netease', id: 1, title: 'A' },
    { source: 'netease', id: 2, title: 'B' },
  ];
  const add = [
    { source: 'netease', id: 2, title: 'B重复' },  // dup（String 归一后同键）
    { source: 'qq', id: '9', title: 'C' },          // new
    { source: 'netease', id: 1, title: 'A重复' },   // dup
    { source: 'qq', id: 10, title: 'D' },           // new
  ];
  const r = mergeSongLists(base, add);
  assert.deepEqual(r.songs.map(s => s.title), ['A', 'B', 'C', 'D']);
  assert.equal(r.added, 2);
  assert.equal(r.dup, 2);
});

test('mergeSongLists：目标自身带重复顺手收敛；无键条目一律放行（宁重不丢）', async () => {
  const { mergeSongLists } = await fresh();
  const r = mergeSongLists(
    [{ source: 'qq', id: 1 }, { source: 'qq', id: '1' }, { noKey: true }],
    [{ source: 'qq', id: 1 }, { stillNoKey: true }]
  );
  assert.equal(r.songs.length, 3); // qq:1 收敛为一个 + 两个无键照收
  assert.equal(r.added, 1);        // added 只计来源侧追加（无键条目也计入）
  assert.equal(r.dup, 1);
});

test('mergeSongLists：输出全浅拷贝不回指原数组；脏输入按空数组容错', async () => {
  const { mergeSongLists } = await fresh();
  const base = [{ source: 'qq', id: 1, title: 'A' }];
  const add = [{ source: 'qq', id: 2, title: 'B' }];
  const r = mergeSongLists(base, add);
  assert.notEqual(r.songs[0], base[0]);
  assert.notEqual(r.songs[1], add[0]);
  assert.deepEqual({ ...base[0] }, r.songs[0]);
  const empty = mergeSongLists(null, undefined);
  assert.deepEqual(empty, { songs: [], added: 0, dup: 0 });
  const nulls = mergeSongLists([null, { source: 'qq', id: 7 }], [undefined, 'str', 42]);
  assert.deepEqual(nulls.songs.map(s => s.id), [7]);
});
