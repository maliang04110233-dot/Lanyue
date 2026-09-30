/**
 * 本地曲库「🎞 格式过滤」—— localFormatFilter.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/local.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import('../src/renderer/js/localFormatFilter.js?tc=' + Math.random());
}

test('extOf/listFormats：只认 filePath 尾扩展名、小写聚合、数量降序同数按字母', async () => {
  const { extOf, listFormats } = await fresh();
  assert.equal(extOf({ filePath: 'D:/m/歌.FLAC' }), 'flac');
  assert.equal(extOf({ filePath: '/x/y.mp3' }), 'mp3');
  assert.equal(extOf({ filePath: 'no-ext' }), '');
  assert.equal(extOf({}), '');
  assert.equal(extOf(null), '');
  assert.deepEqual(listFormats(null), []);
  assert.deepEqual(listFormats([]), []);
  const songs = [
    { filePath: 'a.flac' }, { filePath: 'b.FLAC' }, { filePath: 'c.flac' },
    { filePath: 'd.mp3' }, { filePath: 'e.mp3' },
    { filePath: 'f.wav' }, { filePath: 'g.aac' },
    { filePath: 'broken' }, {},
  ];
  // flac(3) > mp3(2) > aac/wav(1，字母序)
  assert.deepEqual(listFormats(songs), ['flac', 'mp3', 'aac', 'wav']);
});

test('nextFmtMode：all→格式逐个循环回 all；空曲库钉 all；失效格式回落 all', async () => {
  const { nextFmtMode } = await fresh();
  const fmts = ['flac', 'mp3', 'wav'];
  assert.equal(nextFmtMode('all', fmts), 'flac');
  assert.equal(nextFmtMode('flac', fmts), 'mp3');
  assert.equal(nextFmtMode('mp3', fmts), 'wav');
  assert.equal(nextFmtMode('wav', fmts), 'all');
  assert.equal(nextFmtMode('all', []), 'all'); // 没扫描也没格式可走
  assert.equal(nextFmtMode('all', null), 'all');
  assert.equal(nextFmtMode('ogg', fmts), 'all'); // 曲库里没 ogg：直接回全量
  assert.equal(nextFmtMode(undefined, fmts), 'all'); // 未知态回 all 起步
});

test('fmtModeLabel/filterByFmt：文案大写；all 原序拷贝；按扩展名精确匹配', async () => {
  const { fmtModeLabel, filterByFmt } = await fresh();
  assert.equal(fmtModeLabel('all'), '🎞 格式');
  assert.equal(fmtModeLabel(undefined), '🎞 格式');
  assert.equal(fmtModeLabel('flac'), '🎞 FLAC');
  assert.equal(fmtModeLabel('mp3'), '🎞 MP3');
  const songs = [
    { filePath: 'a.flac', n: 0 }, { filePath: 'b.mp3', n: 1 },
    { filePath: 'c.FLAC', n: 2 }, { filePath: 'd', n: 3 },
  ];
  const all = filterByFmt(songs, 'all');
  assert.deepEqual(all, songs);
  assert.notEqual(all, songs); // 新数组，不改源
  assert.deepEqual(filterByFmt(songs, null), songs);
  assert.deepEqual(filterByFmt(songs, 'flac').map(s => s.n), [0, 2]);
  assert.deepEqual(filterByFmt(songs, 'ogg'), []);
  assert.deepEqual(filterByFmt(null, 'flac'), []);
});

test('接线钉：local.js 管线+循环入口、index.html 按钮、命令面板 loc-fmt 全部就位', async () => {
  assert.match(LOCAL_JS, /import \{ listFormats, nextFmtMode, fmtModeLabel, filterByFmt \} from '\.\.\/localFormatFilter\.js';/);
  assert.match(LOCAL_JS, /if \(_localFmtMode !== 'all'\) songs = filterByFmt\(songs, _localFmtMode\);/, 'fav→fmt→kw 管线');
  // 循环动作收敛到 LOCAL_AXES 声明式表 + listAxes 装配；格式档的特殊点是
  // next 需要"全集实际格式表"当额外上下文（getExtra），这是它与音质/完整度轴
  // 唯一不同的地方，必须仍然在接线里。
  assert.ok(/id:\s*'fmt'/.test(LOCAL_JS) && /btnId:\s*'localFmtBtn'/.test(LOCAL_JS), '格式轴应在 LOCAL_AXES 表里声明并绑到 localFmtBtn');
  assert.ok(/id:\s*'fmt'[\s\S]{0,320}next:\s*nextFmtMode,/.test(LOCAL_JS), '格式轴用 nextFmtMode');
  assert.ok(LOCAL_JS.includes("getExtra: () => [listFormats(getState('localSongs') || [])],"),
    '格式档要把全集实际格式表喂给 nextFmtMode');
  assert.ok(/wireAxes\(LOCAL_AXES,\s*\(\)\s*=>\s*filterLocalSongs\(\)\)/.test(LOCAL_JS), '换档后共用重过筛回调');
  assert.ok(LOCAL_JS.includes("function cycleLocalFmt() { _axes.cycle('fmt'); }"), 'cycleLocalFmt 保留为转调壳');
  assert.match(LOCAL_JS, /window\.cycleLocalFmt = cycleLocalFmt;/);
  assert.match(HTML, /id="localFmtBtn" onclick="cycleLocalFmt\(\)"/);
  assert.match(PALETTE_JS, /\{ id: 'loc-fmt',.*_goto\('local'\); _call\('cycleLocalFmt'\); \}/, '面板先跳页再循环');
});
