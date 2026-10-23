/**
 * 单元测试：userSourceValidator —— 用户自定义音源脚本的静态分析
 *
 * 这是 P1 安全边界的核心：脚本进沙箱前的静态筛查。
 * 判定原则「宁可误杀不可放行」—— 每条被拒的都必须有明确理由。
 *
 * 测试分四组：
 *   A. 危险原语：出现即拒绝（fetch / require / eval / process / fs / ...）
 *   B. 合法脚本：能通过，且能力推导正确
 *   C. 边界情况：空脚本 / 注释里的危险词 / 字符串里的危险词
 *   D. manifest 校验：id 前缀 / 必需字段
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeUserSource,
  validateManifest,
  deriveCapabilities,
  BLOCKED_PATTERNS,
} = require('../src/main/userSourceValidator');

// ── 辅助 ──────────────────────────────────────────────

/** 构造一个「最小合法脚本」：调一次 hostApi.platformSearch */
function minimalScript(extra = '') {
  return [
    'async function search(keyword) {',
    '  const res = await hostApi.platformSearch("netease", keyword, 1);',
    '  return res;',
    '}',
    extra,
  ].join('\n');
}

/** 断言某条模式被拒，且错误里有指定的原语名 */
function assertBlocked(script, patternName) {
  const r = analyzeUserSource(script);
  assert.strictEqual(r.ok, false, `脚本应被拒: ${patternName}`);
  assert.ok(r.errors.length > 0, '必须给出错误原因');
  const hit = r.errors.find((e) => e.name === patternName);
  assert.ok(hit, `错误清单里应有 ${patternName}，实际: ${r.errors.map((e) => e.name).join(', ')}`);
  assert.ok(hit.reason, '每条错误必须有 reason');
}

// ══════════════════════════════════════════════════════════
// A. 危险原语
// ══════════════════════════════════════════════════════════

test('A. fetch 被拒（直接触网绕开 SSRF 白名单）', () => {
  assertBlocked('fetch("https://evil.com/x")', 'fetch');
});

test('A. require 被拒（可加载 fs / child_process）', () => {
  assertBlocked('const fs = require("fs");', 'require()');
});

test('A. eval 被拒（可执行任意代码绕过检查）', () => {
  assertBlocked('eval("1+1")', 'eval()');
});

test('A. new Function 被拒（等价 eval）', () => {
  assertBlocked('new Function("return 1")()', 'new Function()');
});

test('A. process 被拒（可读环境变量、退出进程）', () => {
  assertBlocked('process.exit(0)', 'process.');
});

test('A. fs. 被拒（文件系统读写）', () => {
  assertBlocked('fs.readFileSync("/etc/passwd")', 'fs.');
});

test('A. child_process 被拒（等价提权）', () => {
  // 注意：不能写 require("child_process") —— stripStrings 会把字符串剥成 "_"，
  // 那时靠的是 require() 那条规则。这里用变量引用确保命中 child_process 模式。
  assertBlocked('const cp = child_process;', 'child_process');
});

test('A. Buffer 被拒（Node 全局，可用于底层 IO）', () => {
  assertBlocked('const b = Buffer.from("x")', 'Buffer');
});

test('A. __dirname 被拒（泄露宿主文件结构）', () => {
  assertBlocked('console.log(__dirname)', '__dirname');
});

test('A. globalThis 被拒（全局对象别名）', () => {
  assertBlocked('globalThis.foo = 1', 'globalThis');
});

test('A. window. 被拒（可触浏览器全局与其它窗口权限）', () => {
  assertBlocked('window.location = "http://evil.com"', 'window.');
});

test('A. 动态 import() 被拒（可加载 node: 协议模块）', () => {
  assertBlocked('import("node:fs")', '动态 import()');
});

test('A. WebSocket 被拒（直接触网）', () => {
  assertBlocked('new WebSocket("ws://evil.com")', 'WebSocket');
});

// ══════════════════════════════════════════════════════════
// B. 合法脚本
// ══════════════════════════════════════════════════════════

test('B. 只调 hostApi.platformSearch 的脚本通过', () => {
  const r = analyzeUserSource(minimalScript());
  assert.strictEqual(r.ok, true, `应通过: ${JSON.stringify(r.errors)}`);
  assert.ok(r.manifest, '应产出 manifest');
  assert.strictEqual(r.manifest.id, 'user:anonymous');
});

test('B. 调 platformGetUrl 的脚本通过（能取流）', () => {
  const s = 'async function g(id){ return await hostApi.platformGetUrl(id, "netease", "standard"); }';
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, true);
  assert.ok(r.manifest);
});

test('B. 能力推导：调 platformSearch → caps.album = true', () => {
  const r = analyzeUserSource(minimalScript());
  assert.strictEqual(r.manifest._capabilities.album, true);
});

test('B. 能力推导：调 platformGetLyrics → caps.lyrics = true', () => {
  // 脚本必须同时能搜歌或取流（否则 no-capability 拒绝），所以这里带一个 search
  const s = [
    'async function search(kw){ return await hostApi.platformSearch("netease", kw, 1); }',
    'async function l(id){ return await hostApi.platformGetLyrics(id, "netease"); }',
  ].join('\n');
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.manifest._capabilities.lyrics, true);
});

test('B. 能力推导：未调用的能力位为 false', () => {
  const r = analyzeUserSource(minimalScript());
  assert.strictEqual(r.manifest._capabilities.lyrics, false);
  assert.strictEqual(r.manifest._capabilities.cookie, false);
});

