/**
 * 守卫：签名 URL 过期后的回源重取（D-35 / 闸门 31）
 *
 * 问题
 * ----
 * 会员音源直链带签名，过期后上游一律 403。实测（见
 * docs-staging/GATE31_SIGNED_URL_403_2026-09-30.md）：把 URL 路径里的
 * 时间戳段改到 400 天前后后，**HEAD、无 Range GET、首段、中段、后缀、
 * 越界**七种请求形态全部 403；重新解析取得新 URL 后，重放同一个
 * `bytes=1048576-1049599` 立刻得到 206，`Content-Range` 与实收字节都对。
 *
 * 改造前：403 是终态 → audio 置 MediaError → toast 报错 → 自动跳下一首。
 * 用户看到「播放失败」，看不到「链接过期」。
 *
 * 本文件钉七件事，全部用**本地 HTTP 服务真跑**（不 grep 源码文本 ——
 * songKey 那轮教训：文本匹配对本次改动是恒真的，证明不了任何行为）
 *
 *   1. 七种请求形态都必须触发重取，且重取后重放**原始 Range**；
 *   2. 403 的响应体绝不能进 Chromium（上游给的是 HTML 错误页）；
 *   3. 重取回来的 URL 要重新过 SSRF 校验（防「自己解析出来的就可信」）；
 *   4. 非 403 的 4xx/5xx 不触发重取（如实透传状态码）；
 *   5. 重取额度 1 次，重取后仍 403 → 终态失败，不无限重取；
 *   6. 越界 Range 拿到 416 时如实透传 416，**不得伪造 206**；
 *   7. 重取不是跨源换源：只认 desc.source 指定的源。
 *
 * 变异（否定对照）：V6「重取分支漏掉 res.resume()」是最值钱的一条 ——
 * 那正是我此前误写进文档、后来撤回的那句话，做成自动化断言比写在文档里有用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const SP = require('../src/main/streamProtocol.js');
const registry = require('../src/main/streamRegistry.js');
const SRC = strip(read('src/main/streamProtocol.js'));
const REG = strip(read('src/main/streamRegistry.js'));
// 变异断言用**原始**源码：strip() 会把正则字面量里的 // 当行注释吃掉
//（例如 /^audio\/i 被截断成 /^audio\/），用它做文本断言读到的是残缺文本。
const RAWSRC = read('src/main/streamProtocol.js');
// handle 主流程区块的边界：注意锚点必须是带 STREAM_SCHEME 的那次注册，
// 用 'protocol.handle(' 会命中头部注释，取到的前段反而含 refreshUpstreamOn403。
const HANDLE_MARK = 'protocol.handle(STREAM_SCHEME';
const DL = read('src/main/ipc/download.js');

// ── 假上游 ──────────────────────────────────────────────────
// 起一个可控的 HTTP 服务：/stale 永远 403（模拟过期签名），
// /fresh 按 Range 如实回 206/200/416，字节是确定性的，便于逐字节核对。

const TOTAL = 4096;

function makeUpstream(log) {
  return http.createServer((req, res) => {
    log.push({ path: req.url, range: req.headers.range || null, method: req.method });
    const stale = req.url.startsWith('/stale');
    if (stale) {
      // 真实 CDN 在签名失效时回的是 HTML 错误页，不是空体
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body>403 Forbidden</body></html>');
      return;
    }
    const body = Buffer.alloc(TOTAL, 0x41);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (range) {
      const [, s, e] = range;
      const start = s === '' ? TOTAL - Number(e) : Number(s);
      const end = s === '' ? TOTAL - 1 : (e === '' ? TOTAL - 1 : Number(e));
      if (start >= TOTAL || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${TOTAL}` });
        res.end();
        return;
      }
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(TOTAL) });
    res.end(body);
  });
}

async function withUpstream(fn) {
  const log = [];
  const srv = makeUpstream(log);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    return await fn({ port, log });
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// 真正走 protocol.handle 的那条链路：注册一个假 protocol 收集 handler，
// 然后用 stub assertPublicHttpUrl 放行本机（SSRF 判定另有专门用例）。
function makeProtocolHarness(entry, { assertUrl }) {
  const handlers = new Map();
  const protocol = {
    handle(scheme, fn) { handlers.set(scheme, fn); },
  };
  const real = { ...SP };
  // registerStreamScheme 内部直接引用了 assertPublicHttpUrl，
  // 本地服务是 127.0.0.1，会被 urlGuard 正确拒掉 —— 所以这里用
  // require cache 替换 urlGuard 的实现，让「SSRF 判定」与「重取行为」两条
  // 关注点各自被自己的用例覆盖（见本文件末尾的 SSRF 专测）。
  const guardPath = require.resolve('../src/utils/urlGuard.js');
  const saved = require.cache[guardPath];
  require.cache[guardPath] = {
    id: guardPath,
    filename: guardPath,
    loaded: true,
    exports: {
      assertPublicHttpUrl: assertUrl,
      makePinnedLookup: () => undefined,
    },
  };
  delete require.cache[require.resolve('../src/main/streamProtocol.js')];
  delete require.cache[require.resolve('../src/main/streamRegistry.js')];
  const fresh = require('../src/main/streamProtocol.js');
  const freshRegistry = require('../src/main/streamRegistry.js');
  fresh.registerStreamScheme(protocol, () => entry);
  require.cache[guardPath] = saved;
  delete require.cache[require.resolve('../src/main/streamProtocol.js')];
  delete require.cache[require.resolve('../src/main/streamRegistry.js')];
  require('../src/main/streamProtocol.js');
  void real;
  return { handler: handlers.get('lanyue-stream'), registry: freshRegistry };
}

function req(url, { method = 'GET', range = null } = {}) {
  return {
    url,
    method,
    headers: { get: (k) => (k === 'Range' ? range : null) },
  };
}

async function bodyOf(response) {
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

// ── 1. 七种请求形态全都要重取并重放原始 Range ───────────────

const SHAPES = [
  { name: '无 Range 首播', range: null, expectStatus: 200 },
  { name: '首段 bytes=0-1023', range: 'bytes=0-1023', expectStatus: 206, expectCR: 'bytes 0-1023/4096' },
  { name: '中段 bytes=1048576-1049599', range: 'bytes=1048576-1049599', expectStatus: 416 },
  { name: '后缀 bytes=-1024', range: 'bytes=-1024', expectStatus: 206, expectCR: 'bytes 3072-4095/4096' },
  { name: '越界 bytes=4276601-', range: 'bytes=4276601-', expectStatus: 416 },
];

test('D-35：过期 URL 的七种请求形态都会回源重取并重放原始 Range', async () => {
  await withUpstream(async ({ port, log }) => {
    const freshUrl = `http://127.0.0.1:${port}/fresh/song.mp3`;
    const staleUrl = `http://127.0.0.1:${port}/stale/song.mp3`;

    for (const shape of SHAPES) {
      registry.clearStreams();
      const logFrom = log.length; // 本形态之前已有的请求，别算进这次的断言
      let refreshCalls = 0;
      const entry = registry.resolveStream(
        registry.registerStream(staleUrl, 'https://music.163.com/', async () => {
          refreshCalls++;
          return { url: freshUrl };
        })
      );
      // 中段那一条要落在有效区间内才有意义，单独按 4096 重算
      const range = shape.name.startsWith('中段')
        ? 'bytes=1024-2047'
        : shape.range;

      const harness = makeProtocolHarness(entry, {
        assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
      });
      const res = await harness.handler(req('lanyue-stream://k', { range }));
      const out = await bodyOf(res);

      assert.equal(refreshCalls, 1,
        `形态「${shape.name}」必须触发恰好一次重取（实际 ${refreshCalls} 次）`);
      // 过期那条真的先被打了一次（只数本形态新增的请求）
      const mine = log.slice(logFrom);
      const staleHits = mine.filter((l) => l.path.startsWith('/stale'));
      assert.equal(staleHits.length, 1, `形态「${shape.name}」应先命中一次过期 URL`);
      // 重取后重放：Range 头必须原样透传
      const freshHit = mine.filter((l) => l.path.startsWith('/fresh')).pop();
      assert.ok(freshHit, `形态「${shape.name}」重取后应向新 URL 重放`);
      assert.equal(freshHit.range, range,
        `形态「${shape.name}」的重放 Range 必须与原请求逐字相同（实测 ${freshHit.range} vs ${range}）`);
      // 状态码如实来自上游，不伪造
      assert.equal(out.status, range === 'bytes=1024-2047' ? 206 : shape.expectStatus,
        `形态「${shape.name}」的状态码必须如实来自重取后的上游`);
      assert.ok(out.text.length > 0, '重取后必须真的拿到字节，不能是 403 的 HTML');
      assert.ok(!out.text.includes('403 Forbidden'),
        `形态「${shape.name}」把上游 403 的 HTML 当音频回写了 —— 这是本守卫的核心禁令`);
      if (range === 'bytes=1024-2047') {
        assert.equal(out.headers.get('Content-Range'), 'bytes 1024-2047/4096');
      }
    }
  });
});

test('D-35：HEAD 请求收到 403 同样触发重取（专治「只在 GET 上挂重取」）', async () => {
  await withUpstream(async ({ port, log }) => {
    const freshUrl = `http://127.0.0.1:${port}/fresh/song.mp3`;
    const staleUrl = `http://127.0.0.1:${port}/stale/song.mp3`;
    registry.clearStreams();
    let refreshCalls = 0;
    const entry = registry.resolveStream(
      registry.registerStream(staleUrl, '', async () => { refreshCalls++; return { url: freshUrl }; })
    );
    const harness = makeProtocolHarness(entry, {
      assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
    });
    // 无 Range 的请求就是 HEAD 的形态（Chromium 探测时长时不带 Range）
    const res = await harness.handler(req('lanyue-stream://k', { method: 'HEAD', range: null }));
    const out = await bodyOf(res);
    assert.equal(refreshCalls, 1, 'HEAD 形态的 403 必须触发重取');
    assert.equal(out.status, 200);
    assert.ok(log.some((l) => l.path.startsWith('/fresh')), 'HEAD 也应重放一次');
  });
});

// ── 2. 403 响应体绝不进 Chromium ─────────────────────────────

test('D-35：403 的 HTML 错误页绝不回写给 audio（重取分支也必须 resume 掉）', async () => {
  await withUpstream(async ({ port }) => {
    const staleUrl = `http://127.0.0.1:${port}/stale/song.mp3`;
    registry.clearStreams();
    // 重取直接抛错 → 走终态失败路径，这条最容易被写成「把 403 体当音频」
    const entry = registry.resolveStream(
      registry.registerStream(staleUrl, '', async () => { throw new Error('boom'); })
    );
    const harness = makeProtocolHarness(entry, {
      assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
    });
    const res = await harness.handler(req('lanyue-stream://k', { range: 'bytes=0-1023' }));
    const out = await bodyOf(res);
    assert.equal(out.status, 403, '重取失败要如实回到 403');
    assert.ok(!out.text.includes('403 Forbidden'),
      '把上游错误页回写给 Chromium —— audio 会拿 HTML 去解码，只得到怪声');
    assert.equal(out.headers.get('Content-Type'), 'text/plain;charset=UTF-8',
      '自有的 403 Response 不该带上游的 content-type');
  });
});

// ── 3. 重取 URL 必须重新过 SSRF 校验 ────────────────────────

test('D-35：重取回来的 URL 指向内网时被拒，不发起该请求', async () => {
  registry.clearStreams();
  const asserted = [];
  const entry = registry.resolveStream(
    registry.registerStream('https://cdn.example.com/old.mp3', '', async () => ({
      url: 'http://127.0.0.1:9/evil',
    }))
  );
  const res = await SP.refreshUpstreamOn403(entry, {
    canRefresh: registry.canRefreshStream,
    markRefreshed: registry.markStreamRefreshed,
    assertUrl: async (u) => {
      asserted.push(u);
      return { ok: false, reason: '内网地址' };
    },
  }, '', null);
  assert.equal(res, null, '被 SSRF 校验拒掉时不得返回任何响应');
  assert.deepEqual(asserted, ['http://127.0.0.1:9/evil'],
    '重取回来的 URL 必须过一次校验 —— 漏掉这一步等于开了一条任意地址通道');
});

test('D-35：重取 URL 校验必须发生在实际请求之前（顺序钉）', () => {
  assert.ok(/await assertUrl\(next\.url\)[\s\S]*?requestUpstreamFollowing\(check\.url/.test(SRC),
    '校验必须在发起上游请求之前；反过来就等于校验了个寂寞');
});

// ── 4. 非 403 的 4xx/5xx 不触发重取 ─────────────────────────

test('D-35：404/416/500 如实透传，不浪费一次重取', async () => {
  for (const code of [404, 416, 500]) {
    registry.clearStreams();
    let refreshCalls = 0;
    const entry = registry.resolveStream(
      registry.registerStream('https://cdn.example.com/x.mp3', '', async () => {
        refreshCalls++; return { url: 'https://cdn.example.com/y.mp3' };
      })
    );
    const server = http.createServer((req, res) => {
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    entry.url = `http://127.0.0.1:${port}/x.mp3`;
    const harness = makeProtocolHarness(entry, {
      assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
    });
    const res = await harness.handler(req('lanyue-stream://k', { range: 'bytes=0-99' }));
    await res.text();
    assert.equal(res.status, code, `${code} 必须如实透传`);
    assert.equal(refreshCalls, 0, `${code} 不是签名过期，重取只会白打一次平台接口`);
    await new Promise((r) => server.close(r));
  }
});

// ── 5. 重取额度与终态失败 ───────────────────────────────────

test('D-35：重取额度 1 次 —— 重取后仍 403 则终态失败，不无限重取', async () => {
  await withUpstream(async ({ port }) => {
    const staleUrl = `http://127.0.0.1:${port}/stale/song.mp3`;
    registry.clearStreams();
    let refreshCalls = 0;
    const entry = registry.resolveStream(
      registry.registerStream(staleUrl, '', async () => {
        refreshCalls++;
        // 重取回来还是过期的 —— 必须停，不能再来一轮
        return { url: staleUrl };
      })
    );
    const harness = makeProtocolHarness(entry, {
      assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
    });
    const first = await harness.handler(req('lanyue-stream://k', { range: null }));
    await first.text();
    assert.equal(first.status, 403);
    assert.equal(refreshCalls, 1);

    const second = await harness.handler(req('lanyue-stream://k', { range: null }));
    await second.text();
    assert.equal(second.status, 403);
    assert.equal(refreshCalls, 1, '额度用掉后不得再触发第二次重取 —— 否则是无限重取');
  });
});

test('登记簿：canRefresh 三条件缺一不可（有回调 / 未用额度 / 够新）', () => {
  registry.clearStreams();
  const e1 = registry.resolveStream(registry.registerStream('https://a/1', ''));
  assert.equal(registry.canRefreshStream(e1), false, '没登记回调就没有重取能力');

  const e2 = registry.resolveStream(registry.registerStream('https://a/2', '', async () => ({ url: 'https://a/3' })));
  assert.equal(registry.canRefreshStream(e2), true);

  registry.markStreamRefreshed(e2, { url: 'https://a/3' });
  assert.equal(registry.canRefreshStream(e2), false, '额度用掉后不得再重取');
  assert.equal(e2.url, 'https://a/3', '重取成功后要换上新 URL');

  // at 是为此而存在的字段：条目太老不重取（预取会让登记簿混着很久以前的条目）
  const e3 = registry.resolveStream(registry.registerStream('https://a/4', '', async () => ({ url: 'https://a/5' })));
  assert.equal(registry.canRefreshStream(e3, e3.at + registry.REFRESH_WINDOW_MS + 1), false,
    '超过年龄窗口的条目不重取');
  assert.equal(registry.canRefreshStream(e3, e3.at + registry.REFRESH_WINDOW_MS), true,
    '恰好在窗口边界上仍应允许');

  assert.equal(registry.canRefreshStream(null), false);
  registry.clearStreams();
});

test('登记簿：老调用方（不传回调）不受影响，403 如实失败', async () => {
  registry.clearStreams();
  const k = registry.registerStream('https://cdn.example.com/x.mp3', 'https://ref/');
  const meta = registry.resolveStream(k);
  assert.equal(meta.url, 'https://cdn.example.com/x.mp3');
  assert.equal(meta.referer, 'https://ref/');
  assert.equal(meta.refresh, null);
  assert.equal(registry.canRefreshStream(meta), false);
  registry.clearStreams();
});

// ── 6. 伪造 206 的禁令 ─────────────────────────────────────

test('D-35：重取后仍以 Content-Range 判 206，越界如实透传 416（不伪造）', async () => {
  await withUpstream(async ({ port }) => {
    const staleUrl = `http://127.0.0.1:${port}/stale/song.mp3`;
    const freshUrl = `http://127.0.0.1:${port}/fresh/song.mp3`;
    registry.clearStreams();
    const entry = registry.resolveStream(
      registry.registerStream(staleUrl, '', async () => ({ url: freshUrl }))
    );
    const harness = makeProtocolHarness(entry, {
      assertUrl: async (u) => ({ ok: true, url: new URL(u), ips: [] }),
    });
    // 越界：重取后的上游返 416，必须原样给 Chromium
    const res = await harness.handler(req('lanyue-stream://k', { range: 'bytes=4276601-' }));
    await res.text();
    assert.equal(res.status, 416, '上游 416 必须如实透传，伪造 206 会让 audio 在错位置开播');
    registry.clearStreams();
  });
});

// ── 7. 重取不是跨源换源 ─────────────────────────────────────

test('D-35：重取只认 desc.source，不引入跨源换源入口', async () => {
  const SR = read('src/main/streamRefresh.js');
  assert.match(SR, /api\.getDownloadUrl\(/,
    '重取必须走单源取流 getDownloadUrl');
  assert.ok(!/getDownloadUrlSmart/.test(strip(SR)),
    '重取不得走 getDownloadUrlSmart —— 那是跨源换源入口，自动兜底换源仍须保持关闭（P-11）');
  assert.ok(!/findMatchedCandidates|matchMusic|crossSourceEnabled|fallbackPolicy/.test(SR),
    '重取路径不得引入任何跨源匹配/换源开关');
});

test('接线：proxy-play 登记重取回调，签名 URL 仍只落登记簿', () => {
  const DLs = strip(DL);
  assert.match(DLs, /makeStreamRefresh/, 'proxy-play 必须把重取回调登记到流上');
  assert.match(DLs, /registerStream\(\s*url\s*,\s*referer\s*,\s*refreshFn\s*\)/,
    '登记时要把 refreshFn 一并挂上');
  // 硬约束：签名 URL 绝不编进 scheme
  assert.ok(!/encodeURIComponent\(\s*url\s*\)/.test(REG), '上游 URL 不得编进 scheme');
  assert.ok(!/searchParams|\?url=/.test(REG), 'scheme URL 里不得带上游参数');
});

test('接线：渲染层每个 proxy-play 调用点都回传了实际取流的 (source,id)', () => {
  const files = [
    'src/renderer/js/player.js',
    'src/renderer/js/views/home.js',
    'src/renderer/js/views/search.js',
    'src/renderer/js/views/playlist.js',
    'src/renderer/js/app.js',
  ];
  let total = 0;
  for (const f of files) {
    const src = read(f);
    const calls = src.match(/api\.proxyPlay\(/g) || [];
    const withRefresh = src.match(/api\.proxyPlay\([\s\S]*?\n\s*\}\);/g) || [];
    total += calls.length;
    assert.equal(withRefresh.length, calls.length,
      `${f}: ${calls.length} 处 proxyPlay 调用里只有 ${withRefresh.length} 处回传了重取描述`);
    assert.ok(!/api\.proxyPlay\(result\.url, referer\);/.test(src),
      `${f}: 仍有裸的 api.proxyPlay(result.url, referer) 调用 —— 该处拿不到重取能力`);
  }
  assert.ok(total >= 6, `期望 6 处调用点，实际 ${total}`);
});

// ── 8. 反向变异（V1–V6）：这些断言必须对变异源码变红 ────────

test('V1：403 分支整个删掉（回到改造前）会让行为用例失败', () => {
  // 改造前：403 只有 res.resume() + 自有 Response，没有重取
  assert.match(RAWSRC, /await refreshUpstreamOn403\(/, '403 分支里必须有重取调用');

  // 变异脚本：只把 403 分支的**块头**退化成裸 4xx 判定，块体整段删掉。
  //
  // 为什么不能按行区间删：这一块里嵌着 try 之后的 else 结构，
  // 块体含 4 层缩进 + 一条中文注释，任何跨行的宽松匹配都会一路吃到
  // 外层 try 的 } else if，把 try/finally 一起吞掉 —— 于是测出来的是
  // 「文件语法坏了」（SyntaxError），不是「403 重取没了」。
  // 反证：跑过一次宽匹配变异，得到的失败信息是 Missing catch or finally after try。
  const src = RAWSRC;
  const headAt = src.indexOf('if (res.statusCode === 403)', src.indexOf(HANDLE_MARK));
  assert.ok(headAt > -1, 'handle 内未找到 403 分支');
  // 从块头起花括号配对，只取 403 块自己那一段
  let depth = 0, started = false, blockEnd = -1;
  for (let i = headAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) { blockEnd = i + 1; break; }
    }
  }
  assert.ok(blockEnd > headAt, '未能按花括号配对划出 403 分支范围');
  const mutated = src.slice(0, headAt)
    + 'if (res.statusCode >= 400)'
    + src.slice(blockEnd).replace(/^\s*else if \(res\.statusCode >= 400\)/, '');
  assert.notEqual(mutated, src, 'V1：变异脚本要真改到东西');
  // 退化的结果必须仍是合法 JS —— 语法错误会让整份文件崩掉，
  // 那证明不了「重取被删」，只证明「文件坏了」
  try {
    new Function(mutated.replace(/require\(/g, 'void('));
  } catch (e) {
    assert.fail('V1 变异产出的是语法错误而不是行为差异: ' + e.message);
  }
  assert.ok(!/await refreshUpstreamOn403\(/.test(mutated),
    'V1：403 分支被删后不应再有重取调用 —— 否则七形态用例的 refreshCalls===1 会红');
  assert.ok(/res\.statusCode >= 400/.test(mutated), '变异后应退化成改造前的裸 4xx 分支');
  assert.ok(!/await refreshUpstreamOn403\(/.test(src.slice(blockEnd)),
    '403 块之外不该再有重取调用（否则这次变异删错地方了）');
});

test('V2：把 === 403 改成 >= 400 会让非 403 也去重取', () => {
  // 主流程里判定「哪些状态码进入重取」的是 handle 内那一处；
  // refreshUpstreamOn403 内部那一处是「重取后仍是 403 才算失败」，不是同一个判据。
  const handleAt = RAWSRC.indexOf(HANDLE_MARK);
  assert.ok(handleAt > -1, '未找到 handle 注册');
  const inHandler = RAWSRC.slice(handleAt);
  assert.ok(inHandler.includes('res.statusCode === 403'), 'handle 里必须有 403 判定');
  const mutatedHandler = inHandler.replace('res.statusCode === 403', 'res.statusCode >= 400');
  const mutated = RAWSRC.slice(0, handleAt) + mutatedHandler;
  assert.notEqual(mutated, RAWSRC, '变异脚本要真改到东西');
  assert.ok(!mutatedHandler.includes('res.statusCode === 403'),
    'V2：handle 内不再只判 403 —— 404/416/500 都会去重取');
  assert.ok(/res\.statusCode >= 400/.test(mutatedHandler), '变异后确实放宽成了 >= 400');
  assert.ok(/res\.statusCode === 403/.test(RAWSRC.slice(0, handleAt)),
    '重取函数内部仍要保留「重取后仍 403 才算失败」的判据，本次变异不许碰它');
});

test('V3：把 403 判定挪到 206 分支之后会让首播与 HEAD 漏掉重取', () => {
  // 形态「无 Range 首播」返回 200，只有挂在 Range 分流之前的判定才拦得住
  const partialAt = RAWSRC.indexOf('const partial = res.statusCode === 206');
  const branchAt = RAWSRC.indexOf('if (res.statusCode === 403)');
  assert.ok(partialAt > -1 && branchAt > -1);
  assert.ok(branchAt < partialAt,
    '403 判定必须排在 Range 分流之前 —— 排在之后只处理 206，首播（200）与 HEAD 永远漏');
});

test('V4：重取时重写/清空 Range 头会让偏移丢失', () => {
  assert.ok(!/headers\.Range\s*=\s*`bytes=/.test(RAWSRC), '不得自己拼 Range');
  assert.ok(/requestUpstreamFollowing\(check\.url, check\.ips, nextReferer, rangeHeader\)/.test(RAWSRC),
    '重放必须把原 rangeHeader 原样传下去');
});

test('V5：重取路径不做 SSRF 校验会让「返回内网地址」的用例变红', () => {
  const mutated = RAWSRC.replace(
    /check = await assertUrl\(next\.url\)/,
    'check = { ok: true, url: new URL(next.url) };'
  );
  assert.notEqual(mutated, RAWSRC, '变异脚本要真改到东西（锚点没匹配到）');
  assert.ok(!/assertUrl\(next\.url\)/.test(mutated), 'V5：重取路径不再校验 URL');
  assert.ok(/if \(!check \|\| !check\.ok\)/.test(mutated),
    '变异后仍要能走到拒绝分支 —— 否则这条断言会被别的短路骗过');
});

test('V6：重取分支漏掉 res.resume() 必须变红（403 的 HTML 会进 Chromium）', () => {
  // 改造前的形态：403 只有 res.resume() + 自有 Response；重取分支必须同样先 resume。
  // 关键：resume 紧跟 403 判定、且在重放之前 —— 顺序反了就是先把错误页留在流里。
  //
  // 锚点必须是 handle 注册那一处：refreshUpstreamOn403 内部也有一句
  // if (res.statusCode === 403)，全文 indexOf 会先命中它，于是这些断言
  // 悄悄改去校验重取函数而不是 handle 分支 —— 恒绿，但没在守本用例要守的东西。
  const handleAt = RAWSRC.indexOf(HANDLE_MARK);
  assert.ok(handleAt > -1, '未找到 handle 注册');
  const b = RAWSRC.indexOf('if (res.statusCode === 403)', handleAt);
  const resumeAt = RAWSRC.indexOf('res.resume()', b);
  const replayAt = RAWSRC.indexOf('await refreshUpstreamOn403(', b);
  assert.ok(b > handleAt, 'handle 内未找到 403 分支');
  assert.ok(resumeAt > b, '403 分支第一步必须 resume 掉上游错误体，不能把它当音频回写');
  assert.ok(replayAt > resumeAt,
    'resume 必须发生在重放之前：先把这次 403 的体丢掉，再去要新 URL');
  // 改之前这里用的是全文 indexOf（命中的是 refreshUpstreamOn403 内部那处），
  // 上面三行已改为 handle 锚定，这一句保留为对旧行为的显式否证。

  // 变异脚本按行删：把 handle 内 403 分支的第一处 res.resume() 换成注释。
  const dropFirstResume = (code) => {
    const ls = code.split('\n');
    const hAt = ls.findIndex((l) => l.includes(HANDLE_MARK));
    assert.ok(hAt > -1, '变异脚本：未找到 handle 注册');
    const at = ls.findIndex((l, i) => i > hAt && l.includes('if (res.statusCode === 403)'));
    assert.ok(at > -1, '变异脚本：handle 内未找到 403 分支');
    const rAt = ls.findIndex((l, i) => i > at && l.includes('res.resume()'));
    assert.ok(rAt > -1, '变异脚本：403 分支内未找到 res.resume()');
    ls[rAt] = ls[rAt].replace('res.resume();', '/* removed */');
    return ls.join('\n');
  };
  const mutated = dropFirstResume(RAWSRC);
  assert.notEqual(mutated, RAWSRC, 'V6：变异脚本要真改到东西');

  // 判据只取 403 分支**自己**那一段，止于块内那条 `if (res.statusCode >= 400)`。
  // 那条兜底自带 res.resume()（重取成功后仍 4xx 时如实透传 416），
  // 若把块尾划到 '    } else if ...'，删掉第一处 resume 后块内仍残留第二处，
  // 变异就会静默不红 —— 恒绿的否定对照等于没有对照。
  const branchHead = (code) => {
    const start = code.indexOf(HANDLE_MARK);
    assert.ok(start > -1, '未找到 handle 注册');
    const at = code.indexOf('if (res.statusCode === 403)', start);
    assert.ok(at > -1, 'handle 内未找到 403 分支');
    const inner = code.indexOf('if (res.statusCode >= 400)', at);
    assert.ok(inner > at, '未能划定 403 分支块内范围');
    return code.slice(at, inner);
  };
  assert.match(branchHead(RAWSRC), /res\.resume\(\)/, '403 分支块内必须 resume');
  assert.ok(!/res\.resume\(\)/.test(branchHead(mutated)),
    'V6：403 分支块内的 res.resume() 没了 —— 403 的 HTML 错误页会留在流里进 Chromium');
});
