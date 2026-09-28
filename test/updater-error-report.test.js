/**
 * 单元测试：自动更新失败时的「说什么、什么时候说」（增量206）
 *
 * 为什么单独钉这一处（2026-09-21 用户截图）：
 *   弹窗显示「更新失败：net::ERR_CONNECTION_RESET」——两条独立缺陷叠出来的：
 *
 *   1. **说的时机是错的**。electron-updater 的 checkForUpdates() 每次失败都会
 *      emit('error') 然后再 reject（见 node_modules/electron-updater/out/
 *      AppUpdater.js:269-272）。而 updater.js 对一次用户主动检查会跑
 *      「直连×3 + 镜像×2」共 5 次尝试，`_userInitiated` 在整个流程里都是 true ——
 *      于是**第 1 次失败的瞬间**就往 UI 弹「更新失败」，而镜像兜底还在后台跑。
 *      截图里那句「更新失败：」正是事件路径的措辞（收尾路径的措辞是「检查失败：」），
 *      所以看到这句话的时候，流程根本还没走完，弹窗是在谎报最终结果。
 *
 *   2. **说的是内部码，不是人话**。describeUpdateError 的码表按 Node socket 码
 *      写的（ECONNRESET / ETIMEDOUT），但 Chromium 抛上来的是 net:: 名字：
 *      `net::ERR_CONNECTION_RESET` 里**不含**子串 `ECONNRESET`，一条都不匹配
 *      ⇒ 原样把内部 token 印给普通用户（实测九条常见 net:: 名，六条漏网）。
 *
 * 于是本文件钉住四条契约：
 *   A. 连通类错误（Node 码 + Chromium net:: 名）一律翻成可行动的中文；
 *   B. 证书/TLS 类错误单独说（让用户「稍后再试」是错的，重试不会改变结果）；
 *   C. 非网络错误原样返回（翻译它会掩盖真因）；
 *   D. 事件级错误只在「用户主动触发 且 我们自己的重试流程已收尾」时才打扰用户。
 * 外加两条接线守卫：文案与判据不许在 updater.js 里再存第二份。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ue = require(path.join(ROOT, 'src', 'main', 'updateError'));

/** 取一次文案（opts 可选） */
function say(message, opts) {
  return ue.describeUpdateError(new Error(message), opts);
}

// ── A. 连通类错误：必须翻成人话，且不许漏原始码 ──────────

test('net::ERR_CONNECTION_RESET 翻成人话（用户截图里那条，旧码表一条都不匹配）', () => {
  const out = say('net::ERR_CONNECTION_RESET');
  assert.match(out, /网络|连接/, '应是网络类可行动文案');
  assert.doesNotMatch(out, /ERR_CONNECTION_RESET/, '不许把内部错误码印给用户');
});

test('Chromium 与 Node 两套传输层错误名全覆盖（漏一条就是一个截图里的裸码）', () => {
  const transport = [
    // Chromium（net:: 前缀形态，实测来自 electron 的 net 层）
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_ABORTED',
    'net::ERR_TIMED_OUT',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_SOCKET_NOT_CONNECTED',
    // Node socket 码（镜像走 https 时抛的是这一族）
    'connect ETIMEDOUT',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo EAI_AGAIN api.github.com',
    'getaddrinfo ENOTFOUND github.com',
    'socket hang up',
  ];
  for (const msg of transport) {
    const out = say(msg);
    assert.match(out, /网络|连接/, `未翻译：${msg} → ${out}`);
    assert.doesNotMatch(out, /ERR_[A-Z_]+|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/,
      `原始码泄漏：${msg} → ${out}`);
  }
});

test('连通类文案给出「不依赖自动更新」的退路（用户能自己走完下载）', () => {
  assert.match(say('net::ERR_CONNECTION_RESET'), /Releases|手动下载/);
});

// ── B. 证书/TLS 类：单独说，且不许劝人「稍后再试」 ────────

test('证书/TLS 错误指向代理或安全软件，而不是劝用户稍后再试', () => {
  for (const msg of [
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'unable to verify the first certificate',
  ]) {
    const out = say(msg);
    assert.match(out, /证书|代理|安全软件/, `未归类到证书分支：${msg} → ${out}`);
    assert.doesNotMatch(out, /稍后再试/, `重试无用却让用户重试：${msg} → ${out}`);
  }
});

// ── C. 非网络错误：原样返回 ──────────────────────────────

test('非网络错误原样返回（翻成"网络问题"会掩盖真因）', () => {
  for (const msg of [
    'Please check update first',
    'No update filepath provided, can\'t quit and install',
    'Cannot parse update info from latest-macos.yml in the latest update resources',
  ]) {
    assert.strictEqual(say(msg), msg);
  }
});

test('缺 message / 传字符串 / 传 null 都不抛异常', () => {
  assert.strictEqual(typeof say(undefined), 'string');
  assert.strictEqual(ue.describeUpdateError('net::ERR_CONNECTION_RESET'),
    say('net::ERR_CONNECTION_RESET'));
  assert.strictEqual(ue.describeUpdateError(null), '');
  assert.strictEqual(ue.describeUpdateError({}), '');
});

// ── 镜像兜底跑过后，措辞必须跟着变（否则「已自动重试多次」是假话） ──

test('mirrorTried=true 时说明直连与镜像都试过', () => {
  const out = say('net::ERR_CONNECTION_RESET', { mirrorTried: true });
  assert.match(out, /镜像/);
  assert.doesNotMatch(out, /自动重试多次/);
});

