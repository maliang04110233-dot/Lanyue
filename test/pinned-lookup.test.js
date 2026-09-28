/**
 * DNS rebinding 闭环回归（2026-09 审计余项：pinned-lookup 透传）
 *
 * 背景：urlGuard.assertPublicHttpUrl 已返回校验过的 ips，且 makePinnedLookup
 * 存在（playCache 已用）。但 request / downloader / probe 三个网络出口把
 * 校验结果丢弃，"校验 → 连接"之间 DNS 可被调包（rebinding TOCTOU）。
 * 本文件用桩钉死：凡是过了 guard 的那一跳，连接必须固定用校验时的 IP，
 * 而 hostname（Host 头 / TLS SNI）仍是原域名。
 *
 * 打桩方式：替换 http.request（捕获 reqOptions + 假响应脚本）与
 * dns.promises.lookup（虚拟域 → TEST-NET 假公网 IP），全程无真实网络。
 *
 * 2026-09 审计 P1-6：首跳也过 guard 了（此前只有 3xx 分支调 assertPublicHttpUrl），
 * 所以下面 request.js 那条用例的入口域名也必须在桩表里，否则解析失败会被闸口
 * 挡在第一跳 —— 断言从「入口不钉」升级成「入口也钉」，覆盖面只增不减。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');

const FAKE_PUBLIC = '93.184.216.34';  // 真公网形态的假 IP（urlGuard 拦的是保留段，无需 TEST-NET）
const FAKE_CDN = '104.26.10.5';      // 同上

/**
 * 安装 http.request / dns.promises.lookup 桩。
 * @param {Object} records 域名 → IP 数组（urlGuard 的 DNS 视图）
 * @param {Array<{statusCode?:number, headers?:Object, body?:string}>} script 依次序返回假响应
 * @returns {calls, restore}
 */
