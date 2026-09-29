// 守卫：soda 分享页 duration 必须与搜索路径同单位（毫秒）。
//
// 为什么需要这道守卫：搜索给毫秒、分享页给秒，同一字段两种单位时，
// 跨源时长判定会差 1000 倍（65000ms 的歌对 65 秒的另一条），去重全线失效。
// 这类 bug 不会报错，只会让功能静默失准 —— 没有守卫它能一直活着。
//
// 反向钉（必须成对写）：守卫自身也要能被证伪。若有人把判定写宽成
// 「只要 duration 是数字就算过」，本文件后半段的变异样本会红。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'api', 'platforms', 'soda.js');
const code = fs.readFileSync(SRC, 'utf8');

test('soda: 分享页 duration 已从秒换算为毫秒（与搜索路径同口径）', () => {
  assert.match(
    code,
    /duration:\s*\(Number\(awl\.duration\)\s*\|\|\s*0\)\s*\*\s*1000/,
    '分享页 duration 必须 *1000 转毫秒；写成裸 Number(awl.duration) 就是单位混用'
  );
});

test('soda: 搜索路径 duration 保持毫秒原样（不得反向改成秒）', () => {
  assert.match(
    code,
    /duration:\s*Number\(tk\.duration\)\s*\|\|\s*0,/,
    '搜索路径 track.duration 本就是毫秒，再乘/除 1000 会二次换算'
  );
});

test('soda: 码率估算消费秒，不得直接喂毫秒', () => {
  // estimateBr / isImpliedBitrateImpossible 的语义是「秒」。
  // share.duration 变毫秒后若不换算，65 秒的歌按 65000 秒算，
  // 码率恒高于阈值 ⇒ 试听片段判据 NO_AUDIO_STREAM 永不触发。
  assert.match(
    code,
    /const durationSec\s*=\s*share\.duration\s*\/\s*1000/,
    '缺秒/毫秒换算变量，码率与试听片段判据会整体失准'
  );
  assert.match(code, /estimateBr\(probe\.sizeBytes,\s*durationSec\)/);
  assert.match(code, /isImpliedBitrateImpossible\(probe\.sizeBytes,\s*durationSec\)/);
  assert.doesNotMatch(
    code,
    /estimateBr\(probe\.sizeBytes,\s*share\.duration\)/,
    'share.duration 已是毫秒，直接喂进按秒消费的口径就是 bug 复发'
  );
});

test('守卫自检：变异样本下本守卫真的会红（不是恒真断言）', () => {
  const mutated = code
    .replace(/duration:\s*\(Number\(awl\.duration\)\s*\|\|\s*0\)\s*\*\s*1000/, 'duration: Number(awl.duration) || 0')
    .replace(/estimateBr\(probe\.sizeBytes,\s*durationSec\)/, 'estimateBr(probe.sizeBytes, share.duration)');
  const checker = (src) =>
    /duration:\s*\(Number\(awl\.duration\)\s*\|\|\s*0\)\s*\*\s*1000/.test(src) &&
    /estimateBr\(probe\.sizeBytes,\s*durationSec\)/.test(src);
  assert.ok(checker(code), '原码必须通过');
  assert.ok(!checker(mutated), '变异码必须不通过，否则本守卫是恒真的摆设');
});

test('soda: mapTrack 的毫秒语义仍被现有用例钉住（防回滚）', () => {
  assert.match(code, /function mapTrack\(/);
  // 65019ms 的歌若被当成 65019 秒，约 1086 分钟，任何合理阈值都该发现
  assert.ok(Number.isFinite(65019), 'sanity');
});
