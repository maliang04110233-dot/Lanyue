/**
 * 更新镜像兜底模块的回归测试
 *
 * 背景：自动更新的检查/下载走 api.github.com + github.com，
 * 部分网络（实测国内机器）间歇性断连，检查 3 连败、121MB 资产必挂。
 * 兜底策略：直连失败后按 app-update.yml 的 owner/repo 派生镜像 feed
 * （generic provider + 前缀式镜像），仓库名不许硬编码进镜像模块——
 * 单一真源仍是 build/config.cjs 的 publish 段（retry.test.js 同源约束）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const m = require(path.join(ROOT, 'src', 'main', 'updateMirror'));

test('parseGithubFeed: 从 app-update.yml 文本解析 owner/repo', () => {
  const yml = "owner: some-owner\nrepo: some-repo\nprovider: github\nreleaseType: release\n";
  assert.deepStrictEqual(m.parseGithubFeed(yml), { owner: 'some-owner', repo: 'some-repo' });
});

test('parseGithubFeed: 缺字段 / 非 github provider / 空输入返回 null', () => {
  assert.strictEqual(m.parseGithubFeed('provider: generic\nurl: https://example.com'), null);
  assert.strictEqual(m.parseGithubFeed('owner: o\n'), null);
  assert.strictEqual(m.parseGithubFeed(''), null);
  assert.strictEqual(m.parseGithubFeed(null), null);
});

test('buildMirrorFeeds: 生成 generic feed，URL 指向镜像前缀 + releases/latest/download/', () => {
  const feeds = m.buildMirrorFeeds({ owner: 'o', repo: 'r' }, ['https://ghproxy.net/']);
  assert.strictEqual(feeds.length, 1);
  assert.strictEqual(feeds[0].provider, 'generic');
  assert.strictEqual(feeds[0].url, 'https://ghproxy.net/https://github.com/o/r/releases/latest/download/');
});

test('buildMirrorFeeds: feed 缺失返回空数组（开发环境无 app-update.yml 时自然降级）', () => {
  assert.deepStrictEqual(m.buildMirrorFeeds(null), []);
  assert.deepStrictEqual(m.buildMirrorFeeds({ owner: 'o' }), []);
});

// 带 publisherName 的 yml —— 签名校验真正生效的形态，信任闸门据此放行
const SIGNED_YML = [
  'owner: o',
  'repo: r',
  'provider: github',
  'publisherName: Example Corp',
  '',
].join('\n');

test('useMirrorFeed: 切 feed 同时关差分下载并固定 latest 通道', () => {
  const calls = [];
  const fake = { channel: null, disableDifferentialDownload: false, setFeedURL: (f) => calls.push(f) };
  const feed = { provider: 'generic', url: 'https://ghproxy.net/https://github.com/o/r/releases/latest/download/' };
  m.useMirrorFeed(fake, feed, { yml: SIGNED_YML });
  assert.deepStrictEqual(calls, [feed]);
  assert.strictEqual(fake.disableDifferentialDownload, true);
  assert.strictEqual(fake.channel, 'latest');
});

test('守卫：镜像模块不硬编码仓库名/账号名（真源只能是 app-update.yml）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updateMirror.js'), 'utf8');
  assert.doesNotMatch(src, /maliang|MM-Music-Destop/i, '镜像模块出现硬编码仓库标识');
});

test('守卫：updater.js 的检查与下载都接了镜像兜底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  const hits = src.match(/await tryMirrorFeeds\(/g) || [];
  assert.ok(hits.length >= 2, `镜像兜底须在检查+下载两处接线，实际 ${hits.length}`);
  assert.match(src, /require\('\.\/updateMirror'\)/, 'updater.js 必须接 updateMirror 模块');
});

/**
 * P0 守卫（2026-09 审计）：镜像兜底能成立的前提是安装包签名仍被校验。
 *
 * 历史事故：win 段曾显式写 verifyUpdateCodeSignature: false。第三方镜像
 * （ghproxy / gh.ddlc）本身就是「别人代为转发更新包」的中间人形态 ——
 * 再关掉签名校验，等于把「谁提供更新」的信任根交给链路，镜像被劫持即可
 * 静默安装未签名程序。本钉禁止这一项再被关掉。
 */
