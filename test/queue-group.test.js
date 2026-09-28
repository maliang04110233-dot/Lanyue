/**
 * 下载队列「🧩 按平台分组」——queueGroup 纯函数 + 过滤第四维 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const DL_JS = read('src/renderer/js/views/download.js');
const FILTER_JS = read('src/renderer/js/queueFilter.js');
const HTML = read('src/renderer/index.html');
const PALETTE = read('src/renderer/js/commandPalette.js');

const NAME = { netease: '网易云音乐', qq: 'QQ音乐', unknown: '其他' };
const nameOf = (k) => NAME[k] || k;

function Q() {
  return [
    { taskId: 1, source: 'netease', status: 'done' },
    { taskId: 2, source: 'netease', status: 'downloading' },
    { taskId: 3, source: 'QQ', status: 'pending' },
    { taskId: 4, source: 'qq', status: 'error' },
    { taskId: 5, status: 'downloading' },
  ];
}

async function fresh() {
  return import('../src/renderer/js/queueGroup.js?QG=' + Math.random());
}

test('platformKeyOf：大小写/空白归一，缺来源落 unknown', async () => {
  const { platformKeyOf, UNKNOWN_KEY } = await fresh();
  assert.equal(platformKeyOf({ source: 'NetEase ' }), 'netease');
  assert.equal(platformKeyOf({ source: '' }), UNKNOWN_KEY);
  assert.equal(platformKeyOf({}), UNKNOWN_KEY);
  assert.equal(platformKeyOf(null), UNKNOWN_KEY);
  assert.equal(UNKNOWN_KEY, 'unknown');
});

test('分组：组内保序、曲数多者在前、四态计数分列', async () => {
  const { groupTasksByPlatform } = await fresh();
  const gs = groupTasksByPlatform(Q(), nameOf);
  assert.deepEqual(gs.map(g => g.key), ['netease', 'qq', 'unknown'], 'netease/qq 各 2 首要按名序，unknown 单任务在后');
  assert.deepEqual(gs[0].tasks.map(s => s.taskId), [1, 2]);
  assert.deepEqual(gs[1].tasks.map(s => s.taskId), [3, 4], '大小写不同的 source 并进同一组');
  assert.deepEqual(
    { total: gs[0].total, done: gs[0].done, downloading: gs[0].downloading, pending: gs[0].pending, error: gs[0].error },
    { total: 2, done: 1, downloading: 1, pending: 0, error: 0 },
  );
  assert.equal(gs[1].pending, 1);
  assert.equal(gs[1].error, 1);
  assert.equal(gs[2].label, '其他', 'NAME 里登记了 unknown，走 nameOf');
  assert.equal(groupTasksByPlatform(Q(), () => '')[2].label, 'unknown', 'nameOf 返回空时回落到键名');
});

test('脏输入不炸：非数组→[]、null 任务跳过、未知状态只进 total', async () => {
  const { groupTasksByPlatform } = await fresh();
  assert.deepEqual(groupTasksByPlatform(null), []);
  assert.deepEqual(groupTasksByPlatform([null, undefined]), []);
  const gs = groupTasksByPlatform([{ taskId: 7, source: 'migu', status: 'skipped' }]);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].total, 1);
  assert.equal(gs[0].downloading + gs[0].pending + gs[0].done + gs[0].error, 0);
});

test('不改入参：任务对象按引用入组，原数组长度顺序不变', async () => {
  const { groupTasksByPlatform } = await fresh();
  const src = Q();
  const snapshot = src.map(s => s.taskId).join(',');
  const gs = groupTasksByPlatform(src, nameOf);
  assert.equal(src.length, 5);
  assert.equal(src.map(s => s.taskId).join(','), snapshot);
  assert.equal(gs[0].tasks[1], src[1], '组内存的是原对象引用（展开详情/进度刷新才不会被旧副本盖掉）');
});

test('groupHeaderLabel：进行中=下载中+排队，零计数段省略', async () => {
  const { groupTasksByPlatform, groupHeaderLabel } = await fresh();
  const [netease] = groupTasksByPlatform(Q(), nameOf);
  assert.equal(groupHeaderLabel(netease), '网易云音乐 · 2 首（进行中 1 · 完成 1）');
  const qq = groupTasksByPlatform(Q(), nameOf).find(g => g.key === 'qq');
  assert.equal(groupHeaderLabel(qq), 'QQ音乐 · 2 首（进行中 1 · 失败 1）');
  assert.equal(groupHeaderLabel({ key: 'x', label: '咪咕', total: 3, downloading: 0, pending: 0, done: 0, error: 0 }), '咪咕 · 3 首');
  assert.equal(groupHeaderLabel(null), '');
});

test('折叠集合与「只看」切换都是纯操作（不改入参、同键再点即取消）', async () => {
  const { toggleGroupCollapsed, nextPlatformFilter } = await fresh();
  const base = new Set(['qq']);
  const opened = toggleGroupCollapsed(base, 'netease');
  assert.deepEqual([...opened].sort(), ['netease', 'qq']);
  assert.deepEqual([...base], ['qq'], '原集合不动');
  assert.deepEqual([...toggleGroupCollapsed(opened, 'qq')], ['netease']);
  assert.equal(nextPlatformFilter('', 'qq'), 'qq');
  assert.equal(nextPlatformFilter('qq', 'qq'), '', '再点同一个平台=取消只看');
  assert.equal(nextPlatformFilter('qq', 'netease'), 'netease', '点别的平台直接换过去');
  assert.equal(nextPlatformFilter(undefined, ''), '');
});

test('applyQueueFilter 第四维 platform：与状态/关键词 AND 叠加，大小写无关', async () => {
  const { applyQueueFilter } = await import('../src/renderer/js/queueFilter.js?QG=' + Math.random());
  assert.deepEqual(applyQueueFilter(Q(), 'all', '', 'qq').map(s => s.taskId), [3, 4]);
  assert.deepEqual(applyQueueFilter(Q(), 'all', '', 'QQ').map(s => s.taskId), [3, 4]);
  assert.deepEqual(applyQueueFilter(Q(), 'active', '', 'netease').map(s => s.taskId), [2]);
  assert.deepEqual(applyQueueFilter(Q(), 'all', 'x', 'netease'), []);
  assert.equal(applyQueueFilter(Q(), 'all', '').length, 5, '不传第四参时行为与旧签名一致');
  assert.equal(applyQueueFilter(Q(), 'all', '', null).length, 5);
  assert.deepEqual(applyQueueFilter(Q(), 'all', '', 'nope'), []);
  const { UNKNOWN_KEY } = await fresh();
  assert.deepEqual(applyQueueFilter(Q(), 'all', '', UNKNOWN_KEY).map(s => s.taskId), [5],
    '「其他」组（无 source 任务）的「只看」必须能命中自己组里的行，否则组头有数一点就空');
  assert.deepEqual(applyQueueFilter(Q(), 'all', '', '  QQ  ').map(s => s.taskId), [3, 4], '平台键也做空白归一');
});

test('接线钉：download.js 行模板只有一份，分组路径复用它', () => {
  assert.equal((DL_JS.match(/class="queue-item queue-status-/g) || []).length, 1, '行模板被复制成两份是这类重构最常见的坑');
  assert.equal((DL_JS.match(/_queueRowHtml\(s\)/g) || []).length, 3, '定义 + 平铺 + 分组三处');
  assert.match(DL_JS, /const filtered = applyQueueFilter\(queue, _dlFilter, _dlKeyword, _dlPlatform\);/);
  assert.match(DL_JS, /const shown = filtered\.slice\(-50\)\.reverse\(\);/);
  // 分组分支三行钉（逐行钉 + 顺序钉，比多行 verbatim 稳）
  assert.match(DL_JS, /if \(_dlGroupMode\) \{/);
  assert.match(DL_JS, /el\.innerHTML = groupTasksByPlatform\(shown, platformLabel\)\.map\(g => _queueGroupHeaderHtml\(g\)/);
  assert.match(DL_JS, /_dlCollapsed = toggleGroupCollapsed\(_dlCollapsed, key\);/);
  assert.ok(DL_JS.indexOf('if (_dlGroupMode) {') < DL_JS.indexOf("el.innerHTML = shown.map(s => _queueRowHtml(s)).join('');"),
    '分组分支必须在平铺分支之前，否则平铺永远吃掉列表');
  assert.ok(DL_JS.includes([
    "      + (_dlCollapsed.has(g.key) ? '' : g.tasks.map(s => _queueRowHtml(s)).join(''))).join('');",
    '    return;',
  ].join('\n')), '分组分支：折叠判空 + 行模板复用 + 立即 return');
  assert.ok(DL_JS.includes([
    'function clearDlPlatformFilter() {',
    '  if (!_dlPlatform) return;',
    '  setDlPlatformFilter(_dlPlatform);',
    '}',
  ].join('\n')), 'clearDlPlatformFilter 复用 setDlPlatformFilter 的toggle 语义');
  assert.match(DL_JS, /if \(key === UNKNOWN_KEY\) return '其他';/);
  assert.match(FILTER_JS, /&& \(!plat \|\| sourceKeyOf\(s\) === plat\)\);/, '平台维度的比较口径（含 unknown 归一）');
});

test('接线钉：window 桥、导出面、工具栏控件、命令面板项齐备', () => {
  for (const fn of ['toggleDlGroupMode', 'toggleDlGroupCollapsed', 'setDlPlatformFilter', 'clearDlPlatformFilter']) {
    assert.match(DL_JS, new RegExp(`window\\.${fn} = ${fn};`), `${fn} 未挂 window`);
    assert.ok(DL_JS.includes(`  ${fn},`), `${fn} 未进 ES Module 导出面`);
  }
  assert.match(HTML, /id="dlGroupBtn"[^>]*onclick="toggleDlGroupMode\(\)">🧩 分组: <span id="dlGroupLabel">关<\/span>/);
  assert.match(HTML, /id="dlPlatformChip" style="display:none"[^>]*onclick="clearDlPlatformFilter\(\)"/);
  assert.match(PALETTE, /id: 'dl-group'[\s\S]{0,220}_goto\('download'\); _call\('toggleDlGroupMode'\)/);
  assert.match(PALETTE, /id: 'dl-platclear'[\s\S]{0,220}_call\('clearDlPlatformFilter'\)/);
});
