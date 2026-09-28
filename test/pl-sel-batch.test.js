/**
 * 测试：歌单详情多选「⬇ 下载已勾选 / ▶ 播放已勾选」
 * plSelBatch 纯函数直调 + 接线静态钉（views/playlist.js / index.html / commandPalette.js）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PL_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const PALETTE = fs.readFileSync(path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import(`../src/renderer/js/plSelBatch.js?v=${Math.random()}`);
}

test('planSelEnqueue：同 id+source 未完成才跳，done 不跳，保序丢空洞', async () => {
  const { planSelEnqueue } = await fresh();
  const snap = [
    { id: '1', source: 'netease', status: 'done' },
    { id: '2', source: 'qq', status: 'downloading' },
    { id: '3', source: 'netease', status: 'queued' },
  ];
  const songs = [
    { id: '1', source: 'netease', title: '完了过' },   // done → 允许再下
    { id: '2', source: 'qq', title: '下载中' },        // 命中 → 跳
    null,                                             // 空洞 → 丢，不计数
    { id: '3', source: 'netease', title: '排队中' },   // 命中 → 跳
    { id: '3', source: 'kuwo', title: '同id不同台' },  // source 不同 → 入队
  ];
  const { toEnqueue, skipped } = planSelEnqueue(songs, snap);
  assert.strictEqual(skipped, 2);
  assert.deepStrictEqual(toEnqueue.map(s => s.title), ['完了过', '同id不同台']);
  // 防御：非数组输入不炸
  assert.deepStrictEqual(planSelEnqueue(undefined, undefined), { toEnqueue: [], skipped: 0 });
  assert.deepStrictEqual(planSelEnqueue([], null), { toEnqueue: [], skipped: 0 });
});

test('enqueueSkipSuffix：零跳过空串，单项/双项按既有文案拼', async () => {
  const { enqueueSkipSuffix } = await fresh();
  assert.strictEqual(enqueueSkipSuffix(0, 0), '');
  assert.strictEqual(enqueueSkipSuffix(3, 0), '（跳过 3 首已在队列）');
  assert.strictEqual(enqueueSkipSuffix(0, 2), '（跳过 2 首已下载过）');
  assert.strictEqual(enqueueSkipSuffix(3, 2), '（跳过 3 首已在队列，2 首已下载过）');
});

test('playlist.js 接线：_playFrom 抽取、整单入队去重、多选两动作在位', async () => {
  const { planSelEnqueue } = await fresh();
  assert.ok(typeof planSelEnqueue === 'function');
  // playPlaylistSong 变薄壳，取流主体抽成 _playFrom（多选连播复用）
  assert.ok(/async function playPlaylistSong\(idx\) \{\n {2}await _playFrom\(_currentDetailSongs, idx\);/.test(PL_JS), 'playPlaylistSong 应委托 _playFrom');
  assert.ok((PL_JS.match(/_playFrom\(/g) || []).length === 3, '定义1 + 单点1 + 多选连播1');
  // 判重规则收编进纯函数：playlist.js 里只剩单曲守卫一处内联 status 判定
  assert.ok((PL_JS.match(/status !== 'done'/g) || []).length === 1, '整单入队的内联判重应已移入 plSelBatch');
  assert.ok((PL_JS.match(/planSelEnqueue\(/g) || []).length === 2, '整单 + 多选各调一次');
  assert.ok((PL_JS.match(/enqueueSkipSuffix\(/g) || []).length === 2, '两条批量线共用文案后缀');
  // 勾选提取复用0178f20 的 splitBySelection（键=歌身份），不再自造第二套选态
  assert.equal((PL_JS.match(/splitBySelection\(_currentDetailSongs, _plSelKeys\)/g) || []).length, 1);
  assert.ok(/function _plSelPicked\(\) \{\n {2}return splitBySelection\(_currentDetailSongs, _plSelKeys\)\.removed;/.test(PL_JS));
  assert.ok((PL_JS.match(/_plSelPicked\(\)/g) || []).length === 3, '定义1 + 下载/播放各1');
  assert.ok(/async function plSelDownload\(\)/.test(PL_JS));
  assert.ok(/async function plSelPlay\(\) \{[\s\S]*?await _playFrom\(picked, 0\);/.test(PL_JS));
  // 按钮同步扩到 5 件套（计数徽标随勾选数走）
  assert.ok(PL_JS.includes('⬇ 下载 ${_plSelKeys.size}'));
  assert.ok(PL_JS.includes('▶ 播放 ${_plSelKeys.size}'));
  // 桥接
  assert.ok(PL_JS.includes('window.plSelDownload = plSelDownload;'));
  assert.ok(PL_JS.includes('window.plSelPlay = plSelPlay;'));
});

test('index.html 两按钮默认隐藏 + 命令面板两条目', () => {
  assert.ok(/id="plSelDlBtn" class="btn-sm hidden"|class="btn-sm hidden" id="plSelDlBtn"/.test(HTML));
  assert.ok(HTML.includes('id="plSelPlayBtn"'));
  assert.ok((HTML.match(/onclick="plSelDownload\(\)"/g) || []).length === 1);
  assert.ok((HTML.match(/onclick="plSelPlay\(\)"/g) || []).length === 1);
  assert.ok(PALETTE.includes("id: 'pl-seldl'"));
  assert.ok(PALETTE.includes("id: 'pl-selplay'"));
  assert.ok(PALETTE.includes("_call('plSelDownload')"));
  assert.ok(PALETTE.includes("_call('plSelPlay')"));
});
