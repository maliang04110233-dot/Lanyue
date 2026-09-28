/**
 * AI 音乐生成的取消链路（2026-09 审计 P1-10）
 *
 * 缺口：主进程 src/main/ipc/ai-music.js 建了 AbortController，并把 signal
 * 一路传到 generateMusic；但 src/api/ai-music.js **自带** 的 request()
 * （本模块不经过公共 transport：计费接口要禁自动重试、返回值口径也不同）
 * 从第一版起就没读过 options.signal —— signal 在传输层被丢弃。
 * 后果：ai-cancel-generation 只能改界面，在途的 MiniMax 计费请求照跑，
 * 用户点了取消，token 照烧。
 *
 * 为什么必须真起 socket：把 signal 传下去就算"实现了"是最容易骗过自己的
 * 写法。本文件把 https.request 换成本机 http.request（协议不同、socket
 * 行为一致），服务端**故意不立刻回包**，于是：
 *   · 中止前：promise 悬着、socket 活着（证明请求真的在途）；
 *   · 中止后：socket 被 destroy、promise reject ABORT_ERR、进度回调
 *     永远到不了 completed（证明不是"把 signal 传下去就算完"）。
 * 另有一条**对照**用例：同一套桩、不给 signal 时必须正常 resolve ——
 * 没有它，"永远 reject"这种坏实现也能让主用例全绿。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const aiMusic = require(path.join(ROOT, 'src/api/ai-music'));

// ── 本机桩服务：接连接、记 socket、按脚本决定何时回包 ──────────
const sockets = [];
let connections = 0;
let responded = 0;
/** 客户端在拿到回包之前就挂断的次数（真·"请求被打断"的证据） */
let hungUp = 0;
/** 每次请求的应答延迟（ms）；大值 = 请求一直悬着 */
let respondAfter = 400;
const pending = [];

const server = http.createServer((req, res) => {
  pending.push(res);
  // 客户端在应答前挂断 ⇒ 响应侧 close 且从未 end
  res.on('close', () => { if (!res.writableEnded) hungUp++; });
  const timer = setTimeout(() => {
    if (res.destroyed || res.writableEnded) return;
    responded++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      base_resp: { status_code: 0, status_msg: '' },
      data: { status: 0, audio: 'deadbeef' },
      extra_info: { music_duration: 180000 },
    }));
  }, respondAfter);
  res.on('close', () => clearTimeout(timer));
});
server.on('connection', (socket) => {
  connections++;
  sockets.push(socket);
});

/** 客户端侧真实 ClientRequest（abort 后看它有没有被 destroy） */
const clientReqs = [];
const realHttpsRequest = https.request;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // 只换传输层落点：ai-music.js 算出的是 api.minimaxi.com:443，
  // 这里把它改到本机端口，socket 生命周期/事件语义完全一致。
  // agent:false —— Node 19+ 默认 keep-alive，会复用上一条连接，
  // 那样"服务端又接到一条新连接"这个信号就测不到了
  https.request = function stubbedHttpsRequest(opts, cb) {
    const req = http.request({ ...opts, hostname: '127.0.0.1', port, agent: false }, cb);
    clientReqs.push(req);
    return req;
  };
});

test.after(() => {
  https.request = realHttpsRequest;
  for (const s of sockets) { try { s.destroy(); } catch (_e) { /* 已关 */ } }
  server.closeAllConnections?.();
  server.close();
});

const reset = () => {
  connections = 0;
  responded = 0;
  hungUp = 0;
  sockets.length = 0;
  pending.length = 0;
  clientReqs.length = 0;
  respondAfter = 400;
};

const GEN = {
  apiKey: 'k-test',
  lyrics: '[verse]\n晴天 词 曲 周杰伦',
  musicPrompt: '抒情流行，钢琴铺底',
  title: '晴天',
};

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到服务端真的接上了（否则"在途"没成立，后面 abort 什么都没证明） */
async function waitForConnection(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (connections === 0 && Date.now() < deadline) await tick(5);
  assert.equal(connections, 1, '服务端没收到连接：用例没测到在途请求');
}

