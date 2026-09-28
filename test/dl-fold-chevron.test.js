/**
 * dl-fold-chevron.test.js — 折叠/展开三角与队列重排箭头不许撞车
 *
 * 来龙去脉（不是审美问题，是「点它会做什么」被画反了）：
 * 队列行工具条上一共 7 枚按钮，其中「展开/收起详情」与「上移/下移/置顶」是两组
 * 完全不同的动作，却一度共用同一对图标 —— 展开态画「上移箭头」、折叠态画「下移
 * 箭头」，与 title（「收起详情」/「展开详情」）正好相反。用户在 16px 的行内根本
 * 分不出「第 3 个箭头」是要挪队列还是要显隐，点下去才发现搞错了对象。
 * 图标换成 SVG 之前这里用的是字符三角 ▾ / ▸，语义本来就是对的：▾ = 点它会收起，
 * ▸ = 点它会展开。换成 svgIcon('up'/'down') 那次改造把语义弄丢了。
 *
 * 本测试钉三件事：
 *   ① 两个折叠点的图标名逐字钉死（展开=chevronDown / 折叠=chevronRight）；
 *   ② 展开态用的那个图标，**不是**上移/下移/置顶里任何一个（撞车即红）；
 *   ③ svgIcon 的每个调用点引用的键都必须真实存在于 DL_ICONS 表里
 *      （svgIcon 对未知名字静默返回空串 → 图标整个消失，界面上只留一个空按钮，
 *       这条钉是防下一次加图标时打错字）。
 *
 * 静态扫描：download.js 是渲染层，仓库无 jsdom，既有接线钉（queue-group.test.js /
 * failure-tag.test.js）一律走源码文本。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DL_JS = fs.readFileSync(path.join(ROOT, 'src/renderer/js/views/download.js'), 'utf8');

/** 取 DL_ICONS 常量表：键 → SVG 片段 */
function dlIcons() {
  const at = DL_JS.indexOf('const DL_ICONS = {');
  assert.ok(at > -1, 'DL_ICONS 表不见了（图标被挪走或改名）');
  const end = DL_JS.indexOf('\n};', at);
  assert.ok(end > at, 'DL_ICONS 表没有闭合');
  const body = DL_JS.slice(at, end);
  const out = {};
  for (const m of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*('[\s\S]*?')\s*,?\s*$/gm)) {
    out[m[1]] = m[2].slice(1, -1);
  }
  return out;
}

const ICONS = dlIcons();

/** 取某个调用点所在的整行（两处折叠点各占一行，行内模板一眼能看完） */
function lineOf(needle) {
  const line = DL_JS.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `download.js 里找不到 ${needle}`);
  return line;
}

/** svgIcon/menuIcon 的实参里出现的全部字符串字面量（三元也一并取到） */
function iconArgsIn(src, fnName) {
  const args = [];
  const re = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { args.push(src.slice(m.index + m[0].length, i)); break; } }
    }
  }
  return args.flatMap((a) => [...a.matchAll(/'([^']*)'/g)].map((x) => x[1]));
}

// ── ① 两处折叠点的图标名逐字钉死 ──────────────────────

