/**
 * 播放队列「📋 复制曲单」
 *   - src/renderer/js/queueCopy.js —— 取哪些行 + 播报文案（纯函数，无 DOM）
 *   - app.js 接线 + 命令面板入口
 *
 * 复制曲单家族此前有两个消费方（歌单详情108 / 本地曲库108），播放队列是最后一块：
 * 手工排好的一队歌想发给别人，只能一首一首看。
 * 注意入口刻意只做在命令面板：pq-header 已有 6 个按钮且 .pq-panel 是
 * overflow:hidden 的不换行 flex，再塞第 7 个会被裁掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const esm = p => import(`../${p}?ck=${Math.random()}`);

test('未勾选任何行 → 复制整个队列（按队列原序，不是内部存储序）', async () => {
  const { pickQueueCopyRows } = await esm('src/renderer/js/queueCopy.js');
  const q = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
  const r = pickQueueCopyRows(q, new Set());
  assert.equal(r.scope, 'all');
  assert.deepEqual(r.rows.map(s => s.title), ['A', 'B', 'C']);
  assert.equal(pickQueueCopyRows(q, []).scope, 'all', '空数组等价于没勾选');
});

test('多选模式有勾选 → 只取勾到的行，且顺序跟着队列走（勾序 B→A 不该反过来）', async () => {
  const { pickQueueCopyRows } = await esm('src/renderer/js/queueCopy.js');
  const q = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
  const r = pickQueueCopyRows(q, new Set([q[1], q[0]]));
  assert.equal(r.scope, 'checked');
  assert.deepEqual(r.rows.map(s => s.title), ['A', 'B']);
});

test('勾选集合里的陈旧身份（行已被移出队列）不产生幽灵条目', async () => {
  const { pickQueueCopyRows } = await esm('src/renderer/js/queueCopy.js');
  const q = [{ title: 'A' }];
  const ghost = { title: '已被移出的歌' };
  const r = pickQueueCopyRows(q, new Set([ghost, q[0]]));
  assert.deepEqual(r.rows.map(s => s.title), ['A']);
  assert.equal(r.scope, 'checked');
});

test('脏入参一律收敛成空集（null / 非数组 / 非对象行）', async () => {
  const { pickQueueCopyRows } = await esm('src/renderer/js/queueCopy.js');
  for (const bad of [null, undefined, '', 0, {}]) {
    const r = pickQueueCopyRows(bad, new Set());
    assert.deepEqual(r.rows, [], `脏队列 ${JSON.stringify(bad)} 应得空`);
  }
  const r2 = pickQueueCopyRows([null, undefined, { artist: '没标题' }, { title: 'OK' }], new Set());
  assert.deepEqual(r2.rows.map(s => s.title), ['OK'], '行内脏值不能挤掉正常行');
});

test('播报文案如实说明复制了哪个范围（勾选 3 首 ≠ 队列 20 首）', async () => {
  const { queueCopyToastText } = await esm('src/renderer/js/queueCopy.js');
  assert.equal(queueCopyToastText(5, 'all'), '📋 已复制整个队列 5 首（歌名 - 歌手）');
  assert.equal(queueCopyToastText(3, 'checked'), '📋 已复制勾选的 3 首（歌名 - 歌手）');
});

test('接线：命令面板入口 + 复用既有剪贴板/曲名纯函数，零新 IPC 通道', () => {
  const app = read('src/renderer/js/app.js');
  assert.match(app, /import \{ pickQueueCopyRows, queueCopyToastText \} from '\.\/queueCopy\.js';/);
  assert.match(app, /window\.copyQueueListText/, '未挂全局（面板 _call 找不到函数）');
  assert.match(app, /toTrackLines\(/, '曲名行格式化必须复用 songListText，别再手写一遍');
  assert.match(app, /await copyText\(/, '剪贴板必须走 songShare.copyText');
  assert.match(app, /复制失败：剪贴板被占用或无权限|copyFailed/, '剪贴板写不进去要如实说');
  const palette = read('src/renderer/js/commandPalette.js');
  assert.match(palette, /id: 'pq-copylist'[\s\S]*?_call\('copyQueueListText'\)/, '命令面板缺入口');
  assert.doesNotMatch(read('src/shared/ipcContract.js'), /queue-copy|copy-queue/, '不该为此新增通道');
});
