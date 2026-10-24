/**
 * 守卫：006 跨源搜索合并的排序与版别标记（纯函数层）
 *
 * orderMergedResults 的两条铁律：
 *   1. 簇在「代表首次出现处」整块输出，代表永远排在本簇最前
 *      ——代表如果排在成员之后，用户看到的第一条就是"建议换用另一条"的那条。
 *   2. 非簇成员的相对顺序不变（合并不能顺手重排无关结果）
 * markVariants 的三条边界：
 *   · 家族有正主（并簇）⇒ 簇外已知时长成员标 _variant
 *   · 缺时长的成员不标（_undecidable 是它的通道，叠标会把「不知道」
 *     伪装成「另一种版本」）
 *   · 单条家族不标（同名不同曲的独立歌不该被暗示是某版的变体）
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  aggregateAcrossSources,
  orderMergedResults,
  markVariants,
  songKey,
} = require('../src/utils/crossSourceAggregate');

/** 造一首歌（毫秒时长，与全仓口径一致） */
function song(source, id, title, artist, duration, extra = {}) {
  return { source, id, title, artist, duration, ...extra };
}

/** 跑完整链：聚合标记 → 版别标记 → 合并排序（与 api 层 'all' 分支同序） */
function mergeAll(groups, loggedIn) {
  const r = aggregateAcrossSources(groups);
  markVariants(r.songs);
  return { songs: orderMergedResults(r.songs, loggedIn), stats: r.stats };
}

test('合并排序：代表排在本簇最前，块在代表首次出现处，非簇成员原位', () => {
  // nc 在 qq 之前返回；qq 已登录 ⇒ 代表应是 qq 条目
  const groups = [
    { source: 'nc', songs: [song('nc', 1, '晴天', '周杰伦', 269000), song('nc', 2, '七里香', '周杰伦', 269000)] },
    { source: 'qq', songs: [song('qq', 'a', '晴天', '周杰伦', 269000)] },
  ];
  const { songs } = mergeAll(groups, ['qq']);

  // 簇块应在 nc:1（首次出现）处：qq 代表在前、nc 成员随后；七里香保持原位在后
  assert.deepEqual(
    songs.map((s) => songKey(s)),
    ['qq␟a', 'nc␟1', 'nc␟2'],
    '代表(qq)应排本簇最前，簇块落在成员首次出现处，无关条目不被重排'
  );
  const rep = songs.find((s) => songKey(s) === 'qq␟a');
  const member = songs.find((s) => songKey(s) === 'nc␟1');
  assert.strictEqual(rep._primary, true, '代表 _primary=true');
  assert.strictEqual(member._primary, false, '非代表 _primary=false');
  assert.strictEqual(songs.find((s) => songKey(s) === 'nc␟2')._primary, undefined,
    '非簇成员不带 _primary（区别于 false，避免界面误降透明度）');
});

test('合并排序：未传登录态时退「时长已知 + 原序」仍成块（代表为首次出现者）', () => {
  const groups = [
    { source: 'nc', songs: [song('nc', 1, '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [song('qq', 'a', '晴天', '周杰伦', 269000)] },
  ];
  const { songs } = mergeAll(groups);
  assert.deepEqual(
    songs.map((s) => songKey(s)),
    ['nc␟1', 'qq␟a'],
    '无登录态差异时代表取先出现者，簇块位置不变'
  );
  assert.strictEqual(songs[0]._primary, true);
  assert.strictEqual(songs[1]._primary, false);
});

test('版别标记：同歌名同歌手但时长对不上 ⇒ 簇外成员标 _variant，正主不标', () => {
  const groups = [
    { source: 'nc', songs: [song('nc', 1, '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [
      song('qq', 'a', '晴天', '周杰伦', 269000),                  // 并簇正主
      song('qq', 'b', '晴天 (Live)', '周杰伦', 301000),           // 版别
      song('qq', 'c', '晴天 (伴奏)', '周杰伦', 139000),          // 版别（伴奏时长砍半）
    ] },
  ];
  const { songs } = mergeAll(groups);
  const byKey = new Map(songs.map((s) => [songKey(s), s]));
  assert.strictEqual(byKey.get('qq␟a')._variant, undefined, '正主不标版别');
  assert.strictEqual(byKey.get('qq␟b')._variant, true, 'Live 版标版别');
  assert.strictEqual(byKey.get('qq␟c')._variant, true, '伴奏版标版别');
});

test('版别标记：缺时长的成员不标（_undecidable 是它的通道，不得伪装成版别）', () => {
  const groups = [
    { source: 'nc', songs: [song('nc', 1, '晴天', '周杰伦', 269000)] },
    { source: 'mg', songs: [song('mg', 'x', '晴天', '周杰伦', 0)] }, // migu 无时长
  ];
  const { songs } = mergeAll(groups);
  const mg = songs.find((s) => songKey(s) === 'mg␟x');
  assert.strictEqual(mg._variant, undefined, '缺时长不标版别');
  assert.strictEqual(mg._undecidable, 'duration', '缺时长走 undecidable 通道');
});

test('版别标记：单条家族不标（独立歌不是任何版本的变体）', () => {
  const r = aggregateAcrossSources([
    { source: 'nc', songs: [song('nc', 1, '孤勇者', '陈奕迅', 265000)] },
  ]);
  markVariants(r.songs);
  assert.strictEqual(r.songs[0]._variant, undefined, '单条家族不标');
});

test('版别标记：无正主但多条已知时长互不并簇 ⇒ 互为版别', () => {
  // 三个源各一条，时长两两差超 5s：谁也不并簇，但确实互为版别
  const r = aggregateAcrossSources([
    { source: 'nc', songs: [song('nc', 1, '童话镇', '陈一发儿', 268000)] },
    { source: 'qq', songs: [song('qq', 'a', '童话镇 (Live)', '陈一发儿', 295000)] },
  ]);
  markVariants(r.songs);
  assert.ok(r.songs.every((s) => s._variant === true), '无正主时已知时长成员互为版别');
});
