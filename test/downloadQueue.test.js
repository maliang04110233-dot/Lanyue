/**
 * 单元测试：main/downloadQueue.js —— 下载队列引擎
 *
 * 为什么值得测：这是**下载链路的状态机**（队列状态流转、并发调度、
 * 重试策略、持久化淘汰）。抽出来之前它埋在 main/index.js 里，
 * 依赖 electron 运行时，无法在 Node 单测中验证 —— 也就是「改错了只能靠人品」。
 *
 * 现在依赖全部注入，可用桩覆盖：
 *   - 并发上限与调度时机
 *   - 仅 403/404/410 重试、fatal 短路不耗配额
 *   - 换源结果回写 _altSource
 *   - done 淘汰上限、防抖持久化、退出落盘
 *   - 重启恢复的状态迁移（downloading→error、stale pending→error）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDownloadQueueEngine, sanitizeFilename } = require('../src/main/downloadQueue');

// ── 测试替身 ──────────────────────────────────────────────

/** 造一个临时 userData 目录 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-'));
}

/**
 * 构造引擎，默认注入「立即成功」的取流与下载依赖。
 *
 * 说明：history / fsa / downloader 通过**注入**替换（引擎支持这三个依赖注入），
 * 而不是 patch 模块单例 —— 后者对「模块顶层解构绑定」无效（踩过）。
 * 仅 prefs 仍用 patch（引擎按既有约定直接 require 它）。
 *
 * @param {Object} overrides
 */
function buildEngine(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const sent = [];
  const historyAdds = [];
  const downloaded = [];

  const prefs = require('../src/utils/prefs');
  const origPrefsGet = prefs.get;

  const prefsStore = { concurrency: 2, namingTemplate: '{artist} - {title}', ...(overrides.prefs || {}) };
  prefs.get = (k) => prefsStore[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: (ch, payload) => sent.push({ ch, payload }),
    getDownloadUrlSmart: overrides.getDownloadUrlSmart
      || (async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' })),
    getLyrics: overrides.getLyrics || (async () => ({ lrc: '' })),
    notifier: overrides.notifier || { notifyDownloadDone: () => {} },
    getDefaultDownloadDir: overrides.getDefaultDownloadDir,
    // 注入替身（避免真实网络/落盘）
    history: { add: (rec) => { historyAdds.push(rec); } },
    fsa: { statOrNull: overrides.statOrNull || (async () => ({ size: 1234 })) },
    downloader: {
      downloadFileWithRetry: overrides.downloadFileWithRetry
        || (async (url, savePath) => { downloaded.push({ url, savePath }); }),
      embedId3Tags: overrides.embedId3Tags || (async () => {}),
    },
  });

  const restore = () => { prefs.get = origPrefsGet; };

  return { engine, dir, sent, historyAdds, downloaded, prefsStore, restore };
}

/** 等一个条件成立（轮询），超时抛错 */
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ══════════════════════════════════════════════════════════
// 构造与校验
// ══════════════════════════════════════════════════════════

test('createDownloadQueueEngine: 缺必需依赖立即抛错', () => {
  assert.throws(() => createDownloadQueueEngine({}), /必须注入 userDataDir/);
  assert.throws(
    () => createDownloadQueueEngine({ userDataDir: () => '/x', safeSend: () => {} }),
    /必须注入 getDownloadUrlSmart/,
  );
  assert.throws(
    () => createDownloadQueueEngine({
      userDataDir: () => '/x', safeSend: () => {}, getDownloadUrlSmart: async () => ({}),
    }),
    /必须注入 getLyrics/,
  );
});

test('sanitizeFilename: 去掉路径分隔符与非法字符，限长 200', () => {
  assert.strictEqual(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.strictEqual(sanitizeFilename('x'.repeat(300)).length, 200);
});

// ══════════════════════════════════════════════════════════
// 调度与并发
// ══════════════════════════════════════════════════════════

test('processQueue: 单曲成功 ⇒ status=done，写历史与队列推送', async () => {
  const { engine, sent, historyAdds, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');

    const s = engine.getQueue()[0];
    assert.strictEqual(s.status, 'done');
    assert.strictEqual(s.progress, 100);
    assert.ok(s.savePath, '应记录落盘路径');
    assert.strictEqual(historyAdds.length, 1);
    assert.strictEqual(historyAdds[0].status, 'done');
    assert.strictEqual(historyAdds[0].size, 1234);
    assert.ok(sent.some(e => e.ch === 'queue-updated'), '应推送 queue-updated');
  } finally { restore(); }
});

test('processQueue: 并发上限生效（concurrency=2 时同时最多 2 首）', async () => {
  let running = 0;
  let maxRunning = 0;
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 2 },
    downloadFileWithRetry: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
    },
  });
  try {
    for (let i = 0; i < 5; i++) {
      engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
    }
    await engine.processQueue();
    await waitFor(() => engine.getQueue().every(s => s.status === 'done'));
    assert.ok(maxRunning <= 2, `并发不应超过 2，实际峰值 ${maxRunning}`);
    assert.strictEqual(engine.getQueue().filter(s => s.status === 'done').length, 5);
  } finally { restore(); }
});

