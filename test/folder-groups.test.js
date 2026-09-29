/**
 * 本地曲库「🗂 文件夹分组」—— folderGroups.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FG_JS = readFileSync(path.join(ROOT, 'src/renderer/js/folderGroups.js'), 'utf8');
const LOCAL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/local.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import('../src/renderer/js/folderGroups.js?tc=' + Math.random());
}

test('parentDirOf：/ 与 \\ 统一取父目录，无分隔符返回空，根路径归 /', async () => {
  const { parentDirOf } = await fresh();
  assert.equal(parentDirOf('D:/Music/Rock/a.mp3'), 'D:/Music/Rock');
  assert.equal(parentDirOf('D:\\Music\\Rock\\a.mp3'), 'D:/Music/Rock');
  assert.equal(parentDirOf('/x/y.flac'), '/x');
  assert.equal(parentDirOf('/a.mp3'), '/');
  assert.equal(parentDirOf('bare.mp3'), '');
  assert.equal(parentDirOf(null), '');
  assert.equal(parentDirOf(undefined), '');
});

test('folderLabel：优先相对根目录，根本身取(根目录)，无根取 basename，空路径未知', async () => {
  const { folderLabel, UNKNOWN_FOLDER, ROOT_FOLDER_LABEL } = await fresh();
  assert.equal(folderLabel('D:/Music/Rock', 'D:/Music'), 'Rock');
  assert.equal(folderLabel('D:\\Music\\Rock\\2024', 'D:/Music/'), 'Rock/2024');
  assert.equal(folderLabel('D:/Music', 'D:/Music'), ROOT_FOLDER_LABEL);
  assert.equal(folderLabel('D:/Other/x', 'D:/Music'), 'x'); // 根外：退到 basename
  assert.equal(folderLabel('', ''), UNKNOWN_FOLDER);
  assert.equal(folderLabel('solo', ''), 'solo');
});

test('groupFolders：按父目录聚合数量/体积，数量降序同数按标签，容忍脏行', async () => {
  const { groupFolders } = await fresh();
  assert.deepEqual(groupFolders(null), []);
  assert.deepEqual(groupFolders([]), []);
  const songs = [
    { filePath: 'D:/M/Pop/a.mp3', fileSize: 10 },
    { filePath: 'D:/M/Pop/b.mp3', fileSize: '20' },
    { filePath: 'D:/M/Rock/c.flac', fileSize: 100 },
    { filePath: 'D:/M/Rock/d/d.mp3' }, // 嵌套目录单列一组，fileSize 缺失记 0
    { filePath: 'D:/M/top.m4a' },      // 根目录直属桶
    null,
    {}, // 无目录：归未知桶（dir ''）
  ];
  const g = groupFolders(songs, 'D:/M');
  assert.equal(g.length, 5);
  assert.equal(g[0].label, 'Pop'); // 数量最多者居首
  const byLabel = new Map(g.map(x => [x.label, x]));
  assert.deepEqual([byLabel.get('Pop').count, byLabel.get('Pop').size], [2, 30]);
  assert.equal(byLabel.get('Rock').dir, 'D:/M/Rock');
  assert.deepEqual([byLabel.get('Rock').count, byLabel.get('Rock').size], [1, 100]);
  assert.equal(byLabel.get('Rock/d').count, 1);
  assert.equal(byLabel.get('(根目录)').dir, 'D:/M');
  assert.equal(byLabel.get('(未知位置)').dir, '');
  // 后四组同为 1 首：按 label 排序且 Pop 恒在前
  assert.deepEqual(g.slice(1).map(x => x.count), [1, 1, 1, 1]);
});

test('filterByFolder + 激活态：空 dir 全量新数组；精确父目录匹配；setActive 复位', async () => {
  const { filterByFolder, applyFolderToSongs, setActiveFolder, getActiveFolder } = await fresh();
  const songs = [
    { filePath: 'D:/M/Pop/a.mp3', n: 0 },
    { filePath: 'D:/M/Rock/b.mp3', n: 1 },
    { filePath: 'D:/M/Pop/c.mp3', n: 2 },
  ];
  assert.deepEqual(filterByFolder(songs, '').map(s => s.n), [0, 1, 2]);
  assert.notEqual(filterByFolder(songs, null), songs);
  assert.deepEqual(filterByFolder(songs, 'D:/M/Pop').map(s => s.n), [0, 2]);
  assert.deepEqual(filterByFolder(songs, 'D:/M/Nope'), []);
  assert.deepEqual(filterByFolder(null, 'D:/M/Pop'), []);

  assert.equal(getActiveFolder(), null);
  assert.deepEqual(applyFolderToSongs(songs).map(s => s.n), [0, 1, 2]);
  setActiveFolder('D:/M/Pop');
  assert.equal(getActiveFolder(), 'D:/M/Pop');
  assert.deepEqual(applyFolderToSongs(songs).map(s => s.n), [0, 2]);
  assert.deepEqual(applyFolderToSongs(null), []);
  setActiveFolder(null); // 清除回到全量
  assert.equal(getActiveFolder(), null);
  assert.deepEqual(applyFolderToSongs(songs).map(s => s.n), [0, 1, 2]);
});

test('接线钉：local.js 链首注入、folderGroups 窗桥、index.html 按钮、命令面板 lc-folders 全部就位', async () => {
  assert.match(FG_JS, /import \{ groupBarPct, sanitizeFileBase \} from '\.\/artistGroups\.js';/, '复用分组面板件');
  assert.match(FG_JS, /if \(typeof document !== 'undefined'\) \{\n {2}window\.showFolderGroups = showFolderGroups;/);
  assert.match(LOCAL_JS, /import \{ applyFolderToSongs \} from '\.\.\/folderGroups\.js';/);
  assert.match(LOCAL_JS, /songs = applyFolderToSongs\(songs\);[^\n]*\n {2}if \(_localFavOnly\) songs = favOnlyFilter\(/, '文件夹在过滤链首位（fav 之前）');
  // 低频动作折进「🗂 分组 ▾」下拉后，入口判据要连菜单形状一起钉：
  // 只钉函数名的话，按钮被整段删出 DOM 也能靠命令面板这一路蒙过去。
  assert.match(HTML, /class="tb-menu-item" onclick="showFolderGroups\(\);closeTbMenus\(\)"[^>]*>🗂 文件夹分组</);
  assert.match(PALETTE_JS, /\{ id: 'lc-folders',.*_call\('showFolderGroups'\) \},/);
});
