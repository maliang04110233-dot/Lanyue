/**
 * 攻击面门禁测试 —— scripts/audit-attack-surface.cjs 的四条判据
 *
 * 测试纪律（test/audit-gate.test.js 头注同源）：
 *   每个负向用例**只触发一条判据**（A/B/C/D 各自独立），否则红的原因
 *   可能是另一条弦，这条线等于没测到（audit-gate.test.js 第一版踩过）。
 *   正向基线覆盖「注释/字符串里的举例不算代码」—— 文档最爱写
 *   "require('express') 只是举例"，mask 必须挡住它，否则文档一改 CI 就红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { evaluate, GROUP, SDK_CONSUMER, LISTEN_ALLOWED } =
  require('../scripts/audit-attack-surface.cjs');
const { loadAllowlist } = require('../scripts/audit-gate.cjs');

const ROOT = path.join(__dirname, '..');
const f = (relPath, src) => ({ relPath, src });
const ok = () => new Set();

test('A 直达使用：src/ 下 require 分组包 ⇒ 红（其余文件为空，只有 A 能抓住）', () => {
  const r = evaluate({ files: [f('src/x.js', "const e = require('express');")], excluded: ok() });
  assert.equal(r.filter((s) => s.startsWith('A ')).length, 1, JSON.stringify(r));
  r.forEach((s) => assert.match(s, /express/));
});

test('A 覆盖全部三个分组包（body-parser / path-to-regexp 同样不许直接消费）', () => {
  for (const p of ['body-parser', 'path-to-regexp']) {
    const r = evaluate({ files: [f('src/x.js', `require('${p}')`)], excluded: ok() });
    assert.ok(r.some((s) => s.startsWith('A ') && s.includes(p)), JSON.stringify(r));
  }
});

test('B 打包前提：分组包被 build/config.cjs 排除 ⇒ 红（无任何源码命中）', () => {
  const r = evaluate({ files: [], excluded: new Set(['body-parser']) });
  assert.equal(r.filter((s) => s.startsWith('B ')).length, 1, JSON.stringify(r));
  assert.match(r[0], /build\/config\.cjs/);
});

test('C 子路径加载：SDK 的 server/main 被显式引入 ⇒ 两条判据同时红（子路径 + 消费面）', () => {
  const r = evaluate({ files: [f('src/y.js', "require('NeteaseCloudMusicApi/server');")], excluded: ok() });
  assert.ok(r.some((s) => s.startsWith('C ') && /\/server/.test(s)), JSON.stringify(r));
  assert.ok(r.some((s) => s.startsWith('C ') && /消费面/.test(s)), JSON.stringify(r));
});

test('C 消费面扩散：第二个模块也加载 SDK 根路径 ⇒ 红（不含子路径字符串）', () => {
  const r = evaluate({
    files: [f(SDK_CONSUMER, "require('NeteaseCloudMusicApi');"),
            f('src/a.js', 'require("NeteaseCloudMusicApi");')],
    excluded: ok(),
  });
  assert.ok(r.some((s) => s.startsWith('C ') && /消费面/.test(s)), JSON.stringify(r));
  // 单引号形态同样被抓住
  const r2 = evaluate({
    files: [f(SDK_CONSUMER, ''), f('src/a.js', "require('NeteaseCloudMusicApi');")], excluded: ok(),
  });
  assert.ok(r2.some((s) => s.startsWith('C ') && /消费面/.test(s)), JSON.stringify(r2));
});

test('D 启动门：许可清单之外出现真实代码级 createServer/listen ⇒ 红', () => {
  const r = evaluate({
    files: [f('src/z.js', 'http.createServer(fn); srv.listen(3000);')],
    excluded: ok(),
  });
  const set = [...new Set(r)];
  const d = set.filter((s) => s.startsWith('D '));
  assert.equal(d.length, 1, '同一文件里 createServer 与 .listen( 连写只算一条：' + JSON.stringify(r));
  assert.match(d[0], /启动门/);
});

test('.listen( 与 createServer 的两种形态都被启动门抓住（含不带 http. 前缀）', () => {
  for (const src of ['net.createServer(fn);', 'sock.listen(port);', 'http.createServer(fn).listen(0);']) {
    const r = evaluate({ files: [f('src/z.js', src)], excluded: ok() });
    assert.ok(r.some((s) => s.startsWith('D ')), src + JSON.stringify(r));
  }
});

test('正向基线：真仓形态不红 —— 消费面唯一、MCP listen 在许可清单、排除项为空', () => {
  const r = evaluate({
    files: [
      f(SDK_CONSUMER, "// 文档示例 require('express') 不算；import 变体 require(_'NeteaseCloudMusicApi'_) 也不算违规\n"
        + "const ncm = require('NeteaseCloudMusicApi');"),
      f(LISTEN_ALLOWED[0], 'server = http.createServer(fn); server.listen(port, "127.0.0.1");'),
    ],
    excluded: ok(),
  });
  assert.deepStrictEqual(r, [], JSON.stringify(r));
});

test('变变异测试：把 D 判据改成恒真，坏场景必须失去红的绿 —— 反向确认判据在本用例上确实为红', () => {
  // 判据改成恒放行（listenAllowed 塞万有）后，此前必红的用例必须变绿 ——
  // 若它仍红，说明刚才的「红」根本不是 D 抓的，这条测试自己就是假绿。
  const bad = [f('src/z.js', 'http.createServer(fn);')];
  assert.ok(evaluate({ files: bad, excluded: ok() }).some((s) => s.startsWith('D ')),
    '前提：D 必须能抓 z.js');
  const mutated = evaluate({ files: bad, excluded: ok(), listenAllowed: ['src/z.js'] });
  assert.ok(!mutated.some((s) => s.startsWith('D ')), JSON.stringify(mutated));
});

test('分组常量与 allowlist 的 upstream_locked_server_never_launched 组保持一致（漂移即红）', () => {
  const allow = loadAllowlist();
  const pkgs = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts', 'audit-allowlist.json'), 'utf8',
  )).upstream_locked_server_never_launched.packages;
  assert.deepStrictEqual([...GROUP].sort(), [...pkgs].sort(),
    'GROUP 判据侧与 allowlist 声明漂移 —— 改组时两侧一起改');
  for (const p of pkgs) assert.ok(allow.exempt.has(p), p + ' 应被 allowlist 豁免覆盖');
});

test('常量与真仓兼容：消费面文件确实存在、MCP 许可文件确实存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, SDK_CONSUMER)), SDK_CONSUMER);
  for (const p of LISTEN_ALLOWED) assert.ok(fs.existsSync(path.join(ROOT, p)), p);
});

test('真仓全量扫描必须为绿（判据与真实代码库的当下一致）', () => {
  const collect = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const { excludedPackages } = require('../scripts/check-dead-deps.cjs');
  const files = collect(path.join(ROOT, 'src')).map((abs) => ({
    relPath: path.relative(ROOT, abs).split(path.sep).join('/'),
    src: fs.readFileSync(abs, 'utf8'),
  }));
  const r = evaluate({ files, excluded: excludedPackages() });
  assert.deepStrictEqual(r, [], '真仓扫描不应出现任何攻击面告警：' + r.join(' | '));
});

test('脚本纪律：攻击面门禁顶层退出码只在被当脚本跑时交出（与 audit-gate 同律）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-attack-surface.cjs'), 'utf8');
  assert.match(src, /if \(require\.main === module\) process\.exit\(main\(\)\);/);
});
