/**
 * 分片渲染 × 定位正在播放 × 拖拽落点：三个视图统一的行为测试
 *
 * ── 缺陷来龙去脉（实测，不是推测）────────────────────────────────
 *
 * 三个视图都用同一套"首屏同步出 100 行、其余按 rAF 追加 + token 防竞态"的写法
 * （PL_RENDER_CHUNK / LOCAL_GRID_CHUNK / CONV_RENDER_CHUNK 都是 100）。分片本身是对的，
 * 但有两条路径**要求"全部行已在 DOM"**：
 *
 *   ① playlist.js 的 locatePlayingInDetail()：data-pidx 落在第 150 行的歌，
 *      在分片跑完之前根本不在 DOM 里。旧实现在首屏那一瞬就同步查一次，
 *      查不到就弹 toast.plRowNotVisible（"该行当前不在可见列表（检查排序/过滤）"）
 *      —— 一句**完全错误的诊断**，把用户往排序/过滤上带，而真实原因只是还没渲染完。
 *   ② playlist.js 的拖拽排序：_plRowUnder 只能命中已渲染的行，于是"从第 1 首拖到最后"
 *      只能落在第 100 首，persistPlaylistOrder 把歌挪到一个用户根本没瞄准的位置。
 *
 * 修法是让渲染函数把"分片全部落地"的时刻交出去（返回 Promise），调用方 await 它再查；
 * 拖拽那条路则是在分片期间直接拒绝起拖/落序（半个列表算出来的落点会写错序）。
 *
 * ── 测试怎么打桩（node 里没有 document / requestAnimationFrame）──
 * 见 test/helpers/fake-dom.js 与 view-module.js 的头注：一套极小 DOM 替身 +
 * 一个把 i18n.js 换成测试替身的 resolve 钩子（本仓没有 jsdom 依赖，不为一个测试装）。
 * 能测到的是"每一片有没有真的接上 DOM""定位那一刻行在不在""反馈出口说了什么"；
 * 测不到的是 HTML 结构是否合法（替身不解析嵌套）——那条界线在替身文件里写明了。
 *
 * 本文件里的断言都落在**行为**上（DOM 里出现了什么、showToast 说了什么、
 * api.saveUserPlaylist 有没有被调、那个 promise 有没有 resolve），不是读源码做正则匹配。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, FakeEl, tick } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const PL = 'src/renderer/js/views/playlist.js';
const LOCAL = 'src/renderer/js/views/local.js';
const CONV = 'src/renderer/js/views/converter.js';

const song = (i) => ({
  id: i, source: 'net', title: `T${i}`, artist: `A${i}`, album: `Al${i}`,
  duration: 120 + i, filePath: `p${i}.mp3`,
});
const many = (n) => Array.from({ length: n }, (_, i) => song(i));

/** 数容器里出现了多少行（按渲染出的标记数，不是"应该有多少"） */
const countRows = (el, re) => (el.innerHTML.match(re) || []).length;

/**
 * 跑完**所有**待追加的帧，返回跑了几帧。
 *
 * 为什么不能只 flush 一次（首版就是这么写的，于是 npm test 挂死）：
 * 首片是同步落地的，剩下 ceil((rows-100)/100) 片各占一帧。150 行只要 1 帧，
 * 250 行要 **2** 帧 —— 只跑一帧时 `await p` 永远不 resolve，用例挂到超时。
 * 帧数要跟着数据规模变，所以这里按"还有没有待跑帧"来跑，而不是写死一个数字。
 */
function drainFrames(dom) {
  let n = 0;
  while (dom.pendingFrames()) { dom.flushFrame(); n++; }
  return n;
}

/** 造一个"分片还没落地"却不至于挂死的超时哨兵：不结算就变红，而不是把测试卡死 */
const HANG_MS = 400;
function withTimeout(promise, what) {
  return Promise.race([
    promise.then(() => 'ok'),
    new Promise((r) => setTimeout(() => r(what), HANG_MS)),
  ]);
}

// ── 一、playlist 详情：分片 + 定位 + 拖拽落点 ─────────────────────

