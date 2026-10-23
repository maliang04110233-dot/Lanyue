/**
 * 单元测试：换源参数化（allowToggleSource / onToggleSource / isRefresh）
 *
 * 背景（见 docs/design/P0-fallback-params.md）：
 *   这三个参数来自 GitHub 项目 spotube。Lanyue 已有对应的隐式机制，
 *   本轮把**隐式行为显式化**：
 *     · allowToggleSource ⇒ 覆盖跨源换源总开关（原本只有全局 prefs 一档）
 *     · onToggleSource    ⇒ 换源事件回调（原本只有结果对象上的字段，
 *                            程序化消费方如 MCP 工具 / AI 助手拿不到事件）
 *     · isRefresh         ⇒ 跳过 _altSource 记忆，强制重新解析
 *
 * 与既有测试的关系：test/resolveTrackService.test.js 已钉住**全局开关**的
 * 三条边界（关闭不搜候选 / 关闭时记忆失效 / 本源成功不受影响）。
 * 本文件钉的是**单次调用的覆盖**：它是叠加在全局开关之上的第二档，
 * 不是替代 —— 所以这里既有「覆盖生效」也有「覆盖不能突破全局语义」的用例。
 *
 * 全部用桩注入：不触网、不加载 8 个平台。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createResolveTrackService } = require('../src/api/services/resolveTrackService');

// ── 测试替身 ──────────────────────────────────────────────

function makeHealth(rankFn) {
  const calls = [];
  return {
    calls,
    recordResult: (s, ok) => calls.push([s, !!ok]),
    rankByHealth: rankFn || ((a) => a),
  };
}

const okResult = (extra = {}) => ({ url: 'https://cdn/x.mp3', ext: 'mp3', ...extra });
const failResult = (code = 'VIP_REQUIRED') => ({ error: '没有音源', code });

function makeGetUrl(map) {
  const calls = [];
  const fn = async (id, source) => {
    calls.push([source, String(id)]);
    const key = `${source}:${id}`;
    if (!(key in map)) return { error: `未知数据源: ${source}`, code: 'UNKNOWN_SOURCE' };
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}

const SONG = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };

function build(map, opts = {}) {
  const health = opts.health || makeHealth();
  const getUrl = makeGetUrl(map);
  const svc = createResolveTrackService({
    getUrl,
    searchFn: opts.searchFn || (async () => []),
    hasCookie: opts.hasCookie || (() => false),
    findCandidates: opts.findCandidates || (async () => []),
    sourceHealth: health,
    ...(opts.probeUrl ? { probeUrl: opts.probeUrl } : {}),
    ...(opts.fallbackEnabled ? { fallbackEnabled: opts.fallbackEnabled } : {}),
  });
  return { svc, health, getUrl };
}

/** 记忆路径用的歌：带 _altSource */
const SONG_WITH_ALT = { ...SONG, _altSource: { source: 'kuwo', id: 'K9' } };

// ══════════════════════════════════════════════════════════
// A. allowToggleSource —— 单次调用覆盖全局开关
// ══════════════════════════════════════════════════════════

test('allowToggleSource=false：全局开关开着也不换源（覆盖生效）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: false });
  assert.ok(!r.url, '不该拿到 URL');
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']], '只应尝试本源');
});

test('allowToggleSource=false：_altSource 记忆同样失效（与全局开关同口径）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:K9': okResult() },
    { fallbackEnabled: () => true },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard', { allowToggleSource: false });
  assert.ok(!r.url);
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']], '记忆路径也必须被覆盖挡住');
});

test('allowToggleSource=true：全局开关关着也能换源（覆盖反向生效）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => false,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: true });
  assert.ok(r.url, '覆盖为 true 时应能换源');
  assert.strictEqual(r.source, 'kuwo');
  assert.ok(getUrl.calls.length >= 2, '应尝试过本源与候选');
});

test('allowToggleSource 未传：行为与今天逐字一致（回归守卫）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.ok(r.url, '未传 options 时应与改造前一样换源');
  assert.strictEqual(r.source, 'kuwo');
});

test('allowToggleSource 传 null：按「未传」处理（不得被当成 false 而悄悄关掉换源）', async () => {
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: null });
  assert.ok(r.url, 'null 必须是「未指定」而不是 false');
});

test('allowToggleSource 传脏值（字符串/数字）：按「未传」处理，不炸', async () => {
  for (const bad of ['false', 0, '', NaN, {}]) {
    const { svc } = build(
      { 'netease:1': failResult(), 'kuwo:9': okResult() },
      {
        fallbackEnabled: () => true,
        findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
      },
    );
    const r = await svc.resolve(SONG, 'standard', { allowToggleSource: bad });
    assert.ok(r.url, `脏入参 ${JSON.stringify(bad)} 不得关掉换源`);
  }
});