test('B. policies 默认值：不参与换源、不参与探针、聚合条数 0', () => {
  const r = analyzeUserSource(minimalScript());
  assert.strictEqual(r.manifest.policies.fallbackSource, false);
  assert.strictEqual(r.manifest.policies.probeable, false);
  assert.strictEqual(r.manifest.policies.aggregateLimit, 0);
  assert.ok(r.manifest.policies.order > 100, 'order 应排在内置源之后');
});

test('B. hosts.origins 为空（出网全走 hostApi，gateway 自己 SSRF 兜底）', () => {
  const r = analyzeUserSource(minimalScript());
  assert.deepStrictEqual(r.manifest.hosts.origins, []);
});

test('B. 自定义 id / name 透传进 manifest', () => {
  const r = analyzeUserSource(minimalScript(), { id: 'mycloud', name: '我的云音乐' });
  assert.strictEqual(r.manifest.id, 'user:mycloud');
  assert.strictEqual(r.manifest.name, '我的云音乐');
});

// ══════════════════════════════════════════════════════════
// C. 边界情况
// ══════════════════════════════════════════════════════════

test('C. 空脚本被拒', () => {
  const r = analyzeUserSource('');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].name, 'empty');
});

test('C. 注释里的危险词不误判（stripComments 先剥注释）', () => {
  // 注释里写 fetch，但实际代码只调 hostApi
  const s = [
    '// 这里曾经用过 fetch("https://evil.com")，现在不用了',
    'async function search(kw){ return await hostApi.platformSearch("netease", kw, 1); }',
  ].join('\n');
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, true, `注释里的危险词不应误判: ${JSON.stringify(r.errors)}`);
});

test('C. 字符串里的危险词不误判（stripStrings 先剥字符串）', () => {
  const s = 'const note = "不要用 fetch 直接请求"; async function s(kw){ return await hostApi.platformSearch("netease", kw, 1); }';
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, true, `字符串里的危险词不应误判: ${JSON.stringify(r.errors)}`);
});

test('C. 注释与字符串里的危险词同时出现也不误判', () => {
  const s = [
    '// fetch("x") require("fs") eval("y")',
    'const s = "require(\'fs\') fetch(\'z\')";',
    'async function f(kw){ return await hostApi.platformSearch("netease", kw, 1); }',
  ].join('\n');
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, true, `不应误判: ${JSON.stringify(r.errors)}`);
});

test('C. 注释里写「不要用 fetch」但代码里真的用了 fetch → 仍应拒绝', () => {
  const s = [
    '// 不要用 fetch 直接请求',
    'async function f(){ return await fetch("https://evil.com/x"); }',
  ].join('\n');
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, false, '代码里真有 fetch 就必须拒绝');
});

test('C. 没有调用任何 hostApi 方法 → 被拒（no-capability）', () => {
  const s = 'async function f(){ return 42; }';
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].name, 'no-capability');
});

test('C. 只调了未知方法（不在 HOST_API_METHODS 里）→ 不通过能力推导', () => {
  const s = 'async function f(){ return await hostApi.platformDeleteAllData(); }';
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, false, '未知 hostApi 方法不应算作有效能力');
});

test('C. 换行分隔的多个危险原语，每条都记了行号', () => {
  const s = [
    'fetch("a")',
    'require("fs")',
    'eval("b")',
  ].join('\n');
  const r = analyzeUserSource(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length >= 3);
  assert.strictEqual(r.errors[0].line, 1);
  assert.strictEqual(r.errors[1].line, 2);
  assert.strictEqual(r.errors[2].line, 3);
});

// ══════════════════════════════════════════════════════════
// D. manifest 校验
// ══════════════════════════════════════════════════════════

test('D. 合法 manifest 通过 validateManifest', () => {
  const r = analyzeUserSource(minimalScript());
  const v = validateManifest(r.manifest);
  assert.strictEqual(v.ok, true, `应通过: ${v.errors.join('; ')}`);
});

test('D. id 不以 user: 开头 → 拒绝（防与内置平台冲突）', () => {
  const m = { id: 'netease', name: 'x', hosts: { origins: [] }, policies: { order: 1 } };
  const v = validateManifest(m);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('user:')));
});

test('D. 缺 hosts.origins → 拒绝', () => {
  const m = { id: 'user:x', name: 'x', policies: { order: 1 } };
  const v = validateManifest(m);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('hosts.origins')));
});

test('D. 缺 policies.order → 拒绝', () => {
  const m = { id: 'user:x', name: 'x', hosts: { origins: [] }, policies: {} };
  const v = validateManifest(m);
  assert.strictEqual(v.ok, false);
});

test('D. 缺 name → 拒绝', () => {
  const m = { id: 'user:x', hosts: { origins: [] }, policies: { order: 1 } };
  const v = validateManifest(m);
  assert.strictEqual(v.ok, false);
});

// ══════════════════════════════════════════════════════════
// E. 危险原语清单自检
// ══════════════════════════════════════════════════════════

test('E. BLOCKED_PATTERNS 覆盖所有被测的危险原语', () => {
  const names = new Set(BLOCKED_PATTERNS.map((p) => p.name));
  for (const n of ['fetch', 'require()', 'eval()', 'new Function()', 'process.', 'fs.', 'Buffer', '__dirname', 'globalThis']) {
    assert.ok(names.has(n), `BLOCKED_PATTERNS 应包含 ${n}`);
  }
});

test('E. 每个被拒的原语都有非空 reason', () => {
  for (const p of BLOCKED_PATTERNS) {
    assert.ok(p.reason && p.reason.length > 0, `${p.name} 必须有 reason`);
  }
});