/** 摆一个 150 首的歌单详情弹层；manual rAF 让"同步那一刻只有 100 行"成为可断言的事实 */
async function openBigPlaylist(raf, playing = 149) {
  const songs = many(150);
  const state = {
    userPlaylists: [{ id: 'p1', name: 'X', desc: '', songs }],
    currentPlaying: songs[playing],
    queueSnapshot: [],
  };
  const saved = [];
  const dom = installBrowserGlobals({
    raf,
    ids: ['playlistDetailSongs', 'playlistDetailModal', 'playlistSortBtn', 'plDlFilterBtn',
      'playlistSongFilter', 'playlistDetailTitle', 'playlistDetailDesc', 'userPlaylistGrid'],
    extraGlobals: {
      getState: (k) => state[k],
      api: {
        queryHistory: async () => { throw new Error('skip'); },
        saveUserPlaylist: async (payload) => { saved.push(payload); return { success: true }; },
      },
    },
  });
  await loadView(PL, dom);
  await globalThis.openPlaylistDetail('p1');
  return { dom, box: dom.element('playlistDetailSongs'), songs, saved };
}

test('分片是真的：首屏同步 100 行，跑完帧才 150 行（不是恒真断言的前提）', async () => {
  const { dom, box } = await openBigPlaylist('manual');
  assert.strictEqual(countRows(box, /data-pidx=/g), 100,
    '同步那一刻就该只有一片（100 行）。若这里已经是 150，说明分片没了，本文件其余断言都会失去意义');
  assert.strictEqual(dom.pendingFrames(), 1, '应当还有一片待追加');
  assert.ok(!dom.doc.querySelector('#playlistDetailSongs .song-row[data-pidx="149"]'),
    '第 150 行此刻**不该**在 DOM 里 —— 这正是缺陷 1 的成因');
  dom.flushFrame();
  assert.strictEqual(countRows(box, /data-pidx=/g), 150, '跑掉一帧后 150 行必须全部出现');
  for (const idx of [0, 99, 100, 149]) {
    assert.ok(dom.doc.querySelector(`#playlistDetailSongs .song-row[data-pidx="${idx}"]`),
      `第 ${idx + 1} 行应当已渲染`);
  }
});

test('定位正在播放：目标行在第 150 行时也不报「不在可见列表」（缺陷 1 正面）', async () => {
  const { dom, box } = await openBigPlaylist('auto');
  await globalThis.locatePlayingInDetail();
  assert.deepStrictEqual(dom.toasts, [],
    '第 150 行正在播放、且没有过滤/排序干预 —— 不该有任何提示。实到=' + JSON.stringify(dom.toasts));
  const flashed = dom.queried().filter((n) => n.scrolledIntoView);
  assert.strictEqual(flashed.length, 1, '应当正好闪了一行（flashRow 调了 scrollIntoView）');
  assert.strictEqual(String(flashed[0].getAttribute('data-pidx')), '149',
    '闪的必须是第 150 行（data-pidx=149），不是随便哪一行');
  assert.ok(box.innerHTML.includes('data-pidx="149"'), '第 150 行此刻必须已在 DOM 里');
});

test('定位正在播放：真的不在这个歌单里时仍然要报「不在本歌单」（反向钉，防"永远等分片"写成"永远成功"）', async () => {
  const { dom } = await openBigPlaylist('auto');
  await globalThis.locatePlayingInDetail();
  assert.deepStrictEqual(dom.toasts, [], '前置：先确认能定位');
  // 换成一首歌单里没有的歌
  globalThis.getState = (k) => (k === 'currentPlaying' ? song(9999) : k === 'queueSnapshot' ? [] : undefined);
  dom.toasts.length = 0;
  await globalThis.locatePlayingInDetail();
  assert.deepStrictEqual(dom.toasts.map((t) => t.msg), ['正在播放的歌不在本歌单'],
    '定位失败必须照实报错，不能因为"等分片"就把失败吞成成功');
});

