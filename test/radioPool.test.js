/**
 * 单元测试：main/radioPool.js —— 电台取数（3-A）
 *
 * 最要紧的边界：
 *   - 拿不到歌手名就**不猜**：宁可停下也不放一堆不相干的歌；
 *   - 搜索失败降级为空 + 明确 reason，绝不抛给上层；
 *   - 关键词是「歌手 + 歌名」而非只歌手名（否则被同名歌手/翻唱淹没）；
 *   - limit 有上限，防止一次拉爆。
 */

const test = require('node:test');
const assert = require('node:assert');

const { fetchRadioPool, cleanArtistName, DEFAULT_RADIO_POOL } = require('../src/main/radioPool');

const song = (source, id, title, artist, duration) => ({
  source, id: String(id), title, artist, duration,
});

/** 记录搜索入参的假 searchMusic */
function spySearch(result) {
  const calls = [];
  const fn = async (kw, src) => { calls.push({ kw, src }); return result; };
  fn.calls = calls;
  return fn;
}

// ── 歌手名清洗 ─────────────────────────────────────────

test('cleanArtistName：去掉 feat./ft./斜杠后的第一位歌手', () => {
  assert.equal(cleanArtistName('周杰伦'), '周杰伦');
  assert.equal(cleanArtistName('A feat. B'), 'A');
  assert.equal(cleanArtistName('A ft. B'), 'A');
  assert.equal(cleanArtistName('A / B'), 'A');
  assert.equal(cleanArtistName('  A  '), 'A');
  assert.equal(cleanArtistName(''), '');
  assert.equal(cleanArtistName(null), '');
});

// ── 拿不到歌手名就不猜 ─────────────────────────────────

test('无歌手名 ⇒ 立即返回空 + no-artist，且不发任何搜索请求', async () => {
  const s = spySearch({ songs: [song('netease', '1', 'A', 'X', 1000)] });
  const r = await fetchRadioPool({ title: '歌', artist: '' }, {}, { searchMusic: s });
  assert.equal(r.reason, 'no-artist');
  assert.equal(r.songs.length, 0);
  assert.equal(s.calls.length, 0, '没有歌手名就不该打网络');
});

test('seed 为 null / undefined ⇒ 同样不炸、不发请求', async () => {
  const s = spySearch({ songs: [song('n', '1', 'A', 'X', 1)] });
  for (const seed of [null, undefined, {}]) {
    const r = await fetchRadioPool(seed, {}, { searchMusic: s });
    assert.equal(r.reason, 'no-artist', `seed=${JSON.stringify(seed)}`);
  }
  assert.equal(s.calls.length, 0);
});

// ── 正常取数 ───────────────────────────────────────────

test('正常路径：返回歌曲 + ok，并带上清洗后的歌手名', async () => {
  const s = spySearch({ songs: [song('netease', '1', '歌A', '周杰伦', 1000)] });
  const r = await fetchRadioPool({ title: '晴天', artist: '周杰伦' }, {}, { searchMusic: s });
  assert.equal(r.reason, 'ok');
  assert.equal(r.artist, '周杰伦');
  assert.equal(r.songs.length, 1);
});

test('关键词是「歌手 + 歌名」，不是只歌手名', async () => {
  const s = spySearch({ songs: [] });
  await fetchRadioPool({ title: '晴天', artist: '周杰伦' }, {}, { searchMusic: s });
  assert.equal(s.calls[0].kw, '周杰伦 晴天', '只搜歌手名会被同名歌手与翻唱淹没');
});

test('没有歌名时只用歌手名（不强拼出尾随空格）', async () => {
  const s = spySearch({ songs: [] });
  await fetchRadioPool({ artist: '周杰伦' }, {}, { searchMusic: s });
  assert.equal(s.calls[0].kw, '周杰伦');
});

test('默认跨源聚合（source 不给时传 all）', async () => {
  const s = spySearch({ songs: [] });
  await fetchRadioPool({ title: 'A', artist: 'B' }, {}, { searchMusic: s });
  assert.equal(s.calls[0].src, 'all');
});

test('指定 source 时只搜该平台', async () => {
  const s = spySearch({ songs: [] });
  await fetchRadioPool({ title: 'A', artist: 'B' }, { source: 'kugou' }, { searchMusic: s });
  assert.equal(s.calls[0].src, 'kugou');
});

// ── 降级 ───────────────────────────────────────────────

test('搜索抛错 ⇒ 降级为空 + search-failed，不向上抛', async () => {
  const boom = async () => { throw new Error('网络炸了'); };
  const r = await fetchRadioPool({ title: 'A', artist: 'B' }, {}, { searchMusic: boom });
  assert.equal(r.reason, 'search-failed');
  assert.equal(r.songs.length, 0);
  assert.equal(r.artist, 'B', '歌手名仍要带回，便于诊断');
});

test('搜索返回垃圾（null / 非对象 / songs 非数组）⇒ empty，不炸', async () => {
  for (const bad of [null, undefined, {}, { songs: null }, { songs: 'x' }, 42]) {
    const s = spySearch(bad);
    const r = await fetchRadioPool({ title: 'A', artist: 'B' }, {}, { searchMusic: s });
    assert.equal(r.reason, 'empty', `返回 ${JSON.stringify(bad)} 应为 empty`);
    assert.deepEqual(r.songs, []);
  }
});

// ── limit ─────────────────────────────────────────────

test('limit 生效，且有上限（防一次拉爆）', async () => {
  const many = [];
  for (let i = 0; i < 200; i++) many.push(song('n', String(i), '歌' + i, 'B', 1000));

  const s1 = spySearch({ songs: many });
  const r1 = await fetchRadioPool({ title: 'A', artist: 'B' }, { limit: 5 }, { searchMusic: s1 });
  assert.equal(r1.songs.length, 5);

  const s2 = spySearch({ songs: many });
  const r2 = await fetchRadioPool({ title: 'A', artist: 'B' }, { limit: 9999 }, { searchMusic: s2 });
  assert.equal(r2.songs.length, 100, '应被截到 100');

  const s3 = spySearch({ songs: many });
  const r3 = await fetchRadioPool({ title: 'A', artist: 'B' }, {}, { searchMusic: s3 });
  assert.equal(r3.songs.length, DEFAULT_RADIO_POOL, '默认取默认批量');
});

test('limit 垃圾值（0/负/NaN/字符串）⇒ 退回默认，不取 0 条', async () => {
  const one = [song('n', '1', '歌', 'B', 1000)];
  for (const limit of [0, -1, NaN, 'abc', null]) {
    const s = spySearch({ songs: one });
    const r = await fetchRadioPool({ title: 'A', artist: 'B' }, { limit }, { searchMusic: s });
    assert.equal(r.songs.length, 1, `limit=${limit} 应退回默认批量`);
  }
});

// ── opts / deps 的垃圾值 ───────────────────────────────

test('opts / deps 传 null 或垃圾值不炸', async () => {
  const seed = { title: 'A', artist: 'B' };
  for (const [o, d] of [[null, null], [undefined, undefined], ['x', 'y'], [42, 42]]) {
    const r = await fetchRadioPool(seed, o, d);
    assert.ok(Array.isArray(r.songs), `opts=${JSON.stringify(o)} 应返回数组`);
  }
});
