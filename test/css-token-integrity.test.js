/**
 * CSS 设计令牌完整性门禁（2026-10-13）
 *
 * ── 症状（实测，非猜测）─────────────────────────────────────────
 * `var(--x)` 引用了一个从未定义的变量时，CSS **不报错**：整条声明失效，
 * 属性掉回继承值或初始值。所以这类错误在代码评审里看不见，只在屏幕上
 * 表现为「这块怎么没背景 / 这条分隔线去哪了」。
 *
 * 本仓实测有 38 处这样的引用：
 *   · --surface-1 ×33 / --surface-2 ×5：content.css 与 overlays.css 的卡片背景
 *     ⇒ background 整条失效，卡片是**透明**的。content.css:569 的注释里其实
 *     早就记过这个坑（「曾误写 var(--surface-2)，实测 getComputedStyle 得
 *     rgba(0,0,0,0)」），当时只把 .source-badge 一处改对了，其余 38 处没跟。
 *     深色默认主题下「透明」看着跟深色底差不多，于是拖到现在；
 *     切到浅色主题，这些卡片就彻底没有表面层次了。
 *   · --border-subtle / --line / --border-color：分隔线整条失效
 *     ⇒ 本地库与歌单回收站的行间分隔线一直不存在。
 *   · --text-primary / --text-secondary：文字色失效
 *     ⇒ 本地库的「艺术家」行与标题同色，文字层级丢了一档。
 *   · --bg-elevated / --bg-overlay / --bg-secondary / --bg-primary：更新提示、
 *     歌词编辑器写死了深色 fallback ⇒ 浅色主题下是突兀的深色块。
 *
 * ── 为什么钉成门禁 ────────────────────────────────────────────
 * 与 test/diagnose-coverage.test.js 同一套路：令牌这类错误是**静默**的，
 * 靠人眼在 4800 行 CSS 里盯不回来。定义与引用都在同一个文件系统里，
 * 机械比对是唯一可靠的办法 —— 以后谁再写错令牌名，这里直接红。
 *
 * 扫描面刻意包含 JS：内联样式（el.style.cssText / 模板串里的 style="…"）
 * 同样会引用令牌，而且它连 CSS 语法高亮都享受不到，最容易写错。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');

function collectFiles() {
  const out = [];
  const styles = path.join(RENDERER, 'styles');
  for (const n of fs.readdirSync(styles)) {
    if (n.endsWith('.css')) out.push(path.join(styles, n));
  }
  for (const n of ['index.html', 'mini-player.html', 'desktop-lyric.html']) {
    out.push(path.join(RENDERER, n));
  }
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) out.push(p);
    }
  })(path.join(RENDERER, 'js'));
  return out;
}

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 令牌定义处 → 文件行号；引用处 → 文件行号 */
function scan() {
  const defs = new Map();
  const refs = new Map();
  for (const f of collectFiles()) {
    const rel = path.relative(ROOT, f);
    read(f).split('\n').forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      for (const m of line.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
        if (!defs.has(m[1])) defs.set(m[1], new Set());
        defs.get(m[1]).add(at);
      }
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        if (!refs.has(m[1])) refs.set(m[1], new Set());
        refs.get(m[1]).add(at);
      }
    });
  }
  return { defs, refs };
}

const { defs, refs } = scan();

test('扫描本身要有效：扫到的文件数与令牌数都有下限（门禁不能空转）', () => {
  assert.ok(collectFiles().length >= 100, '扫描面太小，多半是目录路径变了');
  assert.ok(defs.size >= 60, `只扫到 ${defs.size} 个令牌定义，正则可能失效了`);
  // 这几个令牌必须既被定义又被引用，否则说明扫描规则漏了一半
  for (const must of ['--accent-ui', '--elev-1', '--stroke-1', '--fg-1']) {
    assert.ok(defs.has(must), `扫描漏了 ${must} 的定义`);
    assert.ok(refs.has(must), `扫描漏了 ${must} 的引用（门禁会假绿）`);
  }
});

test('每个被引用的令牌都必须有定义（幽灵令牌 ⇒ 整条声明静默失效）', () => {
  const ghost = [...refs.keys()]
    .filter((v) => !defs.has(v))
    .sort()
    .map((v) => `${v}  ×${refs.get(v).size}  ${[...refs.get(v)].slice(0, 3).join(', ')}`);
  assert.deepStrictEqual(ghost, [],
    `以下令牌只被引用、从未定义 —— CSS 不报错，只是让那条样式悄悄消失：\n  ${ghost.join('\n  ')}`);
});

/**
 * 主题块的契约：这 8 个令牌是「一套配色」的最低限度。
 * 缺一个 ⇒ 那一套主题里该部位掉回 :root 的默认值，
 * 也就是 base.css 开头警告过的「切主题时只有一半界面在变色」。
 */
