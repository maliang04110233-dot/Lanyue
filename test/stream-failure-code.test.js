/**
 * 取流失败的「类别 → 错误码」回写（2026-10-13）
 *
 * 断链是这样发现的：streamFailure 只往结果上挂 category，而下游**只认 code** ——
 * 渲染层诊断（diagnose.js）拿 errorCode 查 DIAG_TABLE / AUTH_CODES，换源判定拿
 * code 查 fallbackCodes 白名单。平台没给 code 的失败（safeRun 折叠出的
 * `{error:'平台X取流异常'}`、以及 403 被 request() 直接 resolve 掉、压根不产生
 * 错误对象的那些）于是 errorCode 一路为空：
 *   · 行内不戴徽标（failureTag 只认真实回写的码，不认推断）；
 *   · 弹层只能按关键词猜，code 变成 'INFERRED'；
 *   · isAuthFailure('INFERRED') 为假 ⇒ 「一键重试可恢复任务」把 Cookie 失效
 *     这种重试多少遍都没用的任务挨个重试一遍 —— 这才是真正伤用户的一处。
 *
 * 本文件钉住回写规则，并跑一条端到端：真实 401 响应 → gateway 出口拿到可诊断的码。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { annotateStreamError, CATEGORY, CATEGORY_CODE } =
  require('../src/api/services/streamFailure');
const { createPlatformGateway } = require('../src/api/gateway');
const request = require('../src/api/request');

/**
 * 起本地服务。skipSsrf 是 request.js 明确留给测试服务器的开关
 * （与 downloader 的 skipSsrfCheck 同约定），不开会被 SSRF 闸口拦掉。
 */
function startServer(status) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: status, message: 'no auth' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('平台没给 code 时，按类别补一个下游认得的码', () => {
  // 平台只给一句笼统文案（这正是 8 个平台的典型形态）
  const out = annotateStreamError({ error: '该音源需要登录' });
  assert.strictEqual(out.category, CATEGORY.AUTH, '文案里带「登录」⇒ 鉴权类');
  assert.strictEqual(out.code, 'COOKIE_INVALID',
    '必须补出 code：下游的徽标/诊断/批量重试三处都按 code 查表，空码等于三处同时失灵');
});

test('status=401 走状态优先，补出鉴权码（Cookie 失效，不是网络问题）', () => {
  const out = annotateStreamError({ error: '取流失败' }, { httpStatus: 401 });
  assert.strictEqual(out.code, 'COOKIE_INVALID');
  assert.strictEqual(out.status, 401);
});

test('403 签名过期补 UNAVAILABLE（重取直链通常就好，故不是鉴权）', () => {
  const out = annotateStreamError({ error: '取流失败' }, { httpStatus: 403 });
  assert.strictEqual(out.code, 'UNAVAILABLE');
  assert.strictEqual(out.category, CATEGORY.EXPIRED);
});

test('平台自己给了 code 时绝不覆盖（增量原则，既有行为逐字节不变）', () => {
  const out = annotateStreamError({ error: 'x', code: 'NETWORK_ERROR' }, { httpStatus: 401 });
  assert.strictEqual(out.code, 'NETWORK_ERROR',
    '平台最了解上下文，它的判断优先于由状态推断出来的结论');
});

test('成功结果不受影响（有 url 无 error ⇒ 不是失败，什么都不补）', () => {
  const out = annotateStreamError({ url: 'https://cdn/x.mp3' });
  assert.strictEqual(out.code, undefined);
  assert.strictEqual(out.category, undefined);
});

test('端到端：真实 401 响应经 gateway 出口变成可诊断的 COOKIE_INVALID', async () => {
  const srv = await startServer(401);
  try {
    // 桩插件：调一次真实请求（好让请求层记下 401），然后像平台那样
    // 只返回一句笼统文案 —— 不返回 code，因为它压根没看见状态码。
    const plugin = {
      name: '桩平台',
      async getUrl() {
        await request(`http://127.0.0.1:${srv.port}/stream`, { skipSsrf: true, retries: 0 });
        return { error: '该音源需要登录' };
      },
    };
    const gateway = createPlatformGateway({
      registry: { get: () => plugin, getCapabilities: () => ({}) },
      getCookie: () => '',
    });
    const out = await gateway.getUrl('stub', 'x', 'high');
    assert.strictEqual(out.status, 401, '请求层记下的 401 要能走到出口');
    assert.strictEqual(out.code, 'COOKIE_INVALID',
      '出口必须给出下游认得的码，否则用户看到的是「未分类的失败」');
  } finally {
    await srv.close();
  }
});

test('补出来的码必须都进过 fallbackCodes / DIAG_TABLE 的口径（映射自身不漂移）', () => {
  // 映射里出现一个下游不认的码，等于把上游的静默失灵挪到了下游，白改。
  const KNOWN = new Set([
    'COOKIE_INVALID', 'VIP_REQUIRED', 'UNAVAILABLE', 'COPYRIGHT_RESTRICTED', 'NETWORK_ERROR',
  ]);
  for (const code of CATEGORY_CODE.values()) {
    assert.ok(KNOWN.has(code), `映射出了下游不认的码：${code}（要同步登记进 DIAG_TABLE）`);
  }
});

test('渲染层认这个码：戴徽标、且判为「重试无用，先去设置」', async () => {
  const { failureTag, isAuthFailure, classifyFailure } = await import('../src/renderer/js/diagnose.js');
  const tag = failureTag('COOKIE_INVALID');
  assert.ok(tag, 'COOKIE_INVALID 没登记进 DIAG_TABLE ⇒ 行内不戴徽标');
  assert.strictEqual(tag.label, 'Cookie失效');
  assert.ok(isAuthFailure('COOKIE_INVALID'),
    '漏进 AUTH_CODES ⇒ 批量「一键重试可恢复任务」会把 Cookie 失效的任务空跑一遍');
  const d = classifyFailure('COOKIE_INVALID', '');
  assert.strictEqual(d.heal, 'settings', '该把用户支去设置页，而不是让他反复重试');
});

test('守卫钉：推断出的鉴权码不得被算进可自动重试（批量重试空转的回归）', async () => {
  const { classifyFailure, isAuthFailure } = await import('../src/renderer/js/diagnose.js');
  // 补码之前的形态：没有 code，只能按文本猜 —— code 变成 INFERRED，
  // 于是 isAuthFailure 为假，队列把它当成可恢复任务挨个重试。
  const before = classifyFailure(null, 'Cookie 无效');
  assert.strictEqual(before.code, 'INFERRED');
  assert.ok(!isAuthFailure(before.code), '这正是要修的空转：推断码进不了鉴权清单');
  // 中文「鉴权」此前连推断都够不着 —— 那条关键词兜底只认 403/cookie/auth/登录，
  // 而 errors.js 里 AUTH_EXPIRED 的官方文案正是「XX鉴权已过期」。
  const cn = classifyFailure(null, '鉴权失败');
  assert.notStrictEqual(cn.code, 'UNKNOWN', '中文鉴权文案不该掉进「未分类」');
  // 补码之后：真实回写的码能进鉴权清单
  assert.ok(isAuthFailure('COOKIE_INVALID'));
});
