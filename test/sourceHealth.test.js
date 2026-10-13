/**
 * sourceHealth 单元测试（P2 源可用性探针）
 *
 * 2026-10-13 复审 P2-7 后有两处口径变化，本文件已同步：
 *   1. 分数是**拉普拉斯平滑** (ok+1)/(len+2)，不再是 ok/len —— 单次失败不再归零；
 *   2. 探测样本与真实下载样本**分桶**，探测不参与换源排序（只进 healthMap.probe）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sourceHealth = require(path.join(__dirname, '..', 'src', 'utils', 'sourceHealth'));

function reset() {
  sourceHealth._resetForTest();
}

test('recordResult: 记录成败并计算分数（平滑口径 (ok+1)/(len+2)）', () => {
  reset();
  assert.strictEqual(sourceHealth.getHealthScore('netease'), 1, '无数据默认乐观 1');

  sourceHealth.recordResult('netease', true);
  sourceHealth.recordResult('netease', true);
  sourceHealth.recordResult('netease', false);
  assert.strictEqual(sourceHealth.getHealthScore('netease'), 3 / 5,
    '2 成 1 败 ⇒ (2+1)/(3+2)');
  assert.strictEqual(sourceHealth.getSampleCount('netease'), 3);
});

test('recordResult: 滑动窗口只保留最近 WINDOW 次', () => {
  reset();
  const W = sourceHealth.WINDOW;
  // 先压满 W 个失败，再补 1 个成功：窗口滑走一个失败
  for (let i = 0; i < W; i++) sourceHealth.recordResult('qq', false);
  sourceHealth.recordResult('qq', true);
  assert.strictEqual(sourceHealth.getSampleCount('qq'), W);
  assert.strictEqual(sourceHealth.getHealthScore('qq'), 2 / (W + 2),
    '1 成 W-1 败 ⇒ (1+1)/(W+2)');
});

test('getHealthMap: 快照含样本数与分数；无数据源 score=null（区分未知与全成）', () => {
  reset();
  sourceHealth.recordResult('kugou', true);
  const m = sourceHealth.getHealthMap(['kugou', 'bilibili']);
  assert.strictEqual(m.kugou.score, 2 / 3, '1 成 ⇒ (1+1)/(1+2)');
  assert.strictEqual(m.kugou.samples, 1);
  assert.strictEqual(m.bilibili.score, null);
  assert.strictEqual(m.bilibili.samples, 0);
  assert.strictEqual(m.bilibili.probe, null, '没探测过就没有 probe 字段');
});

// ── P2-7 ────────────────────────────────────────────────────

test('P2-7：单次失败只是降权，不归零（旧口径下一次抖动即垫底且爬不回来）', () => {
  reset();
  sourceHealth.recordResult('netease', false);
  const s = sourceHealth.getHealthScore('netease');
  assert.ok(s > 0, `单次失败后分数必须 > 0，实际 ${s}（0 分会被排到所有无数据源之后）`);
  assert.ok(s < 1, '但确实降权了');
  assert.strictEqual(s, 1 / 3, '(0+1)/(1+2)');

  // 连续失败仍会明显沉底：平滑不是「原谅一切」
  for (let i = 0; i < 20; i++) sourceHealth.recordResult('netease', false);
  assert.ok(sourceHealth.getHealthScore('netease') < 0.1,
    `20 连败应显著沉底，实际 ${sourceHealth.getHealthScore('netease')}`);
});

test('P2-7：探测结果不进排序窗口（点一次实测不该把所有源降权）', () => {
  reset();
  // 真实下载：qq 表现很好，netease 表现一般
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('qq', true);
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('netease', false);

  const before = sourceHealth.getHealthScore('netease');
  // 弱网下点一次「源可用性实测」：全部源探测失败
  for (const src of ['netease', 'qq', 'kugou', 'kuwo', 'migu']) {
    sourceHealth.recordProbeResult(src, false);
  }

  assert.strictEqual(sourceHealth.getHealthScore('netease'), before,
    '探测失败不得改写真实下载分数');
  const ranked = sourceHealth.rankByHealth([
    { source: 'netease', name: 'a' },
    { source: 'qq', name: 'b' },
  ]);
  assert.deepStrictEqual(ranked.map(x => x.name), ['b', 'a'],
    '排序结果不受探测影响（qq 依然排前）');

  // 探测结果仍要能被设置页看到
  const m = sourceHealth.getHealthMap(['qq']);
  assert.ok(m.qq.probe, '探测结果应出现在 healthMap.probe 供展示');
  assert.strictEqual(m.qq.probe.samples, 1);
  assert.strictEqual(m.qq.probe.score, 1 / 3);
});

test('rankByHealth: 健康源排前，同分保持原序（稳定）', () => {
  reset();
  // netease 全败，qq 全成，kugou 无记录（默认乐观 1）
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('netease', false);
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('qq', true);
  const items = [
    { source: 'netease', name: 'a' },
    { source: 'kugou', name: 'b' },
    { source: 'qq', name: 'c' },
    { source: 'kugou', name: 'd' },
    { source: 'netease', name: 'e' },
  ];
  const ranked = sourceHealth.rankByHealth(items);
  // 分数降序：kugou(1.0 默认) 与 qq(1.0) 在前（原序 b<d），netease(0.0) 殿后。
  // 稳定排序只保证同分项相对顺序，不保证同分组连续——断言逐对非升即可。
  const scores = ranked.map(x => sourceHealth.getHealthScore(x.source));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], '健康度必须降序');
  }
  assert.strictEqual(ranked[ranked.length - 1].name, 'e');
  assert.strictEqual(ranked[ranked.length - 2].name, 'a');
  const kugouIdx = ranked.findIndex(x => x.name === 'b');
  const kugouIdx2 = ranked.findIndex(x => x.name === 'd');
  assert.ok(kugouIdx < kugouIdx2, '同源候选保持原有相对顺序');
});

test('rankByHealth: 空数组与单元素', () => {
  reset();
  assert.deepStrictEqual(sourceHealth.rankByHealth([]), []);
  const single = [{ source: 'netease', name: 'x' }];
  assert.deepStrictEqual(sourceHealth.rankByHealth(single), single);
});
