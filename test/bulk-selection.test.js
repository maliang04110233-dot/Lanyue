/**
 * 测试：列表多选的键盘效率 —— Shift 连选 + Delete 批量移除
 *
 * 三层覆盖：
 *   ① 纯函数直调（selectionRange.js / deleteScope.js），含边界与畸形输入；
 *   ② 模块纯净自检：这两个模块不碰宿主，才可能在 node --test 里跑起来；
 *   ③ 接线静态钉。渲染层视图模块**一被 import 就摸 DOM**（download.js 末尾就有一句
 *      _cacheDlDom()），测试里加载不了，于是按本仓既有做法钉源码形状。
 *
 * ③ 里最要紧的一条是「连选的判据只能来自 click」：
 *   checkbox 的 change 事件不保证携带 shiftKey（修饰键属于鼠标事件），
 *   把 event 从 onchange 传进去会得到 e.shiftKey===false —— 功能静默退化回单选，
 *   测试若只钉「有没有传 event」就抓不出来。所以这里钉的是
 *   「传 event 的那个处理器**必须是 onclick**」，并把 onchange 形态显式禁掉。
 *   顺带修掉 local.js 的一处既有缺陷：行容器 onclick 与 input onchange 各 toggle
 *   一次（download.js 早就为同一个病改过，renderer-audit.test.js 只盯着那一个文件）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...seg) => fs.readFileSync(path.join(ROOT, ...seg), 'utf8');

const RANGE_SRC = read('src/renderer/js/selectionRange.js');
const SCOPE_SRC = read('src/renderer/js/deleteScope.js');
const PL = read('src/renderer/js/views/playlist.js');
const APP = read('src/renderer/js/app.js');
const DL = read('src/renderer/js/views/download.js');
const LOCAL = read('src/renderer/js/views/local.js');
const KEYS = read('src/renderer/js/shortcuts.js');

const mod = () => import(`../src/renderer/js/selectionRange.js?sr=${Math.random()}`);
const scopeMod = () => import(`../src/renderer/js/deleteScope.js?ds=${Math.random()}`);

// ── ① selectionRange：连选算的是什么 ────────────────────

test('isRangeClick：只有裸 Shift 算连选，任何其它修饰键让位给单行切换', async () => {
  const { isRangeClick } = await mod();
  assert.strictEqual(isRangeClick({ shiftKey: true }), true);
  assert.strictEqual(isRangeClick({ shiftKey: true, ctrlKey: true }), false);
  assert.strictEqual(isRangeClick({ shiftKey: true, metaKey: true }), false);
  assert.strictEqual(isRangeClick({ shiftKey: true, altKey: true }), false);
  assert.strictEqual(isRangeClick({ shiftKey: false }), false);
  // 畸形输入不炸（onclick 漏传 event 时拿到的是 undefined）
  assert.strictEqual(isRangeClick(undefined), false);
  assert.strictEqual(isRangeClick(null), false);
  assert.strictEqual(isRangeClick({}), false);
});

test('rangeKeys：正向/反向/单点/锚点掉出视图/越界', async () => {
  const { rangeKeys } = await mod();
  const keys = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(rangeKeys(keys, 'b', 3), ['b', 'c', 'd'], '锚点在前：向后闭区间');
  assert.deepStrictEqual(rangeKeys(keys, 'd', 1), ['b', 'c', 'd'], '锚点在后：区间自动翻转，inclusive 两端');
  assert.deepStrictEqual(rangeKeys(keys, 'c', 2), ['c'], '锚点==点击行：单行');
  assert.deepStrictEqual(rangeKeys(keys, null, 2), ['c'], '无锚点：退化为本次点击一行');
  assert.deepStrictEqual(rangeKeys(keys, 'zzz', 3), ['d'], '锚点不在当前视图（被过滤/换单）：退化单行，不瞎连');
  assert.deepStrictEqual(rangeKeys(keys, 'a', 9), [], '行号越界（视图刚重排）：空');
  assert.deepStrictEqual(rangeKeys(keys, 'a', -1), [], '负下标：空');
  assert.deepStrictEqual(rangeKeys([], 'a', 0), [], '空视图：空');
  assert.deepStrictEqual(rangeKeys(undefined, 'a', 0), [], '非数组输入：空，不抛');
});

test('rangeKeys 只回区间、不改选态：并集由调用方做（连选不清空既有勾选）', async () => {
  const { rangeKeys } = await mod();
  const keys = ['a', 'b', 'c'];
  const selected = new Set(['x', 'y']); // 手工勾好的、不在本次区间里的行
  for (const k of rangeKeys(keys, 'a', 2)) selected.add(k);
  assert.deepStrictEqual([...selected], ['x', 'y', 'a', 'b', 'c'],
    '一次误触 Shift 点就冲掉用户逐框勾出来的一批，代价不可接受');
});

// ── ② 模块纯净 ────────────────────────────────────────

test('两个新模块不碰宿主（否则测试里加载不了，也就等于没有单测）', () => {
  for (const [name, src] of [['selectionRange.js', RANGE_SRC], ['deleteScope.js', SCOPE_SRC]]) {
    const body = src.replace(/^\/\*\*[\s\S]*?\*\//, '');
    assert.ok(!/document\.|window\.|api\.|getState\(/.test(body), `${name} 混进了宿主调用`);
  }
});

// ── ①续 deleteScope：Delete 落在哪个列表上 ──────────────

function mkScope(id, order, { active = true, count = 1, calls = [] } = {}) {
  return {
    id,
    order,
    active: () => active,
    count: () => count,
    run: () => { calls.push(id); return id; },
  };
}

test('注册表：小 order 优先，且注册顺序不影响结果', async () => {
  const { registerDeleteScope, pickDeleteScope, _resetDeleteScopes } = await scopeMod();
  _resetDeleteScopes();
  registerDeleteScope(mkScope('late', 30));
  registerDeleteScope(mkScope('early', 10));
  assert.strictEqual(pickDeleteScope().id, 'early', '优先级必须由显式 order 决定，不是注册先后');
  _resetDeleteScopes();
  registerDeleteScope(mkScope('early', 10));
  registerDeleteScope(mkScope('late', 30));
  assert.strictEqual(pickDeleteScope().id, 'early', '换个注册顺序，结果必须一样');
});

test('注册表：不在场、零勾选、判据抛错 —— 都跳过而不是接管这枚键', async () => {
  const { registerDeleteScope, pickDeleteScope, runDeleteOnActiveScope, _resetDeleteScopes } = await scopeMod();
  _resetDeleteScopes();
  registerDeleteScope(mkScope('idle', 10, { active: false }));
  registerDeleteScope(mkScope('empty', 20, { count: 0 }));
  assert.strictEqual(pickDeleteScope(), null, '没有合格作用域时不许动手');
  assert.strictEqual(runDeleteOnActiveScope(), false, '调用方据此决定要不要 preventDefault');

  registerDeleteScope({ id: 'boom', order: 5, active: () => { throw new Error('DOM 没了'); }, count: () => 9, run: () => {} });
  registerDeleteScope(mkScope('ok', 40));
  assert.strictEqual(pickDeleteScope().id, 'ok', '一个列表的在场判据抛错，不许拖死其它列表');
  _resetDeleteScopes();
});

test('runDeleteOnActiveScope：命中即调用该列表自己的批量动作，同 id 重复注册只留一条', async () => {
  const { registerDeleteScope, runDeleteOnActiveScope, _resetDeleteScopes } = await scopeMod();
  _resetDeleteScopes();
  const calls = [];
  registerDeleteScope(mkScope('a', 10, { calls }));
  registerDeleteScope(mkScope('b', 20, { calls }));
  registerDeleteScope(mkScope('a', 15, { calls })); // 覆盖上一条 a ⇒ 表里只剩 a(15) 与 b(20)
  assert.strictEqual(runDeleteOnActiveScope(), true);
  assert.deepStrictEqual(calls, ['a'], '覆盖同 id 后只剩一条 a，且 a(15) 仍先于 b(20)');
  assert.strictEqual(calls.length, 1, '一次按键只动一个列表');
  _resetDeleteScopes();
  // 重复注册不许在表里堆出两条 ⇒ 注册总数可从"第二次按键跑的是谁"反证：
  // 若 a 堆了两条（10 与 15），表里会有三个作用域，但 pick 仍只可能返回一个。
  registerDeleteScope(mkScope('a', 15, { calls }));
  registerDeleteScope(mkScope('b', 20, { calls }));
  runDeleteOnActiveScope();
  assert.deepStrictEqual(calls, ['a', 'a'], '重复注册不改变胜者，也不该抛错');
  _resetDeleteScopes();
});

test('注册表：缺字段的注册直接忽略，不许把 null 推进挑选链', async () => {
  const { registerDeleteScope, pickDeleteScope, _resetDeleteScopes } = await scopeMod();
  _resetDeleteScopes();
  registerDeleteScope(null);
  registerDeleteScope({ id: 'no-fns' });
  registerDeleteScope({ id: 'no-run', order: 1, active: () => true, count: () => 1 });
  assert.strictEqual(pickDeleteScope(), null);
  _resetDeleteScopes();
});

// ── ③ 接线钉：四张列表 ────────────────────────────────

/** 每条列表的共同要求：import 了纯函数、有锚点态、处理器收到 event、且是 onclick 而非 onchange */
const LISTS = [
  { name: '歌单详情', src: () => PL, file: 'src/renderer/js/views/playlist.js',
    call: 'onclick="event.stopPropagation();togglePlSongSel(${idx}, event)"',
    fn: 'function togglePlSongSel(idx, e)', anchor: 'let _plSelAnchor = null;' },
  { name: '播放队列', src: () => APP, file: 'src/renderer/js/app.js',
    call: "'onclick=\"event.stopPropagation();togglePqSel(' + i + ', event)\"",
    fn: 'window.togglePqSel = (idx, e)', anchor: 'let _pqSelAnchor = null;' },
  { name: '下载队列', src: () => DL, file: 'src/renderer/js/views/download.js',
    call: "onclick=\"event.stopPropagation();toggleDlSelect('${escQ(s.taskId)}', event)\"",
    fn: 'function toggleDlSelect(taskId, e)', anchor: 'let _dlSelAnchor = null;' },
  { name: '本地曲库', src: () => LOCAL, file: 'src/renderer/js/views/local.js',
    call: "onclick=\"event.stopPropagation();toggleLocalSelect('${encodedPath}',${i}, event)\"",
    fn: 'function toggleLocalSelect(filePathOrEncoded, idx, e)', anchor: 'let _localSelAnchor = null;',
    // 连选动作已收敛到 listSelection（状态仍在本视图持有）——本视图不再直接
    // import selectionRange，改由 listSelection 转调；「跑连选逻辑的那一层必须
    // 真的 import 到 isRangeClick」这条不变量在下面的 listSelection 断言里钉。
    imp: 'listSelection.js',
    impVia: 'src/renderer/js/listSelection.js' },
];

