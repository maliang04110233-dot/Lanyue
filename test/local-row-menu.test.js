/**
 * 增量83：本地曲库行右键菜单（localRowMenu.js 纯函数 + local.js 接线）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/local.js'), 'utf8'
);

async function loadMenu() {
  return import(`../src/renderer/js/localRowMenu.js?ck=${Math.random()}`);
}

const SONG = { title: 'A', artist: 'B', filePath: 'C:\\music\\a.mp3' };

test('buildLocalRowMenuItems：恰 7 项，顺序/图标/标签钉死，第 4 项为分隔线（88 加收藏后）', async () => {
  const { buildLocalRowMenuItems } = await loadMenu();
  const acts = { play() {}, edit() {}, fav() {}, probe() {}, reveal() {}, copyPath() {}, probeDone: false };
  const items = buildLocalRowMenuItems(SONG, acts);
  assert.strictEqual(items.length, 7);
  assert.strictEqual(items[3].sep, true);
  const labels = items.filter((i) => !i.sep).map((i) => i.label);
  assert.deepStrictEqual(labels, ['播放', '编辑信息', '收藏', '检测真实音质', '打开所在文件夹', '复制文件路径']);
  const icons = items.filter((i) => !i.sep).map((i) => i.icon);
  assert.deepStrictEqual(icons, ['▶', '✏️', '♥', '🔬', '📂', '📋']);
});

test('favOn/probeDone 只切各自图标：收藏 ♥/💔、音质 🔬/✓，不影响项数与顺序', async () => {
  const { buildLocalRowMenuItems } = await loadMenu();
  const acts = { play() {}, edit() {}, fav() {}, probe() {}, reveal() {}, copyPath() {} };
  const on = buildLocalRowMenuItems(SONG, { ...acts, probeDone: true, favOn: true });
  const off = buildLocalRowMenuItems(SONG, { ...acts, probeDone: false, favOn: false });
  assert.strictEqual(on[2].icon, '💔');
  assert.strictEqual(on[2].label, '取消收藏');
  assert.strictEqual(off[2].icon, '♥');
  assert.strictEqual(off[2].label, '收藏');
  assert.strictEqual(on[4].icon, '✓');
  assert.strictEqual(off[4].icon, '🔬');
  assert.strictEqual(on.length, 7);
  assert.strictEqual(off.length, 7);
});

test('onClick 转发：play/edit/fav/probe/reveal 收 song 本体，copyPath 收 filePath', async () => {
  const { buildLocalRowMenuItems } = await loadMenu();
  const calls = [];
  const acts = {
    play: (s) => calls.push(['play', s]),
    edit: (s) => calls.push(['edit', s]),
    fav: (s) => calls.push(['fav', s]),
    probe: (s) => calls.push(['probe', s]),
    reveal: (s) => calls.push(['reveal', s]),
    copyPath: (fp) => calls.push(['copyPath', fp]),
    probeDone: false,
  };
  const items = buildLocalRowMenuItems(SONG, acts);
  items[0].onClick();
  items[1].onClick();
  items[2].onClick();
  items[4].onClick();
  items[5].onClick();
  items[6].onClick();
  assert.deepStrictEqual(calls, [
    ['play', SONG], ['edit', SONG], ['fav', SONG], ['probe', SONG], ['reveal', SONG],
    ['copyPath', 'C:\\music\\a.mp3'],
  ]);
});

test('contextMenu 条目契约：非分隔项必带 label + 函数 onClick', async () => {
  const { buildLocalRowMenuItems } = await loadMenu();
  const acts = { play() {}, edit() {}, probe() {}, reveal() {}, copyPath() {}, probeDone: true };
  for (const it of buildLocalRowMenuItems(SONG, acts)) {
    if (it.sep) continue;
    assert.strictEqual(typeof it.label, 'string');
    assert.strictEqual(typeof it.onClick, 'function');
  }
});

test('local.js 接线：import 纯函数与 copyText，菜单数组改由 builder 出，定位/复制动作齐备', () => {
  assert.match(LOCAL_JS, /import \{ buildLocalRowMenuItems \} from '\.\.\/localRowMenu\.js';/);
  assert.match(LOCAL_JS, /import \{ copyText \} from '\.\.\/songShare\.js';/);
  assert.match(LOCAL_JS, /showContextMenu\(e\.clientX, e\.clientY, buildLocalRowMenuItems\(s, \{/);
  // 旧的行内数组必须已清（防止双维护）
  assert.doesNotMatch(LOCAL_JS, /showContextMenu\(e\.clientX, e\.clientY, \[\r?\n\s*\{ icon: '▶'/);
  assert.match(LOCAL_JS, /reveal: \(\) => revealLocalFile\(s\)/);
  assert.match(LOCAL_JS, /copyPath: \(fp\) => copyLocalPath\(fp\)/);
  // 走 openFolderSafe（utils.js 的唯一入口）而不是裸调 api.openFolder：
  // 主进程 open-folder 有 approvedDirs 沙箱，裸调会让「被拒」变成静默失败 ——
  // 用户点了没反应也没有提示。判据与 test/open-folder-entry.test.js 同源。
  assert.match(LOCAL_JS, /await openFolderSafe\(s\.filePath\)/);
  assert.doesNotMatch(LOCAL_JS, /api\.openFolder\(/, '裸调 api.openFolder 会静默失败，走 openFolderSafe');
  assert.match(LOCAL_JS, /await copyText\(fp\)/);
});
