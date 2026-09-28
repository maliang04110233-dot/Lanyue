/**
 * 单元测试：api/request.js
 *
 * 用本地 http server 模拟，覆盖两部分：
 *   - request() 的重试与指数退避
 *   - testAudioLink() 的直链预检（HEAD 被拒退化 Range GET、302 跟随、
 *     拒绝文本识别、体积/扩展名解析、异常不抛）
 *
 * ── 2026-09 审计 P1-6：首跳也过 urlGuard，本文件的用例要显式旁路 ──
 * 修好首跳缺口后，request() 对 127.0.0.1 一律抛 ssrf-blocked —— 下面这些
 * 用例真正在测的是「重试/退避/4xx 透传/超时可重试」这条链路，必须真的连上
 * 本机 server，所以按仓库既有约定（downloader 的 skipSsrfCheck 同名同义、
 * 本文件末尾的 skipSsrf 用例）走测试通道 skipSsrf: true。
 * 闸口本身的行为由 test/request-ssrf-firsthop.test.js 单独钉（含「首跳必须被拦」
 * 与「被拦不进重试」），两处合计的覆盖面只增不减。
 * 唯一不旁路的是末尾那条「302 跳到内网被拒」——它要的就是闸口生效。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('../src/api/request');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('request: 成功响应直接返回解析后的 JSON', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 0, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { ok: true });
  } finally {
    server.close();
  }
});

test('request: 网络错误重试到成功（重试 2 次后通）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count < 3) {
      res.destroy();  // 模拟网络中断
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempts: count }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 10, timeout: 5000, skipSsrf: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.attempts, 3);
  } finally {
    server.close();
  }
});

test('request: 超过重试次数后抛出', async () => {
  const { server, port } = await startServer((req, res) => {
    res.destroy();
  });
  try {
    await assert.rejects(
      () => request(`http://127.0.0.1:${port}/`, { retries: 1, retryDelay: 10, timeout: 2000, skipSsrf: true }),
      /Error|ECONNRESET|aborted|socket/i
    );
  } finally {
    server.close();
  }
});

test('request: 5xx 触发重试', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count < 2) {
      res.writeHead(503);  // 第一次 503
      res.end('upstream busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recovered: true }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 10, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { recovered: true });
  } finally {
    server.close();
  }
});

test('request: 4xx 客户端错误不重试（resolve 出 body 字符串，调用方按业务判断）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(404);
    res.end('not found');
  });
  try {
    // 4xx 走 resolve，body 字符串透传
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 10, timeout: 5000, skipSsrf: true });
    assert.strictEqual(result, 'not found');
    assert.strictEqual(count, 1, '4xx 不应触发重试');
  } finally {
    server.close();
  }
});

// ── testAudioLink：音频直链预检 ─────────────────────────
// 预检的价值在于「不把坏链交给下载器」：无版权曲常返回 200 + text/plain
// 的 "refuse request!"，只看状态码会误判成功。全部用本地 server 桩，无外网依赖。

test('testAudioLink: 音频响应判为可用，解析体积与扩展名', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '181521' });
    res.end(Buffer.alloc(64, 1));
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/song.mp3`, { skipSsrfCheck: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.ext, 'mp3');
    assert.strictEqual(r.sizeBytes, 181521);
  } finally { server.close(); }
});

test('testAudioLink: 200 但返回 text/plain 的拒绝文本 → 判为不可用', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('refuse request!');
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/anti.s`, { skipSsrfCheck: true });
    assert.strictEqual(r.ok, false, 'text 响应不应被判为可用音频');
    assert.strictEqual(r.reason, 'not-audio');
  } finally { server.close(); }
});

test('testAudioLink: HEAD 被拒时退化为 Range GET，并从 content-range 取总长', async () => {
  const seen = { head: 0, get: 0, range: '' };
  const { server, port } = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      seen.head++;
      res.writeHead(403);
      res.end();
      return;
    }
    seen.get++;
    seen.range = req.headers.range || '';
    res.writeHead(206, {
      'Content-Type': 'audio/mpeg',
      'Content-Range': 'bytes 0-1/5242880',
      'Content-Length': '2',
    });
    res.end(Buffer.from([1, 2]));
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/a.mp3`, { skipSsrfCheck: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 206);
    assert.strictEqual(seen.get, 1, 'HEAD 403 后应发起一次 GET');
    assert.strictEqual(seen.range, 'bytes=0-1', 'GET 必须带 Range 头（绝不整包拉取）');
    assert.strictEqual(r.sizeBytes, 5242880, '体积应取 content-range 的总长而非分片长度');
  } finally { server.close(); }
});

test('testAudioLink: 跟随 302 重定向到真实音频', async () => {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/jump') {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/real.mp3` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.alloc(16, 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/jump`, { skipSsrfCheck: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 200);
  } finally { server.close(); }
});

test('testAudioLink: 4xx 判为不可用并带状态码', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/missing.mp3`, { skipSsrfCheck: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 404);
  } finally { server.close(); }
});

test('testAudioLink: 非法 URL 与连接失败均不抛异常', async () => {
  const bad = await request.testAudioLink('not-a-url');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'invalid-url');

  // 端口无人监听 → 网络错误，应 resolve 成 ok:false 而不是 reject
  const dead = await request.testAudioLink('http://127.0.0.1:1/x.mp3', { timeout: 1500, skipSsrfCheck: true });
  assert.strictEqual(dead.ok, false);

  const empty = await request.testAudioLink('');
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty-url');
});

// ── SSRF：内网地址必须被 urlGuard 拒掉（2026-09 审计 P1-6）──
//
// 这条用例的 URL 全部在环回上，P1-6 修好首跳之后它是被**首跳**拦下的，
// 请求根本没发出去 —— 断言（rejects /ssrf-blocked/）不变，且比原来更早生效。
// 「入口放行、重定向跳才被拦」这一形态用真实 server 造不出来（要么入口被拦、
// 要么整链旁路），改由 test/request-ssrf-firsthop.test.js 打桩精确覆盖：
// 那里能让入口解析到假公网 IP 放行、只拦第二跳。

test('request: 环回地址被 urlGuard 拒绝（ssrf-blocked，且请求根本没发出去）', async () => {
  const { server: dest, port: destPort } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ internal: true }));
  });
  let hitJump = 0;
  let hitSecret = 0;
  const { server, port } = await startServer((req, res) => {
    hitJump++;
    if (req.url === '/secret') { hitSecret++; res.end('{}'); return; }
    res.writeHead(302, { Location: `http://127.0.0.1:${destPort}/secret` });
    res.end();
  });
  try {
    await assert.rejects(
      request(`http://127.0.0.1:${port}/jump`, { retries: 0, timeout: 5000 }),
      /ssrf-blocked/,
    );
    // 关键：闸口在连接之前，环回 server 一个字节都不该收到
    assert.strictEqual(hitJump, 0, '首跳被闸口拦下时不应真的发出请求');
    assert.strictEqual(hitSecret, 0);
  } finally {
    server.close();
    dest.close();
  }
});


test('request: skipSsrf 显式放行时仍跟随重定向（本机测试场景）', async () => {
  const { server: dest, port: destPort } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reached: true }));
  });
  const { server, port } = await startServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destPort}/ok` });
    res.end();
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/jump`, { retries: 0, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { reached: true });
  } finally {
    server.close();
    dest.close();
  }
});
