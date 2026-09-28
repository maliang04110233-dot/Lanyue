// 下载历史筛选纯逻辑（historyFilters.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fresh = () => import(`../src/renderer/js/historyFilters.js?ck=${Math.random()}`);

test('buildHistoryQuery：空筛选只留分页，任何维度缺省不进 opts', async () => {
  const { buildHistoryQuery } = await fresh();
  assert.deepEqual(buildHistoryQuery({}, 0, 50), { limit: 50, offset: 0 });
  assert.deepEqual(buildHistoryQuery({ keyword: '  ' }, 2, 50), { limit: 50, offset: 100 });
});

test('buildHistoryQuery：关键词/状态/来源三维修饰符共存', async () => {
  const { buildHistoryQuery } = await fresh();
  const opts = buildHistoryQuery(
    { keyword: ' 晴天 ', status: 'done', source: 'qq' }, 1, 50,
  );
  assert.deepEqual(opts, { limit: 50, offset: 50, keyword: '晴天', status: 'done', source: 'qq' });
});

test('buildHistoryQuery：非法 status 白名单丢弃，合法值保留', async () => {
  const { buildHistoryQuery, HISTORY_STATUS_TABS } = await fresh();
  assert.deepEqual(HISTORY_STATUS_TABS.map(t => t.v), ['', 'done', 'error']);
  assert.ok(!('status' in buildHistoryQuery({ status: 'DROP TABLE' }, 0, 50)));
  assert.equal(buildHistoryQuery({ status: 'error' }, 0, 50).status, 'error');
});

test('buildHistoryQuery：负页码钳到 0，不产生负 offset', async () => {
  const { buildHistoryQuery } = await fresh();
  assert.deepEqual(buildHistoryQuery({}, -3, 20), { limit: 20, offset: 0 });
});

test('sourceOptions：全部来源打头，脏平台条目剔除，缺 name 用 id 兜底', async () => {
  const { sourceOptions } = await fresh();
  const list = sourceOptions([
    { id: 'netease', name: '网易云' },
    { id: 'qq' },
    null,
    { name: '无id' },
  ]);
  assert.deepEqual(list, [
    { v: '', label: '全部来源' },
    { v: 'netease', label: '网易云' },
    { v: 'qq', label: 'qq' },
  ]);
  assert.deepEqual(sourceOptions(null), [{ v: '', label: '全部来源' }]);
});

test('classifyRetryResult：四态归类，null/无标志视为成功入队', async () => {
  // 归类跟着"入队"这件事搬到了 enqueuePayload.js —— 载荷与回话同一处规则
  const { classifyRetryResult } = await import(`../src/renderer/js/enqueuePayload.js?ck=${Math.random()}`);
  assert.equal(classifyRetryResult(null), 'added');
  assert.equal(classifyRetryResult({}), 'added');
  assert.equal(classifyRetryResult({ duplicated: true }), 'dup');
  assert.equal(classifyRetryResult({ alreadyDownloaded: true }), 'had');
  assert.equal(classifyRetryResult({ error: 'x' }), 'fail');
  // duplicated 优先级高于 error（同响应并存时按「已在队列」计）
  assert.equal(classifyRetryResult({ duplicated: true, error: 'x' }), 'dup');
});

test('retrySummary：计数拼文案，缺项按 0 补', async () => {
  const { retrySummary } = await fresh();
  assert.equal(
    retrySummary({ added: 3, dup: 1, had: 2, fail: 4 }),
    '🔁 重试完成：入队 3、已在队列 1、已下载跳过 2、失败 4',
  );
  assert.ok(retrySummary(undefined).includes('入队 0'));
});
