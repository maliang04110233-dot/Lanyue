/**
 * MCP 端到端：真 HTTP + 真协议层 + 真工具表，只有最底层的 callTool 是假的
 *
 * 为什么这一层非补不可：mcpServer.test.js 用假 handleMessage 只测鉴权壳，
 * mcpCore.test.js 直接调 handler 不经过 HTTP —— 两层各自绿着，但**从未有一次测试
 * 走完 tools/list → tools/call → 参数钳制 → 审计落盘**这条真实通路。
 * 17 个工具的名字、契约参数、审计字段任何一处对不上，今天都没有地方会红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMcpServer } = require('../src/main/mcp/mcpServer');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');
const { toolsFromContract, AGENT_TOOLS } = require('../src/main/mcp/tools');
const { createAuditStore, summarizeArgs } = require('../src/main/mcp/auditStore');

const TOKEN = 'e2e-token-0123456789abcdef';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-e2e-'));
  const audit = createAuditStore({ filePath: path.join(dir, 'mcp-audit.json') });
  const seen = [];
  // 审计是 fire-and-forget：写盘不阻塞给 Agent 的应答（否则磁盘抖动会拖慢每次调用）。
  // 测试因此要显式 settle() 等落盘，而不是假设「响应回来 = 记录已写」。
  const pending = [];
  const handler = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: '1.0.36',
    source: 'agent',
    onCall: (e) => { pending.push(audit.record(e)); },
    callTool: async (channel, args) => {
      seen.push({ channel, args });
      if (channel === 'search-music') return { songs: [{ id: '1', title: '双截棍' }] };
      if (channel === 'get-lyrics') return { error: '该源无歌词' };
      throw new Error(`未注册通道: ${channel}`);
    },
  });
  const server = createMcpServer({ token: TOKEN, handleMessage: handler, onRejected: () => {} });
  const { port } = await server.start(0);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: server.stop, audit, seen, dir,
    settle: async () => { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}

const rpc = (url, id, method, params) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('e2e: initialize → tools/list 拿到白名单全量工具，且不外泄内部 channel 字段', async () => {
  const h = await boot();
  try {
    const i = await rpc(h.url, 1, 'initialize', { protocolVersion: '2025-03-26' });
    assert.strictEqual(i.status, 200);
    assert.strictEqual(i.body.result.serverInfo.name, 'musicdl');
    const l = await rpc(h.url, 2, 'tools/list', {});
    const tools = l.body.result.tools;
    assert.strictEqual(tools.length, AGENT_TOOLS.length, '工具数量与显式白名单不一致');
    assert.strictEqual(tools.length, 21, '白名单条目数变了 —— 先确认没有越红线扩面，再同步这条钉');
    assert.ok(tools.every(t => !('channel' in t)), 'channel 属内部字段，绝不能出现在 tools/list');
    assert.ok(tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
  } finally { await h.stop(); }
});

test('e2e: tools/call 成功 → 结果 JSON、isError=false、审计落盘一条', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 3, 'tools/call', { name: 'search_music', arguments: { keyword: '周杰伦', source: 'all', page: 1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.result.isError, false);
    assert.match(r.body.result.content[0].text, /双截棍/);
    await h.settle();
    await h.settle();
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].tool, 'search_music');
    assert.strictEqual(items[0].ok, true);
    assert.strictEqual(items[0].source, 'agent');
    assert.strictEqual(items[0].summary, '周杰伦');
    assert.ok(typeof items[0].ms === 'number');
  } finally { await h.stop(); }
});

test('e2e: 业务失败按 isError 回文本（Agent 能续对话），审计记 ok=false + err', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 4, 'tools/call', { name: 'get_lyrics', arguments: { id: '9' } });
    assert.strictEqual(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /该源无歌词/);
    await h.settle();
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items[0].ok, false);
    assert.match(items[0].err, /该源无歌词/);
  } finally { await h.stop(); }
});

test('e2e: 参数钳制走契约 —— 超长 keyword 被截断而不是原样落到 handler', async () => {
  const h = await boot();
  try {
    await rpc(h.url, 5, 'tools/call', { name: 'search_music', arguments: { keyword: 'x'.repeat(5000) } });
    const call = h.seen.find(s => s.channel);
    assert.ok(call, 'handler 没被调用');
    assert.ok(call.args[0].length <= 200, `契约里 keyword 是 t.str(200)，实到 ${call.args[0].length}`);
  } finally { await h.stop(); }
});

test('e2e: 洪水调用触发 429；协议方法不进审计', async () => {
  const h = await boot();
  try {
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(h.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'ping', params: {} }),
      });
      if (res.status === 429) rejected += 1;
    }
    assert.ok(rejected >= 1, `默认容量 120/秒，200 次连打应有拒绝，实为 ${rejected}`);
    await h.settle();
    assert.strictEqual((await h.audit.list({ limit: 10 })).length, 0, 'ping 不进审计');
  } finally { await h.stop(); }
});

test('e2e: 摘要判据与协议层用的是同一份（防第二套敏感参数规则）', () => {
  const s = summarizeArgs({ aiMusicApiKey: 'mk-xxx', keyword: '夜跑' });
  assert.strictEqual(s.summary, '夜跑');
  assert.ok(!JSON.stringify(s).includes('mk-xxx'));
});