test('processQueue: concurrency 越界回落 3（0 / 99 / 非法值）', async () => {
  for (const bad of [0, 99, 'x', null]) {
    let maxRunning = 0;
    let running = 0;
    const { engine, restore } = buildEngine({
      prefs: { concurrency: bad },
      downloadFileWithRetry: async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      },
    });
    try {
      for (let i = 0; i < 6; i++) {
        engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
      }
      await engine.processQueue();
      await waitFor(() => engine.getQueue().every(s => s.status === 'done'));
      assert.ok(maxRunning <= 3, `concurrency=${bad} 应回落 3，实际峰值 ${maxRunning}`);
    } finally { restore(); }
  }
});

test('processQueue: 重入保护（并发调用不会重复调度同一首）', async () => {
  let calls = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    // 连续三次调用，应只有一次真正调度
    await Promise.all([engine.processQueue(), engine.processQueue(), engine.processQueue()]);
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(calls, 1, '同一任务不应被重复下载');
  } finally { restore(); }
});

test('processQueue: 空队列不抛错', async () => {
  const { engine, restore } = buildEngine();
  try {
    await engine.processQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

test('saveDir 全缺省 ⇒ 落盘到注入的 getDefaultDownloadDir（与 UI 展示目录同源）', async () => {
  const injectDir = path.join(tmpDir(), 'MusicDownloader');
  const { engine, downloaded, restore } = buildEngine({
    getDefaultDownloadDir: () => injectDir,
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => downloaded.length === 1);
    assert.ok(downloaded[0].savePath.startsWith(injectDir + path.sep),
      `应落在注入的默认目录 ${injectDir}，实际 ${downloaded[0].savePath}`);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 重试与 fatal 短路
// ══════════════════════════════════════════════════════════

test('重试：HTTP 403 重试一次后成功', async () => {
  let attempts = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => {
      attempts++;
      if (attempts === 1) throw new Error('HTTP 403 Forbidden');
    },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    assert.strictEqual(attempts, 2, '应在 403 后重试一次');
    assert.strictEqual(engine.getQueue()[0].status, 'done');
  } finally { restore(); }
});

test('重试：非 403/404/410 错误不重试（直接失败）', async () => {
  let attempts = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => { attempts++; throw new Error('磁盘写入失败'); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    assert.strictEqual(attempts, 1, '不可重试错误只应尝试一次');
  } finally { restore(); }
});

test('fatal 短路：取流返回 fatal ⇒ 不消耗重试配额，直接 error', async () => {
  let urlCalls = 0;
  let dlCalls = 0;
  const { engine, sent, restore } = buildEngine({
    getDownloadUrlSmart: async () => {
      urlCalls++;
      return { error: '该歌曲需要 VIP 会员', code: 'VIP_REQUIRED', fatal: true };
    },
    downloadFileWithRetry: async () => { dlCalls++; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    assert.strictEqual(urlCalls, 1, 'fatal 应短路，不重试取流');
    assert.strictEqual(dlCalls, 0, 'fatal 不应尝试下载');
    assert.strictEqual(engine.getQueue()[0].errorCode, 'VIP_REQUIRED');
    const errEvt = sent.find(e => e.ch === 'download-error');
    assert.ok(errEvt, '应推送 download-error');
    assert.strictEqual(errEvt.payload.fatal, true, 'fatal 应透传给渲染层');
  } finally { restore(); }
});

test('非 fatal 取流失败（无重试特征）⇒ 不重试，直接 error', async () => {
  let urlCalls = 0;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => { urlCalls++; return { error: '临时失败' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error', { timeout: 3000 });
    assert.strictEqual(urlCalls, 1, '无 403/404/410 特征时不应重试');
  } finally { restore(); }
});

test('取流失败但错误信息含 HTTP 410 ⇒ 重试到上限（CDN 签名过期可换源重取）', async () => {
  let urlCalls = 0;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => { urlCalls++; return { error: 'HTTP 410 Gone' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error', { timeout: 3000 });
    assert.strictEqual(urlCalls, 2, '410 应重试到上限（2 次）');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 换源结果回写
// ══════════════════════════════════════════════════════════

test('换源：matchedSong 回写 _altSource（供下次直试）', async () => {
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3', ext: 'mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
  });
  try {
    const song = { id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' };
    engine.getQueue().push(song);
    await engine.processQueue();
    await waitFor(() => song.status === 'done');
    assert.deepStrictEqual(song._altSource, { source: 'kugou', id: 'k9' });
  } finally { restore(); }
});

test('换源：历史记录记实际取流源 + matchedFrom', async () => {
  const { engine, historyAdds, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(historyAdds[0].source, 'kugou', '应记实际取流源');
    assert.strictEqual(historyAdds[0].matchedFrom, 'netease');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 持久化
// ══════════════════════════════════════════════════════════

test('persistQueue: 防抖合并写入（500ms 内多次调用只写一次）', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'q', title: 't', taskId: 'x', status: 'pending' });
    engine.persistQueue();
    engine.persistQueue();
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const fp = path.join(dir, 'queue.json');
    assert.ok(fs.existsSync(fp), '应写入 queue.json');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.strictEqual(data.length, 1);
  } finally { restore(); }
});

test('dispose: 防抖窗口内退出 ⇒ 立即落盘，不丢最后一次变更', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'q', title: 't', taskId: 'x', status: 'done' });
    engine.persistQueue();   // 进入防抖窗口
    engine.dispose();        // 立即退出
    const fp = path.join(dir, 'queue.json');
    assert.ok(fs.existsSync(fp), 'dispose 应把待写队列落盘');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.strictEqual(data.length, 1, '不应丢失最后一次变更');
  } finally { restore(); }
});

test('loadPersistedQueue: 恢复任务并迁移状态', async () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    { id: '1', status: 'downloading', title: 'a' },
    { id: '2', status: 'pending', title: 'b', addedAt: now },
    { id: '3', status: 'pending', title: 'c', addedAt: now - 25 * 60 * 60 * 1000 },
    { id: '4', status: 'done', title: 'd' },
    { id: '5', status: 'error', title: 'e' },
  ]));
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    const q = engine.getQueue();
    assert.strictEqual(q.length, 5);
    assert.strictEqual(q[0].status, 'error', 'downloading 异常关闭 → error');
    assert.strictEqual(q[1].status, 'pending', '新 pending 保留');
    assert.strictEqual(q[2].status, 'error', '超 24h pending → error');
    assert.strictEqual(q[3].status, 'done', 'done 保留');
    assert.strictEqual(q[4].status, 'error', 'error 保留');
  } finally { restore(); }
});

test('loadPersistedQueue: 文件损坏不抛错（从空队列恢复）', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), '{ 这不是合法 JSON');
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

