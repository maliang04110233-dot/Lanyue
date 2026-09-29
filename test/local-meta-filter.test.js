/**
 * 本地曲库「元数据完整度」视图过滤 —— localMetaFilter 纯函数 + 接线钉
 *
 * 附一条**过滤器接线回归钉**：所有本地库过滤轴（收藏/格式/音质/完整度/排序）
 * 的循环函数都必须重跑 filterLocalSongs()。37187d2 的 cycleLocalQual 写成了
 * renderLocalSongs()（只重画旧数组），按钮换态不生效且旧测试把这个错钉成了
 * 「期望」—— 本钉按函数体逐个校验，专治这一类。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const LOCAL_JS = read('src/renderer/js/views/local.js');
const FILT_JS = read('src/renderer/js/localMetaFilter.js');
const HTML = read('src/renderer/index.html');
const PALETTE = read('src/renderer/js/commandPalette.js');

function fresh() {
  return import('../src/renderer/js/localMetaFilter.js?MF=' + Math.random());
}

/** 按大括号配平取出函数体（含首尾花括号），避免被前后注释/同名引用绊倒 */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}()`);
  assert.ok(start >= 0, `未找到函数 ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

const FULL = { filePath: '/m/full.mp3', title: 'T', artist: 'A', album: 'Al', cover: 'data:image/png;base64,xx', embeddedLyrics: '[00:01]hi' };
const NO_COVER = { filePath: '/m/nc.mp3', title: 'T', artist: 'A', album: 'Al', cover: null, embeddedLyrics: '[00:01]hi' };
const NO_ALBUM = { filePath: '/m/na.mp3', title: 'T', artist: 'A', album: '', cover: 'x', embeddedLyrics: 'lrc' };
const NO_ARTIST = { filePath: '/m/nar.mp3', title: '', artist: '', album: 'Al', cover: 'x', embeddedLyrics: 'lrc' };
const NO_LYRIC = { filePath: '/m/nl.mp3', title: 'T', artist: 'A', album: 'Al', cover: 'x', embeddedLyrics: '' };
const BLANK_LYRIC = { filePath: '/m/bl.mp3', title: 'T', artist: 'A', album: 'Al', cover: 'x', embeddedLyrics: '   ' };

const LIST = [FULL, NO_COVER, NO_ALBUM, NO_ARTIST, NO_LYRIC];

test('模式循环：all→no-cover→no-album→no-artist→no-lyric→all，脏值回 all', async () => {
  const { nextMetaMode, META_MODES } = await fresh();
  assert.deepEqual(META_MODES, ['all', 'no-cover', 'no-album', 'no-artist', 'no-lyric']);
  let m = 'all';
  const seen = [];
  for (let i = 0; i < 6; i++) { m = nextMetaMode(m); seen.push(m); }
  assert.deepEqual(seen, ['no-cover', 'no-album', 'no-artist', 'no-lyric', 'all', 'no-cover']);
  assert.equal(nextMetaMode('garbage'), 'all');
  assert.equal(nextMetaMode(undefined), 'all');
});

test('封面轴 / 专辑轴：只挑对应字段缺失的行，顺序按曲库原序', async () => {
  const { filterByMeta } = await fresh();
  assert.deepEqual(filterByMeta(LIST, 'no-cover').map(x => x.filePath), ['/m/nc.mp3']);
  assert.deepEqual(filterByMeta(LIST, 'no-album').map(x => x.filePath), ['/m/na.mp3']);
});

test('歌手/标题轴：任一为空即入选（两者都缺也算一次）', async () => {
  const { filterByMeta } = await fresh();
  assert.deepEqual(filterByMeta(LIST, 'no-artist').map(x => x.filePath), ['/m/nar.mp3']);
  assert.deepEqual(
    filterByMeta([{ filePath: '/a', title: 'T', artist: '' }, { filePath: '/b', title: '', artist: 'A' }], 'no-artist')
      .map(x => x.filePath),
    ['/a', '/b'],
  );
});

