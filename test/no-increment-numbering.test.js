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
 * ── 序号 vs 测量值：形态上的分界是「数字后面有没有单位」──────────────
 *
 * 「增量 2062 B」是日志字节增量这个**测量值**（要放行）；而「增量」后面直接跟
 * 一个**没有任何单位**的光秃秃数字（形如本守卫自检里的编号样例），那才是改动
 * 序号（要禁）。两者在词表上完全一样，形态上能分的只有一个：**数字后面跟不跟单位**。
 * 程序输出里这类读数很常见（本仓库冒烟脚本的 WAIT 行就是「增量 <字节数> B」），
 * 引用它的验收单、报告、日志摘录都会被原样抄进去 —— 它们是客观读数，不是
 * 「拿序号当隐藏交叉引用」，而后者才是这个守卫真正要防的东西。
 *
 * 为什么不用白名单豁免：白名单精确到「路径:行号」，条目会随文件编辑腐烂，
 * 而且它会让守卫退化成「有豁免就不再检查」。为什么不去改输出迁就守卫：
 * 那是判据去迁就实现，方向反了 —— 该改的是判据，不是读数。
 *
 * 一条边界必须守住：**子序号形态（数字 + 连字符 + 字母）仍然是序号**。那里的
 * 字母是序号后缀（历史上真出现过「3-B」这种写法），不是单位。所以单位豁免
 * 要求数字与单位之间**只有空白**（不许有连字符），且「-X 后缀」这一支
 * **优先于**单位豁免被匹配。
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
// ── 单位清单：数字后面紧跟这些单位时，那个数字是**测量值**（字节数、毫秒数、
// 条目数……），不是改动序号，放行。清单「可增不可减地收窄」：只允许加单位，
// 不允许删 —— 删一个就等于把一类真实读数重新变成误报。
const UNITS = [
  'B', 'KB', 'MB', 'GB', 'TB',
  '字节', 'ms', '毫秒', 's', '秒',
  '次', '行', '条', '个', '项',
];
// 正则里的单位交替：按长度倒排（长的排前面），避免短单位抢在长单位前面。
const UNIT_ALT = UNITS.slice().sort((a, b) => b.length - a.length).join('|');

// 违规形态 = 两支并列：
//   ① 「词 + 空白? + 数字 + -X 子序号」—— 一律违规。**这一支优先于单位豁免**
//      被匹配：子序号里的字母是序号后缀（历史上真出现过「3-B」这种写法），
//      不是单位，绝不能被下面的豁免吃掉。
//   ② 「词 + 空白? + 数字」—— 只有当这个数字**后面不是**「空白 + 单位」时才算违规。
//
// ② 的否定前瞻写成 (?![\\d\\s]*单位)：前瞻里多吃了数字与空白，是为了防正则
// 回溯把 2062 拆成 206、再把剩下的「2 B」当成单位 —— 没有这一手，
// 「词+2062B」（数字与单位之间无空白）会被误判成序号。
const REF = new RegExp(
  `${WORD}\\s*\\d+(?:\\s*-\\s*[A-Z])`
  + `|${WORD}\\s*\\d+(?![\\d\\s]*(?:${UNIT_ALT}))`,
);

// 测量值形态：词 + 空白? + 数字 + 空白? + 单位（数字与单位之间不得有连字符，
// 所以子序号形态不会落进这里）。仓库级钉用它找「例外条款仍在被行使」的证据。
const MEASUREMENT_RE = new RegExp(`${WORD}\\s*\\d+\\s*(?:${UNIT_ALT})`);

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

// ── 序号 vs 测量值：分界钉 ────────────────────────────────────────────────
// 正向钉：裸数字（序号）仍然命中，且**子序号形态必须优先于单位豁免**——
// 「3-B」里的 B 是序号后缀，不是字节单位，豁免不许把它吃掉。
// 反向钉：带单位的数字（测量值）不命中。
test('判定正则自检：测量值放行、裸数字仍是序号、子序号不被单位豁免吃掉', () => {
  // 反向钉：测量值不得被误判成序号。
  assert.doesNotMatch(WORD + ' 2062 B', REF, '字节增量是测量值，不是序号');
  assert.doesNotMatch(WORD + ' 512 字节', REF, '中文单位同理');
  assert.doesNotMatch(WORD + '2062B', REF, '数字与单位之间没有空白也算测量值（防回溯把数字拆开）');
  assert.doesNotMatch(WORD + ' 12 ms', REF, '耗时毫秒数也是测量值');
  assert.doesNotMatch(WORD + ' 3 次', REF, '带计数单位也是测量值');

  // 正向钉：序号仍然命中（规则不许被放宽成「一律放行」）。
  assert.match(WORD + '213', REF, '裸数字仍然是序号');
  assert.match(WORD + ' 213', REF, '裸数字（带空白）仍然是序号');
  assert.match(WORD + ' 3-B', REF, '子序号必须仍判违规（3-B 的 B 是序号后缀，不是字节）');
  assert.match(WORD + '3-B', REF, '子序号（无空白）同样违规');
  assert.match(WORD + ' 213 ', REF, '裸数字后跟空格仍然违规（后面没有单位）');
});

// ── 仓库级钉：例外条款必须真的在被行使 ───────────────────────────────────
// 否则这条例外会退化成「永远用不上的死规则」，而且删掉它也没人会发现
// （外部用法可能随归档一起消失）。所以：仓库里必须**确实存在**测量型用法，
// 且它们**没有**被判成序号；守卫文件自身也必须留一处 —— 它是最后一道保险。
test('仓库级钉：测量型用法确实存在，且没有被判成序号（例外条款不是死规则）', () => {
  const measurementHits = [];
  const flagged = [];
  for (const p of files) {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (!MEASUREMENT_RE.test(line)) return;
      const at = `${rel}:${i + 1}`;
      measurementHits.push(at);
      if (REF.test(line)) flagged.push(`${at}  ${JSON.stringify(line.trim().slice(0, 70))}`);
    });
  }
  assert.ok(
    measurementHits.length >= 1,
    '仓库里一处「词 + 数字 + 单位」的测量值用法都没有了 —— 例外条款变成死规则。'
      + '请复核：是规则该收紧，还是这类读数从仓库里消失了？',
  );
  assert.deepStrictEqual(
    flagged, [],
    '测量值形态被判成了序号。带单位的读数是客观测量（字节数、毫秒数），'
      + '不是「拿序号当隐藏交叉引用」—— 后者才是本守卫要防的东西。',
  );
  assert.ok(
    measurementHits.some((at) => at.startsWith('test/no-increment-numbering.test.js:')),
    '守卫文件自身必须保留一处测量型用例：它是「例外条款仍被行使」的最后一道保险'
      + '（外部用法可能随归档一起消失，那时删掉例外就没人会发现）。',
  );
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
      + '（数字后面带单位的读数是测量值，如字节数、毫秒数，已放行；本守卫只抓\n'
      + '没有单位的裸数字，以及「数字 + 连字符 + 字母」的子序号形态。）\n'
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
