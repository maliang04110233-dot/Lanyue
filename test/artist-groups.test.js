/**
 * 本地曲库歌手分组纯函数测试（增量68）
 * artistGroups.js DOM 接线段有 typeof document 守卫，node 下仅导出纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/artistGroups.js?ck=${Math.random()}`);

test('groupArtists 聚合计数与体积，空/脏输入安全', async () => {
  const { groupArtists } = await mod();
  const r = groupArtists([
    { artist: '张三', fileSize: 1000 },
    { artist: '张三', fileSize: '2000' },
    { artist: ' 李四 ', fileSize: 500 },
    { artist: '', fileSize: NaN },
    null,
    undefined,
  ]);
  assert.deepEqual(r, [
    { artist: '张三', count: 2, size: 3000 },
    { artist: '李四', count: 1, size: 500 },
    { artist: '未知歌手', count: 1, size: 0 },
  ]);
  assert.deepEqual(groupArtists(null), []);
  assert.deepEqual(groupArtists([]), []);
});

test('groupArtists 数量降序，同数按歌手 zh 拼音序', async () => {
  const { groupArtists } = await mod();
  const mk = (a, n) => Array.from({ length: n }, () => ({ artist: a }));
  const r = groupArtists([...mk('王五', 1), ...mk('李四', 3), ...mk('张三', 1)]);
  assert.deepEqual(r.map((g) => g.artist), ['李四', '王五', '张三']); // 1首组：王(wang)<张(zhang)
});

test('groupBarPct 非零保底 8%，零/坏值返回 0', async () => {
  const { groupBarPct } = await mod();
  assert.equal(groupBarPct(10, 10), 100);
  assert.equal(groupBarPct(1, 100), 8);
  assert.equal(groupBarPct(5, 10), 50);
  assert.equal(groupBarPct(0, 10), 0);
  assert.equal(groupBarPct(3, 0), 0);
  assert.equal(groupBarPct(3, null), 0);
});

test('UNKNOWN_ARTIST 常量导出', async () => {
  const { UNKNOWN_ARTIST } = await mod();
  assert.equal(UNKNOWN_ARTIST, '未知歌手');
});

test('groupAlbums 按专辑聚合并保留 album 字段', async () => {
  const { groupAlbums } = await mod();
  const r = groupAlbums([
    { album: ' 范特西 ', fileSize: 10 },
    { album: '范特西', fileSize: '20' },
    { album: '', fileSize: 5 },
    null,
    { fileSize: 1 },
  ]);
  assert.deepEqual(r, [
    { album: '范特西', count: 2, size: 30 },
    { album: '未知专辑', count: 2, size: 6 },
  ]);
  assert.deepEqual(groupAlbums(null), []);
  assert.deepEqual(groupAlbums('x'), []);
});

test('groupAlbums 数量降序，同数按专辑 zh 拼音序（实测 白<红<蓝）', async () => {
  const { groupAlbums } = await mod();
  const r = groupAlbums([
    { album: '蓝' }, { album: '蓝' },
    { album: '白' }, { album: '白' },
    { album: '红' }, { album: '红' },
  ]);
  assert.deepEqual(r.map((g) => g.album), ['白', '红', '蓝']);
});

test('未知专辑桶：trim 后空串与缺失合并', async () => {
  const { groupAlbums, UNKNOWN_ALBUM } = await mod();
  assert.equal(UNKNOWN_ALBUM, '未知专辑');
  const r = groupAlbums([{ album: '   ' }, { album: undefined }, { album: 'X' }]);
  const unk = r.find((g) => g.album === UNKNOWN_ALBUM);
  assert.equal(unk.count, 2);
});

test('normalizeGroupKey：trim、空值归未知桶', async () => {
  const { normalizeGroupKey } = await mod();
  assert.equal(normalizeGroupKey(' 周杰伦 ', '未知歌手'), '周杰伦');
  assert.equal(normalizeGroupKey('', '未知歌手'), '未知歌手');
  assert.equal(normalizeGroupKey(null, '未知专辑'), '未知专辑');
  assert.equal(normalizeGroupKey(undefined, 'U'), 'U');
});

test('sanitizeFileBase：非法字符替换、结尾点/空格剥离、空串兜底、限长', async () => {
  const { sanitizeFileBase } = await mod();
  assert.equal(sanitizeFileBase('周杰伦: 范特西'), '周杰伦_ 范特西');
  assert.equal(sanitizeFileBase('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFileBase('abc...  '), 'abc');
  assert.equal(sanitizeFileBase('   '), 'playlist');
  assert.equal(sanitizeFileBase(null), 'playlist');
  assert.equal(sanitizeFileBase('x'.repeat(200)).length, 80);
});

test('sanitizeFileBase 保留中文/数字/连字符（常见专辑名无需替换）', async () => {
  const { sanitizeFileBase } = await mod();
  assert.equal(sanitizeFileBase('七里香-2004'), '七里香-2004');
});

test('groupSongsForAlbumWall 按专辑聚合，取第一张非空封面，歌手去重拼接', async () => {
  const { groupSongsForAlbumWall } = await mod();
  const r = groupSongsForAlbumWall([
    { album: ' 范特西 ', artist: '周杰伦', cover: null },
    { album: '范特西', artist: '周杰伦', cover: 'data:image/jpeg;base64,AAA' },
    { album: '范特西', artist: '温岚', cover: 'data:image/jpeg;base64,BBB' },
    { album: '', artist: '', cover: 'data:image/jpeg;base64,CCC' },
    null,
    undefined,
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    album: '范特西',
    count: 3,
    artists: '周杰伦 / 温岚',
    cover: 'data:image/jpeg;base64,AAA',
  });
  assert.deepEqual(r[1], {
    album: '未知专辑',
    count: 1,
    artists: '未知歌手',
    cover: 'data:image/jpeg;base64,CCC',
  });
  assert.deepEqual(groupSongsForAlbumWall(null), []);
  assert.deepEqual(groupSongsForAlbumWall([]), []);
  assert.deepEqual(groupSongsForAlbumWall('x'), []);
});

test('groupSongsForAlbumWall 数量降序，同数按专辑 zh 拼音序，全无封面 cover 为 null', async () => {
  const { groupSongsForAlbumWall } = await mod();
  const r = groupSongsForAlbumWall([
    { album: '蓝' }, { album: '蓝' },
    { album: '白' }, { album: '白' },
    { album: '红' }, { album: '红' },
    { album: '无封面', cover: undefined },
  ]);
  assert.deepEqual(r.map(g => g.album), ['白', '红', '蓝', '无封面']);
  assert.equal(r[0].cover, null);
  assert.equal(r[0].count, 2);
});
