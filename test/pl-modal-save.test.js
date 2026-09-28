/**
 * 平台歌单/专辑弹层「存为我的歌单 / 加进歌单」（零新通道）
 *
 * 弹层落点此前只有下载与连播；本增量把勾选行白名单投影后走
 * 既有 saveUserPlaylist（新建单）/ quickAddToPlaylist（加进已有单，
 * 引擎端 id+source 去重）。plModalSave.js 纯函数 + app.js 接线守卫。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', 'src/renderer', rel), 'utf8');
}

async function fresh() {
  return import('../src/renderer/js/plModalSave.js?tc=' + Math.random());
}

const SONGS = [
  { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', _runtime: 'x' },
  null,
  { id: '2', source: 'qq', title: '记得', artist: '林俊杰', album: '记得', albumMid: 'AL2', duration: 269, cover: 'http://c/2.jpg' },
  { id: '3', source: 'kugou', title: '无源' },
];

test('pickCheckedSongs：按序取勾选行，越界/空洞/非整数跳过', async () => {
  const { pickCheckedSongs } = await fresh();
  const got = pickCheckedSongs(SONGS, new Set([3.5, 2, 9, 0, 'x', -1]));
  assert.deepStrictEqual(got.map(s => s.id), ['1', '2']);
  assert.deepStrictEqual(pickCheckedSongs(SONGS, new Set()), []);
  assert.deepStrictEqual(pickCheckedSongs(null, new Set([0])), []);
  assert.deepStrictEqual(pickCheckedSongs(SONGS, null), []);
});

test('toPlaylistRows：白名单投影剥运行时字段，undefined 不落键，补 addedAt', async () => {
  const { toPlaylistRows } = await fresh();
  const rows = toPlaylistRows([SONGS[0], SONGS[2]]);
  assert.deepStrictEqual(rows[0], { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', addedAt: rows[0].addedAt });
  assert.ok(Number.isInteger(rows[0].addedAt), 'addedAt 供歌单详情按添加时间排序');
  assert.ok(!('_runtime' in rows[0]) && !('_altSource' in rows[0]));
  assert.deepStrictEqual(Object.keys(rows[1]).sort().join(','),
    'addedAt,album,albumMid,artist,cover,duration,id,source,title');
  assert.deepStrictEqual(toPlaylistRows(null), []);
});

test('buildSavedPlaylist：无名回退「平台歌单」，desc 带来源与曲数，封面取首张', async () => {
  const { buildSavedPlaylist, toPlaylistRows } = await fresh();
  const rows = toPlaylistRows([SONGS[0], SONGS[2]]);
  const p = buildSavedPlaylist({ name: ' 华语精选 ', src: '网易云' }, rows);
  assert.strictEqual(p.name, '华语精选');
  assert.strictEqual(p.desc, '网易云 歌单 · 2 首');
  assert.strictEqual(p.cover, 'http://c/2.jpg');
  assert.strictEqual(p.songs, rows);
  const q = buildSavedPlaylist({}, toPlaylistRows([SONGS[0]]));
  assert.strictEqual(q.name, '平台歌单');
  assert.strictEqual(q.desc, '平台 歌单 · 1 首');
  assert.strictEqual(q.cover, '');
});

test('接线：弹层工具条两按钮 + 命令面板 pl-msave + window 桥 + 复用既有通道', () => {
  const app = read('js/app.js');
  assert.ok(app.includes('onclick="savePlModalAsPlaylist()"'), '缺存为歌单按钮');
  assert.ok(app.includes('onclick="addPlModalToPlaylist()"'), '缺加进歌单按钮');
  assert.ok(app.includes("import { pickCheckedSongs, toPlaylistRows, buildSavedPlaylist } from './plModalSave.js';"));
  assert.ok(app.includes('await api.saveUserPlaylist(payload)'), '存为歌单未走既有 saveUserPlaylist 通道');
  assert.ok(app.includes("window.quickAddToPlaylist(toPlaylistRows(picked))"), '加进歌单未复用选单弹层');
  assert.ok(app.includes("modal.classList.contains('hidden')"), '弹层关闭时的守卫缺失');
  assert.ok(app.includes('window.savePlModalAsPlaylist = savePlModalAsPlaylist;'));
  assert.ok(app.includes('window.addPlModalToPlaylist = addPlModalToPlaylist;'));

  const pal = read('js/commandPalette.js');
  assert.ok(pal.includes("{ id: 'pl-msave'"), '命令面板缺 pl-msave');
  assert.ok(pal.includes("_call('savePlModalAsPlaylist')"));

  const mod = read('js/plModalSave.js');
  assert.ok(!/api\.|window\.|document\./.test(mod.replace(/^\s*\/\*\*[\s\S]*?\*\//, '')), '纯模块不得碰 DOM/IPC');
});
