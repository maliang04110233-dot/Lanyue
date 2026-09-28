/**
 * 「📋 复制曲单」—— songListText.js 纯函数 + 双表面接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/playlist.js'), 'utf8');
const LOCAL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/local.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import('../src/renderer/js/songListText.js?tc=' + Math.random());
}

test('toTrackLine：歌名 - 歌手；缺歌手只留歌名；无标题/脏入参回空', async () => {
  const { toTrackLine } = await fresh();
  assert.equal(toTrackLine({ title: '晴' , artist: 'Jay' }), '晴 - Jay');
  assert.equal(toTrackLine({ title: ' 晴 ', artist: '  ' }), '晴'); // trim + 缺歌手
  assert.equal(toTrackLine({ title: '', artist: 'X' }), '');
  assert.equal(toTrackLine({ artist: 'X' }), '');
  assert.equal(toTrackLine(null), '');
  assert.equal(toTrackLine(undefined), '');
  assert.equal(toTrackLine({ title: 123, artist: null }), '123'); // 数字歌名照收，null 歌手算缺
});

test('toTrackLines：顺序不动、空行剔除、脏入参回空数组', async () => {
  const { toTrackLines } = await fresh();
  assert.deepEqual(toTrackLines(null), []);
  assert.deepEqual(toTrackLines([]), []);
  assert.deepEqual(toTrackLines([undefined, null]), []);
  const songs = [
    { title: 'A', artist: 'a' },
    { title: '' },
    { title: 'B', artist: 'b' },
    { title: 'C' },
  ];
  assert.deepEqual(toTrackLines(songs), ['A - a', 'B - b', 'C']);
});

test('接线钉：详情走 _plVisiblePairs 视图 + 本地走 localFiltered 视图 + 双按钮双面板命令', async () => {
  assert.match(PL_JS, /import \{ toTrackLines \} from '\.\.\/songListText\.js';/);
  assert.match(PL_JS, /const lines = toTrackLines\(_plVisiblePairs\(_currentDetailSongs\)\.map\(p => p\.song\)\);/, '复制的是当前过滤视图（含状态过滤/排序后）');
  assert.match(PL_JS, /const ok = await copyText\(lines\.join\('\\n'\)\);/);
  assert.match(PL_JS, /window\.copyPlaylistListText = copyPlaylistListText;/);
  assert.match(LOCAL_JS, /const lines = toTrackLines\(getState\('localFiltered'\) \|\| \[\]\);/, '本地复制当前过滤视图');
  assert.match(LOCAL_JS, /window\.copyLocalListText = copyLocalListText;/);
  assert.match(HTML, /onclick="copyPlaylistListText\(\)">📋 复制曲单</);
  assert.match(HTML, /onclick="copyLocalListText\(\)"[^>]*>📋 复制曲单</);
  assert.match(PALETTE_JS, /\{ id: 'pl-copylist',.*run: \(\) => _call\('copyPlaylistListText'\) \}/);
  assert.match(PALETTE_JS, /\{ id: 'loc-copylist',.*_goto\('local'\); _call\('copyLocalListText'\); \}/);
});