test('allowToggleSource=false：本源成功不受影响（开关只管跨源）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': okResult() },
    { fallbackEnabled: () => true },
  );
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: false });
  assert.ok(r.url, '本源成功时不该被换源开关影响');
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']]);
});

// ══════════════════════════════════════════════════════════
// B. onToggleSource —— 换源事件回调
// ══════════════════════════════════════════════════════════

test('onToggleSource：跨源换源成功时被调用一次，含 from/to', async () => {
  const events = [];
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  await svc.resolve(SONG, 'standard', { onToggleSource: (e) => events.push(e) });
  assert.strictEqual(events.length, 1, '只换了一次源');
  assert.strictEqual(events[0].type, 'toggled');
  assert.strictEqual(events[0].from, 'netease');
  assert.strictEqual(events[0].to, 'kuwo');
});

test('onToggleSource：记忆路径换源也算切换（事件必须触发）', async () => {
  const events = [];
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:K9': okResult() },
    { fallbackEnabled: () => true },
  );
  await svc.resolve(SONG_WITH_ALT, 'standard', { onToggleSource: (e) => events.push(e) });
  assert.strictEqual(events.length, 1, '记忆路径也是一次换源');
  assert.strictEqual(events[0].from, 'netease');
  assert.strictEqual(events[0].to, 'kuwo');
});

test('onToggleSource：本源成功时不调用（不制造噪音）', async () => {
  const events = [];
  const { svc } = build(
    { 'netease:1': okResult() },
    { fallbackEnabled: () => true },
  );
  await svc.resolve(SONG, 'standard', { onToggleSource: (e) => events.push(e) });
  assert.strictEqual(events.length, 0, '没换源就不该有事件');
});

test('onToggleSource：全候选失败时不调用（没真的切换）', async () => {
  const events = [];
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:9': failResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  await svc.resolve(SONG, 'standard', { onToggleSource: (e) => events.push(e) });
  assert.strictEqual(events.length, 0, '没换成功就不该有事件');
});

test('onToggleSource 抛错：取流仍成功（回调是观察者，不是控制者）', async () => {
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard', {
    onToggleSource: () => { throw new Error('回调炸了'); },
  });
  assert.ok(r.url, '回调抛错不得让歌播不出来');
  assert.strictEqual(r.source, 'kuwo');
});

test('onToggleSource 未传：无异常（零回归）', async () => {
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:9': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'kuwo', id: '9', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.ok(r.url);
});

// ══════════════════════════════════════════════════════════
// C. isRefresh —— 跳过 _altSource 记忆，强制重新解析
// ══════════════════════════════════════════════════════════

test('isRefresh=true：跳过 _altSource 记忆，直接走本源', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': okResult(), 'kuwo:K9': okResult() },
    { fallbackEnabled: () => true },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard', { isRefresh: true });
  // 注意：本源成功时结果里**没有** source 字段（normalizeTrackResult 只透传
  // url/ext，source 只在换源路径上被写入）—— 所以用取流调用序列断言，
  // 而不是断言 r.source。
  assert.ok(r.url, '本源应成功');
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']], '记忆路径不应被尝试');
});

test('isRefresh 未传：记忆路径照旧生效（回归守卫）', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:K9': okResult() },
    { fallbackEnabled: () => true },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard');
  assert.strictEqual(r.source, 'kuwo', '未传 isRefresh 时记忆照旧生效');
  assert.deepStrictEqual(getUrl.calls, [['kuwo', 'K9']]);
});

test('isRefresh=true：记忆路径失败后仍会走跨源候选（不是彻底禁掉换源）', async () => {
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:K9': failResult(), 'qq:8': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'qq', id: '8', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard', { isRefresh: true });
  assert.strictEqual(r.source, 'qq', '记忆失效后应照常换源');
});

test('isRefresh 传 true 之外的值：按未传处理（不跳过记忆）', async () => {
  const { svc } = build(
    { 'netease:1': failResult(), 'kuwo:K9': okResult() },
    { fallbackEnabled: () => true },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard', { isRefresh: 'yes' });
  assert.strictEqual(r.source, 'kuwo');
});

test('isRefresh 与 allowToggleSource=false 叠加：记忆与候选都被挡，只走本源', async () => {
  const { svc, getUrl } = build(
    { 'netease:1': failResult(), 'kuwo:K9': okResult(), 'qq:8': okResult() },
    {
      fallbackEnabled: () => true,
      findCandidates: async () => [{ source: 'qq', id: '8', title: '测试曲' }],
    },
  );
  const r = await svc.resolve(SONG_WITH_ALT, 'standard', {
    isRefresh: true,
    allowToggleSource: false,
  });
  assert.ok(!r.url);
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']]);
});