for (const L of LISTS) {
  test(`${L.name}：连选接线就位（import + 锚点 + onclick 传 event）`, () => {
    const s = L.src();
    // 跑连选的那一层必须 import 到 isRangeClick 的来源：默认直接 selectionRange，
    // 收敛过的（本地曲库）走 listSelection，其自身再转调 selectionRange。
    const imp = L.imp || 'selectionRange.js';
    assert.ok(new RegExp(`from '\\.\\.?/${imp}'`).test(s), `${L.file} 没 import ${imp} —— isRangeClick 会是未定义，onclick 静默失灵`);
    if (L.impVia) {
      const via = read(L.impVia);
      assert.ok(/from '\.\/selectionRange\.js'/.test(via), `${L.impVia} 没转调 selectionRange —— 连选区间数学丢了`);
    }
    assert.ok(s.includes(L.anchor), `${L.name} 缺锚点态`);
    assert.ok(s.includes(L.fn), `${L.name} 的切换函数没接住 event 形参`);
    assert.ok(s.includes(L.call), `${L.name} 的内联处理器没把 event 递给切换函数`);
    assert.ok(!/onchange="[^"]*toggle(PlSongSel|PqSel|DlSelect|LocalSelect)\(/.test(s),
      `${L.name} 又回到 onchange 上触发勾选 —— change 事件不保证带 shiftKey，连选会静默退化成单选`);
  });
}

