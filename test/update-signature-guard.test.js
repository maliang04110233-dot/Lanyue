/**
 * 守卫：更新签名校验的「真实状态」必须与记录一致
 *
 * ── 为什么需要这条测试 ────────────────────────────────────────
 *
 * 2026-09 审计把 build/config.cjs 的 verifyUpdateCodeSignature 从 false 改回
 * true，并在注释里写明理由：「配合第三方镜像兜底（ghproxy / gh.ddlc），
 * 关掉等于把信任根交给中间人」。这条加固本身是对的。
 *
 * 但 2026-09-28 复审发现：**开关是开的，防线却是空转的**。三条证据：
 *
 *   1. electron-updater 的校验（NsisUpdater.js:84-99）先读 app-update.yml 的
 *      publisherName，取不到就直接 `return null`；
 *   2. 调用方（同文件 :52-56）只在返回值**非 null** 时才抛
 *      ERR_UPDATER_INVALID_SIGNATURE —— 即 null 的语义是「无签名信息 → 放行」；
 *   3. 实测打包产物 resources/app-update.yml 里根本没有 publisherName，
 *      且 Get-AuthenticodeSignature 对安装包返回 NotSigned。
 *
 * 根因是本仓库没有任何签名证书配置（certificateFile 等），electron-builder
 * 因此不会写入 publisherName，verifyUpdateCodeSignature 就没有可校验的对象。
 *
 * 危害不是「少了一层防护」这么轻 —— 而是注释与提交信息都写着「P0 已修复」，
 * 后续维护者会据此**误判风险已关闭**，于是镜像兜底继续留着、证书也一直不买。
 * 这种「声称已修、实际没修」的静默落差，比明摆着的缺口更难发现。
 *
 * ── 本测试的设计（为什么不是「直接断言必须有证书」）─────────────
 *
 * 「verifyUpdateCodeSignature 为 true ⇒ 必须有签名配置」这条断言在**当下是
 * 假的**（没有证书）。若照直写成硬断言，CI 会永久红灯 —— 那正是本报告批评
 * 过的毛病：恒红的用例会训练团队忽略测试结果，真实回归就混在里面被无视。
 *
 * 所以这里改成**事实钉（fact pin）**：把当前真实状态显式记录下来
 * （RECORDED_STATE），断言配置与记录一致。效果是 ——
 *
 *   · 现在：绿。且「开关开着但不生效」这件事被写进代码，不再只活在注释里；
 *   · 任何人加了证书：测试红，提示把 codeSigningConfigured 改为 true，
 *     顺带逼他回来清理文档里「尚未生效」的措辞；
 *   · 任何人把开关改成 false：测试红（P0 回归，与增量 209 的结论冲突）；
 *   · 任何人删掉证书配置：测试红。
 *
 * 也就是说，风险状态**不可能被静默改变**。这正是「防止将来再误判」的落点。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'build', 'config.cjs');

/**
 * electron-builder 里「配置了代码签名」的键。
 * 只要出现任意一个，构建产物就会被签名，publisherName 随之进入 app-update.yml。
 * cert 路径可以是外部文件（certificateFile）或证书库主体名（certificateSubjectName），
 * 另有 signtoolOptions / azureSignOptions 两种封装形态（electron-builder 24+）。
 */
const CODE_SIGNING_KEYS = [
  'certificateFile',
  'certificateSubjectName',
  'certificateSha1',
  'certificatePassword',
  'cscLink',
  'signtoolOptions',
  'azureSignOptions',
];

function loadConfig() {
  // 每次全新 require，避免其他测试的缓存干扰
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

/** 配置里是否真的存在代码签名配置（win 段与顶层都查） */
function detectCodeSigning(cfg) {
  const scopes = [cfg, cfg && cfg.win, cfg && cfg.build, cfg && cfg.build && cfg.build.win];
  const found = [];
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'object') continue;
    for (const k of CODE_SIGNING_KEYS) {
      if (scope[k] !== undefined && scope[k] !== null && scope[k] !== '') found.push(k);
    }
  }
  return { configured: found.length > 0, keys: found };
}

/**
 * 当前记录的**真实状态**。
 *
 * ⚠️ 这三行是「事实」不是「期望」：它们描述今天的世界长什么样。
 *    任何一个字段与现实不符，下面的测试就会红 —— 那是在提醒你：
 *    更新签名这件事的实际状态变了，请同步修改这里，并回头核对
 *    docs/CODE_REVIEW_2026-09-28.md 的 P1-1 结论与 build/config.cjs 的注释。
 */
const RECORDED_STATE = {
  /** build/config.cjs 里这一项当前是开着的（增量 209 的 P0 加固，不得回退） */
  verifyUpdateCodeSignature: true,
  /** 当前仓库**没有**配置代码签名证书 */
  codeSigningConfigured: false,
  /**
   * 因此校验**实际不生效**：无证书 ⇒ 无 publisherName ⇒ electron-updater
   * 拿到 null 直接放行。这一格是上面两格的推论，单列出来是为了让
   * 「开关开着」与「防线有效」这两件常被混为一谈的事在代码里就分开。
   */
  verificationEffective: false,
};

test('事实钉：verifyUpdateCodeSignature 开关本身必须是开着的', () => {
  const cfg = loadConfig();
  assert.ok(cfg.win, 'build/config.cjs 缺少 win 段');
  assert.strictEqual(
    cfg.win.verifyUpdateCodeSignature,
    RECORDED_STATE.verifyUpdateCodeSignature,
    'verifyUpdateCodeSignature 被改动。这一项是 2026-09 审计 P0：'
      + '关掉它等于配合第三方镜像兜底把更新包的信任根交给中间人。'
      + '若确实要改，请先读 build/config.cjs:112-117 的说明并同步本测试的记录。',
  );
});

