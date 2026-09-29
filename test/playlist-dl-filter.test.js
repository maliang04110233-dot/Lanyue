/**
 * 歌单详情「⬇ 下载状态过滤」—— plDlFilter.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PL_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/playlist.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import('../src/renderer/js/plDlFilter.js?tc=' + Math.random());
}

test('nextPlDlMode/plDlModeLabel：三态循环与按钮文案，未知态回 all', async () => {
  const { nextPlDlMode, plDlModeLabel, PL_DL_MODES } = await fresh();
  assert.equal(nextPlDlMode('all'), 'undone');
  assert.equal(nextPlDlMode('undone'), 'done');
  assert.equal(nextPlDlMode('done'), 'all');
  assert.equal(nextPlDlMode('garbage'), 'undone'); // 未知 → 从 all 起步再进一步
  assert.equal(nextPlDlMode(undefined), 'undone');
  assert.deepEqual(PL_DL_MODES, ['all', 'undone', 'done']);
  assert.equal(plDlModeLabel('all'), '⬇ 全部状态');
  assert.equal(plDlModeLabel('undone'), '⬇ 未下载');
  assert.equal(plDlModeLabel('done'), '⬇ 已下载');
  assert.equal(plDlModeLabel('???'), '⬇ 全部状态');
});

test('filterByDlMode：done 才算已下载；queued/downloading/无状态都算未下载；视图序不动', async () => {
  const { filterByDlMode } = await fresh();
  const items = [
    { song: { id: 1, source: 'netease' }, i: 0 },
    { song: { id: 2, source: 'qq' }, i: 1 },
    { song: { id: 3, source: 'kugou' }, i: 2 },
    { song: { id: 4, source: 'netease' }, i: 3 },
  ];
  const status = { 1: 'done', 2: 'queued', 3: 'downloading', 4: null };
  const st = (song) => status[song.id] || null;

  // all 透传（新数组不共享引用变动风险）
  const all = filterByDlMode(items, 'all', st);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((x) => x.i), [0, 1, 2, 3]);

  assert.deepEqual(filterByDlMode(items, 'done', st).map((x) => x.i), [0]);
  // undone = 除了 done 全留（已加队/下载中/从未下载都算「没下完的」）
  assert.deepEqual(filterByDlMode(items, 'undone', st).map((x) => x.i), [1, 2, 3]);

  // 未知 mode 等同 all；非法输入不炸
  assert.equal(filterByDlMode(items, 'zzz', st).length, 4);
  assert.deepEqual(filterByDlMode(null, 'done', st), []);
  // statusOf 缺失：把条目本身当歌传给默认取值器
  assert.equal(filterByDlMode([{ song: { id: 9 } }], 'done').length, 0);
  // 无 song 字段的裸对象也走取值器（防御性）
  assert.deepEqual(filterByDlMode([{ id: 1 }], 'done', (x) => (x.id === 1 ? 'done' : null)).length, 1);
});

test('接线钉：详情过滤行按钮、统一视图管线、开弹层复位、桥与命令面板入口', async () => {
  assert.match(PL_JS, /import \{ filterByDlMode, nextPlDlMode, plDlModeLabel \} from '\.\.\/plDlFilter\.js';/);
  assert.match(PL_JS, /from '\.\.\/dlStatus\.js'/);
  assert.match(PL_JS, /dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener, dlStatusFor/);
  // 渲染与全选共用一个管线（两旧字面量都退役）
  assert.match(PL_JS, /function _plVisiblePairs\(songs\) \{/);
  // 渲染/全选/复制曲单/Shift 连选四处读视图都走同一管线
  // （连选是第四个读者：区间必须按屏幕上的行序算，另写一遍筛选迟早漂出"连到没显示的行"）
  assert.equal((PL_JS.match(/_plVisiblePairs\(/g) || []).length, 5); // 定义外四处调用
  assert.ok(!/const pairs = sortPlaylistPairs\(filterPlaylistSongs\(/.test(PL_JS), '仍有未走统一管线的 pairs 计算');
  assert.match(PL_JS, /sortPlaylistPairs\(dlFiltered, _plSortMode\)/);
  // 打开弹层复位三件套之一
  assert.match(PL_JS, /_plDlMode = 'all';\n\s*_syncPlSortBtn\(\);\n\s*_syncPlDlBtn\(\);/);
  assert.match(PL_JS, /_plDlMode = nextPlDlMode\(_plDlMode\);/);
  assert.match(PL_JS, /window\.cyclePlDlFilter = cyclePlDlFilter;/);

  assert.match(HTML, /id="plDlFilterBtn"[^>]*onclick="cyclePlDlFilter\(\)"/);

  assert.match(PALETTE_JS, /\{ id: 'pl-dlfilt'/);
  assert.match(PALETTE_JS, /_call\('cyclePlDlFilter'\)/);
});
