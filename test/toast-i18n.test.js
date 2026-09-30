/**
 * 守护：用户反馈文案必须走词典（英文界面不再整片漏中文）
 *
 * 来龙去脉（实测数据，非推测）：
 *   渲染层此前 **没有任何一处** 直接调用 t('…')（grep 实锤：src/renderer/js/**.js 里
 *   `t('` 命中 0 次）。278 键的 zh/en 词典只被 index.html 的 data-i18n 消费。
 *   于是所有**动态**文案（toast、确认框）都是源码里硬编码的中文字面量；
 *   toast.js:26 虽然过了一道 window.translateMessage，但那个函数是
 *   "拿这句中文去 zh 词典里按 **值** 反查键，再取 en 同名键" —— 词典里根本没有
 *   以中文为 value 的 toast 条目，所以实测 366 处中文 showToast 里 **358 处翻不出英文**。
 *   结果：设置页承诺"可切 English"，而英文界面下几乎每一条操作反馈仍是中文。
 *
 * 三刀（本文件钉住的就是这三刀）：
 *   D1 出口归零：主入口 app.js 与出口本身 toast.js 的反馈文案全部改走
 *      t('toast.*', params) —— 中文文本从源码 **搬进** zh.json（同一事实只许一个家：
 *      源码里留键名，词典里留文案），en.json 给独立译文。共 47 条词条（45 条 app.js
 *      + showDownloadError 拆出的整句 2 条）。app.js 55 处、toast.js 1 处清零。
 *   D2 其余文件本轮不动，但立**按文件计数的欠账台账**（LEDGER）：判据是"反馈函数的
 *      首个实参里，剥掉 t(...) 之后仍含 CJK 字符串字面量"。台账与实际逐字相等 ——
 *      多一处新欠账要改台账，少一处欠账也要改台账，进度与倒退都藏不住。
 *      本轮落地时实跑 43 个文件 / 494 处。
 * D3 词典侧双向对账（974fe2f 的教训：单向子集钉等于没守）：
 *      用到的 toast.* 键必须中英齐备、译文不得照抄中文、{占位符} 两边必须同集合；
 *      反过来词典里的 toast.* 键必须真有人按键读，没读的逐条记进 ORPHANS 台账。
 *   D4 透传文案台账（PASSTHROUGH）：判据⑤那一类"中文不在 toast 调用的实参里、而是别处
 *      return 出来再传进 toast"的文件，本轮按 app.js 里 7 个动态透传点逐个追出处，
 *      追到的三个（queueCopy.js / playError.js / fallbackNotice.js）单独记台账并逐字对账 ——
 *      LEDGER 看不见它们（那里没有反馈调用），不另立一张表就是"台账清零、界面照旧漏中文"。
 *
 * 扫描器口径（与974fe2f 同律）：
 *   ① 先 stripComments —— 说明文字里举例提到 showToast('中文') 不算欠账（否则自己的
 *      注释会把自己打红，本文件头部就是一例）；
 *   ② 只有**字符串字面量**里的 CJK 算硬编码，`showToast(t('toast.x'))`、
 *      `showToast(errBrief(e))` 都不算；
 *   ③ 判据要能抓住"改用反引号 / 改抽成变量再拼"这类绕法：反引号算字面量，
 *      而 `+ '中文'` 拼出来的那一半仍是字面量 ⇒ 仍被抓。
 *   ④ 扫描器必须自带自测（见下方 5 枚自测），没有自测的巡扫等于运气。
 *   ⑤ 已知盲区（如实记账，不假装判据全能）：**先在变量里攒好中文、再把变量传进出线**
 *      （`const prefix = '下载失败'; showToast(\`${prefix}：…\`)`）首实参判据抓不到 ——
 *      toast.js:48 就是这一枚，本轮已修。语言上无法用"看实参"抓全数据流，所以出口文件
 *      另加一枚整文件零中文字面量的加严钉（见 D1 下方），其余文件仍按 LEDGER 收编时逐个套；
 *      本轮从 app.js 的动态透传点反查出处，追到的 3 个文件已由 D4 单独立账（不是"抓不全了"，
 *      是把已知的那一段从"看不见"挪进"看得见"）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const zh = JSON.parse(fs.readFileSync(path.join(REPO, 'src/renderer/js/lang/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(REPO, 'src/renderer/js/lang/en.json'), 'utf8'));

/**
 * 用户反馈出口：文案进这里就必须能被翻译，否则英文界面漏中文。
 * 三个都算：showToast（含 btnLabel 的 actionToast 同族）、askConfirm、showActionToast。
 * 首实参是"被展示的那一段"（actionToast 传的是 { text, btnLabel } 对象，整段都在展示）。
 */
const FEEDBACK_FNS = ['showToast', 'askConfirm', 'showActionToast'];

function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * 从 openIdx（左括号下标）起，取该调用的**首个顶层实参**源码片段。
 * 尊重字符串/模板字面量与嵌套括号；找不到时返回 null。
 */
function firstArg(code, openIdx) {
  let depth = 0;
  const start = openIdx + 1;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(code, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return code.slice(start, i);
      depth--;
      continue;
    }
    if (c === ',' && depth === 0) return code.slice(start, i);
  }
  return null;
}

/** 跳过一个以 quote 开头的字面量，返回结束引号的下标 */
function skipString(code, qIdx) {
  const quote = code[qIdx];
  for (let i = qIdx + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') { i++; continue; }
    if (quote === '`' && c === '$' && code[i + 1] === '{') {
      i = skipBraces(code, i + 1);
      continue;
    }
    if (c === quote) return i;
  }
  return code.length - 1;
}

/** 跳过 ${...} 这类花括号块（含内部字符串） */
function skipBraces(code, braceIdx) {
  let depth = 0;
  for (let i = braceIdx; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(code, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return code.length - 1;
}

const CJK = /[㐀-鿿぀-ヿ가-힯]/;

/** 剥掉所有 t('…') / t('…', {...}) 调用后，片段里还剩哪些含 CJK 的字符串字面量 */
function hardcodedLiterals(argSrc) {
  const withoutT = argSrc.replace(/\bt\(\s*(['"])[^'"]+\1\s*(,\s*\{[\s\S]*?\}\s*)?\)/g, '""');
  const hits = [];
  for (let i = 0; i < withoutT.length; i++) {
    const c = withoutT[i];
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const end = skipString(withoutT, i);
    const body = withoutT.slice(i + 1, end);
    if (CJK.test(body)) hits.push(body);
    i = end;
  }
  return hits;
}

/** 一段源码里所有"硬编码中文反馈文案"的位置 */
function feedbackSites(code) {
  const out = [];
  for (const fn of FEEDBACK_FNS) {
    const re = new RegExp('(^|[^A-Za-z0-9_$.])' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(code))) {
      const openIdx = m.index + m[0].length - 1;
      const arg = firstArg(code, openIdx);
      if (arg === null) continue;
      const lits = hardcodedLiterals(arg);
      if (!lits.length) continue;
      out.push({ line: code.slice(0, m.index).split('\n').length, text: lits[0] });
    }
  }
  return out.concat(accumulatorSites(code));
}

/** 反馈调用的首实参源码片段（判据⑥要靠它判断"这个数组攒的文案真的被展示了吗"） */
function feedbackFirstArgs(code) {
  const out = [];
  for (const fn of FEEDBACK_FNS) {
    const re = new RegExp('(^|[^A-Za-z0-9_$.])' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(code))) {
      const arg = firstArg(code, m.index + m[0].length - 1);
      if (arg !== null) out.push(arg);
    }
  }
  return out;
}

/**
 * 判据⑥（2026-09-28 新增）：**先 push 攒进数组、再 join 进出线**也算欠账。
 *
 * 来龙去脉（实测，不是推测）：views/playlist.js 的批量加歌汇总原先写作
 *
 *     parts.push(`已加入 ${added} 首`); …
 *     showToast(parts.join(t('toast.listSeparator')) : …)
 *
 * 首实参是 `parts.join(…)` 表达式，里面**一个字面量都没有** ⇒ 判据只扫首实参时
 * 整段失明。于是那次改动只把**分隔符**接进词典、三个分句留着硬编码中文，
 * 而 LEDGER 里 views/playlist.js 的计数被从 98 改成"删项（归零）"——
 * 台账宣告"该文件没有硬编码中文反馈"，英文界面上那一句照旧整句中文。
 * 这正是 D4 段落里点名的"LEDGER 清零、界面照旧漏中文"的假进度。
 *
 * 为什么按 `.push(` 收口而不是把"函数体内任意字面量"都算进来：数组累加器是这类
 * 失明唯一可静态识别、且误报率低的形状。要求数组**确实出现在某个反馈调用的首实参里**
 * 才计数 —— 于是 `rows.push(html)` 这类"攒的是 DOM 片段、从不进 toast"的写法不受影响。
 */
function accumulatorSites(code) {
  const shown = feedbackFirstArgs(code).join('\n');
  const out = [];
  const re = /(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*push\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const ident = m[1];
    // 只认"这个数组的名字真的出现在反馈调用的首实参里"的累加器
    if (!new RegExp('(^|[^A-Za-z0-9_$])' + ident + '(?![A-Za-z0-9_$])').test(shown)) continue;
    const arg = firstArg(code, m.index + m[0].length - 1);
    if (arg === null) continue;
    const lits = hardcodedLiterals(arg);
    if (!lits.length) continue;
    out.push({ line: code.slice(0, m.index).split('\n').length, text: lits[0] });
  }
  return out;
}

/** 被纳管的面：渲染层 JS + 主窗口 HTML 里的内联脚本 */
function managedFiles() {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = dir + '/' + f.name;
      if (f.isDirectory()) { walk(rel); continue; }
      if (/\.(js|html)$/.test(f.name) && !/\/lang\//.test(rel)) out.push(rel);
    }
  })('src/renderer');
  return out.sort();
}

/** 全量扫描：rel → 欠账条数（只登记非零项，app.js 归零后不该出现在结果里） */
function scanLedger() {
  const map = {};
  for (const rel of managedFiles()) {
    const n = feedbackSites(stripComments(read(rel))).length;
    if (n) map[rel] = n;
  }
  return map;
}

// ── 扫描器自测（反向钉的第一道：先证明钉子本身不假绿、也不误伤）──

/**
 * 扫描器地基守卫（2026-09 审计发现）。
 *
 * stripComments 用的是非贪婪块注释正则 —— 它认不出「注释文字里的块注释起始符」。
 * 于是一行说明文字里写了带斜杠星号的路径或 MIME 通配时，那个起始符会和
 * **后面某个块注释结束符**（往往是几百行外新增的 JSDoc 结尾）配成一对，
 * 中间整段代码被当注释删掉：台账计数静默变小、孤儿表凭空变长，
 * 而报错信息只指向"某词条没人用"，根因在几千字符之外。
 *
 * 实测：settings.js 的一行路径说明就是这样把 14 个词条判成孤儿
 * （新增一个 JSDoc 才引爆）。判据取"行注释里不许出现块注释标记"——
 * 整行是注释时，该标记只可能是装饰文字，不可能有代码语义，误报率为 0。
 */
function lineCommentBlockMarkers(rel) {
  const hits = [];
  read(rel).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') && /\/\*|\*\//.test(t)) hits.push(`${rel}:${i + 1}`);
  });
  return hits;
}