const CORE_THEME_TOKENS = [
  '--bg-deep', '--bg-card', '--bg-hover', '--bg-input', '--border',
  '--text', '--accent', '--neon-cyan', '--neon-red', '--neon-orange', '--neon-yellow',
];

function themeBlocks() {
  const src = read(path.join(RENDERER, 'styles/base.css'));
  const blocks = [];
  const re = /(^|\n)\s*(:root|\[data-theme="[a-z]+"\])\s*\{([\s\S]*?)\n\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const props = new Set();
    for (const p of m[3].matchAll(/(--[a-z0-9-]+)\s*:/gi)) props.add(p[1]);
    blocks.push({ name: m[2].trim(), props });
  }
  return blocks;
}

const BLOCKS = themeBlocks();

// base.css 的注释里多处写「7 套主题」，实测只有 :root + 5 套 data-theme
// （light / cyber / aurora / sunset / forest）—— 那是历史口径留下的旧说法，
// 门禁按实际解析到的数量断言，别让注释把断言带偏。
test('解析要有效：拿到默认 + 5 套主题（共 6 块）', () => {
  assert.ok(BLOCKS.length >= 6, `只解析出 ${BLOCKS.length} 个主题块：${BLOCKS.map((b) => b.name).join(', ')}`);
  assert.ok(BLOCKS.some((b) => b.name === ':root'), '解析漏了 :root');
  for (const t of ['light', 'cyber', 'aurora', 'sunset', 'forest']) {
    assert.ok(BLOCKS.some((b) => b.name.includes(t)), `解析漏了主题 ${t}`);
  }
});

/**
 * 尺寸刻度的收口：圆角与间距必须走 --r-* / --sp-*，不许再写死 px。
 *
 * 2026-10-13 实测：这两个属性上一共 291 处写死值，横跨 4/6/8/10/12/14/16/20px
 * 好几个档 —— 同一个界面里圆角有 5 种、间距有 6 种，是"看着不够规整"的主因，
 * 而且想整体调一档圆角得改上百处。现在全部收到 --r-xs/sm/md/lg/xl 与
 * --sp-1..8 两级刻度上：以后调整体风格只改 base.css 里那一行值。
 *
 * 只钉这两个属性是刻意的：它们不改变盒模型尺寸、不会引起文本换行，
 * 是唯一能安全"对齐"的维度（padding 会撑盒子、font-size 会引起换行/截断，
 * 那两类要改就得逐个目视确认，不在这条门禁的射程内）。
 *
 * gap 的 1px/2px 放行：那是"紧密排列"语义（history-list、均衡器滑块），
 * 拉到 4px 会把列表撑高、可能让均衡器溢出 —— 刻度表达不了"紧密"。
 */
const SIZE_FILES = collectFiles().filter(
  (f) => f.endsWith('.css') && !f.endsWith(path.join('styles', 'base.css')),
);

function hardcodedSize(prop, allowed = new Set()) {
  const bad = [];
  for (const f of SIZE_FILES) {
    const rel = path.relative(ROOT, f);
    read(f).split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\//g, '');
      const re = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        // 先剥掉 var(...)：fallback 里的 px（如 var(--r-md, 8px)）是防御性的，
        // 令牌在时它根本不生效，不算"写死"。
        const val = m[1].replace(/var\([^)]*\)/g, '');
        for (const num of val.matchAll(/(\d+(?:\.\d+)?)px/g)) {
          if (!allowed.has(Number(num[1]))) bad.push(`${rel}:${i + 1}  ${prop}:${m[1].trim()}`);
        }
      }
    });
  }
  return bad;
}

test('圆角一律走 --r-* 刻度（写死 px ⇒ 圆角档位重新发散）', () => {
  const bad = hardcodedSize('border-radius');
  assert.deepStrictEqual(bad, [], `以下圆角仍是写死 px：\n  ${bad.join('\n  ')}`);
});

test('间距一律走 --sp-* 刻度（只有 1px/2px 的"紧密"语义可例外）', () => {
  const bad = hardcodedSize('gap', new Set([1, 2]))
    .concat(hardcodedSize('row-gap', new Set([1, 2])))
    .concat(hardcodedSize('column-gap', new Set([1, 2])));
  assert.deepStrictEqual(bad, [], `以下间距仍是写死 px：\n  ${bad.join('\n  ')}`);
});

