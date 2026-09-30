/**
 * 本地曲库「♥ 仅看收藏」过滤（localFavFilter 纯函数 + 管线/按钮接线）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
  return import(`../src/renderer/js/localFavFilter.js?ck=${Math.random()}`);
}

test('favOnlyFilter：只留 filePath:local 命中收藏键的行，顺序保持', async () => {
  const { favOnlyFilter } = await loadMod();
  const songs = [
    { title: 'A', filePath: 'C:\\m\\a.mp3' },
    { title: 'B', filePath: 'C:\\m\\b.mp3' },
    { title: 'C', filePath: 'C:\\m\\c.mp3' },
  ];
  const keys = new Set(['C:\\m\\c.mp3:local', 'C:\\m\\a.mp3:local', '1001:netease']);
  assert.deepStrictEqual(
    favOnlyFilter(songs, keys).map(s => s.title), ['A', 'C']);
});

test('favOnlyFilter 脏输入：非数组/坏键集/缺 filePath 一律安全空或剔除', async () => {
  const { favOnlyFilter } = await loadMod();
  assert.deepStrictEqual(favOnlyFilter(null, new Set()), []);
  assert.deepStrictEqual(favOnlyFilter([{ filePath: 'x' }], null), []);
  assert.deepStrictEqual(favOnlyFilter([{ filePath: 'x' }, {}], new Set(['x:local'])),
    [{ filePath: 'x' }]);
  // 数字 filePath 也能按字符串键命中
  assert.strictEqual(favOnlyFilter([{ filePath: 7 }], new Set(['7:local'])).length, 1);
});

test('local.js 管线：开关先收藏后关键词串接，按钮文案/active 同步，收藏切换后仅收藏态重过滤', () => {
  assert.match(LOCAL_JS, /import \{ favOnlyFilter \} from '\.\.\/localFavFilter\.js';/);
  assert.match(LOCAL_JS, /let _localFavOnly = false;/);
  assert.match(LOCAL_JS, /if \(_localFavOnly\) songs = favOnlyFilter\(songs, getState\('favoriteKeys'\)\);/);
  // 收藏轴已进 LOCAL_AXES 声明式表：文案随两态切换、高亮=mode 本身（落按钮由 createCycleButton 统一）
  assert.match(LOCAL_JS, /id: 'fav', btnId: 'localFavBtn'/);
  assert.match(LOCAL_JS, /label: \(m\) => \(m \? '♥ 仅收藏' : '♥ 收藏'\),/);
  assert.match(LOCAL_JS, /isActive: \(m\) => !!m,/);
  assert.match(LOCAL_JS, /function toggleLocalFavOnly\(\) \{ _axes\.cycle\('fav'\); \}/);
  // 90 起：即时重过滤收敛到 favorites.js 钩子回调（行内红心/行菜单共用）
  assert.match(LOCAL_JS, /window\.onLocalFavToggle = \(\) => \{ if \(_localFavOnly\) filterLocalSongs\(\); \}/);
  assert.match(LOCAL_JS, /window\.toggleLocalFavOnly = toggleLocalFavOnly;/);
});

test('工具栏按钮与命令面板入口齐备', () => {
  assert.match(HTML, /id="localFavBtn" onclick="toggleLocalFavOnly\(\)"[^>]*>♥ 收藏<\/button>/);
  assert.match(PALETTE, /id: 'lc-favonly'[\s\S]*?_call\('toggleLocalFavOnly'\)/);
});
