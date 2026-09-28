/**
 * 「不感兴趣」屏蔽纯函数测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/dismissed.js?ck=${Math.random()}`);

test('dismissKey：优先 source:id，退化标题|歌手归一键', async () => {
  const { dismissKey } = await mod();
  assert.equal(dismissKey({ source: 'qq', id: 123 }), 'qq:123');
  assert.equal(dismissKey({ source: 'netease', id: '45' }), 'netease:45');
  // 无 id：大小写/多余空白归一
  assert.equal(dismissKey({ title: '  Hello  World ', artist: 'ABBA' }), 't:hello world|abba');
  assert.equal(dismissKey(null), '');
});

test('normalizeDismissed：非数组→[]，丢脏条目，字段强转', async () => {
  const { normalizeDismissed } = await mod();
  assert.deepEqual(normalizeDismissed(null), []);
  assert.deepEqual(normalizeDismissed('x'), []);
  const r = normalizeDismissed([
    { key: 'qq:1', title: 'A', artist: 'B' },
    { title: 'no key' },
    { key: '' },
    null,
    { key: 't:x|y' },
  ]);
  assert.deepEqual(r, [
    { key: 'qq:1', title: 'A', artist: 'B' },
    { key: 't:x|y', title: '', artist: '' },
  ]);
});

test('normalizeDismissed 截断到 MAX_DISMISSED', async () => {
  const { normalizeDismissed, MAX_DISMISSED } = await mod();
  const big = Array.from({ length: MAX_DISMISSED + 50 }, (_, i) => ({ key: 'k' + i }));
  assert.equal(normalizeDismissed(big).length, MAX_DISMISSED);
});

test('addDismiss：新键前插，重复 no-op 返回 false', async () => {
  const { addDismiss } = await mod();
  const src = [{ key: 'a', title: 'A', artist: '' }];
  const r = addDismiss(src, { key: 'b', title: 'B', artist: '' });
  assert.deepEqual(r.map((x) => x.key), ['b', 'a']);
  assert.equal(addDismiss(src, { key: 'a', title: 'X', artist: '' }), false);
  assert.equal(addDismiss(src, null), false);
  assert.deepEqual(src.map((x) => x.key), ['a']); // 原数组不动
});

test('removeDismiss 按键剔除', async () => {
  const { removeDismiss } = await mod();
  const r = removeDismiss([{ key: 'a' }, { key: 'b' }], 'a');
  assert.deepEqual(r, [{ key: 'b' }]);
});

test('filterDismissedPairs：命中剔除保原始下标，空集直通', async () => {
  const { filterDismissedPairs } = await mod();
  const pairs = [[{ source: 'qq', id: 1 }, 0], [{ source: 'qq', id: 2 }, 1], [{ source: 'netease', id: 2 }, 2]];
  const [kept, hidden] = filterDismissedPairs(pairs, new Set(['qq:2']));
  assert.deepEqual(kept.map((p) => p[1]), [0, 2]);
  assert.equal(hidden, 1);
  const [pas, h0] = filterDismissedPairs(pairs, new Set());
  assert.equal(pas, pairs);
  assert.equal(h0, 0);
});
