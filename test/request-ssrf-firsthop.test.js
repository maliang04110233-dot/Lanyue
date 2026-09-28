/**
 * 首跳 SSRF 闸口回归测试（2026-09 审计 P1-6）
 *
 * 缺口长什么样：request() 调 _followRedirects 时第四参 pinnedIps 缺省 null，
 * 而 assertPublicHttpUrl 只在 3xx 分支里跑 —— 第 0 跳（调用方给的原始 URL）
 * 整个裸奔。源码里那句「每一跳都过 urlGuard」对首跳是假的，而同文件的
 * _probeAudio 恰恰对首跳做了 guard + IP 固定，两条路径口径不一致。
 *
 * 为什么这件事值得补测试：全仓 13 个调用点的 URL 都是硬编码平台域名，所以
 * 当时不可利用；但任何新增适配器（拼 HLS 分片 URL、封面代理 URL）都会原样
 * 继承这个缺口。测试要钉的是「入口 URL 不可信」这个前提本身，而不是当前
 * 恰好没人传内网 URL。
 *
 * 本文件全部打桩（http.request + dns.promises.lookup），无真实网络、无环回依赖。
 * 关键手法是让入口解析到**假公网 IP** 放行、只拦第二跳 —— 真实 local server
 * 造不出这个形态（要么入口就被拦，要么整链 skipSsrf 旁路）。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const request = require('../src/api/request');

/** 真公网形态的假 IP（urlGuard 只拦保留段；这两个不是） */
const FAKE_PUBLIC = '93.184.216.34';
/** 云元数据端点：169.254.0.0/16 链路本地，urlGuard 必拒 */
const META_IP = '169.254.169.254';

/**
 * 安装 http.request / dns.promises.lookup 桩。
 * @param {Object} records 域名 → IP 数组（urlGuard 看到的 DNS 视图）
 * @param {Array} script 依次序返回的假响应
 * @returns {{calls, lookupCalls, restore}}
 */
