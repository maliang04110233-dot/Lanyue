/**
 * 单元测试：QQ 取流（vkey）请求的**传输形态**契约
 *
 * 为什么单独钉这一处（2026-09-21 真实事故）：
 *   用户「登录了 QQ 音乐，播放却还是切到酷我」。实测本机 Cookie 完全有效
 *   （uin / qm_keyst 都在，账号对该 VIP 曲有权限），但 qqGetUrl 恒返回
 *   VIP_REQUIRED —— 因为 musicu.fcg **不解析** `application/x-www-form-urlencoded`
 *   的 `data=<编码串>`：整条请求被顶回 `{"code":500001}`，回包里连 req_0 都没有，
 *   purl 自然取不到，而代码把「purl 为空」一律读成「需要 VIP」。
 *   同一条 payload 改成 POST application/json 直传即可拿到 purl（实测
 *   .probe：免费曲/VIP 曲均 code 0 + purl 202~203 字符）。带不带
 *   Content-Length 都不是决定项，编码形态才是。
 *
 * 于是本文件钉住四条「改回去就静默坏掉」的契约：
 *   1. data 以 JSON body 送出（Content-Type: application/json，body 能 JSON.parse）；
 *   2. 登录态 authst 留在 body，绝不进 URL（M6 原意：URL 会落进访问日志）；
 *   3. 协议级失败（无 req_0）不得伪装成取流成功；
 *   4. 音质 → filename 前缀/后缀映射（选错档服务端不报错，只会静默给错码率）。
 * 外加一条正向解析守卫：拿到 purl 时必须拼出可播直链，且优先非 ws 域名。
 *
 * 打桩方式与 test/kugou.test.js 同：改 require.cache 里 src/api/request 的导出，
 * 再清掉平台模块缓存重新 require（平台模块顶层持有 request 引用）。
 */

const test = require('node:test');
const assert = require('node:assert');

const reqPath = require.resolve('../src/api/request');
const realRequest = require(reqPath);
const calls = [];
let responder = () => ({});

function stubbedRequest(url, opts) {
  calls.push({ url, opts: opts || {} });
  return Promise.resolve(responder(url, opts || {}));
}
stubbedRequest.__real = realRequest;
stubbedRequest.testAudioLink = realRequest.testAudioLink;
require.cache[reqPath] = { id: reqPath, filename: reqPath, loaded: true, exports: stubbedRequest };

const qqPath = require.resolve('../src/api/platforms/qq');
delete require.cache[qqPath];
const qq = require(qqPath);

const COOKIE = 'uin=123456789; qm_keyst=SECRET_KEY_VALUE';
const MID = '000EaZKJ2lMP25';

/** 服务端成功回包的缩影（字段名与真实回包一致，purl 用假值） */
function okResponse() {
  return {
    code: 0,
    req_0: {
      code: 0,
      data: {
        sip: ['http://ws.stream.qqmusic.qq.com/', 'https://dl.stream.qqmusic.qq.com/'],
        midurlinfo: [{ songmid: MID, filename: `M500${MID}${MID}.mp3`, purl: `${MID}.mp3?fun=0&vkey=FAKE`, result: 0 }],
      },
    },
  };
}

test('vkey 用 JSON body 送 data：Content-Type=application/json 且 body 可 JSON.parse', async () => {
  calls.length = 0;
  responder = () => okResponse();
  const r = await qq.qqGetUrl(MID, 'standard', COOKIE);

  assert.strictEqual(calls.length, 1, '应且只应发一次 vkey 请求');
  const { opts } = calls[0];
  assert.strictEqual(String(opts.headers['Content-Type']).toLowerCase(), 'application/json',
    'data 必须以 application/json 送出：x-www-form-urlencoded 的 data= 形态 musicu.fcg 不解析（恒回 code 500001）');
  assert.ok(!String(opts.body).startsWith('data='), 'body 不得再是 `data=<urlencoded>` 表单串');
  const parsed = JSON.parse(opts.body);
  assert.strictEqual(parsed.req_0.module, 'vkey.GetVkeyServer');
  assert.strictEqual(parsed.req_0.method, 'CgiGetVkey');
  assert.deepStrictEqual(parsed.req_0.param.filename, [`M500${MID}${MID}.mp3`], '音质前缀/后缀拼法不能动');

  assert.ok(r.url, '拿到 purl 时必须返回可播直链');
  assert.ok(r.url.startsWith('https://dl.stream.qqmusic.qq.com/'), 'sip 里优先选非 ws 域名');
  assert.strictEqual(r.ext, 'mp3');
});

