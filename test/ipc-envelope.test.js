/**
 * IPC 桥层信封（力度 A）：register.js 统一包 {envKey, ok, data/error}，
 * preload 解包还原 —— 渲染层拿到的值与迁移前逐字节一致，
 * 信封只存在于传输层（getInvokeHandler / MCP 拿到的仍是裸 handler）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('node:module');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} } };
  }
  return originalLoad(request, parent, isMain);
};

const { ENVELOPE_KEY, buildContractArg } = require('../src/shared/ipcContract');
const { handle, getInvokeHandler } = require('../src/main/ipc/register');

const call = (channel, event = {}, ...args) => handlers.get(channel)(event, ...args);

test('成功返回值被包成 {env, ok:true, data}', async () => {
  const fn = () => ({ some: 'value' });
  handle('get-default-dir', fn);
  const env = await call('get-default-dir');
  assert.strictEqual(env[ENVELOPE_KEY], 1);
  assert.strictEqual(env.ok, true);
  assert.deepStrictEqual(env.data, { some: 'value' });
});

test('handler 抛错被捕获为 {env, ok:false, error}，不再向外抛', async () => {
  handle('get-cache-size', async () => { throw new Error('boom'); });
  const env = await call('get-cache-size');
  assert.strictEqual(env[ENVELOPE_KEY], 1);
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.error, 'boom');
});

test('参数非法仍是 resolved 值 {error, fatal:true}（零漂移）', async () => {
  handle('scan-local-library', () => 'must-not-run');
  const env = await call('scan-local-library', {}, { not: 'a string' });
  assert.strictEqual(env[ENVELOPE_KEY], 1);
  assert.strictEqual(env.ok, true, '参数拒绝历史上就是 resolved 值，信封不得改变其语义');
  assert.strictEqual(env.data.fatal, true);
  assert.match(env.data.error, /参数非法/);
});

test('getInvokeHandler 返回裸 handler（主进程内复用不经信封）', () => {
  const fn = async () => 'raw';
  handle('get-version', fn);
  assert.strictEqual(getInvokeHandler('get-version'), fn);
});

test('契约 argv 携带 envKey，preload 由此派生解包键', () => {
  assert.ok(typeof ENVELOPE_KEY === 'string' && ENVELOPE_KEY.length > 0,
    'ipcContract 必须导出非空 ENVELOPE_KEY');
  const payload = JSON.parse(buildContractArg('main').slice('--ipc-contract='.length));
  assert.strictEqual(payload.envKey, ENVELOPE_KEY);
});

test('preload 每个 ipcRenderer.invoke 出口都接 unwrap（源码扫描）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  const invokes = src.match(/ipcRenderer\.invoke\(/g) || [];
  const unwraps = src.match(/\.then\(unwrap\)/g) || [];
  // miniAPI 自 preload.js 删至 preload-secondary.js（v1.0.36 死代码清理），
  // 主 preload 只剩 musicAPI + ipcRenderer 两个桥的 invoke 出口，下限从 6 降至 3
  assert.ok(invokes.length >= 3, `预期至少 3 个 invoke 出口，实得 ${invokes.length}`);
  assert.strictEqual(unwraps.length, invokes.length,
    'preload 中每个 ipcRenderer.invoke 都必须 .then(unwrap)，否则渲染层会看到信封泄漏');
  assert.match(src, /contract\.envKey/, 'preload 必须从契约 argv 派生 envKey，不得硬编码第二份事实');
});

test('渲染层不得出现信封键（信封止步于 preload）', () => {
  assert.ok(typeof ENVELOPE_KEY === 'string' && ENVELOPE_KEY.length > 0);
  const dir = path.join(__dirname, '../src/renderer');
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes(ENVELOPE_KEY)) bad.push(p);
    }
  })(dir);
  assert.deepStrictEqual(bad, [], '渲染层见到信封键说明有通道绕过了 preload 解包');
});