test('对照组：同一套桩、不给 signal 时正常 resolve（否则"永远 reject"也能让主用例绿）', async () => {
  reset();
  respondAfter = 30;
  const progress = [];
  const r = await aiMusic.generateMusic(
    { ...GEN, onProgress: (p) => progress.push(p.status) });
  assert.equal(r.audioHex, 'deadbeef', `桩服务没回包，测试环境有问题: ${JSON.stringify(r)}`);
  assert.equal(responded, 1);
  assert.ok(progress.includes('completed'), `进度回调没走到 completed: ${JSON.stringify(progress)}`);
});

test('中止真的打断在途请求：socket 被 destroy，promise reject ABORT_ERR', async () => {
  reset();
  respondAfter = 400; // 请求会一直悬着，直到 400ms 后才回包
  const ctrl = new AbortController();
  const progress = [];
  let settled = null;
  const p = aiMusic.generateMusic(
    { ...GEN, onProgress: (x) => progress.push(x.status) },
    { signal: ctrl.signal },
  ).then((v) => { settled = { ok: v }; }, (e) => { settled = { err: e }; });

  await waitForConnection();
  assert.equal(settled, null, '中止前请求就结束了：在途状态没成立');
  assert.equal(clientReqs[0].destroyed, false, '中止前在途请求应当是活的');

  ctrl.abort();
  await p;
  const r = settled;
  assert.ok(r, '中止后 promise 没有任何归宿');
  assert.ok(r.err, '中止后必须 reject，而不是把在途回包当结果交出去');
  assert.equal(r.err.code, 'ABORT_ERR', `取消错误码应与公共 transport 一致: ${r.err.message}`);
  assert.equal(r.err.message, '已取消');

  // 真·中断的证据一：客户端在途请求对象被 destroy（只把 signal 传下去不会走到这）
  assert.equal(clientReqs[0].destroyed, true, '在途请求未被 destroy —— 取消只是装饰性的');

  // 中止后不许再 resolve：等服务真回包了（400ms 已过），结果不能翻案
  await tick(500);
  assert.equal(responded, 0, '服务端回包了？这条连接本该早就被拆掉');
  assert.equal(hungUp, 1, '服务端没观察到客户端在应答前挂断（请求其实还活着）');
  assert.ok(!progress.includes('completed'), `中止后仍报了完成: ${JSON.stringify(progress)}`);
  assert.ok(settled.err, '中止后结果被翻案成成功');
});

test('传进来时已取消：一跳都不发（少一次计费比什么都强）', async () => {
  reset();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => aiMusic.generateMusic(GEN, { signal: ctrl.signal }),
    (e) => e.code === 'ABORT_ERR',
  );
  await tick(120);
  assert.equal(connections, 0, '已取消的请求不该发出去（token 已经省不回来了，不能再补一刀）');
  assert.equal(clientReqs.length, 0);
});

test('取消语义优先于重试通道：中止后不会被自动重试复活成新一跳', async () => {
  reset();
  respondAfter = 60;
  const ctrl = new AbortController();
  const p = aiMusic.generateMusic(GEN, { signal: ctrl.signal }).catch((e) => e);
  await waitForConnection();
  ctrl.abort();
  const err = await p;
  assert.equal(err.code, 'ABORT_ERR');

  // 传输层此刻正处于"回包/出错 → 可能重试"的岔路口：
  // 若取消被重试逻辑吞掉，这里会冒出第二条连接（= 又一次计费请求）
  await tick(300);
  assert.equal(connections, 1, `中止后仍发起了新请求（重试把取消复活了）: ${connections} 条连接`);
});

test('顺序钉：generateMusic 仍把 signal 交给本模块的 request（M11 的线别断）', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'src/api/ai-music.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const call = src.slice(src.indexOf('MINIMAX_API_BASE}/v1/music_generation'));
  assert.ok(call.length > 20, '找不到 generateMusic 的请求点');
  assert.match(call.slice(0, 600), /signal:\s*callOptions\.signal/,
    'generateMusic 不再把 signal 传下去（渲染层取消又会变成死链）');
});
