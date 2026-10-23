/**
 * 守卫：`docs/process/` 的流程规范必须与仓库事实对得上
 *      （命令存在 / 内链可达 / 章节引用可达 / 路径引用存在）
 *
 * ── 为什么需要这条 ────────────────────────────────────────────
 *
 * `docs/process/` 的六份文档（1386 行）定义「什么需求允许开工、什么状态允许签收」，
 * 是本仓的交付作业系统 —— 但它自己**一条自动化守卫都没有**。建目录当天就已经在
 * 引用一份不存在的文件（`docs/process/DEMAND-LEDGER.md`）。这不是笔误，是「靠人记」
 * 的必然产物：文档之间互相引用几十次、命令写了几十条，每次增删 `package.json` 的
 * scripts、搬动一个源文件、重排一节编号，都要求作者同时记得改五六份文档里的五六处
 * 引用。人做不到，也不该被要求做到。
 *
 * 靠人记会以三种方式失效，而且**三种都不报错**：
 *
 *   1. 「命令漂移」：规范写着 `npm run check:xxx`，scripts 里早已改名或删掉。
 *      执行者跑出 `Missing script`，第一反应是「我环境坏了」，不是「文档错了」——
 *      于是这条门禁被绕过去。写一个不存在的命令，比不写更糟。
 *   2. 「链接/路径漂移」：`./DEMAND.md`、`src/utils/fsAsync.js` 指到不存在的目标。
 *      读者点开是空的，只好凭记忆找替代品，「单一事实来源」随即退化成口头约定。
 *      本仓常态是工作区带着上百项未提交改动（文件搬了、文档没跟），这类漂移每天都在产生。
 *   3. 「章节漂移」（最隐蔽）：`见 DEMAND.md §1.1` 指向的小节被重排成 §1.4。句子仍然
 *      通顺、仍然「有个出处」，但那个出处已经答非所问 —— 而「定义只写一份、其余交叉
 *      引用」这整条纪律，全靠 § 引用落地。引用错了，纪律就只剩口号。
 *
 * 三者的共同点：**文本读起来完全正常**。所以只能把它们变成可判定事实。
 *
 * ── 口径：宁可漏检，不可误报 ─────────────────────────────────
 *
 * 守卫最糟的结局不是漏检，而是误报多到被人 `SKIP` 掉 —— 那比没有守卫更糟，因为它
 * 还占着「这条已经守住了」的心理位置。所以四条断言都刻意收窄，收窄处逐条注明理由：
 *   · 只扫描下方 GUARDED_DOCS 写死的 9 份文档，不遍历 docs/ 全量（理由见末段）；
 *   · 命令只认 `npm run <script>`，不管其后的参数与管道（`npm test` / `npm ci`
 *     不是 `npm run` 形式，本就不是 scripts 里的一条，不参与校验）；
 *   · 路径只认 8 个已知前缀，含 `* ? < > { }` 的一律跳过（通配与占位符本来就是示意写法）；
 *   · 章节引用只校验 `X.md §N` / `X.md §N.M`，不校验锚点、不校验「裸 §N」（省略文件名
 *     的同文档引用）。裸引用在散文里真实存在且经常是跨文档的省略写法：COLLABORATION.md
 *     第六节写的「是 C3 走 §4.2 的 R1–R3」，那个 §4.2 指 DEMAND.md 的 §4.2，本文自己没有
 *     4.2 节 —— 硬校验必然误报。已知盲区如实记在这里，而不是靠放宽判据去糊。
 *
 * ── 为什么清单写死，不 readdirSync ───────────────────────────
 *
 * 新增文档必须由人显式纳入守卫范围：否则一份归档进 `docs/process/` 的临时文档会莫名
 * 让门禁变红，而最省事的处置是把它从清单里删掉 —— 一删，整类漂移就重新失去守卫。
 * 反向也钉住：清单里的文件缺失时本文件直接失败（见第一枚测），所以「悄悄从清单里删」
 * 与「悄悄加一个空文件」两条路都是红的。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * 被守卫的文档清单（写死，不遍历目录；理由见文件头末段）。
 * 前 7 份是流程规范本体，后 2 份是与它互相引用的仓库级文档。
 */
