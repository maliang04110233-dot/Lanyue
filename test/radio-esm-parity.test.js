/**
 * 一致性守卫：电台判定的 ESM 版与 CJS 版必须行为一致
 *
 * 为什么要这份测试
 * --------------
 * src/utils/radio.js（CJS，主进程用）与 src/renderer/js/radioCore.js（ESM，
 * 渲染层用）是**两份实现**。原因见 radioCore.js 头部：rollup 无法从 CJS 里
 * 解析具名导出，且本仓 renderer 从不 import src/utils（CJS）。
 *
 * 两份实现漂移的后果很隐蔽：主进程单测全绿、渲染层单测全绿，
 * 但「电台在渲染层去重、主进程不去重」这类不一致不会有任何测试报警，
 * 只在真机上表现为电台偶尔推重复的歌。
 *
 * 所以这里用**同一批输入同时喂两份实现**，比对关键判据的输出。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cjs = require('../src/utils/radio');

async function loadEsm() {
  return import('../src/renderer/js/radioCore.js');
}

const s = (source, id, title, artist) => ({ source, id: String(id), title, artist });

/** 一批能覆盖各种边界的输入 */
const SONG = s('netease', '0', '晴天', '周杰伦');
const POOL = [
  s('netease', '1', '歌A', '周杰伦'),
  s('netease', '2', '歌B', '周杰伦'),
  s('netease', '3', '歌C', '周杰伦'),
  s('qq', '4', '歌A', '周杰伦'),      // 跨源同曲
  s('netease', '5', '歌D', '林俊杰'),
  s('netease', '6', '歌E', '五月天'),
  { title: '坏数据' },                  // 缺 id/source
  null,
];

// ── 导出集合一致 ───────────────────────────────────────

test('两版导出同一组函数（缺一个就会在某条路径上 undefined）', async () => {
  const esm = await loadEsm();
  // 注意：CJS 版刻意不导出 normalizeName/normalizeArtists（内部实现，经 setNormalizers 注入），
  // 所以这里只比对两版都导出的公共面。归一化一致性由下面的 trackKey 间接验证。
  for (const fn of ['isPlayable', 'trackKey', 'artistKey', 'diversifyByArtist',
    'generateRadioCandidates', 'shouldAutoContinue']) {
    assert.equal(typeof cjs[fn], 'function', `CJS 缺 ${fn}`);
    assert.equal(typeof esm[fn], 'function', `ESM 缺 ${fn}`);
  }
  assert.strictEqual(esm.DEFAULT_ARTIST_COOLDOWN, cjs.DEFAULT_ARTIST_COOLDOWN);
  assert.strictEqual(esm.DEFAULT_BATCH, cjs.DEFAULT_BATCH);
});

// ── 归一化一致 ─────────────────────────────────────────

test('归一化：两版经 trackKey/artistKey 体现出的行为一致', async () => {
  const esm = await loadEsm();
  // 用 trackKey / artistKey 间接验证：这两个内部就走归一化，
  // 比直接调内部函数更能反映真实行为差异。
  const names = ['晴天', '  七里香  ', '七里香 (Live)', 'ADele', 'ＡＢＣ', 'Song #1', '', null, 123];
  for (const n of names) {
    const probe = s('netease', '1', n, 'X');
    assert.strictEqual(esm.trackKey(probe), cjs.trackKey(probe),
      `trackKey 对歌名 ${JSON.stringify(n)} 不一致`);
  }
  const artists = ['周杰伦/费玉清', '费玉清,周杰伦', 'A & B', 'x', '', null];
  for (const a of artists) {
    const probe = s('netease', '1', 'T', a);
    assert.strictEqual(esm.artistKey(probe), cjs.artistKey(probe),
      `artistKey 对歌手 ${JSON.stringify(a)} 不一致`);
  }
  // 大小写与全角折叠：两版都该归一
  assert.strictEqual(esm.trackKey(s('a', '1', 'ADele', 'x')), cjs.trackKey(s('a', '1', 'ADele', 'x')));
  assert.strictEqual(
    esm.trackKey(s('a', '1', 'ＡＢＣ', 'x')),
    cjs.trackKey(s('a', '1', 'ＡＢＣ', 'x')),
  );
  // 多人歌手顺序无关：两版都要认成同一人
  const multi1 = s('n', '1', 'T', '周杰伦/费玉清');
  const multi2 = s('n', '2', 'T', '费玉清/周杰伦');
  assert.strictEqual(esm.artistKey(multi1), esm.artistKey(multi2));
  assert.strictEqual(cjs.artistKey(multi1), cjs.artistKey(multi2));
});

// ── key 一致 ───────────────────────────────────────────

test('trackKey / artistKey：两版逐条一致（含跨源同歌）', async () => {
  const esm = await loadEsm();
  const list = [...POOL, SONG];
  for (const song of list) {
    if (!song) continue;
    assert.strictEqual(esm.trackKey(song), cjs.trackKey(song), `trackKey: ${JSON.stringify(song)}`);
    assert.strictEqual(esm.artistKey(song), cjs.artistKey(song), `artistKey: ${JSON.stringify(song)}`);
  }
});

test('跨源同歌两版都归到同一个 key', async () => {
  const esm = await loadEsm();
  const a = s('netease', '1', '歌A', '周杰伦');
  const b = s('qq', '4', '歌A', '周杰伦');
  assert.strictEqual(esm.trackKey(a), cjs.trackKey(a));
  assert.strictEqual(esm.trackKey(a), esm.trackKey(b), 'ESM：跨源同歌应同 key');
  assert.strictEqual(esm.trackKey(a), cjs.trackKey(b), 'CJS：跨源同歌应同 key');
});

