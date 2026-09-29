/**
 * 接线测试：downloadQueue 里的 3-C 质量策略闸门
 *
 * 纯函数部分在 test/qualityPolicy.test.js 已钉死；本文件只钉**接线事实**：
 *   1. 闸门在 getDownloadUrlSmart **之前**（跳过的任务不碰网络）；
 *   2. prefs 未配规则 ⇒ 完全零行为（旧用户不受影响）；
 *   3. 规则命中 skip ⇒ 落 done + skipReason，不取流、不落文件；
 *   4. getPolicyFacts 抛错 ⇒ 只丢 already_have，队列照常推进。
 *
 * 做法沿用 downloadQueue.test.js 的既有手法：monkey-patch prefs.get，
 * 全部依赖注入，不启动 Electron。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDownloadQueueEngine } = require('../src/main/downloadQueue');

/** 一首待处理任务 */
function makeSong(over = {}) {
  return {
    taskId: 't1', id: '1', source: 'netease',
    title: '晴天', artist: '周杰伦', album: '叶惠美',
    duration: 269, quality: 'lossless', status: 'pending',
    ...over,
  };
}

/**
 * 建引擎：prefs 打桩，依赖全注入
 * @param {Object} o
 * @param {Object} o.prefs prefs 桩值（键 → 值）
 * @param {Function} [o.getPolicyFacts] 本地事实源
 * @param {Function} [o.getDownloadUrlSmart] 取流桩
 */
function build(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-wire-'));
  const downloaded = [];
  const getUrlCalls = [];
  const prefs = require('../src/utils/prefs');
  const origGet = prefs.get;
  const store = { namingTemplate: '{artist} - {title}', concurrency: 2, ...(o.prefs || {}) };
  prefs.get = (k) => store[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: () => {},
    getDownloadUrlSmart: o.getDownloadUrlSmart || (async (song, quality) => {
      getUrlCalls.push({ id: song.id, quality });
      return { url: 'https://cdn/x.mp3', ext: 'mp3' };
    }),
    getLyrics: async () => ({ lrc: '' }),
    notifier: { notifyDownloadDone: () => {} },
    getPolicyFacts: o.getPolicyFacts,
    history: { add: () => {} },
    fsa: { statOrNull: async () => ({ size: 1234 }) },
    downloader: {
      downloadFileWithRetry: async (url, savePath) => { downloaded.push({ url, savePath }); },
      embedId3Tags: async () => {},
    },
  });

  return {
    engine, dir, downloaded, getUrlCalls,
    restore: () => {
      prefs.get = origGet;
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (_e) { /* tmpdir cleanup is best-effort */ }
    },
  };
}

/** 轮询等条件成立 */
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ── 生产接线守卫（源码级：锁住最容易回归的"闸门位置"）──

const QJS = path.join(__dirname, '../src/main/downloadQueue.js');

test('生产接线：闸门必须在 getDownloadUrlSmart 之前（跳过的任务不碰网络）', () => {
  const src = fs.readFileSync(QJS, 'utf8');
  const i = src.indexOf('const policy = await evaluatePolicy(song);');
  const j = src.indexOf('await getDownloadUrlSmart(song');
  assert.ok(i > -1, '找不到策略闸门（接线被删？）');
  assert.ok(j > -1, '找不到取流调用');
  assert.ok(i < j, '闸门必须排在取流之前，否则跳过规则仍会发起网络请求');
});

test('生产接线：复用 done 状态而非新增状态（QUEUE_STATUSES 是闭合集）', () => {
  const src = fs.readFileSync(QJS, 'utf8');
  const { QUEUE_STATUSES } = require('../src/main/downloadQueue');
  assert.deepEqual([...QUEUE_STATUSES].sort(), ['done', 'downloading', 'error', 'pending'],
    '四态闭合集被改动：sanitizeRestoredTask 恢复校验与渲染层分支都依赖它');
  assert.match(src, /song\.status = 'done';/, '跳过任务应落 done');
  assert.match(src, /song\.skipReason = policy\.reason;/, '应保留可回显的跳过原因');
});

test('生产接线：规则来源是 prefs.qualityPolicyRules，读盘异常降级不抛', () => {
  const src = fs.readFileSync(QJS, 'utf8');
  assert.match(src, /prefs\.get\('qualityPolicyRules'\)/, '规则应从 prefs 读取');
  assert.match(src, /read rules failed, treat as none/, '读盘失败必须降级为 keep 而非抛出');
});