const GUARDED_DOCS = [
  'docs/process/README.md',
  'docs/process/DEMAND.md',
  'docs/process/DEMAND-LEDGER.md',
  'docs/process/COLLABORATION.md',
  'docs/process/DELIVERY.md',
  'docs/process/ENGINEERING.md',
  'docs/process/QA.md',
  'CONTRIBUTING.md',
  'docs/RELEASING.md',
];

/** 只校验这 8 个前缀下的反引号路径（见 D 段：其余写法多为示意，误报成本高） */
const PATH_PREFIXES = [
  'src/',
  'test/',
  'docs/',
  'scripts/',
  'build/',
  'hooks/',
  '.github/',
  'deliverables/',
];

const toAbs = (rel) => path.join(ROOT, ...rel.split('/'));
const toPosix = (p) => p.split(path.sep).join('/');
const docExists = (rel) => fs.existsSync(toAbs(rel));
const readLines = (rel) => fs.readFileSync(toAbs(rel), 'utf8').split(/\r?\n/);

/**
 * 扫描面：清单里**实际存在**的文档。
 * 缺失的那份由第一枚测单独报红 —— 否则扫描类测试会各自抛 ENOENT，真正的原因
 * （「清单里的文件不存在」）会被 4 条堆栈埋掉。
 */
const presentDocs = () => GUARDED_DOCS.filter((rel) => docExists(rel));

/** 长清单截断到可读长度：报错信息里贴全量会把真正的那一行淹掉 */
function previewList(list, limit = 40) {
  const sorted = [...list].sort();
  if (sorted.length <= limit) return sorted.join(', ');
  return `${sorted.slice(0, limit).join(', ')} …（共 ${sorted.length} 条）`;
}

// ── 0. 扫描面本身（守卫自己的地基） ───────────────────────────

test('清单里的每份文档都必须存在——防「清单少一份」变成悄悄豁免', () => {
  const missing = GUARDED_DOCS.filter((rel) => !docExists(rel));
  assert.deepStrictEqual(
    missing,
    [],
    `docs/process 规范引用了这些不存在（或已被移走）的文件：\n  ${missing.join('\n  ')}\n`
      + '清单是刻意写死的：确认真的换了位置就把新路径写进本文件顶部 GUARDED_DOCS，\n'
      + '不要靠删条目让它变绿（那会让整类漂移重新失去守卫）。',
  );
});

// ── A. 命令存在性 ─────────────────────────────────────────────

/**
 * `npm run <script>` 的脚本名：允许 `:` 与 `-`（`check:dead-deps` / `test:coverage` /
 * `verify:release` / `smoke:asar`）。后面的参数（`npm run bench -- --check`）不参与校验。
 */
const NPM_RUN_RE = /npm run ([A-Za-z0-9:_-]+)/g;

test('docs 里写的每个 npm run 脚本都必须真实存在——防规范给出不存在的命令', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = Object.keys(pkg.scripts || {});
  assert.ok(names.length > 10, `package.json 的 scripts 只解析出 ${names.length} 条，解析口径写错了`);

  const hits = [];
  let seen = 0;
  for (const rel of presentDocs()) {
    readLines(rel).forEach((line, i) => {
      for (const m of line.matchAll(NPM_RUN_RE)) {
        seen += 1;
        if (!names.includes(m[1])) hits.push(`${rel}:${i + 1}  →  npm run ${m[1]}`);
      }
    });
  }
  assert.ok(seen >= 20, `只扫到 ${seen} 处 npm run，扫描口径可能写窄了（这批文档实测 70+ 处）`);
  assert.deepStrictEqual(
    hits,
    [],
    `规范里出现了 package.json 没有的命令（执行者跑出 Missing script，会以为自己环境坏了）：\n`
      + `  ${hits.join('\n  ')}\n`
      + `package.json 现有 scripts：${previewList(names)}`,
  );
});

