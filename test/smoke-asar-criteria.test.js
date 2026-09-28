/**
 * 守护：打包冒烟门禁（scripts/smoke-asar.js）第 8a 项的判据本身
 *
 * 来龙去脉（实测，非推测）：`npm run smoke:asar` 从c664fdf 起恒红（11/12），
 * 而它是 `npm run verify` 的最后一环 —— 一个天天红的门禁等于没有门禁，
 * 更要紧的是它会训练人"跳过这条看下一条"，那正是假绿进来的通道。两个成因：
 *
 *   成因①「ESM-only 导出无人 import」这一支把消费方**只**数渲染层别的模块：
 *     `exportedNamesOf(eq.js)` 得到 12 个导出（11 函数 + PRESET_CUSTOM），减掉 player.js 桥接的 7 个 ⇒ 5 个
 * ESM-only，其中 `matchPresetName`（为"高亮由曲线现推"而导出，
 *     实际调用点在 eq.js 内部 + node 测试）在别的渲染模块里一次都没出现 ⇒ 判成孤儿。
 *     可它不是死码：模块内部真在用，压缩器绝不会丢它。判据错在把"跨模块 import"
 *     当成"有人用"的唯一形态。189 的幽灵键口径是「哪都没人读」才算死 —— 同一把尺。
 *     修完之后这一支仍然咬得住**真**死导出：只有声明处提到自己的名字 ⇒ 依旧红。
 *     顺带两处补齐：导出面派生原来漏 `export const`（`PRESET_CUSTOM` 隐形），
 *     两侧消费扫描原来不剥注释（注释里提一句函数名就把死导出洗白）。
 *
 *   成因②bundle 内容锚读的是 `release/win-unpacked/resources/app.asar`（本机 = 9/18 10:36 的旧包，
 *     早于 187/190/191 全部提交），而 `npm run verify` 里 `npm run build` 刚把 dist/ 重产出来。
 *     实测：锚串「音频图初始化失败，频谱不可用」在 dist 产物 `exact:true`、在这个旧 asar 里 0 处。
 *     也就是说这条红说的是"包是旧的"，不是"逻辑被 tree-shake 掉了"，两件事被混成一条断言。
 *     修法：内容锚按**新鲜的那个产物**判（包不旧判包；包旧则退判工作树 dist/，
 *     并把"退判了"写进检查名与明细，逼发布前重新打包复跑），
 *     而"包里有 платform 模块 / 关键拷贝路径 / 图标字节 / 依赖树"这些**成员**断言照旧只判包 ——
 *     那才是"用户拿到的那个 exe"专属的事实。
 *
 * 判据一律收成 scripts/smoke-checks.cjs 的纯函数（本文件才测得到真身；
 * smoke-asar.js 自己 `process.exit()`，直接 require 会把这个测试进程干掉）。
 * 与 191 同律：**扫描器/判据必须自带自测**，没有自测的巡扫等于运气。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const CHECKS = require(path.join(REPO, 'scripts', 'smoke-checks.cjs'));

/** 并发线会把整文件改成 CRLF，源码形状钉必须先归一（372d675 起的本仓惯例） */
function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
}
const countOf = (hay, needle) => hay.split(needle).length - 1;

// ── 自测：导出面派生 ────────────────────────────────────
test('exportedNamesOf 认 function / async function / const / export{} 别名四种写法', () => {
  const src = [
    "export function alpha() {}",
    "export async function beta() {}",
    "export const GAMMA = 'g';",
    "export let delta = 1;",
    "function eps() {}\nexport { eps, eps as zeta };",
  ].join('\n');
  assert.deepEqual(CHECKS.exportedNamesOf(src),
    ['GAMMA', 'alpha', 'beta', 'delta', 'eps', 'zeta']);
});

test('exportedNamesOf 扫注释剥离后的代码：注释里举例的 export 不算导出', () => {
  // 两种形状都要覆盖，因为它们咬的是不同的正则：
  //   ① 块注释里**顶格**的 `export function` 会撞上线首锚定 `^\s*export`；
  //   ② 行注释里的 `export { x }` 更危险 —— 那条正则压根没有行首锚（清单本身要多形态），
  //      不剥注释就把文档里举的例子当成真导出。
  const src = [
    '/**',
    ' * 迁移说明：以前这里是',
    'export function ghost() {}',
    ' * 后来删了。',
    ' */',
    "// 老写法 `export { alpha };` 已作废",
    'export function real() {}',
  ].join('\n');
  assert.deepEqual(CHECKS.exportedNamesOf(src), ['real'],
    'ghost / alpha 只活在注释里 ⇒ 不许进导出面（否则消费方审计会去追一个不存在的符号）');
});

