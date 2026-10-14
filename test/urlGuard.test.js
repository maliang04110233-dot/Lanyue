/**
 * urlGuard SSRF 防护测试
 *
 * 覆盖：
 *   - 协议白名单（http/https 之外全拒）
 *   - userinfo 拒绝
 *   - 字面量内网 IPv4/IPv6（RFC1918/loopback/link-local/ULA/multicast/TEST-NET）
 *   - IP 编码绕过：十进制(2130706433)、十六进制(0x7f.0.0.1)、八进制(0177.0.0.1)、IPv4-mapped(::ffff:127.0.0.1)
 *   - 公网字面量 IP 放行
 *   - 公网域名放行（DNS 解析，无网络环境下跳过）
 */

const test = require('node:test');
const assert = require('node:assert');
const { _internal, assertPublicHttpUrl, resolveHostSafe } = require('../src/utils/urlGuard');

const { normalizeHost, isPrivateIPv4, isPrivateIPv6 } = _internal;

// ── normalizeHost：IP 编码归一化 ────────────────────────
test('normalizeHost: 十进制 IP 2130706433 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('2130706433'), '127.0.0.1');
});

test('normalizeHost: 十六进制 IP 0x7f.0.0.1 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('0x7f.0.0.1'), '127.0.0.1');
});

test('normalizeHost: 八进制 IP 0177.0.0.1 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('0177.0.0.1'), '127.0.0.1');
});

test('normalizeHost: 混合编码 0x7f.1 → 不归一（非法段数），原样返回', () => {
  // 0x7f.1 只有 2 段，不是点分四段，按域名处理（后续 DNS 解析会失败/拒绝）
  assert.strictEqual(normalizeHost('0x7f.1'), '0x7f.1');
});

test('normalizeHost: IPv6 字面量去方括号', () => {
  assert.strictEqual(normalizeHost('[::1]'), '::1');
  assert.strictEqual(normalizeHost('[::ffff:127.0.0.1]'), '::ffff:127.0.0.1');
});

// ── isPrivateIPv4 ───────────────────────────────────────
test('isPrivateIPv4: RFC1918 三段 + loopback + link-local 全判定内网', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '255.255.255.255']) {
    assert.strictEqual(isPrivateIPv4(ip), true, `${ip} 应判定为内网`);
  }
});

test('isPrivateIPv4: 172.32.x 和 172.15.x 不是内网（边界外）', () => {
  assert.strictEqual(isPrivateIPv4('172.32.0.1'), false);
  assert.strictEqual(isPrivateIPv4('172.15.0.1'), false);
});

test('isPrivateIPv4: 公网 IP 放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '203.107.1.1']) {
    assert.strictEqual(isPrivateIPv4(ip), false, `${ip} 应判定为公网`);
  }
});

