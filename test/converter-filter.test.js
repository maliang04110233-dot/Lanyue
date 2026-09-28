/**
 * converterFilter 纯函数单测 + 转换页过滤管线回归钉
 *
 * 背景：views/converter.js 里三条「换库」路径
 * （scanLocalForConvert / loadLocalSongsForConvert 的两条分支）原先只调
 * renderConverterSongs()，而它读的是 state.convFiltered —— 于是新库配上一轮的
 * 过滤结果，列表、计数、全选三处一起陈旧；最典型的是首屏扫描还没回来时用户
 * 先敲了关键词，convFiltered 基于空库生成，扫描回来后列表依旧空白。
 *
 * 修法：过滤逻辑抽成本模块的纯函数（可真实单测），三条路径一律改调
 * filterConverterSongs()（管线唯一入口）。本文件同时用「通用模式钉」守住它 ——
  * 不钉某个具体字面量（字面钉曾把 renderLocalSongs 的 bug 钉成「预期」）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CONV_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'views', 'converter.js'), 'utf8');

async function fresh() {
  return import(`../src/renderer/js/converterFilter.js?ck=${Math.random()}`);
}

const SONGS = [
  { filePath: 'a', title: '晴天', artist: '周杰伦', album: '叶惠美' },
  { filePath: 'b', title: 'Sunny Day', artist: 'Jay', album: 'Common' },
  { filePath: 'c', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' },
  { filePath: 'd', title: 'Hello', artist: 'Adele', album: '25' },
];

const paths = (arr) => arr.map((s) => s.filePath);

test('filterConverterSongsByKw：空/空白/非字符串关键词一律返回全部（且是新数组）', async () => {
  const { filterConverterSongsByKw } = await fresh();
  for (const kw of ['', '   ', undefined, null, 0, 123, {}]) {
    const out = filterConverterSongsByKw(SONGS, kw);
    assert.deepStrictEqual(paths(out), ['a', 'b', 'c', 'd'], `kw=${JSON.stringify(kw)} 应全量`);
    assert.notStrictEqual(out, SONGS, '必须返回浅拷贝，避免调用方 setState 后共享同一数组');
  }
});

test('filterConverterSongsByKw：歌名/歌手/专辑三字段命中，大小写不敏感', async () => {
  const { filterConverterSongsByKw } = await fresh();
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, '周杰伦')), ['a', 'c'], '歌手命中');
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, 'JAY')), ['b'], '歌手大小写不敏感');
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, 'sunny')), ['b'], '歌名大小写不敏感');
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, '25')), ['d'], '专辑命中');
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, '  晴天  ')), ['a'], '关键词两端空白应被裁掉');
  assert.deepStrictEqual(paths(filterConverterSongsByKw(SONGS, 'zzz')), [], '无命中返回空数组');
});

test('filterConverterSongsByKw：畸形输入静默安全，不改原数组', async () => {
  const { filterConverterSongsByKw, matchConverterKw } = await fresh();
  assert.deepStrictEqual(filterConverterSongsByKw(undefined, 'a'), []);
  assert.deepStrictEqual(filterConverterSongsByKw('nope', 'a'), []);
  assert.deepStrictEqual(filterConverterSongsByKw(null, 'a'), []);
  const copy = SONGS.slice();
  filterConverterSongsByKw(SONGS, '周杰伦');
  assert.deepStrictEqual(paths(SONGS), paths(copy), '原数组不得被改动');
  // 数字/空值字段不抛（旧内联版对数字 title 会 .toLowerCase() 抛错）
  assert.strictEqual(matchConverterKw({ title: 123 }, '123'), true);
  assert.strictEqual(matchConverterKw({ title: null, artist: undefined, album: '' }, 'x'), false);
  assert.strictEqual(matchConverterKw(null, 'x'), false);
});

test('回归钉：凡改动 _convLocalSongs 的路径必须先重跑 filterConverterSongs，不得直接 renderConverterSongs', () => {
  const lines = CONV_JS.split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (/^\s*(let|const|var)\s/.test(line)) return;              // 声明行不算改动
    if (!/_convLocalSongs\s*=\s*[^=]/.test(line)) return;        // 排除 === / ==
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      if (lines[j].includes('filterConverterSongs()')) { sites.push({ at: i + 1, ok: true }); return; }
      if (lines[j].includes('renderConverterSongs()')) { sites.push({ at: i + 1, ok: false, renderAt: j + 1 }); return; }
    }
    sites.push({ at: i + 1, ok: false, renderAt: null });
  });
  assert.ok(sites.length >= 3, `应找到至少 3 条改动 _convLocalSongs 的路径，实际 ${sites.length}`);
  for (const s of sites) {
    assert.ok(s.ok, s.renderAt
      ? `converter.js:${s.at} 改了 _convLocalSongs，随后先调了 renderConverterSongs（第 ${s.renderAt} 行）——会拿上一轮 convFiltered 渲染陈旧列表，必须改调 filterConverterSongs()`
      : `converter.js:${s.at} 改了 _convLocalSongs，但 10 行内没有任何过滤管线调用，列表不会刷新`);
  }
});

test('接线钉：filterConverterSongs 必须走纯函数并以 renderConverterSongs() 收尾', () => {
  const start = CONV_JS.indexOf('function filterConverterSongs()');
  assert.ok(start >= 0, '找不到 filterConverterSongs 定义');
  const open = CONV_JS.indexOf('{', start);
  let depth = 0;
  let body = '';
  for (let i = open; i < CONV_JS.length; i++) {
    if (CONV_JS[i] === '{') depth++;
    else if (CONV_JS[i] === '}') { depth--; if (depth === 0) { body = CONV_JS.slice(open, i + 1); break; } }
  }
  assert.ok(body.includes('filterConverterSongsByKw'), '过滤逻辑必须复用 converterFilter 纯函数，不许内联回视图');
  assert.ok(body.includes('renderConverterSongs()'), 'filterConverterSongs 过筛后必须重画（否则等于点了没反应）');
});
