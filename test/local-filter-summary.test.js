/**
 * 本地曲库 chip 汇总（localFilterSummary.js）单测
 *
 * 这个模块存在的意义是"报实话"：菜单一关，外面那一行 chip 就是用户唯一能看见的
 * "我到底在筛什么"。所以判据的重心不在算得多复杂，而在三件事：
 *   ① 只报登记过的轴（fav 自己有高亮、sort 不是筛选，混进来就是把用户带偏）；
 *   ② 顺序稳定（chip 顺序 = 菜单行顺序，不然眼睛要在两处对着找）；
 *   ③ 文案与按钮同源（这里必须直接吐 label(mode) 的原文，另抄一份词表迟早漂）。
 * 外加一条 innerHTML 出口的转义测——上游现在是白名单值，但出口不该赌上游永远干净。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const M = '../src/renderer/js/localFilterSummary.js';

/** 造一条轴快照：mode 交给 label 回显，方便断言"文案就是轴表原文" */
const axis = (id, mode, fn) => ({ id, mode, label: fn || ((m) => `${id}:${m}`) });

test('全关档 / 空输入 / 脏输入：一律不报（"没筛"必须报成"没筛"）', async () => {
  const { activeFilterChips } = await import(`${M}?v=${Math.random()}`);
  assert.deepStrictEqual(activeFilterChips([]), []);
  assert.deepStrictEqual(activeFilterChips(undefined), []);
  assert.deepStrictEqual(activeFilterChips(null), []);
  assert.deepStrictEqual(activeFilterChips('not-an-array'), []);
  assert.deepStrictEqual(
    activeFilterChips([axis('fmt', 'all'), axis('qual', 'all'), axis('meta', 'all')]),
    [],
  );
  // 档位值缺失（轴还没初始化）也不许冒出一枚空 chip
  assert.deepStrictEqual(activeFilterChips([axis('fmt', undefined)]), []);
  assert.deepStrictEqual(activeFilterChips([axis('qual', null)]), []);
});

test('顺序按 CHIP_AXIS_IDS 走，不按入参顺序（两处对不齐眼睛就得找）', async () => {
  const { activeFilterChips } = await import(`${M}?v=${Math.random()}`);
  const chips = activeFilterChips([axis('meta', 'no-lyric'), axis('fmt', 'flac'), axis('qual', 'verified')]);
  assert.deepStrictEqual(chips.map((c) => c.id), ['fmt', 'qual', 'meta']);
});

test('名单外的轴不报：fav 有高亮、sort 不是筛选、脏 id 不是轴', async () => {
  const { activeFilterChips } = await import(`${M}?v=${Math.random()}`);
  const chips = activeFilterChips([
    axis('fav', true, (m) => (m ? '♥ 仅收藏' : '♥ 收藏')),
    axis('sort', 'title', () => '↕ 标题'),
    axis('', 'flac'),
    null,
    undefined,
    { id: 'qual' },                       // 没有 label 函数：跳过而不是抛
  ]);
  assert.deepStrictEqual(chips, [], '名单外的轴全都不该出 chip');
});

test('chip 文案就是轴表原文（不另立词表），label 给空串视为没筛', async () => {
  const { activeFilterChips } = await import(`${M}?v=${Math.random()}`);
  const chips = activeFilterChips([axis('qual', 'verified', () => '🧪 真无损'), axis('fmt', 'flac', () => '   ')]);
  assert.deepStrictEqual(chips, [{ id: 'qual', text: '🧪 真无损' }], '空白文案不该成为一枚光杆 chip');
});

test('登记名单是显式决定：改折叠范围必须在这里留下痕迹', async () => {
  const { CHIP_AXIS_IDS } = await import(`${M}?v=${Math.random()}`);
  assert.deepStrictEqual(CHIP_AXIS_IDS, ['fmt', 'qual', 'meta']);
});

test('filterChipsHtml：一枚 chip 一个 ✕ + 单清回调；名单外的 chip 进不了 DOM', async () => {
  const { filterChipsHtml } = await import(`${M}?v=${Math.random()}`);
  assert.strictEqual(filterChipsHtml([]), '');
  assert.strictEqual(filterChipsHtml(undefined), '');
  const html = filterChipsHtml([{ id: 'qual', text: '🧪 真无损' }, { id: 'meta', text: '🏷 缺封面' }]);
  assert.strictEqual((html.match(/class="filter-chip"/g) || []).length, 2);
  assert.strictEqual((html.match(/filter-chip-x">✕/g) || []).length, 2);
  assert.match(html, /onclick="resetLocalFilterAxis\('qual'\)"/);
  assert.match(html, /onclick="resetLocalFilterAxis\('meta'\)"/);
  // 名单外的 id 就算被调用方塞进来也不给出口（单清只能清折叠进菜单的轴）
  assert.strictEqual(filterChipsHtml([{ id: 'sort', text: '↕ 标题' }]), '');
});

test('innerHTML 出口必须转义（不赌上游永远是白名单值）', async () => {
  const { filterChipsHtml } = await import(`${M}?v=${Math.random()}`);
  const evil = [{ id: 'fmt', text: '<img src=x onerror="alert(1)">"' }];
  const html = filterChipsHtml(evil);
  assert.ok(!/<img/.test(html), '原文标签漏进了 innerHTML');
  assert.ok(/&lt;img/.test(html), '标签应被转义成实体');
  assert.ok(html.split('title="')[1].startsWith('&lt;img'), 'title 值应从转义后的正文开始');
  // 一枚 chip 的骨架只该有 8 个双引号（class/onclick/title + 内层 ✕ 的 class，各一对）。
  // 文案里那个裸引号若没变成实体，属性就被截断、后面半截会变成新属性 —— 数引号最诚实。
  assert.strictEqual((html.match(/"/g) || []).length, 8, '文案里的引号逃逸成了属性分隔符');
});

test('自检：本文件的判据对"把 fav/sort 也算成筛选"确实会红（不是恒真）', async () => {
  const { activeFilterChips, CHIP_AXIS_IDS } = await import(`${M}?v=${Math.random()}`);
  const favActive = axis('fav', true, () => '♥ 仅收藏');
  assert.ok(favActive.label(favActive.mode) === '♥ 仅收藏', '这条轴确实"亮着"');
  assert.ok(!CHIP_AXIS_IDS.includes('fav'), '判据只认这份名单——名单一加 fav，上面那条测就红');
  assert.deepStrictEqual(activeFilterChips([favActive]), [], 'fav 现在确实不进 chip');
});