test('扫描器地基：任何 .js 的行注释里不得出现块注释标记（会把后面整段代码吞成注释）', () => {
  const offenders = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = dir + '/' + f.name;
      if (f.isDirectory()) { walk(rel); continue; }
      if (f.name.endsWith('.js')) offenders.push(...lineCommentBlockMarkers(rel));
    }
  })('src');
  assert.deepStrictEqual(offenders, [],
    '这些行注释里带了块注释标记，会让 stripComments 从该行起吞掉后续代码：\n' + offenders.join('\n'));
});

test('扫描器地基自测：判据真能抓到，且不误伤块注释与字符串里的标记', () => {
  // 用合成文本直接验判据（不落盘）
  const synthetic = [
    '// 说明文字里写了 src/utils/* 这种路径',
    'const a = 1;',
  ].join('\n');
  const hits = [];
  synthetic.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') && /\/\*|\*\//.test(t)) hits.push(i + 1);
  });
  assert.deepStrictEqual(hits, [1], '行注释里的 /* 必须被逮住');
  const fine = ['/* 正常块注释 */', "const p = 'src/**/*.js';", '// 普通说明'].join('\n');
  const hits2 = [];
  fine.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') && /\/\*|\*\//.test(t)) hits2.push(i + 1);
  });
  assert.deepStrictEqual(hits2, [], '块注释与字符串里的标记不该被误判');
});

test('自检：硬编码中文反馈能被抓住（含反引号与拼接两种写法）', () => {
  assert.strictEqual(feedbackSites(`showToast('已加入队列', 'info')`).length, 1);
  assert.strictEqual(feedbackSites('askConfirm(`确认删除 ${n} 项？`)').length, 1);
  assert.strictEqual(feedbackSites(`showToast('前缀：' + errBrief(e))`).length, 1);
});

test('自检：走词典的写法与纯动态文案不算欠账', () => {
  assert.strictEqual(feedbackSites(`showToast(t('toast.added'), 'info')`).length, 0);
  assert.strictEqual(feedbackSites(`showToast(t('toast.playing', { title }), 'success')`).length, 0);
  assert.strictEqual(feedbackSites(`showToast(errBrief(e), 'error')`).length, 0);
  assert.strictEqual(feedbackSites(`showToast(msg, 'info')`).length, 0);
});

test('自检：注释与函数名同形词不算欠账（stripComments 后扫）', () => {
  const src = [
    "// 这里以前写 showToast('已清空')，现在走词典",
    '/* askConfirm("确认退出？") 只是历史说明 */',
    'window.__showToastHelper = () => {};',
    "const x = notShowToast('仍然中文');",
  ].join('\n');
  assert.strictEqual(feedbackSites(stripComments(src)).length, 0,
    '注释里的示例与被前缀污染的函数名都不该算欠账');
});

test('自检：非首实参里的中文不算欠账（判据只看被展示的那一段）', () => {
  assert.strictEqual(feedbackSites(`showToast(t('toast.k'), '提示')`).length, 0);
});

test('自检：判据⑥「先 push 攒进数组、再 join 进出线」抓得到（playlist.js 那枚假进度的原型）', () => {
  const src = [
    'const parts = [];',
    "if (added) parts.push(`已加入 ${added} 首`);",
    "showToast(parts.join(t('toast.listSeparator')));",
  ].join('\n');
  const hits = feedbackSites(src);
  assert.strictEqual(hits.length, 1, '攒进数组的中文分句必须被抓住：' + JSON.stringify(hits));
  assert.match(hits[0].text, /已加入/);
  // 反向钉：这段攒的是 DOM 片段、从不进 toast ⇒ 不许被算成欠账（否则本判据会变成噪声源）
  const domOnly = [
    'const rows = [];',
    "rows.push(`<div class=\"song-row\">${esc(song.title)}</div>`);",
    "list.innerHTML = rows.join('');",
  ].join('\n');
  assert.strictEqual(feedbackSites(domOnly).length, 0, '不进反馈调用的数组不该算欠账');
  // 走词典的分句也不该被算成欠账（同 app.js:1057 的正确写法）
  const wired = [
    'const parts = [];',
    "if (added) parts.push(t('toast.batchQueued', { count: added, extra: '' }));",
    "showToast(parts.join(t('toast.listSeparator')));",
  ].join('\n');
  assert.strictEqual(feedbackSites(wired).length, 0, '接了词典的汇总串不算欠账');
});

test('自检：actionToast 的对象实参里 btnLabel 也算欠账（它照样印在界面上）', () => {
  assert.strictEqual(
    feedbackSites(`showActionToast({ text: t('toast.k'), btnLabel: '⬇ 重新下载', ttl: 9000 })`).length, 1);
  assert.strictEqual(
    feedbackSites(`showActionToast({ text: t('toast.k'), btnLabel: t('toast.redl'), ttl: 9000 })`).length, 0);
});

