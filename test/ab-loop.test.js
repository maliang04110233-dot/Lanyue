// A-B 循环纯逻辑（abLoop.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function fresh() {
  return import(`../src/renderer/js/abLoop.js?ck=${Math.random()}`);
}

test('mmss：秒转 m:ss，向下取整与脏值兜底', async () => {
  const { mmss } = await fresh();
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(80), '1:20');
  assert.equal(mmss(83.9), '1:23');
  assert.equal(mmss(-5), '0:00');
  assert.equal(mmss(undefined), '0:00');
});

test('abRewindTo：两端齐且 cur 触到 B（含 0.05s 容差）才回跳到 A', async () => {
  const { abRewindTo } = await fresh();
  assert.equal(abRewindTo(30, 10, 30), 10);
  assert.equal(abRewindTo(29.96, 10, 30), 10); // 容差内提前回跳
  assert.equal(abRewindTo(29.9, 10, 30), null);
  assert.equal(abRewindTo(30, 10, null), null);
  assert.equal(abRewindTo(30, null, 30), null);
  assert.equal(abRewindTo(30, 30, 10), null); // b<=a 非法段
});

test('abAdvance：三态成环 无→A→AB→清', async () => {
  const { abAdvance } = await fresh();
  const s1 = abAdvance(12, {});
  assert.deepEqual(s1.st, { a: 12 });
  assert.match(s1.msg, /A 点 0:12/);
  const s2 = abAdvance(45, s1.st);
  assert.deepEqual(s2.st, { a: 12, b: 45 });
  assert.match(s2.msg, /0:12 – 0:45/);
  const s3 = abAdvance(50, s2.st);
  assert.deepEqual(s3.st, {});
});

test('abAdvance：B 早于或等于 A 时 bad 且状态原样不动', async () => {
  const { abAdvance } = await fresh();
  const st = { a: 20 };
  const r = abAdvance(15, st);
  assert.equal(r.bad, true);
  assert.equal(r.st, st); // 同一引用原样返回
  assert.equal(abAdvance(20, st).bad, true); // 等于 A 也不行
});

test('abAdvance：负时间与脏 cur 归零处理', async () => {
  const { abAdvance } = await fresh();
  assert.deepEqual(abAdvance(-3, {}).st, { a: 0 });
  assert.deepEqual(abAdvance(null, {}).st, { a: 0 });
});

// 本文件其余判据一律 `!= null`（abAdvance / abRewindTo / abLabel / getAbRegion / loadstart），
// 唯独「清除」写成过 `if (!_st.a && !_st.b) return;` —— A=0 时它是假值，于是清不掉、
// 也不弹提示，徽标一直挂着「A 0:00 已选」，用户以为循环还在（其实 abAdvance 早就不回跳了）。
// 判据收进 abHasPoints 一处，设点与清除共用同一句话。
test('abHasPoints：设在 0 秒也算设过（判据不许退回假值）', async () => {
  const { abHasPoints } = await fresh();
  assert.equal(abHasPoints({ a: 0 }), true, 'A 点落在第 0 秒同样是点过的');
  assert.equal(abHasPoints({ b: 0 }), true);
  assert.equal(abHasPoints({ a: 12, b: 45 }), true);
  assert.equal(abHasPoints({}), false);
  assert.equal(abHasPoints(null), false, '脏入参不该抛');
});

test('清除与换曲两条撤销路径共用 abHasPoints', async () => {
  const src = fs.readFileSync(new URL('../src/renderer/js/abLoop.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(!abHasPoints\(_st\)\) return;/,
    'clearAbLoop 又用回假值判断了 —— A=0 时清不掉');
  assert.match(src, /if \(abHasPoints\(_st\)\) \{ _st = \{\}; _syncUi\(\); \}/,
    'loadstart 那条也要走同一判据，一份判据只留一个出处');
  assert.ok(!/_st\.a && !_st\.b/.test(src), '假值判断残留');
});

test('abLabel：三态徽标文案', async () => {
  const { abLabel } = await fresh();
  assert.equal(abLabel({}), '');
  assert.equal(abLabel({ a: 10 }), 'A 0:10 已选');
  assert.equal(abLabel({ a: 10, b: 95 }), '0:10–1:35');
});
