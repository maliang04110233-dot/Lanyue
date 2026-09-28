/**
 * 更新失败时给出「🌐 打开下载页」按钮
 *
 * 起点是收尾时留下的那句文案：网络类失败弹窗写着
 * 「…或到 GitHub Releases 页面手动下载最新版本」——它让用户去一个页面，
 * 却没给任何入口。应用内没有地址栏，浏览器也不会自动停在那个页面上，
 * 于是这句话对 most users 等于没说。本增量把这句话变成一个可点的按钮。
 *
 * 三条不可让步的契约：
 *   A. URL 只有一个真源。仓库 2026-09-10 改过名（MusicDL → MM-Music-Destop），
 *      updater.js 顶部整段注释讲的就是"硬编码 feedURL 覆盖 app-update.yml"
 *      造成的事故。所以 Releases 页地址必须**派生自 app-update.yml**，
 *      与镜像 feed 同源（updateMirror.js 已经在解析 owner/repo）。
 *   B. 按钮只在"网络类失败"时出现。非网络错误（如 "Please check update first"）
 *      给一个下载页按钮是误导——真因不在网络，用户点了页面也解决不了。
 *   C. URL 绝不进 HTML。它是外部数据（打包资源里的 yml），而弹层走 innerHTML。
 *      按钮只带一个无值的 data-update-manual 标记，URL 存在模块变量里，
 *      点击委托从这里取 —— 注入面直接不存在，而不是"依赖某个 esc 记得被调用"。
 *      走委托而非内联 onclick 是 176/193 那条"内联桥不留"的纪律：内联桥在
 *      node 里根本测不到，本增量的行为测（下面「行为：…」两条）就是靠它才成立。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const esm = (rel) => import(`../${rel}?ck=${Math.random()}`);

const um = require(path.join(ROOT, 'src', 'main', 'updateMirror'));
const ue = require(path.join(ROOT, 'src', 'main', 'updateError'));

// ── A. URL 派生：与镜像 feed 同源，绝不新增第二处仓库名 ──────

test('buildReleasesPageUrl：owner/repo 派生出 releases 页地址', () => {
  assert.strictEqual(
    um.buildReleasesPageUrl({ owner: 'some-owner', repo: 'Some-Repo' }),
    'https://github.com/some-owner/Some-Repo/releases/latest',
  );
});

test('buildReleasesPageUrl：缺 owner 或 repo 一律不猜（宁可不给按钮）', () => {
  assert.strictEqual(um.buildReleasesPageUrl(null), null);
  assert.strictEqual(um.buildReleasesPageUrl({ owner: 'o' }), null);
  assert.strictEqual(um.buildReleasesPageUrl({ repo: 'r' }), null);
  assert.strictEqual(um.buildReleasesPageUrl({ owner: '', repo: 'r' }), null);
});

test('getReleasesPageUrl：从 app-update.yml 一路派生（就是打包产物里那份的形状）', () => {
  // 逐字对齐 release/win-unpacked/resources/app-update.yml：无引号、无注释、provider 在前。
  // 注：parseGithubFeed 的值正则不吃行尾注释，这是既有口径，手动下载入口不打算改它——
  // electron-builder 生成的就是干净两行，加容错等于给"手工改过的 yml"开需求。
  const yml = 'provider: github\nowner: maliang04110233-dot\nrepo: MM-Music-Destop\n';
  assert.strictEqual(um.buildReleasesPageUrl(um.parseGithubFeed(yml)),
    'https://github.com/maliang04110233-dot/MM-Music-Destop/releases/latest');
  // 带引号的写法解析器也吃（历史上手改过），派生结果一致
  assert.strictEqual(
    um.buildReleasesPageUrl(um.parseGithubFeed("provider: github\nowner: 'a'\nrepo: \"b\"\n")),
    'https://github.com/a/b/releases/latest');
  // provider 不是 github（比如整体切到 generic feed）时不派生，宁可不给按钮
  assert.strictEqual(um.parseGithubFeed('provider: generic\nurl: https://x/\n'), null);
  // 开发环境没有 resources/app-update.yml ⇒ 拿不到地址，按钮自然不出现
  assert.strictEqual(um.getReleasesPageUrl(), null);
});

// 守卫只查代码不查散文（retry.test.js 同口径）：updater.js 里那段"为什么删掉
// 硬编码 feedURL"的历史说明必须留着，不然下次又有人"顺手补回来"。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('守卫：仓库名字面量只许活在 build/config.cjs 的 publish 段', () => {
  // 5bf3fbc 之前那句 setFeedURL 硬编码就是这么把真源劈成两半的。旧名 MusicDL
  // 已有 retry.test.js 的守卫看着，这里补的是**现用名**——它一旦漏进 src，
  // 下次仓库改名又会重演一遍"每次检查先吃一个 301"。
  const offenders = [];
  const walk = (absDir, relDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const p = path.join(absDir, ent.name);
      const rel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) { walk(p, rel); continue; }
      if (!/\.(js|cjs|json|html)$/.test(ent.name)) continue;
      const src = stripComments(read(rel));
      const hits = (src.match(/MM-Music-Destop/g) || []).length;
      if (hits) offenders.push(`${rel}: ${hits}`);
    }
  };
  for (const d of ['src/main', 'src/renderer/js', 'src/shared']) walk(path.join(ROOT, d), d);
  assert.deepEqual(offenders, [], `更新源地址又长出第二份真源：\n${offenders.join('\n')}`);
});

// ── B. 什么时候给按钮：只有网络类失败 ─────────────────────

const TRANSPORT = ['net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT',
  'net::ERR_NAME_NOT_RESOLVED', 'read ECONNRESET', 'socket hang up'];
const TLS = ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR',
  'unable to verify the first certificate'];

test('isNetworkFailure：传输层 + 证书族都算"网络类"（这两族文案本来就指向手动下载）', () => {
  for (const m of TRANSPORT.concat(TLS)) {
    assert.strictEqual(ue.isNetworkFailure(new Error(m)), true, m);
  }
});

test('isNetworkFailure：非网络错误一律 false（给按钮会指错方向）', () => {
  for (const m of ['Please check update first',
    "No update filepath provided, can't quit and install",
    'Cannot parse update info from latest-macos.yml in the latest update resources']) {
    assert.strictEqual(ue.isNetworkFailure(new Error(m)), false, m);
  }
});

test('isNetworkFailure：脏入参不炸（null / undefined / 裸字符串 / 空对象）', () => {
  assert.strictEqual(ue.isNetworkFailure(null), false);
  assert.strictEqual(ue.isNetworkFailure(undefined), false);
  assert.strictEqual(ue.isNetworkFailure({}), false);
  assert.strictEqual(ue.isNetworkFailure('net::ERR_TIMED_OUT'), true, '字符串形态也要认（describeUpdateError 同口径）');
});

test('manualAvailable=true 时文案指向按钮，不再指向"用户自己去找页面"', () => {
  const withBtn = ue.describeUpdateError(new Error('net::ERR_CONNECTION_RESET'), { manualAvailable: true });
  assert.match(withBtn, /按钮|打开下载页/);
  assert.doesNotMatch(withBtn, /或到 GitHub/, '有按钮还叫用户自己去搜页面，等于没说');
  const withoutBtn = ue.describeUpdateError(new Error('net::ERR_CONNECTION_RESET'), { manualAvailable: false });
  assert.match(withoutBtn, /Releases|手动下载/, '没有按钮时必须保留原有的自助退路指引');
  // 开发环境 / yml 解析不出地址时根本不会渲染按钮，文案却指它 = 让用户对着空气找
  assert.doesNotMatch(withoutBtn, /按钮|打开下载页/, '没按钮的场合不许提按钮');
  assert.doesNotMatch(
    ue.describeUpdateError(new Error('net::ERR_CERT_AUTHORITY_INVALID'), { manualAvailable: false }),
    /按钮|打开下载页/, '证书族同口径');
});

test('证书类失败有按钮时同样指向按钮，且不劝"稍后再试"', () => {
  const out = ue.describeUpdateError(new Error('net::ERR_CERT_AUTHORITY_INVALID'), { manualAvailable: true });
  assert.match(out, /证书|代理|安全软件/);
  assert.match(out, /按钮|打开下载页/);
  assert.doesNotMatch(out, /稍后再试/);
});

// ── C. 渲染层纯函数：URL 不进 HTML ───────────────────────

test('buildUpdateFailure：有 manualUrl 才有按钮，返回值把 URL 交给调用方保管', async () => {
  const { buildUpdateFailure } = await esm('src/renderer/js/updateManual.js');
  const url = 'https://github.com/o/r/releases/latest';
  const r = buildUpdateFailure({ label: '检查失败', message: '网络连不上', manualUrl: url });
  assert.strictEqual(r.manualUrl, url);
  assert.match(r.html, /检查失败/);
  assert.match(r.html, /打开下载页/);
  assert.doesNotMatch(r.html, /github\.com|releases/, 'URL 绝不出现在 HTML 里');

  const none = buildUpdateFailure({ label: '下载失败', message: 'Please check update first', manualUrl: null });
  assert.strictEqual(none.manualUrl, null);
  assert.doesNotMatch(none.html, /打开下载页|<button/, '没有地址就不该有按钮');
  assert.match(none.html, /Please check update first/, '非网络错误原文照说');
});

test('buildUpdateFailure：message 走转义（更新服务器可控的文本进 innerHTML）', async () => {
  const { buildUpdateFailure } = await esm('src/renderer/js/updateManual.js');
  const r = buildUpdateFailure({ label: '更新失败', message: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(r.html, /<img/, '未转义即 XSS（CSP 带 unsafe-inline）');
  assert.match(r.html, /&lt;img/);
});

test('buildUpdateFailure：脏入参不炸，缺省 label 走「更新失败」', async () => {
  const { buildUpdateFailure } = await esm('src/renderer/js/updateManual.js');
  assert.doesNotThrow(() => buildUpdateFailure());
  assert.match(buildUpdateFailure({}).html, /更新失败/);
  assert.strictEqual(buildUpdateFailure({}).manualUrl, null);
});

// ── 行为：把 updater.js 真的挂进桩 DOM，走一遍"事件 → 按钮 → 点击" ──
//
// 静态守卫只能证明"代码长这样"，证明不了"点得动"。这里让主进程把 payload
// 交过来（update-error 事件），看按钮是否真的出现在弹层里、点击是否真的把
// 派生地址原样交给既有 open-external 通道。桩取 test/helpers/dom-stub.js
// 那个唯一的家（收口），本增量给它补的只是"任意 data-* 属性"。

async function mountUpdater() {
  const { makeDomStub } = await import('./helpers/dom-stub.js');
  const doc = makeDomStub();
  const opened = [];
  const handlers = {};
  globalThis.document = doc;
  globalThis.window = {
    ipcRenderer: { on: (ch, cb) => { handlers[ch] = cb; } },
    musicAPI: { openExternal: (u) => opened.push(u) },
  };
  // 全局桩要一直活到测试点完按钮（弹层是懒创建的），故由调用方负责 unmount
  await esm('src/renderer/js/updater.js');
  return {
    opened, handlers,
    unmount: () => { delete globalThis.document; delete globalThis.window; },
    host: () => doc.getElementById('update-toast-content'),
    manualButton: () => {
      const h = doc.getElementById('update-toast-content');
      return (h ? h.children : []).find(
        (c) => c.tag === 'button' && c.getAttribute('data-update-manual') !== null) || null;
    },
  };
}

test('行为：网络类失败事件 → 弹层里有按钮 → 点击把派生地址交给 openExternal', async () => {
  const up = await mountUpdater();
  try {
    // 两端都用真家伙：主进程那半算出的文案 + 地址，原样喂给渲染层
    const url = um.buildReleasesPageUrl({ owner: 'o', repo: 'r' });
    const msg = ue.describeUpdateError(new Error('net::ERR_CONNECTION_RESET'), { manualAvailable: true });
    up.handlers['update-error']({ message: msg, manualUrl: url });
    const btn = up.manualButton();
    assert.ok(btn, '失败弹层里必须解析出可点的手动下载按钮');
    assert.ok(/打开下载页/.test(btn.textContent), '按钮文案要说出它干什么');
    assert.strictEqual(btn.getAttribute('data-update-manual'), '',
      '标记必须无值：URL 一旦进属性就进了 HTML');
    btn.click();
    assert.deepEqual(up.opened, [url], '点击必须把地址原样交给既有 openExternal（零新通道）');
  } finally { up.unmount(); }
});

test('行为：没有地址（开发环境 / yml 解析不出）时按钮不出现，退路只剩文字', async () => {
  const up = await mountUpdater();
  try {
    const msg = ue.describeUpdateError(new Error('net::ERR_CONNECTION_RESET'), { manualAvailable: false });
    up.handlers['update-error']({ message: msg, manualUrl: null });
    assert.strictEqual(up.manualButton(), null, '没按钮可点时不许画一颗假按钮');
    assert.match(up.host().innerHTML, /Releases/, '自助退路指引仍以文字形式保留');
    assert.doesNotMatch(up.host().innerHTML, /https?:\/\//, '文字里也不许出现外部地址原文');
  } finally { up.unmount(); }
});

// ── 接线守卫：三条失败出口共用一个派生点 ─────────────────

test('守卫：update-error 仍是"方向钉、无参数表"，多带一个键不需要动契约', () => {
  // 本增量零新通道、零契约改动：payload 上多一个 manualUrl 之所以安全，
  // 全靠这条通道只钉方向不校验参数。哪天有人给它补 args 表，三处消费方都得跟着改。
  const line = read('src/shared/ipcContract.js')
    .split('\n').find((l) => l.includes("'update-error'"));
  assert.ok(line, 'update-error 通道必须还在契约里');
  assert.ok(!/args:/.test(line), '通道一旦加了参数表，本增量的 payload 形状要同步复核');
});

test('守卫：main/updater.js 用 isNetworkFailure + getReleasesPageUrl 派生入口', () => {
  const src = read('src/main/updater.js');
  // 用 ok+test 而不是 match：失败时不许把整个源文件印进输出（renderer-audit 的教训）
  assert.ok(/isNetworkFailure/.test(src), '按钮时机判据只能住在 updateError.js');
  assert.ok(/getReleasesPageUrl/.test(src), '地址只能住在 updateMirror.js（与镜像同源）');
  assert.ok(/updateError'\)/.test(src), '必须接 updateError');
  assert.ok(/updateMirror'\)/.test(src), '必须接 updateMirror');
  // 时机判据必须真的守在地址前面：只 import 不用等于没有（非网络错误也弹按钮 = 指错方向）
  assert.ok(/isNetworkFailure\([^)]*\)\s*\?\s*getReleasesPageUrl\(\)/.test(src),
    'manualUrl 必须是"网络类失败 ? 地址 : null"，换成无条件取地址本守卫要红');
});

test('守卫：三处失败出口（事件 + 检查 + 下载）都带上 manualUrl', () => {
  const src = read('src/main/updater.js').replace(/\r\n/g, '\n');
  const outlets = (src.match(/manualUrl/g) || []).length;
  assert.ok(outlets >= 3, `事件弹窗 + 检查返回值 + 下载返回值三处都要带，实际出现 ${outlets} 次`);
  // 措辞与 URL 必须同源派生，不许三处各写一遍条件
  assert.strictEqual((src.match(/manualFailureInfo\(/g) || []).length >= 3, true,
    '三处出口必须共用同一个派生函数，否则第二份判据必然漂移');
});

test('守卫：按钮只是无值标记，URL 与内联桥都不许出现', () => {
  const manual = stripComments(read('src/renderer/js/updateManual.js'));
  const src = stripComments(read('src/renderer/js/updater.js'));
  assert.ok(/data-update-manual/.test(manual), '按钮靠标记被委托认领');
  assert.ok(!/onclick/.test(manual), 'updateManual 里不许有内联 onclick（176/193 纪律）');
  assert.ok(!/https?:\/\//.test(manual), 'URL 不许出现在按钮模板里');
  assert.ok(!/window\.openUpdateManualPage/.test(manual + src),
    '全局函数桥是第二个可调用面，不留（反面写法只许出现在散文里）');
  assert.ok(/from '\.\/updateManual\.js'/.test(src), '失败内容只能由 updateManual 生成');
  assert.ok(/data-update-manual/.test(src) && /openExternal/.test(src),
    '点击走既有 open-external 通道，零新通道');
  // 事件通道才是主路径：主进程辛苦算出来的 manualUrl 若在这一步丢掉，按钮永远不出现
  assert.ok(/handleUpdateError\(\s*info\.message,\s*info\.manualUrl\s*\)/.test(src),
    'update-error 监听必须把 manualUrl 一起交给 handleUpdateError');
});

test('守卫：三处失败展示共用 showFailure 单点（不许再各拼一份 innerHTML）', () => {
  const src = read('src/renderer/js/updater.js');
  // 单点收口：buildUpdateFailure 只许被 showFailure 调一次，五个出口全走 showFailure
  assert.strictEqual((src.match(/buildUpdateFailure\(/g) || []).length, 1,
    'buildUpdateFailure 只许在 showFailure 里出现一次，多一处就是多一条判据');
  const calls = (src.match(/(?<!function )showFailure\(/g) || []).length;
  assert.ok(calls >= 3, `检查失败/下载失败/事件更新失败三处都要走它，实际 ${calls} 处`);
  for (const label of ['检查失败', '下载失败', '更新失败']) {
    assert.ok(new RegExp(`showFailure\\('${label}'`).test(src), `缺少 ${label} 出口`);
  }
  // 失败出口不许再直接 showUpdate(…error…)：只有 showFailure 能喂 innerHTML
  assert.ok(/function showFailure[\s\S]{0,160}showUpdate\(r\.html\)/.test(src),
    'showFailure 必须是唯一的失败内容落 DOM 通道');
});