test('扫描器覆盖面：被纳管的文件确实在渲染层', () => {
  const files = managedFiles();
  assert.ok(files.includes('src/renderer/js/app.js'), 'app.js 必须在扫描面内');
  assert.ok(files.includes('src/renderer/js/toast.js'), 'toast.js 必须在扫描面内');
  assert.ok(!files.some((f) => /\/lang\//.test(f)), '语言包本身不该被当消费方扫描');
  assert.ok(files.length > 30, '扫描面异常缩小：' + files.length);
});

// ── D1：已收编的文件必须归零 ──

/**
 * 本轮把文案搬进词典的文件。toast.js 必须一起收编：它是所有下载失败文案的
 * 出口（`🔒 无法下载：${title}` 就写在那儿），漏了它等于给全应用最响的那条
 * 错误提示留着中文。
 */
const CONQUERED = [
  'src/renderer/js/app.js',
  'src/renderer/js/toast.js',
  // 按 LEDGER 收编的第一个文件（43 处 → 0，同时接上 17 条早就为它写好的词条）
  'src/renderer/js/views/settings.js',
  // 按 LEDGER 收编的第二个视图文件（30 处 → 0）：一次还完整文件，不留半截
  'src/renderer/js/views/download.js',
  // 按 LEDGER 收编的第三个视图文件（38 处 → 0）
  'src/renderer/js/views/ai-music.js',
  // 按 LEDGER 收编的第四个视图文件（22 处 → 0）
  'src/renderer/js/views/subscriptions.js',
];

test('已收编文件的用户反馈文案零硬编码（本轮兑现的那一面）', () => {
  const bad = [];
  for (const rel of CONQUERED) {
    for (const s of feedbackSites(stripComments(read(rel)))) {
      bad.push(`${rel} L${s.line} 「${s.text}」`);
    }
  }
  assert.deepStrictEqual(bad, [], '仍有硬编码中文反馈文案：\n  ' + bad.join('\n  '));
});

/**
 * toast.js 的加严钉：它是出口本身，判据要严于"首实参"。
 *
 * 为什么首实参判据在这里不够：`const prefix = '下载失败'; showToast(\`${prefix}：${t}\`)`
 * 把中文藏在变量里，实参扫过去一片干净（本轮就抓到 toast.js:48 这一枚真伤）。
 * 出口文件只有 60 行、除注释外不该有一个中文字符 —— 直接按文件钉，
 * 比继续给扫描器补"数据流追踪"划算得多（同一事实只许一个家：判据越简单越不会误伤）。
 */
test('toast.js 整文件零中文字面量（出口文件按最严口径，注释除外）', () => {
  const code = stripComments(read('src/renderer/js/toast.js'));
  const hits = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const end = skipString(code, i);
    const body = code.slice(i + 1, end);
    if (CJK.test(body)) hits.push(body);
    i = end;
  }
  assert.deepStrictEqual(hits, [], 'toast.js 里仍有中文字面量（文案的家是语言包）：' + JSON.stringify(hits));
});

// ── D1b：收编进来的文件必须真的接上取词（D1 只保证"没有中文"，不保证"有英文"）──

/**
 * 「把中文删掉换成 t('键')」这一步，源码侧有两个失败模式是 D1 的零中文钉抓不到的：
 *   ① 忘了 import，改成读 window.t 或就地攒一个小词典 —— 浏览器里可能照样跑，node 侧与词典侧全瞎；
 *   ② 文件里另有一个叫 t 的局部变量把取词函数遮蔽掉。settings.js 收编前实测就有三处
 *      （`const t = theme || 'default'`、两处 `_dlTemplates.find(t => t.id === ...)`），
 *      遮蔽后的 `t('toast.x')` 是"函数不是函数"的运行时异常，而不是编译错误。
 * settings.js 与 app.js 的差别决定了它必须单独钉一枚：app.js 是入口（自己就是词典的家），
 * settings.js 是视图，它只能用 i18n.js 那一家。
 */
const T_SHADOW_PATTERNS = [
  [/\b(?:const|let|var)\s+t\s*[=:,;]/g, '局部变量 t'],
  [/\bfunction\s+t\s*\(/g, '名为 t 的函数'],
  [/\bt\s*=>/g, '箭头函数形参 t'],
  [/[(,]\s*t\s*(?:,[^)]*)?\)\s*=>/g, '箭头函数形参 t'],
  [/catch\s*\(\s*t\s*\)/g, 'catch 形参 t'],
];

/**
 * 收编过的视图文件（都在 views/ 下，`'../i18n.js'` 相对路径同形）。ed2fad6 起把上面那枚
 * settings.js 专用钉改成按表循环：同一判据不许为第二个文件抄一份（192 口径，一条规则一个门禁），
 * 否则收编到第五个文件时就有五条会各自腐烂的近似测。
 */
const CONQUERED_VIEWS = [
  'src/renderer/js/views/settings.js',
  'src/renderer/js/views/download.js',
  'src/renderer/js/views/ai-music.js',
  'src/renderer/js/views/subscriptions.js',
];

test('已收编视图文件的取词走 i18n.js 的 t，且文件内没有名为 t 的局部遮蔽', () => {
  for (const rel of CONQUERED_VIEWS) {
    const src = read(rel);
    const code = stripComments(src);
    assert.match(src, /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\.\/i18n\.js'/,
      `${rel} 应静态 import { t } from '../i18n.js'（视图层不许自己攒词典）`);
    assert.ok(!/window\.t\s*\(/.test(code),       `${rel} 不许留 window.t 的旁路（同一事实两个家）`);
    const shadows = [];
    for (const [re, what] of T_SHADOW_PATTERNS) {
      let m;
      while ((m = re.exec(code))) shadows.push(`${what} @ ${code.slice(m.index, m.index + 40)}`);
    }
    assert.deepStrictEqual(shadows, [], `${rel} 这些局部 t 会遮蔽取词函数（改名，别改 t 的调用）：\n  ` + shadows.join('\n  '));
  }
});

/**
 * 新增/改写的词条逐字对账。
 *
 * 为什么还要这一枚：D1 + 孤儿台账只证明"源码里没有中文、词典里有人按键读"，
 * 它们**不知道** t('toast.probeFailed') 取出来的到底是不是那句"探测失败"。
 * 收编时键名和值是我在同一轮里写的，接错线（把「删除失败」挂到 saveFailed 键上）
 * 会一路绿灯到用户屏幕上。所以把这批值的原文抄下来当锚 —— 值一动就得在对账测里红一次。
 * （全局增量号 194：并发线已把 193 用在引导层键盘契约上，见 git log be3ec33。）
 */
const WIRING_194 = {
  'toast.probeUnsupported': '当前版本不支持探测',
  'toast.probeDone': '探测完成：{ok}/{total} 个源可用',
  'toast.probeFailed': '探测失败：{msg}',
  'toast.cookieMissing': '请先在输入框中填入 Cookie',
  'toast.cookieSaved': 'Cookie 已保存',
  'toast.cookieCleared': 'Cookie 已清除',
  'toast.clearFailed': '清除失败：{msg}',
  // 「保存失败：{msg}」的家早就在词典里立着了（app.js 两处消费）—— 收编时复用，不再造一个同义键
  'toast.saveFailedDetail': '保存失败: {msg}',
  'toast.deleteFailedMsg': '删除失败：{msg}',
  'toast.noLoginNeeded': '{platform} 免登录，不需要 Cookie',
  'toast.loginOpening': '正在打开 {name} 登录窗口…',
  'toast.loginSuccess': '✅ {name} 登录成功！Cookie 已自动保存',
  'toast.loginCanceled': '已取消登录',
  'toast.loginFailed': '登录失败：{msg}',
  'toast.unknownError': '未知错误',
  'toast.qualityFollowReset': '已恢复为全部跟随默认音质',
  'toast.sourceSwitchReset': '已恢复为全部平台可参与换源',
  'toast.templateSwitched': '已切换到：{name}',
  'toast.templateDefaultName': '默认路径',
  'toast.templateNameRequired': '名称和路径不能为空',
  'toast.templateUpdated': '✅ 模板已更新',
  'toast.templateCreated': '✅ 模板已创建',
  'toast.templateDeleted': '✅ 模板已删除',
  'toast.templateConfirmDelete': '确认删除该路径模板？',
  'toast.cacheCleared': '✅ 播放缓存已清理',
  'toast.cacheClearFailed': '清理缓存失败：{msg}',
  'toast.settingsReset': '✅ 设置已恢复默认值',
  'toast.settingsResetFailed': '恢复失败：{msg}',
  'toast.resetConfirm': '确认恢复所有设置为默认值？\n\n会一并复原：下载/播放/外观全部设置\n（含音量、倍速、淡入淡出、队列完成后动作、均衡器曲线与 EQ 开关）\n\n此操作不会删除：\n• 已下载的音乐文件\n• 平台登录 Cookie\n• 搜索历史',
  'toast.exportSuccess': '✅ 数据已导出到 {path}',
  'toast.exportFailed': '导出失败：{msg}',
  'toast.importFailed': '导入失败：{msg}',
  'toast.webdavInsecure': '⚠️ WebDAV 地址为明文 http 且非本机，密码可能被窃听，建议改用 https',
  'toast.webdavSaved': 'WebDAV 配置已保存',
  'toast.webdavSyncing': '正在与 WebDAV 同步…',
  'toast.webdavSyncDone': '同步完成：歌单 {playlists} / 模板 {templates} / 历史 {history}（歌单页重新打开即为最新）',
  'toast.webdavSyncFailed': '同步失败：{msg}',
  'toast.mcpFailed': 'MCP 操作失败：{msg}',
  'toast.mcpTokenRotated': '令牌已重置，旧令牌立即失效，请在 Agent 配置中更新',
  'toast.importConfirm': '导入将覆盖现有数据（歌单、设置等），是否继续？',
  'toast.importSuccess': '✅ 导入成功',
};

/**
 * （download.js 收编）的接线对账，家法同 WIRING_194：值抄在这里当锚，
 * 键值配错（把「移动失败」挂到 dlMoveBlocked 上）会在这一枚红，而不是红到用户屏幕上。
 * 表里既有新建的 toast.dl*，也有**复用**的三条老词条 —— 复用同样需要钉：
 * 那三条的值是不是这句中文，只有抄下来才知道接没接错线。
 */
const WIRING_203 = {
  'toast.dlBatchRetried': '重试完成：{count} 项已重新加入队列',
  'toast.dlBatchRemoved': '已删除 {count} 项',
  'toast.dlGroupOn': '🧩 已按来源平台分组',
  'toast.dlGroupOff': '已恢复平铺显示',
  'toast.dlOnlyPlatform': '👁 只显示 {platform} 的任务',
  'toast.dlOnlyOff': '已取消单平台过滤',
  'toast.dlRetryQueued': '已加入重试队列',
  'toast.dlRetryFailed': '重试失败：{msg}',
  'toast.dlNoFailed': '没有失败的任务',
  'toast.dlRetryingAll': '正在重试 {count} 个失败任务 ({summary})...',
  'toast.dlRetried': '已重试 {count} 项',
  'toast.dlRetriedSkipped': '已重试 {count} 项，跳过 {skipped} 项（需登录/VIP）',
  'toast.dlAllNeedManual': '所有失败任务均需手动处理（VIP/登录限制）',
  'toast.dlMoveBlocked': '无法移动该任务',
  'toast.dlMoveFailed': '移动失败：{msg}',
  'toast.dlPauseToggleFailed': '切换失败：{msg}',
  'toast.dlPaused': '⏸ 已暂停下载（在途任务继续完成）',
  'toast.dlResumed': '▶ 已继续下载',
  'toast.dlClearedFinished': '已清空 {count} 个已完成任务',
  'toast.dlClearFailed': '清空失败：{msg}',
  'toast.dlConfirmClearAll': '确认清空所有下载任务？正在进行的下载也会被取消。',
  'toast.dlClearedAll': '已清空 {count} 个任务',
  'toast.dlNoSaveDir': '尚未设置保存目录',
  'toast.dlNoFilePath': '未找到文件路径',
  'toast.dlNoTasks': '当前没有下载任务',
  'toast.dlNoCompleted': '没有已完成的歌曲可导出',
  'toast.dlExported': '✅ 已导出 {count} 首歌曲',
  // 复用：词典里早就立着的三家，download.js 这次是第二个消费方（168「同一事实只许一个家」）
  'toast.deleteFailedMsg': '删除失败：{msg}',
  'toast.playFailed': '⚠️ 播放失败：{msg}',
  'toast.exportFailed': '导出失败：{msg}',
  'toast.unknownError': '未知错误',
};

/**
 * （subscriptions.js 收编）的接线对账，家法同 WIRING_194 / 203。
 *
 * 复用一栏这次格外长（7 条），因为订阅页的"入队结果"本来就是全应用同一件事：
 * 「已加入 N 首 + 跳过段」的家在 app.js（批量入队出口），逐首入队的家在
 * toast.queueAdded / queueDup / addFailed。订阅页原本是各写一份中文的第三个消费方，
 * 收编后它改成读那三家 —— 于是句子形状向多数对齐（见下面三条注），而不是再立同义键。
 */
const WIRING_217 = {
  'toast.subAlready': '已订阅过了',
  'toast.subDone': '已订阅: {name}',
  'toast.subFailed': '订阅失败',
  'toast.subFailedDetail': '订阅失败: {msg}',
  'toast.unsubscribed': '已退订',
  'toast.unsubscribeFailed': '退订失败',
  'toast.autoDownloadOn': '已开启自动下载：新歌将直接排入下载队列',
  'toast.subCheckFound': '检查完成，发现 {count} 首新歌',
  'toast.subCheckNone': '检查完成，暂无新歌',
  'toast.subCheckFailed': '检查失败: {msg}',
  'toast.subSongGone': '该歌曲已不在新歌列表，请刷新后重试',
  'toast.enqueueFailed': '加入下载队列失败',
  'toast.enqueueFailedDetail': '加入下载队列失败: {msg}',
  'toast.playlistMissing': '歌单信息缺失',
  'toast.subPlaylistAlready': '已订阅该歌单',
  'toast.singerMissing': '歌手信息缺失',
  'toast.subSingerAlready': '已订阅该歌手',
  // 复用：入队结果那三家（app.js 早已按键读，订阅页是第二个/第三个消费方）
  'toast.batchQueued': '已加入 {count} 首{extra}',
  'toast.skippedDownloaded': '跳过 {count} 首已下载过',
  'toast.batchAddFailed': '批量加入失败: {msg}',
  'toast.queueAdded': '「{title}」已加入下载队列',
  'toast.queueDup': '「{title}」已在下载队列中',
  'toast.addFailed': '加入失败: {msg}',
};

/**
 * 句子形状向多数对齐的那三条，逐条留字（改了用户看得见的标点/字，必须在钉上说话）：
 *   ① 跳过段原先是「，跳过 N 首已下载」，词典里那句是「跳过 {count} 首已下载过」，
 *      间隔号「 · 」是 app.js:1056 起全应用汇总串的既有分隔约定（语言中立，全角逗号不是）；
 *   ② 逐首入队的本地预检原先是「已在队列中」，服务端回执那句是「已在下载队列中」——
 *      同一件事的两句近义，收成一家；
 *   ③ 批量加入失败那句与 toast.batchAddFailed 逐字相等，本来就该按键读。
 */
test(' 订阅页不再自造入队结果的第二套说法', () => {
  const code = stripComments(read('src/renderer/js/views/subscriptions.js'));
  const gone = [
    ['已在队列中', '逐首入队预检应读 toast.queueDup（②）'],
    ['，跳过 ', '跳过段应读 toast.skippedDownloaded（①）'],
    ['批量加入失败: ', '批量失败应读 toast.batchAddFailed（③）'],
  ];
  const bad = gone.filter(([s]) => code.includes(s)).map(([, why]) => why);
  assert.deepStrictEqual(bad, [], '订阅页里还留着自造的句子：\n  ' + bad.join('\n  '));
});

/**
 * 对账表自身的完整性：表必须**恰好**覆盖订阅页读到的那些键。
 *
 * 为什么单独钉这一枚：WIRING_194 / 203 只保证"表里那几条的值没写错"，
 * 不保证"文件里每条句子都在表里"—— 收编时漏抄一行，那一行就没有锚，
 * 接错线照样一路绿灯（实测：把 'toast.enqueueFailed' 从表里删掉，前面所有钉都还绿）。
 * 反向也钉：表里留着文件已经不读的键，说明表和代码脱钩了。
 */
test('88d387e 的对账表与订阅页读到的键恰好一一对应（漏钉＝那条句子没锚，多钉＝表已脱钩）', () => {
  const used = keysUsedIn('src/renderer/js/views/subscriptions.js').sort();
  assert.deepStrictEqual(used, Object.keys(WIRING_217).sort(),
    '订阅页按键读的句子与 WIRING_217 不等。实读=' + JSON.stringify(used));
});

/**
 * （批量加歌汇总三段）的接线对账，家法同 WIRING_194 / 203 / 217：值抄在这里当锚。
 *
 * 为什么不并进 WIRING_194 那张表、也不直接并进 CONQUERED：views/playlist.js 只是
 * **局部**收编（只收了这一处汇总串的三段），整个文件还剩 47 处 CJK 字面量（见 PASSTHROUGH）。
 * 把它塞进 CONQUERED 会让"已收编 = 全文件零中文"那枚钉立刻变红；不钉它的话，
 * 键值配错（把「失败 N 首」挂到 plBatchSkipped 上）一路绿灯到用户屏幕上。
 *
 * 三条里的第一条是**复用**不是新建：toast.batchQueued 的家在 app.js 的批量入队出口
 * （已记过这个复用），歌单页是第二个消费方 —— 同一事实只许一个家。
 */
const WIRING_220 = {
  'toast.batchQueued': '已加入 {count} 首{extra}',
  'toast.plBatchSkipped': '跳过已在歌单 {count} 首',
  'toast.plBatchAddFailed': '失败 {count} 首',
  'toast.plNothingAdded': '没有歌曲被加入',
  // 分隔符不是句子（en 值就是 ", "），但它是这次收编的一半：首版只接了它，
  // 三个分句留着硬编码中文 ⇒ 英文界面上是"纯中文句子 + 英文逗号"，也钉住。
  'toast.listSeparator': '，',
};

for (const [table, name] of [[WIRING_194, '194'], [WIRING_203, '203'], [WIRING_217, '217'], [WIRING_220, '220']]) {
  test(`增量${name} 接线的词条值逐字对账（键与值的配对不许只靠写代码那一次的手感）`, () => {
    const bad = [];
    for (const k of Object.keys(table)) {
      if (!(k in zh)) { bad.push(`${k}: zh 缺键`); continue; }
      if (zh[k] !== table[k]) bad.push(`${k}: zh="${zh[k]}" 应为="${table[k]}"`);
    }
    assert.deepStrictEqual(bad, [], '这些词条的值与源码里搬出来的那句不符：\n  ' + bad.join('\n  '));
  });

  test(`增量${name} 的词条两边都带齐占位符（少一个 {x} 就是把变量名印给用户）`, () => {
    const bad = [];
    for (const k of Object.keys(table)) {
      if (typeof zh[k] !== 'string') { bad.push(`${k}: zh 缺键`); continue; }
      if (typeof en[k] !== 'string') { bad.push(`${k}: en 缺键`); continue; }
      const a = placeholdersOf(zh[k]).join(',');
      const b = placeholdersOf(en[k]).join(',');
      if (a !== b) bad.push(`${k}: zh[${a}] vs en[${b}]`);
    }
    assert.deepStrictEqual(bad, [], '中英占位符集合不等：\n  ' + bad.join('\n  '));
  });
}

/**
 * 191 的家法在词典侧的哨兵：值必须是**整句**。
 * `'保存失败: ' + err` 搬进词典时若写成 `"toast.saveFailed": "保存失败: "`（值以冒号收尾），
 * 接线处就只剩两种可能 —— 要么源码里仍然拼中文冒号（D1 会红，算抓得到），
 * 要么拼一个英文冒号进中文界面（哪枚钉都不红，用户看得见）。所以直接在形状侧堵死半句话。
 */
test('toast.* 词条不许是半句话（值不得以冒号收尾 —— 拼接的那一段必须进 {占位符}）', () => {
  const bad = [];
  for (const k of Object.keys(zh)) {
    if (!k.startsWith('toast.')) continue;
    for (const side of ['zh', 'en']) {
      if (/[:：]\s*$/.test(String(side === 'zh' ? zh[k] : en[k]))) bad.push(`${k}(${side})`);
    }
  }
  assert.deepStrictEqual(bad, [], '这些值以冒号收尾，等于把拼接留在了源码里：\n  ' + bad.join('\n  '));
});

// ── D2：欠账台账逐字相等（只许被显式改动，不许悄悄长大）──

/**
 * 欠账台账：rel → 硬编码中文反馈条数。判据与实跑逐字相等（见下方对账测）。
 * 只许两种改法：还掉一处就把数字改小（归零就删项），新写一处硬编码就得把它改大 ——
 * 但改大的那一枪会同时红在 reviewer 面前，这就是棘轮。
 * app.js 不在表里：它是本轮归零的那一面（见上方 D1 钉）。
 *
 * ⚠️ 2026-09-28 判据加严（不是代码倒退，别照着"变多"去改源码）：新增判据⑥
 *    「先 push 攒进数组、再 join 进出线」（见 accumulatorSites）。加严的结果是
 *    **四个文件的计数同时上调**，而其中只有 views/playlist.js 是本轮真去改的那个：
 *      scheduledDownload.js 2→4、views/batchImport.js 2→6、views/nameBatch.js 5→8
 *    三处都是同一形状的存量失明（它们早就在攒中文字面量，只是判据看不见），
 *    本轮不碰它们的代码，只让台账说实话。views/playlist.js 靠判据⑥ + 把三个分句
 *    接进词典，它自己的计数落回 0 —— 但那**不代表该文件没有中文了**：它还剩
 *    整文件字面量（弹窗按钮、剪贴板报告…），已由下面的 PASSTHROUGH 单独立账。
 *
 * 落地本轮时的规模（43 个文件 / 494 处，本轮前的 app.js 一个文件就占 55 处）：
 * 大头在 views/playlist.js(98)、local.js(48)、search.js(40)、settings.js(43)、
 * ai-music.js(38)、download.js(30) —— 按"一个文件一次收编"的节奏还，
 * 每次收编顺带把该文件的词条接上（ORPHANS 同步变小）。
 */
const LEDGER = {
  'src/renderer/index.html': 2,
  'src/renderer/js/abClip.js': 4,
  'src/renderer/js/abLoop.js': 2,
  'src/renderer/js/afterQueueDone.js': 3,
  'src/renderer/js/artistGroups.js': 6,
  'src/renderer/js/autoCoverOnDone.js': 1,
  'src/renderer/js/autoLyricOnDone.js': 1,
  'src/renderer/js/commandPalette.js': 2,
  'src/renderer/js/converter-core.js': 8,
  'src/renderer/js/diagnose.js': 4,
  'src/renderer/js/dismissed.js': 3,
  'src/renderer/js/favorites.js': 2,
  'src/renderer/js/folderGroups.js': 6,
  'src/renderer/js/historyTrend.js': 2,
  'src/renderer/js/lyricEditor.js': 4,
  'src/renderer/js/lyricNudge.js': 3,
  'src/renderer/js/m3uToPlaylist.js': 6,
  'src/renderer/js/playRetry.js': 6,
  'src/renderer/js/player.js': 10,
  'src/renderer/js/player/fade.js': 2,
  'src/renderer/js/player/lyrics.js': 2,
  'src/renderer/js/player/stats.js': 3,
  'src/renderer/js/scheduledDownload.js': 4,
  'src/renderer/js/sleepTimer.js': 7,
  'src/renderer/js/songGroups.js': 1,
  'src/renderer/js/songMenu.js': 3,
  'src/renderer/js/views/batchImport.js': 6,
  'src/renderer/js/views/clipboard.js': 1,
  'src/renderer/js/views/converter.js': 10,
  'src/renderer/js/views/dragdrop.js': 10,
  'src/renderer/js/views/history.js': 24,
  'src/renderer/js/views/home.js': 15,
  'src/renderer/js/views/local-stats.js': 11,
  // 46 → 40：ID3 编辑弹窗整块抽到 js/localEditModal.js（阶段4），editor 里的
  // 6 处硬编码中文（保存/失败/批量提示等）随之搬走，本文件只减不增。
  'src/renderer/js/views/local.js': 40,
  'src/renderer/js/views/nameBatch.js': 8,
  'src/renderer/js/views/search.js': 36,
};

test('欠账台账与实际逐字相等（新增欠账要改表，还清欠账也要改表）', () => {
  const actual = scanLedger();
  assert.deepStrictEqual(actual, LEDGER,
    '台账与实际不符。实跑=' + JSON.stringify(actual)
    + '\n变多是倒退（必须改回代码），变少是进步（必须把数字钉小或删项）。');
});

// ── D4：透传文案台账（中文在别处拼好，再当变量传进 toast） ──

/** 已剥注释的源码里，所有含 CJK 的字符串字面量（模板串算字面量，反引号里的 ${} 一并算） */
function cjkLiterals(code) {
  const hits = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const end = skipString(code, i);
    const body = code.slice(i + 1, end);
    if (CJK.test(body)) hits.push(body);
    i = end;
  }
  return hits;
}

/**
 * 透传/旁路文案台账：LEDGER 看不见的那些中文字面量，按**整文件**计（去注释后）。
 *
 * 两种成员，失效方式不同但结局一样 —— 都是"台账清零、界面照旧漏中文"：
 *   ① 跨文件 return 透传：app.js 里 7 个"首实参是变量"的 toast 点，本轮逐个追了出处 ——
 *      queueCopyToastText() → queueCopy.js、playFailureRetryText()/describePlayError()
 *      → playError.js、buildFallbackNotice() → fallbackNotice.js。这三个文件里没有一处
 *      showToast 调用，LEDGER 的"看实参"判据对它们**完全失明**。
 *   ② 同文件内、但不落在反馈调用上的字面量（弹窗标题/按钮 title/剪贴板报告…）：
 *      views/playlist.js 归零 LEDGER 之后，整文件仍有 47 处 CJK 字面量 ——
  *      其中 `🧮 揽乐 跨歌单重复报告（${n} 首）`（copyDedupeScanReport）直接进剪贴板，
 *      英文界面上照样是中文。
 *
 * 入表规则（写死，别再出现"LEDGER 说 0 就当这个文件干净了"）：
 *   **某文件在 LEDGER 里归零、而整文件还有 CJK 字面量 ⇒ 它必须同时进这张表。**
 *   已经在 LEDGER 里有非零计数的文件不必重复进表（同一事实一个家，避免两份数字各自腐烂）。
 *
 * （listAccess.js 不在表里：它已经走 say(tr, key, 中文兜底)，句子有键可查，兜底才是中文。）
 */
const PASSTHROUGH = {
  'src/renderer/js/fallbackNotice.js': 2,
  'src/renderer/js/playError.js': 6,
  'src/renderer/js/queueCopy.js': 2,
  // LEDGER 归零但整文件仍有 47 处 CJK 字面量（弹窗文案 + 剪贴板报告 + title 提示…）。
  // 本轮只把批量加歌的三个分句接进词典（-3），剩下的**不假装已还清**，如实记账。
  'src/renderer/js/views/playlist.js': 47,
};

function scanPassthrough() {
  const map = {};
  for (const rel of Object.keys(PASSTHROUGH)) {
    const n = cjkLiterals(stripComments(read(rel))).length;
    if (n) map[rel] = n;
  }
  return map;
}

test('自检：透传计数器数的是字面量，且这类中文 LEDGER 确实看不见', () => {
  assert.strictEqual(feedbackSites("function f(){ return '已复制 3 首'; }").length, 0,
    'LEDGER 只看反馈调用的首实参 —— 单列台账不是为了重复，是因为它抓不到');
  assert.strictEqual(cjkLiterals('function f(){ return `📋 已复制 ${n} 首`; }').length, 1);
  assert.strictEqual(cjkLiterals(stripComments("// 注释里举例：'中文'\nvar k = 'toast.copyDone';")).length, 0,
    '注释与词典键名不算中文文案');
});

test('透传文案台账与实际逐字相等（还掉一处改小，新写一处改大）', () => {
  const actual = scanPassthrough();
  assert.deepStrictEqual(actual, PASSTHROUGH,
    '透传台账与实际不符。实跑=' + JSON.stringify(actual)
    + '\n这些文件里的中文不进反馈调用的实参（跨文件 return 透传 / 弹窗与剪贴板文案）：'
    + '新增中文要改表（并补词条接线），还清也要改表。');
});

/**
 * 两张表不许互相盖住：PASSTHROUGH 的成员必须是"LEDGER 判它零欠账"的文件。
 *
 * 为什么需要这一枚：入表规则是"LEDGER 归零、整文件还有中文 ⇒ 进 PASSTHROUGH"，
 * 但规则本身没有机器执行 —— 表是手写的，于是**反向**的漏洞一直敞着：把一个
 * LEDGER 里还欠着 20 处的文件也塞进 PASSTHROUGH，两张表各记一份数，
 * 改一处只改一张 ⇒ 两张表的差额就是新的、未被记账的中文。
 * （顺手也钉住"表项不许写成 0"：计数归零就该删项，而不是留一条恒真的记录。）
 */
test('两张表不许互相盖住：PASSTHROUGH 每一项的 LEDGER 计数都必须是 0，且整文件确有中文', () => {
  const actual = scanLedger();
  const bad = [];
  for (const [rel, n] of Object.entries(PASSTHROUGH)) {
    if (actual[rel]) bad.push(`${rel}: LEDGER 还有 ${actual[rel]} 处，不该同时进 PASSTHROUGH（两份数会各自腐烂）`);
    const whole = cjkLiterals(stripComments(read(rel))).length;
    if (whole !== n) bad.push(`${rel}: 表里写 ${n}，整文件实跑 ${whole}`);
    if (whole === 0) bad.push(`${rel}: 整文件已无中文字面量，表项该删掉（恒真记录是负资产）`);
  }
  assert.deepStrictEqual(bad, [], '两张台账互相盖住了：\n  ' + bad.join('\n  '));
});

/**
 * 定点回归：views/playlist.js 这一枚假进度不许复发。
 *
 * 实测过的失效方式（三样同时发生，界面上一个字都没变）：
 *   ① 三个分句的 `parts.push(\`已加入 ${added} 首\`)` 留着硬编码中文；
 *   ② 只有分隔符接了词典，于是英文界面上是"纯中文句子 + 英文逗号"；
 *   ③ LEDGER 里把该文件的 98 直接删项（归零），判据却因为首实参是
 *      `parts.join(…)` 表达式而一个字面量都扫不到 ⇒ 台账与实跑"逐字相等"。
 * 三样都被本文件（判据⑥ + PASSTHROUGH 表 + 下面三段断言）钉住。
 */
test('views/playlist.js 批量加歌的三段汇总走词典（不是"只接分隔符"那种假进度）', () => {
  const code = stripComments(read('src/renderer/js/views/playlist.js'));
  const fn = /async function _addListToPlaylist\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(code);
  assert.ok(fn, '没找到 _addListToPlaylist');
  const body = fn[0];

  for (const k of ['toast.batchQueued', 'toast.plBatchSkipped', 'toast.plBatchAddFailed']) {
    assert.match(body, new RegExp(`t\\(\\s*'${k}'\\s*,`), `${body.includes(k) ? '' : '该段仍没按键读：'}${k}`);
  }
  // 三段都带 {count}（把首数说实，不是"加入了一些"含糊带过）
  assert.match(body, /t\('toast\.batchQueued',\s*\{\s*count:\s*added,\s*extra:\s*''\s*\}\)/,
    '已加入段应读 toast.batchQueued（app.js:1057 同一个事实的家）并把 extra 传空串');
  assert.match(body, /t\('toast\.plBatchSkipped',\s*\{\s*count:\s*skipped\s*\}\)/);
  assert.match(body, /t\('toast\.plBatchAddFailed',\s*\{\s*count:\s*failed\s*\}\)/);

  // 旧的三句字面量不得残留（含只留分隔符的中文分句：判据⑥ 抓的就是它）
  for (const s of ['已加入 ${added} 首', '跳过已在歌单 ${skipped} 首', '失败 ${failed} 首']) {
    assert.ok(!body.includes(s), `汇总串里还留着硬编码中文分句：${s}`);
  }
  // 判据⑥ 独立复核：这个函数里一处含 CJK 的字面量都不许有
  assert.deepStrictEqual(accumulatorSites(code), [],
    '_addListToPlaylist 仍在往数组里攒中文字面量（判据⑥ 报到的是全文件，不止这一个函数）');
  assert.ok(!new RegExp('已加入|跳过已在歌单').test(body), '汇总串里还有中文分句字面量');
});

test('views/playlist.js 归零 LEDGER 后仍如实进 PASSTHROUGH（"还剩多少"是真实数字）', () => {
  // 本轮只还了 3 处，剩下 47 处（弹窗文案、剪贴板报告、title 提示…）不许装作已清零
  assert.ok(!('src/renderer/js/views/playlist.js' in LEDGER),
    'views/playlist.js 的反馈文案已接词典，LEDGER 里应当是删项而不是留一条 0');
  const n = cjkLiterals(stripComments(read('src/renderer/js/views/playlist.js'))).length;
  assert.ok(n > 0, '整文件已无中文字面量 ⇒ PASSTHROUGH 的表项该删掉');
  assert.strictEqual(PASSTHROUGH['src/renderer/js/views/playlist.js'], n,
    `PASSTHROUGH 与实跑不符：表里写 ${PASSTHROUGH['src/renderer/js/views/playlist.js']}，实跑 ${n}`);
});

/**
 * 批量加歌汇总的五个键，必须**在 zh 与 en 两边都在**，且都带齐占位符。
 *
 * 为什么这条不能靠现成的钉兜住：`用到的每个键都中英齐备` 与 `每条 toast.* 的中英占位符
 * 同集合` 两枚遍历的都是 keysUsedInApp()，而那是**已收编文件**（CONQUERED）的并集 ——
 * views/playlist.js 只做了局部收编，刻意没进那张表（进了就会因整文件还剩 47 处中文而红）。
 * 于是这五个键一度谁都不管：新写一个 zh 键忘了 en，英文界面上就印出键名 `toast.plBatchSkipped`。
 * 局部收编必须自带一枚"这几个键两边齐"的钉，否则就是覆盖盲区。
 */
test(' 批量加歌汇总的五个键中英齐备、占位符对齐、译文是真英文', () => {
  const bad = [];
  for (const k of Object.keys(WIRING_220)) {
    if (!(k in zh)) { bad.push(`${k}: zh 缺键（英文界面会印出键名）`); continue; }
    if (!(k in en)) { bad.push(`${k}: en 缺键（英文界面会印出键名）`); continue; }
    const a = placeholdersOf(zh[k]).join(',');
    const b = placeholdersOf(en[k]).join(',');
    if (a !== b) bad.push(`${k}: 占位符 zh[${a}] vs en[${b}]（少一个 {x} 就是把变量名印给用户）`);
    if (CJK.test(en[k])) bad.push(`${k}: en 里混着中文（等于没译）`);
  }
  assert.deepStrictEqual(bad, [], '这批词条不合格：\n  ' + bad.join('\n  '));

  // 三个计数段必须真的把首数说实 —— "已加入一些"在批量操作里是不合格的反馈
  for (const k of ['toast.batchQueued', 'toast.plBatchSkipped', 'toast.plBatchAddFailed']) {
    assert.match(zh[k], /\{count\}/, `${k} 缺 {count}：批量加歌不报数等于让用户自己数`);
    assert.match(en[k], /\{count\}/, `${k}(en) 缺 {count}`);
  }
  // 复核接线：这五个键是 _addListToPlaylist 一个不落地按键读的
  const used = new Set(keysUsedIn('src/renderer/js/views/playlist.js'));
  const missing = Object.keys(WIRING_220).filter((k) => !used.has(k));
  assert.deepStrictEqual(missing, [],
    '表里有键没人读（表已脱钩）／或函数改用了别的键：' + missing.join(', '));
});

// ── D3：词典侧双向对账 ──

/** 已收编文件里用到的全部词典键（本轮兑现的那一面） */
function keysUsedInApp() {
  const set = new Set();
  for (const rel of CONQUERED) for (const k of keysUsedIn(rel)) set.add(k);
  return [...set].sort();
}

/**
 * 取词调用的名字清单。
 *
 * 45838e3 之前"取词只有一个拼法 `t('键')`"，判据可以硬到只认 t(。
 * 之后取词函数可以按参数注入（toast.js 收到的就叫 translate，与 listAccess.js / home.js 的
 * term 同一约定），静态签名不再是编译期保证，判据只能退回名字清单：
 * 新引入一个注入名就必须同时进这里 —— 漏了的那一条接线会被词典侧当成孤儿（本轮实测就是这么炸出来的：
 * toast.dlFatal / toast.dlError 明明被读，孤儿台账却说没人用）。与 FEEDBACK_FNS 同法。
 */
const TERM_FNS = ['t', 'translate', 'term'];
const TERM_FN_RE = new RegExp('\\b(?:' + TERM_FNS.join('|') + ')\\(\\s*([\'"])([^\'"]+)\\1', 'g');

/** 某个纳管文件里用到的全部词典键：认所有取词函数名（见 TERM_FNS）的字符串字面量实参 */
function keysUsedIn(rel) {
  const code = stripComments(read(rel));
  const set = new Set();
  const re = new RegExp(TERM_FN_RE.source, 'g');
  let m;
  while ((m = re.exec(code))) set.add(m[2]);
  return [...set].sort();
}

/** 纳管面内被用过的所有词典键（孤儿判定按全渲染层，不按单文件） */
function keysUsedAnywhere() {
  const set = new Set();
  for (const rel of managedFiles()) {
    for (const k of keysUsedIn(rel)) set.add(k);
  }
  return set;
}

function placeholdersOf(text) {
  return (String(text).match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []).sort();
}

test('用到的每个键都中英齐备', () => {
  const used = keysUsedInApp();
  assert.ok(used.length >= 20, '已收编文件的词典调用点异常稀薄：' + used.length + '（是不是改坏了？）');
  const missing = used.filter((k) => !(k in zh) || !(k in en));
  assert.deepStrictEqual(missing, [], '这些键在 zh/en 里缺席（英文界面会印出键名）：' + missing.join(', '));
});

/**
 * 词典侧的"没人按键读"台账（974fe2f 的幽灵键病，这次长在语言包上）。
 *
 * 实测发现：zh/en 里早就挂着 34 条 `toast.*` 词条（某次 i18n 迁移写了一半就停了），
 * 而渲染层对 t() 的调用数是 **0** —— 全部没人按键读，只能靠 translateMessage 的
 * 值匹配撞运气。本轮 app.js + toast.js 消费掉 47 条（含新增），剩下的记在这里。
 *
 * 把 settings.js 接上线，吃掉了这张表里的 17 条（probeDone / cookieSaved /
 * clearFailed / cookieCleared / template* / cache* / reset* / export* / importFailed ——
 * 它们本来就是从 settings.js 抄进词典的，只是那次抄完没接线）。 接上 importConfirm +
 * importSuccess（破坏性覆盖加确认守卫顺带消孤儿）。 接上 search.js handleLinkInput 的
 * linkShort / linkRecognized / linkUnsupported / linkFailed（链接识别四处反馈）。
 *
 * 清零收官：alreadyDownloaded / alreadyDownloadedAt / redownload 接上 utils.js 的
 * showRedownloadToast（一句"已下载过 + 仍要下载"就吃掉三条），queueRestored 接上
 * player-sync.js（顺带给两边补 {count} —— 原值不含首数，接上去会说谎），
 * loading / saved 全仓零消费方（既无按键调用也无 data-i18n，grep 只命中本测试名单）
 * ⇒ 判为死词条**删除**，而不是硬凑一个调用点去消数字。短值「已保存」留着更是负资产：
 * 它会抢走「已保存歌单…」这类长句的值匹配前缀（191 记过的雷）。
 *
 * 从此这张表是**空表常态**：下面的对账测把"任何 toast.* 键都必须有消费方"变成硬门禁
 * （189 律：白名单只进不出）。新写词条不同一次接线落地即红。
 */
const ORPHANS = [];

test('toast.* 孤儿词条与实际逐字相等（接线一个少一个，新写词条必须同时接上）', () => {
  const used = keysUsedAnywhere();
  const actual = Object.keys(zh).filter((k) => k.startsWith('toast.') && !used.has(k)).sort();
  const actualEn = Object.keys(en).filter((k) => k.startsWith('toast.') && !used.has(k)).sort();
  assert.deepStrictEqual(actual, ORPHANS,
    'zh 侧孤儿不符，实跑=' + JSON.stringify(actual)
    + '\n新增词条必须同时有消费方（白名单键须与消费方同一次落地）；接上线的把名字从表里删掉。');
  assert.deepStrictEqual(actualEn, ORPHANS, 'en 侧孤儿与 zh 侧不一致：' + JSON.stringify(actualEn));
});

test('每条 toast.* 译文都是真英文（不得照抄中文）', () => {
  const bad = keysUsedInApp().filter((k) => k.startsWith('toast.') && en[k] === zh[k]);
  assert.deepStrictEqual(bad, [], '这些键的 en 与 zh 一字不差（等于没译）：' + bad.join(', '));
  const noZh = keysUsedInApp().filter((k) => k.startsWith('toast.') && !CJK.test(zh[k]));
  assert.deepStrictEqual(noZh, [], '这些键的 zh 值里没有中文（文案搬家时丢了？）：' + noZh.join(', '));
});

/**
 * 词条自身的形状（本轮实测到的旧伤：`" Ready"`、`" SaveFailed"` 带前导空格，
 * 是复制进语言包时留下的脏值 —— 一旦接线就会在英文界面上印出歪斜文案）。
 */
test('toast.* 两边值都是干净文案（无首尾空白、en 不含中文、zh 必须含中文）', () => {
  // toast.listSeparator 是 join 用的分隔符不是句子：en 值 ", " 的尾随空格是分隔符本体
  // （拼进列表要 ", "），zh 值 "，" 是全角逗号不在 CJK 判据的汉字区间 —— 按句子口径会误伤它。
  const SEPARATOR_KEYS = new Set(['toast.listSeparator']);
  const keys = Object.keys(zh).filter((k) => k.startsWith('toast.') && !SEPARATOR_KEYS.has(k));
  assert.ok(keys.length >= 20, '词典里 toast.* 词条数异常：' + keys.length);
  const bad = [];
  for (const k of keys) {
    if (typeof en[k] !== 'string') { bad.push(`${k}: en 缺值`); continue; }
    if (zh[k] !== String(zh[k]).trim()) bad.push(`${k}: zh 首尾有空白`);
    if (en[k] !== String(en[k]).trim()) bad.push(`${k}: en 首尾有空白`);
    if (CJK.test(en[k])) bad.push(`${k}: en 里混着中文`);
    if (!CJK.test(zh[k])) bad.push(`${k}: zh 里没有中文`);
  }
  assert.deepStrictEqual(bad, [], '词条文案不合格：\n  ' + bad.join('\n  '));
});

test('每条 toast.* 的中英占位符同集合（漏一个 {x} 就是把变量名印给用户）', () => {
  const bad = [];
  for (const k of keysUsedInApp()) {
    if (!k.startsWith('toast.')) continue;
    const a = placeholdersOf(zh[k]).join(',');
    const b = placeholdersOf(en[k]).join(',');
    if (a !== b) bad.push(`${k}: zh[${a}] vs en[${b}]`);
  }
  assert.deepStrictEqual(bad, [], '占位符两边不一致：\n  ' + bad.join('\n  '));
});

/**
 * 已接词典的文案出去时已是英文，而 toast.js 还会再过一道 translateMessage
 * （值匹配反查）。两条翻译路径叠在一起时唯一会出事的情形是：某条 zh 词条的值恰好
 * 是某条英文输出的**前缀** ⇒ 整句被改写成另一个词条。
 *
 * ⚠️ 判据一开始被我写窄了：只拿"含中文的 zh 值"去比英文前缀 —— 中文值永远撞不到
 *    英文开头，等于恒真。真正的杀手是那两条**不含中文**的 zh 值（`app.title`、
 *    `player.artist`）：zh 值只要哪天变成 "Removed"/"Loading" 这类英文词，
 *    所有以它开头的英文 toast 都会被吞掉后半句。所以这里**不过滤**中文。
 */
test('已翻译的文案不会再被值匹配二次改写（t() 与 translateMessage 不打架）', () => {
  const zhValues = Object.keys(zh).map((k) => String(zh[k])).filter((v) => v.length > 0);
  const bad = [];
  for (const k of keysUsedInApp()) {
    if (!k.startsWith('toast.')) continue;
    const out = String(en[k]);
    const hit = zhValues.find((v) => out === v || out.startsWith(v));
    if (hit) bad.push(`${k}: "${out}" 以中文词条值 "${hit}" 开头`);
  }
  assert.deepStrictEqual(bad, [], '这些键的英文输出会被 translateMessage 再翻一次：\n  ' + bad.join('\n  '));
});

// ── 接线：取词只有一个家，且必须是语言包 ──

test('app.js 的取词走 i18n.js 的 t（不许自己攒一份词典或走 window 兜底）', () => {
  const src = read('src/renderer/js/app.js');
  assert.match(src, /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\/i18n\.js'/,
    'app.js 应直接 import { t } from i18n.js（静态导入，语言包在模块求值时就位）');
  assert.ok(!/window\.t\s*\(/.test(stripComments(src)),
    '已经静态导入 t 了，就别再留一条 window.t 的旁路（同一事实两个家）');
});

/**
 * 45838e3 踩出来的坑，必须留哨兵：**能被 node 测试 import 的文件，图里不许有 JSON import**。
 *
 * 来龙去脉：给 toast.js 加了一行 `import { t } from './i18n.js'` 之后，i18n.js 的语言包
 * JSON import 就进了所有依赖 toast.js 的测试图（实跑里 toast-timing.test.js 整个文件连坐炸红：
 * node 的 ESM 加载器要求 JSON 带 import attribute）。两条出路都堵着 ——
 * ① 给 JSON import 补 `with { type: 'json' }`：node 认，但本仓 eslint 8 / espree 9.6
 *    解析不了 with 写法（lint 门禁红，且 ecmaVersion 拉到 latest 也不行）；
 * ② 把语言包改成 .js 模块：能通，但 zh.json/en.json 有 12 处 CJS require / JSON.parse 消费方，
 *    为一个文件的加载方式改全仓词典格式，半径不成比例。
 * 所以走仓里已经立着的约定（listAccess.js 的 term、home.js 的 term）：**取词函数当参数传进来**。
 * 这枚钉就是这条约定的哨兵 —— 谁把 i18n.js 静态拖回 toast.js，红。
 */
test('toast.js 在 node 的 ESM 加载器下可求值（可测文件的图里不许有 JSON import）', async () => {
  const { pathToFileURL } = require('node:url');
  const url = pathToFileURL(path.join(REPO, 'src/renderer/js/toast.js')).href;
  const prevWindow = globalThis.window;
  globalThis.window = globalThis.window || {};
  let mod = null;
  let err = null;
  try {
    mod = await import(url);
  } catch (e) {
    err = e;
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
  assert.equal(err, null, 'import toast.js 失败：' + (err && err.message));
  assert.equal(typeof mod.showDownloadError, 'function');
  assert.ok(!/from\s*'\.\/i18n\.js'/.test(stripComments(read('src/renderer/js/toast.js'))),
    'toast.js 不许静态导入 i18n.js（那会把语言包 JSON 拖进 node 测试图）——取词按参数注入');
});

/**
 * 注入式取词的代价是：接线从"编译期保证"降级成"调用方自觉"。
 * 少传一个实参，translate 就是 undefined —— 错误路径上的 undefined 又最容易漏测（要真下载失败才走得到）。
 * 所以这枚钉同时读签名和调用点，数量对不上就红，而不是等到用户点出下载失败才发现。
 */
test('showDownloadError 的形参与唯一调用方实参数量对齐（取词函数不许漏传）', () => {
  const toastCode = stripComments(read('src/renderer/js/toast.js'));
  const appCode = stripComments(read('src/renderer/js/app.js'));
  const sig = toastCode.match(/function\s+showDownloadError\s*\(([^)]*)\)/);
  assert.ok(sig, 'toast.js 里应能读到 showDownloadError 的函数声明');
  const params = sig[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(params.length, 4,
    '签名应显式收下取词函数（title/error/fatal/translate）：躲回硬编码中文或改成读全局，都算退步');
  assert.equal(params[3], 'translate', '第四个形参就是注入的取词函数');

  const calls = [...appCode.matchAll(/\bshowDownloadError\s*\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(calls.length, 1,
    'app.js 是 showDownloadError 的唯一调用方（多一个入口就得同时多一枚钉，见记忆里的消费方审计）');
  const args = calls[0].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(args.length, params.length,
    `调用方传了 ${args.length} 个实参，签名要 ${params.length} 个（漏传 translate 会让下载失败提示当场抛异常）`);
  assert.equal(args[3], 't', '第四个实参必须是 i18n.js 的 t，不能是别的东西');
});

// ── 边界：不许借新通道/新出口偷偷改架构 ──

/**
 * 零新 IPC：翻译是渲染层-local。
 * ⚠️ i18n.js 本来就调 api.getPref/setPref 来**记住语言选择**（66ac646 那条线），
 *    那是既有通道、既有职责，不是本钉要防的东西 —— 防的是"多一个通道"，
 *    所以判据取用过的 api 方法名集合，与今日快照逐字相等。
 */
const API_METHODS_ALLOWED = ['getPref', 'setPref'];

test('零新 IPC：toast/i18n 两家用到的 api 方法不得超出快照', () => {
  const used = {};
  for (const rel of ['src/renderer/js/toast.js', 'src/renderer/js/i18n.js']) {
    const code = stripComments(read(rel));
    const re = /\bapi\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let m;
    while ((m = re.exec(code))) (used[rel] = used[rel] || new Set()).add(m[1]);
  }
  const actual = {};
  for (const rel of Object.keys(used).sort()) actual[rel] = [...used[rel]].sort();
  assert.deepStrictEqual(actual['src/renderer/js/toast.js'] || [], [],
    'toast.js 不该碰 api：文案翻译不需要跨进程往返');
  assert.deepStrictEqual(actual['src/renderer/js/i18n.js'] || [], API_METHODS_ALLOWED.slice().sort(),
    'i18n.js 的 api 用法变了（实跑=' + JSON.stringify(actual['src/renderer/js/i18n.js'] || [])
    + '）：加通道要另立增量并走 ipcSchema');
});

test('translateMessage 仍作为存量兜底在位（本轮没把它抽走）', () => {
  const code = read('src/renderer/js/toast.js');
  assert.match(code, /translateMessage/, 'toast.js 仍应对未接词典的存量文案保留值匹配兜底');
});

test('importConfig 是破坏性覆盖，IPC 前必须有 askConfirm', () => {
  const src = read('src/renderer/js/views/settings.js');
  const fn = src.slice(src.indexOf('async function importConfig()'));
  const confirmIdx = fn.indexOf('askConfirm');
  const invokeIdx = fn.indexOf("api.invoke('import-all-data')");
  assert.ok(confirmIdx >= 0, 'importConfig 缺 askConfirm —— 导入会静默覆盖全部歌单/设置/历史');
  assert.ok(invokeIdx >= 0, 'importConfig 调 import-all-data 的锚还在');
  assert.ok(confirmIdx < invokeIdx, '确认必须在 IPC 调用之前');
});

test('importConfig 的成功/失败 toast 走词典不透传中文（消 importSuccess 孤儿）', () => {
  const src = read('src/renderer/js/views/settings.js');
  const fn = src.slice(src.indexOf('async function importConfig()'));
  assert.ok(!/['"`]\u2705\s*['"`]\s*\+/.test(fn) && !/["'`]\u274c\s*["'`]\s*\+/.test(fn),
    'importConfig 内不应再拼 emoji + 主进程中文字面量（走 t() 取词典整句）');
});

test('toast.importConfirm 与 toast.importSuccess 不再是孤儿（接线兑现）', () => {
  assert.ok(!ORPHANS.includes('toast.importConfirm'), 'importConfirm 已被 settings.js 接线，应从 ORPHANS 删除');
  assert.ok(!ORPHANS.includes('toast.importSuccess'), 'importSuccess 已被 settings.js 接线，应从 ORPHANS 删除');
});

test('search.js 的 handleLinkInput 四处链接反馈全走词典（919c187 收编）', () => {
  const src = read('src/renderer/js/views/search.js');
  const fn = src.slice(src.indexOf('async function handleLinkInput('));
  assert.ok(fn.length > 50, 'handleLinkInput 锚还在');
  for (const k of ['toast.linkShort', 'toast.linkRecognized', 'toast.linkUnsupported', 'toast.linkFailed']) {
    assert.ok(fn.includes(`t('${k}')`) || fn.includes(`t('${k}',`),
      `handleLinkInput 应改用 t('${k}') —— 英文界面这里会漏中文`);
  }
  // 旧的硬编码中文整句不得残留（值匹配兜底会把「已识别」这类前缀抢走改错别的长句）
  assert.ok(!/showToast\(`🔗 已识别/.test(fn), '识别成功 toast 不得再拼中文字面量模板串');
  assert.ok(!/showToast\('暂不支持/.test(fn) && !/showToast\('检测到短链/.test(fn),
    '短链/不支持提示不得再是硬编码中文');
  assert.ok(!/showToast\('链接识别：'/.test(fn), '失败 toast 应走 t() 只把主进程 error 当变量透传');
});

test('toast.link* 四条不再是孤儿（接线兑现）', () => {
  for (const k of ['toast.linkShort', 'toast.linkRecognized', 'toast.linkUnsupported', 'toast.linkFailed']) {
    assert.ok(!ORPHANS.includes(k), `${k} 已被 search.js 接线，应从 ORPHANS 删除`);
  }
});

test('两条无人消费的死词条已删除：toast.loading / toast.saved 不该还躺在词典里', () => {
  // 实测（改动前）：src/ 与 index.html 里没有任何 showToast('加载中…')/showToast('已保存')，
  // 也没有 data-i18n="toast.loading"/"toast.saved" —— 全仓 grep 只命中本测试的名单。
  // 留着它们等于让「已保存」这种短值去抢「已保存歌单…」的长句前缀（值匹配的雷，191 记过）。
  for (const k of ['toast.loading', 'toast.saved']) {
    assert.equal(zh[k], undefined, `${k} 在 zh 侧仍是死词条`);
    assert.equal(en[k], undefined, `${k} 在 en 侧仍是死词条`);
  }
});

test('utils.js 的「已下载过 / 仍要下载」三句走词典，反馈点不留中文字面量', () => {
  const src = read('src/renderer/js/utils.js');
  const fn = src.slice(src.indexOf('function showRedownloadToast('));
  assert.ok(fn.length > 50, 'showRedownloadToast 锚还在');
  for (const k of ['toast.alreadyDownloadedAt', 'toast.alreadyDownloaded', 'toast.redownload']) {
    assert.ok(fn.includes(`t('${k}')`) || fn.includes(`t('${k}',`),
      `showRedownloadToast 应改用 t('${k}') —— 英文界面这里必然漏中文`);
  }
  // 参数名必须与词典占位符同名，写错等于把 "{when}" 印给用户。
  // 注意口径：整段里本来就还有 `const when = ...`，光测 \bwhen\b 永远绿 —— 必须钉参数对象本身。
  assert.ok(/\{\s*title\s*,\s*when\s*\}/.test(fn) && /\{\s*title\s*\}/.test(fn),
    't() 的 params 必须恰是 { title, when } / { title}（与词典 {title} {when} 对齐）');
  // 三条旧硬编码整句不得残留在反馈点
  assert.ok(!/「\$\{title\}」/.test(fn) && !/btnLabel:\s*['"]仍要下载['"]/.test(fn),
    'showRedownloadToast 内不应再拼中文整句（值只许留在词典一家）');
});

test('player-sync.js 恢复队列 toast 走词典并带上首数', () => {
  const src = read('src/renderer/js/player-sync.js');
  assert.ok(/t\(\s*'toast\.queueRestored'\s*,\s*\{[^}]*\bcount\b/.test(src),
    '恢复队列 toast 应走 t(\'toast.queueRestored\', { count }) —— 原模板串英文界面必漏中文');
  assert.ok(!/showToast\(\s*`♻️\s*恢复播放队列/.test(src),
    '旧的 `♻️ 恢复播放队列 N 首` 模板串不得残留（带变量的整句值匹配永远撞不到）');
  // 零 import 守卫（drop-play.test.js:110）不许被本增量破掉
  assert.ok(!/^\s*import\s/m.test(src), 'player-sync.js 仍必须零 import（桥走 window.t 的本模块别名）');
});

test('toast.queueRestored 两边都得有 {count}（把首数说实，不是"恢复了"含糊带过）', () => {
  assert.ok(/\{count\}/.test(zh['toast.queueRestored']), 'zh 值缺 {count} 占位符');
  assert.ok(/\{count\}/.test(en['toast.queueRestored']), 'en 值缺 {count} 占位符');
});