// ── 行为接线 ───────────────────────────────────────────

test('行为：未配规则 = 零行为，照常取流下载（旧用户不受影响）', async () => {
  const h = build(); // prefs 里没有 qualityPolicyRules
  const s = makeSong();
  h.engine.getQueue().push(s);
  try {
    h.engine.processQueue();
    const done = await waitFor(() => s.status === 'done' || s.status === 'error');
    assert.ok(done, '任务应走到终态');
    assert.equal(s.status, 'done', `应下载完成，实得 ${s.status} / ${s.error || ''}`);
    assert.equal(h.getUrlCalls.length, 1, '无规则时应照常取流');
    assert.equal(s.skipReason, undefined, '无规则不该写 skipReason');
  } finally { h.restore(); }
});

test('行为：命中 skip ⇒ 不取流、不落文件、落 done 且带原因', async () => {
  const h = build({
    prefs: { qualityPolicyRules: [{ id: 'min_quality', params: { min: 'lossless' } }] },
  });
  const s = makeSong({ quality: 'standard' }); // 低于 lossless 门槛
  h.engine.getQueue().push(s);
  try {
    h.engine.processQueue();
    const done = await waitFor(() => s.status === 'done' || s.status === 'error');
    assert.ok(done, '任务应走到终态');
    assert.equal(s.status, 'done', `应落 done，实得 ${s.status} / ${s.error || ''}`);
    assert.equal(h.getUrlCalls.length, 0, '被跳过的任务绝不能取流');
    assert.equal(h.downloaded.length, 0, '被跳过的任务绝不能落文件');
    assert.ok(s.skipReason && s.skipReason.includes('lossless'), `应带可读原因: ${s.skipReason}`);
    assert.equal(s.skipRule, 'min_quality');
  } finally { h.restore(); }
});

test('行为：命中 demote ⇒ 传给取流的 quality 被压档，且不误标 skip', async () => {
  // 269s lossless 估约 26MB，上限 10MB ⇒ 降 hq
  const h = build({
    prefs: { qualityPolicyRules: [{ id: 'max_size', params: { maxMb: 10, to: 'hq' } }] },
  });
  const s = makeSong({ quality: 'lossless' });
  h.engine.getQueue().push(s);
  try {
    h.engine.processQueue();
    const done = await waitFor(() => s.status === 'done' || s.status === 'error');
    assert.ok(done, '任务应走到终态');
    assert.equal(s.status, 'done', `应下载完成，实得 ${s.status} / ${s.error || ''}`);
    assert.equal(h.getUrlCalls.length, 1);
    assert.equal(h.getUrlCalls[0].quality, 'hq', `取流应收到降档后的 hq，实得 ${h.getUrlCalls[0].quality}`);
    assert.equal(s.skipReason, undefined, '降档不是跳过，不该写 skipReason');
    assert.ok(s.demoteReason, '应记录降档原因');
  } finally { h.restore(); }
});

test('行为：getPolicyFacts 抛错 ⇒ 队列照常推进（事实源故障不阻断下载）', async () => {
  const h = build({
    // 规则只依赖事实源；事实源炸了 ⇒ already_have 不命中 ⇒ 照常下
    prefs: { qualityPolicyRules: [{ id: 'already_have', params: { scope: 'artist' } }] },
    getPolicyFacts: async () => { throw new Error('library index down'); },
  });
  const s = makeSong();
  h.engine.getQueue().push(s);
  try {
    h.engine.processQueue();
    const done = await waitFor(() => s.status === 'done' || s.status === 'error');
    assert.ok(done, '任务应走到终态');
    assert.equal(s.status, 'done', `事实源故障不该让下载失败，实得 ${s.status} / ${s.error || ''}`);
    assert.equal(h.getUrlCalls.length, 1, '应照常取流');
  } finally { h.restore(); }
});

test('行为：getPolicyFacts 未注入 ⇒ already_have 不命中（宁可不下手不误杀）', async () => {
  const h = build({
    prefs: { qualityPolicyRules: [{ id: 'already_have', params: { scope: 'artist' } }] },
    // 故意不注入 getPolicyFacts
  });
  const s = makeSong();
  h.engine.getQueue().push(s);
  try {
    h.engine.processQueue();
    const done = await waitFor(() => s.status === 'done' || s.status === 'error');
    assert.ok(done);
    assert.equal(s.status, 'done', '缺事实源时不得误杀');
    assert.equal(h.getUrlCalls.length, 1);
  } finally { h.restore(); }
});
