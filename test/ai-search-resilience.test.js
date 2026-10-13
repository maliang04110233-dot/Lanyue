/**
 * AI 搜索的失败可见性（2026-10-13 复审 P2-13）与请求重试不重复（P2-12）
 *
 * P2-13：并行扇出里单个关键词失败被 `.catch(() => [])` 吞成空列表，而 queries
 *   原样返回 ⇒ 界面看不出有 1~2 个关键词挂了。现在失败收进 failedQueries，
 *   成功的结果一条不丢，但界面必须能说出「结果可能不全」。
 *
 * P2-12：一次超时会排出**两个**重试定时器（timeout 分支 req.destroy() 引发同一 req
 *   的 'error'，两个分支各排一个，retryTimer 被覆盖的那个没被 clear）⇒ 一次超时
 *   换两次请求、两次计费。本文件用假 request 制造「destroy 必然触发 error」这个
 *   真实行为序列，断言只发一次重试。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { searchByPhrase } = require('../src/api/services/nlSearchService');

// ── P2-13 ──────────────────────────────────────────────

test('P2-13：单个关键词失败 ⇒ 结果里带 failedQueries，成功的结果一条不丢', async () => {
  const song = (id) => ({ id, source: 'qq', title: `t${id}` });
  const r = await searchByPhrase({
    phrase: '夜跑 中文摇滚',
    rewrite: async () => ['q1', 'q2', 'q3'],
    searchAll: async (k) => {
      if (k === 'q2') throw new Error('搜索超时');
      if (k === 'q3') throw new Error('聚合源全失败');
      return [song('1'), song('2')];
    },
  });
  assert.strictEqual(r.songs.length, 2, '成功关键词的结果必须照常返回');
  assert.deepStrictEqual(r.queries, ['q1', 'q2', 'q3'], '改写出来的关键词仍原样回报');
  assert.strictEqual(r.failedQueries.length, 2, '失败的两个关键词必须可见');
  assert.deepStrictEqual(r.failedQueries.map(f => f.query).sort(), ['q2', 'q3']);
  assert.match(r.failedQueries[0].error, /超时|失败/);
});

test('P2-13：全部失败时 failedQueries 覆盖全部，且 songs 为空而非缺字段', async () => {
  const r = await searchByPhrase({
    phrase: 'x',
    rewrite: async () => ['a', 'b'],
    searchAll: async () => { throw new Error('全网失败'); },
  });
  assert.deepStrictEqual(r.songs, []);
  assert.strictEqual(r.failedQueries.length, 2);
});

test('P2-13：全部成功时**不**产生 failedQueries 字段（避免调用方判 undefined）', async () => {
  const r = await searchByPhrase({
    phrase: 'x',
    rewrite: async () => ['a'],
    searchAll: async () => [{ id: '1', source: 'qq', title: 'A' }],
  });
  assert.ok(!('failedQueries' in r), '成功路径不该多吐一个空数组字段');
});

test('P2-13：失败关键词若恰好命中 limit 截断，仍要报（不能被 break 吞掉）', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), source: 'qq', title: 't' }));
  const r = await searchByPhrase({
    phrase: 'x',
    rewrite: async () => ['full', 'boom'],
    searchAll: async (k) => (k === 'boom' ? Promise.reject(new Error('挂了')) : many(5)),
    limit: 3,
  });
  assert.strictEqual(r.songs.length, 3);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.failedQueries.length, 1, '失败信息与截断互不影响');
});

// ── P2-12 ──────────────────────────────────────────────

/**
 * 起一个只接受连接但不响应的服务：客户端 timeout 到点触发 req.destroy()，
 * 而 destroy 必然让同一 req 发出 'error'（socket hang up）—— 正是旧实现双发重试
 * 的成因。每次 doRequest 对应一次 TCP 连接，用连接数即可量化「发了多少跳」。
 */
function startBlackHole() {
  return new Promise((resolve) => {
    const sockets = [];
    let connections = 0;
    const server = http.createServer(() => { /* 故意不响应 */ });
    server.on('connection', (s) => { connections++; sockets.push(s); });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      get connections() { return connections; },
      close: () => new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(r);
      }),
    }));
  });
}

test('P2-12：一次超时只排一次重试（否则一次超时 = 两次请求 = 两次计费）', async () => {
  const bh = await startBlackHole();
  try {
    const { request } = require('../src/api/ai-music');
    // retries=2 ⇒ 期望 1 次首发 + 2 次重试 = 3 次连接。
    // 旧实现里 timeout 分支的 req.destroy() 会让同一 req 紧接着发 'error'，
    // 两个分支各排一个定时器，且 retryTimer 被后一次赋值覆盖 ⇒ 前一个没被 clear，
    // 于是变成 1 + 2 + 2 = 5 次连接（一次超时换两次请求）。
    await assert.rejects(
      request(`http://127.0.0.1:${bh.port}/chat`, {
        method: 'POST',
        timeout: 80,
        retries: 2,
        retryDelay: 10,
      }),
      /超时/,
    );
    assert.strictEqual(bh.connections, 3,
      `期望 3 次连接（首发+2 次重试），实际 ${bh.connections} 次 —— 同一跳排了两次重试`);
  } finally {
    await bh.close();
  }
});

test('P2-12：取消优先于重试（退避等待期被取消 ⇒ 一跳都不多发）', async () => {
  const bh = await startBlackHole();
  const ctrl = new AbortController();
  try {
    const { request } = require('../src/api/ai-music');
    const p = request(`http://127.0.0.1:${bh.port}/chat`, {
      method: 'POST',
      timeout: 80,
      retries: 3,
      retryDelay: 200,      // 退避窗口足够长，取消一定落在窗口里
      signal: ctrl.signal,
    }).catch(() => null);
    setTimeout(() => ctrl.abort(), 20);
    await p;
    assert.strictEqual(bh.connections, 1, '取消后不得再发重试请求（那是白烧 token）');
  } finally {
    await bh.close();
  }
});