function installStubs(records = {}, script = []) {
  const origRequest = http.request;
  const origLookup = dns.promises.lookup;
  const calls = [];
  const lookupCalls = [];

  dns.promises.lookup = (hostname, opts, cb) => {
    lookupCalls.push(hostname);
    const ips = records[hostname];
    const p = !ips
      ? Promise.reject(Object.assign(new Error('ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }))
      : Promise.resolve(
        (opts && opts.all)
          ? ips.map((ip) => ({ address: ip, family: net.isIP(ip) }))
          : { address: ips[0], family: net.isIP(ips[0]) },
      );
    if (typeof cb === 'function') { p.then((v) => cb(null, v), (e) => cb(e)); return undefined; }
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
    lookupCalls,
    restore: () => { http.request = origRequest; dns.promises.lookup = origLookup; },
  };
}

/** 取出 pinned lookup 的解析结果（all 形态） */
function resolveVia(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

// ── 首跳：内网/元数据地址必须在**连接之前**就被拦下 ────────────

test('首跳: 环回与元数据地址被拦下，且 http.request 一次都没被调用', async () => {
  // 修复前这一整组都会真的发出请求（本地 server 甚至能回 200）
  for (const url of [
    'http://127.0.0.1:9/secret',            // 环回
    'http://169.254.169.254/latest/meta-data/', // 云元数据
    'http://10.0.0.5/internal',            // RFC1918
    'http://192.168.1.1/router',            // RFC1918
    'http://2130706433/x',                  // 十进制编码的 127.0.0.1
    'http://[::1]/x',                       // IPv6 环回
  ]) {
    const s = installStubs();
    try {
      await assert.rejects(() => request(url, { retries: 0, timeout: 2000 }), /ssrf-blocked/,
        `${url} 应被首跳闸口拒绝`);
      assert.strictEqual(s.calls.length, 0,
        `${url} 被拦时不得真的建立连接（闸口在连接之前）`);
    } finally { s.restore(); }
  }
});

test('首跳: 闸口拦下的错误不进重试通道（retries=5 也只判一次）', async () => {
  const s = installStubs({ 'blocked.example.test': [META_IP] });
  try {
    await assert.rejects(
      () => request('http://blocked.example.test/latest/meta-data/', { retries: 5, retryDelay: 1 }),
      /ssrf-blocked/,
    );
    // 只解析一次 ⇒ 闸口只跑了一次。若这条退化成"重试也拦"，lookupCalls 会是 6。
    assert.strictEqual(s.lookupCalls.length, 1,
      `被拦的 URL 不该重试，实际校验 ${s.lookupCalls.length} 次`);
    assert.strictEqual(s.calls.length, 0, '被拦的 URL 不该发出任何请求');
  } finally { s.restore(); }
});

// ── 重定向跳：闸口没有因为首跳下沉而失效 ───────────────────────

test('重定向跳: 入口放行、第二跳指向内网 ⇒ 第二跳的连接压根没发出去', async () => {
  const s = installStubs(
    { 'api.example.test': [FAKE_PUBLIC], 'intranet.example.test': [META_IP] },
    [{ statusCode: 302, headers: { location: 'http://intranet.example.test/x' } }],
  );
  try {
    await assert.rejects(
      () => request('http://api.example.test/s', { retries: 0 }),
      /ssrf-blocked redirect/,
    );
    // 只有入口那一跳真的连了：第二跳在 guard 就被挡回去
    assert.strictEqual(s.calls.length, 1, '被拦的第二跳不应发出请求');
    assert.strictEqual(s.calls[0].hostname, 'api.example.test');
  } finally { s.restore(); }
});

test('首跳: 过闸口后校验与连接同源（IP 钉住，DNS 只解析一次）', async () => {
  const s = installStubs(
    { 'cdn.example.test': [FAKE_PUBLIC] },
    [{ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }],
  );
  try {
    const out = await request('http://cdn.example.test/s');
    assert.deepStrictEqual(out, { ok: 1 });
    assert.strictEqual(s.lookupCalls.length, 1, '校验一次；连接阶段应复用校验结果而不是再解析');
    assert.strictEqual(typeof s.calls[0].lookup, 'function', '首跳过了闸口就必须钉 IP（rebinding 闭合）');
    const pinned = await resolveVia(s.calls[0].lookup, 'cdn.example.test');
    assert.deepStrictEqual(pinned.map((a) => a.address), [FAKE_PUBLIC]);
    assert.strictEqual(s.calls[0].hostname, 'cdn.example.test', 'Host 侧仍是原域名');
  } finally { s.restore(); }
});

test('公网首跳正常放行（闸口不许退化成"一律拒绝"）', async () => {
  const s = installStubs(
    { 'music.example.test': [FAKE_PUBLIC] },
    [{ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }],
  );
  try {
    assert.deepStrictEqual(await request('http://music.example.test/s'), { ok: true });
    assert.strictEqual(s.calls.length, 1);
  } finally { s.restore(); }
});

test('skipSsrf 仍旁路闸口且不钉 IP（既有测试通道语义不变）', async () => {
  const s = installStubs(
    {},
    [{ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"reached":true}' }],
  );
  try {
    assert.deepStrictEqual(
      await request('http://127.0.0.1:9/ok', { skipSsrf: true, retries: 0 }),
      { reached: true },
    );
    assert.strictEqual(s.calls[0].lookup, undefined, '旁路时不应钉 IP（维持原解析路径）');
  } finally { s.restore(); }
});

test('非法 URL 仍报 invalid url（闸口没有把解析错误吞成 ssrf-blocked）', async () => {
  const s = installStubs();
  try {
    const err = await request('not-a-url', { retries: 0 }).then(() => null, (e) => e);
    assert.ok(err, '非法 URL 必须抛错');
    assert.match(err.message, /invalid url/);
    assert.doesNotMatch(err.message, /ssrf-blocked/, 'URL 解析失败不是 SSRF 拦截，语义别混');
    assert.strictEqual(s.calls.length, 0);
  } finally { s.restore(); }
});

test('拦截消息只带 origin，不带查询串（平台 API 把鉴权态塞在 GET 参数里）', async () => {
  const s = installStubs(
    { 'api.example.test': [FAKE_PUBLIC], 'evil.example.test': [META_IP] },
    [{ statusCode: 302, headers: { location: 'http://evil.example.test/x' } }],
  );
  try {
    const err = await request('http://api.example.test/s?authst=SECRET_A&data=SECRET_B', { retries: 0 })
      .then(() => null, (e) => e);
    assert.ok(err, '重定向到内网必须抛错');
    assert.match(err.message, /ssrf-blocked/);
    assert.ok(!err.message.includes('SECRET_A') && !err.message.includes('SECRET_B'),
      '错误消息不得抄送鉴权态: ' + err.message);
  } finally { s.restore(); }
});

// ── 接线钉：闸口必须只有一处，且落在每一跳的必经之路上 ──────────
//
// 行为测试已经钉住"首跳被拦"；这组字符串钉补的是"判据只有一处"——
// 有人把 assertPublicHttpUrl 又抄回 3xx 分支时（两套口径，正是 P1-6 的成因），
// 下面两条会变红。

test('request.js: SSRF 闸口只有一处（在 _guardHop 里），重定向分支不自带判据', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/api/request.js'), 'utf8');
  const start = src.indexOf('function _sendHop');
  const end = src.indexOf('function _followRedirects');
  assert.ok(start > 0 && end > start, '源码形状变了：_sendHop / _followRedirects 找不到');
  const sendHopBody = src.slice(start, end);
  assert.ok(!sendHopBody.includes('assertPublicHttpUrl'),
    '重定向分支不得自带 SSRF 判据 —— 下一跳的闸口在 _followRedirects 入口统一跑');
  assert.ok(!sendHopBody.includes('proceed('),
    '旧的 proceed(ips) 双闸结构应已删除');
  assert.match(src, /function _followRedirects\(url, options, redirectCount = 0\)/,
    '首跳与重定向跳必须共用同一个入口函数（不再有第四参 pinnedIps 旁路）');
  assert.match(src, /if \(err\.ssrfBlocked\) return false;/,
    'SSRF 拦截不得落进重试通道');
});
