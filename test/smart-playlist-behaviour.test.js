/**
 * AI 智能歌单（轨道三）行为测试 —— 真跑视图模块，不读源码做正则。
 *
 * 与 test/smart-playlist-ui.test.js 的分工：那枚钉的是**形状**（写库入口只有一处、
 * 令牌表覆盖全、键有双语），这枚钉的是**跑起来的行为**：面板展开、勾选掉出载荷、
 * 存下去的到底是哪几首、错误令牌出来的是整句人话还是裸大写。
 * 形状能正则、行为不能 —— 「勾掉的那首没进歌单」这句话只有真调用一遍才知道。
 *
 * 套具同 local-filter-chips.test.js：fake-dom + loadView（本仓没有 jsdom）。
 * 视图 import 的是 toast.js 的**具名导出**而不是全局桥，所以 toast 断言读真身写进
 * #toastContainer 的文本；toast.js 的同文案合并表是模块级单例、跨用例不清，
 * 因此每条 toast 文案本文件只断言一次（用不同歌单名让"已存为"那条天然不撞）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const VIEW = 'src/renderer/js/views/smart-playlist.js';
const zh = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lang', 'zh.json'), 'utf8'),
);

const IDS = [
  'smartPlPanel', 'smartPlScope', 'smartPlPrompt', 'smartPlGenBtn', 'smartPlStatus',
  'smartPlResult', 'smartPlName', 'smartPlReason', 'smartPlList', 'toastContainer',
];

const LISTS = [
  { id: 'favorites', name: '红心', songs: [{ id: 'f1', source: 'netease', title: 'F', artist: 'fa' }] },
  { id: 'p1', name: '夜骑', songs: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] },
  { id: 'p2' },
];

const PICKED = (count, total) =>
  zh['smartPl.picked'].replace('{count}', count).replace('{total}', total);

function makeDom({ invoke, save, lists = LISTS } = {}) {
  const calls = { getUserPlaylists: 0, invoke: [], save: [], loadUserPlaylists: 0 };
  const dom = installBrowserGlobals({
    ids: IDS,
    extraGlobals: {
      ipcRenderer: {
        invoke: (channel, ...args) => {
          calls.invoke.push([channel, ...args]);
          return invoke ? invoke(channel, ...args) : Promise.resolve({ ok: false, error: 'LLM_FAILED' });
        },
      },
      loadUserPlaylists: async () => { calls.loadUserPlaylists += 1; },
      api: {
        getUserPlaylists: async () => { calls.getUserPlaylists += 1; return lists; },
        saveUserPlaylist: (payload) => {
          calls.save.push(payload);
          return save ? save(payload) : Promise.resolve({ success: true });
        },
      },
    },
  });
  return { dom, calls };
}

async function fresh(opts) {
  const { dom, calls } = makeDom(opts);
  await loadView(VIEW, dom);
  const el = (id) => dom.element(id);
  const status = () => el('smartPlStatus').textContent;
  const rows = () => el('smartPlList').children;
  const toasts = () => el('toastContainer').children.map((c) => c.textContent);
  return { dom, calls, el, status, rows, toasts };
}

/** 展开面板、填主题并点一次生成 —— 用户走的就是这条路 */
async function run(h) {
  await globalThis.toggleSmartPanel();
  h.el('smartPlPrompt').value = '  适合夜跑的快节奏  ';
  await globalThis.runSmartPlaylist();
  return h;
}

test('展开面板：范围下拉用真歌单填，♥ 不重复列出，无名歌单不进选项', async () => {
  const h = await fresh({});
  await globalThis.toggleSmartPanel();
  assert.strictEqual(h.el('smartPlPanel').style.display, 'flex');
  assert.strictEqual(h.calls.getUserPlaylists, 1, '每次展开重拉：刚建的单要立刻能选');
  const opts = h.el('smartPlScope').children;
  assert.deepStrictEqual(opts.map((o) => o.value), ['library', 'favorites', 'playlist:p1']);
  assert.deepStrictEqual(opts.map((o) => o.textContent),
    [zh['smartPl.scopeLibrary'], zh['smartPl.scopeFavorites'], '夜骑 · 3']);
});

test('收起再展开：重拉一次歌单，而不是拿第一次的缓存骗人', async () => {
  const h = await fresh({});
  await globalThis.toggleSmartPanel();
  await globalThis.toggleSmartPanel();
  assert.strictEqual(h.el('smartPlPanel').style.display, 'none');
  assert.strictEqual(h.calls.getUserPlaylists, 1, '收起不该拉，也不该在收起时拉');
  await globalThis.toggleSmartPanel();
  assert.strictEqual(h.calls.getUserPlaylists, 2, '第二次展开必须再拉一次');
});