/**
 * 色值收口：样式表里不许再写死色值，一律走令牌。
 *
 * 与尺寸那条同理 —— 只是色值的后果更直观：写死的 `rgba(255,255,255,.05)`
 * 分隔线在浅色主题下是"白底上的白线"，等于不存在；写死的 `rgba(0,0,0,.7)`
 * 弹层遮罩在浅色主题下是一层纯黑压在白界面上。
 *
 * 只管 CSS，不管 JS/HTML 内联样式：后者有几类**本就该写死**的色 ——
 *   · 主题选择卡片的预览色卡（要展示各主题的真实配色）
 *   · AI 曲风色板（流行=粉/摇滚=红…是分类语义，不是主题色）
 *   · 桌面歌词窗口（独立窗口浮在桌面上，有自己的配色契约）
 * 机械断言分不清这些，强行收口会损坏功能，故不纳入。
 */
const COLOR_ALLOW = new Set(['#e5484d']);   // 窗口关闭按钮：窗口管理器的约定色

function hardcodedColor() {
  const bad = [];
  for (const f of SIZE_FILES) {
    // 先剥跨行块注释：content.css:571 那种注释里引用旧色值的说明文字不能算违规
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\([^)]*\)/g, '');
    const rel = path.relative(ROOT, f);
    src.split('\n').forEach((line, i) => {
      const found = [
        ...[...line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]),
        ...[...line.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0]),
      ];
      const keep = found.filter(
        (v) => !/^(#fff|#000|#ffffff|#000000|transparent|currentColor|white|black)$/i.test(v)
          && !COLOR_ALLOW.has(v.toLowerCase()),
      );
      if (keep.length) bad.push(`${rel}:${i + 1}  ${keep.join(' ')}  ${line.trim().slice(0, 90)}`);
    });
  }
  return bad;
}

test('样式表里的色值一律走令牌（写死 ⇒ 换主题时那一块不变色）', () => {
  const bad = hardcodedColor();
  assert.deepStrictEqual(bad, [], `以下样式仍写死色值：\n  ${bad.join('\n  ')}`);
});

/**
 * 交互反馈收口：凡声明 `cursor: pointer` 的元素，必须有 hover/active/focus-visible 之一。
 *
 * `cursor: pointer` 是作者对"这里可以点"的显式声明；没有对应反馈，用户把鼠标
 * 移上去毫无变化，只能靠试才知道能点 —— 2026-10-13 实测 117 个可点元素里有
 * 23 个属于这种"沉默的可点"，其中歌词行（点它跳播）最典型：只有 cursor:pointer，
 * 悬停时连个字色变化都没有。
 *
 * 例外（原生控件自带反馈，或热区所在的整行已有 hover，再叠一层反而吵）：
 *   · range 滑块的 thumb —— 拖拽本身就是反馈
 *   · checkbox 及其容器 —— 有 :checked 态与 accent-color，且所在行（.song-row /
 *     .local-row / .queue-item）已带 hover
 *   · 裸 button —— 实际由 .btn 等修饰类接管
 */
const FEEDBACK_EXEMPT = /slider|range|volume|checkbox|input|thumb/i;

function clickableWithoutFeedback() {
  const clickable = new Map();
  const feedback = new Set();
  for (const f of collectFiles().filter((p) => p.endsWith('.css'))) {
    const src = read(f);
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!sel || sel.startsWith('@')) continue;
      if (/cursor\s*:\s*pointer/.test(m[2])) {
        for (const part of sel.split(',')) { const s = part.trim(); if (s) clickable.set(s, f); }
      }
      if (/:(hover|active|focus-visible)\b/.test(sel)) {
        for (const part of sel.split(',')) {
          const base = part.trim().replace(/:(hover|active|focus-visible).*$/, '').trim();
          if (base) feedback.add(base);
        }
      }
    }
  }
  // 包含匹配：`.conv-btn-blue:hover` 是 `.conv-btn` 的修饰类反馈，
  // 精确比对会把"基类有 cursor、修饰类有 hover"误报成缺口。
  const has = (sel) => [...feedback].some((f) => f === sel || f.includes(sel) || sel.includes(f));
  return [...clickable.keys()]
    .filter((sel) => !has(sel) && !FEEDBACK_EXEMPT.test(sel) && sel !== 'button')
    .map((sel) => `${sel}   (${path.relative(ROOT, clickable.get(sel))})`);
}

test('可点元素必须有 hover/active/focus-visible 反馈（不然用户看不出能点）', () => {
  const bad = clickableWithoutFeedback();
  assert.deepStrictEqual(bad, [], `以下元素声明了 cursor:pointer 却无任何交互反馈：\n  ${bad.join('\n  ')}`);
});

test('每套主题都定义了完整的核心令牌（缺一个 ⇒ 那个部位不跟着换主题）', () => {
  const missing = [];
  for (const b of BLOCKS) {
    const lack = CORE_THEME_TOKENS.filter((t) => !b.props.has(t));
    if (lack.length) missing.push(`${b.name} 缺 ${lack.join(' ')}`);
  }
  assert.deepStrictEqual(missing, [], `主题令牌不全：\n  ${missing.join('\n  ')}`);
});
