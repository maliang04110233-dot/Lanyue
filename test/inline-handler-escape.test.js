/**
 * 守卫：内联事件处理器里的 JS 字符串字面量必须用 escQ，而不是 escAttr
 *
 * ── 缺陷模式（2026-09-28 复审发现，已修）──────────────────────
 *
 *   onclick="subscriptionRemove('${escAttr(e.key)}')"
 *                                  ^^^^^^^ 错
 *
 * 为什么这是**可利用的 DOM XSS**，而不是风格问题：
 *
 *   1. 内联事件属性（onclick="..."）的值在浏览器里要先做 **HTML 实体解码**，
 *      再当作 JS 源码解析执行 —— 这是规范定的两步语义；
 *   2. escAttr 把单引号转成 `&#39;`。这防住了「HTML 属性层」被闭合，
 *      但解码之后 `&#39;` 又变回裸的 `'`，于是 JS 字符串被提前闭合；
 *   3. 载荷 `x');alert(1);//` 经 escAttr 后，浏览器实际执行的是
 *        subscriptionRemove('x');alert(1);//')
 *      alert(1) 已逃出字符串，直接执行。
 *
 *   而 escQ 会把 `'` 转义成 `\'`（并先转义反斜杠，防 `foo\` 把 `\'` 变义），
 *   解码后仍是 `\'`，单引号留在字符串内：
 *        subscriptionRemove('x\');alert(1);//')
 *
 * 为什么需要守卫：这个模式在本仓库**真实发生过两次**（subscriptions.js 6 处、
 * ai-music.js 1 处），而且更糟的是 —— test/subscription-new-dl.test.js 原先把
 * escAttr 版本当作"已转义"钉住，等于用测试保护了 bug。所以光修不够，
 * 必须有全仓扫描，否则下次写新内联处理器时照样会犯。
 *
 * 判定规则：`on{event}="..."` 内部，处于**单引号 JS 字符串**中的 `${...}`，
 * 若转义函数是 escAttr / esc / escHtml 等「只做 HTML 实体转义」的函数，即违规。
 * 允许：escQ、纯数字表达式、白名单函数（见 ALLOWED_FN）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.backup', '.preview', 'release', 'dist', '.git']);

/** 只做 HTML 实体转义、不能用于内联 JS 字符串字面量的函数 */
const HTML_ONLY_ESCAPERS = [
  'escAttr',      // & < > " '
  'esc',          // & < > "
  'escHtml',
  'escapeHtml',
  'htmlEscape',
];

/**
 * 允许出现在内联处理器里的其他函数/表达式（各有其安全依据）：
 *   - Number/parseInt/parseFloat/String(...)  ：数字/字符串规范化
 *   - btoa(...)                              ：输出 base64 字符集，无引号无尖括号
 *   - encodeURIComponent(...)                ：百分号编码，逐字符安全
 *   - JSON.stringify(...)                    ：⚠️ 单独出现**不安全**（中文/引号原样输出），
 *                                              仅当外面再包 escQ 时才安全，故不在此白名单，
 *                                              由 escQ 的匹配覆盖
 */
const ALLOWED_WRAPPERS = ['Number', 'parseInt', 'parseFloat', 'btoa', 'encodeURIComponent'];

const HANDLER_RE = /on(?:click|change|dblclick|input|keydown|keyup|mouseover|mouseenter|mouseleave|error|submit|focus|blur)="([^"]*)"/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 找出「内联处理器属性值里、位于单引号字符串中、用 HTML-only 转义函数」的插值。
 * @returns {Array<{file:string,line:number,fn:string,expr:string}>}
 */
function findViolations(files) {
  const violations = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(HANDLER_RE)) {
        const body = m[1];
        // 找 '\''${...}'\'' 这种被单引号包住的插值
        for (const t of body.matchAll(/'(\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})'/g)) {
          const full = t[1];
          const inner = full.slice(2, -1).trim();
          const fnName = (inner.match(/^([A-Za-z_$][\w$]*)\s*\(/) || [])[1] || null;
          if (!fnName) continue; // 裸变量/字面量：另由数字白名单覆盖
          if (fnName === 'escQ') continue;
          if (ALLOWED_WRAPPERS.includes(fnName)) continue;
          if (HTML_ONLY_ESCAPERS.includes(fnName)) {
            violations.push({
              file: path.relative(ROOT, f).replace(/\\/g, '/'),
              line: i + 1, fn: fnName, expr: inner.slice(0, 70),
            });
          }
        }
      }
    });
  }
  return violations;
}

