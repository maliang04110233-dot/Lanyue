/**
 * ci-doctor.cjs —— 把「CI 红了」翻译成「谁的锅、下一步做什么」
 *
 * 存在的理由（2026-10-14 那轮红四天）：单测失败只有用例名进了 annotation，
 * 断言差值与文件行全留在需要 admin 才下得动的 job 原始日志里。补了 FAIL-DETAIL
 * 之后好了一些，但仍缺一层判断 —— 同一个 `not ok` 可能是真回归、可能是异步泄漏
 * 挂到无辜用例头上、可能是测试偷偷出了网、也可能压根不是代码问题。
 * 这四种的正确处置完全相反（改代码 / 堵泄漏 / 关出网 / 重跑或换 runner），
 * 让人对着原文自己分辨，就是把归因又推回给人。
 *
 * 口径：
 *   · 纯确定性规则 —— 输入一段 TAP 文本，输出恒定。CI 不出网、不花钱，
 *     所以判定只能来自文本本身，不能来自模型。
 *   · 只读自己的产物 —— 输入是 Unit tests 步骤落盘的 attempt-N.tap.txt。
 *   · 不越权 —— 退出码恒为 0。红不红由原步骤判，本脚本只解释红。
 *     归因脚本自己坏掉时必须安静退化，不能把绿跑弄红。
 *
 * 判据都钉在 node --test --test-reporter=tap 的真实输出形状上（见 test/ciDoctor.test.js
 * 里的 fixture 来源说明）。node 升级改了文案时那些用例会红，而红得对。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 出网特征。测试期出现这些串意味着真有请求跑出去了 —— 本仓的单测口径是必须离线，
 * 所以它不是「环境抖动」，是可定罪的缺陷（2026-10-14 那次就是文件名猜出来的标题
 * 被拿去搜在线封面，CI 因此在向 QQ 发真请求）。
 */
const EGRESS_RE = /(ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ENOTFOUND|ETIMEDOUT|socket hang up|getaddrinfo|songsearch\.|c\.y\.qq\.com|y\.qq\.com|music\.163\.com|kugou|kuwo\.|migu|fetchOnlineCover|scheduleOnlineLrc|searchViaGateway)/i;

/** node 把「用例结束后才发生的异步活动」报成整文件级 not ok，真凶写在这行注释里 */
const ESCAPE_RE = /^#\s*Error:\s*Test "(.+?)" at (\S+?) generated asynchronous activity after the test ended\.(.*)$/;

const OK_RE = /^(?:not )?ok (\d+) - (.*)$/;
const LOCATION_RE = /^\s+location:\s*'?(.+?\.(?:js|mjs|cjs):\d+:\d+)'?\s*$/;
const FRAME_RE = /([^\s()]+\.(?:js|mjs|cjs):\d+:\d+)/;
const COUNT_RE = /^#\s*(pass|fail|cancelled|skipped)\s+(\d+)/;
/** runner 对单条 annotation 的可见长度很紧，宁可少说也别把 next action 切掉 */
const MAX_ANNOTATION = 1200;

const KEY_RE = /^\s{2}([A-Za-z_][\w-]*):(.*)$/;

/** 块标量（`key: |-`）的后继行：4 空格缩进，或空行 */
const BLOCK_LINE_RE = /^(?: {4}|$)/;

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'") && t.length > 1) || (t.startsWith('"') && t.endsWith('"') && t.length > 1)) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 解析一段 TAP 文本。只认三种东西：`ok/not ok` 条目及其 YAML 块、`# Error:` 异步泄漏行、
 * `# pass/fail` 汇总行。其余原样留在 evidence 里供人看。
 */