test('定位正在播放：关键词过滤藏住该行时，清过滤重渲染后仍要闪（覆盖"清过滤那一轮也要等"）', async () => {
  const { dom } = await openBigPlaylist('auto');
  globalThis.onPlaylistSongFilterInput('T1499');   // 过滤到空 → 该行被藏
  dom.toasts.length = 0;
  await globalThis.locatePlayingInDetail();
  assert.deepStrictEqual(dom.toasts, [],
    '过滤藏住的行应当被"清过滤 + 重渲染"救回来，而不是弹「不在可见列表」');
  assert.strictEqual(dom.queried().filter((n) => n.scrolledIntoView).length, 1, '应当闪了那一行');
});

/** 造一棵最小但真实的拖拽事件树：handle 在 row 里，row 在容器里 */
function dragTree(box, fromIdx, toIdx) {
  const mk = (idx) => {
    const row = new FakeEl('div');
    row.setAttribute('data-pidx', String(idx));
    row.setAttribute('class', 'song-row');
    row.parent = box;
    return row;
  };
  const from = mk(fromIdx);
  const handle = new FakeEl('span');
  handle.setAttribute('class', 'pl-drag-handle');
  from.appendChild(handle);
  return { from, handle, to: mk(toIdx) };
}

test('分片期间不许起拖：dragstart 被拒，persistPlaylistOrder 不被触发（缺陷 1 之二正面）', async () => {
  const { dom, saved } = await openBigPlaylist('manual');   // 第 2 片还没落地
  assert.strictEqual(dom.pendingFrames(), 1, '前置：此刻分片确实还在跑');
  const { handle, to } = dragTree(dom.element('playlistDetailSongs'), 3, 5);
  const ev = dom.doc.dispatch('dragstart', { target: handle, dataTransfer: { setData() {} } });
  assert.ok(ev.defaultPrevented, '分片在跑时起拖必须被拒（否则落点只按"已画出的前几片"解释）');
  dom.doc.dispatch('drop', { target: to });
  assert.deepStrictEqual(saved, [], 'persistPlaylistOrder 不许被触发 —— 半个列表算出来的落点会写错序');
});

test('分片跑完之后拖拽照常落序（反向钉：守卫不是"永远拒绝"）', async () => {
  const { dom, saved, songs } = await openBigPlaylist('manual');
  // 等分片落地走**产品自己的排空句柄**（window.playlistRenderIdle），不用 tick 猜帧数：
  // 首版那句 `await globalThis._plRenderIdleProbe ? null : tick(4)` 等于靠让出事件循环
  // 撞运气 —— 帧数一旦从 1 涨到 2（数据规模一变），它就静默变成"还没画完就断言"。
  let idleDone = false;
  const idleP = globalThis.playlistRenderIdle().then(() => { idleDone = true; });
  await tick();
  assert.strictEqual(idleDone, false, '第 2 片还没追加，排空句柄不许提前 resolve');
  drainFrames(dom);
  assert.strictEqual(await withTimeout(idleP, 'idle'), 'ok', '帧跑完排空句柄必须 resolve');
  const box = dom.element('playlistDetailSongs');
  assert.ok(box.innerHTML.includes('data-pidx="5"'), '前置：两片都已在 DOM 里');
  const { handle, to } = dragTree(box, 1, 4);
  const start = dom.doc.dispatch('dragstart', { target: handle, dataTransfer: { setData() {} } });
  assert.ok(!start.defaultPrevented, '分片跑完后不该再拦起拖');
  dom.doc.dispatch('drop', { target: to });
  assert.strictEqual(saved.length, 1, '应当落一次盘');
  const after = saved[0].songs;
  // 只比前 7 首：这是 150 首的歌单，比整数组会把"其余 143 首没动"这条信息淹掉。
  // moveInList 是 splice(from,1) 后 splice(to,0) —— 落在 pidx=4 那一行上，
  // 语义是"占据第 5 个位置"，所以第 2 首落在下标 4 而不是下标 3。
  assert.deepStrictEqual(after.slice(0, 7).map((s) => s.id), [0, 2, 3, 4, 1, 5, 6],
    '第 2 首应当占据第 5 首的位置（moveInList 语义），其余顺序不变');
  assert.deepStrictEqual(after.slice(7).map((s) => s.id), Array.from({ length: 143 }, (_, i) => i + 7),
    '后面的歌一个都不许动（落盘覆盖的是全量 songs，误排会整片丢序）');
  assert.strictEqual(saved[0].id, 'p1');
  assert.strictEqual(after.length, songs.length, '不许顺手丢歌');
});