test('守卫：Windows 更新包签名校验必须开启（关掉 = 镜像兜底变成任意代码投递通道）', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'build', 'config.cjs'), 'utf8');
  assert.doesNotMatch(cfg, /verifyUpdateCodeSignature\s*:\s*false/,
    'win.verifyUpdateCodeSignature 被关掉了：第三方镜像 + 不校验签名 = 可静默安装任意程序');
  assert.match(cfg, /verifyUpdateCodeSignature\s*:\s*true/,
    '签名校验应显式置 true（显式优于依赖默认值，也防未来默认值变更）');
});

/**
 * ── 信任闸门（fail-closed）────────────────────────────────────
 *
 * 上面那条「签名校验必须开启」的守卫有个它自己看不见的漏洞：开关是 true，
 * 但**运行时根本没人消费它**。实测链路：
 *
 *   1. NsisUpdater.js:25 的 `set verifyUpdateCodeSignature` 全仓从未被调用；
 *      那个 true 只是构建期 app-builder-lib/out/winPackager.js:26 用来决定
 *      「要不要去算 publisherName」的提示位。
 *   2. 运行时的唯一闸门是 NsisUpdater.js:88 —— publisherName 取不到就
 *      `return null`，而调用方 :53 只在**非 null** 时才抛
 *      ERR_UPDATER_INVALID_SIGNATURE。null 的语义是「放行」。
 *   3. publisherName 只在配了代码签名证书时才会写进产物
 *      （PublishManager.js:202-207 依赖 windowsSignToolManager.computedPublisherName，
 *      无证书时为 null）。
 *
 * 本仓没有证书 ⇒ 产物 app-update.yml 无 publisherName ⇒ 签名校验空转。
 * 而镜像 feed 的 latest.yml（含 sha512）由镜像自己提供，校验自指；setFeedURL
 * 又不动 configOnDisk，所以镜像路径读的还是那份无 publisherName 的 yml。
 * 两者叠加 = 镜像成为「谁提供安装包谁说了算」的投递通道。
 *
 * 所以 useMirrorFeed 必须在无 publisherName 时拒绝切换。这就是下面这组用例。
 */
test('readPublisherName: 认出 publisherName，缺字段/空值都归 null', () => {
  assert.strictEqual(m.readPublisherName(SIGNED_YML), 'Example Corp');
  assert.strictEqual(m.readPublisherName("owner: o\nprovider: github\n"), null,
    '没有 publisherName 必须归 null —— 这正是「签名校验空转」的形态');
  assert.strictEqual(m.readPublisherName("publisherName: ''\n"), null, '空串不算有信任锚');
  assert.strictEqual(m.readPublisherName("publisherName:\n"), null);
  assert.strictEqual(m.readPublisherName(null), null);
});

test('isMirrorFeedTrusted: 有 publisherName 才算可信（fail-closed）', () => {
  assert.strictEqual(m.isMirrorFeedTrusted(SIGNED_YML), true);
  assert.strictEqual(m.isMirrorFeedTrusted('owner: o\nprovider: github\n'), false);
  assert.strictEqual(m.isMirrorFeedTrusted(null), false, '读不到 yml（开发环境）同样不可信');
  assert.strictEqual(m.isMirrorFeedTrusted(''), false);
});

