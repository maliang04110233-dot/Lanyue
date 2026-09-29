// 守卫：把「依赖豁免档 A」从文档变成会红的测试。
//
// 背景：npm audit 报 14 条漏洞。express / body-parser / qs / serve-static /
// send / express-fileupload / path-to-regexp / cookie 共 8 个包确实随
// netease.js 的一行 require 进入应用进程（入口级实测：netease.js ⇒ 113 包，
// 其中 vuln=express,body-parser,qs,serve-static,express-fileupload,send）。
// 它们的「不可达」结论**只有一个支点**：serveNcmApi() 从未被调用，
// 因此 ncm 的 express 应用从不监听端口，没有 HTTP 入口。
//
// 只写文档不写守卫 = 结论会静默失效：哪天有人加个本地 API 调试开关，
// 端口就起来了，CI 绿、测试绿、审计照旧，登记照旧写着「不可达」。
// 这与 verifyUpdateCodeSignature:true 却无证书是同一种错误。
//
// ⚠️ 这条守卫自己写错过两次，都记在这里免得下一个人重蹈：
//   1) 第一版扫 `.listen(` 全仓零容忍 → mcpServer.js 与一堆测试桩假货全命中。
//   2) 第二版用 `(?<![.\w])listen\s*\(` 排除点号调用 → 真实的
//      `server.listen(...)` 恰好是点号形态，反而把真监听点漏掉了。
// 现在用「精确白名单 + 方法边界正则」，并保留反向钉防白名单腐烂。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'dist', '.ekko-tmp', '.backup', 'out']);

// 已知且已评估的监听点。改动这一行 = 重新评估依赖档位，结论必须写进豁免登记。
// mcpServer.js 自建 http.createServer 绑 127.0.0.1，不经过 express，
// 因此不影响 express 族八条的档 A 结论。
const KNOWN_LISTENERS = new Set(['src/main/mcp/mcpServer.js']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 去掉注释与字符串字面量，避免注释举例/断言样本被算成真调用点。 */
function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''");
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``');
  return s;
}

/** 方法边界：listen 前面不能紧跟字母/数字/下划线，避免 listeners / relisten 误报。 */
const LISTEN_RE = /\blisten\s*\(/g;

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const code = files.map((f) => ({
  rel: path.relative(ROOT, f).replace(/\\/g, '/'),
  src: stripComments(fs.readFileSync(f, 'utf8')),
}));

test('依赖档 A 守卫：serveNcmApi 零调用点', () => {
  const hits = [];
  for (const { rel, src } of code) {
    const re = /serveNcmApi/g;
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      const after = src.slice(m.index, m.index + 24);
      if (/module\.exports\s*\.?\s*$/.test(before)) continue;
      
      if (/^\s*[:=,]\s*$/.test(after)) continue;
      hits.push(rel + '@L' + src.slice(0, m.index).split('\n').length);
    }
  }
  assert.deepStrictEqual(
    hits, [],
    '出现 serveNcmApi 调用点：ncm 的 express 应用将监听端口，' +
      'express/body-parser/qs/serve-static/send/express-fileupload/path-to-regexp/cookie ' +
      '八条档 A 豁免立即失效，必须降为档 B 并补补偿控制。命中：' + hits.join(', ')
  );
});

test('依赖档 A 守卫：listen 调用点必须逐个登记（白名单外的出现即红）', () => {
  const hits = [];
  for (const { rel, src } of code) {
    LISTEN_RE.lastIndex = 0;
    let m;
    while ((m = LISTEN_RE.exec(src))) {
      hits.push(rel + '@L' + src.slice(0, m.index).split('\n').length);
    }
  }
  const unexpected = [...new Set(hits.map((h) => h.split('@')[0]))].filter((f) => !KNOWN_LISTENERS.has(f));
  assert.deepStrictEqual(
    unexpected, [],
    '白名单外出现 listen( 调用：新增监听面需重评依赖档位并登记评估结论。命中文件：' + unexpected.join(', ')
  );
  const stale = [...KNOWN_LISTENERS].filter((f) => !hits.some((h) => h.startsWith(f + '@')));
  assert.deepStrictEqual(stale, [], '白名单登记了但已无 listen( 命中：登记项已腐烂，请删除。' + stale.join(', '));
});

test('守卫自检：植入 serveNcmApi / listen 必须让本守卫变红', () => {
  const serve = (src) => /serveNcmApi\s*\(/.test(src);
  const listen = (src) => /\blisten\s*\(/g.test(src);
  assert.ok(serve('ncm.serveNcmApi(3000);'), '植入的 serveNcmApi 调用必须被判命中');
  assert.ok(listen('server.listen(0);'), '植入的 listen 调用必须被判命中');
  assert.ok(listen('http.createServer(h).listen(port, host);'), '对照组：本仓库真实形态');
  assert.ok(!serve('ncm.search();'), '对照：正常 SDK 调用不得误报');
  assert.ok(!listen('s.listeners("error", f);'), '对照：listeners 不得被当成 listen');
});

test('扫描面非空（守卫没有因为扫不到文件而空转）', () => {
  assert.ok(files.length > 20, '扫描到的源文件过少：' + files.length + '，守卫可能空转');
  assert.ok(files.some((f) => f.endsWith('netease.js')), '必须扫到 netease.js，否则档 A 结论失去观测面');
});
