/**
 * request.js socket 空闲超时的可重试性测试（第二轮审计 M4）
 *
 * 修复前：timeout 错误消息是中文「请求超时」且无 err.code，
 * isRetriableError 匹配不到 → 超时永不重试，与「网络层错误值得重试」意图相反。
 *
 * skipSsrf: true —— 本用例把 http.request 整个打桩、用假域名 api.example，
 * 测的是「socket 空闲超时算不算可重试」。首跳的 SSRF 闸口（P1-6 补上后）
 * 会先做一次真实 DNS 解析，与本用例无关且在离线环境必然失败，故走测试通道。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const request = require('../src/api/request');

const origRequest = http.request;

test('M4: socket 空闲超时属于可重试错误，重试后成功', async () => {
  let calls = 0;
  const EE = require('node:events').EventEmitter;
  http.request = (opts, cb) => {
    calls++;
    const req = new EE();
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => {
        if (calls === 1) {
          req.emit('timeout'); // 第一跳：服务器 accept 后不回字节
          return;
        }
        const res = new EE();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.resume = () => {};
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ ok: 1 })));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const out = await request('http://api.example/list', { retryDelay: 5, skipSsrf: true });
    assert.strictEqual(calls, 2, `超时后应重试（实际发起 ${calls} 次请求）`);
    assert.deepStrictEqual(out, { ok: 1 });
  } finally {
    http.request = origRequest;
  }
});
