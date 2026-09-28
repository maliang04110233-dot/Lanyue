/**
 * 歌单详情「多选批量移除」
 *
 * 详情弹层此前只能逐行 ✕ 移除；本增量补多选模式：勾选键是歌的身份
 * （id:source，对齐主进程 songKey），过滤/排序/重渲染不丢选中，
 * 提交走既有 save-user-playlist（带 id 整单更新），零新 IPC 通道。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLAYLIST_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function fresh() {
  return import('../src/renderer/js/plBulkRemove.js?tc=' + Math.random());
}

const SONGS = [
  { id: '1', source: 'netease', title: '晴天' },
  null,
  { id: '1', source: 'qq', title: '同名不同源' },
  { id: '2', source: 'kugou', title: '无选' },
  { id: '3', title: '无源字段' },
];

test('plSongKey：键形对齐主进程 songKey（id:source），跨平台撞号互不误伤', async () => {
  const { plSongKey } = await fresh();
  assert.strictEqual(plSongKey(SONGS[0]), '1:netease');
  assert.strictEqual(plSongKey(SONGS[2]), '1:qq');
  assert.strictEqual(plSongKey(SONGS[4]), '3:', '缺 source 折叠成空串，与主进程 String(s.source||"") 同式');
});

test('splitBySelection：keep/removed 各归账，跨平台同号只删勾选源，空洞丢弃', async () => {
  const { splitBySelection } = await fresh();
  const { keep, removed } = splitBySelection(SONGS, new Set(['1:qq', '3:']));
  assert.deepStrictEqual(removed.map(s => s.title), ['同名不同源', '无源字段']);
  assert.deepStrictEqual(keep.map(s => s.title), ['晴天', '无选'], '1:netease 不受 1:qq 勾选波及；null 行直接丢弃');
  const a = splitBySelection(SONGS, ['2:kugou']);
  assert.strictEqual(a.removed.length, 1, '数组键集同样可用');
  assert.deepStrictEqual(splitBySelection(null, new Set()), { keep: [], removed: [] });
  assert.deepStrictEqual(splitBySelection(SONGS, null).keep.length, 4, '空键集全保留（去掉空洞）');
});

test('keysOf：一组歌 → 键集合，忽略空洞；空输入给空集', async () => {
  const { keysOf } = await fresh();
  assert.deepStrictEqual([...keysOf(SONGS)].sort(), ['1:netease', '1:qq', '2:kugou', '3:']);
  assert.strictEqual(keysOf(null).size, 0);
  assert.strictEqual(keysOf([null]).size, 0);
});

test('接线钉：三按钮入过滤行、行首勾选框跟模式走、整单更新提交、开/关重置、面板入口、模块纯净', async () => {
  assert.ok(HTML.includes('id="plSelModeBtn"') && HTML.includes('onclick="togglePlBulkMode()"'), '多选开关');
  assert.ok(HTML.includes('id="plSelAllBtn"') && HTML.includes('onclick="plSelectAllVisible()"'), '全选可见');
  assert.ok(HTML.includes('id="plSelRemoveBtn"') && HTML.includes('onclick="removeCheckedFromPlaylist()"'), '移除按钮');
  assert.ok(PLAYLIST_JS.includes("import { plSongKey, splitBySelection, keysOf } from '../plBulkRemove.js';"));
  assert.ok(PLAYLIST_JS.includes('class="pl-sel-chk"') && PLAYLIST_JS.includes('_plSelKeys.has(plSongKey(song))'),
    '行首勾选框按键集回显选中态');
  assert.ok(PLAYLIST_JS.includes('async function removeCheckedFromPlaylist()')
    && /removeCheckedFromPlaylist[\s\S]*?api\.saveUserPlaylist\(\{\s*id: pl\.id/.test(PLAYLIST_JS),
    '提交必须带 id 走整单更新，不逐首发 remove 通道');
  assert.ok(PLAYLIST_JS.includes("askConfirm(t('toast.plConfirmRemove', { count: removed.length, name: pl.name }))"),
    '不可逆前先确认（走词典）');
  // 键值对账：源码只留键，词典值必须还是那句「确认把 N 首歌移出歌单…」（防止接错线）
  const zh = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../src/renderer/js/lang/zh.json'), 'utf8'));
  assert.ok(zh['toast.plConfirmRemove'].includes('确认把 {count} 首歌移出歌单「{name}」'),
    'toast.plConfirmRemove 词典值被改动（原文丢失）');
  const openBody = PLAYLIST_JS.slice(PLAYLIST_JS.indexOf('async function openPlaylistDetail'));
  assert.ok(openBody.indexOf('_resetPlSel();') > -1 && openBody.indexOf('_resetPlSel();') < openBody.indexOf('closePlaylistDetail'),
    '开弹层重置选择态');
  assert.ok(/function closePlaylistDetail\(\)[\s\S]*?_resetPlSel\(\);/.test(PLAYLIST_JS), '关弹层重置选择态');
  assert.ok(PALETTE_JS.includes("{ id: 'pl-bulkrm'") && PALETTE_JS.includes("_call('togglePlBulkMode')"));
  assert.ok(window_bridges_ok(), '四个入口挂 window');
  function window_bridges_ok() {
    return ['togglePlBulkMode', 'togglePlSongSel', 'plSelectAllVisible', 'removeCheckedFromPlaylist']
      .every((fn) => PLAYLIST_JS.includes(`window.${fn} = ${fn};`));
  }
  const PURE = fs.readFileSync(path.join(__dirname, '../src/renderer/js/plBulkRemove.js'), 'utf8');
  const body = PURE.replace(/^\/\*\*[\s\S]*?\*\//, '');
  assert.ok(!/api\.|window\.|document\./.test(body), '纯函数模块不碰宿主');
});
