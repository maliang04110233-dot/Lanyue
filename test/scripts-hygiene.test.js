/**
 * scripts-hygiene.test.js — 增量223：scripts/ 不许留一次性重放脚本，判据模块必须可测
 *
 * 背景：scripts/ 长期是「什么都往里扔」的地带，而它同时是**没人看**的地带 ——
 * `npm run lint` 只扫 `src/ test/`，.github/workflows 里也没有任何一条针对 scripts/
 * 的检查。于是一次性脚本留在里面有两个后果，且都不会报警：
 *   ① 任何人误跑一次就可能**二次改写已经迁完的产物**（实测过的例子：
 *      _migrate-playlist-i18n.js 会就地重写 views/playlist.js + 两份语言包 +
 *      test/toast-i18n.test.js；文件头自己写着 "Run once"）；
 *   ② 里面的逻辑既不过 lint 也不过门禁，改坏了没人知道。
 * 本批随缺陷 6 删掉两个（_dump-feedback.js / _migrate-playlist-i18n.js，迁移
 * 早已完成、git 历史里有；前者还带一份与 test/toast-i18n.test.js 几乎逐字重复的
 * stripComments/skipString/firstArg/hardcodedLiterals，删掉即消解）。
 *
 * 本测试把「删掉」升级成「删了不许再回来」，三条：
 *   ① scripts/ 下不许有 `_` 前缀的文件（一次性脚本的老命名法）；
 *   ② 任何 scripts/*.js|cjs 的头注释自述「跑一次 / 调试用 / 用完即删」即红；
 *   ③ 凡是自己 `module.exports` 出来的判据模块，必须至少被一个 test/ 下的文件
 *      require —— 否则它等于「有判据但没人能测」，正是 191 立的那条律。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const listScripts = () => fs.readdirSync(SCRIPTS, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name);

test('scripts/ 下没有 `_` 前缀的一次性脚本（跑一次的脚本不留在仓库里）', () => {
  const once = listScripts().filter((n) => n.startsWith('_'));
  assert.deepEqual(once, [],
    `这些是留着重放的一次性脚本：${once.join(', ')}。迁移已完成、git 历史里有，直接删掉`);
});

test('scripts/*.js|cjs 头注释不许自述「跑一次 / 调试用 / 用完即删」', () => {
  // 自述即证据：这类脚本留在仓库里，唯一的用途就是被人误跑。
  // 真需要长期存在的调试工具，请挂进 package.json 的 scripts 或写成 .cjs + 配套测试。
  const SELF_TOLD = /Run\s+once|一次性脚本|调试脚本|用完即删|跑一次就删|临时脚本/i;
  const offenders = [];
  for (const n of listScripts()) {
    if (!/\.(js|cjs)$/.test(n)) continue;
    const head = fs.readFileSync(path.join(SCRIPTS, n), 'utf8').slice(0, 1200);
    if (SELF_TOLD.test(head)) offenders.push(n);
  }
  assert.deepEqual(offenders, [],
    `这些脚本自述是一次性的，留着就等着被误跑：${offenders.join(', ')}`);
});

test('门禁判据模块必须被某个测试 require（否则「有判据但没人能测」）', () => {
  // 判据住在顶层就 process.exit() 的脚本里 = 永远没有自测。这条已在本批栽过两次：
  // smoke-asar.js（增量192 抽出 smoke-checks.cjs）与 check-dead-deps.cjs（增量223 加
  // require.main 守卫 + 导出）。名单写死是刻意的：判据模块就这两个，全仓扫描式地
  // 猜「哪个算判据」只会把 gen-icon.js 这类纯入口脚本也拖进来（它导出的是被主流程
  // 直接调的绘图函数，不经任何断言），而它们不在本批的管辖范围内。
  const testsDir = path.join(ROOT, 'test');
  const testSrc = fs.readdirSync(testsDir)
    .filter((n) => n.endsWith('.js'))
    .map((n) => fs.readFileSync(path.join(testsDir, n), 'utf8'))
    .join('\n');
  for (const n of ['check-dead-deps.cjs', 'smoke-checks.cjs']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, n)), `${n} 不在了，请同步改这条名单`);
    assert.ok(testSrc.includes(n), `${n} 是门禁判据却没有任何测试 require 它 —— 判据自己坏掉时没人知道`);
  }
});

test('判据模块导出的每个名字都得在本文件里真有定义（打错字 = 导出 undefined）', () => {
  // module.exports = { staticRefsIn } 里写错一个字母，消费者拿到 undefined，
  // 症状是「测试莫名其妙挂在别的地方」，而导出面看起来永远是绿的。
  for (const n of ['check-dead-deps.cjs', 'smoke-checks.cjs']) {
    const src = read('scripts', n);
    const block = /module\.exports\s*=\s*\{([\s\S]*?)\}/.exec(src);
    assert.ok(block, `${n} 没有 module.exports（判据没法被测）`);
    const names = block[1].split(',')
      .map((s) => s.trim().split(':')[0].trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    assert.ok(names.length >= 3, `${n} 的导出面只认出 ${names.length} 个名字，取法可能坏了`);
    const missing = names.filter((name) => !new RegExp(
      `(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b)`, 'm').test(src));
    assert.deepEqual(missing, [], `${n} 导出了未定义的名字：${missing.join(', ')}`);
  }
});