test('loadPersistedQueue: 文件不存在不抛错', async () => {
  const { engine, restore } = buildEngine();
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 2026-09 审计 P1：恢复时的逐条结构校验
//
// 旧实现只判「顶层是数组」，随后对每条直接 delete item._processing ——
// 数组里混进 null / 字符串 / 缺 status 的脏对象就抛 TypeError，
// **整批恢复中止**：一条坏记录等于整个队列丢失（用户体感"重启后下载全没了"）。
// ══════════════════════════════════════════════════════════

test('loadPersistedQueue: 脏条目只丢自己，合法条目照常恢复（不整批中止）', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    null,
    'this-is-not-a-task',
    42,
    [],
    { title: '缺 id 与 status' },
    { id: 'no-status', title: '缺 status' },
    { id: 'bad-status', status: 'wat', title: '状态不在词汇表' },
    { id: 'ok1', status: 'pending', title: '合法' },
    { id: 'ok2', status: 'done', title: '合法' },
  ]));
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    const q = engine.getQueue();
    assert.deepStrictEqual(q.map((s) => s.id), ['ok1', 'ok2'],
      '7 条脏记录必须只丢自己，不能把后面两条合法的一起带走');
  } finally { restore(); }
});

test('sanitizeRestoredTask: 判据只认「普通对象 + id + 合法 status」', () => {
  const { sanitizeRestoredTask } = require('../src/main/downloadQueue');
  for (const bad of [null, undefined, 'x', 1, [], {}, { id: 'a' }, { status: 'done' },
    { id: {}, status: 'done' }, { id: 'a', status: 'wat' }, { id: 'a', status: 3 }]) {
    assert.strictEqual(sanitizeRestoredTask(bad), null, `${JSON.stringify(bad)} 应被拒`);
  }
  const ok = { id: 'a', status: 'pending', title: 't', _processing: true, _cancelRequested: true };
  const out = sanitizeRestoredTask(ok);
  assert.strictEqual(out.id, 'a');
  assert.ok(!('_processing' in out) && !('_cancelRequested' in out),
    '瞬态调度标记不得跨重启存活');
  assert.strictEqual(sanitizeRestoredTask({ id: 7, status: 'done' }).id, 7, '数字 id 也合法');
});

