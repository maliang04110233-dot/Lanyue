/**
 * 单元测试：utils/radio.js —— 电台候选生成（3-A 最小可用版）
 *
 * 最要紧的三条边界：
 *   - **不推已播过的**：跨源同歌也算播过（source+id 不同但歌名歌手相同）；
 *   - **不无限复读同一歌手**：连着 N 首后要打散，且同歌手优先于"随便放"；
 *   - **不该接管时不接管**：单曲循环、开关关闭、种子不可播，都保持原行为。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const radio = require('../src/utils/radio');
const {
  isPlayable,
  trackKey,
  artistKey,
  diversifyByArtist,
  generateRadioCandidates,
  shouldAutoContinue,
  DEFAULT_ARTIST_COOLDOWN,
} = radio;

// 用真实的归一化（与 matchMusic 同口径），否则跨源去重测不到真东西
const { normalizeName, normalizeArtists } = require('../src/utils/matchMusic');
radio.setNormalizers(normalizeName, normalizeArtists);

const s = (source, id, title, artist) => ({ source, id: String(id), title, artist });

/** 取生成结果里的歌名序列，便于断言顺序 */
const titles = (songs) => songs.map((x) => x.title);

/** n 个不同歌手的同名歌（用于构造"必须打散"的池子） */
function multiArtistPool() {
  return [
    s('netease', '1', '歌A', '周杰伦'),
    s('netease', '2', '歌B', '周杰伦'),
    s('netease', '3', '歌C', '周杰伦'),
    s('netease', '4', '歌D', '林俊杰'),
    s('netease', '5', '歌E', '林俊杰'),
    s('netease', '6', '歌F', '五月天'),
  ];
}

// ── 基元 ──────────────────────────────────────────────

test('isPlayable：有歌名 + id + 来源才算可播', () => {
  assert.equal(isPlayable(s('netease', '1', 'A', 'B')), true);
  assert.equal(isPlayable({ source: 'x', id: '1' }), false, '缺歌名');
  assert.equal(isPlayable({ source: 'x', title: 'A' }), false, '缺 id');
  assert.equal(isPlayable({ id: '1', title: 'A' }), false, '缺来源');
  assert.equal(isPlayable(null), false);
});

test('trackKey：跨源同歌得到同一个 key（电台不该重复放）', () => {
  const a = s('netease', '1', '晴天', '周杰伦');
  const b = s('qq', '999', '晴天', '周杰伦');
  assert.equal(trackKey(a), trackKey(b), '不同平台的同一首歌必须同 key');
  assert.notEqual(trackKey(a), trackKey(s('netease', '2', '稻香', '周杰伦')));
});

test('trackKey：归一后一致（大小写/全角差异不影响）', () => {
  assert.equal(trackKey(s('a', '1', 'Adele', 'x')), trackKey(s('b', '2', ' ADELE ', 'X')));
});

test('artistKey：歌手归一（多人歌手顺序无关）', () => {
  assert.equal(artistKey(s('a', '1', 't', '周杰伦/费玉清')), artistKey(s('b', '2', 't', '费玉清/周杰伦')));
});

// ── 打散 ──────────────────────────────────────────────

test('diversifyByArtist：连着 N 首同歌手后必须换人', () => {
  // 6 首周杰伦 + 3 首别人，cooldown=2
  const pool = [
    s('n', '1', 'A', '周杰伦'), s('n', '2', 'B', '周杰伦'), s('n', '3', 'C', '周杰伦'),
    s('n', '4', 'D', '周杰伦'), s('n', '5', 'E', '周杰伦'), s('n', '6', 'F', '周杰伦'),
    s('n', '7', 'G', '林俊杰'), s('n', '8', 'H', '五月天'), s('n', '9', 'I', '蔡依林'),
  ];
  const out = diversifyByArtist(pool, 2);
  // 任何位置往前看 3 首，歌手都不该全同（即连续不超过 2）
  for (let i = 2; i < out.length; i++) {
    const trio = out.slice(i - 2, i + 1).map(artistKey);
    assert.notDeepEqual([...new Set(trio)].length, 1,
      `位置 ${i - 2}..${i} 连续三首同歌手，冷却失效: ${titles(out)}`);
  }
});