test('歌词轴：只看内嵌（embeddedLyrics），空白串等同缺失', async () => {
  const { filterByMeta, hasText } = await fresh();
  assert.deepEqual(filterByMeta(LIST, 'no-lyric').map(x => x.filePath), ['/m/nl.mp3']);
  assert.deepEqual(filterByMeta([BLANK_LYRIC], 'no-lyric').map(x => x.filePath), ['/m/bl.mp3'],
    '纯空白不算有歌词');
  assert.equal(hasText('  '), false);
  assert.equal(hasText(undefined), false);
  assert.equal(hasText('x'), true);
});

test('all / 未知模式原样浅拷贝；脏输入不炸', async () => {
  const { filterByMeta, matchMetaMode } = await fresh();
  assert.deepEqual(filterByMeta(LIST, 'all'), LIST.slice());
  assert.deepEqual(filterByMeta(LIST, 'weird'), LIST.slice(), '未知 mode 等价 all，不误伤');
  assert.equal(matchMetaMode(FULL, null), true);
  assert.deepEqual(filterByMeta(null, 'no-cover'), []);
  assert.deepEqual(filterByMeta([null, NO_COVER], 'no-cover').map(x => x.filePath), ['/m/nc.mp3']);
});

test('文案：每个 mode 一句话，未知 mode 回落全部（按钮文字来自函数，不散落字面量）', async () => {
  const { metaModeLabel, META_MODES } = await fresh();
  assert.equal(metaModeLabel('all'), '🏷 完整度');
  assert.equal(metaModeLabel('no-lyric'), '🏷 缺内嵌歌词');
  assert.equal(metaModeLabel('weird'), '🏷 完整度');
  for (const m of META_MODES) assert.ok(metaModeLabel(m).startsWith('🏷 '), m);
});

test('接线钉：local.js 管线 + 循环函数 + window 桥 + HTML 按钮 + 面板项，纯函数模块零 DOM', () => {
  assert.ok(LOCAL_JS.includes("import { metaModeLabel, nextMetaMode, filterByMeta } from '../localMetaFilter.js';"));
  assert.ok(LOCAL_JS.includes("  if (_localMetaMode !== 'all') songs = filterByMeta(songs, _localMetaMode);"));
  assert.ok(LOCAL_JS.includes([
    'function cycleLocalMeta() {',
    '  _localMetaMode = nextMetaMode(_localMetaMode);',
    "  _syncFilterBtn('localMetaBtn', metaModeLabel(_localMetaMode), _localMetaMode !== 'all');",
    '  filterLocalSongs();',
    '}',
  ].join('\n')), '循环函数：换态 → 刷按钮字样+高亮 → 重过筛');
  assert.ok(LOCAL_JS.indexOf("if (_localQualMode !== ") < LOCAL_JS.indexOf("if (_localMetaMode !== "),
    '音质轴先于完整度轴（完整度按已过滤的视图再切，与其余轴同为 AND 叠加）');
  assert.equal((LOCAL_JS.match(/window\.cycleLocalMeta = cycleLocalMeta;/g) || []).length, 1);
  assert.ok(HTML.includes('id="localMetaBtn" onclick="cycleLocalMeta()"'));
  assert.ok(PALETTE.includes("id: 'loc-meta'") && PALETTE.includes("_call('cycleLocalMeta')"));
  assert.ok(!FILT_JS.includes('document') && !FILT_JS.includes('innerHTML'));
});

test('回归钉：每条本地库过滤轴的循环函数都必须重跑 filterLocalSongs（漏调致按钮失效）', () => {
  const axes = ['toggleLocalFavOnly', 'cycleLocalFmt', 'cycleLocalQual', 'cycleLocalSort', 'cycleLocalMeta'];
  for (const fn of axes) {
    const body = fnBody(LOCAL_JS, fn);
    assert.ok(body.includes('filterLocalSongs()'),
      `${fn} 换态后必须重过筛：只调 renderLocalSongs() 会重画旧 localFiltered，按钮点了没反应`);
  }
});
