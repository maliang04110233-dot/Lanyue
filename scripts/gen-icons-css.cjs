/**
 * gen-icons-css.cjs — 生成 src/renderer/styles/icons.css
 *
 * ── 为什么图标要单独一个 CSS 文件，而不是内联 SVG ──────────────
 * i18n 的 applyTranslations()（js/i18n.js:58）**只对 children.length === 0
 * 的节点写 textContent**，这是为了保护设置页 3 个内嵌 <code> 的提示框。
 * 因此凡是带 data-i18n 的按钮，一旦往里插一个 <svg> 子节点，这个按钮就
 * 再也不会被翻译 —— 中文界面切英文后，按钮文字原地不动。
 *
 * 实测 index.html 里 60% 的 emoji 都长在 data-i18n 元素里。所以图标位
 * 一律用 **CSS 伪元素 + mask**：伪元素不进 DOM 树，children.length 仍是 0，
 * 翻译链路完全不受影响，textContent 断言也一字不变。
 *
 * mask 而不是 background-image 的原因：mask 让图标走 background-color:
 * currentColor，于是图标颜色自动跟随文字色（hover / active / 禁用态全都
 * 不用另写规则）；background-image 会把颜色烤死在 SVG 里，切主题就废了。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   <button data-i18n="download.clearDone" data-ico="trash">清空已完成</button>
 *
 * 纯图标容器（无文字）用 data-ico + data-ico-only 去掉右侧间距：
 *   <span class="stat-icon" data-ico="music" data-ico-only></span>
 *
 * ── 重新生成 ─────────────────────────────────────────────────
 *   node scripts/gen-icons-css.cjs
 *
 * 图标规格：24×24 viewBox，stroke-width 1.75，round cap/join，纯描边无填充
 * （play / heart / sparkle 三个是实心，因为它们在 24px 下描边会糊成一团）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'styles', 'icons.css');

/* 路径数据用单引号，输出时不用再转义双引号 */
const ICONS = {
  /* ── 导航与检索 ─────────────────────────────────── */
  search: "<circle cx='11' cy='11' r='7'/><path d='M16.5 16.5 21 21'/>",
  filter: "<path d='M3 5h18l-7 8v6l-4 2v-8z'/>",
  sort: "<path d='M8 4v16M5 17l3 3 3-3M16 20V4M13 7l3-3 3 3'/>",
  'chevron-down': "<path d='M6 9l6 6 6-6'/>",
  grid: "<rect x='3' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='3' width='7' height='7' rx='1.5'/><rect x='3' y='14' width='7' height='7' rx='1.5'/><rect x='14' y='14' width='7' height='7' rx='1.5'/>",
  list: "<path d='M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'/>",
  target: "<circle cx='12' cy='12' r='8'/><circle cx='12' cy='12' r='3'/>",
  'eye-off': "<path d='M3 3l18 18'/><path d='M10.6 6.2A9 9 0 0 1 21 12a17 17 0 0 1-2.1 2.7'/><path d='M6.3 8.3A17 17 0 0 0 3 12a9 9 0 0 0 12.7 4.9'/>",

  /* ── 传输与文件 ─────────────────────────────────── */
  download: "<path d='M12 3v12M7 11l5 5 5-5M4 20h16'/>",
  upload: "<path d='M12 16V4M8 8l4-4 4 4M4 20h16'/>",
  import: "<path d='M12 3v10M8 9l4 4 4-4'/><path d='M4 16v4h16v-4'/>",
  export: "<path d='M12 14V3M8 7l4-4 4 4'/><path d='M4 16v4h16v-4'/>",
  folder: "<path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>",
  'folder-open': "<path d='M3 8V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1'/><path d='M3 8h18l-2 10a2 2 0 0 1-2 1.6H5.6A2 2 0 0 1 3.6 18z'/>",
  'folder-tree': "<rect x='3' y='3' width='6' height='5' rx='1'/><rect x='3' y='16' width='6' height='5' rx='1'/><rect x='15' y='9' width='6' height='5' rx='1'/><path d='M6 8v8M15 11.5H9'/>",
  save: "<path d='M5 3h11l3 3v15H5z'/><path d='M8 3v6h7V3'/><rect x='8' y='13' width='8' height='8' rx='1'/>",
  trash: "<path d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/>",
  refresh: "<path d='M20 12a8 8 0 1 1-2.3-5.6'/><path d='M20 4v4h-4'/>",
  repeat: "<path d='M17 2l4 4-4 4M21 6H8a5 5 0 0 0-5 5M7 22l-4-4 4-4M3 18h13a5 5 0 0 0 5-5'/>",
  'x-circle': "<circle cx='12' cy='12' r='9'/><path d='M9 9l6 6M15 9l-6 6'/>",
  'check-square': "<rect x='3' y='3' width='18' height='18' rx='3'/><path d='M8 12l3 3 5-6'/>",
  check: "<path d='M4 12l5 5L20 6'/>",
  x: "<path d='M6 6l12 12M18 6L6 18'/>",
  plus: "<path d='M12 5v14M5 12h14'/>",
  minus: "<path d='M5 12h14'/>",

  /* ── 媒体 ───────────────────────────────────────── */
  play: "<path d='M7 4.5v15l13-7.5z' fill='currentColor' stroke='none'/>",
  pause: "<rect x='6' y='4' width='4' height='16' rx='1' fill='currentColor' stroke='none'/><rect x='14' y='4' width='4' height='16' rx='1' fill='currentColor' stroke='none'/>",
  'play-circle': "<circle cx='12' cy='12' r='9'/><path d='M10 8.5l6 3.5-6 3.5z' fill='currentColor' stroke='none'/>",
  music: "<path d='M9 18V5l10-2v13'/><circle cx='6.5' cy='18' r='2.5'/><circle cx='16.5' cy='16' r='2.5'/>",
  disc: "<circle cx='12' cy='12' r='9'/><circle cx='12' cy='12' r='2.5'/>",
  mic: "<rect x='9' y='2' width='6' height='11' rx='3'/><path d='M5 11a7 7 0 0 0 14 0M12 18v3'/>",
  heart: "<path d='M12 20.5S4 15.4 4 10.3A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 8 2.7c0 5.1-8 10.2-8 10.2z' fill='currentColor' stroke='none'/>",
  volume: "<path d='M4 9h4l5-4v14l-5-4H4z'/><path d='M17 8.5a5 5 0 0 1 0 7'/>",
  sparkle: "<path d='M12 3l2.2 6.1L20 11l-5.8 1.9L12 19l-2.2-6.1L4 11l5.8-1.9z' fill='currentColor' stroke='none'/>",
  'music-list': "<path d='M4 6h9M4 12h9M4 18h5'/><path d='M20 7v10'/><circle cx='18' cy='17.5' r='2'/>",

  /* ── 状态与语义 ─────────────────────────────────── */
  alert: "<path d='M12 3l9.5 17H2.5z'/><path d='M12 9v5M12 17.2h.01'/>",
  info: "<circle cx='12' cy='12' r='9'/><path d='M12 11v6M12 7.6h.01'/>",
  flame: "<path d='M12 22c4.4 0 7-3 7-7 0-5-7-12-7-12S5 10 5 15c0 4 2.6 7 7 7z'/><path d='M12 18a2.5 2.5 0 0 1 0-5'/>",
  zap: "<path d='M13 2L4 14h7l-1 8 9-12h-7z'/>",
  flag: "<path d='M5 21V4M5 4h11l-2 4 2 4H5'/>",
  shield: "<path d='M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z'/>",
  'bandage': "<path d='M4 20l16-16 4 4L8 24z' /><path d='M11.5 8.5l4 4M8.5 11.5l4 4'/>",

  /* ── 内容与资料 ─────────────────────────────────── */
  image: "<rect x='3' y='4' width='18' height='16' rx='2'/><circle cx='8.5' cy='9.5' r='1.5'/><path d='M21 16l-5-5-6 6'/>",
  note: "<path d='M5 3h9l5 5v13H5z'/><path d='M14 3v5h5M8 13h8M8 17h5'/>",
  pencil: "<path d='M4 20l1-5 11-11 4 4-11 11z'/>",
  tag: "<path d='M3 12V4h8l9 9-8 8z'/><circle cx='7.5' cy='7.5' r='1'/>",
  book: "<path d='M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z'/><path d='M4 5v14'/>",
  chart: "<path d='M4 20V11M10 20V4M16 20v-6M22 20H2'/>",
  calculator: "<rect x='5' y='3' width='14' height='18' rx='2'/><path d='M8 7h8'/><path d='M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01'/>",
  film: "<rect x='3' y='5' width='18' height='14' rx='2'/><path d='M7 5v14M17 5v14M3 10h4M3 15h4M17 10h4M17 15h4'/>",
  flask: "<path d='M9 3h6M10 3v6l-5 9.5A2 2 0 0 0 6.8 21h10.4a2 2 0 0 0 1.8-2.5L14 9V3'/>",
  microscope: "<path d='M9 3h5v8H9z'/><path d='M7.5 12l-2 5M14 12c3 1 4 4 3 6'/><path d='M5 21h14'/>",
  dna: "<path d='M5 3c0 6 14 12 14 18M19 3c0 6-14 12-14 18M7 7h10M7 17h10'/>",
  toolbox: "<rect x='3' y='8' width='18' height='12' rx='2'/><path d='M8 8V5h8v3M3 13h18'/>",
  puzzle: "<path d='M4 9h3a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 0 0-4z'/>",
  antenna: "<path d='M12 8v4'/><circle cx='12' cy='18' r='3'/><path d='M5 5a10 10 0 0 1 14 0M7.5 8a6 6 0 0 1 9 0'/>",
  robot: "<rect x='4' y='7' width='16' height='12' rx='3'/><path d='M12 3v4M2 13h2M20 13h2'/><circle cx='9' cy='13' r='1.3'/><circle cx='15' cy='13' r='1.3'/>",
  history: "<path d='M3 12a9 9 0 1 0 3-6.7'/><path d='M3 4v4h4M12 8v4l3 2'/>",
  settings: "<circle cx='12' cy='12' r='3'/><path d='M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2'/>",
  user: "<circle cx='12' cy='8' r='4'/><path d='M4 21c0-4 4-6.5 8-6.5s8 2.5 8 6.5'/>",
  palette: "<path d='M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a3 3 0 0 0 3-3 9 9 0 0 0-8-7z'/><circle cx='8' cy='9' r='1'/><circle cx='12' cy='7' r='1'/><circle cx='16' cy='9' r='1'/>",
  layers: "<path d='M12 3l9 5-9 5-9-5z'/><path d='M3 13l9 5 9-5'/>",
  sliders: "<path d='M4 8h10M18 8h2M4 16h4M12 16h8'/><circle cx='16' cy='8' r='2'/><circle cx='10' cy='16' r='2'/>",
  /* 去重：两个重叠的卡片 + 一笔划掉，比「垃圾桶」更贴切（去重不删文件） */
  dedupe: "<rect x='3' y='3' width='12' height='12' rx='2'/><path d='M9 21h9a3 3 0 0 0 3-3V9'/><path d='M4 4l16 16'/>",

  /* ── 补充（命令面板需要） ───────────────────────── */
  bell: "<path d='M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z'/><path d='M10 18a2 2 0 0 0 4 0'/>",
  'skip-next': "<path d='M6 4l10 8-10 8z'/><path d='M18 4v16'/>",
  'skip-prev': "<path d='M18 4L8 12l10 8z'/><path d='M6 4v16'/>",
  'trending-up': "<path d='M3 17l6-6 4 4 8-8'/><path d='M15 7h6v6'/>",
  rewind: "<path d='M11 5L4 12l7 7z'/><path d='M20 5l-7 7 7 7z'/>",
  'fast-forward': "<path d='M13 5l7 7-7 7z'/><path d='M4 5l7 7-7 7z'/>",
  scissors: "<circle cx='6' cy='6' r='2.5'/><circle cx='6' cy='18' r='2.5'/><path d='M8 7.5L20 18M8 16.5L20 6'/>",
  share: "<path d='M14 4h6v6'/><path d='M20 4l-9 9'/><path d='M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/>",
  waves: "<path d='M2 9c2-3 4-3 6 0s4 3 6 0 4-3 6 0'/><path d='M2 16c2-3 4-3 6 0s4 3 6 0 4-3 6 0'/>",
  'arrow-right': "<path d='M4 12h16M14 6l6 6-6 6'/>",
  'volume-off': "<path d='M4 9h4l5-4v14l-5-4H4z'/><path d='M17 9l4 6M21 9l-4 6'/>",
  undo: "<path d='M9 14L4 9l5-5'/><path d='M4 9h11a5 5 0 0 1 0 10h-3'/>",
  moon: "<path d='M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'/>",
  stop: "<rect x='5' y='5' width='14' height='14' rx='2'/>",
  link: "<path d='M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1'/><path d='M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'/>",
  ban: "<circle cx='12' cy='12' r='9'/><path d='M5.6 5.6l12.8 12.8'/>",
  cast: "<path d='M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5'/><path d='M3 10v3M3 17v1'/><path d='M6 21a3 3 0 0 0-3-3'/>",
};