test('diversifyByArtist：只有一位歌手时仍全部返回（不直接停播）', () => {
  const pool = [s('n', '1', 'A', '周杰伦'), s('n', '2', 'B', '周杰伦'), s('n', '3', 'C', '周杰伦')];
  const out = diversifyByArtist(pool, 2);
  assert.equal(out.length, 3, '单一歌手时不该丢歌（否则电台听着会突然停）');
});

test('diversifyByArtist：打散不改变元素集合（不增不减不换）', () => {
  const pool = multiArtistPool();
  const out = diversifyByArtist(pool, 1);
  assert.equal(out.length, pool.length);
  assert.deepEqual(titles(out).sort(), titles(pool).sort());
});

test('diversifyByArtist：cooldown=0 时严格交替不同歌手', () => {
  const pool = [
    s('n', '1', 'A', 'X'), s('n', '2', 'B', 'X'), s('n', '3', 'C', 'Y'),
    s('n', '4', 'D', 'X'), s('n', '5', 'E', 'Y'),
  ];
  const out = diversifyByArtist(pool, 0);
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(artistKey(out[i]), artistKey(out[i - 1]), `位置 ${i} 与前一首同歌手`);
  }
});

// ── 生成 ──────────────────────────────────────────────

test('generate：同歌手作品优先（电台的核心行为）', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const pool = [
    s('netease', '1', '歌A', '周杰伦'),
    s('netease', '2', '歌B', '周杰伦'),
    s('netease', '3', '歌C', '林俊杰'),
  ];
  const r = generateRadioCandidates(seed, pool, { batch: 3, artistCooldown: 5, random: () => 0 });
  // 打散会在冷却允许时把同歌手岔开，因此不能断言严格顺序；
  // 真正的性质是：同歌手的都在，且整体排在其他歌手之前。
  assert.deepEqual(titles(r.songs).sort(), ['歌A', '歌B', '歌C']);
  const others = r.songs.map((x) => artistKey(x)).filter((k) => k !== artistKey(seed));
  const idxLastSame = r.songs.map((x) => artistKey(x)).lastIndexOf(artistKey(seed));
  const idxFirstOther = r.songs.map((x) => artistKey(x)).findIndex((k) => k !== artistKey(seed));
  assert.ok(idxLastSame < idxFirstOther,
    `同歌手的应整体靠前: ${titles(r.songs)}（others=${others.length}）`);
});

test('generate：同歌手不足时用其他歌手补满批次', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const pool = [s('netease', '1', '歌A', '周杰伦'), s('netease', '2', '歌C', '林俊杰')];
  const r = generateRadioCandidates(seed, pool, { batch: 5, artistCooldown: 5, random: () => 0 });
  assert.equal(r.songs.length, 2, '池子只有 2 首就该只给 2 首');
});

test('generate：不推种子自己', () => {
  const seed = s('netease', '0', '晴天', '周杰伦');
  const pool = [s('qq', '77', '晴天', '周杰伦'), s('netease', '1', '稻香', '周杰伦')];
  const r = generateRadioCandidates(seed, pool, { batch: 5, artistCooldown: 5, random: () => 0 });
  assert.ok(!titles(r.songs).includes('晴天'), '刚播完的那首不该立刻再来一遍');
});

test('generate：已播过的（含跨源同曲）不再出现', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const pool = [
    s('netease', '1', '已播A', '周杰伦'),
    s('qq', '88', '已播A', '周杰伦'), // 跨源同歌
    s('netease', '2', '新的B', '周杰伦'),
  ];
  const played = new Set([trackKey(s('netease', '1', '已播A', '周杰伦'))]);
  const r = generateRadioCandidates(seed, pool, { playedKeys: played, batch: 5, artistCooldown: 5, random: () => 0 });
  assert.ok(!titles(r.songs).includes('已播A'), '已播过的（含跨源同曲）不该再推');
  assert.ok(titles(r.songs).includes('新的B'));
});

test('generate：统计字段可用于诊断', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const pool = [s('netease', '1', 'A', '周杰伦'), { title: '坏数据' }];
  const r = generateRadioCandidates(seed, pool, { batch: 5, random: () => 0 });
  assert.equal(r.stats.pool, 2);
  assert.equal(r.stats.usable, 1, '坏数据应被滤掉');
  assert.equal(r.stats.afterPlayed, 1);
});

