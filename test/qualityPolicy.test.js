/**
 * 单元测试：utils/qualityPolicy.js 下载质量策略求值器
 *
 * 语义边界（逐条钉死）：
 *   - 空规则 = 完全放行（默认零行为，不给用户意外行为）；
 *   - 短路即终判：命中第一条即返回，排序即优先级；
 *   - 垃圾值安静降级为「无规则」，绝不抛错阻断队列；
 *   - 缺外部事实 = 该规则不命中（宁可不下手，不误杀）；
 *   - 降档不越级：已低于目标档位时 keep 而非 demote 到更高档。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUALITY_RANK,
  QUALITY_RULES,
  QUALITY_RULE_IDS,
  normalizeQuality,
  normalizeRules,
  normalizeRule,
  estimateSizeMb,
  evaluateQualityPolicy,
} = require('../src/utils/qualityPolicy');

const SONG = { title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, quality: 'lossless' };

// ── 归一：档位 ─────────────────────────────────────────

test('normalizeQuality：三档原样，未知/缺省/垃圾一律 standard', () => {
  for (const q of ['lossless', 'hq', 'standard']) {
    assert.equal(normalizeQuality(q), q);
  }
  // 注意：大小写与空白是「合法变体」而非垃圾，由下一条单独钉
  for (const q of [undefined, null, '', '320k', 0, {}, [], true, NaN]) {
    assert.equal(normalizeQuality(q), 'standard', `应归一到 standard: ${JSON.stringify(q)}`);
  }
});

test('normalizeQuality：大小写与首尾空白视为同一档（用户手编/旧备份常见）', () => {
  assert.equal(normalizeQuality('HQ'), 'hq');
  assert.equal(normalizeQuality('  Lossless  '), 'lossless');
  assert.equal(normalizeQuality('Standard'), 'standard');
});

test('QUALITY_RANK 档位序自洽：standard < hq < lossless', () => {
  assert.ok(QUALITY_RANK.standard < QUALITY_RANK.hq);
  assert.ok(QUALITY_RANK.hq < QUALITY_RANK.lossless);
});

// ── 归一：规则 ─────────────────────────────────────────

test('normalizeRules：垃圾输入一律空队列（不抛错、不阻断）', () => {
  for (const raw of [null, undefined, 42, 'not json {', true, { a: 1 }, [null, 42, 'x']]) {
    assert.deepEqual(normalizeRules(raw), [], `应为空队列: ${JSON.stringify(raw)}`);
  }
});

test('normalizeRules：收数组 / 单对象 / {rules:[]} / JSON 串四种形态', () => {
  const one = { id: 'min_quality', params: { min: 'hq' } };
  assert.equal(normalizeRules([one]).length, 1);
  assert.equal(normalizeRules(one).length, 1);
  assert.equal(normalizeRules({ rules: [one] }).length, 1);
  assert.equal(normalizeRules(JSON.stringify([one])).length, 1);
});

test('normalizeRules：坏元素被丢弃、好元素保留（宽容但不放弃）', () => {
  const out = normalizeRules([{ id: 'min_quality' }, null, 42, { id: '不存在' }, { id: 'max_size' }]);
  assert.deepEqual(out.map((r) => r.id), ['min_quality', 'max_size']);
});

test('normalizeRule：enabled 缺省为真，params 垃圾值退化为 {}', () => {
  assert.equal(normalizeRule({ id: 'min_quality' }).enabled, true);
  assert.equal(normalizeRule({ id: 'min_quality', enabled: false }).enabled, false);
  assert.deepEqual(normalizeRule({ id: 'min_quality', params: 'x' }).params, {});
});

// ── 体积估算 ───────────────────────────────────────────

test('estimateSizeMb：按码率×时长线性估算，三档单调递增', () => {
  const s = estimateSizeMb(240, 'standard');
  const h = estimateSizeMb(240, 'hq');
  const l = estimateSizeMb(240, 'lossless');
  assert.ok(s > 0 && s < h && h < l, `应递增: ${s}/${h}/${l}`);
  // 320kbps × 240s ≈ 9.4MB
  assert.ok(Math.abs(h - 9.375) < 0.2, `hq 240s 应约 9.4MB，实得 ${h}`);
});

test('estimateSizeMb：时长非法/缺省返回 0（不产生 NaN 污染比较）', () => {
  for (const d of [0, -5, null, undefined, NaN, 'abc']) {
    assert.equal(estimateSizeMb(d, 'hq'), 0, `应返回 0: ${d}`);
  }
});

// ── 求值：空规则 ───────────────────────────────────────

test('无规则 = 完全放行，且不改音质（默认零行为）', () => {
  for (const rules of [[], null, undefined, 'bad json', [{ id: '不存在' }]]) {
    const r = evaluateQualityPolicy(rules, SONG);
    assert.deepEqual(r, { action: 'keep', quality: 'lossless', ruleId: null, reason: '' });
  }
});

test('null song 不炸：归到 standard 并按门槛求值', () => {
  const r = evaluateQualityPolicy([{ id: 'min_quality', params: { min: 'lossless' } }], null);
  assert.equal(r.action, 'skip', 'standard 低于 lossless 门槛应跳过');
  assert.equal(r.quality, 'standard');
});

// ── 求值：min_quality ──────────────────────────────────

test('min_quality：低于门槛跳过，达标放行（边界含等号）', () => {
  const rules = [{ id: 'min_quality', params: { min: 'hq' } }];
  assert.equal(evaluateQualityPolicy(rules, { ...SONG, quality: 'standard' }).action, 'skip');
  assert.equal(evaluateQualityPolicy(rules, { ...SONG, quality: 'hq' }).action, 'keep', '等于门槛应放行');
  assert.equal(evaluateQualityPolicy(rules, { ...SONG, quality: 'lossless' }).action, 'keep');
});

test('min_quality：disabled 的规则不生效', () => {
  const rules = [{ id: 'min_quality', enabled: false, params: { min: 'lossless' } }];
  assert.equal(evaluateQualityPolicy(rules, { ...SONG, quality: 'standard' }).action, 'keep');
});

test('min_quality：命中时带 ruleId 与可读 reason', () => {
  const r = evaluateQualityPolicy([{ id: 'min_quality', params: { min: 'lossless' } }], { ...SONG, quality: 'hq' });
  assert.equal(r.ruleId, 'min_quality');
  assert.ok(r.reason.includes('hq') && r.reason.includes('lossless'), `reason 应点明双方: ${r.reason}`);
});

// ── 求值：max_size ─────────────────────────────────────

test('max_size：超上限降档，且只降不升', () => {
  // 269s lossless 估约 26MB；上限 10MB ⇒ 降 hq
  const r = evaluateQualityPolicy([{ id: 'max_size', params: { maxMb: 10, to: 'hq' } }], SONG);
  assert.equal(r.action, 'demote');
  assert.equal(r.quality, 'hq');
  assert.equal(r.ruleId, 'max_size');
});

test('max_size：未超上限放行', () => {
  const r = evaluateQualityPolicy([{ id: 'max_size', params: { maxMb: 500, to: 'hq' } }], SONG);
  assert.equal(r.action, 'keep');
  assert.equal(r.quality, 'lossless');
});

test('max_size：目标已不高于 to 时 keep 而非 demote（不得反向升档）', () => {
  // 已是 standard，目标 hq 更高 ⇒ 再降无意义
  const r = evaluateQualityPolicy(
    [{ id: 'max_size', params: { maxMb: 1, to: 'hq' } }], { ...SONG, quality: 'standard', duration: 600 });
  assert.equal(r.action, 'keep');
  assert.equal(r.quality, 'standard', '绝不能把 standard 升成 hq');
  assert.ok(r.reason.includes('最低档'), `应说明为何不降: ${r.reason}`);
});

test('max_size：cap 非法（0/负/NaN/字符串）⇒ 本条不生效，不误杀', () => {
  for (const cap of [0, -1, NaN, 'abc', null]) {
    const r = evaluateQualityPolicy([{ id: 'max_size', params: { maxMb: cap, to: 'hq' } }], SONG);
    assert.equal(r.action, 'keep', `cap=${cap} 应不生效`);
  }
});

test('max_size：ctx.estSizeMb 覆盖内部估算（调用方自算优先）', () => {
  const rules = [{ id: 'max_size', params: { maxMb: 10, to: 'standard' } }];
  assert.equal(evaluateQualityPolicy(rules, SONG, { estSizeMb: 1 }).action, 'keep');
  assert.equal(evaluateQualityPolicy(rules, SONG, { estSizeMb: 999 }).action, 'demote');
});

// ── 求值：already_have ─────────────────────────────────

test('already_have(artist)：本地已有该歌手 ⇒ 跳过', () => {
  const rules = [{ id: 'already_have', params: { scope: 'artist' } }];
  const hit = evaluateQualityPolicy(rules, SONG, { haveArtist: ['周杰伦'] });
  assert.equal(hit.action, 'skip');
  assert.equal(hit.ruleId, 'already_have');
  assert.ok(hit.reason.includes('周杰伦'), `reason 应点名歌手: ${hit.reason}`);

  const miss = evaluateQualityPolicy(rules, SONG, { haveArtist: ['林俊杰'] });
  assert.equal(miss.action, 'keep');
});

test('already_have(album)：按专辑跳过，只歌手命中不误杀', () => {
  const rules = [{ id: 'already_have', params: { scope: 'album' } }];
  // 只有歌手命中、专辑没命中 ⇒ 不该跳过
  assert.equal(evaluateQualityPolicy(rules, SONG, { haveArtist: ['周杰伦'] }).action, 'keep');
  assert.equal(evaluateQualityPolicy(rules, SONG, { haveAlbum: ['叶惠美'] }).action, 'skip');
});

test('already_have：缺外部事实 ⇒ 不命中（宁可不下手，不误杀）', () => {
  const rules = [{ id: 'already_have', params: { scope: 'artist' } }];
  assert.equal(evaluateQualityPolicy(rules, SONG, {}).action, 'keep');
  assert.equal(evaluateQualityPolicy(rules, SONG, { haveArtist: [] }).action, 'keep');
});

test('already_have：忽略首尾空白，且拉丁歌手名忽略大小写', () => {
  const rules = [{ id: 'already_have', params: { scope: 'artist' } }];
  assert.equal(evaluateQualityPolicy(rules, SONG, { haveArtist: ['  周杰伦  '] }).action, 'skip',
    '首尾空白应被容忍');
  // 大小写折叠只有对拉丁字母才有意义，中文没有大小写
  const enSong = { ...SONG, artist: 'Adele' };
  assert.equal(evaluateQualityPolicy(rules, enSong, { haveArtist: ['  ADELE '] }).action, 'skip',
    '拉丁歌手名应忽略大小写');
});

test('already_have：歌手字段为空时不得因空串误命中', () => {
  const rules = [{ id: 'already_have', params: { scope: 'artist' } }];
  const r = evaluateQualityPolicy(rules, { ...SONG, artist: '' }, { haveArtist: [''] });
  assert.equal(r.action, 'keep', '空歌手不该被空名单命中');
});

// ── 求值：exclude_names ────────────────────────────────

test('exclude_names：命中歌名/歌手/专辑任一即跳过', () => {
  const rules = [{ id: 'exclude_names', params: { names: ['周杰伦'] } }];
  const r = evaluateQualityPolicy(rules, SONG, {});
  assert.equal(r.action, 'skip');
  assert.equal(r.ruleId, 'exclude_names');
  assert.ok(r.reason.includes('周杰伦'), `reason 应点名: ${r.reason}`);
});

test('exclude_names：名单为空 ⇒ 本条不生效', () => {
  for (const names of [[], '', null, ['']]) {
    const r = evaluateQualityPolicy([{ id: 'exclude_names', params: { names } }], SONG, {});
    assert.equal(r.action, 'keep', `names=${JSON.stringify(names)} 应不生效`);
  }
});

test('exclude_names：支持子串包含（用户只想排「现场版」不必列全名）', () => {
  const rules = [{ id: 'exclude_names', params: { names: ['live'] } }];
  assert.equal(evaluateQualityPolicy(rules, SONG, {}).action, 'keep', '正片不该被「live」命中');
  assert.equal(evaluateQualityPolicy(rules, { ...SONG, title: '晴天 (Live)' }, {}).action, 'skip',
    '大小写不同也应命中（归一后子串包含）');
});

// ── 求值：短路与排序 ───────────────────────────────────

test('短路即终判：第一条命中即返回，排序即优先级', () => {
  const rules = [
    { id: 'min_quality', params: { min: 'lossless' } }, // hq 歌 → 命中
    { id: 'max_size', params: { maxMb: 1, to: 'standard' } }, // 也会命中，但不该被看到
  ];
  const r = evaluateQualityPolicy(rules, { ...SONG, quality: 'hq' });
  assert.equal(r.ruleId, 'min_quality', '应返回第一条命中的规则');
});

test('调整顺序即改变判定：skip 优先于 demote', () => {
  const skipFirst = [
    { id: 'already_have', params: { scope: 'artist' } },
    { id: 'max_size', params: { maxMb: 1, to: 'standard' } },
  ];
  const demoteFirst = [...skipFirst].reverse();
  const ctx = { haveArtist: ['周杰伦'] };
  assert.equal(evaluateQualityPolicy(skipFirst, SONG, ctx).action, 'skip');
  assert.equal(evaluateQualityPolicy(demoteFirst, SONG, ctx).action, 'demote');
});

test('全不命中时回落 keep 且 ruleId 为 null', () => {
  const r = evaluateQualityPolicy([
    { id: 'min_quality', params: { min: 'standard' } },
    { id: 'max_size', params: { maxMb: 9999, to: 'standard' } },
  ], SONG, { haveArtist: ['林俊杰'] });
  assert.equal(r.action, 'keep');
  assert.equal(r.ruleId, null);
  assert.equal(r.reason, '');
});

// ── 规则表完备性（新增规则漏登记要红）──────────────────

test('规则表完备性：每个已登记规则都被求值器真正实现（漏实现会红）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/qualityPolicy.js'), 'utf8');
  for (const id of QUALITY_RULE_IDS) {
    assert.ok(src.includes(`case '${id}'`), `规则 ${id} 已登记但求值器里没有对应分支`);
  }
});

test('规则表完备性：求值器里的每个 case 都在规则表中登记（漏登记会红）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/qualityPolicy.js'), 'utf8');
  const cases = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  for (const c of cases) {
    assert.ok(QUALITY_RULES[c], `求值器实现了 ${c}，但规则表未登记`);
  }
});

test('规则表完备性：登记的 action 只有 skip/demote', () => {
  for (const [id, spec] of Object.entries(QUALITY_RULES)) {
    assert.ok(['skip', 'demote'].includes(spec.action), `${id} 的 action 非法: ${spec.action}`);
  }
});

// ── 自检：判据对「退回错误写法」确实会红 ────────────────

test('自检：门槛判据对"用 <= 代替 <"会红（边界必须放行）', () => {
  const r = evaluateQualityPolicy([{ id: 'min_quality', params: { min: 'hq' } }], { ...SONG, quality: 'hq' });
  assert.equal(r.action, 'keep', '等于门槛应放行');
});

test('自检：体积判据对"忘了 *1024 换算"会红', () => {
  const est = estimateSizeMb(240, 'hq');
  assert.ok(est < 100, `240s hq 不可能是 ${est}MB —— 换算写错时会得到 9.375`);
});
