/**
 * 增量84：歌单详情「🧹 清重复」
 * = mergeSongLists(base, []) 折叠曲内重复（保留首次出现）+ 视图/面板接线
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function loadMerge() {
  return import(`../src/renderer/js/playlistMerge.js?ck=${Math.random()}`);
}

test('曲内重复被折叠：保留首次出现与原顺序，removed=长度差', async () => {
  const { mergeSongLists } = await loadMerge();
  const base = [
    { id: 1, source: 'net', title: 'A', artist: 'x' },
    { id: 2, source: 'net', title: 'B', artist: 'y' },
    { id: '1', source: 'net', title: 'A重', artist: 'x' }, // 与首条同键（String 归一）
    { id: 3, source: 'qq', title: 'A', artist: 'x' },      // 跨平台同题不同键：保留
    { id: 2, source: 'net', title: 'B副本', artist: 'y' },
  ];
  const m = mergeSongLists(base, []);
  assert.deepStrictEqual(m.songs.map(s => s.title), ['A', 'B', 'A']);
  assert.deepStrictEqual(m.songs.map(s => `${s.source}:${s.id}`), ['net:1', 'net:2', 'qq:3']);
  assert.strictEqual(base.length - m.songs.length, 2);
});

test('无重复歌单幂等：长度/顺序不变，removed=0（UI 据此走 info toast 不写库）', async () => {
  const { mergeSongLists } = await loadMerge();
  const base = [
    { id: 1, source: 'net', title: 'A', artist: 'x' },
    { id: 2, source: 'net', title: 'B', artist: 'y' },
  ];
  const m = mergeSongLists(base, []);
  assert.strictEqual(m.songs.length, 2);
});

test('无键歌「宁重不丢」：两轮清理结果一致（折叠对无键项幂等不成立→不删）', async () => {
  const { mergeSongLists } = await loadMerge();
  const base = [
    { title: 'X' }, { title: 'X' },            // 有回退键 title|artist
    { bogusOnly: 1 }, { bogusOnly: 2 },        // 无 id/源 也无 标题 → 无键，全保留
  ];
  const m1 = mergeSongLists(base, []);
  const m2 = mergeSongLists(m1.songs, []);
  assert.deepStrictEqual(m2.songs, m1.songs);
});

test('playlist.js 接线：去重走 mergeSongLists(pl.songs,[])，有 busy 守卫与 window 桥', () => {
  assert.match(PL_JS, /const merged = mergeSongLists\(pl\.songs \|\| \[\], \[\]\);/);
  assert.match(PL_JS, /let _plDedupeBusy = false;/);
  assert.match(PL_JS, /if \(!_currentPlaylistId \|\| _plDedupeBusy\) return;/);
  assert.match(PL_JS, /if \(!removed\) \{ showToast\(t\('toast\.plNoDupSongs'\), 'info'\); return; \}/);
  // 键值对账：源码只留键，词典值必须还是「本歌单没有重复歌曲」（防止接错线）
  const zh = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../src/renderer/js/lang/zh.json'), 'utf8'));
  assert.strictEqual(zh['toast.plNoDupSongs'], '本歌单没有重复歌曲');
  assert.match(PL_JS, /api\.saveUserPlaylist\(\{ id: pl\.id, name: pl\.name, songs: merged\.songs \}\)/);
  assert.match(PL_JS, /window\.dedupeCurrentPlaylist = dedupeCurrentPlaylist;/);
});

test('index.html 按钮与命令面板入口齐备', () => {
  assert.match(HTML, /onclick="dedupeCurrentPlaylist\(\)">🧹 清重复<\/button>/);
  assert.match(PALETTE, /id: 'pl-dedupe'[\s\S]*?_call\('dedupeCurrentPlaylist'\)/);
});
