/**
 * AI 调用方的「进程内执行面」只许有一个家
 *
 * 外部 Agent（HTTP）与应用内助手（IPC）跑的是同一批工具、同一套契约钳制、
 * 同一份审计。如果两边各自 require 一遍 createMcpHandler 并各自写 callTool，
 * 就会出现「改了一边、另一边静默失效」的经典漂移（例如助手侧忘了接审计）。
 * 本文件钉住：桥 = 唯一装配点；审计默认自动挂上；两个 source 都落进同一个文件。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentBridge } = require('../src/main/mcp/agentBridge');
const auditSink = require('../src/main/mcp/auditSink');

/** 审计是 fire-and-forget（写盘绝不拖慢 Agent 响应），所以读侧要等它落盘 */
async function waitForItems(store, want) {
  for (let i = 0; i < 50; i++) {
    const items = await store.list({ limit: 10 });
    if (items.length >= want) return items;
    await new Promise(r => setTimeout(r, 10));
  }
  return store.list({ limit: 10 });
}

test('桥默认自动接审计：不传 onCall 也会落盘，且 source 原样写进入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  auditSink._setUserDataDirForTest(dir);
  const handle = createAgentBridge({ source: 'assistant' });
  // search_music 是查询类，本测试进程没注册它 —— 走「通道未注册」的错误路径也要审计
  const r = await handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_music', arguments: { keyword: '夜跑' } },
  });
  assert.ok(r.result, JSON.stringify(r));
  const items = await waitForItems(auditSink.store(), 1);
  assert.strictEqual(items.length, 1, '审计没落到共享落点');
  assert.strictEqual(items[0].source, 'assistant');
  assert.strictEqual(items[0].tool, 'search_music');
});

test('显式 onCall 覆盖默认落点（HTTP 层要数限流，得自己挂）', async () => {
  const seen = [];
  const handle = createAgentBridge({ source: 'agent', onCall: (e) => seen.push(e) });
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'history_stats' } });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].source, 'agent');
});

test('未知工具在桥这一层就是协议错误，不会漂到 callTool 里', async () => {
  const handle = createAgentBridge({ source: 'assistant', onCall: () => {} });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } });
  assert.strictEqual(r.error.code, -32602);
});

test('装配点唯一：ipc/mcp.js 不得再自己攒一份 createMcpHandler / createAuditStore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'mcp.js'), 'utf8');
  assert.ok(!/createMcpHandler\(/.test(src), 'HTTP 侧应改用 createAgentBridge');
  assert.ok(!/createAuditStore\(/.test(src), '审计单例的家是 auditSink');
  assert.match(src, /createAgentBridge\(\{[\s\S]{0,240}source:\s*'agent'/, 'HTTP 侧没走桥');
});
