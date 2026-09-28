/**
 * dead-deps-scanner.test.js — check-dead-deps 的源码扫描器自带自测
 *
 * 为什么必须补：scripts/check-dead-deps.cjs 的判据此前**一条自测都没有**，而它是
 * 「asar 排除项还能不能继续排除」的唯一守门人。判据自己坏掉时的症状极其恶劣 ——
 * 不是变红，是**变绿**：扫不到引用就报「排除仍然安全」，于是一颗真的在运行时被
 * require 的包被从 asar 里剔掉、npm 构建照样成功、绝大部分测试照样通过，用户拿到
 * 的 exe 上某个功能报 Cannot find module。假绿比假红贵得多。
 *
 * 具体踩过的两枚（都在同一次改动里一起修掉）：
 *   ① 注释里的 `require('jade')` 举例被当成真引用。写一句「运行时从不
 *      require('jade)」就足以把 CI 弄红，而全仓没有任何一行真的 require 过它 ——
 *      排除项其实仍然安全，却没人敢再碰。31 个排除项此前一个都没撞上，纯属侥幸。
 *   ② DYN_SEG（动态 require 整段抽字面量）把 `require(Buffer.from('x'))` 里的
 *      'x' 当成包名：pkgOf 对任何非内置裸串原样返回，于是 'x' 成了一个「第三方包」。
 *      顺带「字符串里含 require(」（文案/正则里出现这段文本）也照扫不误。
 *
 * 样本里一律用 **jade**：它是真的在 build/config.cjs 的 31 个排除项里，所以
 * 「误报」在这里不是假设，而是会真的把 `npm run check:dead-deps` 弄红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { codeMask, pkgOf, staticRefsIn, excludedPackages } = require('../scripts/check-dead-deps.cjs');

const FILE = path.join('src', 'main', 'ipc', 'library.js');
const refsOf = (src) => [...staticRefsIn(src, FILE)].sort();

/** 取某一段在掩码里是否算「真代码」 */
const isCode = (src, needle) => {
  const at = src.indexOf(needle);
  assert.ok(at > -1, `样本里找不到 ${needle}`);
  return codeMask(src)[at] === 1;
};

// ── 前置：样本必须真的对准一个排除项，否则下面几条测的不是真东西 ──
test('自检：jade 确实在 build/config.cjs 的排除清单里（误报它 = CI 真的会红）', () => {
  assert.ok(excludedPackages().has('jade'), 'jade 不再被排除，本文件的样本失去意义，请换一个真实排除项');
  assert.ok(excludedPackages().size >= 30, '排除清单异常少，取法可能坏了');
});

// ── 掩码本身 ──────────────────────────────────────────

test('codeMask：注释与字面量正文不是代码，定界符与真代码是', () => {
  // String.raw：正则里的反斜杠必须原样进样本，写成普通字符串就得数四层转义，
  // 数错一层这条测试就在测另一个字符串（第一版就是这么自己瞎绿的）。
  const reLine = String.raw`const re = /\/\/require\('jade'\)/;`;
  const src = [
    "const a = require('jade'); // 注释里的 require('jade')",
    "/* 块注释 require('jade') */",
    'const s = "文案里的 require(\'jade\') 文本";',
    reLine,
  ].join('\n');
  const m = codeMask(src);
  assert.equal(m[src.indexOf('const a')], 1, '真代码应是代码');
  assert.equal(m[src.indexOf('// 注释')], 0, '行注释不是代码');
  assert.equal(m[src.indexOf('/* 块注释')], 0, '块注释不是代码');
  assert.equal(m[src.indexOf('"文案里')], 1, '引号本身是代码（实参要从原文读出来）');
  assert.equal(m[src.indexOf('文案里')], 0, '字符串正文不是代码');
  // 正则这条最容易写错：正文里有一处字面的 //，不跳正则就会被当成行注释，
  // 后面那一整行（含收尾的 /;）全被吃掉 —— 于是真代码被误判成注释（假阴性）。
  const at = src.indexOf(reLine);          // reLine 的下标是行内的，别拿它去索引整段的掩码
  const open = reLine.indexOf('/');
  assert.equal(m[at + open], 1, '正则定界符是代码');
  assert.equal(m[at + open + 1], 0, '正则正文不是代码');
  assert.equal(m[src.length - 1], 1, '行尾的 ; 仍是代码（正则若被误当注释，这里会是 0）');
  assert.deepEqual(refsOf(src), ['jade'], '整段只有第一行那条真引用');
});

test('codeMask：模板字面量正文不是代码，${ } 里是代码（插值里真的 require 得扫到）', () => {
  const src = 'const s = `提示 require(\'jade\') 之类 ${await import(\'jade\')}`;';
  assert.equal(isCode(src, '提示'), false, '模板正文不是代码');
  assert.equal(isCode(src, 'await import'), true, '${ } 插值内部是代码');
  assert.deepEqual(refsOf(src), ['jade'], '插值里的 import 仍应被扫到；模板正文里那处不算引用');
});

// ── ① 注释 / 字符串里的 require 不算引用 ────────────────

test('注释里的 require(\'jade\')（行注释 / 块注释 / JSDoc）一律不算引用', () => {
  const src = [
    "// 运行时从不 require('jade')，所以它可以留在排除清单里",
    "/*",
    " * 历史包袱：曾经 require('jade') 渲染模板。",
    " */",
    '/**',
    " * @example require('jade')",
    ' */',
    "const ok = 1;",
  ].join('\n');
  assert.deepEqual(refsOf(src), [], '注释被当成了代码 —— 任何人写一句举例就能把 CI 弄红');
  // 反向钉：同一段里放一行真 require，必须仍然被扫到（防「一刀切全过滤」）
  assert.deepEqual(refsOf(src + "\nrequire('jade');\n"), ['jade'], '真代码里的 jade 反倒没扫到');
});

