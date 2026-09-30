/**
 * 守卫：默认状态下 3-C 的质量规则一条都不生效（3-B E2E 走查 E 组）
 *
 * E1 是升级不改变既有行为的保证：v1.0.34 升级到 v1.0.35，
 * 用户不动任何设置，下载行为必须逐字节一致。
 * 此前由四条规则的静态推演确认过；本文件把它落成可执行的断言 ——
 * 推演会随 evaluateQualityPolicy 的改动悄悄过期，断言不会。
 *
 * 同时钉 E2/E3 的正向对照：规则一开，skip 立刻发生。
 */

const test = require('node:test');
const assert = require('node:assert');

const { evaluateQualityPolicy, normalizeRules, QUALITY_RULE_IDS } =
  require('../src/utils/qualityPolicy');
const { explainSkip, isPolicySkipped } = (() => {
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const ROOT = path.join(__dirname, '..');
  const requireESM = createRequire(path.join(ROOT, 'test', 'x.cjs'));
  return requireESM('../src/renderer/js/policySkipNotice.js');
})();

const SONG = {
  title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269000, quality: 'standard',
};
const CANDIDATES = [
  { title: '晴天', artist: '周杰伦', quality: 'standard' },
];

/** 用户从没碰过设置时，prefs 里的形态 */
const UNTOUCHED = { qualityRules: [] };
const MISSING_KEY = {};

// ── E1：默认零影响 ─────────────────────────────────────

test('E1：规则列表为空 ⇒ 一条都不触发，动作恒为 keep', () => {
  for (const prefs of [UNTOUCHED, MISSING_KEY, { qualityRules: null }, { qualityRules: [] }]) {
    const p = evaluateQualityPolicy(prefs.qualityRules || [], SONG, {});
    assert.equal(p.action, 'keep',
      `默认状态下不该拦下任何下载（prefs=${JSON.stringify(prefs)}）`);
    assert.equal(p.ruleId, null, '未触发规则就不该带 ruleId');
  }
});

test('E1：默认状态下不产生任何 skip 话术', () => {
  const p = evaluateQualityPolicy([], SONG, {});
  const e = explainSkip({ status: 'done', skipReason: p.reason, skipRule: p.ruleId });
  assert.equal(isPolicySkipped({ status: 'done', skipReason: p.reason, skipRule: p.ruleId }), false,
    '正常下载完的任务不得被渲染成"已跳过"');
  assert.equal(e.skipped, false);
});

test('E1：即便规则已存在但全部 enabled=false，也不拦', () => {
  const rules = QUALITY_RULE_IDS.map((id) => ({ id, enabled: false, params: {} }));
  const p = evaluateQualityPolicy(rules, SONG, {});
  assert.equal(p.action, 'keep', '禁用状态与没有规则效果相同');
  assert.equal(p.ruleId, null);
});

// ── 否定对照：规则一开就生效，证明上面的断言不是因为求值器坏了 ──

test('E2 对照：min_quality 一开即 skip（默认放行不是求值器失灵）', () => {
  const rules = normalizeRules([{ id: 'min_quality', enabled: true, params: { min: 'lossless' } }]);
  const p = evaluateQualityPolicy(rules, SONG, { candidates: CANDIDATES });
  assert.equal(p.action, 'skip', '默认音质低于无损门槛时应跳过');
  assert.equal(p.ruleId, 'min_quality');
  assert.match(explainSkip({ status: 'done', skipReason: p.reason, skipRule: p.ruleId }).summary,
    /音质下限/);
});

test('E3 对照：exclude_names 一开即 skip', () => {
  const rules = normalizeRules([{ id: 'exclude_names', enabled: true, params: { names: ['周杰伦'] } }]);
  const p = evaluateQualityPolicy(rules, SONG, {});
  assert.equal(p.action, 'skip');
  assert.equal(p.ruleId, 'exclude_names');
  assert.ok(p.reason && p.reason.length, '必须带 reason，界面要靠它说明命中了什么');
});

// ── 规则集本身的自检 ───────────────────────────────────

test('规则 ID 集合稳定（新增规则要同步更新 E1 的推理）', () => {
  assert.deepEqual([...QUALITY_RULE_IDS].sort(),
    ['already_have', 'exclude_names', 'max_size', 'min_quality']);
});

test('normalizeRules 对空输入返回空数组（不是 undefined）', () => {
  for (const bad of [undefined, null, [], 'x', 42, {}]) {
    const out = normalizeRules(bad);
    assert.ok(Array.isArray(out), `normalizeRules(${JSON.stringify(bad)}) 应返回数组`);
    assert.equal(out.length, 0);
  }
});
