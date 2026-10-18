import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = pathToFileURL(path.join(ROOT, 'scripts', 'audit-gate.cjs')).href;
const { loadAllowlist, parseAuditJson } = await import(GATE);

const WHY = '运行时插桩与静态引用均未命中，不在发布产物里';
const DATE = '2026-10-13';

/**
 * 每个用例**只缺一样东西**。
 *
 * 第一版这里写成「缺 _why」的同时也缺了 _verified，于是断言照样成立 ——
 * 真正抓住它的是另一条校验，这条线根本没被测到。门禁测试自己假绿，
 * 比没有门禁更危险：它会让人以为理由校验一直在生效。
 */
test('豁免缺理由 ⇒ 不合规（其余字段齐全，确保只有理由这一条能抓住它）', () => {
  const r = loadAllowlist({ unreachable_excluded: { packages: ['jade'], _verified: DATE } });
  assert.ok(r.problems.some((p) => /_why/.test(p)), '缺理由必须被单独抓住：' + JSON.stringify(r.problems));
});

test('豁免理由过短 ⇒ 不合规（"没写"与"写得太随意"同样不可复核）', () => {
  const r = loadAllowlist({ unreachable_excluded: { packages: ['jade'], _why: '不安全', _verified: DATE } });
  assert.ok(r.problems.some((p) => /_why/.test(p)));
});

test('豁免缺核查日期 ⇒ 不合规（理由齐全，确保只有日期这一条能抓住它）', () => {
  const r = loadAllowlist({ unreachable_excluded: { packages: ['jade'], _why: WHY } });
  assert.ok(r.problems.some((p) => /_verified/.test(p)));
});

test('日期格式不合规 ⇒ 不合规（YYYY-MM-DD，不接受随手写的字符串）', () => {
  const r = loadAllowlist({ unreachable_excluded: { packages: ['jade'], _why: WHY, _verified: '2026/10/13' } });
  assert.ok(r.problems.some((p) => /_verified/.test(p)));
});

test('分组缺 packages ⇒ 不合规', () => {
  const r = loadAllowlist({ unreachable_excluded: { _why: WHY, _verified: DATE } });
  assert.ok(r.problems.some((p) => /packages/.test(p)));
});

test('完整形态不该被误判，且豁免集合正确', () => {
  const r = loadAllowlist({ unreachable_excluded: { packages: ['jade', 'clean-css'], _why: WHY, _verified: DATE } });
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual([...r.exempt.keys()], ['jade', 'clean-css']);
});

test('同一个包出现在两个分组 ⇒ 报错（豁免范围必须唯一可判）', () => {
  const r = loadAllowlist({
    a: { packages: ['express'], _why: WHY, _verified: DATE },
    b: { packages: ['express'], _why: WHY, _verified: DATE },
  });
  assert.ok(r.problems.some((p) => /express/.test(p)), '重复豁免必须被发现');
});

test('仓库里的 audit-allowlist.json 自身合规（分组、理由、日期齐全）', () => {
  const r = loadAllowlist();
  assert.deepStrictEqual(r.problems, [], '清单不合规：' + r.problems.join('; '));
  assert.ok(r.exempt.size > 0);
});

test('豁免分组的四个可选值（新增分组必须先想清楚依据属于哪一类；改名/合组同步改此钉）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'audit-allowlist.json'), 'utf8'));
  const groups = Object.keys(raw).filter((k) => !k.startsWith('_')).sort();
  assert.deepStrictEqual(groups, [
    'unreachable_but_packaged',
    'unreachable_excluded',
    'upstream_locked',
    'upstream_locked_server_never_launched',
  ]);
});

test('攻击面日志四组缺一不可：upstream_locked_server_never_launched 只放「打进 asar + 被 require + listen 分支不可达」的包', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'audit-allowlist.json'), 'utf8'));
  const g = raw.upstream_locked_server_never_launched;
  // 缺 machines 判据 —— 该组的存在前提是对 scripts/audit-attack-surface.cjs
  // 的机器复核承诺；_why 不提这一点的分组会退化为「信任上次结论的僵尸标签」。
  assert.ok(/audit-attack-surface|机器判据/.test(g._why),
    '该组 _why 必须指明机器判据挂钩（scripts/audit-attack-surface.cjs）');
  // SDK 自身不可归入该组 —— 它的 HTTP 服务部分确实存在（server.js 被要求加载），
  // 真正锁死它的点是「消费面只有纯数据方法」；SDK 归 upstream_locked。
  assert.ok(!g.packages.includes('NeteaseCloudMusicApi'),
    'SDK 根包不属于 server_never_launched 组（server.js 是被无条件加载的）');
});

test('npm audit 输出带 BOM 时仍能解析（Windows 上真实发生过的坑）', () => {
  const obj = { vulnerabilities: {} };
  assert.deepStrictEqual(parseAuditJson('\uFEFF' + JSON.stringify(obj)), obj);
  assert.deepStrictEqual(parseAuditJson(JSON.stringify(obj)), obj);
});

test('门禁主流程不得在顶层执行（否则测试 import 会把自己一起干掉）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-gate.cjs'), 'utf8');
  assert.match(src, /if \(require\.main === module\) process\.exit\(main\(\)\);/,
    '退出码只能在被当脚本跑时交出去；顶层直接 exit 会让测试静默变成「跑了一个文件、零个用例」');
});

test('package.json 的 audit:deps 指向 audit-gate.cjs（旧的 audit-level 口径已被替换）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:deps'], 'node scripts/audit-gate.cjs');
});