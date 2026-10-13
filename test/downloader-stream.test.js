/**
 * 下载传输层的两条硬约束（2026-10-13 复审 P0-2 / P1-5）
 *
 * P0-2：限速开启时响应流报错必须让 Promise settle。
 *   旧实现 `throttle ? res.pipe(throttle) : res` + 只在 dataStream 上挂 error，
 *   而 Node 的 pipe 既不转发源流 error、也不因源流销毁而结束下游 ⇒ res 中途
 *   断流时 throttle 既收不到 end 也收不到 error ⇒ writeStream 永不 finish ⇒
 *   Promise 永不 settle ⇒ downloadQueue 的 .finally 不执行 ⇒ 并发槽泄漏、
 *   队列停摆、任务永久「下载中」。本文件用「限时 race」把它钉成可观测行为。
 *
 * P1-5：服务端声明了 Content-Length 却没写够时，必须判失败而不是转正名。
 *   旧实现只拿 content-length 算进度，写完就 rename ⇒ 半截文件被当成下载
 *   成功、嵌 ID3、记 history done ⇒ 用户拿到播一半断掉的歌且再也不会重下。
 *
 * 用例都起本地 HTTP server（127.0.0.1），并用 skipSsrfCheck 跳过 SSRF 判定 ——
 * 那道判定对内网地址的拒绝正是它该有的行为，不该在这里被绕过去。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { downloadFileWithRetry } = require('../src/utils/downloader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dlt-test-'));
}

/** 起一个本地 server，handler 由用例给；返回 { url, close } */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/f.mp3`,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** 让 Promise 在 ms 毫秒内必须结束，否则判为「悬挂」（P0-2 的核心断言） */
function withDeadline(p, ms) {
  return Promise.race([
    p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}

test('P0-2：开启限速时服务端中途断流 ⇒ 必须 reject，不能悬挂', async () => {
  const dir = tmpDir();
  const savePath = path.join(dir, 'song.mp3');
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '1000000' });
    res.write(Buffer.alloc(4096, 1));
    // 写一半直接掐掉连接：客户端侧表现为响应流报错
    setTimeout(() => { res.socket?.destroy(); }, 30);
  });
  try {
    const p = downloadFileWithRetry(srv.url, savePath, null, {}, {
      skipSsrfCheck: true,
      speedLimit: 64 * 1024,     // 关键：走 throttle 分支
      maxRetry: 0,               // 只验「能不能 settle」，不验重试
    });
    const r = await withDeadline(p, 3000);
    assert.ok(!r.hung, '限速模式下响应流报错必须让 Promise 结束（旧实现会永久悬挂）');
    assert.strictEqual(r.ok, false, '断流必须判失败');
    assert.strictEqual(fs.existsSync(savePath), false, '失败不应留下正名文件');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2（对照组）：不限速时同样必须 reject', async () => {
  const dir = tmpDir();
  const savePath = path.join(dir, 'song.mp3');
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '1000000' });
    res.write(Buffer.alloc(4096, 1));
    setTimeout(() => { res.socket?.destroy(); }, 30);
  });
  try {
    const p = downloadFileWithRetry(srv.url, savePath, null, {}, {
      skipSsrfCheck: true,
      maxRetry: 0,
    });
    const r = await withDeadline(p, 3000);
    assert.ok(!r.hung, '不限速时断流也必须让 Promise 结束');
    assert.strictEqual(r.ok, false);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-5：Content-Length 大于实际写入量 ⇒ 绝不转正名', async () => {
  const dir = tmpDir();
  const savePath = path.join(dir, 'song.mp3');
  const body = Buffer.alloc(1024, 7);
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length * 10) });
    res.end(body);
    // 明确掐断：让客户端立刻感知到「连接在数据到齐前就断了」。
    // 不这么做的话，Node 客户端会按 Content-Length 等剩余字节直到 req 超时，
    // 测出来的是超时而不是「半截文件被当成成功」这个真正的风险。
    setTimeout(() => { res.socket?.destroy(); }, 20);
  });
  try {
    const p = downloadFileWithRetry(srv.url, savePath, null, {}, {
      skipSsrfCheck: true,
      maxRetry: 0,
    });
    const r = await withDeadline(p, 8000);
    assert.ok(!r.hung, '必须判失败而不是等满超时');
    assert.strictEqual(r.ok, false, '声明长度与实际不符时绝不能判成功');
    assert.strictEqual(fs.existsSync(savePath), false,
      '半截文件绝不能被 rename 成正式文件（旧实现会，于是嵌 ID3、记 done、去重也认定已下载）');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-5（守卫钉）：downloader 保留「按 Content-Length 判短包」的兜底分支', () => {
  // 上面那个用例走的是 ECONNRESET（Node 自己在数据不足时报的错）。短包分支
  // 防的是另一类畸形响应：连接正常结束、但字节数少于声明值（部分 CDN/代理的
  // 转发异常）。那条路径无法用本地 server 稳定构造（Node server 一旦发现
  // 写入少于 Content-Length 就自己掐连接），所以用静态守卫钉住它不许被删。
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/utils/downloader.js'), 'utf8');
  assert.match(src, /downloaded < fullSize/,
    '短包判定不许消失：它拦住的是「流正常结束但数据不足」的畸形响应');
  assert.match(src, /下载不完整/,
    '错误文案要说清是短包，别让用户对着「未知错误」猜');
});

test('P1-5（对照组）：长度相符时照常成功并转正名', async () => {
  const dir = tmpDir();
  const savePath = path.join(dir, 'song.mp3');
  const body = Buffer.alloc(2048, 3);
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) });
    res.end(body);
  });
  try {
    const out = await downloadFileWithRetry(srv.url, savePath, null, {}, {
      skipSsrfCheck: true,
      maxRetry: 0,
    });
    assert.strictEqual(out, savePath);
    assert.strictEqual(fs.statSync(savePath).size, body.length);
    assert.strictEqual(fs.existsSync(savePath + '.tmp'), false, '成功后不留 .tmp');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