function installStubs(records, script) {
  const origRequest = http.request;
  const origLookup = dns.promises.lookup;
  const calls = [];

  dns.promises.lookup = (hostname, opts, cb) => {
    const ips = records[hostname];
    const p = !ips
      ? Promise.reject(Object.assign(new Error('ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }))
      : Promise.resolve(
        (opts && opts.all)
          ? ips.map((ip) => ({ address: ip, family: net.isIP(ip) }))
          : { address: ips[0], family: net.isIP(ips[0]) },
      );
    if (typeof cb === 'function') {
      p.then((v) => cb(null, v), (e) => cb(e));
      return undefined;
    }
    return p;
  };

  http.request = (options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.abort = req.destroy = () => {};
    req.setTimeout = () => {};
    req.end = () => {
      calls.push(options);
      const next = script[calls.length - 1];
      if (!next) { req.emit('error', new Error('桩脚本耗尽')); return; }
      const res = new EventEmitter();
      res.statusCode = next.statusCode || 200;
      res.headers = next.headers || {};
      res.resume = () => {};
      res.destroy = () => {};
      onResponse(res);
      setImmediate(() => {
        if (next.body) res.emit('data', Buffer.from(next.body));
        if (!(next.statusCode >= 300 && next.statusCode < 400)) res.emit('end');
      });
    };
    return req;
  };

  return {
    calls,
    restore: () => { http.request = origRequest; dns.promises.lookup = origLookup; },
  };
}

/** 取出 lookup 的解析结果（all 形态） */
function resolveVia(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

// 这些桩模块在测试内被全局替换，必须串行且用完即还原
test('request.js：过了 guard 的每一跳（含首跳）连接都固定用校验时的 IP', async () => {
  const request = require('../src/api/request');
  const s = installStubs(
    { 'api.example.test': [FAKE_PUBLIC], 'rebind.example.test': [FAKE_CDN] },
    [
      { statusCode: 302, headers: { location: 'http://rebind.example.test/x' } },
      { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' },
    ],
  );
  try {
    const out = await request('http://api.example.test/s');
    assert.deepStrictEqual(out, { ok: 1 }); // request 向后兼容直接返回 data
    // 首跳同样过了 guard（审计 P1-6 补上的缺口）→ 也要钉住校验结果。
    // 修复前这里断言的是 lookup === undefined，注释写着「入口从未过 guard」。
    assert.strictEqual(typeof s.calls[0].lookup, 'function', '首跳过了 guard 就必须钉');
    const entryAddrs = await resolveVia(s.calls[0].lookup, 'api.example.test');
    assert.deepStrictEqual(entryAddrs.map((a) => a.address), [FAKE_PUBLIC]);
    // 重定向跳：assertPublicHttpUrl 校验过 rebind.example.test → 钉住校验结果
    assert.strictEqual(typeof s.calls[1].lookup, 'function', '重定向跳应携带 pinned lookup');
    const addrs = await resolveVia(s.calls[1].lookup, 'rebind.example.test');
    assert.deepStrictEqual(addrs.map((a) => a.address), [FAKE_CDN]);
    assert.strictEqual(s.calls[1].hostname, 'rebind.example.test', 'Host 侧仍是原域名');
  } finally { s.restore(); }
});

test('request.js：skipSsrf（本机测试通道）不做 pin，维持原解析路径', async () => {
  const request = require('../src/api/request');
  const s = installStubs(
    {},
    [
      { statusCode: 302, headers: { location: 'http://127.0.0.1:9/x' } },
      { statusCode: 200, headers: {}, body: 'ok' },
    ],
  );
  try {
    await request('http://api.example.test/s', { skipSsrf: true });
    assert.strictEqual(s.calls[1].lookup, undefined);
  } finally { s.restore(); }
});

test('testAudioLink：每一跳探测都钉在 guard 校验过的 IP 上', async () => {
  const { testAudioLink } = require('../src/api/request');
  const s = installStubs(
    { 'cdn.example.test': [FAKE_PUBLIC] },
    [{ statusCode: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '10' } }],
  );
  try {
    const r = await testAudioLink('http://cdn.example.test/a.mp3');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(typeof s.calls[0].lookup, 'function', '探测首跳过了 guard，必须钉');
    const addrs = await resolveVia(s.calls[0].lookup, 'cdn.example.test');
    assert.deepStrictEqual(addrs.map((a) => a.address), [FAKE_PUBLIC]);
  } finally { s.restore(); }
});

test('downloadFile：入口校验通过后，下载连接固定在已校验 IP', async () => {
  const downloader = require('../src/utils/downloader');
  const savePath = path.join(os.tmpdir(), `pin-dl-${Date.now()}.mp3`);
  const s = installStubs(
    { 'dl.example.test': [FAKE_PUBLIC] },
    [{ statusCode: 404, headers: {} }],
  );
  try {
    await assert.rejects(
      () => downloader.downloadFile('http://dl.example.test/s.mp3', savePath),
      /HTTP 404/,
    );
    assert.strictEqual(typeof s.calls[0].lookup, 'function', '过了 SSRF 入口校验就必须钉住');
    const addrs = await resolveVia(s.calls[0].lookup, 'dl.example.test');
    assert.deepStrictEqual(addrs.map((a) => a.address), [FAKE_PUBLIC]);
  } finally { s.restore(); }
});

test('downloadBuffer：SSRF 校验与图片下载连接同源钉 IP', async () => {
  const downloader = require('../src/utils/downloader');
  const s = installStubs(
    { 'cover.example.test': [FAKE_PUBLIC] },
    [{ statusCode: 200, headers: {}, body: 'PNGFAKE' }],
  );
  try {
    const buf = await downloader.downloadBuffer('http://cover.example.test/c.png');
    assert.strictEqual(String(buf), 'PNGFAKE');
    assert.strictEqual(typeof s.calls[0].lookup, 'function');
    const addrs = await resolveVia(s.calls[0].lookup, 'cover.example.test');
    assert.deepStrictEqual(addrs.map((a) => a.address), [FAKE_PUBLIC]);
  } finally { s.restore(); }
});