test('字符串里的 require(\'jade\') 不算引用（文案 / 正则 / 模板串）', () => {
  const src = [
    'const a = "用法：require(\'jade\')";',
    'const b = `模板里的 require(\'jade\')`;',
    "const re = /require\\('jade'\\)/;",
    'const c = 1;',
  ].join('\n');
  assert.deepEqual(refsOf(src), [], '字符串里的 require 被当成了真引用');
});

test('动态 require 的字面量只认顶层实参：Buffer.from(\'jade\') 的 jade 不是包名', () => {
  assert.deepEqual(refsOf("const id = require(Buffer.from('jade')).toString('hex');"), [],
    "'jade' 是 Buffer.from 的实参，不是模块名 —— 报出去就是一个凭空捏造的包");
  assert.deepEqual(refsOf("const p = require(path.join(PLATFORMS_DIR, 'jade')); "), [],
    "path.join 的实参同理");
});

test('动态 require 的顶层字面量仍算引用（真·惰性加载不许被这道过滤误伤）', () => {
  assert.deepEqual(refsOf("const mod = require(dep || 'jade');"), ['jade'],
    '模块名就在 require 的实参里，必须抓到');
  assert.deepEqual(refsOf("const { x } = require(cond ? 'jade' : 'optimist');"), ['jade', 'optimist'],
    '实参是三元时两个分支都是候选模块名，都要抓');
});

// 记债钉（不是期望，是「已知的洞」）：反引号模板串形式 require(`iconv-lite`)
// 扫不到 —— LITERAL_REQ 只认 ' 与 "。全仓当前一处都没有这种写法（动态加载走的是
// require(path.join(...))，实参里没有字面量），所以没当成缺陷去改；但写成钉是
// 为了别让人以为这条路已覆盖：哪天真出现 `import(`x`)`，排除项安全性会**假绿**。
test('记债：反引号模板串形式的 require 不在扫描视野内（当前全仓零处，改前先看这行）', () => {
  assert.deepEqual(refsOf("const mod = require(`jade`);"), [], '这仍是已知的洞，不是新引入的行为');
});

// ── ② 正向钉：真引用一条都不许漏 ───────────────────────

test('三种真引用形态（require 字面量 / import from / 动态 import）都扫得到', () => {
  const src = [
    "const j = require('jade');",
    "import k from 'jade';",
    "import 'jade';",
    "const l = await import('jade');",
  ].join('\n');
  assert.deepEqual(refsOf(src), ['jade']);
});

test('内建模块与相对路径不误报（pkgOf 那三道闸还在）', () => {
  const src = [
    "const path = require('node:path');",
    "const fs = require('fs');",
    "const { a } = require('./local.js');",
    "const b = require('../shared/dto');",
  ].join('\n');
  assert.deepEqual(refsOf(src), [], '内建与相对路径被当成了第三方包');
  // node: 前缀曾经整条漏掉：Module.builtinModules 里只有 'path' 没有 'node:path'，
  // 于是 node:http / node:https / node:path 被当成三个「第三方包」报进清单。
  assert.equal(pkgOf('node:path'), null, 'node: 前缀必须先摘掉再查内建表');
  assert.equal(pkgOf('node:fs'), null);
  assert.equal(pkgOf('path'), null);
  assert.equal(pkgOf('./a.js'), null);
  assert.equal(pkgOf('jade'), 'jade', '裸第三方包名照常认（这几道闸不是把闸门焊死）');
});

// ── ③ 拿真实源码验一遍：扫描器没退化成「什么都不扫」──

test('全仓静态扫描仍能捞到惰性 require 的真包（iconv-lite / node-id3 等）', () => {
  const found = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const pkg of staticRefsIn(fs.readFileSync(p, 'utf8'), p)) found.add(pkg);
    }
  })(path.join(ROOT, 'src'));
  // 这四个都只出现在惰性分支里（插桩跑不到），静态扫描是它们唯一的发现途径。
  // 判据一旦退化成空扫描，这里立刻红。
  for (const p of ['iconv-lite', 'node-id3', 'music-metadata', 'electron-updater']) {
    assert.ok(found.has(p), `静态扫描没扫到 ${p} —— 要么它被删了，要么扫描器坏了`);
  }
  // 反向：node: 前缀内建与纯注释里的举例都不得进清单。
  // src/renderer/js/pathLite.js 的头注释里写着 `import path from 'node:path'`，
  // 剥注释之前它会混进「静态引用」计数；node: 前缀不摘的话 node:http 也一样会混进去。
  assert.ok(!found.has('node:path'), 'node:path 只在注释里被提到过，不该算静态引用');
  assert.ok(!found.has('node:http'), 'node:http 是内建模块（require 真有），不该算第三方包');
  assert.ok(!found.has('path'), '纯注释里的 node:path 举例不该退化成裸包名 path');
});

test('端到端：源码里塞一段注释举例，跑完整扫描器仍判「排除项安全」', () => {
  // 这是本文件存在的理由：把缺陷 4 的场景原样复现一遍。
  // 真放进 src/ 之前不能这么干（会脏工作树），故此处直接调判据。
  const excluded = excludedPackages();
  const sample = [
    "/* 曾经的模板引擎：require('jade')。现在只走 vite 的 html 模板。 */",
    "const path = require('node:path');",
    'module.exports = { path };',
  ].join('\n');
  const hit = [...staticRefsIn(sample, FILE)].filter((p) => excluded.has(p));
  assert.deepEqual(hit, [], `样例里的注释举例被报成排除项被引用：${hit.join(', ')}`);
});