test('loadPersistedQueue: 超量条目被截断且不抛错（防被写坏的文件撑爆内存）', async () => {
  const dir = tmpDir();
  const { MAX_RESTORED_TASKS } = require('../src/main/downloadQueue');
  const list = [];
  for (let i = 0; i < MAX_RESTORED_TASKS + 5; i++) {
    list.push({ id: String(i), status: 'done', title: `t${i}` });
  }
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(list));
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.getQueue().length, MAX_RESTORED_TASKS);
  } finally { restore(); }
});

test('淘汰：done 超过 200 时保留最新 200（最旧的被删）', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    const q = engine.getQueue();
    for (let i = 0; i < 205; i++) {
      q.push({ id: String(i), source: 'q', title: `t${i}`, taskId: `k${i}`, status: 'done' });
    }
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.strictEqual(saved.length, 200, `应淘汰到 200，实际 ${saved.length}`);
    assert.strictEqual(saved[0].id, '5', '应淘汰最旧的 5 条');
    assert.strictEqual(saved[saved.length - 1].id, '204', '应保留最新');
  } finally { restore(); }
});

test('淘汰：不误删 pending/error 任务', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    const q = engine.getQueue();
    q.push({ id: 'p1', source: 'q', title: 'pending', taskId: 'p', status: 'pending' });
    for (let i = 0; i < 202; i++) {
      q.push({ id: String(i), source: 'q', title: `t${i}`, taskId: `k${i}`, status: 'done' });
    }
    q.push({ id: 'e1', source: 'q', title: 'error', taskId: 'e', status: 'error' });
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.ok(saved.some(s => s.id === 'p1'), 'pending 不应被淘汰');
    assert.ok(saved.some(s => s.id === 'e1'), 'error 不应被淘汰');
    assert.strictEqual(saved.filter(s => s.status === 'done').length, 200);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 歌词与 ID3
// ══════════════════════════════════════════════════════════

test('歌词：换源成功时用匹配源的 id/source 取词（更准）', async () => {
  let seen = null;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
    getLyrics: async (id, source) => { seen = { id, source }; return { lrc: '[00:01]hi' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.deepStrictEqual(seen, { id: 'k9', source: 'kugou' });
  } finally { restore(); }
});

test('歌词：取词失败不影响下载成功', async () => {
  const { engine, restore } = buildEngine({
    getLyrics: async () => { throw new Error('歌词接口炸了'); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(engine.getQueue()[0].status, 'done', '歌词失败不应让下载失败');
  } finally { restore(); }
});

test('保存目录：saveDir 为 null 时不崩溃（回落 prefs 或系统目录）', async () => {
  const { engine, restore } = buildEngine({ prefs: { saveDir: undefined } });
  try {
    engine.getQueue().push({
      id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x',
      status: 'pending', saveDir: null,
    });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    assert.strictEqual(engine.getQueue()[0].status, 'done');
  } finally { restore(); }
});

test('通知：notifications=false 时不调用通知器', async () => {
  let notified = 0;
  const { engine, restore } = buildEngine({
    prefs: { notifications: false },
    notifier: { notifyDownloadDone: () => { notified++; } },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(notified, 0, '关闭通知时不应弹窗');
  } finally { restore(); }
});

test('通知：默认开启时调用通知器', async () => {
  let notified = 0;
  const { engine, restore } = buildEngine({
    notifier: { notifyDownloadDone: () => { notified++; } },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(notified, 1);
  } finally { restore(); }
});

// ── 暂停/继续调度 ────────────────────────────────────────

test('setPaused: 暂停时不调度新任务，恢复后立即调度并完成', async () => {
  const { engine, restore, downloaded } = buildEngine();
  try {
    engine.setPaused(true);
    assert.strictEqual(engine.isPaused(), true);
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(engine.getQueue()[0].status, 'pending', '暂停期间不应启动');
    assert.strictEqual(downloaded.length, 0);

    engine.setPaused(false);
    assert.strictEqual(engine.isPaused(), false);
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(downloaded.length, 1);
  } finally { restore(); }
});

test('setPaused: 在途任务不被打断，照常完成', async () => {
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => { await new Promise((r) => setTimeout(r, 60)); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'downloading');
    engine.setPaused(true);
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50)); // 等 finally 链收尾（activeDownloads--）
    assert.strictEqual(engine.getActiveCount(), 0);
  } finally { restore(); }
});

test('setPaused: 暂停期间入队的多个任务恢复后全部完成（含 100ms 重排定时器被打断）', async () => {
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 1 },
    downloadFileWithRetry: async () => { await new Promise((r) => setTimeout(r, 10)); },
  });
  try {
    engine.setPaused(true);
    for (let i = 0; i < 3; i++) {
      engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
    }
    await engine.processQueue();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(engine.getQueue().every(s => s.status === 'pending'));
    engine.setPaused(false);
    await waitFor(() => engine.getQueue().every(s => s.status === 'done'), { timeout: 3000 });
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 平台级并发钳制（perSourceConcurrency）
//
// 为什么需要：全局 concurrency 只限总数不限来源 —— 批量下载一个
// QQ 歌单时 3 个 worker 全打在同一个 CDN 上，正是 lx 文档警告的
// 「并发过高会被源封 IP」形态。按**请求源**钳制并发是风控自卫。
// 计数按 song.source（请求的平台），换源命中的实际源不另计 ——
// 换源是串行发生在单任务内部，不构成额外并发压力。
// ══════════════════════════════════════════════════════════

/** 造一个「下载挂起直到手动放行」的 downloader 桩；started() = 累计启动数 */
function makeGate() {
  const waiting = [];
  let startedCount = 0;
  const fn = async () => new Promise((resolve) => { waiting.push(resolve); startedCount++; });
  return {
    fn,
    /** 放行最早的一个挂起下载 */
    release: () => { const r = waiting.shift(); if (r) r(); return !!r; },
    started: () => startedCount,
  };
}

const dlItem = (id, source) => ({
  id, source, title: 't', artist: 'a', taskId: `task-${source}-${id}`, status: 'pending',
});

test('平台钳制：同平台并发受 perSourceConcurrency（默认 2）限制，不占满全局额度', async () => {
  const gate = makeGate();
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 3 },
    downloadFileWithRetry: gate.fn,
  });
  try {
    engine.getQueue().push(dlItem('1', 'netease'), dlItem('2', 'netease'),
      dlItem('3', 'netease'), dlItem('9', 'qq'));
    await engine.processQueue();
    await waitFor(() => gate.started() >= 1);
    await new Promise((r) => setTimeout(r, 50)); // 给调度留稳定观测窗口

    const q = engine.getQueue();
    assert.strictEqual(q.filter(s => s.status === 'downloading' && s.source === 'netease').length, 2,
      'netease 最多 2 个在途（perSourceConcurrency 默认 2）');
    assert.strictEqual(q.filter(s => s.status === 'downloading' && s.source === 'qq').length, 1,
      '额度没占满时其他平台必须能启动');
    assert.strictEqual(q.filter(s => s.status === 'pending').length, 1);

    // 放行一个 netease ⇒ 第三个 netease 立即补位
    gate.release();
    await waitFor(() => gate.started() >= 3 || q.find(s => s.taskId === 'task-netease-3' && s.status !== 'pending'));
    await waitFor(() => q.filter(s => s.status === 'downloading' && s.source === 'netease').length === 2);
  } finally { restore(); }
});

