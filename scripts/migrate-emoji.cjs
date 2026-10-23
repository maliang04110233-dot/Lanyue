/**
 * migrate-emoji.cjs —— 把 index.html 里的界面 emoji 换成语义图标
 *
 * ── 为什么需要脚本而不是手工改 ─────────────────────────────────
 * 151 处 emoji 散在 1600 行 HTML 的 60 多个标签上，手工改会漏、会错位。
 *
 * ── 算法：按标签切段，单遍重建 ─────────────────────────────────
 * 第一版实现用「从右往左 + 缓存索引」，遇到一行两个 emoji（如「🗂 分组 ▾」）
 * 就错位：处理右边那个会改变字符串长度，左边那个的缓存索引随即失效，
 * 结果是 emoji 没删掉、data-ico 加到了错的位置。
 *
 * 现方案把每一行拆成 [标签 | 文本 | 标签 | 文本 …]，用栈维护"当前在谁的
 * 文本区里"，对每个文本段：
 *   ① 找第一个可映射的 emoji → 给当前开始标签加 data-ico
 *   ② 删掉该文本段里所有 emoji（以及紧随的一个空格）
 *   ③ 删除后文本全空 → 加 data-ico-only（纯图标容器，不要右侧间距）
 * 一次遍历，没有索引漂移。
 *
 * ── 刻意跳过（都有理由）──────────────────────────────────────
 *   · <kbd> 里的 ← → ↑ ↓：键盘键位的文字表示，不是图标
 *   · 整行 HTML 注释：用户看不到
 *   · 已经在 data-ico 元素里的 emoji：说明这里有多个语义（如专辑筛选
 *     按钮里的 ✕），保留原文由人决定
 *
 * 用法：
 *   node scripts/migrate-emoji.cjs           # 预览
 *   node scripts/migrate-emoji.cjs --write   # 写入
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'renderer', 'index.html');
const WRITE = process.argv.includes('--write');

/* emoji → 图标名。带 VS16 的组合放最前面，让最长匹配优先。 */
const MAP = [
  ['⬇️', 'download'], ['🖼️', 'image'], ['✏️', 'pencil'], ['⚙️', 'settings'],
  ['⚠️', 'alert'], ['⏱️', 'clock'], ['❤️', 'heart'],
  ['🔍', 'search'], ['⬇', 'download'], ['🗑', 'trash'], ['✓', 'check'],
  ['☑', 'check-square'], ['🔄', 'refresh'], ['📋', 'list'], ['🎼', 'music-list'],
  ['🎵', 'music'], ['💿', 'disc'], ['🎤', 'mic'], ['✨', 'sparkle'],
  ['▶', 'play'], ['♥', 'heart'], ['📊', 'chart'], ['📥', 'import'],
  ['📂', 'folder-open'], ['🎯', 'target'], ['📜', 'history'], ['🧹', 'dedupe'],
  ['💾', 'save'], ['❌', 'x-circle'], ['🗂', 'folder-tree'], ['🖼', 'image'],
  ['🧬', 'dna'], ['✏', 'pencil'], ['⚙', 'settings'], ['⚠', 'alert'],
  ['🙈', 'eye-off'], ['⚡', 'zap'], ['🎞', 'film'], ['🧪', 'flask'],
  ['🏷', 'tag'], ['🧰', 'toolbox'], ['🔬', 'microscope'], ['📝', 'note'],
  ['🏁', 'flag'], ['🧩', 'puzzle'], ['🩹', 'bandage'], ['📤', 'export'],
  ['🔁', 'repeat'], ['🤖', 'robot'], ['🧮', 'calculator'], ['📡', 'antenna'],
  ['📖', 'book'], ['📀', 'disc'], ['➕', 'plus'], ['✕', 'x'],
  ['◈', 'user'], ['◐', 'palette'], ['▷', 'play-circle'], ['↕', 'sort'],
  ['▾', 'chevron-down'], ['▦', 'grid'], ['↓', 'download'], ['↑', 'upload'],
  ['⏱', 'clock'], ['⏰', 'clock'], ['🔽', 'chevron-down'],
];

const ALL = MAP.map(([e]) => e);
const iconOf = (e) => (MAP.find(([x]) => x === e) || [])[1];

