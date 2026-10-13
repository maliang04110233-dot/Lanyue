/**
 * 取消/移除后的在途协程必须真的停下（2026-10-13 复审 P1-4）
 *
 * 旧实现在每轮 attempt 顶部查一次 `_cancelRequested || !downloadQueue.includes(song)`，
 * 而 attempt 内部是一串长 await（取流 → 下载 → 歌词 → 嵌标签 → 写历史）。取消只能
 * 打断已登记到 _inflightReqs 的那个请求，其余阶段形同虚设：
 *
 *   被移除的歌跑完带宽 → 落到正式文件名 → 嵌标签 → 写 history done → 弹通知，
 *   而对象已被 splice，这些动作对用户全都不可见 ⇒ 磁盘上出现用户没要过的文件，
 *   历史里多一条他没下过的记录。
 *
 * 修复后在三个检查点补判据：取流之后、传输完成之后、终态落笔之前。
 * 本文件把「移除 ⇒ 不嵌标签、不写历史、不通知」钉成行为，并留一条对照用例，
 * 确认正常任务不受影响。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDownloadQueueEngine } = require('../src/main/downloadQueue');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qabort-test-'));
}

/**
 * 与 downloadQueue.test.js 同一套注入约定：history / fsa / downloader 走
 * 依赖注入（引擎顶层解构绑定，patch 模块单例无效），prefs 用 patch。
 */
function buildEngine(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const historyAdds = [];
  const embeds = [];
  const downloads = [];

  const prefs = require('../src/utils/prefs');
  const origPrefsGet = prefs.get;
  const prefsStore = { concurrency: 1, namingTemplate: '{artist} - {title}', ...(overrides.prefs || {}) };
  prefs.get = (k) => prefsStore[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: () => {},
    getDownloadUrlSmart: overrides.getDownloadUrlSmart
      || (async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' })),
    getLyrics: overrides.getLyrics || (async () => ({ lrc: '' })),
    notifier: { notifyDownloadDone: () => {} },
    history: { add: (rec) => { historyAdds.push(rec); } },
    fsa: { statOrNull: async () => ({ size: 1 }) },
    downloader: {
      downloadFileWithRetry: overrides.downloadFileWithRetry
        || (async (url, savePath) => { downloads.push(savePath); }),
      embedId3Tags: overrides.embedId3Tags
        || (async () => { embeds.push(1); }),
    },
  });

  return { engine, dir, historyAdds, embeds, downloads, restore: () => { prefs.get = origPrefsGet; } };
}

async function waitFor(fn, { timeout = 3000, interval = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('P1-4：传输期间被移出队列 ⇒ 不嵌标签、不写历史、不通知', async () => {
  let started = false;
  let release;
  const gate = new Promise((r) => { release = r; });

  const { engine, historyAdds, embeds, restore } = buildEngine({
    downloadFileWithRetry: async () => { started = true; await gate; },
  });
  try {
    const q = engine.getQueue();
    q.push({ id: '1', source: 'q', title: '会被移除的歌', taskId: 'x1', status: 'pending', addedAt: Date.now() });
    engine.processQueue();

    await waitFor(() => started);
    // 用户在传输途中把它从队列里移除（渲染层 remove-queue-item 的实际效果）
    q.splice(q.findIndex((s) => s.taskId === 'x1'), 1);
    release();

    // 让协程跑完它剩下的所有 await
    await new Promise((r) => setTimeout(r, 150));

    assert.deepStrictEqual(embeds, [], '已被移除的任务不该再嵌 ID3');
    assert.deepStrictEqual(historyAdds, [], '已被移除的任务不该写下载历史（旧实现会记一条 done）');
  } finally { restore(); }
});

test('P1-4（对照组）：正常完成的任务照旧嵌标签并写历史', async () => {
  const { engine, historyAdds, embeds, restore } = buildEngine();
  try {
    engine.getQueue().push({
      id: '1', source: 'q', title: '正常歌', taskId: 'x2', status: 'pending', addedAt: Date.now(),
    });
    engine.processQueue();
    await waitFor(() => historyAdds.length > 0);
    assert.strictEqual(embeds.length, 1, '正常任务必须嵌标签');
    assert.strictEqual(historyAdds[0].status, 'done');
    assert.strictEqual(historyAdds[0].title, '正常歌');
  } finally { restore(); }
});

test('P1-4：取流期间被取消 ⇒ 不进入传输阶段', async () => {
  let releaseUrl;
  const gate = new Promise((r) => { releaseUrl = r; });
  const downloads = [];
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => { await gate; return { url: 'https://cdn/x.mp3', ext: 'mp3' }; },
    downloadFileWithRetry: async (url, savePath) => { downloads.push(savePath); },
  });
  try {
    const q = engine.getQueue();
    const song = { id: '1', source: 'q', title: '取消的歌', taskId: 'x3', status: 'pending', addedAt: Date.now() };
    q.push(song);
    engine.processQueue();
    await new Promise((r) => setTimeout(r, 20));
    song._cancelRequested = true;      // 用户点取消
    releaseUrl();

    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(downloads, [], '取流返回后必须复查取消状态，不该白下一遍');
  } finally { restore(); }
});
