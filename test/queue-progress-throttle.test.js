/**
 * 下载进度上报的节流（2026-10-13 复审 P2-1）
 *
 * 旧实现每个 data chunk 都 safeSend 一次 download-progress，而
 * src/main/context.js 在每条 download-progress 上还会触发
 * taskbarProgress.refresh() —— 那是一次对**整个队列**的 O(n) 扫描。无限速时
 * 单任务每秒数百次回调，并发 N 首线性放大。渲染层 queueSummary.js 的注释还写着
 * 「main 端已节流」—— 那条注释本身就是误导源。
 *
 * 本文件钉两件事：
 *   1. 密集进度被合并，且 100% 那一拍**总是**发出（否则界面停在 99%）；
 *   2. song.progress 仍每次都更新（队列摘要读它，不依赖事件）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDownloadQueueEngine } = require('../src/main/downloadQueue');
const ROOT = path.join(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qprog-test-'));
}

function buildEngine(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const events = [];
  const prefs = require('../src/utils/prefs');
  const origPrefsGet = prefs.get;
  prefs.get = (k) => ({ concurrency: 1, namingTemplate: '{title}', ...(overrides.prefs || {}) }[k]);

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: (ch, payload) => { events.push({ ch, payload }); },
    getDownloadUrlSmart: async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' }),
    getLyrics: async () => ({ lrc: '' }),
    notifier: { notifyDownloadDone: () => {} },
    history: { add: () => {} },
    fsa: { statOrNull: async () => ({ size: 1000 }) },
    downloader: overrides.downloader,
  });

  return { engine, dir, events, restore: () => { prefs.get = origPrefsGet; } };
}

async function waitFor(fn, { timeout = 3000, interval = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('P2-1：密集进度被节流，100% 那一拍必须发出去', async () => {
  let send = null;
  const { engine, events, restore } = buildEngine({
    downloader: {
      // 模拟 200 个 chunk 在极短时间内全部到达：进度一路爬到 99%，最后单独补一拍 100%
      // （真实传输里 100% 只会来一次；测试里若反复给 100，那属于「终态抖动」，
      //   恰恰是节流规则里唯一被有意放行的情况，不该拿来衡量节流效果）
      downloadFileWithRetry: async (url, savePath, onProgress) => {
        for (let i = 1; i <= 200; i++) {
          onProgress(Math.min(99, Math.round((i / 200) * 100)), { receivedBytes: i * 10, totalBytes: 2000 });
        }
        onProgress(100, { receivedBytes: 2000, totalBytes: 2000 });
        send = true;
      },
      embedId3Tags: async () => {},
    },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'q', title: 't', taskId: 'p1', status: 'pending', addedAt: Date.now() });
    engine.processQueue();
    await waitFor(() => send);

    const prog = events.filter(e => e.ch === 'download-progress');
    assert.ok(prog.length > 0, '至少要发一次进度');
    assert.ok(prog.length <= 12,
      `200 个 chunk 不该产生 ${prog.length} 条 IPC（节流失效）`);
    assert.strictEqual(prog[prog.length - 1].payload.progress, 100,
      '100% 必须发出去，否则界面停在 99%');
    assert.strictEqual(engine.getQueue()[0].progress, 100, 'song.progress 仍要更新到最终值');
  } finally { restore(); }
});

test('P2-1（守卫钉）：渲染层那条「main 端已节流」的注释必须与实现相符', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/downloadQueue.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(ROOT, 'src/renderer/js/queueSummary.js'), 'utf8');
  assert.ok(main.includes('PROGRESS_THROTTLE_MS'),
    '主进程必须有节流常量，否则「已节流」又成了一句空话');
  assert.ok(renderer.includes('PROGRESS_THROTTLE_MS'),
    '渲染层注释引用同一个常量名，改一处就要改另一处');
});

test('P2-3（守卫钉）：library 通道不再无条件放行整个系统音乐目录', () => {
  // 沙箱守卫拆到 library/sandbox.js
  const lib = fs.readFileSync(path.join(ROOT, 'src/main/ipc/library/sandbox.js'), 'utf8');
  assert.ok(!lib.includes("bases.push(app.getPath('music'))"),
    '旧实现让 %USERPROFILE%\\Music 下任意路径都过沙箱，与 open-folder / 下载落盘的'
    + '严格口径不一致；默认目录已由 index.js approve，无需在这里额外开口子');
});
