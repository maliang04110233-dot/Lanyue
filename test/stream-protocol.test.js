/**
 * 守卫：在线播放必须真的流式，且不得牺牲 SSRF / Range 正确性（根因 1）
 *
 * 问题
 * ----
 * 旧路径 proxyPlay 把整首 HTTP GET 落盘，等 file.on('finish') 才返回 file://。
 * 于是整首下完之前 audio.duration 是 NaN，进度条与拖动全被守卫拦死 ——
 * 用户看到的是"在线音源不能从中间播"，而根因是 seek 入口在下载完成前不存在。
 *
 * 本文件钉三件事：
 *   1. Range 解析：只认单区间，非法的一律当没有 Range（自己拼会被 CDN 拒绝，
 *      退化成 200 全量 = 白改回整首下载）；
 *   2. SSRF 规格不得降级：与整首下载同款 assertPublicHttpUrl + pinned lookup，
 *      且**重定向的每一跳**都要校验（只校第一跳等于没校）；
 *   3. 上游不支持 Range 时如实透传 200，不伪造 206 —— 假 206 会让 audio
 *      元素以为可以 seek，随后在错误的位置上播放。
 *
 * 判据风格：纯函数真跑；electron 依赖（protocol.handle / Response）用桩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const {
  parseRange, contentTypeOf, contentLengthOfRange, MAX_BYTES,
} = require('../src/main/streamProtocol.js');
const registry = require('../src/main/streamRegistry.js');

const SRC = strip(read('src/main/streamProtocol.js'));
const REG = strip(read('src/main/streamRegistry.js'));

// ── 1. Range 解析 ─────────────────────────────────────

test('Range：闭区间与开区间都能解析', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: '' });
});

test('Range：bytes=-N 表示最后 N 字节（需要已知总长）', () => {
  assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 });
  assert.equal(parseRange('bytes=-500', 0), null, '总长未知时无法解释后缀区间');
  assert.equal(parseRange('bytes=-500', null), null);
  assert.equal(parseRange('bytes=-0', 1000), null, 'N=0 是空区间，没有意义');
});

test('Range：多区间当没有 Range（音频播放用不上，拼了会被上游拒绝）', () => {
  assert.equal(parseRange('bytes=0-99,200-299', 1000), null);
  assert.equal(parseRange('bytes=0-1,3-4', 1000), null);
});

test('Range：非法值一律 null，绝不产出半个可用区间', () => {
  const bad = [
    undefined, null, '', 'bytes=', 'bytes=-', 'items=0-99', '0-99',
    'bytes=abc-def', 'bytes=200-100', 'bytes=1.5-2',
  ];
  for (const b of bad) {
    assert.equal(parseRange(b, 1000), null,
      `Range="${String(b)}" 应被拒绝，产出 ${JSON.stringify(parseRange(b, 1000))} 反而会拼出错误请求`);
  }
  // 首尾空白合法，交给上游自己处理
  assert.deepEqual(parseRange('bytes=0-99 ', 1000), { start: 0, end: 99 });
});

test('Range：bytes=-N 是「最后 N 字节」，N 合法就得解析（它不是非法值）', () => {
  assert.deepEqual(parseRange('bytes=-5', 1000), { start: 995, end: 999 });
  // 只有 N<=0 才非法：空区间没有意义
  assert.equal(parseRange('bytes=-0', 1000), null);
});

test('Range：负数起点与非有限值不产出区间', () => {
  assert.equal(parseRange('bytes=-0-99', 1000), null);
  assert.equal(parseRange('bytes=Infinity-99', 1000), null);
  assert.equal(parseRange('bytes=NaN-', 1000), null);
});

// ── 2. 206 的 Content-Length 来自 Content-Range ────────

test('Content-Range 优先于 Content-Length 算本段长度', () => {
  assert.equal(contentLengthOfRange({ 'content-range': 'bytes 0-99/1000', 'content-length': '100' }), 100);
  assert.equal(contentLengthOfRange({ 'content-range': 'bytes 100-199/1000' }), 100);
  // 两者不一致时以 Content-Range 为准：它描述的正是这一段
  assert.equal(contentLengthOfRange({ 'content-range': 'bytes 0-199/1000', 'content-length': '9999' }), 200);
});

test('没有 Content-Range 时退回 Content-Length，都没有则 0', () => {
  assert.equal(contentLengthOfRange({ 'content-length': '123' }), 123);
  assert.equal(contentLengthOfRange({}), 0);
  assert.equal(contentLengthOfRange({ 'content-length': 'abc' }), 0);
});

// ── 3. Content-Type ───────────────────────────────────

test('Content-Type：audio/* 原样，octet-stream 兜底成 audio/mpeg', () => {
  assert.equal(contentTypeOf({ headers: { 'content-type': 'audio/flac' } }), 'audio/flac');
  assert.equal(contentTypeOf({ headers: { 'content-type': 'audio/mpeg; charset=utf-8' } }), 'audio/mpeg');
  assert.equal(contentTypeOf({ headers: { 'content-type': 'application/octet-stream' } }), 'audio/mpeg',
    '很多音源只给 octet-stream，不兜底 audio 元素会拒绝解码');
  // 未知的非 audio 类型：原样透出，不硬套 audio/*。
  // 谎报 mime 会让 audio 元素按错的 codec 解析，表现是"能播但全是噪声"。
  assert.equal(contentTypeOf({ headers: { 'content-type': 'video/mp4' } }), 'video/mp4');
});

test('Content-Type：完全缺失时给 audio/mpeg，不给空串（空 mime 会让 audio 拒绝解码）', () => {
  assert.equal(contentTypeOf({ headers: {} }), 'audio/mpeg');
  assert.equal(contentTypeOf({}), 'audio/mpeg');
});

// ── 4. SSRF 规格不得降级 ──────────────────────────────

test('SSRF：入口校验 + pinned lookup 都在（渲染层能塞任意 URL 进这个 scheme）', () => {
  assert.match(SRC, /assertPublicHttpUrl\(\s*meta\.url\s*\)/, '入口必须过 urlGuard');
  assert.match(SRC, /lookup:\s*makePinnedLookup\(ips\)/,
    '必须用 pinned lookup 固定连接 IP，防 DNS rebinding');
  assert.match(SRC, /u\.protocol === 'https:'\s*\?\s*require\('https'\)\s*:\s*require\('http'\)/,
    'https/http 要分别选库');
});

test('SSRF：重定向每一跳都校验（只校第一跳等于没校）', () => {
  assert.match(SRC, /assertPublicHttpUrl\(\s*next\s*\)/,
    '重定向目标同样要过 urlGuard —— 第一跳的校验会被这一跳绕过');
  // 跨域跳转要清 referer，与整首下载同规格
  assert.match(SRC, /nextHost\s*!==\s*refHost[\s\S]*?nextReferer\s*=\s*''/,
    '跨域重定向必须清掉 referer');
});

test('SSRF：校验失败不发起上游请求，直接 403', () => {
  assert.match(SRC, /if\s*\(!check\.ok\)[\s\S]*?status:\s*403/,
    'URL 被判定为内网/非法时要直接拒绝，且不得先发请求');
});

// ── 5. Range 透传与 206/200 如实性 ────────────────────

test('Range：只透传上游给的值，不自己拼（拼错会退化成 200 全量下载）', () => {
  assert.match(SRC, /if\s*\(rangeHeader\)\s*headers\.Range\s*=\s*rangeHeader/,
    '必须原样透传请求里带来的 Range');
  assert.ok(!/headers\.Range\s*=\s*`bytes=/.test(SRC), '不得自己拼 Range 字符串');
});

test('206/200：只在上游真的返回 206 时才发 206，不伪造', () => {
  assert.match(SRC, /const partial = res\.statusCode === 206/);
  assert.match(SRC, /status:\s*partial\s*\?\s*206\s*:\s*200/,
    '206 必须由上游状态码决定');
  assert.match(SRC, /Accept-Ranges['"]:\s*['"]bytes['"]/,
    '要声明支持 Range，audio 元素才会去 seek');
});

test('上游 4xx/5xx 如实透传状态码，不伪装成音频', () => {
  assert.match(SRC, /statusCode\s*>=\s*400[\s\S]*?status:\s*res\.statusCode/,
    '上游报错要原样返回，否则 audio 会收到一个 200 却解不出声音');
  assert.match(SRC, /status:\s*502/, '上游连不上要 502 而不是 200');
});

// ── 6. 体积上限语义随流式改变 ─────────────────────────

test('MAX_BYTES 作用在单次响应上，不在整首歌上（流式后没有整首上限的语义）', () => {
  assert.equal(MAX_BYTES, 200 * 1024 * 1024);
  assert.match(SRC, /received\s*>\s*MAX_BYTES[\s\S]*?res\.destroy\(\)/,
    '超限要断流而不是继续拉');
});

test('流式模块完全不碰 playCache（落盘就是退回根因 1）', () => {
  assert.ok(!/createWriteStream/.test(SRC), '流式路径不得落盘');
  assert.ok(!/play_cache/.test(SRC), '流式路径不得写 play_cache 目录');
  assert.ok(!/require\(['"]\.\/playCache['"]\)/.test(SRC), '流式模块不得依赖整首下载的缓存层');
  assert.ok(!/\bfs\./.test(SRC) || !/writeFile|createWriteStream|appendFile/.test(SRC),
    '流式模块不得写文件');
});

// ── 7. 登记簿：签名 URL 不进 scheme ───────────────────

test('上游 URL 不编码进 scheme URL（签名参数会流进日志与 prefill）', () => {
  assert.ok(!/encodeURIComponent\(\s*url\s*\)/.test(REG), '上游 URL 不得编进 scheme');
  assert.ok(!/searchParams|query|\?url=/.test(REG), 'scheme URL 里不得带上游参数');
  assert.match(REG, /new Map\(\)/, '登记簿是内存 Map');
});

test('登记簿：上限淘汰 + 可解析 + 可清空', () => {
  registry.clearStreams();
  const a = registry.registerStream('https://cdn.example.com/a.mp3?sign=x', 'https://ref.example.com/');
  assert.equal(registry.streamCount(), 1);
  const meta = registry.resolveStream(a);
  assert.equal(meta.url, 'https://cdn.example.com/a.mp3?sign=x');
  assert.equal(meta.referer, 'https://ref.example.com/');

  for (let i = 0; i < registry.MAX_ENTRIES + 5; i++) {
    registry.registerStream(`https://cdn.example.com/${i}.mp3`);
  }
  assert.ok(registry.streamCount() <= registry.MAX_ENTRIES,
    '登记簿无上限会把签名 URL 无限堆在内存里');
  assert.equal(registry.resolveStream(a), null, '最旧的应被淘汰');
  registry.clearStreams();
  assert.equal(registry.streamCount(), 0);
});

test('登记簿：解析只认本 scheme 的 key，不接受完整 URL 猜测', () => {
  registry.clearStreams();
  const k = registry.registerStream('https://cdn.example.com/x.mp3');
  const key = k.replace('lanyue-stream://', '');
  assert.equal(registry.resolveStream('lanyue-stream://' + key).url, 'https://cdn.example.com/x.mp3');
  assert.equal(registry.resolveStream('https://evil.example.com/x.mp3'), null,
    '直接传一个外部 URL 不该被当成已登记的流');
  assert.equal(registry.resolveStream('lanyue-stream://nope'), null);
  registry.clearStreams();
});

test('两个模块的 scheme 常量必须一致（各自写一份就会漂）', () => {
  const SP = read('src/main/streamProtocol.js');
  const SR = read('src/main/streamRegistry.js');
  const grab = (src) => {
    const m = /STREAM_SCHEME\s*=\s*'([^']+)'/.exec(src);
    return m ? m[1] : null;
  };
  assert.equal(grab(SP), 'lanyue-stream');
  assert.equal(grab(SR), grab(SP),
    'streamProtocol 与 streamRegistry 的 scheme 不一致：登记时发 A、注册时听 B，流永远匹配不上');
  assert.equal(registry.STREAM_SCHEME, grab(SP), '导出的常量与内部定义也要一致');
});

// ── 8. 接线：主进程确实注册了这个 scheme ─────────────

test('index.js 在 whenReady 里注册流式 scheme（注册时机早于任何窗口加载）', () => {
  const IDX = strip(read('src/main/index.js'));
  const ready = IDX.indexOf('app.whenReady()');
  assert.ok(ready > -1, '未找到 whenReady');
  const body = IDX.slice(ready, ready + 4000);
  assert.match(body, /registerStreamScheme|streamProtocol/,
    'whenReady 块里没看到流式 scheme 注册 —— 旧整首下载路径仍在生效');
});

test('主进程把 scheme 声明为特权（否则 audio 元素不会发 Range 请求）', () => {
  const IDX = read('src/main/index.js');
  assert.match(IDX, /protocol\.registerSchemesAsPrivileged\(/,
    '未调用 registerSchemesAsPrivileged —— 非 standard scheme 下 Chromium '
    + '不会按媒体语义发 Range，流式播放形同虚设');
  // 声明块必须真的包含 lanyue-stream（删掉协议名也能过上面那行）
  const blk = IDX.slice(IDX.indexOf('registerSchemesAsPrivileged('), IDX.indexOf('registerSchemesAsPrivileged(') + 500);
  assert.match(blk, /scheme:\s*STREAM_SCHEME|['"]lanyue-stream['"]/, '声明块里没有 lanyue-stream');
  assert.match(blk, /standard:\s*true/, 'standard 是让 Chromium 按媒体语义处理的前提');
  assert.match(blk, /stream:\s*true/, 'stream 允许响应体以流的方式交付');
  // 且必须在 app ready 之前（Electron 硬要求）
  assert.ok(IDX.indexOf('registerSchemesAsPrivileged(') < IDX.indexOf('app.whenReady()'),
    '特权 scheme 必须在 app.whenReady 之前注册，否则抛错');
});

test('preload 之外，渲染层拿到的就是 scheme URL（不再等 file://）', () => {
  const DL = read('src/main/ipc/download.js');
  const DLs = strip(DL);
  // D-35 起登记是三参：(url, referer, refreshFn)。第三参是同源重取回调，
  // 缺了它签名链接过期就只能如实失败。期望值必须跟着接线走 ——
  // 但断言意图不变：proxy-play 要登记流并返回 scheme URL，renderer 不得等整首落盘。
  assert.match(DLs, /streamRegistry\.registerStream\(\s*url\s*,\s*referer\s*,\s*refreshFn\s*\)/,
    'proxy-play 应登记流（含重取回调）并返回 scheme URL —— 否则 renderer 仍在等整首落盘');

  // 变异自检：把第三参换成别的标识，这道断言必须变红 ——
  // 否则它会退化成"文件里出现过 registerStream 就算过"的恒真守卫。
  {
    const mutated = DLs.replace(
      /streamRegistry\.registerStream\(\s*url\s*,\s*referer\s*,\s*refreshFn\s*\)/,
      'streamRegistry.registerStream( url , referer , somethingElse )'
    );
    assert.notEqual(mutated, DLs, '变异脚本要真改到东西');
    assert.ok(
      !/streamRegistry\.registerStream\(\s*url\s*,\s*referer\s*,\s*refreshFn\s*\)/.test(mutated),
      '第三参被换掉后断言仍绿 —— 这道守卫已经恒真，形同虚设');
  }
  assert.match(DLs, /return\s*\{\s*fileUrl:\s*streamUrl\s*,\s*streaming:\s*true\s*\}/,
    '返回体要标明是流式，渲染层据此不再期待 file://');
  // 整首落盘那一层不得再挂在播放链路上
  assert.ok(!/require\(['"]\.\.\/playCache['"]\)/.test(DLs),
    'download.js 仍 require playCache —— 播放链路还留在整首下载上');
  assert.ok(!/await\s+proxyPlay\(/.test(DLs), 'proxy-play 里仍有整首落盘调用');
  assert.ok(!/await\s+proxyPlay\(/.test(strip(read('src/renderer/js/player.js'))),
    'player.js 仍在等 proxyPlay 的落盘结果');
});