function parseTap(text) {
  const lines = stripBom(String(text)).split(/\r?\n/);
  const failures = [];
  const escapes = [];
  const counts = { pass: 0, fail: 0, cancelled: 0, skipped: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const esc = line.match(ESCAPE_RE);
    if (esc) {
      escapes.push({ ownerTest: esc[1], culprit: esc[2], message: esc[3].trim() });
      continue;
    }

    const cnt = line.match(COUNT_RE);
    if (cnt) {
      counts[cnt[1]] = Number(cnt[2]);
      continue;
    }

    const ent = line.match(OK_RE);
    if (!ent) continue;
    const rawName = unquote(ent[2]);
    const isOk = !line.startsWith('not ok');

    // YAML 块：往后吃，直到下一个条目/汇总行/顶格键
    const block = {};
    const blockLines = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const b = lines[j];
      if (OK_RE.test(b) || /^#/.test(b) || /^\d+\.\.\d+/.test(b)) break;
      const key = b.match(KEY_RE);
      if (key) {
        const [, k, rest] = key;
        if (rest.trim() === '|-' || rest.trim() === '|') {
          const buf = [];
          let n = j + 1;
          for (; n < lines.length && BLOCK_LINE_RE.test(lines[n]); n++) buf.push(lines[n].slice(4));
          block[k] = buf.join('\n').replace(/\s+$/, '');
          j = n - 1;
        } else {
          block[k] = unquote(rest);
        }
        if (k !== 'duration_ms') blockLines.push(b);
        continue;
      }
      if (b.trim() === '...') continue;
      if (b.trim() === '') continue;
      blockLines.push(b);
    }
    i = j - 1;

    if (isOk) continue;
    const location = block.location && LOCATION_RE.test(block.location)
      ? block.location.match(LOCATION_RE)[1]
      : (block.location || '').trim();
    // stack 首帧是用例体内真正抛出的那一行；location 只是用例声明处 —— 修代码要往前者去
    const stack = block.stack || '';
    const frame = stack.match(FRAME_RE);
    failures.push({
      index: Number(ent[1]),
      name: rawName,
      fileLevel: /\.test\.js$/.test(rawName),
      location,
      culprit: frame ? frame[1] : location,
      error: block.error || '',
      code: block.code || '',
      failureType: block.failureType || '',
      exitCode: block.exitCode,
      blockText: blockLines.join(' ').slice(0, 600),
    });
  }

  return { failures, escapes, counts };
}

function fingerprint(f) {
  return `${f.name}|${f.culprit || f.location}`;
}

function egressEvidence(text) {
  const m = String(text).match(new RegExp(EGRESS_RE.source, 'gi'));
  return m ? Array.from(new Set(m)).slice(0, 4).join(', ') : '';
}

const RULES = {
  TEST_EGRESS: {
    verdict: '测试期间真的出网了。本仓单测口径是离线，这不是环境噪声。',
    nextAction: '定位那次出网的调用点并在测试里桩掉它（参照 test/ciDoctor.test.js 头部记的 require.cache 桩法）',
  },
  ASYNC_ESCAPE: {
    verdict: '误归属：失败挂在整文件上，真凶是用例结束后才落地的异步活动（多为未 await 的 fire-and-forget）。',
    nextAction: '去 culprit 处把游离 Promise 接住或改成 await，别改这个用例的断言',
  },
  DETERMINISTIC_REGRESSION: {
    verdict: '三次 attempt 同一个指纹：确定性回归，重跑不会好。',
    nextAction: '按 culprit 行改代码或改用例，不能靠重跑过关',
  },
  FLAKY: {
    verdict: '失败指纹在 attempt 之间漂移：并发资源竞争或时序依赖，不是同一处逻辑坏掉。',
    nextAction: '登记待查（看各 attempt 的失败名差异），别把它写成「环境抖动，重跑即可」',
  },
  INFRA: {
    verdict: '进程退出码非 0，但 TAP 里一个失败用例都没有。',
    nextAction: '查 runner 侧：npm 安装/内存/磁盘/Node 崩溃，与本次提交代码无关',
  },
};

/**
 * 把 3 次 attempt 的解析结果折成结论。
 * 优先级：能直接定罪的证据（出网）> 形态推断（整文件级+异步泄漏）> 跨 attempt 分布。
 */
