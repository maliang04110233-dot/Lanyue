/**
 * MCP 传输层速率限制
 *
 * SECURITY.md §4 曾记录的未闭合项：「MCP 服务只靠 Bearer 令牌与 Origin 白名单防误触，
 * 没有请求频率限制」。一个写坏的 Agent 循环（或拿到令牌的任意本机进程）可以无限
 * 触发下载/改库。这里补上令牌桶把它闭合（§4 现为事实描述），钉四条：
 *   ① 桶满必拒（429 + Retry-After）；② 时间推进后自动恢复；
 *   ③ 未通过鉴权的请求不吃桶 —— 否则任何人都能用垃圾请求把合法客户端饿死；
 *   ④ 批量 JSON-RPC 按整批计一次（协议层已把数组拆开分发，计量口径要钉住）。
 * 时钟注入（now）保证不靠 sleep 测限流。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createMcpServer, DEFAULT_RATE_LIMIT } = require('../src/main/mcp/mcpServer');

const TOKEN = 'rate-test-token-0123456789';

async function serve(opts = {}) {
  let clock = 0;
  const rejected = [];
  const server = createMcpServer({
    token: TOKEN,
    handleMessage: async (msg) => (Array.isArray(msg)
      ? msg.map(m => ({ jsonrpc: '2.0', id: m.id, result: { ok: true } }))
      : { jsonrpc: '2.0', id: msg.id, result: { ok: true } }),
    rateLimit: opts.rateLimit,
    now: () => clock,
    onRejected: (info) => rejected.push(info),
  });
  const { port } = await server.start(0);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: server.stop,
    rejected,
    advance(ms) { clock += ms; },
  };
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
});
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

test('桶满必拒：超出 capacity 立刻 429，带 Retry-After', async () => {
  const h = await serve({ rateLimit: { capacity: 3, refillPerSec: 1 } });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await post(h.url, init)).status, 200);
    const res = await post(h.url, init);
    assert.strictEqual(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1, 'Retry-After 至少 1 秒');
    const body = await res.json();
    assert.strictEqual(body.error, 'rate_limited');
    assert.strictEqual(h.rejected.length, 1);
  } finally { await h.stop(); }
});

test('时间推进后恢复：refill 到足额就能继续调用', async () => {
  const h = await serve({ rateLimit: { capacity: 2, refillPerSec: 1 } });
  try {
    await post(h.url, init); await post(h.url, init);
    assert.strictEqual((await post(h.url, init)).status, 429);
    h.advance(1000);
    assert.strictEqual((await post(h.url, init)).status, 200);
  } finally { await h.stop(); }
});

test('鉴权失败不吃桶：错 token 连打 100 次后，合法请求仍有全额容量', async () => {
  const h = await serve({ rateLimit: { capacity: 5, refillPerSec: 1 } });
  try {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(h.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify(init),
      });
      assert.strictEqual(r.status, 401);
    }
    for (let i = 0; i < 5; i++) assert.strictEqual((await post(h.url, init)).status, 200);
    assert.strictEqual(h.rejected.length, 0, '401 不该被记成限流');
  } finally { await h.stop(); }
});

test('批量请求整批计一次（计量口径钉死）', async () => {
  const h = await serve({ rateLimit: { capacity: 2, refillPerSec: 1 } });
  try {
    const res = await post(h.url, [init, init, init]);
    assert.strictEqual(res.status, 200, '3 条一批发 200 —— 批次只扣 1 个令牌');
    assert.strictEqual((await post(h.url, init)).status, 200);
    assert.strictEqual((await post(h.url, init)).status, 429);
  } finally { await h.stop(); }
});

test('默认容量存在且宽松：正常 Agent 一轮对话（几十次调用）不该被限', () => {
  assert.ok(DEFAULT_RATE_LIMIT.capacity >= 60, '默认容量过小会误伤真实使用');
  assert.ok(DEFAULT_RATE_LIMIT.refillPerSec >= 10);
});
