/**
 * 守卫：判据不全的跨源条目不得静默（3-B 缺口 1）
 *
 * 问题
 * ----
 * `isCrossSourceSameSong` 要求三条件齐备：歌名 + 歌手 + 时长。
 * 实际有两个平台满足不了：
 *   · fivesing / migu —— 搜索接口不返回时长，`duration` 恒为 0
 *     （见 src/api/platforms/fivesing.js:124、migu.js:89，两处都写着这个事实）
 *   · 部分平台分享链接产生的条目 —— 缺歌手字段
 *
 * 这些条目**不会**被标成跨源重复（判据不全 ⇒ 判不了 ⇒ 不标）。
 * 界面上没有任何提示，于是用户看到"咪咕这首没重复"，实际含义是
 * "咪咕这条根本没参与判定"。歌一条不少地躺在列表里，用户会以为该平台没有这首歌。
 *
 * 这份守卫钉的是**行为**（跑真聚合器看输出），不是源码文本。
 * 判定口径在 utils 层，出错时渲染层照样绿一片。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  aggregateAcrossSources,
  hasKnownDuration,
  undecidableReason,
  DURATION_TOLERANCE_MS,
} = require('../src/utils/crossSourceAggregate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 一首歌（duration 单位：毫秒；0 表示平台不提供时长） */
const s = (source, id, title, artist, duration) => ({
  source, id: String(id), title, artist, duration,
});

// ── 1. 基元 ───────────────────────────────────────────

test('hasKnownDuration：0 / 缺失 / 非数都算未知，真实毫秒值算已知', () => {
  assert.equal(hasKnownDuration(s('migu', '1', '晴天', '周杰伦', 269000)), true);
  assert.equal(hasKnownDuration(s('migu', '1', '晴天', '周杰伦', 0)), false, 'fivesing/migu 恒为 0');
  assert.equal(hasKnownDuration({ duration: undefined }), false);
  assert.equal(hasKnownDuration({ duration: null }), false);
  assert.equal(hasKnownDuration({ duration: 'abc' }), false);
  assert.equal(hasKnownDuration({ duration: -1000 }), false, '负时长不是已知时长');
  assert.equal(hasKnownDuration(null), false);
});

test('undecidableReason：分清"判不了"与"判出来不同"', () => {
  assert.equal(undecidableReason(s('qq', '1', '晴天', '周杰伦', 269000)), null, '判据齐备 ⇒ 不属此类');
  assert.equal(undecidableReason(s('migu', '1', '晴天', '周杰伦', 0)), 'duration');
  assert.equal(undecidableReason(s('migu', '1', '晴天', '', 0)), 'duration', '两项都缺，时长先报');
  assert.equal(undecidableReason(s('migu', '1', '晴天', '', 269000)), 'artist');
  assert.equal(undecidableReason(null), null);
});

test('两个真实平台插件确实不返回时长（守卫的是现状，不是假设）', () => {
  for (const f of ['fivesing', 'migu']) {
    const src = read(`src/api/platforms/${f}.js`);
    assert.match(src, /duration:\s*0\s*,?\s*\/\/\s*搜索接口不返回时长/,
      `${f}.js 不再是「搜索不返回时长」，本守卫的前提变了，需要重新评估 _undecidable 的触发面`);
  }
});

// ── 2. 聚合输出：判不了的必须被显式回报 ────────────────

test('缺时长的跨源同名条目被标 _undecidable，stats 计数一致', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'migu', songs: [s('migu', '2', '晴天', '周杰伦', 0)] },
  ]);
  const migu = r.songs.find((x) => x.source === 'migu');
  const netease = r.songs.find((x) => x.source === 'netease');

  assert.equal(migu._undecidable, 'duration', '缺时长必须被标记');
  assert.equal(r.stats.undecidable, 1);

  // 否定对照：判据齐备的那一侧不属于"判不了"
  assert.equal(netease._undecidable, undefined);
  // 缺时长的那侧仍不得被标成跨源重复 —— 判据不全不能拿来当同曲证据
  assert.equal(migu._crossSource, undefined, '缺时长不构成同曲证据');
  assert.equal(r.stats.duplicates, 0, '时长差无从比较，不能算重复');
});

test('缺歌手的跨源同名条目标 _undecidable=artist', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '2', '晴天', '', 269000)] },
  ]);
  const qq = r.songs.find((x) => x.source === 'qq');
  assert.equal(qq._undecidable, 'artist');
  assert.equal(r.stats.undecidable, 1);
  assert.equal(r.stats.duplicates, 0);
});

test('判据齐备的同曲仍照常标重复，且不带 _undecidable', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '2', '晴天', '周杰伦', 270000)] },
  ]);
  for (const x of r.songs) {
    assert.equal(x._crossSource, true, '5s 容差内应标重复');
    assert.equal(x._undecidable, undefined, '判据齐备不该被混进"判不了"');
  }
  assert.equal(r.stats.undecidable, 0);
  assert.equal(r.stats.duplicates, 2);
});

test('判据齐备但确实不同曲（伴奏版）不带 _undecidable —— 判出来 ≠ 判不了', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '2', '晴天', '周杰伦', 140000)] },
  ]);
  for (const x of r.songs) {
    assert.equal(x._crossSource, undefined, '时长差远超容差，不是同曲');
    assert.equal(x._undecidable, undefined,
      '判据齐全地判出"不是同一首"，不能报成"无法判定"，否则用户会去查一个不存在的毛病');
  }
  assert.equal(r.stats.undecidable, 0);
  assert.equal(r.songs.length, 2);
});

