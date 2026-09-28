/**
 * 连通性失败的判据收进一处中性模块（src/shared/netClass.js）
 *
 * 改造前的真实状态：
 *   - 「这条失败是不是网络类」只有主进程更新器那条线会问（正则写死在 src/main/updateError.js，
 *     那里没有 electron 依赖所以能单测）。下载引擎完全不问：catch 里只认 HTTP 403/404/410，
 *     网络类失败**一次即死**，并且 song.errorCode 只在取流 fatal 那一条路上才写，
 *     于是断网跑完的队列行与历史行统统不戴徽标、诊断弹层只会说「未分类的失败，请复制错误信息反馈」。
 *   - 渲染层没有任何网络状态感知：断网两小时、复网后那 30 条红色任务仍躺在那儿等用户手点。
 *
 * 本文件钉住这次改造的四条不变量：
 *   A 判据只有一处：两支正则 + 自归类码清单全在 shared/netClass.js，更新器改为消费方（T7/T8 查源码）。
 *   B 说话要有分寸：超时/断连算「重试有意义」，证书与 TLS 拦截不算（T4）—— 拦你的东西不会自己消失。
 *   C 老语义不动：updateError.isNetworkFailure 仍把 TLS 算作"网络类"（该不该给「打开下载页」按钮），
 *     这条与 B 是两回事，各自钉住（T9）。
 *   D 码不许拼错：NETWORK_CODES 里每一枚都必须是 errors.js 真定义过的码（T6）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 去掉块注释与行注释：对账一律看真代码，注释里举的例子不许算数 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function net() {
  return require(path.join(ROOT, 'src/shared/netClass.js'));
}

// ══════════════════════════════════════════════════════════
// 1-3：哪些文本算「重试有意义」的网络失败
// ══════════════════════════════════════════════════════════

test(' 超时族归 NETWORK_TIMEOUT', () => {
  const m = net();
  for (const msg of [
    'net::ERR_TIMED_OUT',
    'connect ETIMEDOUT 10.0.0.1:443',
    'request timeout of 30000ms exceeded',
    'network timeout',
  ]) {
    assert.strictEqual(m.transportCode(msg), 'NETWORK_TIMEOUT', `${msg} 应判为超时`);
  }
});

test(' 断连族归 NETWORK_ERROR（Chromium 与 Node 两套命名都要覆盖）', () => {
  const m = net();
  for (const msg of [
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND music.qq.com',
    'socket hang up',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_ADDRESS_UNREACHABLE',
  ]) {
    assert.strictEqual(m.transportCode(msg), 'NETWORK_ERROR', `${msg} 应判为断连`);
  }
});

test(' 非网络失败一律不认领（不许把鉴权/磁盘问题说成网络问题）', () => {
  const m = net();
  for (const msg of [
    'HTTP 403 Forbidden',
    'HTTP 410 Gone',
    '磁盘写入失败',
    'VIP_REQUIRED',
    'ENOSPC: no space left on device',
    '临时失败',
    '',
    null,
    undefined,
  ]) {
    assert.strictEqual(m.transportCode(msg), null, `${msg} 不该被认领成网络失败`);
  }
});

// ══════════════════════════════════════════════════════════
// 4：证书/TLS 单独一档 —— 「稍后再试」对它不成立
// ══════════════════════════════════════════════════════════

test(' TLS 与传输失败分档：TLS 不算可自动重试', () => {
  const m = net();
  const tls = [
    'net::ERR_CERT_AUTHORITY_INVALID',
    'unable to verify the first certificate',
    'self-signed certificate in certificate chain',
  ];
  for (const msg of tls) {
    assert.strictEqual(m.isTlsFailure(msg), true, `${msg} 应是 TLS 类`);
    assert.strictEqual(m.transportCode(msg), null, `${msg} 不许冒充"重试就好"的网络失败`);
    assert.strictEqual(m.isConnectivityFailure({ error: msg }), false, `${msg} 不该被自动重排队`);
  }
});

// ══════════════════════════════════════════════════════════
// 5：入参形状要宽（引擎给的是错误对象，队列快照给的是 {errorCode, error}）
// ══════════════════════════════════════════════════════════

test(' 判定吃四种形状：字符串 / Error / 队列条目 / 裸码', () => {
  const m = net();
  assert.strictEqual(m.isConnectivityFailure('read ECONNRESET'), true);
  assert.strictEqual(m.isConnectivityFailure(new Error('net::ERR_TIMED_OUT')), true);
  assert.strictEqual(m.isConnectivityFailure({ errorCode: 'NETWORK_ERROR', error: 'x' }), true);
  assert.strictEqual(m.isConnectivityFailure({ errorCode: 'NETWORK_TIMEOUT', error: 'x' }), true);
  assert.strictEqual(m.isConnectivityFailure({ errorCode: 'VIP_REQUIRED', error: '需要 VIP' }), false);
  assert.strictEqual(m.isConnectivityFailure({ errorCode: null, error: 'HTTP 403' }), false);
  assert.strictEqual(m.isConnectivityFailure(null), false);
  assert.strictEqual(m.isConnectivityFailure({}), false);
});

// ══════════════════════════════════════════════════════════
// 6：码不许拼错
// ══════════════════════════════════════════════════════════

test(' NETWORK_CODES 每枚都是 errors.js 真定义过的码', () => {
  const m = net();
  const { ERROR_CODES } = require(path.join(ROOT, 'src/shared/errors.js'));
  assert.ok(Array.isArray(m.NETWORK_CODES) && m.NETWORK_CODES.length >= 2, '清单本身不能空');
  for (const code of m.NETWORK_CODES) {
    assert.ok(Object.values(ERROR_CODES).includes(code), `${code} 不在 ERROR_CODES 里：拼错的码永远匹配不上`);
  }
});

// ══════════════════════════════════════════════════════════
// 7-8：判据之家只有一处
// ══════════════════════════════════════════════════════════

test(' 更新器不再自带第二份正则', () => {
  const code = stripComments(read('src/main/updateError.js'));
  assert.ok(!/net::ERR_/.test(code), 'updateError.js 里仍写着 net:: 正则：同一判据开了第二个门禁');
  assert.ok(!/TRANSPORT_ERROR\s*=\s*\//.test(code), 'TRANSPORT_ERROR 仍在本地声明');
  assert.ok(/require\(['"]\.\.\/shared\/netClass['"]\)/.test(code), '没有改成消费中性模块');
});

test(' 引擎侧的认领只问判据，不再自己列一遍网络码', () => {
  const code = stripComments(read('src/main/downloadQueue.js'));
  assert.ok(/require\(['"]\.\.\/shared\/netClass['"]\)/.test(code), '下载引擎没接 netClass 判据');
  assert.ok(!/['"]NETWORK_(?:TIMEOUT|ERROR)['"]/.test(code),
    '引擎里不许再列一遍网络码字面量：清单的家在 netClass，抄一份就意味着两边会漂');
});

// ══════════════════════════════════════════════════════════
// 9：老语义不动（真调用，不是查源码）
// ══════════════════════════════════════════════════════════

test(' 迁移判据后 updateError 的说话口径一字未变', () => {
  const upd = require(path.join(ROOT, 'src/main/updateError.js'));
  // TLS 仍算"网络类"（该给手动下载入口），但文案说的是证书拦截而不是"稍后再试"
  assert.strictEqual(upd.isNetworkFailure({ message: 'net::ERR_CERT_REVOKED' }), true);
  assert.match(upd.describeUpdateError(new Error('net::ERR_CERT_REVOKED')), /证书校验挡住/);
  // 传输失败：措辞跟着「镜像是否已兜底」走
  assert.strictEqual(upd.isNetworkFailure({ message: 'read ECONNRESET' }), true);
  assert.match(upd.describeUpdateError(new Error('read ECONNRESET'), { mirrorTried: true }),
    /GitHub 直连与镜像源均已试过/);
  // 非网络错误原样返回：不许把 "Please check update first" 翻译成人畜无害的网络问题
  assert.strictEqual(upd.describeUpdateError(new Error('Please check update first')), 'Please check update first');
  assert.strictEqual(upd.isNetworkFailure({ message: 'Please check update first' }), false);
});
