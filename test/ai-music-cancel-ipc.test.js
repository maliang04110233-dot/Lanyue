/**
 * 取消链路的主进程接线（2026-09 审计 P1-10 的另一半）
 *
 * 传输层那一半在 test/ai-music-abort.test.js（signal 真的断掉在途 socket）。
 * 本文件盯主进程这一半：signal 是从 ai-generate-music 一路递到
 * generateMusic 的，中间隔着一张 requestId → controller 的登记表 ——
 * 登记表一漂，取消又变成"点了没反应"。
 *
 * 这里还有一个只有并发版本才暴露的洞：渲染层一次生成两版（AI 写词默认出
 * 两个版本），两发共用同一个 requestId。原实现谁先跑完谁 delete 登记，
 * 于是"取消"只在两版都还在飞的时候有效；等其中一版落盘返回后，剩下那版
 * 仍在烧 token 却再也取消不掉 —— 取消链路在同一个地方又断了一次。
 *
 * 桩：把 ../../api/ai-music 换成可控 stub（不发真请求、不落盘），
 * 只验"signal 有没有递到位"和"登记表什么时候摘"。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const handlers = new Map();
/** 每次 generateMusic 收到的东西：{ params, signal }，由用例决定何时兑现 */
const calls = [];

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
      app: { getPath: () => path.join(require('node:os').tmpdir(), 'musictest-ai-') },
    };
  }
  if (parent && parent.filename && /[\\/]ipc[\\/]ai-music\.js$/.test(parent.filename)
      && request === '../../api/ai-music') {
    return {
      setHistoryPath() { /* no-op */ },
      generateMusic: (params, callOptions) => new Promise((resolve, reject) => {
        calls.push({ params, callOptions: callOptions || {}, resolve, reject });
      }),
      saveAudioFromHex: async (hex, p) => p,
      loadHistory: async () => [],
      addToHistory: async () => [],
      clearHistory() { /* no-op */ },
      translateLyrics: async () => ({}),
    };
  }
  return originalLoad(request, parent, isMain);
};
const ipcAiMusic = require(path.join(ROOT, 'src/main/ipc/ai-music'));
Module._load = originalLoad;
ipcAiMusic.register();

const { ENVELOPE_KEY } = require(path.join(ROOT, 'src/shared/ipcContract'));

async function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  const env = await fn({}, ...args);
  return env && env[ENVELOPE_KEY] === 1 ? env.data : env;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('对照组：单发生成时 signal 真的递到了 generateMusic', async () => {
  calls.length = 0;
  invoke('ai-generate-music', { requestId: 'r1', apiKey: 'k', lyrics: '词' });
  await tick(10);
  assert.equal(calls.length, 1, 'generateMusic 没被调到');
  assert.ok(calls[0].callOptions.signal, 'generateMusic 没收到 signal —— 取消又是死链');
  assert.equal(calls[0].callOptions.signal.aborted, false);
  // 收尾：把悬着的 promise 兑现掉，别留一个不落地的在途请求
  calls[0].resolve({ status: 0, duration: 0 });
});

test('取消：abort 真的落到那一发的 signal 上（用户点取消 = 在途请求停）', async () => {
  calls.length = 0;
  invoke('ai-generate-music', { requestId: 'r2', apiKey: 'k', lyrics: '词' });
  await tick(10);
  const signal = calls[0].callOptions.signal;
  assert.ok(signal, '没拿到 signal');

  const r = await invoke('ai-cancel-generation', 'r2');
  assert.equal(r.cancelled, true, '在途生成必须报取消成功');
  assert.equal(signal.aborted, true, 'signal 未被 abort —— 传输层收不到，计费请求照烧');

  // 未知 requestId：如实说不认识，不许假装取消成功
  const r2 = await invoke('ai-cancel-generation', 'never-existed');
  assert.equal(r2.cancelled, false);
});

test('并发版本：一版先返回后，剩下那版仍可被取消（登记按在途计数收尾）', async () => {
  calls.length = 0;
  // 渲染层一次生成两版，两发共用同一个 requestId
  const p1 = invoke('ai-generate-music', { requestId: 'r3', apiKey: 'k', lyrics: '词A' });
  const p2 = invoke('ai-generate-music', { requestId: 'r3', apiKey: 'k', lyrics: '词B' });
  await tick(10);
  assert.equal(calls.length, 2, '两发都该在途');
  const [a, b] = calls;
  assert.equal(a.callOptions.signal, b.callOptions.signal,
    '同一 requestId 的两发应当共用一个 controller（点一次取消 = 整批都停）');

  // 第一版先返回
  a.resolve({ status: 0, duration: 0 });
  await p1;
  await tick(10);

  // 此时第二版仍在计费，取消必须还有效
  const r = await invoke('ai-cancel-generation', 'r3');
  assert.equal(r.cancelled, true,
    '一版先返回就把登记摘掉的话，仍在计费的那一版永远取消不掉（取消链路第二次断）');
  assert.equal(b.callOptions.signal.aborted, true, '仍在途的那一版没收到 abort');
  b.reject(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }));
  const out2 = await p2;
  assert.equal(out2.error, '已取消', '主进程应把取消如实回给渲染层');
});

test('无 requestId 的调用不登记（老调用方不该被登记表误伤）', async () => {
  calls.length = 0;
  invoke('ai-generate-music', { apiKey: 'k', lyrics: '词' });
  await tick(10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callOptions.signal, undefined, '没有 requestId 就不该凭空造 signal');
});

test('接线钉：ai-cancel-generation 走的是登记表里的 controller（不是每次新建）', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'src/main/ipc/ai-music.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(src, /entry\.ctrl\.abort\(\)/,
    '取消必须 abort 登记表里那一发共用的 controller');
  assert.match(src, /entry\.pending--/,
    '登记表必须按在途计数收尾（谁先返回谁 delete = 剩下那版取消不掉）');
});