// ── isPrivateIPv6 ───────────────────────────────────────
test('isPrivateIPv6: loopback/link-local/ULA/multicast/IPv4-mapped 全判定内网', () => {
  assert.strictEqual(isPrivateIPv6('::1'), true);
  assert.strictEqual(isPrivateIPv6('::'), true);
  assert.strictEqual(isPrivateIPv6('fe80::1'), true);
  assert.strictEqual(isPrivateIPv6('fc00::1'), true);
  assert.strictEqual(isPrivateIPv6('fd12:3456::1'), true);
  assert.strictEqual(isPrivateIPv6('ff02::1'), true);
  assert.strictEqual(isPrivateIPv6('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateIPv6('::ffff:192.168.1.1'), true);
});

test('isPrivateIPv6: 公网 IPv6 放行', () => {
  assert.strictEqual(isPrivateIPv6('2606:4700:4700::1111'), false);
  assert.strictEqual(isPrivateIPv6('2001:4860:4860::8888'), false);
});

// ── resolveHostSafe（字面量 IP 路径，无 DNS 依赖）───────
test('resolveHostSafe: 字面量内网 IP 拒绝（含编码形式）', async () => {
  for (const h of ['127.0.0.1', '10.0.0.5', '192.168.0.1', '172.20.1.1', '[::1]', '::ffff:10.0.0.1']) {
    const r = await resolveHostSafe(h);
    assert.strictEqual(r.ok, false, `${h} 应被拒绝`);
  }
});

test('resolveHostSafe: 编码 IP 经归一化后拒绝（十进制/十六进制/八进制）', async () => {
  // Node URL 会把这些保留在 hostname；urlGuard 先归一化再判定
  for (const h of ['2130706433', '0x7f.0.0.1', '0177.0.0.1']) {
    const r = await resolveHostSafe(h);
    assert.strictEqual(r.ok, false, `${h}（编码的 127.0.0.1）应被拒绝`);
  }
});

test('resolveHostSafe: 公网字面量 IP 放行并返回 IP 列表', async () => {
  const r = await resolveHostSafe('8.8.8.8');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ips, ['8.8.8.8']);
});

// ── assertPublicHttpUrl ────────────────────────────────
test('assertPublicHttpUrl: 拒绝非 http(s) 协议', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,x', 'gopher://127.0.0.1:6379/_INFO']) {
    const r = await assertPublicHttpUrl(url);
    assert.strictEqual(r.ok, false, `${url} 应被拒绝`);
  }
});

test('assertPublicHttpUrl: 拒绝携带 userinfo 的 URL', async () => {
  const r = await assertPublicHttpUrl('http://user:pass@8.8.8.8/');
  assert.strictEqual(r.ok, false);
});

test('assertPublicHttpUrl: 拒绝编码内网 IP 的 http URL', async () => {
  for (const url of [
    'http://127.0.0.1:8500/admin',
    'http://2130706433:8500/admin',
    'http://0x7f.0.0.1/x',
    'http://0177.0.0.1/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://169.254.169.254/latest/meta-data/',  // 云元数据端点
    'http://192.168.1.1/router',
  ]) {
    const r = await assertPublicHttpUrl(url);
    assert.strictEqual(r.ok, false, `${url} 应被拒绝`);
  }
});

// 域名路径要过 dns.promises.lookup —— 真解析让这条用例变成 CI 里的抖动源
// （全量并发跑时出现过 DNS 超时而红，单独跑又绿）。守卫换成桩：判定逻辑一行没变，
// 但「公网放行」与「DNS 挂了要拒绝」两个分支从此确定性可复现。
const dns = require('node:dns');

function withStubLookup(impl, body) {
  const original = dns.promises.lookup;
  dns.promises.lookup = impl;
  return body().finally(() => { dns.promises.lookup = original; });
}

test('assertPublicHttpUrl: 公网 URL 放行（域名→公网 IP，桩掉 DNS）', async () => {
  await withStubLookup(
    async () => [{ address: '115.124.15.30', family: 4 }],
    async () => {
      const r = await assertPublicHttpUrl('https://music.163.com/song/media/outer/url?id=1.mp3');
      assert.strictEqual(r.ok, true);
      assert.ok(r.url instanceof URL);
      assert.deepStrictEqual(r.ips, ['115.124.15.30']);
    }
  );
});

test('assertPublicHttpUrl: 域名解析到内网 → 拒绝（SSRF 走 DNS  rebinding 的那一侧）', async () => {
  await withStubLookup(
    async () => [{ address: '10.0.0.8', family: 4 }],
    async () => {
      const r = await assertPublicHttpUrl('https://evil.example.com/x');
      assert.strictEqual(r.ok, false);
      assert.match(String(r.reason), /内网|private|10\.0\.0\.8/);
    }
  );
});

