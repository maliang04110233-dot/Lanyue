/**
 * 队列恢复后自启动（2026-10-13 复审 P0-1）
 *
 * 复审发现的洞：恢复只「续数据」不「续行为」。index.js 启动时调
 * loadPersistedQueue() 把 queue.json 的 pending 塞回队列，但全仓
 * processQueue() 只在用户动作（新增单曲 / 重试 / 批量入队 / 订阅自动下载）
 * 里被调用 —— 于是重启后界面显示「排队中 N 首」，实际一首都不下，
 * 直到用户手动加一首歌或切一次暂停/继续；只等着的用户，这些任务 24 小时后
 * 还会被 STALE_PENDING_MS 判死。
 *
 * 本文件钉两件事：
 *   1. 行为：resumeRestoredQueue() 把 pending 真的推上调度器（取流被调用）；
 *      而 error/done **不**自动重跑（失败任务的语义是等用户决定）。
 *   2. 接线：index.js 必须在注册完 IPC handler 之后调用它。行为用例测不到
 *      「调用点是否存在」，而这恰恰是原 bug 的根因，所以用静态断言补上。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createDownloadQueueEngine } = require('../src/main/downloadQueue');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qresume-test-'));
}

/**
 * 与 downloadQueue.test.js 同一套注入约定：history / fsa / downloader 走
 * 依赖注入（引擎在顶层解构绑定，patch 模块单例无效 —— 那边踩过），
 * prefs 按引擎既有约定仍用 patch。
 */
function buildEngine(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const fetched = [];

  const prefs = require('../src/utils/prefs');
  const origPrefsGet = prefs.get;
  const prefsStore = { concurrency: 2, namingTemplate: '{artist} - {title}', ...(overrides.prefs || {}) };
  prefs.get = (k) => prefsStore[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: () => {},
    getDownloadUrlSmart: async (song) => { fetched.push(String(song && song.id)); return { url: 'https://cdn/x.mp3', ext: 'mp3' }; },
    getLyrics: async () => ({ lrc: '' }),
    notifier: { notifyDownloadDone: () => {} },
    getDefaultDownloadDir: () => path.join(dir, 'dl'),
    history: { add: () => {} },
    fsa: { statOrNull: async () => ({ size: 1 }) },
    downloader: {
      downloadFileWithRetry: async () => {},
      embedId3Tags: async () => {},
    },
  });

  return { engine, dir, fetched, restore: () => { prefs.get = origPrefsGet; } };
}

async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('resumeRestoredQueue: 恢复出的 pending 会被真的推上调度器', async () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    { id: 'p1', source: 'q', title: '待下载', status: 'pending', addedAt: now },
    { id: 'e1', source: 'q', title: '已失败', status: 'error', addedAt: now },
    { id: 'd1', source: 'q', title: '已完成', status: 'done', addedAt: now },
  ]));
  const { engine, fetched, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    const scheduled = engine.resumeRestoredQueue();
    assert.strictEqual(scheduled, 1, '只有 pending 应被自动调度');
    await waitFor(() => fetched.includes('p1'));
    assert.deepStrictEqual(fetched, ['p1'],
      'error/done 不得自动重跑：失败任务的语义是等用户决定');
  } finally { restore(); }
});

test('resumeRestoredQueue: 没有 pending 时是空操作', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    { id: 'e1', source: 'q', title: 'x', status: 'error', addedAt: Date.now() },
  ]));
  const { engine, fetched, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.resumeRestoredQueue(), 0);
    assert.deepStrictEqual(fetched, [], '无 pending 时不该触发任何取流');
  } finally { restore(); }
});

test('resumeRestoredQueue: 暂停状态下不启动（尊重用户暂停语义）', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    { id: 'p1', source: 'q', title: 't', status: 'pending', addedAt: Date.now() },
  ]));
  const { engine, fetched, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    engine.setPaused(true);
    engine.resumeRestoredQueue();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(fetched, [], '用户暂停过就别在启动时偷偷开跑');
  } finally { restore(); }
});

test('接线钉：index.js 恢复队列后必须调用 resumeRestoredQueue', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const loadAt = src.indexOf('loadPersistedQueue()');
  const resumeAt = src.indexOf('resumeRestoredQueue()');
  assert.ok(loadAt >= 0, 'index.js 应仍有启动恢复调用（改动请同步本守卫）');
  assert.ok(resumeAt > loadAt,
    '必须在恢复之后调用 resumeRestoredQueue —— 原 bug 正是「只加载不调度」');
  const regAt = src.indexOf('registerAllIpcHandlers()');
  assert.ok(resumeAt > regAt,
    '应在 registerAllIpcHandlers 之后调度：取流/歌词等上下文在那段装配里才就绪');
});