test('登录态 authst 进 body 不进 URL（URL 会落进访问日志）', async () => {
  calls.length = 0;
  responder = () => okResponse();
  await qq.qqGetUrl(MID, 'hq', COOKIE);

  const { url, opts } = calls[0];
  const body = JSON.parse(opts.body);
  assert.strictEqual(body.comm.authst, 'SECRET_KEY_VALUE', 'authst 仍要带上（VIP 鉴权靠它）');
  assert.ok(!url.includes('SECRET_KEY_VALUE'), '登录态密钥不得出现在 URL 查询串');
  assert.ok(!url.includes('authst'), 'URL 里不得有 authst 参数');
});

test('服务端回 {"code":500001}（连 req_0 都没有）时不得判成取流成功', async () => {
  calls.length = 0;
  responder = () => ({ code: 500001, ts: 1789970679553 });
  const r = await qq.qqGetUrl(MID, 'standard', COOKIE);
  assert.ok(!r.url, '协议级失败绝不能带 url');
  assert.ok(r.error, '必须给出错误信息，不能静默');
});

test('音质映射：hq→M800.mp3 / standard→M500.mp3 / lossless→F000.flac（错档是静默的）', async () => {
  const seen = {};
  for (const quality of ['hq', 'standard', 'lossless']) {
    calls.length = 0;
    responder = () => okResponse();
    const r = await qq.qqGetUrl(MID, quality, COOKIE);
    const filename = JSON.parse(calls[0].opts.body).req_0.param.filename[0];
    seen[quality] = { filename, ext: r.ext };
  }
  // vkey 的 filename 是「前缀 + mid + mid + 后缀」，前缀/后缀就是音质本身
  assert.strictEqual(seen.hq.filename, `M800${MID}${MID}.mp3`);
  assert.strictEqual(seen.hq.ext, 'mp3');
  assert.strictEqual(seen.standard.filename, `M500${MID}${MID}.mp3`);
  assert.strictEqual(seen.lossless.filename, `F000${MID}${MID}.flac`);
  assert.strictEqual(seen.lossless.ext, 'flac');
});

/* ── 失败分类不得一刀切成「需要VIP」 ────────────────────────
 * 「purl 为空」在旧代码里恒等于 VIP_REQUIRED，可这两种回包根本不是一回事：
 *   连 req_0 都没有 = 服务端压根没处理这条请求（协议/接口问题 —— 2026-09-21 的
 *   500001 事故就是这个形状，当时本机 Cookie 完全有效、账号对该 VIP 曲有权限）；
 *   req_0 正常、midurlinfo 里 result 非 0 = 平台明确说"这首这档不给"（才是 VIP）。
 * 混成一类的代价全落在用户身上：diagnose.js 对 VIP_REQUIRED 说"补 VIP Cookie"、
 * 行内戴「需VIP」，用户照着折腾半天 Cookie，真相却是接口回包形态变了。
 */

test('回包连 req_0 都没有 → PLATFORM_CHANGED，不再冒充「需要VIP」', async () => {
  calls.length = 0;
  responder = () => ({ code: 500001, ts: 1789970679553 });
  const r = await qq.qqGetUrl(MID, 'standard', COOKIE);
  assert.ok(!r.url, '协议级失败不得带 url');
  assert.strictEqual(r.code, 'PLATFORM_CHANGED',
    '无 req_0 属协议/接口级失败（请求被顶回、平台没解析），说成 VIP_REQUIRED 会把用户支去瞎折腾 Cookie');
});

test('req_0 正常但 purl 为空、result 非 0 → 仍是 VIP_REQUIRED（改动不许做成一刀切）', async () => {
  calls.length = 0;
  responder = () => ({
    code: 0,
    req_0: {
      code: 0,
      data: {
        sip: ['https://dl.stream.qqmusic.qq.com/'],
        midurlinfo: [{ songmid: MID, filename: `F000${MID}${MID}.flac`, purl: '', result: 1 }],
      },
    },
  });
  const r = await qq.qqGetUrl(MID, 'lossless', COOKIE);
  assert.ok(!r.url);
  assert.strictEqual(r.code, 'VIP_REQUIRED', '平台明确回了曲目级别的失败，才归到 VIP/权限类');
});
