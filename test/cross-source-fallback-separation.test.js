/**
 * 守卫：聚合「跨源建议」与下载链路「自动兜底换源」是两个独立概念（P-11）
 *
 * 这两个东西在产品文档里都叫「换源」，长期被当成同一件事，于是有两种
 * 相反的错误改法：有人会去改 fallbackPolicy.crossSourceEnabled 来"关掉
 * 聚合里的重复建议"，也有人会因为它是关的就以为聚合建议也没了。
 * 两者一旦被合并，其中一边必然被误伤。
 *
 * 事实（本文件逐行核过，2026-09-30）
 * ------------------------------------------------
 * 开关的读者只有一处调用链，且在**下载/播放的取流服务**里：
 *   api/index.js:142        require('./services/fallbackPolicy')
 *   api/index.js:158        fallbackEnabled: crossSourceEnabled   ← 注入
 *   resolveTrackService.js:178  function crossSourceOn()
 *   resolveTrackService.js:260  if (crossSourceOn() && alt && ...)  ← 唯一真判
 *   resolveTrackService.js:280  if (!crossSourceOn() || !shouldFallback...)
 *   fallbackPolicy.js:30    function crossSourceEnabled() { return false; }
 *
 * 聚合链上**没有一处**读它：
 *   utils/crossSourceAggregate.js:44  只 require('./matchMusic') 的纯文本归一
 *   ipc/playlist.js:141  pickRepresentative(members, loggedIn)
 *                       第二个参数是 cookieStore 的登录态集合，与 fallbackPolicy 无关
 *   views/aggregate.js:110  s._primary === false → 提示「换用另一条」
 *   渲染层全仓 grep `fallbackEnabled` 零命中
 *
 * 所以 fallbackPolicy.js:30 的 `return false` 关掉的只是**下载/播放取流**时的
 * 自动兜底；3-B 聚合页的代表条目建议与它无关，v1.0.35 保持该开关关闭时
 * 聚合建议照常显示。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// ── 1. 开关仍然关闭（产品口径未变） ───────────────────

test('自动兜底换源仍是关闭状态', () => {
  const { crossSourceEnabled } = require('../src/api/services/fallbackPolicy');
  assert.equal(crossSourceEnabled(), false,
    '本版不开自动兜底换源；真要打开请走产品决策并同步更新本文件');
});

// ── 2. 聚合链不读该开关 ───────────────────────────────

test('聚合模块不 import fallbackPolicy（不依赖自动换源开关）', () => {
  const body = read('src/utils/crossSourceAggregate.js');
  const requires = [...body.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(!requires.some((r) => /fallbackPolicy|fallback-notice/.test(r)),
    `聚合模块不应依赖自动换源开关，实际 require: ${requires.join(', ')}`);
});

test('聚合 IPC handler 不引用 crossSourceEnabled / fallbackEnabled', () => {
  const body = read('src/main/ipc/playlist.js');
  assert.ok(!/crossSourceEnabled|fallbackEnabled/.test(body),
    'aggregate-cross-source 的代表条目挑选与自动换源开关无关');
});

test('渲染层聚合视图不引用 fallbackEnabled', () => {
  const body = read('src/renderer/js/views/aggregate.js');
  assert.ok(!/fallbackEnabled/.test(body),
    '聚合页的「换用另一条」提示不应被自动换源开关控制');
});

// ── 3. 行为层：开关关闭时聚合建议照常产出 ───────────────

test('行为：crossSourceEnabled() 为 false 时，聚合仍选出代表条目并给出建议', () => {
  const { crossSourceEnabled } = require('../src/api/services/fallbackPolicy');
  const { aggregateAcrossSources, pickRepresentative } = require('../src/utils/crossSourceAggregate');

  assert.equal(crossSourceEnabled(), false, '前提：自动换源是关的');
  const songs = [
    { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000 },
    { id: '9', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 },
  ];
  const r = aggregateAcrossSources([{ source: 'netease', songs: [songs[0]] },
    { source: 'qq', songs: [songs[1]] }]);
  const cross = r.songs.filter((s) => s._crossSource);
  assert.equal(cross.length, 2, '跨源同曲应被标出');
  const rep = pickRepresentative(cross, new Set());
  assert.ok(rep, '代表条目必须选得出来——它驱动「换用另一条」提示');
  // 登录态集合空 ⇒ 退化为「时长已知优先 + 原顺序」，与开关无关
  assert.equal(rep.source, 'netease');
  assert.equal(cross.length - 1, 1, '另一条应被判为非代表，聚合页据此提示「换用另一条」');
});

// ── 4. 开关的读者仍然只有取流服务 ─────────────────────

test('crossSourceOn() 的调用点仍只在 resolveTrackService 的取流路径里', () => {
  const body = read('src/api/services/resolveTrackService.js');
  const hits = [...body.matchAll(/crossSourceOn\(\)/g)].length;
  // 定义处 1 次 + 260 行 + 280 行两处判读
  assert.equal(hits, 3, `crossSourceOn() 出现 ${hits} 次，调用点变了需要重新评估本文件`);
});

test('fallbackPolicy 的 crossSourceEnabled 仍只被 api/index.js 注入', () => {
  const body = read('src/api/index.js');
  assert.match(body, /fallbackEnabled:\s*crossSourceEnabled/,
    '注入点消失了，取流服务将退回缺省「开」——这会让本版悄悄开始自动换源');
});