test('事实钉：是否配置了代码签名，与记录一致', () => {
  const cfg = loadConfig();
  const { configured, keys } = detectCodeSigning(cfg);
  assert.strictEqual(
    configured,
    RECORDED_STATE.codeSigningConfigured,
    configured
      ? `检测到签名配置（${keys.join(', ')}）—— 真实状态变了！请把 RECORDED_STATE.codeSigningConfigured `
        + '改为 true、verificationEffective 改为 true，并清理 build/config.cjs 注释与 '
        + 'docs/CODE_REVIEW_2026-09-28.md 里「尚未生效 / 已知未闭合」的措辞。'
      : '签名配置消失了。若是有意移除（例如改为仅用官方渠道分发），请同步更新本测试的记录与相关文档；'
        + '若是误删，请恢复。',
  );
});

test('事实钉：校验是否真正生效，与记录一致（开关 ∧ 有证书）', () => {
  const cfg = loadConfig();
  const { configured } = detectCodeSigning(cfg);
  const effective = cfg.win.verifyUpdateCodeSignature === true && configured;
  assert.strictEqual(
    effective,
    RECORDED_STATE.verificationEffective,
    '更新签名校验的**有效性**变了。当前记录的结论是「不生效」：'
      + '无证书 ⇒ app-update.yml 无 publisherName ⇒ electron-updater 取到 null 后放行。'
      + '如果它现在真的生效了，请更新本测试记录并撤销 P1-1 结论；'
      + '如果它变得比记录的更弱，请立刻处置。',
  );
});

test('守卫自检：detectCodeSigning 真的能识别签名配置（正则/取值写坏了会静默失效）', () => {
  assert.strictEqual(detectCodeSigning({ win: {} }).configured, false, '空 win 段不应命中');
  assert.strictEqual(detectCodeSigning({}).configured, false, '空配置不应命中');
  assert.strictEqual(
    detectCodeSigning({ win: { certificateFile: 'cert.pfx' } }).configured, true,
    'certificateFile 必须被识别（否则守卫形同虚设）',
  );
  assert.strictEqual(
    detectCodeSigning({ win: { certificateSubjectName: 'CN=Example' } }).configured, true,
    'certificateSubjectName 必须被识别',
  );
  assert.strictEqual(
    detectCodeSigning({ win: { signtoolOptions: { certificateFile: 'x.pfx' } } }).configured, true,
    'signtoolOptions 形态（electron-builder 24+）必须被识别',
  );
});

test('守卫：electron-updater 的 null 放行语义未被上游改变', () => {
  // 本测试的前提是「publisherName 取不到 ⇒ 校验放行」。这个前提住在依赖源码里，
  // 依赖升级可能悄悄改掉它 —— 那时 P1-1 的分析就需要重做。故在此钉住。
  const src = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'electron-updater', 'out', 'NsisUpdater.js'), 'utf8',
  );
  assert.match(
    src,
    /publisherName\s*==\s*null[\s\S]{0,80}?return null;/,
    'electron-updater 不再「publisherName 为空则 return null」——'
      + '上游语义已变，必须重做 P1-1 的结论（见 docs/CODE_REVIEW_2026-09-28.md）',
  );
  assert.match(
    src,
    /signatureVerificationStatus\s*!=\s*null/,
    '校验结果的处理分支已变（原为「非 null 才抛错」，即 null 表示放行）',
  );
});

test('守卫：package.json 不得有 build 段（裸跑 electron-builder 会产出无签名开关的包）', () => {
  // 这里曾有一个 `"build": { "extends": null }`。今天无害 —— 4 处调用都带
  // `--config build/config.cjs`。但它是一颗哑弹：任何人（包括 CI 里手改的脚本、
  // 或者本地 `npx electron-builder`）漏掉 --config，就会用这份 config 打出
  // **无 publish 段、无 verifyUpdateCodeSignature** 的包 —— 正好是 P1-1 描述的
  // 最坏状态，而且完全静默。所以整段删掉，让 electron-builder 直接报错而不是
  // 悄悄降级。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(
    pkg.build, undefined,
    'package.json 不该有 build 段：electron-builder 会优先读它，'
      + '导致漏 --config 时静默打出无 publish / 无签名校验开关的包。'
      + '打包配置的唯一真源是 build/config.cjs。',
  );
});

test('守卫：所有 electron-builder 调用都显式带 --config build/config.cjs', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const scripts = JSON.parse(read('package.json')).scripts;
  const callers = Object.entries(scripts).filter(([, cmd]) => /electron-builder/.test(cmd));
  assert.ok(callers.length > 0, '没找到 electron-builder 调用点 —— 是脚本改名了吗？');
  for (const [name, cmd] of callers) {
    // install-app-deps 是子命令，不需要 config
    if (/\binstall-app-deps\b/.test(cmd)) continue;
    assert.match(
      cmd, /--config\s+build\/config\.cjs/,
      `npm run ${name} 调 electron-builder 却没带 --config build/config.cjs`,
    );
  }
  const ci = read(path.join('.github', 'workflows', 'ci.yml'));
  // 跳过注释行：ci.yml 的头注释里大段讨论 electron-builder，不剥会把注释当调用点
  const ciCalls = ci.split('\n')
    .map((l) => l.replace(/^\s*#.*$/, ''))
    .filter((l) => /electron-builder/.test(l) && !/install-app-deps/.test(l));
  for (const line of ciCalls) {
    assert.match(line, /--config\s+build\/config\.cjs/, `CI 里有一行 electron-builder 漏了 --config: ${line.trim()}`);
  }
});