test('平台钳制：perSourceConcurrency=1 时同平台严格串行', async () => {
  const gate = makeGate();
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 3, perSourceConcurrency: 1 },
    downloadFileWithRetry: gate.fn,
  });
  try {
    engine.getQueue().push(dlItem('1', 'kugou'), dlItem('2', 'kugou'));
    await engine.processQueue();
    await waitFor(() => gate.started() >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(gate.started(), 1, 'cap=1 时第二个 kugou 任务必须等待');
    gate.release();
    await waitFor(() => gate.started() >= 2);
  } finally { restore(); }
});

test('平台钳制：cap 超过全局 concurrency 时按全局钳制（钳制只会更紧不会更松）', async () => {
  const gate = makeGate();
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 2, perSourceConcurrency: 10 },
    downloadFileWithRetry: gate.fn,
  });
  try {
    engine.getQueue().push(dlItem('1', 'netease'), dlItem('2', 'netease'), dlItem('3', 'netease'));
    await engine.processQueue();
    await waitFor(() => gate.started() >= 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(gate.started(), 2, '全局 concurrency=2 仍是硬上限');
  } finally { restore(); }
});

test('平台钳制：perSourceConcurrency 越界（0/负数/非数字）回落默认 2', async () => {
  for (const bad of [0, -1, 'x']) {
    const gate = makeGate();
    const { engine, restore } = buildEngine({
      prefs: { concurrency: 3, perSourceConcurrency: bad },
      downloadFileWithRetry: gate.fn,
    });
    try {
      engine.getQueue().push(dlItem('1', 'netease'), dlItem('2', 'netease'), dlItem('3', 'netease'));
      await engine.processQueue();
      await waitFor(() => gate.started() >= 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(gate.started(), 2, `非法值 ${JSON.stringify(bad)} 应回落 cap=2`);
      gate.release(); gate.release(); // 清场
    } finally { restore(); }
  }
});

// ══════════════════════════════════════════════════════════
// 终态立即落盘（不等 500ms 防抖）
//
// 防抖合并进度类高频变更是对的，但 done/error 是**终态**：崩溃窗口里
// 丢一条终态 = 用户看到已完成的任务消失/回到下载中。omniget 的
// 「逐条 fsync」在本工程规模（≤400 条整写原子文件）下等价做法就是
// 终态免防抖立即写，成本一次 100KB 级 atomic write，可忽略。
// ══════════════════════════════════════════════════════════

test('持久化：任务 done 后 queue.json 立即可读（绕过防抖）', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    engine.getQueue().push(dlItem('1', 'netease'));
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    // 不 sleep 500ms、不调 dispose —— 终态必须已经落盘
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.strictEqual(raw[0].status, 'done');
    assert.strictEqual(raw[0].taskId, 'task-netease-1');
  } finally { restore(); }
});

