/**
 * 守卫：质量策略跳过必须在界面上说清楚（3-C 闸门 22）
 *
 * 背景
 * ----
 * 主进程把 skip 写成 status='done' + skipReason + skipRule
 * （downloadQueue.js 复用 done 是有意为之：QUEUE_STATUSODES 是闭集，
 *   渲染层二十多处按 done/error/pending/downloading 分支）。
 * 代价是：渲染层若不还原，用户看到的就是一行「已完成」，
 * 与真的下完了毫无区别。R1（全部音源低于下限）与 R3（已存在误伤）
 * 都因此变成无声的丢歌。
 *
 * 本文件钉「话术与判定一致」这一层：
 *   1. explainSkip 能从任务还原出规则、原因、调整入口；
 *   2. 判定门未开的规则不给调整入口（给了就是让用户去改一个无关开关）；
 *   3. 否定对照：真的下载完的任务不得被误判成跳过。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// policySkipNotice.js 是渲染层的 ESM（由 Vite 打包），单测是 CJS ——
// 经 createRequire 载入，测的是**同一个文件**，不是复制品。
const { createRequire } = require('node:module');
const requireESM = createRequire(path.join(ROOT, 'test', 'x.cjs'));
const { explainSkip, isPolicySkipped, RULE_LABELS, TUNABLE_RULES } =
  requireESM('../src/renderer/js/policySkipNotice.js');
const { evaluateQualityPolicy } = require('../src/utils/qualityPolicy');

// ── 1. 四条 skip 规则各自都能还原出说明 ────────────────

const SONGS = {
  lowQuality: { title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, quality: 'standard' },
  haveIt: { title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223, quality: 'hq' },
  excluded: { title: '现场版歌曲', artist: '某人', album: '合辑', duration: 200, quality: 'hq' },
};

test('R1 min_quality 跳过：说「没有音源达到你设定的音质下限」并给调整入口', () => {
  const p = evaluateQualityPolicy(
    [{ id: 'min_quality', enabled: true, params: { min: 'lossless' } }],
    SONGS.lowQuality, {},
  );
  assert.equal(p.action, 'skip');
  const e = explainSkip({ status: 'done', skipRule: p.ruleId, skipReason: p.reason });
  assert.equal(e.skipped, true);
  assert.equal(e.ruleId, 'min_quality');
  assert.match(e.summary, /没有音源达到.*音质下限/,
    'R1 是唯一一种「所有候选都没了」的情形，措辞必须与其它 skip 区分开');
  assert.equal(e.needsAdjust, true, '用户需要一个地方去改门槛');
  assert.ok(e.hint && e.hint.length > 0, '必须给出下一步');
  assert.ok(e.detail.some((d) => /触发规则/.test(d)), '要说明是哪条规则拦下的');
});

test('R3 already_have 跳过：可查看判定依据（命中了什么）', () => {
  const p = evaluateQualityPolicy(
    [{ id: 'already_have', enabled: true, params: { scope: 'artist' } }],
    SONGS.haveIt, { haveArtist: new Set(['周杰伦']) },
  );
  assert.equal(p.action, 'skip');
  const e = explainSkip({ status: 'done', skipRule: p.ruleId, skipReason: p.reason });
  assert.equal(e.ruleId, 'already_have');
  assert.ok(e.detail.includes(p.reason),
    '判定依据里必须原样带上主进程给的 reason（含命中的歌手/专辑名）');
  assert.equal(e.needsAdjust, true, '误伤时用户要能改规则');
  assert.match(e.hint, /本地确实没有这首|已存在/, 'hint 应指向「本地库记错了」这条真实可能');
});

test('R4 exclude_names 跳过：说明命中了哪个词', () => {
  const p = evaluateQualityPolicy(
    [{ id: 'exclude_names', enabled: true, params: { names: ['现场'] } }],
    SONGS.excluded, {},
  );
  assert.equal(p.action, 'skip');
  const e = explainSkip({ status: 'done', skipRule: p.ruleId, skipReason: p.reason });
  assert.equal(e.ruleId, 'exclude_names');
  assert.ok(e.detail.some((d) => d.includes('命中排除名单')), '应保留原 reason');
  assert.equal(e.needsAdjust, true);
});

test('max_size 的 demote 不是 skip，不该出现在跳过说明里', () => {
  const p = evaluateQualityPolicy(
    [{ id: 'max_size', enabled: true, params: { maxMb: 1, to: 'standard' } }],
    { ...SONGS.haveIt, duration: 400 }, {},
  );
  assert.equal(p.action, 'demote');
  assert.equal(isPolicySkipped({ status: 'done', demoteReason: p.reason }), false,
    'demote 降档下载仍会成功，不能说成跳过');
});

// ── 2. 判定门：不该给的入口不给 ───────────────────────

test('TUNABLE_RULES 覆盖参数化规则；already_have 走独立分支', () => {
  // already_have 需要的是「可核对判定依据」，其余三条是「可改参数」，
  // 两者在 explainSkip 里分开处理，所以不该出现在同一个 Set 里。
  for (const id of ['min_quality', 'max_size', 'exclude_names']) {
    assert.equal(TUNABLE_RULES.has(id), true, `${id} 参数可调，应在 TUNABLE_RULES 内`);
    assert.ok(RULE_LABELS[id], `${id} 应有用户可读名称`);
  }
  assert.equal(TUNABLE_RULES.has('already_have'), false, 'already_have 由独立分支处理');
  // 但它的可调整性仍必须成立
  const e = explainSkip({ status: 'done', skipRule: 'already_have', skipReason: '本地已有' });
  assert.equal(e.needsAdjust, true, 'already_have 仍必须给用户调整入口');
});

// ── 3. 否定对照 ───────────────────────────────────────

test('否定对照：真的下完的任务不得被误判成跳过', () => {
  const done = { status: 'done', savePath: 'C:/Music/a.mp3', fileSize: 123 };
  assert.equal(isPolicySkipped(done), false);
  const e = explainSkip(done);
  assert.equal(e.skipped, false);
  assert.equal(e.summary, '');
  assert.equal(e.hint, null);
});

test('否定对照：空任务 / 下载中 / 失败任务都不是跳过', () => {
  for (const t of [null, undefined, {}, { status: 'downloading' }, { status: 'error', error: 'x' }]) {
    assert.equal(isPolicySkipped(t), false, `${JSON.stringify(t)} 不该被判为跳过`);
  }
});

test('否定对照：只有 skipRule、reason 为空时仍算跳过（判据不依赖文案）', () => {
  // 老版本队列数据可能只有 skipRule 没有 skipReason；若因此漏判，用户还是看不到原因
  assert.equal(isPolicySkipped({ status: 'done', skipRule: 'min_quality' }), true);
  const e = explainSkip({ status: 'done', skipRule: 'min_quality' });
  assert.equal(e.skipped, true);
  assert.ok(e.detail.some((d) => /触发规则/.test(d)), '即使没有 reason，规则名也要能显示');
});

test('否定对照：未知 ruleId 不得崩，且不谎称已知规则', () => {
  const e = explainSkip({ status: 'done', skipRule: 'future_rule', skipReason: '将来加的规则' });
  assert.equal(e.skipped, true);
  assert.match(e.ruleLabel, /future_rule/, '未知规则应回显 id，而不是编一个名字');
  assert.equal(e.needsAdjust, false, '未知规则没有对应的调整入口，不该引导用户去改设置');
});

// ── 4. 接线：渲染层确实用了它 ─────────────────────────

test('接线：download.js 已 import explainSkip 并在行渲染里用', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/views/download.js'), 'utf8');
  assert.match(src, /import\s*\{\s*explainSkip\s*\}\s*from\s*'\.\.\/policySkipNotice\.js'/,
    'download.js 未引入 explainSkip');
  assert.match(src, /const skip = explainSkip\(s\)/, '未在行渲染里构造跳过说明');
  assert.match(src, /skip\.summary/, '状态行未使用跳过说明');
  assert.match(src, /skip\.hint/, '详情面板未给出调整入口');
});

test('模块形态与渲染层一致：ESM 导出，不是 CJS（vite build 会直接报 is not exported）', () => {
  // 曾经这里写的是 module.exports：node 单测全绿，`vite build` 却报
  // "explainSkip is not exported"。单测绿灯、打包失败 —— 这类落差只有
  // 真的跑一次打包才会暴露，所以判据直接钉住导出形态。
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/policySkipNotice.js'), 'utf8');
  assert.ok(!/module\.exports/.test(src), '渲染层模块不得用 module.exports（Vite 走 ESM）');
  for (const name of ['explainSkip', 'isPolicySkipped', 'RULE_LABELS', 'TUNABLE_RULES']) {
    assert.match(src, new RegExp(`export\\s+(const|function)\\s+${name}\\b`),
      `${name} 缺少具名 export`);
  }
});

test('接线：主进程确实把 skipRule / skipReason 写在任务上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/downloadQueue.js'), 'utf8');
  assert.match(src, /song\.skipReason\s*=/, '主进程未写 skipReason');
  assert.match(src, /song\.skipRule\s*=/, '主进程未写 skipRule');
});