// ── 自测：内部使用判定 ──────────────────────────────────
test('internalUsesOf 只数声明处之外的调用点，注释里提一句不算使用', () => {
  const used = [
    'export function helper(a) { return a; }',
    'export function caller() { return helper(1); }',
  ].join('\n');
  assert.equal(CHECKS.internalUsesOf(used, 'helper'), 1);
  assert.equal(CHECKS.internalUsesOf(used, 'caller'), 0);

  const onlyDecl = 'export const NAME = 1;\nfunction f() { return NAME; }';
  assert.equal(CHECKS.internalUsesOf(onlyDecl, 'NAME'), 1);
  assert.equal(CHECKS.internalUsesOf(onlyDecl, 'f'), 0);

  const inComment = 'export function solo() {}\n// solo() 以前由 player.js 调\n';
  assert.equal(CHECKS.internalUsesOf(inComment, 'solo'), 0,
    '说明文字里提到自己的函数名，不能把死导出洗成活导出');

  const reexport = 'function base() {}\nexport { base };';
  assert.equal(CHECKS.internalUsesOf(reexport, 'base'), 0,
    'export{} 只是把它挂上导出面，不是有人用它');
});

// ── 自测：孤儿判定的四种形状 ────────────────────────────
test('unownedEsmExports：跨模块消费 / 模块内部使用都算活，只有声明处或只有注释算死', () => {
  const selfSrc = [
    'export function usedOutside() {}',
    'export function usedInside() {}',
    'export function onlyDeclared() {}',
    'export function onlyInComment() {}',
    'usedInside();',
  ].join('\n');
  const otherSrc = [
    "import { usedOutside } from './player/eq.js';",
    '// 以前 onlyInComment 也在这里调过',
  ].join('\n');
  assert.deepEqual(
    CHECKS.unownedEsmExports({
      selfSrc, otherSrc,
      names: ['usedOutside', 'usedInside', 'onlyDeclared', 'onlyInComment'],
    }),
    ['onlyDeclared', 'onlyInComment']);
});

test('旧判据会把「只在模块内部用」的导出当孤儿 —— 新判据不会（187 起恒红的那一枚）', () => {
  const selfSrc = 'export function internalOnly(x) { return x; }\ninternalOnly(1);';
  const names = ['internalOnly'];
  const oldRule = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(selfSrc ? 'const a = 1;' : ''));
  assert.deepEqual(oldRule, ['internalOnly'], '旧判据（只看别的模块）在这里判成孤儿 ⇒ 恒红');
  assert.deepEqual(CHECKS.unownedEsmExports({ selfSrc, otherSrc: 'const a = 1;', names }), [],
    '新判据承认内部调用点，同一条不再红');
});

// ── 真仓回归钉：8a 的两支都必须绿 ───────────────────────
function rendererFiles() {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.js$/.test(e.name) ? [full] : [];
  });
  return walk(path.join(REPO, 'src', 'renderer', 'js'));
}

test('eq.js 的 ESM-only 导出没有一个真孤儿（192 修的这条，187 起一直在红）', () => {
  const files = rendererFiles();
  const eqPath = path.join(REPO, 'src', 'renderer', 'js', 'player', 'eq.js');
  const selfSrc = read(path.relative(REPO, eqPath).split(path.sep).join('/'));
  const otherSrc = files.filter((p) => p !== eqPath).map((p) => read(
    path.relative(REPO, p).split(path.sep).join('/'))).join('\n');
  const bridge = read('src/renderer/js/player.js')
    .match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player\/eq\.js'/);
  assert.ok(bridge, 'player.js 里应能读到对 eq.js 的桥接 import（读不到 ⇒ 断链，不是通过）');
  const bridgeNames = bridge[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim());
  const esmOnly = CHECKS.exportedNamesOf(selfSrc).filter((n) => !bridgeNames.includes(n));
  assert.ok(esmOnly.length > 0, 'eq.js 除桥接面之外还应派生出 ESM-only 导出，空集说明判据失效');
  assert.deepEqual(CHECKS.unownedEsmExports({ selfSrc, otherSrc, names: esmOnly }), [],
    '每一个 ESM-only 导出都要有真消费方（跨模块 import 或本模块内部调用）');
});

test('eq.js 的导出面含 export const（派生清单不许漏写法，PRESET_CUSTOM 不再隐形）', () => {
  const eqSrc = read('src/renderer/js/player/eq.js');
  const names = CHECKS.exportedNamesOf(eqSrc);
  assert.ok(names.includes('PRESET_CUSTOM'), 'export const 也是导出面');
  assert.ok(names.includes('matchPresetName'), ' 那个被误判的名字必须在派生清单里');
});

// ── 自测：陈旧度与断言源 ────────────────────────────────
test('isPackageStale：产物早于任一输入即陈旧，相等或更晚不算', () => {
  assert.equal(CHECKS.isPackageStale({ packageMtime: 100, newestInputMtime: 101 }), true);
  assert.equal(CHECKS.isPackageStale({ packageMtime: 100, newestInputMtime: 100 }), false);
  assert.equal(CHECKS.isPackageStale({ packageMtime: 101, newestInputMtime: 100 }), false);
});