test('信任闸门：无 publisherName 时 useMirrorFeed 抛错，且不碰 autoUpdater', () => {
  const calls = [];
  const fake = { channel: null, disableDifferentialDownload: false, setFeedURL: (f) => calls.push(f) };
  const feed = { provider: 'generic', url: 'https://ghproxy.net/https://github.com/o/r/releases/latest/download/' };
  assert.throws(
    () => m.useMirrorFeed(fake, feed, { yml: 'owner: o\nprovider: github\n' }),
    (err) => err instanceof m.UntrustedMirrorError && err.code === 'ERR_UPDATE_MIRROR_UNTRUSTED',
    '无 publisherName 必须拒绝切镜像 feed',
  );
  // 关键：不只是抛错，还必须「什么都没改」——半途改了一半的 autoUpdater
  // 会让后续直连/下载走在一个来路不明的 provider 上。
  assert.deepStrictEqual(calls, [], '闸门拦下时不得调用 setFeedURL');
  assert.strictEqual(fake.channel, null, '闸门拦下时不得改 channel');
  assert.strictEqual(fake.disableDifferentialDownload, false, '闸门拦下时不得改差分下载开关');
});

test('信任闸门自检：闸门真的接在 useMirrorFeed 上（不是写了没人调）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updateMirror.js'), 'utf8');
  const body = src.slice(src.indexOf('function useMirrorFeed'));
  assert.match(body, /isMirrorFeedTrusted\(/,
    'useMirrorFeed 里没有信任闸门调用 —— 无 publisherName 时会静默切到不可信镜像');
  assert.match(body, /throw new UntrustedMirrorError\(\)/,
    '闸门判定后没有抛错，fail-closed 不成立');
});

test('事实钉：当前产物 app-update.yml 无 publisherName ⇒ 镜像处于停用状态', () => {
  // 有意写成「事实钉」而非硬断言：采购证书后本用例会红，那是提醒把
  // docs/CODE_REVIEW_2026-09-28.md 的 P1-1 结论改成「已闭合」，
  // 并回来删掉 updateMirror.js 头注释里「在此之前镜像等价于半撤」那段。
  // 若照直硬断言「必须无 publisherName」，买了证书后 CI 会永久红灯 ——
  // 那正是本报告批评过的毛病：恒红的用例会训练团队忽略测试结果。
  const ymlPath = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app-update.yml');
  if (!fs.existsSync(ymlPath)) return; // 没打过包，无产物可查
  const publisherName = m.readPublisherName(fs.readFileSync(ymlPath, 'utf8'));
  assert.strictEqual(
    publisherName === null,
    true,
    `产物里出现了 publisherName（${publisherName}）—— 签名校验现在真的生效了，`
      + '请更新 docs/CODE_REVIEW_2026-09-28.md 的 P1-1 结论与 updateMirror.js 的注释。',
  );
});

test('守卫：setFeedURL 只允许出现在 updateMirror.js（防镜像源被硬编码注入）', () => {
  // 历史事故背景：updater.js 曾有一句硬编码仓库名的 setFeedURL 覆盖，
  // 与 app-update.yml 打架、每次检查先吃一个改名 301。retry.test.js 只守
  // updater.js 一个文件，而真正的 setFeedURL 在 updateMirror.js —— 攻击链
  // 最需要守的那一步恰好没被守。这里把作用域补到全仓。
  //
  // 扫描前必须剥注释：updater.js 的头注释里就大段讨论 setFeedURL（解释为什么
  // 不许它回来），不剥会把注释当命中。全仓扫字符串的守卫都有这个坑。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name !== 'node_modules' && name !== '.git') walk(p);
        continue;
      }
      if (!name.endsWith('.js')) continue;
      if (stripComments(fs.readFileSync(p, 'utf8')).includes('setFeedURL')) {
        hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(
    hits, ['src' + path.sep + 'main' + path.sep + 'updateMirror.js'],
    `setFeedURL 出现在这些文件里：${hits.join(', ')}`
      + ' —— 任何新增的 feed 覆盖都必须回到 updateMirror.js 走信任闸门',
  );
});

test('守卫：MIRROR_PREFIXES 保持记录值（加镜像前必须先过信任闸门评审）', () => {
  assert.deepStrictEqual(
    m.MIRROR_PREFIXES, ['https://ghproxy.net/', 'https://gh.ddlc.top/'],
    '镜像清单变了。新增镜像源会扩大「谁提供安装包谁说了算」的暴露面，'
      + '请先确认 useMirrorFeed 的信任闸门在生效（无 publisherName 时应拦下）。',
  );
});