test('mirrorBlocked 时不得声称试过镜像（压根没试，说了就是假话）', () => {
  // 镜像是被信任闸门拦下的（产物无 publisherName ⇒ 签名校验空转 ⇒ 镜像不可信），
  // 那种情况下 tryMirrorFeeds 一次都没真去请求镜像。若沿用「GitHub 直连与镜像源
  // 均已试过」，用户会以为镜像也排除过了 —— 事实并非如此，这是本文案纪律最在意的一类错。
  const out = say('net::ERR_CONNECTION_RESET', { mirrorTried: false, mirrorBlocked: true });
  assert.doesNotMatch(out, /均已试过/, '镜像是被闸门拦下的，不能说「均已试过」');
  assert.doesNotMatch(out, /镜像源均/, '同上');
  assert.match(out, /未做代码签名/, '应说明镜像是因未做代码签名而未启用');
  assert.match(out, /未启用/);
});

test('mirrorBlocked 优先于 mirrorTried（两个都传时以 blocked 为准）', () => {
  const out = say('net::ERR_CONNECTION_RESET', { mirrorTried: true, mirrorBlocked: true });
  assert.doesNotMatch(out, /均已试过/, 'blocked 与 tried 语义互斥，blocked 优先');
  assert.match(out, /未启用/);
});

test('mirrorBlocked 时手动下载入口照给（那是唯一走得通的路）', () => {
  const withBtn = say('net::ERR_CONNECTION_RESET', { mirrorBlocked: true, manualAvailable: true });
  assert.match(withBtn, /打开下载页/, '镜像不可用时手动下载更重要，不该省掉按钮');
  const noBtn = say('net::ERR_CONNECTION_RESET', { mirrorBlocked: true, manualAvailable: false });
  assert.match(noBtn, /GitHub Releases 页面手动下载/, '无按钮时退回页面指引，不得指向不存在的按钮');
});

test('未走镜像时不提镜像（不提发生过的事，也不漏说重试过）', () => {
  const out = say('net::ERR_CONNECTION_RESET');
  assert.doesNotMatch(out, /镜像/);
  assert.match(out, /重试/);
});

// ── D. 事件级错误的上报时机 ──────────────────────────────

test('受控流程在飞时，事件级错误不许打扰用户（截图里那次弹窗就是它）', () => {
  assert.strictEqual(
    ue.shouldReportEventError({ userInitiated: true, flowInFlight: true }),
    false,
    '直连第 1 次失败时镜像兜底还在跑，此刻弹"更新失败"是谎报最终结果',
  );
});

test('shouldReportEventError 真值表：只有"用户主动 + 流程已收尾"才报', () => {
  assert.strictEqual(
    ue.shouldReportEventError({ userInitiated: true, flowInFlight: false }), true,
    '流程收尾后仍有事件级错误（如 quitAndInstall 失败）必须让用户知道');
  assert.strictEqual(
    ue.shouldReportEventError({ userInitiated: false, flowInFlight: false }), false,
    '启动时的静默自检失败不许弹窗');
  assert.strictEqual(
    ue.shouldReportEventError({ userInitiated: false, flowInFlight: true }), false);
  assert.strictEqual(ue.shouldReportEventError({}), false, '缺字段一律不打扰用户');
  assert.strictEqual(ue.shouldReportEventError(null), false);
});

// ── 接线守卫：判据只能有一份真源 ─────────────────────────

function readUpd() {
  return fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8').replace(/\r\n/g, '\n');
}

test('守卫：updater.js 接了 updateError，且不再自带第二份文案函数', () => {
  const src = readUpd();
  assert.match(src, /require\('\.\/updateError'\)/, 'updater.js 必须接 updateError 模块');
  assert.doesNotMatch(src, /function describeUpdateError/,
    '文案函数只能住在 updateError.js，两处各一份必然漂移');
});

// 增量216 之后，"把 mirrorTried 传给文案函数"这件事收进了 manualFailureInfo 一处
// （三条出口还要各自带上 manualUrl，各写一遍 opts 必然漂移）。这里钉的是同一条
// 纪律的当前形态：文案派生只有一个调用点，两个事实参数都在那里传。
test('守卫：文案派生只有一个调用点，mirrorTried 与 manualAvailable 都在那里传', () => {
  const src = readUpd();
  assert.ok(src.includes('mirrorTried: _mirrorTried'),
    '措辞必须跟着"这轮是否真试过镜像"的事实走');
  assert.ok(src.includes('manualAvailable: !!manualUrl'),
    '措辞也必须跟着"下载页按钮到底在不在"的事实走');
  assert.strictEqual((src.match(/describeUpdateError\(/g) || []).length, 1,
    '文案派生只许一个调用点，第二份判据必然漂移');
});

test('守卫：error 监听必须经过 shouldReportEventError 判定', () => {
  const src = readUpd();
  const start = src.indexOf("autoUpdater.on('error'");
  assert.notStrictEqual(start, -1, '未找到 error 监听');
  const end = src.indexOf('\n});', start);
  assert.notStrictEqual(end, -1, 'error 监听未正常闭合');
  const listener = src.slice(start, end);
  assert.match(listener, /shouldReportEventError/,
    'error 监听不许无条件弹窗');
  assert.match(listener, /flowInFlight/, '判定必须把"流程在飞"传进去');
});

test('守卫：检查与下载两条流程都维护 flowInFlight（进出都要置位）', () => {
  const src = readUpd();
  const sets = (src.match(/_flowInFlight\s*=\s*true/g) || []).length;
  const clears = (src.match(/_flowInFlight\s*=\s*false/g) || []).length;
  assert.ok(sets >= 2, `检查+下载两处都要置 true，实际 ${sets}`);
  assert.ok(clears >= 2, `两处都要在 finally 里复位，实际 ${clears}`);
});