test('pickBundleSource 四分支：新包判包 / 旧包退判 dist / 两边都没有就判 none', () => {
  const A = 'ASAR_BUNDLE';
  const D = 'DIST_BUNDLE';
  const fresh = CHECKS.pickBundleSource({ asarBundle: A, distBundle: D, stale: false });
  assert.equal(fresh.text, A, '包新鲜时内容锚判包');
  assert.equal(fresh.from, 'asar');
  assert.equal(fresh.note, '', '没退化就不要编一句退化说明（明细里的噪声同样是假消息）');

  const fallback = CHECKS.pickBundleSource({ asarBundle: A, distBundle: D, stale: true });
  assert.equal(fallback.text, D, '包陈旧 ⇒ 内容锚改判工作树 dist/（否则旧包天天假红）');
  assert.equal(fallback.from, 'dist');
  assert.match(fallback.note, /npm run package/, '退化必须写明"发布前重新打包复跑"');

  const noDist = CHECKS.pickBundleSource({ asarBundle: A, distBundle: '', stale: true });
  assert.equal(noDist.from, 'none', '旧包 + 无 dist ⇒ 不许悄悄拿旧包内容当真身');
  assert.match(noDist.note, /npm run build/);

  const missingInFreshPackage = CHECKS.pickBundleSource({ asarBundle: '', distBundle: D, stale: false });
  assert.equal(missingInFreshPackage.from, 'dist', '包里压根没有渲染 bundle：判 dist 并记账');
  assert.match(missingInFreshPackage.note, /包内未找到渲染 bundle/);

  assert.equal(CHECKS.pickBundleSource({ asarBundle: '', distBundle: '', stale: false }).from, 'none');
});

// ── 接线钉：判据只有一家，且三项 bundle 断言都吃选出的源 ──
test('判据住在 scripts/smoke-checks.cjs 一家，smoke-asar.js 不再自带实现', () => {
  const script = read('scripts/smoke-asar.js');
  assert.match(script, /require\('\.\/smoke-checks\.cjs'\)/, '脚本应引用共享判据');
  for (const fn of ['exportedNamesOf', 'stripJsComments']) {
    assert.equal(countOf(script, `function ${fn}(`), 0,
      `${fn} 的实现只能有一处（在 smoke-checks.cjs），脚本里再写一份就是第二个家`);
  }
  const mod = read('scripts/smoke-checks.cjs');
  for (const fn of ['exportedNamesOf', 'stripJsComments', 'internalUsesOf',
    'unownedEsmExports', 'isPackageStale', 'pickBundleSource']) {
    assert.ok(mod.includes(`function ${fn}(`), `smoke-checks.cjs 应导出 ${fn}`);
  }
});

test('smoke-asar.js 里三项 bundle 内容断言共用同一个断言源', () => {
  const script = read('scripts/smoke-asar.js');
  assert.equal(countOf(script, 'const bundle = '), 1, 'bundle 只能有一个出处');
  assert.match(script, /const bundle = resolvedBundle\.text/,
    'bundle 必须来自 pickBundleSource 选出的源，而不是硬读 asar');
  assert.equal(countOf(script, 'pickBundleSource('), 1, '断言源只解析一次');
  assert.match(script, /渲染层 bundle 断言源/, '退化情况要单独成一项检查，不许只写在注释里');
  assert.equal(countOf(script, 'read(assets[0])'), 1,
    '包内 bundle 只读一次（喂给断言源解析）；第二处就是又分了一个家');
  assert.ok(!/const bundle = assets\.length/.test(script),
    '旧写法「bundle 硬读 asar」不许回来：那正是 9/18 旧包天天假红的成因');
});

test('陈旧度的输入集是 src/ 全部文件，不是只看 .js', () => {
  const script = read('scripts/smoke-asar.js');
  assert.match(script, /newestMtime\(walkFiles\(path\.join\(ROOT, 'src'\)\)\)/,
    '只扫 .js 会漏掉 lang/*.json、*.html、*.css —— 那些改了而包没重打，同样是「包已陈旧」');
  assert.equal(countOf(script, 'function walkFiles('), 1, '递归枚举只许一家');
  assert.equal(countOf(script, 'function listJs('), 0, 'listJs 是它的前身，不许留着当第二家');
});

test('门禁工具不许拖进第三方依赖（scripts/ 不在 check:dead-deps 的扫描面里）', () => {
  const mod = read('scripts/smoke-checks.cjs');
  const reqs = [...mod.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs.filter((r) => !['fs', 'path'].includes(r)), [],
    'smoke-checks.cjs 只准用 node 内建模块');
});
