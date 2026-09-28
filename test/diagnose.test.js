/**
 * 单元测试：diagnose.js —— 失败分类纯函数
 *
 * classifyFailure：码表优先 → 关键词兜底 → 未分类，三层永不落空；
 * heal 动作只能是 settings/retry/null，驱动弹层按钮的显隐。
 */

const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);
}

test('classifyFailure: 码表命中优先于文本关键词', async () => {
  const { classifyFailure } = await fresh();
  const d = classifyFailure('AUTH_EXPIRED', 'some timeout');
  assert.equal(d.code, 'AUTH_EXPIRED');
  assert.equal(d.heal, 'settings');
  assert.match(d.cause, /Cookie/);
});

test('classifyFailure: 全部码表码都有非空 cause/advice 且 heal 合法', async () => {
  const { classifyFailure } = await fresh();
  for (const code of ['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED', 'COPYRIGHT_RESTRICTED',
    'UNAVAILABLE', 'CDN_EMPTY', 'NETWORK_TIMEOUT', 'NO_AUDIO_STREAM', 'UNKNOWN_PLATFORM']) {
    const d = classifyFailure(code, '');
    assert.ok(d.cause && d.advice, `${code} 缺文案`);
    assert.ok([null, 'settings', 'retry'].includes(d.heal), `${code} heal 非法: ${d.heal}`);
  }
});

test('classifyFailure: 未知码走文本关键词兜底', async () => {
  const { classifyFailure } = await fresh();
  assert.match(classifyFailure('SOMETHING', 'Error: ENOSPC no space left').cause, /磁盘/);
  assert.equal(classifyFailure('', 'ETIMEDOUT').heal, 'retry');
  assert.match(classifyFailure('', 'HTTP 403 Forbidden').cause, /鉴权/);
  assert.match(classifyFailure('', 'need VIP to download').cause, /VIP/);
});

test('classifyFailure: 全不命中归未分类且可重试，空输入不炸', async () => {
  const { classifyFailure } = await fresh();
  const d = classifyFailure(null, 'weird platform hiccup');
  assert.equal(d.code, 'UNKNOWN');
  assert.equal(d.heal, 'retry');
  const e = classifyFailure(undefined, undefined);
  assert.equal(e.code, 'UNKNOWN');
  assert.ok(e.cause && e.advice);
});

// ── 批量聚合 ─────────────────────────────────
test('groupFailures: 按分类聚合降序，非 error 与空项被忽略', async () => {
  const { groupFailures } = await fresh();
  const err = (code, error, title) => ({ status: 'error', errorCode: code, error, title, taskId: 't' + title });
  const items = [
    err('NETWORK_TIMEOUT', '', 'a'), err('NETWORK_TIMEOUT', '', 'b'), err('NETWORK_TIMEOUT', '', 'c'),
    err('AUTH_EXPIRED', '', 'd'), err('AUTH_EXPIRED', '', 'e'),
    err('', 'HTTP 403 Forbidden', 'f'),
    { status: 'done', title: 'g' },
    null,
  ];
  const groups = groupFailures(items);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].code, 'NETWORK_TIMEOUT');
  assert.equal(groups[0].songs.length, 3);
  assert.equal(groups[1].code, 'AUTH_EXPIRED');
  assert.equal(groups[2].code, 'INFERRED');
  assert.deepEqual(groups[2].songs.map(s => s.title), ['f']);
  assert.deepEqual(groupFailures(null), []);
  assert.deepEqual(groupFailures([{ status: 'done' }]), []);
});

test('retryableFailureCount: 鉴权/VIP 三码不计入，其余可重试', async () => {
  const { groupFailures, retryableFailureCount } = await fresh();
  const err = (code) => ({ status: 'error', errorCode: code, taskId: code });
  const groups = groupFailures([
    err('AUTH_EXPIRED'), err('LOGIN_REQUIRED'), err('VIP_REQUIRED'),
    err('CDN_EMPTY'), err('NETWORK_TIMEOUT'), err('UNKNOWN_X'),
  ]);
  assert.equal(retryableFailureCount(groups), 3);
  assert.equal(retryableFailureCount([]), 0);
});
