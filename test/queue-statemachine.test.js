/**
 * 下载队列状态机测试
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  STATES,
  TRANSITIONS,
  canTransition,
  transition,
  transitionWithHistory,
  getTransitionHistory,
  getAllowedTransitions,
} = require('../src/main/downloadQueue/statemachine');

// ── 状态定义 ────────────────────────────────────────────

test('STATES: 包含全部 5 个状态', () => {
  assert.strictEqual(STATES.PENDING, 'pending');
  assert.strictEqual(STATES.DOWNLOADING, 'downloading');
  assert.strictEqual(STATES.DONE, 'done');
  assert.strictEqual(STATES.ERROR, 'error');
  assert.strictEqual(STATES.CANCELLED, 'cancelled');
});

test('TRANSITIONS: 每个状态都有转换表', () => {
  for (const state of Object.values(STATES)) {
    assert.ok(Array.isArray(TRANSITIONS[state]), `${state} 应有转换表`);
  }
});

// ── canTransition ───────────────────────────────────────

test('canTransition: pending → downloading 合法', () => {
  assert.strictEqual(canTransition('pending', 'downloading'), true);
});

test('canTransition: pending → error 合法', () => {
  assert.strictEqual(canTransition('pending', 'error'), true);
});

test('canTransition: downloading → done 合法', () => {
  assert.strictEqual(canTransition('downloading', 'done'), true);
});

test('canTransition: downloading → error 合法', () => {
  assert.strictEqual(canTransition('downloading', 'error'), true);
});

test('canTransition: done → pending 合法（重试）', () => {
  assert.strictEqual(canTransition('done', 'pending'), true);
});

test('canTransition: error → pending 合法（重试）', () => {
  assert.strictEqual(canTransition('error', 'pending'), true);
});

test('canTransition: pending → done 非法', () => {
  assert.strictEqual(canTransition('pending', 'done'), false);
});

test('canTransition: downloading → pending 合法（可重试错误）', () => {
  assert.strictEqual(canTransition('downloading', 'pending'), true);
});

test('canTransition: cancelled → 任何状态 非法', () => {
  assert.strictEqual(canTransition('cancelled', 'pending'), false);
  assert.strictEqual(canTransition('cancelled', 'downloading'), false);
  assert.strictEqual(canTransition('cancelled', 'done'), false);
  assert.strictEqual(canTransition('cancelled', 'error'), false);
});

test('canTransition: 未知状态返回 false', () => {
  assert.strictEqual(canTransition('unknown', 'pending'), false);
});

// ── transition ──────────────────────────────────────────

test('transition: 合法转换成功', () => {
  const song = { status: 'pending', id: 'test' };
  transition(song, 'downloading');
  assert.strictEqual(song.status, 'downloading');
});

test('transition: 非法转换抛错', () => {
  const song = { status: 'pending', id: 'test' };
  assert.throws(() => transition(song, 'done'), /非法状态转换/);
});

test('transition: 空对象抛错', () => {
  assert.throws(() => transition(null, 'pending'), /任务对象不能为空/);
});

test('transition: 记录最后转换', () => {
  const song = { status: 'pending', id: 'test' };
  transition(song, 'downloading', '开始下载');
  assert.ok(song._lastTransition);
  assert.strictEqual(song._lastTransition.from, 'pending');
  assert.strictEqual(song._lastTransition.to, 'downloading');
  assert.strictEqual(song._lastTransition.reason, '开始下载');
});

// ── transitionWithHistory ───────────────────────────────

test('transitionWithHistory: 记录转换历史', () => {
  const song = { status: 'pending', id: 'test' };
  transitionWithHistory(song, 'downloading', '开始下载');
  transitionWithHistory(song, 'done', '下载成功');
  const history = getTransitionHistory(song);
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].from, 'pending');
  assert.strictEqual(history[1].to, 'done');
});

test('transitionWithHistory: 历史最多保留 10 条', () => {
  const song = { status: 'pending', id: 'test' };
  for (let i = 0; i < 15; i++) {
    const to = i % 2 === 0 ? 'downloading' : 'pending';
    try { transitionWithHistory(song, to); } catch {}
  }
  const history = getTransitionHistory(song);
  assert.ok(history.length <= 10);
});

// ── getAllowedTransitions ───────────────────────────────

test('getAllowedTransitions: pending 有 3 个合法转换', () => {
  const allowed = getAllowedTransitions('pending');
  assert.strictEqual(allowed.length, 3);
  assert.ok(allowed.includes('downloading'));
  assert.ok(allowed.includes('error'));
  assert.ok(allowed.includes('cancelled'));
});

test('getAllowedTransitions: cancelled 没有合法转换', () => {
  const allowed = getAllowedTransitions('cancelled');
  assert.strictEqual(allowed.length, 0);
});

test('getAllowedTransitions: 未知状态返回空数组', () => {
  const allowed = getAllowedTransitions('unknown');
  assert.deepStrictEqual(allowed, []);
});