test('主题空着：不发通道请求，状态是词典里那句「先写一句主题」', async () => {
  const h = await fresh({});
  h.el('smartPlPrompt').value = '   ';
  await globalThis.runSmartPlaylist();
  assert.strictEqual(h.calls.invoke.length, 0);
  assert.strictEqual(h.status(), zh['smartPl.needPrompt']);
});

test('生成成功：通道恰好一次、参数是(主题, 范围)，行用 textContent 上屏', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({
      ok: true,
      name: '夜跑节奏',
      reason: 'bpm 都在 160 以上',
      songs: [
        { id: 'a', source: 'netease', title: 'A', artist: 'ar' },
        { id: 'b', source: 'qq', title: 'B' },
      ],
      candidateCount: 2,
      truncated: 0,
    }),
  });
  await run(h);
  assert.deepStrictEqual(h.calls.invoke,
    [['smart-playlist-generate', '适合夜跑的快节奏', 'library']]);
  assert.strictEqual(h.el('smartPlName').value, '夜跑节奏');
  assert.strictEqual(h.rows().length, 2);
  assert.deepStrictEqual(h.rows().map((r) => r.children[1].textContent), ['1. A — ar', '2. B']);
  assert.strictEqual(h.status(), PICKED(2, 2), '没截断时不许出现"另有 n 首"');
  assert.strictEqual(h.el('smartPlGenBtn').disabled, false, '生成结束要解禁');
});

test('模型给的 name/reason 含尖括号：只能作为文本出现，一次 innerHTML 都不写', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const h = await fresh({
    invoke: () => Promise.resolve({
      ok: true, name: nasty, reason: nasty, songs: [{ id: 'a', title: nasty }], truncated: 0,
    }),
  });
  await run(h);
  assert.strictEqual(h.el('smartPlReason').innerHTML, '');
  assert.strictEqual(h.el('smartPlList').innerHTML, '');
  assert.strictEqual(h.el('smartPlReason').textContent, nasty);
  assert.strictEqual(h.rows()[0].children[1].textContent, `1. ${nasty}`);
});

test('候选被钳过：截断条数必须说出来，否则用户以为 AI 读完了整个曲库', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({
      ok: true, name: 'n', reason: 'r', songs: [{ id: 'a', title: 'A' }], truncated: 137,
    }),
  });
  await run(h);
  assert.strictEqual(h.status(), `${PICKED(1, 1)} · ${zh['smartPl.truncated'].replace('{n}', 137)}`);
});

test('连点生成：前一次没回来时第二次一口都不张（不重复出网、不重复计费）', async () => {
  let release;
  const h = await fresh({ invoke: () => new Promise((r) => { release = r; }) });
  h.el('smartPlPrompt').value = '夜跑';
  const first = globalThis.runSmartPlaylist();
  assert.strictEqual(h.el('smartPlGenBtn').disabled, true);
  await globalThis.runSmartPlaylist();
  assert.strictEqual(h.calls.invoke.length, 1, '忙时第二次必须直接返回');
  release({ ok: true, name: 'n', reason: 'r', songs: [{ id: 'a', title: 'A' }], truncated: 0 });
  await first;
  assert.strictEqual(h.el('smartPlGenBtn').disabled, false);
});

test('取消勾选：这首掉出保存载荷，且摘要计数当场的跟着变', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({
      ok: true, name: '夜跑', reason: 'r',
      songs: [{ id: 'a', source: 'netease', title: 'A' }, { id: 'b', source: 'netease', title: 'B' }],
      truncated: 0,
    }),
  });
  await run(h);
  const second = h.rows()[1].children[0];
  assert.strictEqual(second.checked, true, '生成回来的每一首默认都勾着');
  second.dispatch('change');
  assert.strictEqual(h.status(), PICKED(1, 2));

  h.el('smartPlName').value = '我的夜跑单';
  await globalThis.saveSmartPlaylist();
  assert.strictEqual(h.calls.save.length, 1, '存歌单只有点下去那一次');
  const payload = h.calls.save[0];
  assert.deepStrictEqual(payload.songs.map((s) => s.id), ['a'], '勾掉的那首不许混进去');
  assert.strictEqual(payload.name, '我的夜跑单');
});