test('行详情折叠：展开态用 chevronDown、折叠态用 chevronRight（title 与图标同向）', () => {
  const line = lineOf('class="queue-detail-toggle"');
  assert.ok(
    line.includes("svgIcon(isExpanded ? 'chevronDown' : 'chevronRight')"),
    `展开态应显示「点它会收起」的向下三角，折叠态应显示「点它会展开」的向右三角；实得：${line.trim()}`
  );
  // 反向钉：曾错用 up/down（与 title 相反，且与同行的上移/下移按钮同款）
  assert.doesNotMatch(line, /svgIcon\(isExpanded \? '(up|down)'/, '展开/折叠不许再用队列重排的上移/下移箭头');
});

test('平台分组折叠：折叠态用 chevronRight、展开态用 chevronDown（与行详情同一对）', () => {
  const line = lineOf('class="queue-group-fold"');
  assert.ok(
    line.includes("svgIcon(collapsed ? 'chevronRight' : 'chevronDown')"),
    `折叠态应显示向右三角（点它会展开），展开态应显示向下三角（点它会收起）；实得：${line.trim()}`
  );
  assert.doesNotMatch(line, /svgIcon\(collapsed \? '(up|down)'/, '分组折叠不许再用队列重排的上移/下移箭头');
});

// ── ② 展开态图标 ≠ 上移箭头（本次缺陷的正题）──────────

test('展开态的图标与上移/下移/置顶三个重排图标**逐字不同**（撞车即红）', () => {
  const detail = lineOf('class="queue-detail-toggle"');
  // 只认 svgIcon 那一处三元：title 里也有 `isExpanded ? …`，按它取会取到中文标题上
  const pair = detail.match(/svgIcon\(isExpanded \? '([^']+)' : '([^']+)'\)/);
  assert.ok(pair, `行详情那枚按钮的图标三元没解析出来：${detail.trim()}`);
  const expandedIcon = ICONS[pair[1]];
  const collapsedIcon = ICONS[pair[2]];
  assert.ok(expandedIcon && collapsedIcon, '折叠三角必须在 DL_ICONS 里有实体（否则 svgIcon 静默返回空串）');
  for (const [name, svg] of [['up', ICONS.up], ['down', ICONS.down], ['top', ICONS.top]]) {
    assert.notStrictEqual(expandedIcon, svg, `展开态图标与 ${name} 撞车：同一行里点它干的是另一件事`);
    assert.notStrictEqual(collapsedIcon, svg, `折叠态图标与 ${name} 撞车`);
  }
});

test('chevron 形状上就与重排箭头不同：没有竖杆、没有底横线（不只是换了名字）', () => {
  // up/down 的骨架是「竖杆 + 箭头 + 底横线」（M12 21V9 / M4 4h16 / M4 20h16），
  // chevron 只有一个角。形状区分是这道修复的真正目的，改名不算数。
  for (const k of ['chevronDown', 'chevronRight']) {
    const d = ICONS[k];
    assert.ok(d, `DL_ICONS 缺 ${k}`);
    assert.doesNotMatch(d, /[Vv]\s*-?\d/, `${k} 出现了竖杆命令，与上移/下移箭头同形`);
    assert.doesNotMatch(d, /h\s*16\b/, `${k} 出现了底横线，与上移/下移箭头同形`);
    assert.doesNotMatch(d, /M12\s+(3|21)/, `${k} 用了重排箭头的竖杆起点`);
  }
  // 反向钉：两枚 chevron 方向不同（一个是角向下、一个角向右）
  assert.notStrictEqual(ICONS.chevronDown, ICONS.chevronRight, '折叠/展开两个状态画了同一个图标');
});

// ── ③ 调用点的键必须真实存在（svgIcon 对未知键静默返回空串）──

test('svgIcon/menuIcon 的每个调用点引用的键都在 DL_ICONS 表里（打错字 = 按钮空着）', () => {
  const used = new Set([
    ...iconArgsIn(DL_JS, 'svgIcon'),
    ...iconArgsIn(DL_JS, 'menuIcon'),
  ]);
  assert.ok(used.size >= 10, `调用点只认出 ${used.size} 个图标名，取参逻辑多半坏了`);
  const missing = [...used].filter((k) => !(k in ICONS));
  assert.deepEqual(missing, [], `这些图标名不在 DL_ICONS 表里，svgIcon 会静默返回空串：${missing.join(', ')}`);
});

test('自检：DL_ICONS 至少含折叠/重排两族共 5 个键（防本测试自己瞎绿）', () => {
  for (const k of ['up', 'down', 'top', 'chevronDown', 'chevronRight']) {
    assert.ok(k in ICONS, `DL_ICONS 缺 ${k}`);
  }
  // svgIcon 对未知名字是 `DL_ICONS[name] || ''` —— 空串会让 <svg> 变成 0 内容元素。
  // 上面那条「调用点键都存在」只有在真能取到表内容时才有意义，这里钉住取表本身。
  assert.ok(Object.keys(ICONS).length >= 16, `DL_ICONS 只解析出 ${Object.keys(ICONS).length} 个键，解析口径坏了`);
});