function analyze(attempts) {
  const parsed = attempts.map((a) => ({ index: a.index, exitCode: a.exitCode, raw: a.tap, tap: parseTap(a.tap), egress: egressEvidence(a.tap) }));
  const total = parsed.length;
  const groups = new Map();

  for (const a of parsed) {
    for (const f of a.tap.failures) {
      const key = fingerprint(f);
      let g = groups.get(key);
      if (!g) {
        g = { key, name: f.name, file: f.location.split(':')[0], culprit: f.culprit, location: f.location, attempts: [], sample: f, escape: null, egress: '' };
        groups.set(key, g);
      }
      g.attempts.push(a.index);
      // 整文件级 not ok 与同一 attempt 里的异步泄漏注释配对：那行注释才是真凶地址
      if (f.fileLevel && a.tap.escapes.length) {
        const hit = a.tap.escapes.find((e) => e.culprit.startsWith(f.name) || e.culprit.includes(path.basename(f.name))) || a.tap.escapes[0];
        if (hit) {
          g.escape = hit;
          g.culprit = hit.culprit;
        }
      }
      if (a.egress) g.egress = a.egress;
    }
  }

  const found = [];
  const flaky = [];
  for (const g of groups.values()) {
    const evidence = [g.egress && `出网痕迹: ${g.egress}`, g.escape && `泄漏: ${g.escape.ownerTest} → ${g.escape.culprit}`,
      g.sample.error && `断言差值: ${g.sample.error.replace(/\s+/g, ' ').slice(0, 220)}`,
      g.sample.blockText].filter(Boolean).join(' | ').slice(0, 700);

    let category;
    if (g.egress) category = 'TEST_EGRESS';
    else if (g.escape && g.name.endsWith('.test.js')) category = 'ASYNC_ESCAPE';
    else if (g.attempts.length === total) category = 'DETERMINISTIC_REGRESSION';
    else { category = 'FLAKY'; flaky.push(g); }

    found.push({ category, name: g.name, file: g.file, culprit: g.culprit, attempts: g.attempts,
      evidence, verdict: RULES[category].verdict, nextAction: RULES[category].nextAction });
  }

  // 多个漂移指纹合成一条：间歇性的证据恰恰是「每次红的不是同一条」
  if (flaky.length) {
    const others = found.filter((x) => x.category !== 'FLAKY');
    const detail = parsed.map((a) => `attempt ${a.index}: ${(a.tap.failures || []).map((f) => f.name).join(',') || '无失败'}`).join('; ');
    const drifted = flaky.map((g) => g.culprit || g.location).filter(Boolean);
    others.push({ category: 'FLAKY', name: `${flaky.length} 条漂移`, file: '', culprit: drifted.slice(0, 3).join(' '),
      attempts: flaky.flatMap((x) => x.attempts), evidence: detail.slice(0, 700),
      verdict: RULES.FLAKY.verdict, nextAction: RULES.FLAKY.nextAction });
    found.length = 0;
    found.push(...others);
  }

  for (const a of parsed) {
    if (a.exitCode !== 0 && a.tap.failures.length === 0 && a.tap.escapes.length === 0) {
      found.push({ category: 'INFRA', name: `attempt ${a.index} 无失败用例却非 0 退出`, file: '', culprit: '',
        attempts: [a.index], evidence: String(a.raw).slice(-300), verdict: RULES.INFRA.verdict, nextAction: RULES.INFRA.nextAction });
    }
  }

  const order = ['TEST_EGRESS', 'ASYNC_ESCAPE', 'DETERMINISTIC_REGRESSION', 'FLAKY', 'INFRA'];
  found.sort((x, y) => order.indexOf(x.category) - order.indexOf(y.category));

  const allGreen = parsed.every((a) => a.exitCode === 0) && found.length === 0;
  return { verdict: allGreen ? 'GREEN' : (found.length ? 'FAIL' : 'UNKNOWN'), attempts: total, findings: found };
}

/** runner 的 workflow command 只吃转义后的单行：先 % 再 #，换行必须消失 */
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/#/g, '%23').replace(/\r/g, '').replace(/\n/g, ' ');
}