test('拖拽途中来了一次重渲染：drop 同样不落盘（from 是旧列表的下标，落到新列表就是错歌）', async () => {
  // manual 帧：分片"跑着"这件事必须可精确观测。用 auto 的话 setTimeout 随时会把
  // 那一帧跑掉，pendingFrames() 断言就变成竞态。
  const { dom, saved } = await openBigPlaylist('manual');
  drainFrames(dom);
  const box = dom.element('playlistDetailSongs');
  const { handle, to } = dragTree(box, 1, 4);
  dom.doc.dispatch('dragstart', { target: handle, dataTransfer: { setData() {} } });
  // 拖拽途中另一个动作把歌单重渲染了一遍（分片又跑起来）
  globalThis.onPlaylistSongFilterInput('');
  assert.strictEqual(dom.pendingFrames(), 1, '前置：此刻又有一段分片在跑');
  dom.doc.dispatch('drop', { target: to });
  assert.deepStrictEqual(saved, [], 'DOM 换过一轮，from/to 已不可信 —— 必须不落盘');
});

// ── 二、local 网格：分片 Promise 的契约 ───────────────────────────

/** 摆 250 首的本地库网格视图（renderLocalGrid 是 ES Module 导出，直接拿得到） */
async function localGrid(raf = 'manual') {
  const songs = many(250);
  const state = { localSongs: songs, localFiltered: songs, favoriteKeys: new Set() };
  const dom = installBrowserGlobals({
    raf,
    ids: ['localGrid', 'localList', 'localAlbumWall', 'localAlbumFilterChip', 'localViewToggleBtn', 'localFilter'],
    extraGlobals: { getState: (k) => state[k] },
  });
  const mod = await loadView(LOCAL, dom);
  return { dom, mod, box: dom.element('localGrid'), songs };
}

test('网格分片：await 返回的那一刻，全部格子已经落地（Promise 契约正面）', async () => {
  const { dom, mod, box } = await localGrid('manual');
  let settled = false;
  const p = mod.renderLocalGrid().then(() => { settled = true; });
  await tick();                                     // 让微任务跑完
  assert.strictEqual(settled, false, '还有一片没追加，不许提前 resolve');
  assert.strictEqual(countRows(box, /class="grid-cell"/g), 100);
  const frames = drainFrames(dom);
  assert.ok(frames >= 2, `250 行 / 每片 100 ⇒ 至少还要 2 帧，实跑 ${frames} 帧`);
  assert.strictEqual(await withTimeout(p, 'grid'), 'ok', '帧跑完就必须 resolve');
  assert.strictEqual(settled, true, '帧跑完就该 resolve');
  assert.strictEqual(countRows(box, /class="grid-cell"/g), 250, 'resolve 时 250 格必须全在 DOM 里');
});

test('网格分片：被新一轮渲染作废的那一轮也必须结算（否则 await 它的调用方永久挂起）', async () => {
  const { dom, mod } = await localGrid('manual');
  const first = mod.renderLocalGrid();              // 第 1 片落地，第 2 片待帧
  const second = mod.renderLocalGrid();             // 立刻作废 first
  assert.strictEqual(await withTimeout(first, 'first'), 'ok',
    '被作废的分片必须被结算：漏结算就是永久 pending，比误报更难查');
  drainFrames(dom);
  assert.strictEqual(await withTimeout(second, 'second'), 'ok');
  assert.strictEqual(dom.pendingFrames(), 0, '不该留下悬挂的帧');
});

