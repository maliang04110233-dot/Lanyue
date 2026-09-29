/**
 * 播放队列「多选批量移除」
 *
 * 队列此前只有单行 ✕与整队清空；大队列做减法只能一下一下点。
 * 选态装「行对象引用」而不是下标：拖拽排序、外部加歌/移除让
 * 下标漂移时，提交仍按当前队列现算命中行，消失的行自然跳过。
 * removeQueueItemsByIdentity 倒序合成既有 removeQueueItem，
 * playIdx 换算与「删当前播补位」语义零复制粘贴。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/app.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
// 45838e3 起，用户反馈文案住在语言包里（源码只留键名），接线钉要两侧都看得见的东西才能钉稳
const ZH = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/lang/zh.json'), 'utf8'
));
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function fresh() {
  return import('../src/renderer/js/playQueueEdit.js?tc=' + Math.random());
}

function mkQueue() {
  const rows = [
    { id: 'a', source: 'netease', title: 'A' },
    { id: 'b', source: 'qq', title: 'B' },
    { id: 'c', source: 'kugou', title: 'C' },
    { id: 'd', source: 'netease', title: 'D' },
  ];
  return rows;
}

test('removeQueueItemsByIdentity：按引用命中，playIdx 前移正确，空选/非法选不动队列', async () => {
  const { removeQueueItemsByIdentity } = await fresh();
  const q = mkQueue();
  const r = removeQueueItemsByIdentity(q, 2, new Set([q[0], q[1]]));
  assert.deepStrictEqual(r.queue.map(s => s.title), ['C', 'D']);
  assert.strictEqual(r.playIdx, 0, '正在播 C：两行在它前面被删，高亮挪到 0');
  assert.strictEqual(r.removed, 2);
  assert.strictEqual(r.removedCurrent, false);
  assert.strictEqual(q.length, 4, '原队列不可变');
  const noop = removeQueueItemsByIdentity(q, 1, new Set());
  assert.strictEqual(noop.removed, 0);
  assert.deepStrictEqual(noop.queue.map(s => s.title), ['A', 'B', 'C', 'D']);
  assert.deepStrictEqual(noop.playIdx, 1);
  assert.strictEqual(removeQueueItemsByIdentity(q, 1, [q[2]]).removed, 0, '非 Set 输入按空选处理');
});

test('删中正在播的行：补位曲顶上；全删光则队空置 playIdx -1', async () => {
  const { removeQueueItemsByIdentity } = await fresh();
  const q = mkQueue();
  const r = removeQueueItemsByIdentity(q, 1, new Set([q[1], q[3]]));
  assert.deepStrictEqual(r.queue.map(s => s.title), ['A', 'C']);
  assert.strictEqual(r.removedCurrent, true);
  assert.strictEqual(r.playIdx, 1, 'B 没了，C 补到 1 位顶上');
  assert.strictEqual(r.queue[r.playIdx].title, 'C');
  const all = removeQueueItemsByIdentity(q, 2, new Set(q));
  assert.deepStrictEqual(all.queue, []);
  assert.strictEqual(all.playIdx, -1);
  assert.strictEqual(all.removed, 4);
});

test('身份选态抗漂移：拖拽换序照删对歌，已消失的行自然跳过', async () => {
  const { removeQueueItemsByIdentity } = await fresh();
  const q = mkQueue();
  const sel = new Set([q[1], q[2]]);
  const moved = [q[3], q[2], q[0], q[1]]; // 拖拽排序后
  const r = removeQueueItemsByIdentity(moved, 2, sel);
  assert.deepStrictEqual(r.queue.map(s => s.title), ['D', 'A'], '选的是 B/C，换序后删的还是 B/C');
  assert.strictEqual(r.playIdx, 1, 'C 正播着被删 → 补位 A 到 1');
  const gone = removeQueueItemsByIdentity([q[0], q[3]], 0, sel);
  assert.strictEqual(gone.removed, 0, '选中行已被外部删除：不动作');
});

test('接线钉：pq-header 双按钮、行首勾选框与模式化 onclick/拖拽开关、确认+桥+面板入口', () => {
  assert.ok(HTML.includes('id="pqSelBtn"') && HTML.includes('onclick="togglePqSelMode()"'), '多选开关');
  assert.ok(HTML.includes('id="pqSelRmBtn"') && HTML.includes('onclick="removeCheckedFromQueue()"'), '移除按钮');
  assert.ok(APP_JS.includes("import { removeQueueItem, removeQueueItemsByIdentity, dedupeQueue } from './playQueueEdit.js';"));
  assert.ok(APP_JS.includes('class="pq-sel-chk"') && APP_JS.includes('_pqSel.has(s)'), '行首勾选框按引用回显');
  assert.ok(APP_JS.includes("draggable=\"' + (_pqSelMode ? 'false' : 'true')"), '多选态禁拖拽防误合');
  // ', event' 是 Shift 连选的命门：change 事件带不出 shiftKey，只有 click 传得回键盘状态，
  // 接线详情与负向钉（禁止再退回 onchange）见 bulk-selection.test.js
  assert.ok(APP_JS.includes("_pqSelMode ? 'togglePqSel(' + i + ', event)' : 'window._playQueueIdx(' + i + ')'"),
    '多选态点行=勾选，平时=切歌');
  assert.ok(APP_JS.includes("askConfirm(t('toast.confirmRemoveRows', { count: _pqSel.size }))") && APP_JS.includes('_pqSel.clear();'),
    '先确认后落账，提交即清选态');
  // 这句确认文案从模板串搬进了语言包（英文界面要能翻）。判据跟着搬，但两侧都钉 ——
  // 只钉源码，词典可以悄悄换词；只钉词典，源码可以悄悄换键。
  assert.ok(ZH['toast.confirmRemoveRows'].includes('移出播放队列'),
    '确认框仍说清移出去的是「播放队列」里的行');
  assert.ok(ZH['toast.confirmRemoveRows'].includes('{count}'),
    '计数占位符在位（漏掉 {count} 就是把变量名印给用户）');
  assert.ok(APP_JS.includes('window._playQueueIdx(r.playIdx);'), '删掉当前播=补位曲续播');
  assert.ok(APP_JS.includes('_syncPqSelBtns();'), '按钮计数跟重绘走');
  ['togglePqSelMode', 'togglePqSel', 'removeCheckedFromQueue'].forEach((fn) => {
    assert.ok(APP_JS.includes(`window.${fn} =`), `${fn} 挂 window`);
  });
  assert.ok(PALETTE_JS.includes("{ id: 'pq-bulkrm'") && PALETTE_JS.includes("_call('togglePqSelMode')"));
});
