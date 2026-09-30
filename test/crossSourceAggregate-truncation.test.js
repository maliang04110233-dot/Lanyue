/**
 * 守卫：单源取数上限不得静默截断（D-30）
 *
 * 问题
 * ----
 * 本版不做跨平台分页，平台歌单一律按 2000 首取。超出的部分不会进入聚合结果，
 * 用户因此看到的是一个**子集**。如果界面上对此一言不发，用户会把它当成
 * 「这个源只有这么多收藏」——这不是显示细节，是数据完整性问题。
 *
 * 判据为什么要挂在 opts.fetched 上（而不是数结果条数）
 * --------------------------------------------------
 * 本地红心走 userPlaylists，没有这个上限。恰好 2000 首时什么都没被截掉，
 * 却会被「结果里有 2000 首 ⇒ 报截断」这种写法永久贴上"仅显示前 2000 首"。
 * 一条常驻的假话比不说更糟：它会训练用户忽略所有截断提示。
 * 所以上限由**调用方登记事实**，聚合层不猜。
 *
 * 三个信号必须分开（粒度错一次，提示就互相掩护）
 *   failed      源级，这次没拿到数据
 *   truncated   源级，拿到了但不全
 *   _undecidable 条目级，数据全但判据不齐
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  aggregateAcrossSources,
  isSourceTruncated,
  markTruncation,
  SOURCE_FETCH_LIMIT,
} = require('../src/utils/crossSourceAggregate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 一首歌（duration 单位：毫秒） */
const s = (source, id, title, artist, duration) => ({
  source, id: String(id), title, artist, duration: duration == null ? 200000 : duration,
});

/** 造 n 首同源歌（歌名各不相同，避免被判成跨源重复） */
const many = (source, n) => Array.from({ length: n }, (_, i) =>
  s(source, i + 1, `曲目 ${i + 1}`, '歌手', 180000 + i * 1000));

// ── 1. 判据本身 ───────────────────────────────────────

test('触达上限才报截断，且 limit 取自调用方登记（不是写死 2000）', () => {
  const songs = many('qq', 3);
  // limit=3 传 3 条必须判真：这一条专治「写死 2000」的实现
  assert.equal(isSourceTruncated('qq', songs, { fetched: { qq: 3 } }), true,
    'limit 取实际传入值时，3/3 应判真');
  assert.equal(isSourceTruncated('qq', songs, { fetched: { qq: 4 } }), false,
    '未触达上限不报');
  assert.equal(isSourceTruncated('qq', many('qq', 4), { fetched: { qq: 4 } }), true,
    '触达上限（4/4）应判真');
});

test('本地红心（未登记上限）不报截断 —— 恰好 2000 首也不是被截断', () => {
  const songs = many('netease', SOURCE_FETCH_LIMIT);
  assert.equal(isSourceTruncated('netease', songs, { fetched: {} }), false,
    '红心不走上限路径，2000 首是它的全部，没截断任何东西');
  assert.equal(isSourceTruncated('netease', songs, {}), false, '无 fetched 参数时一律不报');
  assert.equal(isSourceTruncated('netease', songs, { fetched: { qq: 2000 } }), false,
    '别的源触顶不应牵连到没登记的源');
});

test('无效 limit（0 / 负数 / 非数）不报截断', () => {
  const songs = many('qq', 3);
  for (const bad of [0, -1, NaN, Infinity, 'abc', null, undefined]) {
    assert.equal(isSourceTruncated('qq', songs, { fetched: { qq: bad } }), false,
      `limit=${String(bad)} 不是有效上限，不该报截断`);
  }
});

test('markTruncation 按源分别判定，且不与 failed 混用', () => {
  const songs = [...many('qq', 3), ...many('kugou', 2)];
  const r = markTruncation(songs, { fetched: { qq: 3, kugou: 5 } });
  assert.deepEqual(r.truncated, { qq: 3 }, '只有 qq 触顶');
  assert.ok(!('failed' in r), 'truncated 不得复用 failed 键位 —— 一个是"不全"，一个是"没有"');
  assert.ok(!('songs' in r), 'markTruncation 只回报截断信息，不重带曲目');
});

test('聚合结果不夹带 failed 键（截断不是失败，混用会让两组提示互相掩护）', () => {
  const r = aggregateAcrossSources([{ source: 'qq', songs: many('qq', 3) }], { fetched: { qq: 3 } });
  assert.ok(!('failed' in r),
    '聚合器产出里出现 failed 键，说明截断被伪装成失败 —— '
    + '用户会去反复重登一个其实取到了 3 首的源，而真正的失败源反而被淹没');
  assert.deepEqual(Object.keys(r).sort(), ['songs', 'stats', 'truncated'],
    '聚合器的产出键就是这三个，多一个少一个都要说得清');
});

