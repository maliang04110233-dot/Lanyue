/**
 * 转义兜底与口径统一（2026-10-13 复审 P3-1 / P3-2）
 *
 * 两个旧洞：
 *
 * P3-1 · utils.js 的 esc 只转 & < > "，比 escAttr 少一个单引号。于是「内容用
 *   esc、属性用 escAttr」这个惯例留着裂缝：照着写出 title='${esc(x)}' 就能闭合
 *   属性挂事件。加上 highlight.js 的 escHtml，本仓曾有三套口径。
 *
 * P3-2 · songGroups.js / nameBatch.js 用 `typeof esc === 'function' ? esc : s =>
 *   String(s)` 兜底。全局 esc 尚未挂上时降级目标是**恒等**：远端歌名原文进
 *   innerHTML ⇒ 渲染层任意 JS ⇒ 拿到约 90 个 IPC 通道。恒等降级比不降级更危险，
 *   因为它看起来「已经处理过」。
 *   其中 songGroups.js 的 locateSongRow 实参还正好是 onclick 里的 JS 字符串
 *   字面量 —— 内联处理器守卫只按精确函数名扫描，esc_ 这个别名整条绕过了它。
 *
 * 本文件按本仓既有约定不加载渲染层 ESM（依赖 window/document 会炸链），而是把
 * escapeFallback.js 的源码原样求值来验证语义 —— 比「抄一份实现」强，改坏了会红。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 原样执行 escapeFallback.js 的源码（它零依赖，去掉 export 即可求值） */
function loadFallback() {
  const src = read('src/renderer/js/escapeFallback.js').replace(/^export\s+/gm, '');
  return new Function(`${src}\nreturn { escHtml, escJsString, escSafe, escQSafe };`)();
}

test('兜底实现：HTML 转义覆盖全部五个危险字符', () => {
  const { escHtml } = loadFallback();
  assert.strictEqual(escHtml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
  assert.strictEqual(escHtml(null), '', 'null 不该变成 "null" 字面量');
  assert.strictEqual(escHtml(undefined), '');
  assert.strictEqual(escHtml(0), '0', '数字 0 不能被 || 吞成空串');
});

test('兜底实现：内联 JS 字面量转义先反斜杠后单引号（顺序不能反）', () => {
  const { escJsString } = loadFallback();
  assert.strictEqual(escJsString("x');alert(1);//"), "x\\');alert(1);//");
  // 反斜杠必须先转，否则 `foo\` 会把后面的 \' 变成转义义，单引号照样逃出字符串
  assert.strictEqual(escJsString('foo\\'), 'foo\\\\');
  assert.strictEqual(escJsString(`<img src=x onerror="alert(1)">`),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('escSafe / escQSafe：全局版就绪时用全局版，没就绪时用等价兜底（都不是恒等）', () => {
  const { escSafe, escQSafe } = loadFallback();
  const hadEsc = Object.prototype.hasOwnProperty.call(globalThis, 'esc');
  const hadEscQ = Object.prototype.hasOwnProperty.call(globalThis, 'escQ');
  const prevEsc = globalThis.esc;
  const prevEscQ = globalThis.escQ;
  try {
    delete globalThis.esc;
    delete globalThis.escQ;
    // 全局缺席：必须仍然是安全转义，而不是 String(s)
    assert.strictEqual(escSafe(`it's <b>`), 'it&#39;s &lt;b&gt;');
    assert.strictEqual(escQSafe("x');alert(1);//"), "x\\');alert(1);//");

    globalThis.esc = (s) => `[[${s}]]`;        // 标记版：证明「优先用全局」
    globalThis.escQ = (s) => `{{${s}}}`;
    assert.strictEqual(escSafe('a'), '[[a]]');
    assert.strictEqual(escQSafe('a'), '{{a}}');
  } finally {
    if (hadEsc) globalThis.esc = prevEsc; else delete globalThis.esc;
    if (hadEscQ) globalThis.escQ = prevEscQ; else delete globalThis.escQ;
  }
});

test('P3-1：utils.js 的 esc 与 escAttr 口径一致（单引号也被转义）', () => {
  const utils = read('src/renderer/js/utils.js');
  const escBody = /function esc\(s\)\s*\{([\s\S]*?)\n\}/.exec(utils);
  assert.ok(escBody, '找不到 utils.js 里的 esc 函数');
  assert.match(escBody[1], /escAttr\(s\)/,
    'esc 应直接委托 escAttr，别再各写一份（两份必然漂 —— 本仓已经漂过一次）');

  // 语义等价性直接验证（escAttr 的实现抄自源文件，避免维护两份测试期望）
  const attr = /function escAttr\(s\)\s*\{\s*return String\(s \|\| ''\)[\s\S]*?;\s*\}/.exec(utils);
  assert.ok(attr, '找不到 utils.js 里的 escAttr');
  const escAttrFn = new Function(`${attr[0]}; return escAttr;`)();
  assert.strictEqual(escAttrFn(`a'b"c`), 'a&#39;b&quot;c',
    'escAttr 必须转义单引号（否则单引号属性可被闭合）');
});

/** 去掉行尾注释与整行注释：注释里引用旧写法（`... : (s => String(s))`）不算违规 */
function codeOnly(src) {
  return src.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => !/^\s*(\*|\/\*)/.test(l))
    .join('\n');
}

test('P3-2：调用点不再有恒等降级', () => {
  const offenders = [];
  for (const rel of ['src/renderer/js/songGroups.js', 'src/renderer/js/views/nameBatch.js']) {
    if (/:\s*\(s\s*=>\s*String\(s\)\)/.test(codeOnly(read(rel)))) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [],
    '这些文件仍把 esc 缺失时的兜底写成恒等函数 —— 远端数据会以原文进 innerHTML');

  assert.match(read('src/renderer/js/songGroups.js'), /escQSafe\(it\.id\)/,
    'locateSongRow 的实参在 onclick 的 JS 字符串里，必须是 escQ 语义');
  assert.match(read('src/renderer/js/songGroups.js'), /import \{ escSafe, escQSafe \}/,
    '应从零依赖兜底模块取用，而不是自己判全局');
});