test('无跨源同名候选时不产生任何 _undecidable（避免满屏提示）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'migu', songs: [s('migu', '2', '稻香', '周杰伦', 0)] },
  ]);
  assert.equal(r.stats.undecidable, 0, '歌名都对不上，谈不上"无法判定是否同一首"');
  for (const x of r.songs) assert.equal(x._undecidable, undefined);
});

test('同一平台的多个缺时长条目：彼此之间不算跨源候选', () => {
  // 同源两条都缺时长 ⇒ 用户本来就分不清，不该再被告知"无法判定"
  const solo = aggregateAcrossSources([{
    source: 'migu',
    songs: [s('migu', '1', '晴天', '周杰伦', 0), s('migu', '2', '晴天', '周杰伦', 0)],
  }]);
  assert.equal(solo.stats.undecidable, 0, '只有一个源时不存在跨源重复问题');
  for (const x of solo.songs) assert.equal(x._undecidable, undefined);

  // 同一批 migu 条目 + qq 有同名的已知时长条目 ⇒ migu 侧确实存在潜在重复
  const withQq = aggregateAcrossSources([
    { source: 'migu', songs: [s('migu', '1', '晴天', '周杰伦', 0), s('migu', '2', '晴天', '周杰伦', 0)] },
    { source: 'qq', songs: [s('qq', '3', '晴天', '周杰伦', 269000)] },
  ]);
  const migu = withQq.songs.filter((x) => x.source === 'migu');
  assert.equal(withQq.stats.undecidable, 2, 'qq 侧有已知时长 ⇒ migu 侧确实存在潜在重复');
  assert.ok(migu.every((x) => x._undecidable === 'duration'));
  assert.equal(withQq.stats.duplicates, 0, '缺时长的两条不互证，也不与 qq 构成同曲');
  assert.equal(withQq.songs.find((x) => x.source === 'qq')._undecidable, undefined);
});

test('markDuplicates=false 时不做任何判定，连 _undecidable 也不给', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'migu', songs: [s('migu', '2', '晴天', '周杰伦', 0)] },
  ], { markDuplicates: false });
  assert.equal(r.stats.undecidable, 0);
  assert.equal(r.songs.find((x) => x.source === 'migu')._undecidable, undefined);
});

test('容差常量仍是 5s（_undecidable 的前提是这个判据存在）', () => {
  assert.strictEqual(DURATION_TOLERANCE_MS, 5000);
});

// ── 3. 界面必须把这件事说出来 ─────────────────────────

test('聚合页：有 _undecidable 时逐行点明 + 统计栏给总数', () => {
  const VIEW = read('src/renderer/js/views/aggregate.js');
  assert.match(VIEW, /_aggRowHtml[\s\S]*?_undecidable/, '行渲染未消费 _undecidable');
  assert.match(VIEW, /_aggStatBar[\s\S]*?undecidable/, '统计栏未统计 undecidable');
  assert.match(VIEW, /aggregate\.undecidableBadge/, '行内未用 undecidableBadge 文案');
  assert.match(VIEW, /aggregate\.undecidableSome/, '统计栏未用 undecidableSome 文案');
});

test('文案：双语齐备、占位符一致、英文不含中文', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const keys = [
    'aggregate.undecidableBadge',
    'aggregate.undecidableRowHint',
    'aggregate.undecidableSome',
    'aggregate.undecidableHint',
  ];
  const ph = (x) => (String(x).match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []).sort();
  for (const k of keys) {
    assert.equal(typeof zh[k], 'string', `zh 缺 ${k}`);
    assert.equal(typeof en[k], 'string', `en 缺 ${k}`);
    assert.ok(zh[k].trim().length && en[k].trim().length, `${k} 有空串`);
    assert.deepEqual(ph(zh[k]), ph(en[k]), `${k} 占位符双语不一致`);
    assert.ok(!/[\u4e00-\u9fff]/.test(en[k]), `en 的 ${k} 含中文: ${en[k]}`);
  }
  assert.match(zh['aggregate.undecidableRowHint'], /没有时长|缺少时长|未提供时长/,
    '行内提示要落在"缺时长/缺歌手"这件事上，而不是泛泛说无法比较');
  assert.match(zh['aggregate.undecidableSome'], /时长或歌手/,
    '统计栏的原因列举要覆盖 duration 与 artist 两种，只说"该源未提供时长"会把缺歌手的条目说错');
  assert.ok(!/该源未提供时长/.test(zh['aggregate.undecidableSome']),
    '统计栏无法区分是哪一条的原因，不能断言成因是时长');
});

test('文案说的是「既没标重复也没丢弃」，不能暗示歌曲不存在', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const h = zh['aggregate.undecidableRowHint'];
  assert.match(h, /不会被标成重复|未被丢弃|没有丢弃/, '要点明这些条目仍在列表里');
  assert.ok(!/该平台没有|此源没有|不包含这首/.test(h + zh['aggregate.undecidableHint']),
    '文案不能让用户以为该平台没有这首歌');
});