test('持久化：任务 error 后 queue.json 立即可读', async () => {
  const { engine, dir, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({ error: 'boom', code: 'INTERNAL_ERROR', fatal: false }),
  });
  try {
    engine.getQueue().push(dlItem('2', 'qq'));
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.strictEqual(raw[0].status, 'error');
  } finally { restore(); }
});

test('取消下载：迟到的 onProgress 不再写进度、不再推送事件（2026-09 审计 M-竞态）', async () => {
  let onProgressCb;
  let finish;
  const { engine, sent, restore } = buildEngine({
    downloadFileWithRetry: (url, savePath, onProgress) => {
      onProgressCb = onProgress;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  try {
    engine.getQueue().push(dlItem('1', 'netease'));
    await engine.processQueue();
    await waitFor(() => !!onProgressCb);
    engine.requestCancel('task-netease-1');
    // 取消已发出，但底层回调仍可能迟到一拍
    onProgressCb(50, { receivedBytes: 1, totalBytes: 2 });
    assert.ok(!sent.some(s => s.ch === 'download-progress' && s.payload.progress === 50),
      '已取消任务不得再推送 download-progress');
    finish();
    await waitFor(() => engine.getQueue().every(s => s.status !== 'downloading'));
  } finally {
    restore();
  }
});

// ══════════════════════════════════════════════════════════
// H1/M1：重试等待期的调度与取消（第二轮审计修复）
// ══════════════════════════════════════════════════════════

test('H1: 403 重试等待期的任务不得被二次调度（同曲并发下载协程=1）', async () => {
  const fetchCalls = [];
  const dlConcurrent = {};
  let maxConcurrentA = 0;
  let releaseA;
  const aGate = new Promise((r) => { releaseA = r; });
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 2 },
    getDownloadUrlSmart: async (song) => {
      fetchCalls.push(song.taskId);
      const n = fetchCalls.filter((c) => c === song.taskId).length;
      if (song.taskId === 'A' && n === 1) throw new Error('HTTP 403: 签名过期');
      return { url: 'https://cdn/' + song.taskId + '.mp3', ext: 'mp3' };
    },
    downloadFileWithRetry: async (url, savePath, onProgress, headers, options = {}) => {
      const id = options.token;
      dlConcurrent[id] = (dlConcurrent[id] || 0) + 1;
      if (id === 'A') maxConcurrentA = Math.max(maxConcurrentA, dlConcurrent[id]);
      if (id === 'A') await aGate;
      dlConcurrent[id]--;
    },
  });
  try {
    const q = engine.getQueue();
    q.push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'A', status: 'pending' });
    q.push({ id: '2', source: 'netease', title: 't2', artist: 'a', taskId: 'B', status: 'pending' });
    await engine.processQueue();
    // A 首次取流 403 → 进入 500ms 重试退避；B 快速完成 → 触发调度器重入窗口
    await waitFor(() =>
      fetchCalls.includes('A') &&
      q.find((s) => s.taskId === 'B').status === 'done');
    // 覆盖退避期（500ms）+ 重调度定时器（100ms）
    await new Promise((r) => setTimeout(r, 700));
    releaseA();
    await waitFor(() => q.find((s) => s.taskId === 'A').status === 'done');
    const aFetch = fetchCalls.filter((c) => c === 'A').length;
    assert.strictEqual(aFetch, 2,
      `A 应恰好 2 次取流（1 失败 + 1 重试），实际 ${aFetch} —— 重试等待期被二次调度`);
    assert.strictEqual(maxConcurrentA, 1,
      `同一首歌不允许两个下载协程并发写同一文件，实测峰值 ${maxConcurrentA}`);
  } finally {
    restore();
  }
});