test('守卫：内联事件处理器的 JS 字符串字面量不得用 HTML-only 转义（escAttr/esc 等）', () => {
  const files = walk(path.join(ROOT, 'src'));
  const v = findViolations(files);
  assert.deepStrictEqual(
    v, [],
    '以下位置在内联事件属性的 JS 字符串里用了只做 HTML 实体转义的函数 ——\n'
    + '浏览器会先解码实体再执行，单引号因此逃出字符串（可利用的 DOM XSS）。\n'
    + '改用 escQ（先转义 \\ 再把 \' 转成 \\\'）：\n'
    + v.map((x) => `  ${x.file}:${x.line}  ${x.fn}(${x.expr})`).join('\n'),
  );
});

test('守卫自检：扫描器真的能抓到错误写法（正则写坏会静默放行）', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xss-guard-'));
  const bad = path.join(tmpDir, 'bad.js');
  fs.writeFileSync(bad, [
    'const a = `<button onclick="f(\'${escAttr(x.key)}\')">a</button>`;',
    'const b = `<button onclick="f(\'${esc(x.key)}\')">b</button>`;',
  ].join('\n'), 'utf8');

  const hits = findViolations([bad]);
  assert.strictEqual(hits.length, 2, 'escAttr 与 esc 都必须被抓到，实际 ' + hits.length);

  const good = path.join(tmpDir, 'good.js');
  fs.writeFileSync(good, [
    'const a = `<button onclick="f(\'${escQ(x.key)}\')">a</button>`;',
    'const b = `<button onclick="f(\'${Number(i)}\')">b</button>`;',
    'const c = `<span title="${escAttr(x.name)}">c</span>`;', // 纯属性用 escAttr 是对的
  ].join('\n'), 'utf8');
  assert.deepStrictEqual(findViolations([good]), [], '正确写法不得误报');
});

test('守卫自检：escAttr 与 escQ 在单引号内确实语义不同（防止有人"统一"成一个函数）', () => {
  // 抄自 src/renderer/js/utils.js
  const escAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escQ = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const payload = "x');alert(1);//";
  // 模拟浏览器：HTML 实体解码（内联事件属性取出时的必然步骤）
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  /**
   * 判定「解码后的 JS 里，载荷是否逃出了字符串字面量」。
   *
   * 不能用 `includes("');")` —— escQ 的输出 `x\');` 里**也含** `');`
   * 这三个字符，区别只在于引号前面有没有反斜杠。
   *
   * 也不该简单数"未转义引号" —— 首尾包裹载荷的那对引号本来就是字符串边界，
   * 正常存在。正确做法是**按 JS 规则走一遍状态机**：从第一个 ' 开始进入
   * 字符串态，遇到「前面是偶数个连续反斜杠」的 ' 才退出；若在退出后、
   * 下一个字符串起点之前出现了 alert( ，才算逃逸。
   */
  function payloadEscapes(js) {
    let i = 0, inString = false;
    while (i < js.length) {
      const ch = js[i];
      if (!inString) {
        if (ch === "'") { inString = true; i++; continue; }
        // 字符串之外：若出现 alert( 即逃逸成功
        if (js.startsWith('alert(', i)) return true;
        i++;
        continue;
      }
      // 字符串内：处理转义
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") { inString = false; i++; continue; }
      i++;
    }
    return false;
  }

  const viaAttr = decode(`f('${escAttr(payload)}')`);
  const viaQ = decode(`f('${escQ(payload)}')`);

  assert.strictEqual(viaAttr, "f('x');alert(1);//')", 'escAttr 版应产生可执行注入');
  assert.strictEqual(viaQ, "f('x\\');alert(1);//')", 'escQ 版应把引号转义掉');

  // 关键区别：escAttr 版的 alert( 落在字符串之外 ⇒ 会被执行；escQ 版仍在字符串内
  assert.ok(payloadEscapes(viaAttr), 'escAttr 版：alert 逃出了字符串（这正是缺陷）');
  assert.ok(!payloadEscapes(viaQ), 'escQ 版：alert 必须仍在字符串内（反斜杠转义生效）');
});