/** 同一位置可能同时匹配 '⬇️'(含VS16) 与 '⬇'，只保留最长的那个 */
function findEmoji(s) {
  const byPos = new Map();
  for (const e of ALL) {
    let i = -1;
    while ((i = s.indexOf(e, i + 1)) !== -1) {
      const prev = byPos.get(i);
      if (!prev || e.length > prev.e.length) byPos.set(i, { i, e });
    }
  }
  return [...byPos.values()].sort((a, b) => a.i - b.i);
}

/** 删除所有 emoji，并吃掉紧随的一个空格（避免" 搜索"留下前导空格） */
function stripEmoji(s) {
  let out = s;
  for (let guard = 0; guard < 100; guard++) {
    const hits = findEmoji(out);
    if (!hits.length) break;
    const { i, e } = hits[hits.length - 1];
    const after = out[i + e.length] === ' ' ? e.length + 1 : e.length;
    out = out.slice(0, i) + out.slice(i + after);
  }
  return out;
}

const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line', 'use', 'stop']);

function processLine(line) {
  if (!findEmoji(line).length) return line;
  if (line.trim().startsWith('<!--')) return line;

  /* 拆成 tag / text 段 */
  const parts = [];
  let last = 0, m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(line))) {
    if (m.index > last) parts.push({ type: 'text', text: line.slice(last, m.index) });
    parts.push({
      type: 'tag',
      text: m[0],
      name: m[1].toLowerCase(),
      closing: m[0][1] === '/',
      selfClose: m[0].endsWith('/>'),
      attrs: m[2],
    });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  if (!parts.some((p) => p.type === 'tag')) return line;

  const stack = [];
  const log = [];
  let changed = false;

  for (const p of parts) {
    if (p.type === 'tag') {
      if (p.closing) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === p.name) { stack.length = k; break; }
        }
      } else if (!p.selfClose && !VOID.has(p.name)) {
        stack.push(p);
      }
      /* 属性值里的 emoji（placeholder / title）：伪元素在属性里无效，直接删字符 */
      if (findEmoji(p.attrs).length) {
        const before = p.text;
        p.attrs = stripEmoji(p.attrs);
        p.text = `<${p.closing ? '/' : ''}${p.name}${p.attrs}>`;
        if (p.text !== before) { changed = true; log.push('strip-attr'); }
      }
      continue;
    }

    const hits = findEmoji(p.text);
    if (!hits.length) continue;

    const owner = stack[stack.length - 1];
    if (owner && owner.name === 'kbd') continue;          // 键位说明保留
    if (owner && owner.attrs.includes('data-ico=')) continue; // 多语义，留给人决定

    const mappable = hits.find((h) => iconOf(h.e));

    if (owner && mappable) {
      const name = iconOf(mappable.e);
      p.text = stripEmoji(p.text);
      const plain = p.text.replace(/\s+/g, ' ').trim();
      const only = plain === '';
      owner.attrs += ` data-ico="${name}"${only ? ' data-ico-only' : ''}`;
      owner.text = `<${owner.name}${owner.attrs}>`;
      changed = true;
      log.push(`data-ico="${name}"${only ? ' only' : ''}`);
    } else {
      p.text = stripEmoji(p.text);
      changed = true;
      log.push('strip-orphan');
    }
  }

  if (!changed) return line;
  const result = parts.map((p) => p.text).join('');
  return { result, log };
}

const src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

/* script 块整体跳过：里面的 showToast('❌ …') 是 JS 兜底文案，单独处理 */
let inScript = false;
let count = 0;
const stats = {};

const out = lines.map((line, idx) => {
  const t = line.trim();
  if (inScript) { if (t.includes('</script>')) inScript = false; return line; }
  if (t.startsWith('<script')) { if (!t.includes('</script>')) inScript = true; return line; }

  const r = processLine(line);
  if (typeof r === 'string') return r;
  count += 1;
  for (const a of r.log) stats[a] = (stats[a] || 0) + 1;
  if (WRITE && count <= 200) { /* 逐行替换由下面统一写盘 */ }
  void idx;
  return r.result;
});

console.log(`处理 ${count} 行，${Object.values(stats).reduce((a, b) => a + b, 0)} 个动作`);
console.log(Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k} ×${v}`).join('\n'));

if (WRITE) {
  fs.writeFileSync(FILE, out.join('\n'), 'utf8');
  console.log(`已写入 ${path.relative(ROOT, FILE)}`);
} else {
  console.log('\n（预览模式，未改文件。加 --write 生效）');
}
