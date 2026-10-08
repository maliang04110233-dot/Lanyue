/**
 * 守卫：源码/测试里不得出现编码损坏（mojibake）
 *
 * ── 为什么需要这条 ────────────────────────────────────────────
 *
 * 2026-09-28 修复过程中，`test/playlist-trash.test.js` 被一次 PowerShell 写文件
 * 意外改成 GBK 解码 → UTF-8 落盘，整个文件变成乱码。**当时 2319 条测试全绿**：
 * 因为损坏的全是注释、用例名和断言消息，而这些不参与判定。
 *
 * 这类损坏的危险不在于当场报错，而在于：
 *   1. 文件从此不可读 —— 后人 review 时读不懂，交叉引用（增量号、LEDGER 台账）
 *      全部对不上账；
 *   2. **它会伪装成「没改过」**。`git diff` 里每一行中文都变，自然被当成
 *      「这个文件大改了一遍」而滑过去；
 *   3. 只有当损坏落在正则或期望串上时才会红 —— 而那已经是附带损害了。
 *
 * 编码损坏的识别特征很稳定：UTF-8 中文被当 GBK 解码后，会产生一批
 * 「简体中文里几乎不会出现」的字符（平假名、欧元号、汉字部首替代符、CJK
 * 兼容区叠字，以及替换符 U+FFFD）。真人手写的中文源码不会包含这些。
 * 特征表在下方用 \uXXXX 转义构造 —— 字面量会把本文件自己判成损坏。
 *
 * 允许清单机制：`src/main/ipc/library.js` 里有一行注释**故意提到** U+FFFD
 * （它在讲「兜底移除乱码替换字符」），那是合法命中。白名单按
 * `相对路径:行号` 精确到行，并要求该行必须是注释 —— 白名单本身过期了
 * （文件删了/行移了/不再提这件事）这条会红，避免它变成万能豁免。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'test', 'scripts', 'build', 'docs', '.github'];
const EXTS = /\.(js|cjs|mjs|json|html|css|yml|yaml|md|py)$/i;

// 编码损坏特征字符。刻意不用「含 U+FFFD」一条兜底 —— 那是留给白名单解释的。
//
// 全部用 \uXXXX 转义构造：特征字符一旦以字面量出现在本文件里，本守卫就会
// 把自己判成损坏（第一版就这么翻车了）。转义后文件本身不含任何特征字符。
const SIGNATURE_CHARS = [
  '\uFFFD',                     // 替换符：非法字节序列的产物
  '\uE000', '\uF8FF',           // 私用区：GBK 误解码常落这里
  '\u951B', '\u9226',           // UTF-8 句读被当 GBK 读的典型残留
  '\u9225', '\u922B',
  '\u20AC',                     // 欧元号：半个字符被吃时的高频替身
  '\u3089', '\u308A', '\u3088', // 平假名：简体中文源码里不该有
  '\u3041', '\u3043', '\u3045',
  '\u3005', '\u3223',           // 叠字符与带括号叠字
];
// 「形态词」逐字匹配：这些串是「增量 / 收编 / 必须 / 确认」被 GBK 误解码后的
// 固定形态。不收进上面的单字表 —— 逐字匹配误报面更小，且从 diff 里能一眼
// 认出是哪一次损坏。转义构造，原因同上（本文件不能含任何特征字符）。
const SIGNATURE_WORDS = [
  '\u6F66\u70BA\u568E',         // 增量的误解码形态
  '\u93C8\u781D\u6892',         // 收编的误解码形态
  '\u93B5\u53E5\u4E0D',         // 必须的误解码形态
  '\u7EAD\u6D5F',               // 确认的误解码形态
  '\u94A6\u70B9',               // 按钮的误解码形态
  '\u54C8\u70B3',               // 回放的误解码形态
  '\u7B1B\u5C7E',               // 馆/览 类的误解码形态
  '\u59EC\u4EAB',               // 姝屽崟 一类
].join('|');
const SIGNATURE = new RegExp(`[${SIGNATURE_CHARS.join('')}]|${SIGNATURE_WORDS}`);

/** 合法命中：讲到 U+FFFD 本身的注释行。精确到行，过期即红。 */
const ALLOWED = new Set([
  'src/main/ipc/library.js:481',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.backup', '.preview', 'spark-output']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, out); continue; }
    if (EXTS.test(name)) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

test('扫描面非空（别让守卫因为路径写错而空转）', () => {
  assert.ok(files.length > 150, `只扫到 ${files.length} 个文件，路径或扩展名白名单写错了`);
});

test('源码与测试里没有编码损坏（乱码）', () => {
  const hits = [];
  for (const p of files) {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!SIGNATURE.test(line)) return;
      const at = `${rel}:${i + 1}`;
      if (ALLOWED.has(at)) return;
      hits.push(`${at}  ${JSON.stringify(line.trim().slice(0, 70))}`);
    });
  }
  assert.deepStrictEqual(
    hits, [],
    `发现 ${hits.length} 处编码损坏。\n`
      + '成因通常是 PowerShell 写文件时按 ANSI 码页解码（Get-Content/Set-Content/\n'
      + 'Out-File 未指定 -Encoding utf8）。这类损坏在测试全绿时也不会暴露，\n'
      + '所以只能靠静态扫描拦。修法：用 UTF-8 明确读写，或用编辑工具改文件。\n'
      + '若某行确实是「合法提到乱码字符」的注释，把它加进本文件的 ALLOWED（精确到行）。\n'
      + `命中明细：\n  ${hits.slice(0, 20).join('\n  ')}`,
  );
});

test('白名单本身不许过期（否则它会变成万能豁免）', () => {
  for (const at of ALLOWED) {
    const idx = at.lastIndexOf(':');
    const rel = at.slice(0, idx);
    const lineNo = Number(at.slice(idx + 1));
    const abs = path.join(ROOT, rel.split('/').join(path.sep));
    assert.ok(fs.existsSync(abs), `白名单条目 ${at} 指向的文件已不存在，请删掉该条目`);
    const line = fs.readFileSync(abs, 'utf8').split('\n')[lineNo - 1];
    assert.ok(line !== undefined, `白名单条目 ${at} 指向的行不存在（文件变短了？）`);
    assert.match(
      line, /^\s*(\/\/|\*|\/\*)/,
      `白名单条目 ${at} 已不再指向注释行 —— 允许豁免一个非注释行等于给真实损坏开后门，请复核`,
    );
  }
});

test('三份语言词典必须是纯 UTF-8 可解析的 JSON（编码坏了会在这里现形）', () => {
  for (const rel of ['src/renderer/js/lang/zh.json', 'src/renderer/js/lang/en.json']) {
    const p = path.join(ROOT, rel.split('/').join(path.sep));
    const raw = fs.readFileSync(p, 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, `${rel} 不是合法 JSON`);
    assert.ok(Object.keys(parsed).length > 100, `${rel} 键数异常（${Object.keys(parsed).length}）`);
    assert.ok(!SIGNATURE.test(raw), `${rel} 含编码损坏特征字符`);
  }
});

test('所有源文件都是 UTF-8 且不含 BOM', () => {
  // BOM 会让部分解析器（含某些 JSON/正则路径）行为不同，且在 diff 里极难发现。
  const withBom = [];
  for (const p of files) {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(3);
    try { fs.readSync(fd, buf, 0, 3, 0); } finally { fs.closeSync(fd); }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      withBom.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  }
  assert.deepStrictEqual(withBom, [], `这些文件带 UTF-8 BOM：${withBom.join(', ')}`);
});