test('存为歌单：补 addedAt、文案取自词典、成功后收面板并刷新侧栏', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({
      ok: true, name: 'AI 草稿', reason: 'r',
      songs: [{ id: 'a', source: 'netease', title: 'A', artist: 'ar' }], truncated: 0,
    }),
  });
  await run(h);
  assert.strictEqual(h.el('smartPlPanel').style.display, 'flex', '生成成功时面板还开着');
  assert.strictEqual(h.el('smartPlName').value, 'AI 草稿', '模型给的名字先进输入框，用户可改');
  h.el('smartPlName').value = '  改过的名字  ';
  await globalThis.saveSmartPlaylist();
  const payload = h.calls.save[0];
  assert.strictEqual(payload.name, '改过的名字', '存的是用户改后的，不是模型给的');
  assert.strictEqual(payload.desc, zh['smartPl.descTag'].replace('{count}', '1'));
  assert.strictEqual(typeof payload.songs[0].addedAt, 'number');
  assert.strictEqual(payload.songs[0].title, 'A', '歌曲对象原样带上，只多一个 addedAt');
  assert.deepStrictEqual(h.toasts(), [zh['toast.smartPlSaved'].replace('{name}', '改过的名字').replace('{count}', '1')]);
  assert.strictEqual(h.el('smartPlPanel').style.display, 'none');
  assert.strictEqual(h.calls.loadUserPlaylists, 1, '新建的单要立刻出现在侧栏');
});

test('名字空着：不写库，toast 是词典那句「歌单名不能空着」', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({ ok: true, name: 'x', reason: 'r', songs: [{ id: 'a', title: 'A' }], truncated: 0 }),
  });
  await run(h);
  h.el('smartPlName').value = '  ';
  await globalThis.saveSmartPlaylist();
  assert.strictEqual(h.calls.save.length, 0);
  assert.deepStrictEqual(h.toasts(), [zh['toast.smartPlNeedName']]);
});

test('一首都没勾上：不写库（宁可不存，也不给用户建一个空歌单）', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({ ok: true, name: 'x', reason: 'r', songs: [{ id: 'a', title: 'A' }], truncated: 0 }),
  });
  await run(h);
  h.rows()[0].children[0].dispatch('change');
  h.el('smartPlName').value = '空的';
  await globalThis.saveSmartPlaylist();
  assert.strictEqual(h.calls.save.length, 0);
  assert.deepStrictEqual(h.toasts(), [zh['toast.smartPlNothing']]);
});

test('写库失败：toast 报错、面板不收起、侧栏不刷新（用户还能改完再存）', async () => {
  const h = await fresh({
    invoke: () => Promise.resolve({ ok: true, name: 'x', reason: 'r', songs: [{ id: 'a', title: 'A' }], truncated: 0 }),
    save: () => Promise.resolve({ success: false }),
  });
  await run(h);
  h.el('smartPlName').value = '再存一次';
  await globalThis.saveSmartPlaylist();
  assert.deepStrictEqual(h.toasts(), [zh['toast.smartPlSaveFailed']]);
  assert.strictEqual(h.el('smartPlPanel').style.display, 'flex');
  assert.strictEqual(h.calls.loadUserPlaylists, 0);
});

test('主进程只发 ASCII 令牌：界面上是整句人话，一个大写字母都不许漏给用户', async () => {
  for (const [code, key] of [['NO_KEY', 'smartPl.errNoKey'], ['NO_PICKS', 'smartPl.errNoPicks']]) {
    const h = await fresh({ invoke: () => Promise.resolve({ ok: false, error: code }) });
    await run(h);
    assert.strictEqual(h.status(), zh[key]);
    assert.strictEqual(h.rows().length, 0, '失败时结果区不该留下上一次的行');
  }
});

test('没登记过的令牌：回落到「生成失败，稍后再试」而不是把大写印在界面上', async () => {
  const h = await fresh({ invoke: () => Promise.resolve({ ok: false, error: 'SOMETHING_NEW' }) });
  await run(h);
  assert.strictEqual(h.status(), zh['smartPl.errLlmFailed']);
  assert.ok(!h.status().includes('SOMETHING_NEW'));
});

test('通道直接抛（网络断）：走 errBrief 的人话层，按钮解禁', async () => {
  const h = await fresh({ invoke: () => Promise.reject(new Error('fetch failed')) });
  await run(h);
  assert.strictEqual(h.status(),
    zh['smartPl.errInvoke'].replace('{msg}', '网络异常，请检查网络/代理后重试'));
  assert.strictEqual(h.el('smartPlGenBtn').disabled, false);
});

test('拉歌单失败：面板照常可用，只是少几个单个歌单选项（别把整个功能废掉）', async () => {
  const h = await fresh({});
  globalThis.api.getUserPlaylists = async () => { throw new Error('ipc down'); };
  await globalThis.toggleSmartPanel();
  assert.deepStrictEqual(h.el('smartPlScope').children.map((o) => o.value), ['library', 'favorites']);
});
