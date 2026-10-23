/**
 * localSort 单元测试：七档循环 + 各模式排序行为（缺字段垫底、中文 locale 序、稳定）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

async function fresh() {
  return import(`../src/renderer/js/localSort.js?ck=${Math.random()}`);
}

test('nextLocalSortMode：七档循环，未知模式回默认', async () => {
  const { nextLocalSortMode, localSortLabel, LOCAL_SORT_MODES } = await fresh();
  let m = 'default';
  const seq = [];
  for (let i = 0; i < 7; i++) { m = nextLocalSortMode(m); seq.push(m); }
  assert.deepStrictEqual(seq, ['title', 'artist', 'duration-desc', 'size-desc', 'plays-desc', 'mtime-desc', 'default']);
  assert.strictEqual(nextLocalSortMode('nope'), 'default');
  /* 2026-10-23：轴图标改为由按钮上的 data-ico 承担（CSS mask 渲染），
     文案本身不再带 ↕ 前缀。判据随之从「含 ↕」改为「非空且不含任何
     emoji/几何符号」—— 这样既守住文案不空，也守住"符号不许回到字符串里"。 */
  for (const mode of LOCAL_SORT_MODES) {
    const label = localSortLabel(mode);
    assert.ok(label && label.length > 0, mode);
    assert.ok(!/[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/u.test(label), `${mode} 的文案仍带符号：${label}`);
  }
});

test('sortLocalSongs：plays-desc 按注入计数表降序，未播/缺表垫底保序', async () => {
  const { sortLocalSongs, playKeyOf } = await fresh();
  const songs = [
    { filePath: 'a', title: '甲', artist: 'X' },
    { filePath: 'b', title: '乙', artist: 'Y' },
    { filePath: 'c', title: '丙' },
    { filePath: 'd', title: '丁', artist: 'Z' },
  ];
  const map = {
    [playKeyOf({ title: '乙', artist: 'Y' })]: 7,
    [playKeyOf({ title: '甲', artist: 'X' })]: 3,
    [playKeyOf({ title: '丙', artist: '' })]: 0, // 0 视同未播垫底
  };
  assert.deepStrictEqual(sortLocalSongs(songs, 'plays-desc', map).map(s => s.filePath), ['b', 'a', 'c', 'd']);
  // 无计数表 = 全垫底原序
  assert.deepStrictEqual(sortLocalSongs(songs, 'plays-desc').map(s => s.filePath), ['a', 'b', 'c', 'd']);
  // null 歌不动（playKeyOf 宽容空值）
  assert.strictEqual(playKeyOf(null), '|||');
});

test('sortLocalSongs：标题/歌手按中文 locale 升序，缺字段垫底且保序', async () => {
  const { sortLocalSongs } = await fresh();
  const songs = [
    { filePath: 'a', title: '白鸽', artist: '张三' },
    { filePath: 'b', title: '安河桥' },
    { filePath: 'c', artist: '李四' },
    { filePath: 'd', title: '安和桥', artist: '张三' },
    { filePath: 'e', title: '安河桥', artist: '王五' },
  ];
  const byTitle = sortLocalSongs(songs, 'title').map(s => s.filePath);
  // ICU zh 拼音序：同音"安和桥/安河桥"按字形排（d<b=e），"安"系 < "白"，无标题 c 垫底；同键稳定 b 先于 e
  assert.deepStrictEqual(byTitle, ['d', 'b', 'e', 'a', 'c']);
  const byArtist = sortLocalSongs(songs, 'artist').map(s => s.filePath);
  // 拼音升序：李四(c) < 王五(e) < 张三(a,d 同键稳定) < 无歌手 b 垫底
  assert.deepStrictEqual(byArtist, ['c', 'e', 'a', 'd', 'b']);
  assert.strictEqual(sortLocalSongs(songs, 'default').length, 5);
});

test('sortLocalSongs：时长/大小降序，0/缺字段/非数字一律垫底', async () => {
  const { sortLocalSongs } = await fresh();
  const songs = [
    { filePath: 'a', duration: 200, fileSize: 10 },
    { filePath: 'b', duration: null, fileSize: 0 },
    { filePath: 'c', duration: 60, fileSize: 999 },
    { filePath: 'd', fileSize: 'not-a-number' },
    { filePath: 'e', duration: 120 },
  ];
  assert.deepStrictEqual(sortLocalSongs(songs, 'duration-desc').map(s => s.filePath), ['a', 'e', 'c', 'b', 'd']);
  assert.deepStrictEqual(sortLocalSongs(songs, 'size-desc').map(s => s.filePath), ['c', 'a', 'b', 'd', 'e']);
});

test('sortLocalSongs：mtime-desc 按文件修改时间降序，0/缺字段/非数字一律垫底保序', async () => {
  const { sortLocalSongs } = await fresh();
  const songs = [
    { filePath: 'a', mtime: 1000 },
    { filePath: 'b' },                        // 缺字段 → 垫底
    { filePath: 'c', mtime: 3000 },
    { filePath: 'd', mtime: 0 },              // 0 视同未知 → 垫底
    { filePath: 'e', mtime: 'yesterday' },    // 非数字 → 垫底
    { filePath: 'f', mtime: 2000 },
  ];
  assert.deepStrictEqual(
    sortLocalSongs(songs, 'mtime-desc').map(s => s.filePath),
    ['c', 'f', 'a', 'b', 'd', 'e']
  );
  // 全垫底时保持原序（稳定）
  assert.deepStrictEqual(
    sortLocalSongs([{ filePath: 'x' }, { filePath: 'y' }], 'mtime-desc').map(s => s.filePath),
    ['x', 'y']
  );
});

test('接线钉：扫描结果必须带出 mtime，否则「最近添加」排序会静默全体垫底', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'localLibrary.js'), 'utf8');
  assert.match(
    src,
    /mtime:\s*stat\.mtimeMs/,
    'localLibrary 必须把文件 mtime 带进歌曲对象，否则 mtime-desc 排序恒等于原序（假绿）'
  );
});

test('sortLocalSongs：畸形输入静默安全，不改原数组', async () => {
  const { sortLocalSongs } = await fresh();
  assert.deepStrictEqual(sortLocalSongs(undefined, 'title'), []);
  assert.deepStrictEqual(sortLocalSongs('nope', 'size-desc'), []);
  const songs = [{ filePath: 'x', title: '乙' }, { filePath: 'y', title: '甲' }, null];
  const copy = songs.slice();
  const out = sortLocalSongs(songs, 'title');
  assert.deepStrictEqual(songs.map(s => s && s.filePath), copy.map(s => s && s.filePath)); // 原数组不动
  assert.deepStrictEqual(out.map(s => s && s.filePath), ['y', 'x', null]); // null 无 title 垫底
});
