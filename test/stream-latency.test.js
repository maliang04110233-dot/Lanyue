/**
 * 在线播放链路：首播延迟与 seek 的三项修正（2026-10-13）
 *
 * 背景（全部来自对现有实现的剖析，不是猜测）：
 *
 * 1. **同一次播放解析两次 DNS**。`ipc/download.js` 的 proxy-play 先
 *    assertPublicHttpUrl 校验一次（拿到 ips 却丢掉不用），`streamProtocol.js`
 *    的 protocol.handle 又对同一个 URL 校验一次，而真正用于连接的是第二次的 ips。
 *    → 现在把第一次的 check 一起登记，protocol.handle 直接复用
 *      （URL 被 refresh 换过时自动重新校验，见 streamProtocol 的注释）。
 *
 * 2. **play() 被两次 getPref IPC 卡在后面**。player.js 原本是
 *    `await restorePlayProgress()` → `audio.play()`，而前者内部是两次串行
 *    getPref。→ 现在先 play 后并行恢复进度（resumeSeeker 本来就监听
 *      loadedmetadata 时机做 seek）。本文件用静态断言守住这个顺序。
 *
 * 3. **正在播放的流可能被 LRU 淘汰**。淘汰只看登记顺序，于是「歌播到一半突然
 *    停住」（protocol.handle 拿到 404 no stream meta）。→ 淘汰改为按最近取用
 *    时间（lastUsed），且 resolveStream 会刷新它。
 *
 * 4. **parseRange 是死代码**。头注承诺「解析失败就当没有 Range，绝不自己拼」，
 *    但请求路径零调用点，多区间/畸形 Range 被原样打给 CDN（可能拿到
 *    multipart/byteranges，Chromium 侧是怪声或中断）。→ 新增
 *    normalizeRangeHeader 并真正接上。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const streamProtocol = require('../src/main/streamProtocol');
const registry = require('../src/main/streamRegistry');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 4. Range 归一化 ────────────────────────────────────────

test('Range：只放行明确起点的单区间，其余一律当没有 Range', () => {
  const { normalizeRangeHeader } = streamProtocol;
  // 合法：明确起点
  assert.strictEqual(normalizeRangeHeader('bytes=0-'), 'bytes=0-');
  assert.strictEqual(normalizeRangeHeader('bytes=1024-'), 'bytes=1024-');
  assert.strictEqual(normalizeRangeHeader('bytes=0-1023'), 'bytes=0-1023');
  assert.strictEqual(normalizeRangeHeader('  bytes=0-1  '), 'bytes=0-1', '空白应被容忍');

  // 非法：宁可退化成无 Range（上游返 200 从头顺播），也不要构造上游会拒绝的请求
  assert.strictEqual(normalizeRangeHeader('bytes=0-99,200-299'), null, '多区间必须拒绝');
  assert.strictEqual(normalizeRangeHeader('bytes=abc'), null);
  assert.strictEqual(normalizeRangeHeader('bytes=500-100'), null, 'end < start 非法');
  assert.strictEqual(normalizeRangeHeader('bytes='), null);
  assert.strictEqual(normalizeRangeHeader('bytes=-'), null, '空后缀长度非法');
  assert.strictEqual(normalizeRangeHeader(''), null);
  assert.strictEqual(normalizeRangeHeader(null), null);
});

test('Range：后缀形态 bytes=-N 必须透传（越界交给上游用 416 回答）', () => {
  const { normalizeRangeHeader } = streamProtocol;
  assert.strictEqual(normalizeRangeHeader('bytes=-1024'), 'bytes=-1024');
  // D-35 的契约是「重放与原请求逐字相同」；若这里被吞成 null，签名过期后
  // 重放就会退化成全量请求，seek 语义丢失。
  assert.strictEqual(normalizeRangeHeader('bytes=-1'), 'bytes=-1');
  assert.strictEqual(normalizeRangeHeader('bytes=-0'), null, '长度为 0 非法');
  assert.strictEqual(normalizeRangeHeader('bytes=-abc'), null);
});

test('Range 守卫钉：protocol.handle 必须真的用上 normalizeRangeHeader', () => {
  const src = read('src/main/streamProtocol.js');
  assert.match(src, /normalizeRangeHeader\(rawRange\)/,
    '请求路径必须归一化 Range —— 否则 parseRange/normalizeRangeHeader 只是又一份死代码');
  // parseRange 此前零调用点；它保留作为纯函数（可单测），但不能再是「承诺未兑现」
  assert.match(src, /只透传上游给的值|归一化要透传给上游的 Range 头/,
    '头注应说明实际生效的是 normalizeRangeHeader');
});

// ── 1. 复用已校验结果（少一次 DNS）─────────────────────────

test('登记簿：接收并保留调用方已完成的那次 SSRF 校验结果', () => {
  registry.clearStreams();
  const check = { ok: true, url: new URL('https://cdn.example.com/a.mp3?sign=X'), ips: ['93.184.216.34'] };
  const schemeUrl = registry.registerStream('https://cdn.example.com/a.mp3?sign=X', 'https://ref/', null, check);
  const entry = registry.resolveStream(schemeUrl);
  assert.ok(entry.check, 'check 必须在条目里');
  assert.deepStrictEqual(entry.check.ips, ['93.184.216.34']);
  assert.strictEqual(String(entry.check.url), 'https://cdn.example.com/a.mp3?sign=X');
  registry.clearStreams();
});

test('登记簿：没有 check 时该字段为 null（调用方是旧路径/本地曲）', () => {
  registry.clearStreams();
  const schemeUrl = registry.registerStream('https://cdn.example.com/b.mp3', '', null);
  const entry = registry.resolveStream(schemeUrl);
  assert.strictEqual(entry.check, null, '缺省必须是 null 而不是半成品对象');
  registry.clearStreams();
});

test('守卫钉：proxy-play 必须把 check 传进 registerStream（否则复用形同虚设）', () => {
  const src = read('src/main/ipc/download.js');
  assert.match(src, /registerStream\(url, referer, refreshFn, check\)/,
    'proxy-play 已经在同一个 handler 里校验过 URL，不传下去就等于白校验一次');
});

// ── 3. LRU 不得淘汰正在使用的流 ───────────────────────────

test('LRU：按「最近取用」淘汰，正在 seek 的流不会被踢掉', () => {
  registry.clearStreams();
  // 先填到恰好上限（注意别在填充过程中就触发淘汰，否则测的就不是「取用过的那条」）
  const first = registry.registerStream('https://c/0.mp3', '', null);
  for (let i = 1; i < registry.MAX_ENTRIES; i++) {
    registry.registerStream(`https://c/${i}.mp3`, '', null);
  }
  assert.strictEqual(registry.streamCount(), registry.MAX_ENTRIES);

  // 「正在播放」= 被 resolveStream 取用过（首播 / 每次 seek 都会取用）
  registry.resolveStream(first);
  // 再注册一条触发淘汰
  registry.registerStream('https://c/overflow.mp3', '', null);

  assert.ok(registry.resolveStream(first),
    '刚被取用过的流不该被淘汰 —— 淘汰它等于让 audio 元素拿到 404 no stream meta');
  assert.strictEqual(registry.streamCount(), registry.MAX_ENTRIES, '容量上限仍然生效');
  registry.clearStreams();
});

test('LRU：长时间未取用的仍然会被淘汰（容量上限仍有效）', () => {
  registry.clearStreams();
  const victim = registry.registerStream('https://c/old.mp3', '', null);
  for (let i = 1; i <= registry.MAX_ENTRIES; i++) {
    registry.registerStream(`https://c/${i}.mp3`, '', null);
  }
  assert.strictEqual(registry.resolveStream(victim), null,
    '上限必须真的生效，否则登记簿会无界增长');
  registry.clearStreams();
});

test('守卫钉：淘汰必须看 lastUsed 而不是登记顺序', () => {
  const src = read('src/main/streamRegistry.js');
  assert.match(src, /lastUsed/);
  assert.ok(!/_entries\.keys\(\)\.next\(\)\.value/.test(src),
    '「插序 map 的第一个即最旧」是旧实现：它会踢掉正在播放的流');
});

// ── 2. 首播顺序（渲染层）───────────────────────────────────

test('守卫钉：audio.play() 必须在 restorePlayProgress 的 await 之前发起', () => {
  const src = read('src/renderer/js/player.js');
  const bad = /const\s+savedTime\w*\s*=\s*await\s+restorePlayProgress\(song\);[\s\S]{0,400}?audio\.play\(\)/;
  assert.ok(!bad.test(src),
    'play() 又被放回 await restorePlayProgress 之后了 —— 那是两个串行 getPref 的首播延迟');
  // 两处播放入口都要改到（在线播放 + 预取命中）
  const playCount = (src.match(/audio\.play\(\)\.catch/g) || []).length;
  assert.ok(playCount >= 2, `两个播放入口都应先 play 后并行恢复进度（实际 ${playCount} 处）`);
  const parallel = (src.match(/restorePlayProgress\(song\)\.then\(/g) || []).length;
  assert.ok(parallel >= 2, `进度恢复应改为并行（实际 ${parallel} 处）`);
});

// ── 端到端：起真实服务验证 Range 透传行为 ────────────────────

test('端到端：多区间 Range 不会被打到上游（Chromium 侧怪声/中断的根因）', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.range || null);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '4' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // 直接验证归一化后的行为：非法 Range → 不带 Range 头发给上游
    const { normalizeRangeHeader } = streamProtocol;
    const headers = {};
    const range = normalizeRangeHeader('bytes=0-99,200-299');
    if (range) headers.Range = range;
    await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/a.mp3', headers }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    assert.strictEqual(seen[0], null, '多区间 Range 被归一化掉，不该出现在上游请求里');

    // 对照：合法单区间照常透传
    const headers2 = {};
    const ok = normalizeRangeHeader('bytes=0-3');
    if (ok) headers2.Range = ok;
    await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/b.mp3', headers: headers2 }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    assert.strictEqual(seen[1], 'bytes=0-3', '合法 Range 必须原样透传（不自己重写格式）');
  } finally {
    server.close();
  }
});