test('M1: 重试等待期取消任务 → 协程终止，不再取流/落盘/写历史', async () => {
  const fetchCalls = [];
  const dlCalls = [];
  const { engine, historyAdds, sent, restore } = buildEngine({
    prefs: { concurrency: 1 },
    getDownloadUrlSmart: async (song) => {
      fetchCalls.push(song.taskId);
      if (song.taskId === 'A' && fetchCalls.filter((c) => c === 'A').length === 1) {
        throw new Error('HTTP 403: x');
      }
      return { url: 'https://cdn/A.mp3', ext: 'mp3' };
    },
    downloadFileWithRetry: async (url, savePath, onProgress, headers, options = {}) => {
      dlCalls.push(options.token);
    },
  });
  try {
    const q = engine.getQueue();
    q.push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'A', status: 'pending' });
    await engine.processQueue();
    // A 进入 500ms 退避（status=pending 且协程仍在途）
    await waitFor(() => fetchCalls.filter((c) => c === 'A').length === 1 && q[0].status === 'pending');
    const hit = engine.requestCancel('A');
    assert.strictEqual(hit, true, '重试等待期的任务应可被取消');
    await waitFor(() => q[0].status === 'error' && !q[0]._processing);
    assert.match(q[0].error || '', /取消/);
    await new Promise((r) => setTimeout(r, 700)); // 确认退避结束后不再取流
    assert.strictEqual(fetchCalls.filter((c) => c === 'A').length, 1, '取消后不得再取流');
    assert.strictEqual(dlCalls.length, 0, '取消后不得开始下载');
    assert.strictEqual(historyAdds.length, 0, '取消不写历史');
    assert.strictEqual(sent.filter((s) => s.ch === 'download-error').length, 0, '取消不发 download-error');
  } finally {
    restore();
  }
});

// ── 失败历史条目带上 errorCode ────────────────────

test('fatal 失败的写历史条目带 errorCode（历史侧诊断才不必靠关键词猜）', async () => {
  const { engine, historyAdds, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({ error: '该歌曲需要 VIP 会员', code: 'VIP_REQUIRED', fatal: true }),
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    const rec = historyAdds.find((r) => r.status === 'error');
    assert.ok(rec, '失败应写历史');
    assert.strictEqual(rec.errorCode, 'VIP_REQUIRED');
  } finally { restore(); }
});