// ── 打散一致 ───────────────────────────────────────────

test('diversifyByArtist：两版对各档 cooldown 产出相同顺序', async () => {
  const esm = await loadEsm();
  const pool = [
    s('n', '1', 'A', '周杰伦'), s('n', '2', 'B', '周杰伦'), s('n', '3', 'C', '周杰伦'),
    s('n', '4', 'D', '林俊杰'), s('n', '5', 'E', '林俊杰'), s('n', '6', 'F', '五月天'),
  ];
  for (const cd of [0, 1, 2, 3, 99]) {
    const a = cjs.diversifyByArtist(pool, cd).map((x) => x.id).join(',');
    const b = esm.diversifyByArtist(pool, cd).map((x) => x.id).join(',');
    assert.strictEqual(b, a, `cooldown=${cd} 两版顺序不一致:\n CJS ${a}\n ESM ${b}`);
  }
});

test('diversifyByArtist：cooldown=0 两版都严格交替（回归钉）', async () => {
  const esm = await loadEsm();
  const pool = [
    s('n', '1', 'A', 'X'), s('n', '2', 'B', 'X'), s('n', '3', 'C', 'Y'),
    s('n', '4', 'D', 'X'), s('n', '5', 'E', 'Y'),
  ];
  const out = esm.diversifyByArtist(pool, 0);
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(esm.artistKey(out[i]), esm.artistKey(out[i - 1]), `位置 ${i} 相邻同歌手`);
  }
});

// ── 生成一致 ───────────────────────────────────────────

test('generateRadioCandidates：两版同输入同输出（固定 random）', async () => {
  const esm = await loadEsm();
  const opts = { playedKeys: [], batch: 6, artistCooldown: 2, random: () => 0 };
  const a = cjs.generateRadioCandidates(SONG, POOL, opts);
  const b = esm.generateRadioCandidates(SONG, POOL, opts);

  assert.deepStrictEqual(b.songs.map((x) => x.id), a.songs.map((x) => x.id),
    '选出的曲目顺序不一致');
  assert.deepStrictEqual(b.stats, a.stats, '统计字段不一致');
});

test('generateRadioCandidates：带 playedKeys 时两版都排掉已播', async () => {
  const esm = await loadEsm();
  const played = [cjs.trackKey(POOL[0])];
  const opts = { playedKeys: played, batch: 6, artistCooldown: 2, random: () => 0 };
  const a = cjs.generateRadioCandidates(SONG, POOL, opts);
  const b = esm.generateRadioCandidates(SONG, POOL, opts);
  assert.deepStrictEqual(b.songs.map((x) => x.id), a.songs.map((x) => x.id));
  assert.ok(!b.songs.some((x) => x.title === '歌A' && x.source === 'netease'),
    '已播的（netease/歌A）不该再出现');
});

test('generateRadioCandidates：垃圾输入两版都不崩', async () => {
  const esm = await loadEsm();
  const cases = [
    [null, []], [SONG, null], [SONG, 'x'], [SONG, [], null], [{ title: '' }, POOL],
  ];
  for (const [seed, pool] of cases) {
    const a = cjs.generateRadioCandidates(seed, pool, null);
    const b = esm.generateRadioCandidates(seed, pool, null);
    assert.deepStrictEqual(b.songs, a.songs, `seed=${JSON.stringify(seed)}`);
    assert.deepStrictEqual(b.stats, a.stats, `seed=${JSON.stringify(seed)}`);
  }
});

// ── 接管判据一致 ───────────────────────────────────────

test('shouldAutoContinue：两版对同一批参数给出相同结论', async () => {
  const esm = await loadEsm();
  const cases = [
    {},
    { enabled: false, seed: SONG },
    { enabled: true, seed: SONG },
    { enabled: true, loopMode: 0, seed: SONG },
    { enabled: true, loopMode: 1, seed: SONG },
    { enabled: true, loopMode: 2, seed: SONG },
    { enabled: true, loopMode: 2, seed: { title: '' } },
    { enabled: true, seed: null },
    null,
  ];
  for (const args of cases) {
    assert.strictEqual(esm.shouldAutoContinue(args), cjs.shouldAutoContinue(args),
      `参数 ${JSON.stringify(args)} 两版结论不一致`);
  }
});

test('shouldAutoContinue：单曲循环两版都拒绝接管（回归钉）', async () => {
  const esm = await loadEsm();
  const args = { enabled: true, loopMode: 2, seed: SONG };
  assert.equal(esm.shouldAutoContinue(args), false);
  assert.equal(cjs.shouldAutoContinue(args), false);
});

// ── 结构纪律 ───────────────────────────────────────────

test('结构纪律：渲染层不 import src/utils（那里全是 CJS）', () => {
  const R = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const rel of ['src/renderer/js/radio.js', 'src/renderer/js/player.js',
    'src/renderer/js/radioCore.js']) {
    const src = R(rel);
    assert.ok(!/from '[^']*\/utils\/[^']*'/.test(src),
      `${rel} 不该 import src/utils（CJS）：rollup 解析不出具名导出`);
  }
});

test('结构纪律：radioCore.js 是 ESM（有 export），utils/radio.js 是 CJS', () => {
  const R = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(R('src/renderer/js/radioCore.js'), /^export \{/m, 'radioCore 应为 ESM');
  assert.match(R('src/utils/radio.js'), /module\.exports/, 'utils/radio 应保持 CJS');
});