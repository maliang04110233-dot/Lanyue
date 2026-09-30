/**
 * 本地曲库工具栏「精简」守卫
 *
 * 病根（用户截图）：常驻控件挤在一行里，每枚按钮被 flex 压到一列一个字 ——
 * 「扫描目录」竖成「扫/描/目/录」，整条工具栏变成一堵竖排字墙。
 * 上一轮把 13 枚低频动作折进「🗂 分组  / 🧰 工具 ▾」两个下拉是治症，
 * 本轮治因：
 *   ① 标签本身瘦下来 —— 默认态只报轴名（🧪 音质），切态后只报值（🧪 真无损），
 *      "有没有在筛"改由 .active 高亮表示（旧文案「🧪 音质: 仅待验（无损容器未实测）」
 *      一枚按钮吃掉 13 个字，正是压垮那一行的主力）；
 *   ② CSS 兜底 —— 宁可换行也不许在词中间断开（窄窗口是常态，窗口会被拖窄）。
 *
 * 本文件钉的是"精简不许变成删功能"与"文案不许两处漂"：
 *   · HTML 默认字样 == 纯函数 all 态字样（否则首屏一个样、点一下跳成另一个样）；
 *   · 常驻标签长度封顶；
 *   · 13 枚折进下拉的动作仍各自可达；
 *   · 换行 + 不断词的样式守卫。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../src/renderer/styles/player.css'), 'utf8');
const LOCAL_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/views/local.js'), 'utf8');
const CYCLE_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/filterCycle.js'), 'utf8');

/** 工具栏区段：从 local-toolbar 开标签到「批量选择操作栏」注释（下拉菜单也在其中） */
function toolbarHtml() {
  const at = HTML.indexOf('class="local-toolbar"');
  assert.ok(at > -1, '找不到 .local-toolbar（工具栏改名或挪走）');
  const end = HTML.indexOf('批量选择操作栏', at);
  assert.ok(end > at, '工具栏区段没有预期的结尾（结构变了要同步本判据）');
  return HTML.slice(at, end);
}

