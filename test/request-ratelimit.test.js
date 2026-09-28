/**
 * 单元测试：api/request.js 的限流退避 = 补 Sprint B 最后一项
 *
 * 覆盖计划文档明确列为「待补」的三项中的两项：
 *   1. 429 限流退避（本文件）
 *   2. URL 过期重取（见 resolveTrackService.test.js 的 CDN 过期用例，本轮补边界）
 *
 * 关于「请求取消（AbortSignal）」的说明 —— **故意不在此文件伪造**：
 *   实测 `src/api/request.js` 的 `request()` / `_followRedirects()` / `_probeAudio()`
 *   全部**没有** signal 参数，全仓 `AbortController` 只出现在
 *   `renderer/js/views/ai-music.js`（AI 音乐生成，与本模块无关）。
 *   也就是说「请求取消」不是「缺测试」，而是**缺功能**。
 *   给重构轮补一个不存在的行为测试，等于用测试固化一个假象；
 *   正确做法是把它作为独立特性单独立项（见本轮报告）。
 *
 * 用本地 http server 模拟，无外网依赖（与既有 request.test.js 同风格）。
 *
 * 所有 request() 调用都带 skipSsrf: true：P1-6 补上首跳闸口之后，环回地址
 * 一律被 urlGuard 拒掉，而这些用例真正在测的是 429/5xx 的退避节奏与状态码
 * 透传，必须真的连上本机 server，故按仓库既有约定（downloader 的
 * skipSsrfCheck 同名同义）走测试通道。闸口自身的行为见
 * test/request-ssrf-firsthop.test.js，两处合计覆盖面只增不减。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('../src/api/request');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** 采集一段代码的真实耗时（用于断言退避确实发生了等待） */
async function withTiming(fn) {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value };
}

/**
 * 捕获 reject 出的错误对象本身。
 *
 * ⚠️ 不要写 `const err = await assert.rejects(...)` ——
 *    `assert.rejects()` 的 promise 只 resolve 出 `undefined`，
 *    并不会把错误交回来（早期用错此处会让 err 恒为 undefined，
 *    报「Cannot read properties of undefined (reading 'statusCode')」）。
 */
async function catchError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('预期该调用抛出错误，但它成功 resolve 了');
}

// ── 429 限流退避 ────────────────────────────────────────────

test('429: 持续 429 时按 retries 重试，最终抛出且带 statusCode=429', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(429, { 'Retry-After': '1' });
    res.end('rate limited');
  });
  try {
    const err = await catchError(
      () => request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 5, timeout: 5000, skipSsrf: true })
    );
    // 429 属 isRetriableStatus → 重试到上限（1 次首发 + 2 次重试 = 3）
    assert.strictEqual(count, 3, `429 应重试到上限，实际请求 ${count} 次`);
    assert.strictEqual(err.statusCode, 429, '抛出的错误必须带 statusCode，供上层判定限流');
    assert.match(String(err.message), /429/);
  } finally { server.close(); }
});

test('429: 前两次限流后恢复 → 最终 resolve 出业务数据（重试确实救了回来）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count <= 2) {
      res.writeHead(429);
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempts: count }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 5, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { ok: true, attempts: 3 });
  } finally { server.close(); }
});

test('429: retries=0 时不重试，只发一次请求', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(429);
    res.end('nope');
  });
  try {
    await assert.rejects(
      () => request(`http://127.0.0.1:${port}/`, { retries: 0, retryDelay: 5, timeout: 5000, skipSsrf: true })
    );
    assert.strictEqual(count, 1, 'retries=0 必须只请求一次');
  } finally { server.close(); }
});

test('429: 抛出的错误携带 responseBody，便于上层记录限流响应体', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(429);
    res.end('quota exceeded: retry later');
  });
  try {
    const err = await catchError(
      () => request(`http://127.0.0.1:${port}/`, { retries: 0, timeout: 5000, skipSsrf: true })
    );
    assert.strictEqual(err.responseBody, 'quota exceeded: retry later');
  } finally { server.close(); }
});

test('退避时序: 退避延迟按 baseDelay × 3^attempt 增长（用真实耗时验证）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(503);
    res.end('busy');
  });
  try {
    // baseDelay=60 → 退避 60ms + 180ms = 240ms（另有两次请求往返的极小开销）
    const { ms } = await withTiming(() =>
      request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 60, timeout: 5000, skipSsrf: true })
        .catch(() => null)
    );
    assert.strictEqual(count, 3);
    // 下限严格：必须 ≥ 240ms（证明真的等待了，而不是立即重试）
    assert.ok(ms >= 240, `总耗时 ${ms}ms 应 ≥ 240ms（60+180 退避）；若小于则退避未生效`);
    // 上限宽松：只用于捕捉「退避量级算错」（如误用 baseDelay × 3^retries 或固定延迟）
    assert.ok(ms < 1200, `总耗时 ${ms}ms 异常偏大，退避量级可能算错`);
  } finally { server.close(); }
});

test('退避时序: 退避随 attempt 递增（第二次等待明显长于第一次）', async () => {
  // 用「相邻请求到达的时间间隔」直接测量每次退避，而非只看总耗时
  const gaps = [];
  let last = null;
  const { server, port } = await startServer((req, res) => {
    const now = Date.now();
    if (last !== null) gaps.push(now - last);
    last = now;
    res.writeHead(503);
    res.end('busy');
  });
  try {
    await request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 50, timeout: 5000, skipSsrf: true }).catch(() => null);
    assert.strictEqual(gaps.length, 2, '应有两次重试间隔（3 次请求）');
    // 期望 gap1≈50ms、gap2≈150ms；断言「第二个 gap 至少是第一个的 1.5 倍」
    assert.ok(
      gaps[1] >= gaps[0] * 1.5,
      `退避应指数增长，实际间隔 ${JSON.stringify(gaps)}（期望 gap2 ≥ gap1 × 1.5）`
    );
  } finally { server.close(); }
});

test('429: 与 5xx 共用同一重试通道（isRetriableStatus 判据一致）', async () => {
  // 一次 429 + 一次 502 + 成功 → 证明两类状态码走同一条重试逻辑
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count === 1) { res.writeHead(429); res.end('limited'); return; }
    if (count === 2) { res.writeHead(502); res.end('bad gateway'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 5, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(count, 3);
  } finally { server.close(); }
});

test('429: 4xx 中非 429 者不重试（401 应立即返回，不浪费退避）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 5, timeout: 5000, skipSsrf: true });
    assert.strictEqual(result, 'unauthorized', '4xx 走 resolve 透传 body');
    assert.strictEqual(count, 1, '401 不应重试');
  } finally { server.close(); }
});

// ── 边界：429 的 body 不应污染成功路径 ─────────────────────

test('429 后成功：返回的是成功响应的 body，而非限流响应体', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count === 1) {
      res.writeHead(429);
      res.end('RATE LIMITED BODY');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ real: 'data' }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 5, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { real: 'data' });
    assert.ok(!JSON.stringify(result).includes('RATE LIMITED'), '限流 body 不得泄漏进成功结果');
  } finally { server.close(); }
});
