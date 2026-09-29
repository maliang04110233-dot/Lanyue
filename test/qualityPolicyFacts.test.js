/**
 * 单元测试：main/qualityPolicyFacts.js —— already_have 规则的事实来源
 *
 * 语义边界：
 *   - 没扫过 / 索引读失败 ⇒ scanned=false + 空集合（不是抛错）——
 *     缺判据时规则应当"不命中"，绝不能反过来误杀用户的下载；
 *   - 目录变了 ⇒ 旧索引的歌手/专辑对新目录无意义，同样降级；
 *   - 多人歌手（"A / B"）必须拆开逐个登记，否则合著曲目对不上；
 *   - 归一口径与 qualityPolicy._normNames 一致（大小写/空白）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const libraryIndex = require('../src/utils/libraryIndex');
const { loadLocalFacts, getPolicyFactsForQueue, splitArtists } = require('../src/main/qualityPolicyFacts');

/** 每个用例一份独立 userData，避免互相污染 */
function withIndex(seed, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpfacts-'));
  const prev = libraryIndex.loadIndex;
  libraryIndex.init(dir);
  if (seed) {
    fs.writeFileSync(path.join(dir, 'library-index.json'),
      JSON.stringify({ dirPath: seed.dirPath || '', songs: seed.songs, lastScan: 1 }), 'utf8');
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      libraryIndex.init(null);
      libraryIndex.loadIndex = prev;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
}

// ── 歌手拆分 ───────────────────────────────────────────

test('splitArtists：拆开多人歌手（合著曲目要能逐个命中）', () => {
  assert.deepEqual([...splitArtists('周杰伦 / 费玉清')].sort(), ['周杰伦', '费玉清']);
  assert.deepEqual([...splitArtists('A、B')].sort(), ['a', 'b']);
  assert.deepEqual([...splitArtists('Adele & Jay-Z')].sort(), ['adele', 'jay-z']);
});

test('splitArtists：空/垃圾输入 ⇒ 空数组', () => {
  for (const v of ['', null, undefined, 0, {}]) {
    assert.deepEqual([...splitArtists(v)], [], `应为空: ${JSON.stringify(v)}`);
  }
});

// ── 无索引：降级而不是抛错 ────────────────────────────

test('没扫过本地曲库（无索引文件）⇒ 空集合 + scanned=false，不抛错', async () => {
  await withIndex(null, async () => {
    const f = await loadLocalFacts();
    assert.equal(f.scanned, false, '没有索引时不应声称扫过');
    assert.equal(f.haveArtist.size, 0);
    assert.equal(f.haveAlbum.size, 0);
  });
});

test('索引里 songs 为空 ⇒ scanned=false（空曲库不是错误）', async () => {
  await withIndex({ dirPath: '/m', songs: [] }, async () => {
    const f = await loadLocalFacts();
    assert.equal(f.scanned, false);
    assert.equal(f.haveArtist.size, 0);
  });
});

test('索引文件损坏 ⇒ 降级为空集合，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpfacts-bad-'));
  libraryIndex.init(dir);
  try {
    fs.writeFileSync(path.join(dir, 'library-index.json'), '{ this is not json', 'utf8');
    const f = await loadLocalFacts();
    assert.equal(f.scanned, false, '坏索引必须降级');
    assert.equal(f.haveArtist.size, 0);
  } finally {
    libraryIndex.init(null);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── 有索引：正常抽取 ───────────────────────────────────

test('有索引 ⇒ 抽出歌手与专辑集合（归一：小写去空白）', async () => {
  await withIndex({
    dirPath: '/music',
    songs: [
      { artist: '周杰伦', album: '叶惠美' },
      { artist: ' ADELE ', album: ' 21 ' },
      { artist: '周杰伦 / 费玉清', album: '不能说的秘密' },
    ],
  }, async () => {
    const f = await loadLocalFacts();
    assert.equal(f.scanned, true);
    assert.ok(f.haveArtist.has('周杰伦'));
    assert.ok(f.haveArtist.has('adele'), '应归一成小写');
    assert.ok(f.haveArtist.has('费玉清'), '多人歌手应拆开登记');
    assert.ok(f.haveAlbum.has('叶惠美'));
    assert.ok(f.haveAlbum.has('21'));
  });
});

test('索引条目缺 artist/album 字段 ⇒ 跳过而非崩', async () => {
  await withIndex({
    dirPath: '/music',
    songs: [null, {}, { artist: '', album: '' }, { artist: '周杰伦' }],
  }, async () => {
    const f = await loadLocalFacts();
    assert.equal(f.scanned, true);
    assert.deepEqual([...f.haveArtist], ['周杰伦']);
    assert.equal(f.haveAlbum.size, 0, '空专辑不该进集合（否则空串会误命中一切）');
  });
});

// ── 目录变更 ⇒ 旧索引失效 ─────────────────────────────

test('目录与索引记录不一致 ⇒ 降级（别拿 A 目录的歌手去卡 B 目录）', async () => {
  await withIndex({ dirPath: '/old', songs: [{ artist: '周杰伦', album: '叶惠美' }] }, async () => {
    const f = await loadLocalFacts({ dirPath: '/new' });
    assert.equal(f.scanned, false, '目录变了就应视为无判据');
    assert.equal(f.haveArtist.size, 0);
  });
});

test('目录一致 ⇒ 索引照常生效', async () => {
  await withIndex({ dirPath: '/music', songs: [{ artist: '周杰伦' }] }, async () => {
    const f = await loadLocalFacts({ dirPath: '/music' });
    assert.equal(f.scanned, true);
    assert.ok(f.haveArtist.has('周杰伦'));
  });
});

test('未传 dirPath 时用索引自身记录的目录（不误判为失效）', async () => {
  await withIndex({ dirPath: '/music', songs: [{ artist: '周杰伦' }] }, async () => {
    const f = await loadLocalFacts();
    assert.equal(f.scanned, true);
  });
});

// ── 与求值器的接口形状 ─────────────────────────────────

test('getPolicyFactsForQueue：返回求值器要的 ctx 形状（Set 而非数组）', async () => {
  await withIndex({ dirPath: '/m', songs: [{ artist: '周杰伦', album: '叶惠美' }] }, async () => {
    const ctx = await getPolicyFactsForQueue();
    assert.ok(ctx.haveArtist instanceof Set, '求值器按 Set 归一，形状要对得上');
    assert.ok(ctx.haveAlbum instanceof Set);
    assert.ok(ctx.haveArtist.has('周杰伦'));
  });
});

test('端到端：facts 喂给求值器后 already_have 真的会跳过', async () => {
  await withIndex({ dirPath: '/m', songs: [{ artist: '周杰伦', album: '叶惠美' }] }, async () => {
    const { evaluateQualityPolicy } = require('../src/utils/qualityPolicy');
    const rules = [{ id: 'already_have', params: { scope: 'artist' } }];
    const ctx = await getPolicyFactsForQueue();
    const hit = evaluateQualityPolicy(rules, { title: '晴天', artist: '周杰伦', quality: 'hq' }, ctx);
    assert.equal(hit.action, 'skip', '本地已有该歌手 ⇒ 应跳过');
    const miss = evaluateQualityPolicy(rules, { title: '稻香', artist: '林俊杰', quality: 'hq' }, ctx);
    assert.equal(miss.action, 'keep', '没有的歌手 ⇒ 不该跳过');
  });
});

// ── 生产接线守卫 ───────────────────────────────────────

test('生产接线：main/index.js 把 getPolicyFacts 注入了引擎（漏注入 = 规则空转）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  assert.match(src, /getPolicyFactsForQueue/, 'index.js 未 require 事实源');
  assert.match(src, /getPolicyFacts:\s*getPolicyFactsForQueue/, '未注入 downloadQueue 工厂');
});

test('生产接线：downloadQueue 确实消费了注入的事实源', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/downloadQueue.js'), 'utf8');
  assert.match(src, /getPolicyFacts/, 'downloadQueue 未声明 getPolicyFacts 形参');
  assert.match(src, /await getPolicyFacts\(song\)/, '未调用事实源');
});
