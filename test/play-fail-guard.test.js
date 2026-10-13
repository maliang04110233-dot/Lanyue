/**
 * 播放失败熔断的契约钉 —— 守卫"一次失败不得接管整个界面"这条不变量。
 *
 * 背景（用户截图实证）：连续失败被 nextSong 的循环模式放大成无限 toast 刷屏，
 * 界面完全不可操作。这里钉住熔断器的行为面：计数、阈值、清零、参数校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'playFailGuard.js')).href;
const { createPlayFailGuard, DEFAULT_THRESHOLD } = await import(url);

// ── 计数与阈值 ────────────────────────────────────────────

test('连续失败到阈值才 tripped，阈值之前不得误停（单曲失败不该拖垮整轮）', () => {
  const g = createPlayFailGuard();
  for (let i = 1; i < DEFAULT_THRESHOLD; i++) {
    const r = g.fail();
    assert.equal(r.tripped, false, `第 ${i} 次失败还没到阈值（阈值 ${DEFAULT_THRESHOLD}），不该停`);
    assert.equal(r.streak, i);
  }
  const last = g.fail();
  assert.equal(last.tripped, true, `第 ${DEFAULT_THRESHOLD} 次必须熔断`);
  assert.equal(last.threshold, DEFAULT_THRESHOLD);
});

test('熔断后继续失败仍然 tripped（归零是调用方的决定，不是这里自动发生）', () => {
  const g = createPlayFailGuard();
  for (let i = 0; i < 10; i++) g.fail();
  assert.equal(g.streak, 10);
  assert.equal(g.fail().tripped, true, '归零前一直处于熔断态');
});

// ── 清零的两条路 ─────────────────────────────────────────

test('播成功一次即清零：偶发失败不该让后面的歌陪葬', () => {
  const g = createPlayFailGuard();
  g.fail();
  g.fail();
  g.succeed();
  assert.equal(g.streak, 0);
  assert.equal(g.fail().tripped, false, '清零后第一次失败又从头数');
});

test('reset 与 succeed 等价（调用方在熔断后手动清零，给用户新的机会）', () => {
  const g = createPlayFailGuard();
  for (let i = 0; i < DEFAULT_THRESHOLD; i++) g.fail();
  g.reset();
  assert.equal(g.streak, 0);
  assert.equal(g.fail().tripped, false);
});

// ── 各实例互不干扰 ───────────────────────────────────────

test('两个 guard 的计数互不影响（模块级单例若被复用会串味）', () => {
  const a = createPlayFailGuard();
  const b = createPlayFailGuard();
  a.fail();
  a.fail();
  assert.equal(b.streak, 0);
  assert.equal(b.fail().tripped, false);
});

// ── 参数校验 ─────────────────────────────────────────────

test('阈值必须是 >=1 的整数（0 或负数会让它一失败就永久熔断）', () => {
  assert.throws(() => createPlayFailGuard({ threshold: 0 }), TypeError);
  assert.throws(() => createPlayFailGuard({ threshold: -1 }), TypeError);
  assert.throws(() => createPlayFailGuard({ threshold: 1.5 }), TypeError);
  assert.throws(() => createPlayFailGuard({ threshold: '3' }), TypeError);
});

test('自定义阈值生效（1 = 一失败就停，供"严格模式"用）', () => {
  const g = createPlayFailGuard({ threshold: 1 });
  assert.equal(g.fail().tripped, true);
});