test('网格分片：切视图导致的**外部**作废（不经 renderLocalGrid）同样会结算', async () => {
  const { dom, mod } = await localGrid('manual');
  globalThis.toggleLocalView();                     // list → grid，走 filterLocalSongs
  const p = mod.renderLocalGrid();                  // 手动再起一次，还有片待帧
  // 判据是"还有帧没跑"而不是"恰好 1 帧"：250 行 / 每片 100 ⇒ 首片同步、后 2 片占 2 帧。
  // 写死 1 会在数据规模一变时静默变成"帧数断言"而不是"分片在跑"的断言。
  assert.ok(dom.pendingFrames() >= 1, `前置：确实还有片待追加，实跑 ${dom.pendingFrames()} 帧`);
  globalThis.toggleLocalView();                     // grid → album：只 ++token，不再调 renderLocalGrid
  // 结算由**已排进队列的那一帧**完成，所以这里必须把帧跑掉。首版没跑，于是
  // withTimeout 超时、用例变红 —— 测的是"帧没来"，不是"没人结算"。
  drainFrames(dom);
  assert.strictEqual(await withTimeout(p, 'orphan'),
    'ok',
    '外部 ++token 之后，已排进 rAF 队列的那一帧必须替我们结算掉这个 Promise —— '
    + '否则切一次视图就有一条 await 永久挂起');
  assert.strictEqual(dom.pendingFrames(), 0, '作废之后不该再留下悬挂的帧（否则 DOM 还会被后续片改写）');
});

// ── 四、等排空句柄的可重入性：等待期间又来一次渲染 ────────────────
//
// 下面三条是首版修法的漏网处。单次 Promise.all 的写法里，等待期间到来的新一轮渲染
// 会**结算掉本轮的句柄**并把自己登记成新的在跑项，于是"只等一次"的 await 在**新
// 那一轮才画完首片**的时刻就返回；调用方紧接着查 DOM 仍会扑空，缺陷 1 原样复发
// （窗口比修之前窄，但照样复现）。三条都断言"句柄 resolve 的那一刻"DOM 的实际状态，
// 所以把那三个 while 循环改回单次 Promise.all 就会红。
//
// ⚠️ 三条的步骤顺序是判据的一部分，**不能改**：重渲染与"让微任务跑一轮"之间不许
//   先把帧跑掉。先跑帧再让出，单次 Promise.all 的写法也会绿 —— 因为那时 DOM 恰好
//   已经是全量，测到的就不是"返回早了"，而是"返回晚了"。真正的失败窗口是：
//   旧句柄被结算 → await 恢复 → **此刻新一轮只画了首片** → 查询扑空。

test('定位：等待分片的期间又来一次渲染，仍要闪到第 150 行（走产品入口的端到端）', async () => {
  const { dom, box } = await openBigPlaylist('manual');
  // locatePlayingInDetail 先同步算出 idx=149，再 await 排空句柄。此刻它挂在**本轮**分片上。
  const locating = globalThis.locatePlayingInDetail();
  globalThis.onPlaylistSongFilterInput('');            // 等待期间的重渲染（别的动作保存了歌单…）
  // 判据是"还有帧没跑"而不是写死帧数：第一轮那一片还挂在队列里没跑（它已被作废，
  // 跑起来只会自己结算），第二轮又排了一片。
  assert.ok(dom.pendingFrames() >= 1, `前置：第二轮分片确实在跑，实跑 ${dom.pendingFrames()} 帧`);
  assert.strictEqual(countRows(box, /data-pidx=/g), 100,
    '前置：新一轮此刻只画了首片（100 行）—— 这正是单次 Promise.all 会在这里扑空的时刻');
  await tick();                                        // 旧句柄此刻已结算，让定位恢复执行
  drainFrames(dom);
  assert.strictEqual(await withTimeout(locating, 'locate'), 'ok', '定位必须返回：返回不了就是有 Promise 永不结算');
  assert.deepStrictEqual(dom.toasts, [],
    '重渲染把本轮句柄结算掉就返回的话，此刻第 150 行还没画出来 ⇒ 照旧弹「不在可见列表」。实到='
    + JSON.stringify(dom.toasts));
  const flashed = dom.queried().filter((n) => n.scrolledIntoView);
  assert.strictEqual(flashed.length, 1, '应当正好闪了一行');
  assert.strictEqual(String(flashed[0].getAttribute('data-pidx')), '149', '闪的必须是第 150 行');
  assert.ok(box.innerHTML.includes('data-pidx="149"'), '第 150 行此刻必须已在 DOM 里');
});