test('generate：垃圾输入不崩（seed 不可播 / pool 非数组 / opts 缺失）', () => {
  for (const args of [
    [null, []], [s('n', '1', 'A', 'B'), null], [s('n', '1', 'A', 'B'), 'not-array'],
    [s('n', '1', 'A', 'B'), [], null], [{ title: '' }, []],
  ]) {
    const r = generateRadioCandidates(args[0], args[1], args[2]);
    assert.ok(Array.isArray(r.songs), `应返回数组: ${JSON.stringify(args)}`);
  }
});

test('generate：种子不可播 ⇒ 空结果（上层据此不切电台）', () => {
  const r = generateRadioCandidates({ title: '' }, [s('n', '1', 'A', 'B')]);
  assert.equal(r.songs.length, 0);
});

test('generate：batch 生效', () => {
  const seed = s('netease', '0', '种子', 'X');
  const pool = [];
  for (let i = 1; i <= 20; i++) pool.push(s('netease', String(i), '歌' + i, '歌手' + i));
  const r = generateRadioCandidates(seed, pool, { batch: 4, artistCooldown: 0, random: () => 0 });
  assert.equal(r.songs.length, 4);
});

test('generate：注入 random 后结果确定（同分不抖动）', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const pool = multiArtistPool();
  const opts = { batch: 6, artistCooldown: 2, random: () => 0 };
  const a = generateRadioCandidates(seed, pool, opts).songs;
  const b = generateRadioCandidates(seed, pool, opts).songs;
  assert.deepEqual(titles(a), titles(b), '同种子同输入应完全可复现（便于回归定位）');
});

test('generate：结果里的歌都可用（下游可直接播放）', () => {
  const seed = s('netease', '0', '种子', '周杰伦');
  const r = generateRadioCandidates(seed, multiArtistPool(), { batch: 5, random: () => 0 });
  for (const song of r.songs) {
    assert.ok(isPlayable(song), `生成了不可播的曲目: ${JSON.stringify(song)}`);
    assert.notEqual(song.title, '种子');
  }
});

// ── 是否接管 ──────────────────────────────────────────

test('shouldAutoContinue：开关关 / 单曲循环 / 种子不可播 ⇒ 都不接管', () => {
  const seed = s('netease', '0', 'A', 'B');
  assert.equal(shouldAutoContinue({ enabled: false, seed }), false, '开关关闭不该接管');
  assert.equal(shouldAutoContinue({ enabled: true, loopMode: 2, seed }), false, '单曲循环不该插队');
  assert.equal(shouldAutoContinue({ enabled: true, seed: { title: '' } }), false, '种子不可播不该接管');
  assert.equal(shouldAutoContinue({}), false, '缺参数不该接管');
});

test('shouldAutoContinue：正常情况接管', () => {
  assert.equal(shouldAutoContinue({ enabled: true, loopMode: 1, seed: s('netease', '0', 'A', 'B') }), true);
  assert.equal(shouldAutoContinue({ enabled: true, loopMode: 0, seed: s('netease', '0', 'A', 'B') }), true);
});

test('默认冷却值是 3（连着三首就换人）', () => {
  assert.strictEqual(DEFAULT_ARTIST_COOLDOWN, 3);
});

// ── 生产接线：归一化必须与 matchMusic 同口径 ───────────

test('生产接线：默认归一化必须走 matchMusic，否则跨源去重失效', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/radio.js'), 'utf8');
  assert.match(src, /require\('\.\/matchMusic'\)/, '应复用 matchMusic 的归一化');
  // 实现形态：模块顶层解构出 normalizeName/normalizeArtists 并直接赋给
  // 内部变量（保证 require 后立即生效，不必等调用方再注入一次）。
  assert.match(src, /const \{ normalizeName:\s*_mn,\s*normalizeArtists:\s*_ma \} = require\('\.\/matchMusic'\)/,
    '应在模块顶层从 matchMusic 取真实归一化');
  assert.match(src, /let normalizeName = _mn;/, '内部归一化应指向 matchMusic 的实现');
});