test('取流无码失败时不往历史塞空 errorCode（宁可缺键，也不给诊断喂伪码）', async () => {
  const { engine, historyAdds, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({ error: '临时失败' }),
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    const rec = historyAdds.find((r) => r.status === 'error');
    assert.ok(rec, '失败应写历史');
    assert.ok(!('errorCode' in JSON.parse(JSON.stringify(rec))), '落盘 JSON 里不该出现 errorCode 键');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 下载路径模板（设置页那个「使用中」必须是真话）
// ══════════════════════════════════════════════════════════

const SONG_T = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', album: '叶惠美', taskId: 'x', status: 'pending' };

/** 跑一首歌，返回它实际要写入的路径 */
async function oneSongPath(engine) {
  engine.getQueue().push({ ...SONG_T });
  await engine.processQueue();
  await waitFor(() => ['done', 'error'].includes(engine.getQueue()[0].status));
  return engine.getQueue()[0];
}

test('路径模板: 活动模板的子目录真实建出来（漏 mkdir 就是 ENOENT）', async () => {
  const dir = tmpDir();
  const { engine, downloaded, restore } = buildEngine({
    dir,
    prefs: {
      saveDir: dir,
      downloadTemplates: [{ id: 't1', name: '按专辑', subpath: '{artist}/{album}' }],
      activeDownloadTemplate: 't1',
    },
  });
  try {
    await oneSongPath(engine);
    assert.strictEqual(downloaded[0].savePath,
      path.join(dir, '周杰伦', '叶惠美', '周杰伦 - 晴天.mp3'));
    assert.ok(fs.existsSync(path.join(dir, '周杰伦', '叶惠美')),
      '子目录必须被 mkdir 真建出来 —— 规划了目录却不建，下载直接 ENOENT');
    assert.strictEqual(engine.getQueue()[0].status, 'done');
  } finally { restore(); }
});

test('路径模板: 没有活动模板时保持平铺（别把默认行为顺手改了）', async () => {
  const dir = tmpDir();
  const { engine, downloaded, restore } = buildEngine({
    dir,
    prefs: {
      saveDir: dir,
      downloadTemplates: [{ id: 't1', subpath: '{artist}' }],
      activeDownloadTemplate: null,
    },
  });
  try {
    await oneSongPath(engine);
    assert.strictEqual(downloaded[0].savePath, path.join(dir, '周杰伦 - 晴天.mp3'));
  } finally { restore(); }
});

test('路径模板: 穿越写法只能在根目录里打转', async () => {
  const dir = tmpDir();
  const { engine, downloaded, restore } = buildEngine({
    dir,
    prefs: {
      saveDir: dir,
      downloadTemplates: [{ id: 'evil', subpath: '..' + path.sep + '..' + path.sep + '{artist}' }],
      activeDownloadTemplate: 'evil',
    },
  });
  try {
    await oneSongPath(engine);
    const p = downloaded[0].savePath;
    // 只按「相对根目录还出不出得去」判定 —— 拿 tmpdir 的父目录比是错的，
    // 临时目录本身就长在 Temp 里（这条在写测试时坑过我一次）。
    const rel = path.relative(dir, p);
    assert.ok(rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel),
      '逃出下载根目录: ' + p);
    assert.strictEqual(rel.split(path.sep).length, 2,
      '点号段被丢弃后只剩一层子目录，不该更多');
  } finally { restore(); }
});

test('路径模板: 老模板只有绝对路径也能用；换根目录后自动失效回落', async () => {
  const dir = tmpDir();
  const legacy = [{ id: 'old', path: path.join(dir, 'Old') }];
  const { engine, downloaded, restore } = buildEngine({
    dir,
    prefs: { saveDir: dir, downloadTemplates: legacy, activeDownloadTemplate: 'old' },
  });
  try {
    await oneSongPath(engine);
    assert.strictEqual(downloaded[0].savePath, path.join(dir, 'Old', '周杰伦 - 晴天.mp3'));
  } finally { restore(); }

  const dir2 = tmpDir();
  const moved = buildEngine({
    dir: dir2,
    prefs: { saveDir: dir2, downloadTemplates: legacy, activeDownloadTemplate: 'old' },
  });
  try {
    await oneSongPath(moved.engine);
    assert.strictEqual(moved.downloaded[0].savePath, path.join(dir2, '周杰伦 - 晴天.mp3'),
      '绝对路径已不属于当前根目录 ⇒ 回落，绝不写到别人家里');
  } finally { moved.restore(); }
});

test('路径模板: 逐曲 saveDir 是根，模板子路径长在它下面', async () => {
  const dir = tmpDir();
  const perSong = path.join(dir, 'per-song');
  const { engine, downloaded, restore } = buildEngine({
    dir,
    prefs: {
      saveDir: dir,
      downloadTemplates: [{ id: 't1', subpath: '{artist}' }],
      activeDownloadTemplate: 't1',
    },
  });
  try {
    engine.getQueue().push({ ...SONG_T, saveDir: perSong });
    await engine.processQueue();
    await waitFor(() => ['done', 'error'].includes(engine.getQueue()[0].status));
    assert.strictEqual(downloaded[0].savePath, path.join(perSong, '周杰伦', '周杰伦 - 晴天.mp3'));
    assert.ok(fs.existsSync(path.join(perSong, '周杰伦')));
  } finally { restore(); }
});