/** 常驻按钮（下拉里的 .tb-menu-item 不算：它们不在同一行里抢宽度） */
function residentButtons(bar) {
  return [...bar.matchAll(/<button class="tab[^"]*"([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((m) => ({ attrs: m[1], text: m[2].trim() }));
}

/** 只数汉字与字母数字（图标、括号、空白不占实际宽度） */
function textLen(s) {
  return (s.match(/[㐀-鿿A-Za-z0-9]/g) || []).length;
}

async function freshLabels() {
  const q = await import(`../src/renderer/js/localQualityFilter.js?v=${Math.random()}`);
  const m = await import(`../src/renderer/js/localMetaFilter.js?v=${Math.random()}`);
  const f = await import(`../src/renderer/js/localFormatFilter.js?v=${Math.random()}`);
  return { qual: q.qualModeLabel, meta: m.metaModeLabel, fmt: f.fmtModeLabel };
}

test('常驻标签封顶：默认态只报轴名，长度不许回到"音质: 仅待验（…）"那种量级', () => {
  const bar = toolbarHtml();
  const btns = residentButtons(bar);
  assert.ok(btns.length >= 8, `常驻按钮数量异常（实得 ${btns.length}），本判据的前提没了`);
  for (const b of btns) {
    assert.ok(textLen(b.text) <= 4, `常驻标签过长（${textLen(b.text)} 字）：${b.text}`);
  }
  assert.ok(!/音质:|完整度:|全部格式/.test(bar), '轴名前缀回来了 = 压垮那一行的主力回来了');
});

test('HTML 默认字样 == 纯函数 all 态字样（两处漂了首屏一个样、点一下跳另一个样）', async () => {
  const { qual, meta, fmt } = await freshLabels();
  const bar = toolbarHtml();
  const cases = [
    ['localQualBtn', qual('all')],
    ['localMetaBtn', meta('all')],
    ['localFmtBtn', fmt('all')],
  ];
  for (const [id, label] of cases) {
    const m = bar.match(new RegExp(`id="${id}"[^>]*>([^<]*)</button>`));
    assert.ok(m, `找不到 ${id} 按钮`);
    assert.strictEqual(m[1].trim(), label, `${id} 的 HTML 默认字样与函数 all 态不一致`);
  }
});

test('三枚循环按钮的文案与高亮同源，且高亮判据是"非 all"', () => {
  // 文案与高亮一处算：sync() 同时写 textContent 与 .active
  assert.ok(CYCLE_JS.includes('btn.textContent = cfg.label(mode);')
    && CYCLE_JS.includes("btn.classList.toggle('active', !!isActive(mode));"),
    'filterCycle.sync 里文案与高亮必须一次算完（分两处写迟早漂成"按钮亮着但视图没筛"）');
  // 默认高亮判据 = 非 all；三枚过滤轴都不覆盖 isActive，故吃这个默认
  assert.ok(CYCLE_JS.includes("cfg.isActive || ((m) => m !== 'all')"), '高亮判据默认应为「非 all」');
  // 三枚过滤轴各在 LOCAL_AXES 表里声明，文案取自各自的 *ModeLabel（收藏/排序另有两态/纯排序判据）
  for (const [axisId, btnId, labelFn] of [
    ['qual', 'localQualBtn', 'qualModeLabel'],
    ['meta', 'localMetaBtn', 'metaModeLabel'],
    ['fmt', 'localFmtBtn', 'fmtModeLabel'],
  ]) {
    const at = LOCAL_JS.indexOf(`id: '${axisId}'`);
    assert.ok(at >= 0, `LOCAL_AXES 里缺 ${axisId} 轴`);
    const block = LOCAL_JS.slice(at, at + 320);
    assert.ok(block.includes(`btnId: '${btnId}',`), `${axisId} 轴绑到 ${btnId}`);
    assert.ok(block.includes(`label: ${labelFn},`), `${btnId} 的文案走 ${labelFn}`);
    assert.ok(!/isActive:/.test(block), `${axisId} 是过滤轴，高亮用默认判据（非 all），不需覆写`);
  }
  // 收藏轴是布尔两态、排序轴是纯排序——这两条必须覆写 isActive（默认值对它们不成立）
  assert.ok(/id:\s*'fav'[\s\S]{0,320}isActive:\s*\(m\)\s*=>\s*!!m/.test(LOCAL_JS), '收藏轴两态，高亮=mode 本身');
  assert.ok(/id:\s*'sort'[\s\S]{0,320}isActive:\s*\(\)\s*=>\s*false/.test(LOCAL_JS), '排序轴只显文案不打卡');
});

test('折进下拉的 13 枚动作仍各自可达（精简不许变成删功能）', () => {
  const bar = toolbarHtml();
  const items = [...bar.matchAll(/<button class="tb-menu-item" onclick="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)];
  const want = ['批量补封面', '批量补歌词', '转码', '统计', '查重', '内容查重', '音质扫描',
    '定位播放', '导出m3u', '复制曲单', '歌手分组', '专辑分组', '文件夹分组'];
  // 一枚动作一个菜单项：数量与名单一一对应（多出来的是重复入口，少了的是删功能）
  assert.strictEqual(items.length, want.length,
    `下拉菜单项与名单不符（实得 ${items.length}，名单 ${want.length}）`);
  const seen = items.map((m) => m[2].trim());
  for (const label of want) {
    assert.ok(seen.some((s) => s.includes(label)), `菜单项「${label}」不见了`);
  }
  // 菜单项一律「动作 + 收菜单」，漏 closeTbMenus 会让菜单常驻盖住下面的行
  for (const m of items) {
    assert.ok(/closeTbMenus\(\)/.test(m[1]), `菜单项没收菜单：${m[2].trim()}`);
  }
});

test('CSS 兜底：窄窗口换行而不是把按钮压成逐字竖排', () => {
  const at = CSS.indexOf('.local-toolbar {');
  assert.ok(at > -1, '找不到 .local-toolbar 规则');
  const block = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(block, /flex-wrap:\s*wrap/, '工具栏必须能换行');
  assert.match(CSS, /\.local-toolbar \.tab \{[^}]*white-space:\s*nowrap/, '按钮文字不许在词中间断开');
  assert.match(CSS, /\.local-toolbar \.tab \{[^}]*flex-shrink:\s*0/, '按钮不能被压扁');
});

test('自检：本文件的判据对"退回旧写法"确实会红（不是恒真）', async () => {
  const { qual } = await freshLabels();
  // ① 文案退回轴名前缀 ⇒ all 态字样钉必须失配
  assert.notStrictEqual(qual('all'), '🧪 音质: 全部', '判据应当只认精简后的字样');
  // ② 常驻标签退回长文案 ⇒ 封顶钉必须命中
  const verbose = '🧪 音质: 仅待验（无损容器未实测）';
  assert.ok(textLen(verbose) > 4, '长度封顶应当抓到这处倒退');
  // ③ 菜单项漏掉 closeTbMenus ⇒ 收菜单钉必须命中
  const leaky = 'showFolderGroups()';
  assert.ok(!/closeTbMenus\(\)/.test(leaky), '收菜单钉应当抓到"只调动作不关菜单"');
  // ④ CSS 去掉换行 ⇒ 判据必须失配
  assert.ok(!/flex-wrap/.test('.local-toolbar { display: flex; }'), '换行钉应当对无 flex-wrap 失配');
});
