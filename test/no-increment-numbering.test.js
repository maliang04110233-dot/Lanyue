/**
 * 守卫：源码与测试里不得出现「词 + 数字」式的改动序号
 *
 * ── 为什么要禁 ─────────────────────────────────────────────────
 *
 * 本仓库长期用「改动序号 + 数字」标注注释、用例名与断言消息，给每一次提交排
 * 一个连续号。这套机制有三种失效模式，且每一种都已经在仓库里发生过：
 *
 *   1. 撞号 —— 同一号码被两次使用。界面语言对齐与首个下载庆祝各占一个号，
 *      但号相同；引用它的人无从判断指的是哪一个，注释因此失去指向性。
 *   2. 空洞与悬空 —— 已占用的号不连续（有号无提交）；另有 14 个号在 git 历史
 *      里查不到任何提交，引用它们的人无处可查。
 *   3. 记账成本 —— 每次改动都要查前一个号是几、登记进台账、撞号了回头改注释。
 *      这是纯粹的管理开销；注释里真正有用的是描述文本本身，不是那个数字。
 *
 * 删掉序号之后，追溯靠 git 短哈希 —— 那是唯一不会重号的锚点。真正的交叉引用
 * （「同一课的教训」「同一个坑」）已改写为 7 位短哈希。
 *
 * ── 判定边界：禁的是形态，不是词 ───────────────────────────────
 *
 * 仓库里有大量该词的合法技术用法：增量扫描 / 增量缓存 / 增量重扫 / 增量路径，
 * 以及「本增量 / 上一增量」这类名词用法。一刀切禁词会把正常代码判成违规，
 * 反而训练团队忽略守卫 —— 所以只禁「词 + 空白? + 数字」这个编号形态，
 * 并用反向钉把合法用法固定下来：若有人把守卫误写成禁词，这些钉立刻红。
 *
 * ── 白名单机制 ─────────────────────────────────────────────────
 *
 * ALLOWED 精确到「相对路径:行号」，且必须是注释/文档行；条目过期（文件删了、
 * 行移了、内容变了）这条会红，避免白名单变成万能豁免。
 * 当前为空 —— 全部序号已清除，含审查报告里的两处（已改写句子以保持可读）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'test', 'scripts', 'build', 'docs', '.github'];
const EXTS = /\.(js|cjs|mjs|json|html|css|yml|yaml|md|py)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.backup', '.preview', 'spark-output']);

// 编号形态：词 + 可选空白 + 数字，可带 -A/-B 后缀（曾出现过的子序号写法）。
// 词用 \uXXXX 构造：一旦以字面量带数字写进本文件，本守卫会把自己判成违规。
const WORD = '\u589e\u91cf';
const REF = new RegExp(`${WORD}\\s*\\d+(?:\\s*-\\s*[A-Z])?`);

// 反向钉：词后面不是数字的合法用法。
const LEGIT_RE = new RegExp(`${WORD}(?!\\s*\\d)`);
const LEGIT_MIN = 40;
const LEGIT_MUST_CONTAIN = ['增量扫描', '增量缓存', '增量重扫'];

// 允许清单：`相对路径:行号`。当前为空。
const ALLOWED = new Set([]);

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

test('判定正则自检：命中编号形态，放过合法技术用法', () => {
  assert.match(WORD + '213', REF, '数字紧贴应命中');
  assert.match(WORD + ' 213', REF, '带空白的编号应命中');
  assert.match(WORD + '126-B', REF, '带字母后缀的子序号应命中');
  for (const good of ['增量扫描', '增量缓存', '本增量把它', '增量${n}', '增量']) {
    assert.doesNotMatch(good, REF, `「${good}」是合法用法，被误判成编号形态`);
  }
});

test('源码与测试里没有改动序号（词 + 数字）', () => {
  const hits = [];
  for (const p of files) {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!REF.test(line)) return;
      const at = `${rel}:${i + 1}`;
      if (ALLOWED.has(at)) return;
      hits.push(`${at}  ${JSON.stringify(line.trim().slice(0, 70))}`);
    });
  }
  assert.deepStrictEqual(
    hits, [],
    `发现 ${hits.length} 处改动序号。\n`
      + '追溯改用 git 短哈希（git log --oneline）。真正的交叉引用（同一课的教训、\n'
      + '同一个坑）写 7 位短哈希；纯装饰性的序号连同它带的标点一起删掉。\n'
      + `命中明细：\n  ${hits.slice(0, 20).join('\n  ')}`,
  );
});

test('反向钉：合法的「词」用法必须原样保留（防止守卫被误写成禁词）', () => {
  let count = 0;
  let all = '';
  for (const p of files) {
    const t = fs.readFileSync(p, 'utf8');
    all += t + '\n';
    const m = t.match(new RegExp(LEGIT_RE.source, 'g'));
    if (m) count += m.length;
  }
  assert.ok(
    count >= LEGIT_MIN,
    `合法的「${WORD}」用法只剩 ${count} 处（阈值 ${LEGIT_MIN}）。\n`
      + '它们不是编号：增量扫描/增量缓存等是技术术语，「本增量/上一增量」是名词用法。\n'
      + '如果守卫被改成禁词而非禁形态，这些会被连坐删掉 —— 这条钉就是防这个。',
  );
  for (const form of LEGIT_MUST_CONTAIN) {
    assert.ok(all.includes(form), `合法用法「${form}」消失了 —— 它不是编号，不许被连坐`);
  }
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
      line, /^\s*(\/\/|\*|\/\*|<!--|-|\*|#)/,
      `白名单条目 ${at} 已不再指向注释/文档行 —— 允许豁免一个可执行行等于给真实违规开后门，请复核`,
    );
  }
});
