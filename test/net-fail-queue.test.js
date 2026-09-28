/**
 * （下半）：断网跑完的任务要留下真话
 *
 * 改造前的实证：src/main/downloadQueue.js 的 catch 里
 *   `const isRetriable = /HTTP\s*(403|404|410)/i.test(msg)` 之后直接 break，
 *   而 `song.errorCode` 只在「取流返回 fatal」那一条路上才写（335 行）。
 *   ⇒ 断网导致的下载失败既没有任何码，也没有任何分类：
 * 队列行与历史行不戴徽标（cb2c416 的徽标只认码），
 * 诊断弹层只会说「未分类的失败，请复制错误信息反馈」（372d675 起的兜底文案），
 *     渲染层更不可能知道「这些红色任务是等网络恢复的」——于是复网后它们就一直是红的。
 *
 * 本文件钉住：
 *   A 网络类失败终态带上真实码（超时/断连分两档），历史行与队列行同码；
 *   B 非网络失败不许被认领（磁盘满说成网络问题 = 让用户去查没坏的网络）；
 *   C 取流层已经写好的码不被覆盖（fatal 短路那条路的码更准）；
 *   D 用户主动取消不写码（取消不是失败）；
 *   E 传输层的瞬时错误判定不再自带第二份正则（顺带把 net::ERR_* 一族接进退避重试与断点续传）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createDownloadQueueEngine } = require(path.join(ROOT, 'src/main/downloadQueue'));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mq-net-'));
}

/** 最小引擎替身：取流一律给个"能下"的 URL，下载阶段由测试决定怎么失败 */
function buildEngine(overrides = {}) {
  const dir = tmpDir();
  const historyAdds = [];
  const prefs = require(path.join(ROOT, 'src/utils/prefs'));
  const origPrefsGet = prefs.get;
  const prefsStore = { concurrency: 1, namingTemplate: '{artist} - {title}', ...(overrides.prefs || {}) };
  prefs.get = (k) => prefsStore[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: () => {},
    getDownloadUrlSmart: overrides.getDownloadUrlSmart || (async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' })),
    getLyrics: async () => ({ lrc: '' }),
    notifier: { notifyDownloadDone: () => {} },
    history: { add: (rec) => { historyAdds.push(rec); } },
    fsa: { statOrNull: async () => ({ size: 10 }) },
    downloader: {
      downloadFileWithRetry: overrides.downloadFileWithRetry || (async () => {}),
      embedId3Tags: async () => {},
    },
  });
  return { engine, historyAdds, restore: () => { prefs.get = origPrefsGet; } };
}

async function runOne(overrides) {
  const { engine, historyAdds, restore } = buildEngine(overrides);
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    return { song: engine.getQueue()[0], historyAdds };
  } finally { restore(); }
}

async function waitFor(fn, { timeout = 3000, interval = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时：任务没进 error 终态');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ══════════════════════════════════════════════════════════
// A：网络类失败带上真码
// ══════════════════════════════════════════════════════════

test(' 断连类传输失败 ⇒ 终态带 NETWORK_ERROR（队列与历史同码）', async () => {
  const { song, historyAdds } = await runOne({
    downloadFileWithRetry: async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); },
  });
  assert.strictEqual(song.errorCode, 'NETWORK_ERROR', '队列行的徽标只认这个码');
  assert.strictEqual(historyAdds[0].errorCode, 'NETWORK_ERROR', '历史行的徽标与队列行同一个码，不能一边有一边没有');
});

test(' Chromium 层的断网名（net::ERR_INTERNET_DISCONNECTED）也认得', async () => {
  const { song } = await runOne({
    downloadFileWithRetry: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); },
  });
  assert.strictEqual(song.errorCode, 'NETWORK_ERROR');
});

test(' 超时类分档为 NETWORK_TIMEOUT', async () => {
  const { song } = await runOne({
    downloadFileWithRetry: async () => { throw new Error('下载超时'); },
  });
  assert.strictEqual(song.errorCode, 'NETWORK_TIMEOUT');
});

// ══════════════════════════════════════════════════════════
// B/C/D：不许乱认领、不许覆盖更准的码、取消不算失败
// ══════════════════════════════════════════════════════════

test(' 磁盘满不写网络码（把磁盘问题说成网络问题会让人查半天网络）', async () => {
  const { song } = await runOne({
    downloadFileWithRetry: async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
  });
  assert.strictEqual(song.errorCode, undefined, '非网络失败保持无码，由关键词兜底说话');
});

test(' 取流层已经写好的码不被传输层覆盖', async () => {
  const { song } = await runOne({
    getDownloadUrlSmart: async () => ({ error: '需要 VIP', fatal: true, code: 'VIP_REQUIRED' }),
  });
  assert.strictEqual(song.errorCode, 'VIP_REQUIRED');
});

test(' 用户主动取消不写错误码（取消不是失败）', async () => {
  const { song, historyAdds } = await runOne({
    downloadFileWithRetry: async () => { throw Object.assign(new Error('aborted'), { cancelled: true }); },
  });
  assert.strictEqual(song.errorCode, undefined);
  assert.strictEqual(historyAdds.length, 0, '取消不写失败历史（原有规矩）');
});

// ══════════════════════════════════════════════════════════
// E：传输层判定同源
// ══════════════════════════════════════════════════════════

test(' 传输层不再自带第二份瞬时错误正则', () => {
  const code = stripComments(read('src/utils/downloader.js'));
  assert.ok(/require\(['"]\.\.\/shared\/netClass['"]\)/.test(code), 'downloader.js 没接 netClass 判据');
  assert.ok(/isTransportFailure\(/.test(code), '判据 require 了却没在重试分支上调用');
  // 原来只查 'ECONNRESET|ETIMEDOUT' 这一串字面量：换一种写法（单个码、net:: 一族）就漏过去，
  // 门禁照样绿。这里按"码表字面量"这一族逐个查，第二份判据一写出来就红。
  assert.ok(!/\bECONN[A-Z]*\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEPIPE\b|net::ERR_|socket hang up/.test(code),
    'isTransient 仍在本地手抄码表：那份漏了 net::ERR_*，断网时的传输失败既不退避也不续传');
});
