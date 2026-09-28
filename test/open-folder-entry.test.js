/**
 * 守卫：「打开文件夹」只有一个入口，且失败一定有人说话
 *
 * ── 背景 ──────────────────────────────────────────────────────
 *
 * 2026-09-28 给 open-folder 接上 approvedDirs 沙箱（主进程会返回
 * `{ok:false, error}`）之后，发现渲染层 9 个调用点里有 8 个**完全忽略返回值**。
 * 后果是静默失败：用户点「打开文件夹」，资源管理器不弹、界面毫无反应 ——
 * 比报错更难排查，也和本仓「反馈必须跟着事实走」的纪律相悖。
 *
 * 于是加了 `openFolderSafe()`（src/renderer/js/utils.js）作为唯一入口，
 * 由它统一出反馈，并区分两类失败（被沙箱拒 / 通道异常）—— 用户能采取的
 * 动作不一样，措辞不能混。
 *
 * 这条测试防止后来者直接调 `api.openFolder` 绕开它。新增「打开文件夹」入口时
 * 请一并更新这里的白名单与理由。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

// 逐行去注释但**保留行数**（把注释内容替换成等长空格）。
// 早先用整段 replace 删注释，删掉的行会让后面所有行号偏移，报告出来的
// `file:line` 全是错的 —— 守卫本身先得可信。
const BLANK_COMMENT = (line) => {
  let out = '';
  let inS = null; // 当前所处字符串定界符
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (inS) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; continue; }
    if (c === '/' && n === '/') { out += ' '.repeat(line.length - i); break; }
    out += c;
  }
  return out;
};

const files = walk(RENDERER);
const hits = [];
for (const p of files) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  const raw = fs.readFileSync(p, 'utf8').split('\n');
  raw.forEach((line, i) => {
    if (BLANK_COMMENT(line).includes('api.openFolder(')) {
      hits.push({ rel, line: i + 1, text: line.trim() });
    }
  });
}

// openFolderSafe 的实现自身必须调 api.openFolder —— 它就是那个「唯一入口」。
// 显式豁免并要求它真的在 utils.js 里，避免豁免变成万能洞。
const SELF = 'src/renderer/js/utils.js';

const stripComments = (src) => src;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p, out); continue; }
    if (/\.(js|html)$/i.test(name)) out.push(p);
  }
  return out;
}

test('扫描面非空（别让守卫因为路径写错而空转）', () => {
  assert.ok(files.length > 40, `只扫到 ${files.length} 个渲染层文件`);
});

test('渲染层不得直接调 api.openFolder（失败反馈只由 openFolderSafe 出）', () => {
  const bypass = hits.filter((h) => h.rel !== SELF);
  assert.deepStrictEqual(
    bypass.map((h) => `${h.rel}:${h.line}`), [],
    `这些地方绕过了 openFolderSafe：\n  ${bypass.map((h) => `${h.rel}:${h.line}  ${h.text}`).join('\n  ')}\n`
      + '主进程 open-folder 有沙箱，被拒时返回 {ok:false}。直接调 api.openFolder 会静默失败。',
  );
});

test('唯一的 api.openFolder 调用点在 utils.js 的 openFolderSafe 里', () => {
  // 豁免必须是真的「唯一入口」，否则上面那条会变成万能洞：把裸调全搬进
  // utils.js 也能过。这里用括号配对把 openFolderSafe 的函数体切出来，
  // 断言 utils.js 里的每一处 api.openFolder 都落在它体内。
  const utils = fs.readFileSync(path.join(ROOT, SELF.split('/').join(path.sep)), 'utf8');
  const start = utils.indexOf('async function openFolderSafe(');
  assert.ok(start > -1, 'openFolderSafe 函数找不到');

  // 括号配对（跳过字符串与注释里的括号，否则会切错位）
  let depth = 0;
  let i = utils.indexOf('{', start);
  const bodyStart = i;
  let inS = null;
  for (; i < utils.length; i++) {
    const c = utils[i];
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const body = utils.slice(bodyStart, i + 1);
  assert.match(body, /api\.openFolder\(/, 'openFolderSafe 体内没有 api.openFolder 调用 —— 它不转调就永远打不开');

  const inBody = (body.match(/api\.openFolder\(/g) || []).length;
  const inFile = (utils.match(/api\.openFolder\(/g) || []).length;
  assert.strictEqual(
    inBody, inFile,
    `utils.js 里有 ${inFile} 处 api.openFolder，但只有 ${inBody} 处在 openFolderSafe 体内 —— `
      + '多出来的那几处同样绕过了统一反馈',
  );

  // 全仓口径：除 utils.js 那一处外，不许再有裸调
  const all = hits.reduce((s, h) => s + (utils.split('\n')[h.line - 1].match(/api\.openFolder\(/g) || []).length, 0);
  assert.strictEqual(hits.length, inFile, `守卫扫描到 ${hits.length} 处裸调，与实际 ${inFile} 处对不上 —— 扫描逻辑本身坏了`);
  assert.ok(all > 0);
});

test('openFolderSafe 存在且区分两类失败', () => {
  const utils = fs.readFileSync(path.join(RENDERER, 'js', 'utils.js'), 'utf8');
  assert.match(utils, /function openFolderSafe\(/, 'utils.js 里没有 openFolderSafe');
  // 被拒（ok:false）与异常（throw）是两回事，措辞不能一样
  assert.match(utils, /toast\.folderBlocked/, '缺少「被沙箱拒」的反馈');
  assert.match(utils, /toast\.folderOpenFailed/, '缺少「通道异常」的反馈');
  assert.match(utils, /toast\.folderNoPath/, '缺少「入参为空」的反馈');
  // 两条失败路径都要真的 return，不能只弹 toast
  assert.match(utils, /return false;/, 'openFolderSafe 失败时必须返回 false 供调用方判');
  // 导出面：ESM 导出 + window 桥接，两处都要有
  assert.match(utils, /^\s*openFolderSafe,$/m, 'openFolderSafe 未进 ESM 导出');
  assert.match(utils, /window\.openFolderSafe = openFolderSafe;/, 'openFolderSafe 未挂 window（HTML 内联 onclick 用得到）');
});

test('调用点确实走了 openFolderSafe（防止把上一条的替换反向做掉）', () => {
  const uses = [];
  for (const p of files) {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    const n = (stripComments(fs.readFileSync(p, 'utf8')).match(/openFolderSafe\(/g) || []).length;
    if (n) uses.push({ rel, n });
  }
  const total = uses.reduce((s, u) => s + u.n, 0);
  // 旧实现是 9 个调用点；少一个都说明有人把某个入口删了或改回了裸调
  assert.ok(total >= 9, `只找到 ${total} 处 openFolderSafe 调用（旧实现是 9 个调用点），逐个文件：${JSON.stringify(uses)}`);
});

test('三条词条中英齐备且带 {error} 占位符', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(RENDERER, 'js', 'lang', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(RENDERER, 'js', 'lang', 'en.json'), 'utf8'));
  for (const k of ['toast.folderNoPath', 'toast.folderBlocked', 'toast.folderOpenFailed']) {
    assert.ok(zh[k], `zh.json 缺 ${k}`);
    assert.ok(en[k], `en.json 缺 ${k}`);
    assert.doesNotMatch(en[k], /[\u4e00-\u9fa5]/, `en 的 ${k} 混进了中文`);
  }
  assert.match(zh['toast.folderBlocked'], /\{error\}/);
  assert.match(en['toast.folderBlocked'], /\{error\}/);
  assert.match(zh['toast.folderOpenFailed'], /\{error\}/);
  assert.match(en['toast.folderOpenFailed'], /\{error\}/);
});