test('本地曲库：行容器与勾选框不再各 toggle 一次（download.js 同病的既有修法推广）', () => {
  assert.ok(!/onchange="event\.stopPropagation\(\);toggleLocalSelect\(/.test(LOCAL),
    'input 的 click 冒泡到行容器已 toggle，onchange 再 toggle 一次 = 永远选不中');
  // 既有钉的推广版：renderer-audit.test.js 只对 download.js 立了这条，这里补 local.js
  assert.ok(!/onchange="event\.stopPropagation\(\);toggleDlSelect\(/.test(DL), 'download.js 同步不许倒退');
});

test('下载队列的连选视图序与渲染共用同一条管线（两份筛选迟早漂出"连到没显示的行"）', () => {
  assert.match(DL, /function _dlShownTasks\(queue\) \{[\s\S]{0,200}applyQueueFilter\(queue, _dlFilter, _dlKeyword, _dlPlatform\)[\s\S]{0,80}slice\(-50\)\.reverse\(\)/,
    '视图序必须只有一个计算处');
  assert.match(DL, /const shown = _dlShownTasks\(queue\);/, 'renderQueue 必须改读它');
  assert.match(DL, /function _dlViewOrder\(\)[\s\S]{0,200}_dlShownTasks\(getState\('queueSnapshot'\)/,
    '连选必须读同一个函数');
  assert.match(DL, /_dlGroupMode[\s\S]{0,200}_dlCollapsed\.has\(g\.key\)/,
    '分组模式要跳过折叠组：折叠起来的行不在 DOM 里，区间不该跨过它');
  assert.ok(!/const filtered = applyQueueFilter\(/.test(DL), '残留的第二份筛选管线');
});

// ── ③续 Delete 键的三段接线 ───────────────────────────

test('三张列表各自注册 Delete 作用域，且优先级是 弹层 > 队列抽屉 > 下载页', () => {
  const regs = [
    { s: PL, id: "id: 'playlist-detail'", order: 'order: 10', run: 'removeCheckedFromPlaylist' },
    { s: APP, id: "id: 'play-queue'", order: 'order: 20', run: 'removeCheckedFromQueue' },
    { s: DL, id: "id: 'download-queue'", order: 'order: 30', run: 'batchRemoveDl' },
  ];
  for (const r of regs) {
    assert.ok(/from '\.\.?\/deleteScope\.js'/.test(r.s), '没 import 注册表：Delete 永远找不到这个列表');
    assert.ok(r.s.includes('registerDeleteScope({') && r.s.includes(r.id) && r.s.includes(r.order),
      `作用域注册缺失或 order 变了：${r.id}`);
    // run 必须是该列表「🗑 移除」按钮用的那个函数 —— 确认弹窗/toast/选态清理不许另写一份。
    // app.js 里 removeCheckedFromQueue 只有 window 绑定（`window.x = async () => {}`），
    // 裸调用会 ReferenceError，所以允许 window. 前缀这一种写法差异。
    assert.ok(new RegExp(`run: \\(\\) => (?:window\\.)?${r.run}\\(\\)`).test(r.s), `run 没复用 ${r.run}()`);
  }
  // 本地曲库的选择条只有导出/批量编辑/批量重命名，没有批量删除 ⇒ 不给它发明 Delete 语义
  assert.ok(!LOCAL.includes('registerDeleteScope'),
    '本地曲库不该注册 Delete 作用域（删文件是另一条更重的路径）');
});

test('shortcuts.js：Delete 分支的三道拦截都在', () => {
  assert.match(KEYS, /import \{ pickDeleteScope \} from '\.\/deleteScope\.js';/, '没接注册表');
  assert.match(KEYS, /\(e\.key === 'Delete' \|\| e\.key === 'Del'\) && !ctrlOrCmd/,
    '必须排除组合键：输入框里的 Ctrl+Delete 之类不归本功能管');
  assert.match(KEYS, /if \(scope && !_anyModalOpenExcept\(scope\.modalId\)\)/,
    '上层压着别的浮层时不许删底下的行');
  assert.match(KEYS, /const scope = pickDeleteScope\(\);[\s\S]{0,200}scope\.run\(\);/,
    '命中后要 preventDefault 并交给列表自己的批量动作');
  assert.match(KEYS, /function _anyModalOpenExcept\(id\)[\s\S]{0,200}m\.id !== mine/,
    '排除自身浮层的判据（歌单详情本身就是 data-modal）');
});

// ── 守卫自检：正则写坏了会恒真，这里逐条要求"变异即红" ────

test('自检：上述接线钉对变异源码确实会失配（不是恒真）', () => {
  // ① 把 onclick 的 event 参数拿掉 ⇒ onclick 钉必须失配
  const mutated = PL.replace('onclick="event.stopPropagation();togglePlSongSel(${idx}, event)"',
    'onclick="event.stopPropagation();togglePlSongSel(${idx})"');
  assert.ok(mutated !== PL, '替换没命中，说明这条自检本身写坏了');
  assert.ok(!mutated.includes('onclick="event.stopPropagation();togglePlSongSel(${idx}, event)"'),
    'onclick+event 钉应当对变异源码失配');

  // ② 退回 onchange ⇒ onchange 负向钉必须转为命中
  const back = APP.replace('onclick="event.stopPropagation();togglePqSel(\' + i + \', event)"',
    'onchange="togglePqSel(\' + i + \', event)"');
  assert.ok(back !== APP, '替换没命中');
  assert.ok(/onchange="[^"]*toggle(PlSongSel|PqSel|DlSelect|LocalSelect)\(/.test(back),
    'onchange 负向钉应当抓到这处倒退');

  // ③ order 被改成相同值 ⇒ 逐文件 order 钉仍能抓到（钉的是字面量，不是"存在某个 order"）
  const sameOrder = DL.replace('order: 30', 'order: 20');
  assert.ok(!sameOrder.includes('order: 30'), 'order 钉应对该变异失配');

  // ④ run 换成自写逻辑 ⇒ run 钉失配
  const rewired = DL.replace('run: () => batchRemoveDl()', 'run: () => exitDlSelectionMode()');
  assert.ok(!/run: \(\) => batchRemoveDl\(\)/.test(rewired), 'run 钉应对该变异失配');
});

// ── 实弹（fake-dom 装载视图模块）──────────────────────────
//
// 上面的接线钉只证明"源码长这样"，这一节证明"点下去真会那样"：
// 用本仓既有的极小 DOM 替身（helpers/fake-dom.js + view-module.js，无 jsdom）
// 把 playlist.js 装起来、开一张 6 首的歌单详情、按 singer 排序后**真的调用**
// window.togglePlSongSel(idx, {shiftKey:true})，再读渲染出来的勾选态。
//
// 为什么排序模式要挑'歌手'：它把视图序打乱成非对称排列，于是"连选按视图序"
// 与（错误的）"连选按存储下标"会选出**不同的集合** —— 用默认排序或倒序都做不到，
// 两者给出同一组行，实弹就成了恒真断言。

const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const PL_VIEW = 'src/renderer/js/views/playlist.js';

/** artist 首字母刻意乱序：按歌手排序后视图序 = [1,3,5,4,2,0] */
const PL_SONGS = ['f', 'a', 'e', 'b', 'd', 'c']
  .map((artist, i) => ({ id: i, source: 'net', title: 'T' + i, artist }));

async function openPlInRangeMode() {
  const state = {
    userPlaylists: [{ id: 'p1', name: 'X', desc: '', songs: PL_SONGS }],
    currentPlaying: null,
    queueSnapshot: [],
  };
  const dom = installBrowserGlobals({
    raf: 'auto',
    ids: ['playlistDetailSongs', 'playlistDetailModal', 'playlistSortBtn', 'plDlFilterBtn',
      'playlistSongFilter', 'playlistDetailTitle', 'playlistDetailDesc', 'userPlaylistGrid',
      'plSelModeBtn', 'plSelAllBtn', 'plSelRemoveBtn', 'plSelDlBtn', 'plSelPlayBtn'],
    extraGlobals: {
      getState: (k) => state[k],
      api: {
        queryHistory: async () => { throw new Error('skip'); },
        saveUserPlaylist: async () => ({ success: true }),
      },
    },
  });
  await loadView(PL_VIEW, dom);
  await globalThis.openPlaylistDetail('p1');
  globalThis.cyclePlaylistSort(); // 默认序 → 标题
  globalThis.cyclePlaylistSort(); // 标题 → 歌手
  globalThis.togglePlBulkMode();  // 进多选
  return dom;
}

/** 从渲染出的行模板里读出「已勾选」行的存储下标（按屏幕行序） */
function checkedRows(dom) {
  const html = dom.element('playlistDetailSongs').innerHTML;
  const out = [];
  for (const m of html.matchAll(/class="pl-sel-chk"\s+(checked\s+)?onclick="event\.stopPropagation\(\);togglePlSongSel\((\d+), event\)"/g)) {
    out.push({ idx: Number(m[2]), checked: !!m[1] });
  }
  return out;
}
/** 勾选集合（升序）—— 断言比的是"选了哪几行"，屏幕序另有前提自检钉住 */
const picked = (dom) => checkedRows(dom).filter((r) => r.checked).map((r) => r.idx).sort((a, b) => a - b);

test('实弹：Shift 连选连的是屏幕上的区间，不是存储下标的区间', async () => {
  const dom = await openPlInRangeMode();
  // 前提自检：视图序确实被打乱了（否则本用例退化成恒真）
  const screen = checkedRows(dom).map((r) => r.idx);
  assert.deepStrictEqual(screen, [1, 3, 5, 4, 2, 0], '歌手序下的屏幕行序');

  const click = (idx, shift) => globalThis.togglePlSongSel(idx, { shiftKey: shift });
  click(1, false);            // 单点屏幕第 1 行（存储 1）→ 锚点
  click(5, true);            // Shift 点屏幕第 3 行（存储 5）

  assert.deepStrictEqual(picked(dom), [1, 3, 5],
    '应当选中屏幕上第 1~3 行；若这里出现 2 或 4，说明连选按存储下标算区间');
});

test('实弹：Shift 连选只并入不清空，单点会移动锚点', async () => {
  const dom = await openPlInRangeMode();
  const click = (idx, shift) => globalThis.togglePlSongSel(idx, { shiftKey: shift });

  click(3, false);           // 存储 3（屏幕第 2 行）
  click(1, true);           // 往回连：屏幕第 1~2 行
  assert.deepStrictEqual(picked(dom), [1, 3],
    '屏幕区间 [0..1] = 存储 {1,3}');

  click(2, false);           // 单点存储 2（屏幕第 5 行）→ 只加这一个，锚点移到这里
  assert.deepStrictEqual(picked(dom), [1, 2, 3], '手动勾选的行不能被后续操作清掉');

  click(0, true);           // 从锚点 2（屏幕 4）连到 0（屏幕 5）
  assert.deepStrictEqual(picked(dom), [0, 1, 2, 3],
    '锚点已随单点移动：这次连的是屏幕第 4~5 行，第 4/5 行没被牵进来');

  click(1, false);           // 取消单点（非 Shift）
  assert.ok(!checkedRows(dom).find((r) => r.idx === 1).checked, '非 Shift 单点仍是开/关切换');
});

test('实弹：e 缺席（退回 onchange 或忘传 event）时退化为单选而不是崩溃', async () => {
  const dom = await openPlInRangeMode();
  globalThis.togglePlSongSel(1);            // 老签名：没有第二个参数
  globalThis.togglePlSongSel(5, { shiftKey: true, ctrlKey: true }); // 组合键不算连选
  assert.deepStrictEqual(picked(dom), [1, 5],
    'isRangeClick 对 undefined/组合键都判否 ⇒ 只勾这一行，不抛错也不整段连');
});