function annotationLine(f) {
  const parts = [
    `category=${f.category}`,
    `attempts=${f.attempts.join(',')}`,
    `culprit=${f.culprit || f.file || '?'}`,
    `evidence=${(f.evidence || '').replace(/\s+/g, ' ').slice(0, 220)}`,
    `next=${f.nextAction}`,
  ];
  return `::error::CI-DOCTOR ${escapeData(parts.join(' '))} name=${escapeData(f.name)}`;
}

/** 最多 5 条 + 1 条「另有 N 条」：runner 只显示少数 annotation，堆多了等于没有 */
function formatAnnotations(result, cap = 5) {
  if (result.verdict === 'GREEN') return [];
  const shown = result.findings.slice(0, cap).map(annotationLine);
  const rest = result.findings.length - shown.length;
  if (rest > 0) shown.push(`::error::CI-DOCTOR category=MORE 另有 ${rest} 条同类失败，见 step summary`);
  return shown.map((l) => (l.length <= MAX_ANNOTATION ? l : `${l.slice(0, MAX_ANNOTATION - 60)} …(截断)`));
}

function formatSummary(result) {
  const lines = ['', '## CI 归因（确定性规则，未出网）', '', `结论：\`${result.verdict}\`（共 ${result.attempts} 次 attempt）`, ''];
  lines.push('| 类别 | 用例 | 真凶位置 | 处置建议 |', '| --- | --- | --- | --- |');
  for (const f of result.findings) {
    lines.push(`| ${f.category} | ${(f.name || '').replace(/\\|\|/g, '\\|')} | ${f.culprit || f.file || '-'} | ${f.nextAction.replace(/\|/g, '\\|')} |`);
  }
  for (const f of result.findings) {
    if (f.evidence) lines.push('', `**${f.category} / ${f.name}**`, '', '```', f.evidence, '```');
  }
  return lines.join('\n');
}

/**
 * 读 attempt-N.tap.txt（Unit tests 步骤每轮落一份）并出归因。
 * 返回 { exitCode, stdout }，绝不抛、绝不非 0 —— 红由原步骤判。
 */
function run(opts = {}) {
  const stdout = [];
  try {
    const attempts = [];
    if (opts.tapFile) {
      attempts.push({ index: 1, exitCode: 1, tap: fs.readFileSync(opts.tapFile, 'utf8') });
    } else {
      const dir = opts.dir || '.';
      const files = fs.readdirSync(dir)
        .filter((n) => /^attempt-\d+\.tap\.txt$/.test(n))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      for (const n of files) {
        const idx = Number(n.match(/\d+/)[0]);
        const exitFile = path.join(dir, `attempt-${idx}.exit`);
        const exitCode = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) || 1 : 1;
        attempts.push({ index: idx, exitCode, tap: fs.readFileSync(path.join(dir, n), 'utf8') });
      }
    }
    if (!attempts.length) {
      stdout.push('::warning::CI-DOCTOR 没有可读的 attempt-N.tap.txt，跳过归因（不影响本步骤结论）');
      return { exitCode: 0, stdout, result: null };
    }

    const result = analyze(attempts);
    if (result.verdict === 'GREEN') {
      stdout.push('::notice::CI-DOCTOR 单测全绿，无需归因');
    } else {
      stdout.push(...formatAnnotations(result));
      if (opts.summary && process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(result), 'utf8'); } catch { /* summary 写不进不影响归因 */ }
      }
    }
    return { exitCode: 0, stdout, result };
  } catch (err) {
    stdout.push(`::warning::CI-DOCTOR 归因脚本自身失败（${escapeData(String(err && err.message || err)).slice(0, 200)}），跳过归因`);
    return { exitCode: 0, stdout, result: null };
  }
}

module.exports = { parseTap, analyze, formatAnnotations, formatSummary, run, RULES, MAX_ANNOTATION };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const out = run({
    dir: get('--tap-dir') || (argv.length ? process.cwd() : '.'),
    tapFile: get('--tap-file'),
    summary: argv.includes('--summary'),
  });
  for (const line of out.stdout) console.log(line);
  process.exitCode = out.exitCode;
}
