/**
 * 增量177：首个下载成功的 moment-of-truth 庆祝（check 回写）。
 *
 * 覆盖两层：
 *  1) createFirstDownloadMachine —— 纯状态机，判"这真是用户史上第一次下载成功"的门槛逻辑，
 *     在 Node 里用注入的假 api 直接驱动，不碰 DOM。
 *  2) showActionToast 的 tone 扩展 —— 庆祝条要走成功色，且既有「撤销/仍要下载」两处的长相不许变。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// logger.js 顶层读 window.location；afterQueueDone 同款垫片
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/firstDownloadCelebration.js?fdc=${Math.random()}`);
}

// ── 门槛谓词 ───────────────────────────────────────────

test('isDoneRow：只有 status=done 且有落盘路径的行才算"下载成功"', async () => {
  const { isDoneRow } = await fresh();
  assert.strictEqual(isDoneRow({ status: 'done', savePath: '/x/a.mp3' }), true);
  assert.strictEqual(isDoneRow({ status: 'done', filePath: '/x/a.mp3' }), true);
  assert.strictEqual(isDoneRow({ status: 'downloading', savePath: '/x/a.mp3' }), false);
  assert.strictEqual(isDoneRow({ status: 'done' }), false, 'done 但没路径（异常）不算');
  assert.strictEqual(isDoneRow(null), false);
  assert.strictEqual(isDoneRow({}), false);
});

test('hasActiveRow：pending/downloading 才算活跃——启动恢复的全终态队列不能误判为"刚下完"', async () => {
  const { hasActiveRow } = await fresh();
  assert.strictEqual(hasActiveRow([{ status: 'downloading' }]), true);
  assert.strictEqual(hasActiveRow([{ status: 'pending' }]), true);
  assert.strictEqual(hasActiveRow([{ status: 'done' }, { status: 'error' }]), false);
  assert.strictEqual(hasActiveRow([]), false);
  assert.strictEqual(hasActiveRow(null), false);
});

// ── 状态机：真·首下的判定 ──────────────────────────────

async function mk(over = {}) {
  const { createFirstDownloadMachine } = await fresh();
  const calls = { celebrate: [], setPref: [] };
  const cfg = Object.assign({
    getPref: async () => undefined,        // 默认：没庆祝过
    setPref: async (k, v) => { calls.setPref.push([k, v]); },
    getHistoryStats: async () => ({ done: 1 }), // 默认：这条就是唯一一条完成记录
    onCelebrate: (song) => { calls.celebrate.push(song); },
  }, over);
  return { calls, m: createFirstDownloadMachine(cfg) };
}

test('没先见过活跃任务 → 完成行也不庆祝（启动恢复队列保护）', async () => {
  const { calls, m } = await mk();
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  assert.deepStrictEqual(calls.celebrate, [], '凭空的全终态队列不该触发庆祝');
});

test('活跃→完成，且是史上第一条 → 庆祝一次并把该歌传出去', async () => {
  const { calls, m } = await mk();
  m.observe([{ status: 'downloading', savePath: '/x/a.mp3', title: 'A' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A', artist: '甲' }]);
  await m.idle();
  assert.strictEqual(calls.celebrate.length, 1);
  assert.strictEqual(calls.celebrate[0].title, 'A');
  assert.strictEqual(calls.celebrate[0].savePath, '/x/a.mp3');
});

test('pref 已记庆祝过 → 永不二次打扰', async () => {
  const { calls, m } = await mk({ getPref: async () => '1' });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  assert.deepStrictEqual(calls.celebrate, []);
  assert.deepStrictEqual(calls.setPref, [], '既然已经庆祝过，不该再写 pref');
});

test('老用户（历史完成数>1）升级后首次下载 → 不谎报"第一次"，改为静默记 pref 免再查', async () => {
  const { calls, m } = await mk({ getHistoryStats: async () => ({ done: 42 }) });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  assert.deepStrictEqual(calls.celebrate, [], '第 42 次下载不是第一次，不该庆祝');
  assert.strictEqual(calls.setPref.length, 1, '应记 pref 短路后续查询');
  assert.strictEqual(calls.setPref[0][0], 'firstDownloadCelebrated');
});

test('一个会话只庆祝一次：连续多帧 done 不再触发', async () => {
  const { calls, m } = await mk();
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  assert.strictEqual(calls.celebrate.length, 1);
});

test('庆祝回调抛异常被吞掉，机器不卡死、pref 已记不会再进', async () => {
  const { calls, m } = await mk({
    onCelebrate: () => { throw new Error('boom'); },
  });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle(); // 不应 reject
  assert.strictEqual(calls.setPref.length, 1, '庆祝前置了 pref 写入，异常不影响记账');
});

test('取 pref/统计失败 → 保守不庆祝（宁可不弹，也不误弹）', async () => {
  const { calls, m } = await mk({ getPref: async () => { throw new Error('ipc down'); } });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done', savePath: '/x/a.mp3', title: 'A' }]);
  await m.idle();
  assert.deepStrictEqual(calls.celebrate, []);
});

// ── showActionToast 的 tone 扩展：成功色 + 既有调用长相不变 ──

test('showActionToast 接可选 tone：庆祝走成功色，默认仍是 warn（既有两处不受影响）', () => {
  const utils = read('src', 'renderer', 'js', 'utils.js');
  const body = utils.slice(utils.indexOf('function showActionToast('));
  // tone 参数存在且有默认值 warn
  assert.match(body, /tone\s*=\s*['"]warn['"]/, 'tone 需默认 warn，老调用零改动');
  // 成功走 .toast-success，其余走 .toast-warn（类名来自 base.css 两族，禁裸色值）
  assert.match(body, /tone === ['"]success['"]/, '成功分支挂 toast-success');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body.split('\n').filter((l) => !/^\s*[//*]/.test(l)).join('\n')),
    'tone 拼装里不得出现裸色值');
});

test('.toast-success 类确实在样式表里（庆祝色有落处，非凭空引用）', () => {
  const css = read('src', 'renderer', 'styles', 'base.css');
  assert.match(css, /\.toast-success\b/, 'base.css 需有 .toast-success');
});

// ── 接线钉：观察器挂上 app.js 的 onQueueUpdated，且庆祝走既有函数 ──

test('接线：app.js 队列推送里调用 window.firstDownloadCelebrateObserve，与三个兄弟观察器同段', () => {
  const app = read('src', 'renderer', 'js', 'app.js');
  const at = app.indexOf('api.onQueueUpdated((queue)');
  assert.ok(at > -1, '找不到 onQueueUpdated 段');
  const body = app.slice(at, at + 900);
  assert.match(body, /window\.firstDownloadCelebrateObserve/, '观察器没挂进队列推送');
  // 兄弟观察器同在（证明这是既有范式，不是新造通道）
  assert.match(body, /afterQueueObserve/);
  assert.match(body, /autoCoverObserve/);
});

test('庆祝条的动作走既有 api.openFolder（回答"文件在哪"），零新 IPC；播放引向队列行既有 ▶', async () => {
  const src = read('src', 'renderer', 'js', 'firstDownloadCelebration.js');
  // 必须走 openFolderSafe（utils.js 的唯一出口）：裸调 api.openFolder 在主进程
  // 沙箱拒绝时是静默失败 —— 用户点了没反应也没有提示，而这里正是「打开文件夹」
  // 的高频位置。
  assert.match(src, /openFolderSafe\(/, '应走 openFolderSafe（被拒时有提示）');
  assert.doesNotMatch(src, /api\.openFolder\(/, '裸调 api.openFolder 会静默失败');
  assert.match(src, /播放/, '文案要把"接下来听"引到队列行既有的播放入口');
  assert.ok(!/ipcRenderer\.|require\(['"]electron/.test(src), '渲染层不得直连 ipcRenderer');
});

test('反钉：庆祝文案不在 JS 里裸写色值，走 toast tone 类', async () => {
  const src = read('src', 'renderer', 'js', 'firstDownloadCelebration.js');
  const noComments = src.split('\n').filter((l) => !/^\s*[//*]/.test(l)).join('\n');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(noComments), '色值一律走 CSS 类/token');
});
