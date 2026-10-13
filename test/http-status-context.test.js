/**
 * 取流链路的 HTTP 状态旁路记录（2026-10-13）
 *
 * 解决的问题（来自对 8 个平台的逐一取证）：
 *   1. `src/api/request.js` 向后兼容地 `return result.data`，把 `{status, data}`
 *      里的 status 丢掉了；
 *   2. 403 不在 reject 名单里（只有 5xx/429 才 reject），所以它连「异常」都不算，
 *      body 照样是合法 JSON 被正常返回；
 *   ⇒ 「这条链是不是 CDN 签名过期」这个最该触发跨源换源的信息，在插件层的
 *      catch 里**永远拿不到**。平台于是只返回一句笼统文案，
 *      resolveTrackService 那条专门为 403/404/410 准备的换源出口形同虚设。
 *
 * 修法走旁路而不是改返回值：把 `{data, status}` 返回给 8 个平台是破坏性改动
 * （它们全都按 body 取字段），把 403 升级成 reject 也会打断降级链。
 *
 * 本文件起**真实本地 HTTP 服务**验证行为，不用 mock —— 403 要真的被 resolve
 * 一遍，才能证明旁路记录的位置是对的。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  runWithHttpStatusContext,
  getLastHttpStatus,
} = require('../src/api/request');

/**
 * 起一个可编排的本地服务。skipSsrf 是 request.js 里明确留给测试服务器的开关
 * （与 downloader 的 skipSsrfCheck 同约定）—— 不开的话 127.0.0.1 会被 SSRF 闸口拦掉。
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('403 被旁路记录，而 body 仍照常返回（向后兼容是前提）', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, message: '签名过期' }));
  });
  try {
    const { result, lastStatus } = await runWithHttpStatusContext(
      () => require('../src/api/request')(`http://127.0.0.1:${srv.port}/url`, {
        skipSsrf: true, retries: 0,
      }),
    );
    assert.strictEqual(lastStatus, 403, '403 必须被记录 —— 这正是换源机制要认的信号');
    assert.deepStrictEqual(result, { code: -1, message: '签名过期' },
      'body 必须原样返回：8 个平台全按 body 取字段，改了就是破坏性改动');
  } finally {
    await srv.close();
  }
});

test('404 / 410 / 200 同样被记录（出口对整类状态生效，不是只对 403 特判）', async () => {
  for (const status of [404, 410, 200]) {
    const srv = await startServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const { lastStatus } = await runWithHttpStatusContext(
        () => require('../src/api/request')(`http://127.0.0.1:${srv.port}/url`, {
          skipSsrf: true, retries: 0,
        }),
      );
      assert.strictEqual(lastStatus, status);
    } finally {
      await srv.close();
    }
  }
});

test('5xx 走 reject 路径也记录（错误对象上的 statusCode 同样要旁路）', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  });
  try {
    // retries:0 ⇒ 503 立刻 reject（它是可重试状态，有重试就会多次打服务端）
    const { lastStatus } = await runWithHttpStatusContext(async () => {
      try {
        await require('../src/api/request')(`http://127.0.0.1:${srv.port}/url`, {
          skipSsrf: true, retries: 0,
        });
      } catch (_e) { /* 预期 reject */ }
    });
    assert.strictEqual(lastStatus, 503);
  } finally {
    await srv.close();
  }
});

test('降级链取「最后一次」状态（最接近最终为什么失败）', async () => {
  const srv = await startServer((req, res) => {
    // 同一个服务：先 404 再 403，用 URL 区分两次调用
    const st = req.url.includes('first') ? 404 : 403;
    res.writeHead(st, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ n: st }));
  });
  const req = require('../src/api/request');
  try {
    const { lastStatus } = await runWithHttpStatusContext(async () => {
      await req(`http://127.0.0.1:${srv.port}/first`, { skipSsrf: true, retries: 0 });
      await req(`http://127.0.0.1:${srv.port}/second`, { skipSsrf: true, retries: 0 });
    });
    assert.strictEqual(lastStatus, 403,
      '应取最后一次：平台降级链末尾那次响应的状态最接近「最终为什么失败」');
  } finally {
    await srv.close();
  }
});

test('不在上下文里时不污染全局（getLastHttpStatus 返回 null）', async () => {
  assert.strictEqual(getLastHttpStatus(), null,
    '旁路记录必须是显式作用域，不能变成进程级「最近一次状态」这种隐式全局');
});

test('守卫钉：gateway 的取流出口必须用上下文并把 lastStatus 传进分类', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/api/gateway.js'), 'utf8');
  assert.match(src, /runWithHttpStatusContext/,
    'gateway 没用上下文 ⇒ 平台永远拿不到 status 信号，这条改动等于没做');
  assert.match(src, /httpStatus:\s*lastStatus/,
    'lastStatus 必须传进 annotateStreamError，否则分类层看不到它');
  assert.match(src, /require\('\.\/request'\)/,
    '上下文 helper 来自 request.js');
});