test('网格：等待期间又来一次渲染，localGridRenderIdle resolve 时网格已是全量', async () => {
  const { dom, mod, box } = await localGrid('manual');
  mod.renderLocalGrid();                               // 第一轮：首片同步 + 2 帧
  // 在"resolve 的那一刻"取样，而不是在 await 之后再取 —— await 之后再取的话，
  // 单次 Promise.all 的写法会因为后面又跑了帧而看起来是全量，判据就废了。
  let rowsAtResolve = -1;
  const idle = mod.localGridRenderIdle().then(() => {
    rowsAtResolve = countRows(box, /class="grid-cell"/g);
  });
  mod.renderLocalGrid();                               // 第二轮：结算第一轮句柄、登记自己
  assert.strictEqual(countRows(box, /class="grid-cell"/g), 100, '前置：第二轮此刻只画了首片');
  await tick();
  drainFrames(dom);
  assert.strictEqual(await withTimeout(idle, 'idle'), 'ok');
  assert.strictEqual(rowsAtResolve, 250,
    'resolve 那一刻网格里有几格：循环版等第二轮画完 ⇒ 250；'
    + '只等一次的写法在第二轮才画了首片时就返回 ⇒ 100');
});

test('转换器：等待期间又来一次渲染，converterRenderIdle resolve 时列表已是全量', async () => {
  const songs = many(230);
  const dom = installBrowserGlobals({
    raf: 'manual',
    ids: ['converterSongList', 'converterInfo', 'converterSearch', 'converterSelectAll',
      'converterBatchFormat', 'converterBatchBitrate', 'converterOutputDir',
      'converterStartBtn', 'converterCancelBtn'],
    extraGlobals: { getState: (k) => (k === 'localSongs' ? songs : k === 'localDirPath' ? '' : null) },
  });
  const mod = await loadView(CONV, dom);
  globalThis.initConverter();                          // 第一轮：首片同步 + 2 帧（230/100）
  const list = dom.element('converterSongList');
  let rowsAtResolve = -1;
  const idle = globalThis.converterRenderIdle().then(() => {
    rowsAtResolve = countRows(list, /class="converter-song-item /g);
  });
  globalThis._converterSearch();                       // 重渲染：结算上一轮、登记新一轮
  assert.strictEqual(countRows(list, /class="converter-song-item /g), 100, '前置：新一轮此刻只画了首片');
  await tick();
  drainFrames(dom);
  assert.strictEqual(await withTimeout(idle, 'conv'), 'ok');
  assert.strictEqual(rowsAtResolve, 230,
    'resolve 那一刻列表里有几行：循环版等第二轮画完 ⇒ 230；只等一次 ⇒ 100');
  assert.ok(mod.OUTPUT_DIR_PREF !== undefined, '顺带确认导出面没被本次改动削掉');
});

// ── 三、converter 列表：分片 + 空态不覆盖 ────────────────────────

test('转换器列表：分片跑完后全部行出现，计数与列表一致', async () => {
  const songs = many(230);
  const dom = installBrowserGlobals({
    raf: 'auto',
    ids: ['converterSongList', 'converterInfo', 'converterSearch', 'converterSelectAll',
      'converterBatchFormat', 'converterBatchBitrate', 'converterOutputDir',
      'converterStartBtn', 'converterCancelBtn'],
    extraGlobals: { getState: (k) => (k === 'localSongs' ? songs : k === 'localDirPath' ? '' : null) },
  });
  const mod = await loadView(CONV, dom);
  globalThis.initConverter();
  assert.strictEqual(countRows(dom.element('converterSongList'), /class="converter-song-item /g), 100,
    '首屏同步一片（100 行）');
  const r = await withTimeout(globalThis.converterRenderIdle(), 'conv');
  assert.strictEqual(r, 'ok', 'converterRenderIdle() 必须能 resolve');
  assert.strictEqual(countRows(dom.element('converterSongList'), /class="converter-song-item /g), 230,
    '230 行必须全部落地');
  assert.strictEqual(mod.OUTPUT_DIR_PREF !== undefined, true, '顺带确认导出面没被本次改动削掉');
});
