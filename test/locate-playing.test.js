/**
 * 🎯 定位正在播放的歌（locatePlaying.js 纯匹配 + 两视图接线）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);
const LOCAL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/local.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function loadMod() {
  return import(`../src/renderer/js/locatePlaying.js?ck=${Math.random()}`);
}

test('对象引用即命中（播放队列与列表共用同引用时零比较成本）', async () => {
  const { indexOfPlaying } = await loadMod();
  const a = { id: 1, source: 'net', title: 'A' };
  assert.strictEqual(indexOfPlaying([{ id: 9 }, a, { id: 2 }], a), 1);
});

test('平台+ID 命中：数字/字符串 ID 归一同键；跨平台同 ID 不误命中', async () => {
  const { indexOfPlaying } = await loadMod();
  const list = [
    { id: 7, source: 'net', title: 'X' },
    { id: 7, source: 'qq', title: 'Y' },
  ];
  assert.strictEqual(indexOfPlaying(list, { id: '7', source: 'net' }), 0);
  assert.strictEqual(indexOfPlaying(list, { id: '7', source: 'qq' }), 1);
  assert.strictEqual(indexOfPlaying(list, { id: 8, source: 'net' }), -1);
});

test('filePath 命中本地曲目（无 id/source 也能定位）', async () => {
  const { indexOfPlaying } = await loadMod();
  const list = [{ filePath: 'C:\\m\\a.mp3' }, { filePath: 'C:\\m\\b.flac' }];
  assert.strictEqual(indexOfPlaying(list, { filePath: 'C:\\m\\b.flac' }), 1);
});

test('标题|歌手回退：大小写/首尾尾/内部多空白归一后命中', async () => {
  const { indexOfPlaying } = await loadMod();
  const list = [{ title: 'Hello World', artist: 'A B' }];
  assert.strictEqual(indexOfPlaying(list, { title: '  hello   world ', artist: 'a  b' }), 0);
  assert.strictEqual(indexOfPlaying(list, { title: 'Hello World', artist: 'other' }), -1);
});

test('脏输入全 -1：cur 为 null / 列表非数组 / 空对象', async () => {
  const { indexOfPlaying } = await loadMod();
  assert.strictEqual(indexOfPlaying([{ id: 1 }], null), -1);
  assert.strictEqual(indexOfPlaying(undefined, { id: 1 }), -1);
  assert.strictEqual(indexOfPlaying([{}, null], { title: '', artist: '' }), -1);
});

test('两视图接线：详情走 data-pidx+清过滤重试，本地走 scrollToIndex+双闪；按钮与面板入口齐备；模块有 document 守卫', () => {
  assert.match(PL_JS, /import \{ indexOfPlaying, flashRow \} from '\.\.\/locatePlaying\.js';/);
  assert.match(PL_JS, /data-pidx="\$\{idx\}"/);
  assert.match(PL_JS, /if \(!row && _plSongKw\) \{/);
  assert.match(PL_JS, /window\.locatePlayingInDetail = locatePlayingInDetail;/);
  assert.match(LOCAL_JS, /_localVirtualScroller\.scrollToIndex\(idx\)/);
  assert.match(LOCAL_JS, /setTimeout\(flash, 200\)/);
  assert.match(LOCAL_JS, /window\.locatePlayingLocal = locatePlayingLocal;/);
  assert.match(HTML, /onclick="locatePlayingInDetail\(\)">🎯 定位<\/button>/);
  assert.match(HTML, /onclick="locatePlayingLocal\(\)"[^>]*>🎯 定位播放<\/button>/);
  assert.match(PALETTE, /id: 'pl-locate'[\s\S]*?_call\('locatePlayingInDetail'\)/);
  assert.match(PALETTE, /id: 'lc-locate'[\s\S]*?_call\('locatePlayingLocal'\)/);
  const MOD = fs.readFileSync(
    path.join(__dirname, '../src/renderer/js/locatePlaying.js'), 'utf8'
  );
  assert.match(MOD, /typeof document === 'undefined'/);
});