// ── B. 内链存在性 ─────────────────────────────────────────────

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\n]+)\)/g;
/** 外部链接与纯锚点不参与校验（`tel:` 与根绝对路径一并放过，属保守取舍） */
const NON_INTERNAL_LINK_RE = /^(?:https?:|mailto:|tel:|#|\/)/i;

test('docs 里的相对内链必须指向真实文件——防读者点开是空的', () => {
  const hits = [];
  let seen = 0;
  for (const rel of presentDocs()) {
    // 关键：相对路径按「声明该链接的文件所在目录」解析，不是一律以仓库根解析
    const baseDir = path.dirname(toAbs(rel));
    readLines(rel).forEach((line, i) => {
      for (const m of line.matchAll(MD_LINK_RE)) {
        const raw = m[2].trim();
        if (NON_INTERNAL_LINK_RE.test(raw)) continue;
        // 剥掉 `"标题"` 与 `#锚点`：锚点不校验（Markdown 锚点规则复杂，误报成本高于收益）
        const target = raw.split(/\s+/)[0].split('#')[0];
        if (!target) continue;
        seen += 1;
        const absTarget = path.resolve(baseDir, target);
        if (fs.existsSync(absTarget)) continue;
        hits.push(
          `${rel}:${i + 1}  [${m[1]}](${raw})  →  ${toPosix(path.relative(ROOT, absTarget))}`,
        );
      }
    });
  }
  assert.ok(seen >= 6, `只扫到 ${seen} 条相对内链，扫描口径可能写窄了`);
  assert.deepStrictEqual(
    hits,
    [],
    `这些内链指向不存在的文件（相对路径按「文档所在目录」解析，不是仓库根）：\n`
      + `  ${hits.join('\n  ')}`,
  );
});

// ── C. 章节引用存在性（最重要的一条） ─────────────────────────

const CN_DIGITS = {
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字 → 数（0–99 够用：这批文档最大到 §十三） */
function cnToNumber(text) {
  if (!text.includes('十')) return CN_DIGITS[text];
  const [head, tail] = text.split('十');
  const tens = head === '' ? 1 : CN_DIGITS[head];
  const ones = tail === '' ? 0 : CN_DIGITS[tail];
  return tens * 10 + ones;
}

/** 章节键的规范形态：零写作 `〇`，其余写十进制（`1`、`1.1`、`12`） */
function numberToKey(n) {
  return n === 0 ? '〇' : String(n);
}

/** 把引用里的编号归一成章节键：`§〇`→`〇`、`§二`→`2`、`§0`→`0`（后者永远匹配不上） */
function refToKey(text) {
  if (/^\d/.test(text)) {
    return text
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }
  return numberToKey(cnToNumber(text));
}

/** 代码块不可信：围栏里的 `### 1.1` 是**示例文本**，不是本文件真有的小节 */
function maskFences(lines) {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/**
 * 目标文档实际拥有的小节编号。
 *   `## 〇、…` / `## 一、…` / `## 七、…`       → 〇 / 1 / 7（中文数字需映射）
 *   `### 1.1 …` / `### 6.3 …`                 → 1.1 / 6.3
 *   `### H1 …` / `### DoD-1 …` / `### 1. …`   → 不参与（非「N.M」形态的编号不进 § 引用体系）
 */
function sectionsOf(rel) {
  const keys = new Set();
  for (const line of maskFences(readLines(rel))) {
    const section = /^##\s+([〇一二三四五六七八九十]+)、/.exec(line);
    if (section) {
      const n = cnToNumber(section[1]);
      if (Number.isFinite(n)) keys.add(numberToKey(n));
      continue;
    }
    const sub = /^###\s+(\d+)\.(\d+)(?:\s|$)/.exec(line);
    if (sub) keys.add(`${Number(sub[1])}.${Number(sub[2])}`);
  }
  return keys;
}

/** 章节键的可读排序：〇 在前，然后按主次号（否则 `10` 会排在 `2` 前面） */
function sortKeys(keys) {
  const major = (k) => (k === '〇' ? -1 : Number(k.split('.')[0]));
  const minor = (k) => (k.includes('.') ? Number(k.split('.')[1]) : -1);
  return [...keys].sort((a, b) => major(a) - major(b) || minor(a) - minor(b));
}

/** 清单里各文档的 basename → 相对路径（章节引用的 `X.md` 靠它定位） */
const DOC_BY_BASENAME = new Map(GUARDED_DOCS.map((rel) => [path.posix.basename(rel), rel]));

/**
 * `X.md` 可带目录部分（`docs/process/DEMAND.md`），不带时按 basename 在清单里查。
 *
 * 带目录部分的写法先按**仓库根**解析：文档里 `docs/RELEASING.md §六` 这种写法是
 * 根相对（与 `[`.github/workflows/`](...)` 的反引号路径同一惯例），不是相对当前文件。
 * 但相对当前文件的写法（`../RELEASING.md`）也真实存在，所以两者都试一遍 ——
 * 只试一种，要么 12 处根相对引用全红，要么 `../` 那类全红。
 */
function resolveRefDoc(fromRel, token) {
  if (!token.includes('/')) return DOC_BY_BASENAME.get(token) || null;
  const candidates = [
    toPosix(path.normalize(token)),
    toPosix(path.relative(ROOT, path.resolve(path.dirname(toAbs(fromRel)), token))),
  ];
  return candidates.find((rel) => docExists(rel)) || candidates[0];
}

/**
 * `X.md §N` / `X.md §N.M` / `X.md §〇`（文件名常被反引号包住，故允许一个尾随反引号）。
 * 已知盲区：`§1.1、§1.2` 这类链式引用只认第一个 —— 第二个没有文件名可依据，
 * 而「裸 §N 是哪个文档」本身无解（见文件头口径段）。宁可漏检。
 */
const SECTION_REF_RE = /([A-Za-z0-9_./-]+\.md)`?\s*§\s*([〇一二三四五六七八九十]+|\d+(?:\.\d+)?)/g;

test('docs 里交叉引用的每个 §小节都必须真实存在——防「见 X.md §1.1」指到不存在的地方', () => {
  const hits = [];
  let seen = 0;
  for (const rel of presentDocs()) {
    readLines(rel).forEach((line, i) => {
      for (const m of line.matchAll(SECTION_REF_RE)) {
        const target = resolveRefDoc(rel, m[1]);
        if (!target) continue; // 不在清单里（POSTMORTEM-…、架构文档等）：不是本文守卫的引用
        seen += 1;
        const where = `${rel}:${i + 1}  「${m[1]} §${m[2]}」`;
        if (!docExists(target)) {
          hits.push(`${where}  →  ${target} 不存在`);
          continue;
        }
        const keys = sectionsOf(target);
        const want = refToKey(m[2]);
        if (keys.has(want)) continue;
        const hint = want === '0' ? '；编号零必须写 §〇，§0 谁都匹配不上' : '';
        hits.push(
          `${where}  →  ${target} 里没有 §${m[2]}${hint}；该文档实有：${sortKeys(keys).join(' ')}`,
        );
      }
    });
  }
  assert.ok(seen >= 40, `只扫到 ${seen} 处 § 交叉引用，扫描口径可能写窄了（实测 60+ 处）`);
  assert.deepStrictEqual(
    hits,
    [],
    `这些交叉引用指不到实际小节（「单一事实来源」全靠 § 引用落地，指错了纪律就成口号）：\n`
      + `  ${hits.join('\n  ')}`,
  );
});

test('章节编号的零只写 §〇——§0 是错误写法，规范里不许出现', () => {
  // 标题侧 `## 〇、` 已用中文数字，引用侧沿用同一写法：§0 与 §〇 指的同一节，
  // 但 §0 在视觉上会被当成「阿拉伯序号体系」的开头，与 §1……§七 混用后无法自洽。
  const hits = [];
  for (const rel of presentDocs()) {
    readLines(rel).forEach((line, i) => {
      if (/§\s*0/.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepStrictEqual(
    hits,
    [],
    `这些位置把编号零写成了阿拉伯数字（应为 §〇）：\n  ${hits.join('\n  ')}`,
  );
});

test('扫描器地基：编号解析与代码块屏蔽真能区分「真小节」与「示例文本」', () => {
  // 真实文档上的定向断言（解析器坏掉时这里先红，而不是等引用测给出莫名其妙的清单）
  const demand = sectionsOf('docs/process/DEMAND.md');
  for (const key of ['〇', '1', '1.1', '1.2', '3.3', '6.3']) {
    assert.ok(demand.has(key), `DEMAND.md 应解析出 §${key}，实得：${sortKeys(demand).join(' ')}`);
  }
  // `### 需求 <ID> · <标题>`（§3.2 的模板）不是小节，不许进编号集合
  assert.ok(![...demand].some((k) => k.includes('<')), '模板里的示例标题被当成了真小节');

  // `### 1. 主进程即 UI 线程` 是三级标题但只有一个号：它不属于 §N.M 体系，也不许冒充 §1
  const contributing = sectionsOf('CONTRIBUTING.md');
  assert.ok(contributing.has('1'), 'CONTRIBUTING.md 的 `## 一、` 应解析为 §1');
  assert.ok(!contributing.has('1.1'), '`### 1. …` 不是 §1.1，不该被解析成二级编号');

  // 围栏里的标题是示例，不算本文件的小节
  const masked = maskFences(['## 一、真标题', '```md', '## 二、示例标题', '```', '## 三、真标题']);
  assert.deepStrictEqual(masked.filter((l) => l.startsWith('##')), [
    '## 一、真标题',
    '## 三、真标题',
  ]);

  // 引用侧：文件名可被反引号包住、可带目录；`§〇` 归一为 `〇`
  const refs = [...'见 `docs/process/DEMAND.md` §〇、`DEMAND.md` §1.1'.matchAll(SECTION_REF_RE)];
  assert.deepStrictEqual(
    refs.map((m) => `${m[1]}|${m[2]}`),
    ['docs/process/DEMAND.md|〇', 'DEMAND.md|1.1'],
  );
  assert.strictEqual(refToKey('〇'), '〇');
  assert.strictEqual(refToKey('二'), '2');
  assert.strictEqual(refToKey('0'), '0');
});

// ── D. 路径引用存在性 ─────────────────────────────────────────

const INLINE_CODE_RE = /`([^`\n]+)`/g;
/** 通配与占位符：`test/*.test.js`、`test/<name>.test.js`、`docs/**` —— 示意写法，不校验 */
const PLACEHOLDER_RE = /[*?<>{}]/;

/**
 * 把反引号里的 token 归一成待校验路径；不像路径就返回 null（保守口径，见文件头）。
 * 归一内容：剥末尾行号 `src/x.js:58`、剥中文标点与括号、取首个空白前的片段。
 */
function backtickToPath(token) {
  const first = token.trim().split(/\s+/)[0];
  if (!first || PLACEHOLDER_RE.test(first)) return null;
  const noLineNo = first.replace(/[:：]\d+(?:\s*[-–]\s*\d+)?$/, '');
  const trimmed = noLineNo.replace(/[^\w./-]+$/g, '');
  if (!PATH_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  return trimmed;
}

test('docs 里反引号标注的路径必须真实存在——防规范把人指向已搬走的文件', () => {
  const hits = [];
  let seen = 0;
  for (const rel of presentDocs()) {
    readLines(rel).forEach((line, i) => {
      for (const m of line.matchAll(INLINE_CODE_RE)) {
        const target = backtickToPath(m[1]);
        if (!target) continue;
        seen += 1;
        if (fs.existsSync(toAbs(target))) continue;
        hits.push(`${rel}:${i + 1}  \`${target}\``);
      }
    });
  }
  assert.ok(seen >= 60, `只扫到 ${seen} 处待校验路径，扫描口径可能写窄了（实测 90+ 处）`);
  assert.deepStrictEqual(
    hits,
    [],
    `这些路径引用不存在（读者按图索骥会扑空）：\n  ${hits.join('\n  ')}`,
  );
});

test('扫描器地基：路径归一不误伤通配与占位符，也不漏掉行号后缀', () => {
  assert.strictEqual(backtickToPath('src/renderer/js/i18n.js:58'), 'src/renderer/js/i18n.js');
  assert.strictEqual(backtickToPath('src/utils/fsAsync.js'), 'src/utils/fsAsync.js');
  assert.strictEqual(backtickToPath('src/renderer/styles/'), 'src/renderer/styles/');
  assert.strictEqual(backtickToPath('docs/RELEASING.md'), 'docs/RELEASING.md');
  // 以下全是示意写法或非路径：一律跳过（漏检可接受，误报不可接受）
  assert.strictEqual(backtickToPath('test/*.test.js'), null);
  assert.strictEqual(backtickToPath('test/<name>.test.js'), null);
  assert.strictEqual(backtickToPath('src/main/**'), null);
  assert.strictEqual(backtickToPath('package.json'), null);
  assert.strictEqual(backtickToPath('DEMAND.md §1.1'), null);
  // 末尾中文标点/括号要剥掉，否则每个引用都会误报
  assert.strictEqual(backtickToPath('src/utils/logger.js）'), 'src/utils/logger.js');
  assert.strictEqual(backtickToPath('docs/process/QA.md，'), 'docs/process/QA.md');
});