/* play / pause / heart / sparkle 用了 fill + stroke='none'。
   mask 只取 alpha 通道，颜色本身不重要，但必须是不透明色 —— 所以
   currentColor 换成 black（不能用 %23 预编码，否则下一步会二次编码成
   %2523000，整块图标消失）。 */
function normalize(body) {
  return body.replace(/fill='currentColor'/g, "fill='black'");
}

function toDataUri(body) {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
    "stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'>" +
    normalize(body) +
    '</svg>';
  // 只编码必须编码的三个字符，其余保持可读，便于人工 diff
  const encoded = svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
  return `data:image/svg+xml,${encoded}`;
}

const header = `/* ══════════════════════════════════════════════════════════════════
   icons.css · 线性图标集（由 scripts/gen-icons-css.cjs 生成，勿手改）
   ──────────────────────────────────────────────────────────────────
   规格：24×24 viewBox / stroke-width 1.75 / round cap+join

   为什么是 CSS mask 伪元素，而不是内联 <svg>：
     i18n 的 applyTranslations() 只对 children.length === 0 的节点写
     textContent（保护设置页内嵌 <code> 的提示框）。凡是带 data-i18n 的
     按钮，一旦插入 <svg> 子节点就再也不被翻译 —— 切英文时按钮文字原地
     不动。伪元素不进 DOM 树，children.length 仍是 0，翻译链路零影响。

   为什么是 mask 而不是 background-image：
     mask 让图标走 background-color: currentColor，颜色自动跟随文字
     （hover / active / 禁用 / 主色激活态都不用另写规则）。background-image
     会把颜色烤进 SVG，切主题就废。

   用法：
     <button data-i18n="download.clearDone" data-ico="trash">清空已完成</button>
     <span class="stat-icon" data-ico="music" data-ico-only></span>   ← 纯图标

   重新生成：node scripts/gen-icons-css.cjs
   ══════════════════════════════════════════════════════════════════ */

/* ── 基类 ────────────────────────────────────────────────────────
   1em 见方 —— 图标随字号缩放，不需要每个上下文单独指定尺寸。
   vertical-align: -.14em 是让图标视觉中线与汉字中心对齐的经验值
   （纯 -.125em 在大字号下会偏高）。
   margin-inline-end 给「图标 + 文字」的按钮用；纯图标容器加
   data-ico-only 去掉它，否则容器内会多出一段空白。 */
[data-ico]::before {
  content: "";
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: none;
  background-color: currentColor;
  -webkit-mask-image: var(--ico);
  mask-image: var(--ico);
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  vertical-align: -.14em;
  margin-inline-end: .35em;
}
[data-ico][data-ico-only]::before { margin-inline-end: 0; }

/* 纯图标容器（统计卡 / 空态 / 封面占位）：图标要按容器字号放大，
   并且不能再被当成行内字符影响行高。 */
.stat-icon[data-ico]::before,
.empty-icon[data-ico]::before,
.conv-header-icon[data-ico]::before,
.edit-cover-preview[data-ico]::before,
.nav-icon[data-ico]::before {
  display: block;
  width: 1em;
  height: 1em;
  margin: 0;
}

`;

const rules = Object.entries(ICONS)
  .map(([name, body]) => `[data-ico="${name}"] { --ico: url("${toDataUri(body)}"); }`)
  .join('\n');

fs.writeFileSync(OUT, header + '/* ── 图标定义 ────────────────────────────────────────────────── */\n' + rules + '\n', 'utf8');

const bytes = fs.statSync(OUT).size;
console.log(`[gen-icons-css] ${Object.keys(ICONS).length} 个图标 → ${path.relative(ROOT, OUT)} (${(bytes / 1024).toFixed(1)} KB)`);