test('assertPublicHttpUrl: DNS 解析失败 → 拒绝而不是放行', async () => {
  await withStubLookup(
    async () => { const e = new Error('queryA ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; },
    async () => {
      const r = await assertPublicHttpUrl('https://does-not-exist.example/x');
      assert.strictEqual(r.ok, false);
      assert.match(String(r.reason), /DNS 解析失败/);
    }
  );
});

// ── DNS 路径（依赖网络；离线环境跳过）─────────────────
test('resolveHostSafe: localhost 解析到内网 → 拒绝', { skip: false }, async () => {
  const r = await resolveHostSafe('localhost');
  // 即使 DNS 把 localhost 解析为 ::1/127.0.0.1，也必须拒绝
  assert.strictEqual(r.ok, false);
});

// ── makePinnedLookup ───────────────────────────────────
test('makePinnedLookup: 返回固定的已校验 IP（防 rebinding）', async () => {
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const lookup = makePinnedLookup(['8.8.8.8']);
  await new Promise((resolve) => {
    lookup('example.com', { all: false }, (err, address, family) => {
      assert.strictEqual(err, null);
      assert.strictEqual(address, '8.8.8.8'); // 无论此刻 DNS 解析出什么，连接都用校验过的 IP
      assert.strictEqual(family, 4);
      resolve();
    });
  });
});

// 回归守卫：Node 20+ 的 net 在 autoSelectFamily（Happy Eyeballs）路径下用
// { all: true } 调用 lookup 并期望数组回调。旧实现只支持单值形态，导致
// Node 24（Electron 44）连接阶段抛 ERR_INVALID_IP_ADDRESS: undefined。
test('makePinnedLookup: 支持 net 的 all:true 数组形态（Node 20+ 回归守卫）', async () => {
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const lookup = makePinnedLookup(['8.8.8.8', '2001:4860:4860::8888']);
  const list = await new Promise((resolve, reject) => {
    lookup('example.com', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
  assert.ok(Array.isArray(list), 'all:true 必须回数组，否则 Node 24 抛 ERR_INVALID_IP_ADDRESS');
  assert.strictEqual(list.length, 2);
  assert.ok(list.every((e) => typeof e.address === 'string' && (e.family === 4 || e.family === 6)));
  assert.strictEqual(list[0].family, 4, 'IPv4 必须排前（IPv6 不可达时避免首连超时）');
});

test('makePinnedLookup: 非法 IP 被过滤，全部非法时退回系统解析', async () => {
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const lookup = makePinnedLookup(['not-an-ip', undefined, '']);
  const list = await new Promise((resolve, reject) => {
    lookup('localhost', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
  assert.ok(Array.isArray(list) && list.length > 0, '退回 dns.lookup 后仍须回数组');
});

test('makePinnedLookup: all:true 下 family 过滤，过滤为空则退回全部', async () => {
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const only6 = makePinnedLookup(['2001:4860:4860::8888']);
  const r = await new Promise((resolve, reject) => {
    only6('example.com', { all: true, family: 4 }, (err, a) => (err ? reject(err) : resolve(a)));
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].family, 6, '没有 IPv4 时不能回空数组');
});

// 端到端形态验证：真实走一次 net 的连接路径（修复前此项必失败）
test('makePinnedLookup: 端到端真实 HTTP 连接可用', async () => {
  const http = require('http');
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: 'localhost',
        port,
        path: '/',
        lookup: makePinnedLookup(['127.0.0.1']),
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
    assert.strictEqual(body, 'ok');
  } finally {
    server.close();
  }
});

// ── 批④ M6：fe80::/10 全段拦截 ──────────────────────────────
test('isPrivateIPv6: fe81-fe8f 属链路本地 fe80::/10 必须拦截（此前仅精确匹配 fe80: 前缀）', () => {
  for (const ip of ['fe80::1', 'fe81::1', 'fe8f::abcd', 'fe90::1', 'febf::1']) {
    assert.strictEqual(isPrivateIPv6(ip), true, `${ip} 属 fe80::/10 应按内网拒绝`);
  }
});