// ── 2. 走真聚合器，验证端到端 ──────────────────────────

test('聚合输出带 truncated，触顶源与非触顶源分开', () => {
  const r = aggregateAcrossSources(
    [{ source: 'qq', songs: many('qq', 3) }, { source: 'kugou', songs: many('kugou', 2) }],
    { fetched: { qq: 3, kugou: 5 } },
  );
  assert.deepEqual(r.truncated, { qq: 3 });
  assert.equal(r.songs.length, 5, '被截断的条目照样在列表里 —— 截断是"不全"，不是"丢弃"');
});

test('关闭重复标记时截断信息仍要回报（空/早退路径不能漏）', () => {
  const r = aggregateAcrossSources(
    [{ source: 'qq', songs: many('qq', 3) }],
    { markDuplicates: false, fetched: { qq: 3 } },
  );
  assert.deepEqual(r.truncated, { qq: 3 },
    'markDuplicates=false 的早退分支同样要算截断，否则"只看跨源重复"的用户会被隐瞒');
});

test('完全空结果不产生 truncated 键', () => {
  const r = aggregateAcrossSources([], { fetched: { qq: 2000 } });
  assert.deepEqual(r.truncated, {});
});

// ── 3. wiring：IPC 与界面必须真的用上 ──────────────────

test('IPC 聚合 handler 把拉取上限登记给聚合层（且不写死数字）', () => {
  const IPC = read('src/main/ipc/playlist.js');
  const i = IPC.indexOf("handle('aggregate-cross-source'");
  assert.ok(i > -1, '未注册 aggregate-cross-source');
  const body = IPC.slice(i, i + 4000);
  assert.match(body, /fetched\s*\[\s*src\s*\]\s*=\s*SOURCE_FETCH_LIMIT/,
    '平台歌单拉取成功后要登记上限，否则聚合层无从判断触顶');
  assert.match(body, /aggregateAcrossSources\(\s*groups\s*,\s*\{[^}]*fetched/s,
    'fetched 必须传给聚合器');
  assert.ok(!/fetched\s*\[\s*src\s*\]\s*=\s*2000/.test(body), '不要在 handler 里写死 2000');
});

test('红心分支不登记上限（红心没有截断这回事）', () => {
  const IPC = read('src/main/ipc/playlist.js');
  const i = IPC.indexOf("handle('aggregate-cross-source'");
  const body = IPC.slice(i, i + 4000);
  const favIdx = body.indexOf('bySource');
  assert.ok(favIdx > -1, '未找到红心分组逻辑');
  const favBlock = body.slice(favIdx, favIdx + 900);
  assert.ok(!/fetched\s*\[/.test(favBlock), '红心分组不得登记 fetched —— 登记了就是谎报上限');
});

test('平台歌单取数用的是共享常量，与聚合判据同源', () => {
  const IPC = read('src/main/ipc/playlist.js');
  assert.match(IPC, /getPlaylistSongs\(\s*platformIdOf\(source\)\s*,\s*playlistId\s*,\s*SOURCE_FETCH_LIMIT\s*\)/,
    '取数上限须引用 SOURCE_FETCH_LIMIT，写死 2000 会让判据与实际脱钩');
});

test('界面文案键齐备，且与 failed / undecidable 分开', () => {
  const VIEW = read('src/renderer/js/views/aggregate.js');
  assert.match(VIEW, /_aggState\.truncated|_aggState && _aggState\.truncated/,
    '渲染层要读 truncated');
  assert.match(VIEW, /aggregate\.truncatedSome/, '统计栏要出现截断提示');
  assert.match(VIEW, /aggregate\.truncatedHint/, '截断提示要有解释性 title');

  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  for (const k of ['aggregate.truncatedSome', 'aggregate.truncatedHint']) {
    assert.ok(zh[k], `zh.json 缺 ${k}`);
    assert.ok(en[k], `en.json 缺 ${k}`);
    assert.ok(!/完整收藏|全部收藏|所有收藏|complete collection|all favorites/i.test(zh[k] + en[k]),
      '截断提示里不得出现"完整收藏"这类正面宣传');
  }
  assert.notEqual(zh['aggregate.truncatedSome'], zh['aggregate.failedSome'],
    '截断与失败必须两句话，不能共用一条');
  assert.notEqual(zh['aggregate.truncatedSome'], zh['aggregate.undecidableSome'],
    '截断与无法判定必须两句话');
});

test('截断提示把上限值说清楚，不写「以最新版本为准」这类空话', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  assert.match(zh['aggregate.truncatedSome'], /\{n\}/, '文案要带实际上限数字');
  assert.match(zh['aggregate.truncatedSome'], /\{names\}/, '文案要点名是哪些源');
});

// ── 4. 真跑统计栏：文案必须真的出现在渲染结果里 ─────────
//
// 只 grep 源码的话，把 `if (cutNames.length)` 改成 `if (false)` 照样全绿
// ——键还在、代码还在，只有渲染结果里那行字消失了。
// 所以下面这段把 views/aggregate.js 拉进沙箱走它自己的渲染路径。

/**
 * 加载渲染模块并渲染一次统计栏，返回其 innerHTML。
 *
 * aggregate.js 拿不到真实 DOM 就什么也不渲染，所以这里给一个最小 mock：
 * bar.innerHTML 被赋值时，从里面把 aggregateStatBar 摘出来注册进 id 表，
 * 随后的 getElementById('aggregateStatBar') 就能拿到。
 */
async function renderStatBar(state, lang) {
  const vm = require('node:vm');
  const src = read('src/renderer/js/views/aggregate.js');
  const byId = {};
  const mk = (id) => ({ id, innerHTML: '', dataset: {}, querySelector: () => null });

  const bar = mk('aggregateBar');
  let statBar = null;
  Object.defineProperty(bar, 'innerHTML', {
    get() { return bar._html || ''; },
    set(v) {
      bar._html = v;
      const m = v.match(/<span id="aggregateStatBar">([\s\S]*?)<\/span>\s*$/);
      if (m) { statBar = mk('aggregateStatBar'); statBar.innerHTML = m[1]; }
    },
  });
  byId.aggregateBar = bar;
  byId.aggregateList = mk('aggregateList');

  const ctx = {
    console,
    logger: { warn() {} },
    platformName: (x) => x,
    esc: (x) => String(x == null ? '' : x),
    escAttr: (x) => String(x == null ? '' : x),
    t: (k, vars) => {
      let out = lang[k];
      if (out == null) return k;
      for (const [kk, vv] of Object.entries(vars || {})) out = out.split('{' + kk + '}').join(vv);
      return out;
    },
    api: { aggregateCrossSource: async () => state },
    window: {},
    document: {
      getElementById: (id) => (id === 'aggregateStatBar' ? statBar : byId[id] || null),
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  await ctx.loadAggregated();
  return statBar ? statBar.innerHTML : '';
}

const ZH = JSON.parse(read('src/renderer/js/lang/zh.json'));

test('统计栏真渲染：触顶源出现截断提示并带上实际条数与源名', async () => {
  const html = await renderStatBar({
    songs: [...many('qq', 3), ...many('kugou', 2)],
    stats: { total: 5, sources: 2, duplicates: 0, groups: 0, undecidable: 0 },
    failed: [],
    truncated: { qq: 3 },
  }, ZH);
  assert.match(html, /agg-truncated/, '触顶却没有渲染出截断提示 —— 用户看到的是一个子集却没人告诉他');
  assert.match(html, /3/, '提示里要能看到实际条数');
  assert.match(html, /qq/, '提示要点名是哪个源触顶');
  assert.ok(!/kugou/.test(html), '没触顶的源不该出现在截断提示里');
});

test('统计栏真渲染：没有截断时就不出现该提示（不制造常驻噪音）', async () => {
  const html = await renderStatBar({
    songs: many('kugou', 2),
    stats: { total: 2, sources: 1, duplicates: 0, groups: 0, undecidable: 0 },
    failed: [],
    truncated: {},
  }, ZH);
  assert.ok(!/agg-truncated/.test(html), '未触顶却显示截断提示');
});

test('统计栏真渲染：截断与失败分别成句，不共用一条文案', async () => {
  const html = await renderStatBar({
    songs: [...many('qq', 3), ...many('kugou', 0)],
    stats: { total: 3, sources: 2, duplicates: 0, groups: 0, undecidable: 0 },
    failed: ['kugou'],
    truncated: { qq: 3 },
  }, ZH);
  assert.match(html, /agg-truncated/, '缺截断提示');
  assert.match(html, /agg-failed/, '缺失败提示');
  const cut = html.match(/<span class="agg-truncated"[^>]*>([^<]*)</);
  const fail = html.match(/<span class="agg-failed"[^>]*>([^<]*)</);
  assert.notEqual(cut[1], fail[1], '截断与失败渲染成了同一句话，用户分不清"没数据"和"数据不全"');
  assert.match(fail[1], /kugou/, '失败提示要点名失败的源');
  assert.ok(!/kugou/.test(cut[1]), '失败的源不属于截断源');
});
