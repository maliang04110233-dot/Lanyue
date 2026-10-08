/**
 * 本地曲库工具栏「精简」守卫
 *
 * 病根（用户截图）：常驻控件挤在一行里，每枚按钮被 flex 压到一列一个字 ——
 * 「扫描目录」竖成「扫/描/目/录」，整条工具栏变成一堵竖排字墙。
 * 三轮各自的分工：
 *   第 1 轮（治症）把 13 枚低频动作折进「🗂 分组 / 🧰 工具 ▾」两个下拉；
 *   第 2 轮（治因）标签瘦身 + CSS 兜底 —— 默认态只报轴名（🧪 音质），切态后只报值
 *     （🧪 真无损），"有没有在筛"由 .active 表示（旧文案「🧪 音质: 仅待验（无损容器未实测）」
 *     一枚吃掉 13 个字，正是压垮那一行的主力）；CSS 宁可换行也不许在词中间断开。
 *   第 3 轮（补第 2 轮治出的新病）把 🎞/🧪/🏷 三轴折进「🔽 筛选 ▾」——省宽之后
 *     "正在筛什么"随菜单一起藏起来了，于是补一行只在外头露面的 chip 报实话。
 *
 * 本文件钉的是"精简不许变成删功能""文案不许两处漂""报数不许说谎"：
 *   · HTML 默认字样 == 纯函数 all 态字样（否则首屏一个样、点一下跳成另一个样）；
 *   · 常驻标签长度封顶；
 *   · 折进下拉的动作仍各自可达，且**收/不收菜单按项性分叉**（动作项必须收，
 *     档位项必须不收 —— 收了就等于五态只能一次点一格再重开，等于没做）；
 *   · 折叠范围三处同源（菜单档位项 == CHIP_AXIS_IDS == 轴表里的 btnId）；
 *   · chip 行的容器与"空则不占缝"的样式就位；
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

/** 折进「🔽 筛选 ▾」的三条档位在菜单里的固定顺序（= 轴表顺序 = chip 顺序） */
const AXIS_BTN_IDS = ['localFmtBtn', 'localQualBtn', 'localMetaBtn'];

/** 工具栏区段：从 local-toolbar 开标签到「批量选择操作栏」注释（下拉菜单与 chip 行都在其中） */
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

/**
 * 两个工具栏下拉里的菜单项。
 *
 * 只从第一个 .tb-dropdown 往后取：选择栏/批量栏里也有一批 .tb-menu-item 的行
 * （它们借同一套样式），把那些算进"折进下拉的动作"会让数数判据莫名其妙地红。
 * 属性顺序不敏感（档位项的 id 写在 onclick 前）；onclick 只在开始标签里取，
 * 正文按 </button> 截 —— 菜单文本带 emoji 与变体选择符，别拿它做正则的活口。
 */
function menuItems(bar) {
  const at = bar.indexOf('<div class="tb-dropdown">');
  assert.ok(at > -1, '找不到 .tb-dropdown（下拉改名或挪走）');
  const tail = bar.slice(at);
  const out = [];
  const re = /<button\b([^>]*)>/g;
  let m;
  while ((m = re.exec(tail))) {
    if (!/class="tb-menu-item"/.test(m[1])) continue;
    const close = tail.indexOf('</button>', m.index);
    out.push({
      id: (m[1].match(/\bid="([^"]+)"/) || [])[1] || '',
      onclick: (m[1].match(/\bonclick="([^"]*)"/) || [])[1] || '',
      text: tail.slice(m.index + m[0].length, close).trim(),
    });
  }
  return out;
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

test('折进下拉的 14 枚动作仍各自可达（精简不许变成删功能）', () => {
  const actions = menuItems(toolbarHtml()).filter((it) => !it.id);
  const want = ['批量补封面', '批量补歌词', '转码', '统计', '查重', '内容查重', '音质扫描',
    '定位播放', '导出m3u', '复制曲单', '歌手分组', '专辑分组', '文件夹分组', '清空筛选'];
  // 一枚动作一个菜单项：数量与名单一一对应（多出来的是重复入口，少了的是删功能）
  assert.strictEqual(actions.length, want.length,
    `动作项与名单不符（实得 ${actions.length}，名单 ${want.length}）`);
  for (const label of want) {
    assert.ok(actions.some((a) => a.text.includes(label)), `动作项「${label}」不见了`);
  }
  // 动作项一律「动作 + 收菜单」，漏 closeTbMenus 会让菜单常驻盖住下面的行
  for (const a of actions) {
    assert.ok(/closeTbMenus\(\)/.test(a.onclick), `动作项没收菜单：${a.text}`);
  }
});

test('档位项与动作项相反：走一格后菜单必须留着（连点才能把五态走完）', () => {
  const axes = menuItems(toolbarHtml()).filter((it) => it.id);
  assert.deepStrictEqual(axes.map((a) => a.id), AXIS_BTN_IDS,
    '菜单里的档位项必须就这三条、且按轴表顺序排（chip 顺序与此同源）');
  for (const a of axes) {
    assert.ok(/cycleLocal(Fmt|Qual|Meta)\(\)/.test(a.onclick), `${a.id} 没接到自己的循环函数：${a.onclick}`);
    assert.ok(!/closeTbMenus/.test(a.onclick), `${a.id} 收菜单 = 走一格得重开一次菜单`);
  }
});

test('折叠范围三处同源：菜单档位项 == CHIP_AXIS_IDS == 轴表 btnId', async () => {
  const { CHIP_AXIS_IDS } = await import(`../src/renderer/js/localFilterSummary.js?v=${Math.random()}`);
  assert.deepStrictEqual(CHIP_AXIS_IDS, ['fmt', 'qual', 'meta'],
    '名单变了要同时改菜单 DOM、轴表和本钉 —— 只改一处就是"菜单能筛、外面不报"或反之');
  for (const id of CHIP_AXIS_IDS) {
    assert.ok(LOCAL_JS.includes(`id: '${id}'`), `轴表里缺 ${id} 轴`);
  }
});

test('♥ 收藏留在常驻区：一键开关不许被折进菜单（折叠范围的例外要说清）', () => {
  const bar = toolbarHtml();
  const resident = residentButtons(bar);
  assert.ok(resident.some((b) => /id="localFavBtn"/.test(b.attrs)), '♥ 收藏该是常驻 .tab 按钮');
  assert.ok(!menuItems(bar).some((it) => it.id === 'localFavBtn'), '♥ 收藏折进菜单就丢了单键切换');
  // 触发器就位：菜单一关，用户唯一的入口就是它
  assert.match(bar, /id="localFilterBtn"[^>]*onclick="toggleTbDropdown\(event, 'localFilterMenu'\)"/);
});

test('chip 行就位：容器在工具栏与选择栏之间，空则整行不占缝', () => {
  const bar = toolbarHtml();
  assert.match(bar, /id="localFilterChips"[^>]*hidden/,
    'chip 容器该在工具栏区段内，且出生即 hidden');
  assert.match(bar, /<div class="filter-chips" id="localFilterChips"/, 'chip 容器的类名/顺序该与样式判据对得上');
  assert.match(CSS, /\.filter-chips\[hidden\] \{ display: none; \}/,
    '.local-page 是 gap:14px 的 flex 列，空行不真隐藏就会白占一条缝');
  // 菜单里的高亮：折进去之后 .tab.active 那套已经够不着档位项了
  assert.match(CSS, /\.tb-menu-item\.active \{[^}]*box-shadow: inset/,
    '档位项在菜单里也得有同语义高亮，否则"亮=在筛"进菜单就死了');
});

test('chip 接线：渲染挂在唯一漏斗上，文案取轴表、清档只认名单', () => {
  // 渲染点：filterLocalSongs 里（三条轴的 onChange 都汇到这儿，挂别处就会漂）
  const fn = LOCAL_JS.slice(LOCAL_JS.indexOf('function filterLocalSongs()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes('_renderFilterChips();'), 'chip 渲染没接在 filterLocalSongs 里');
  // 同源：投影只搬运 label 函数，自己不拼词
  assert.match(LOCAL_JS, /\.map\(\(a\) => \(\{ id: a\.id, mode: a\.get\(\), label: a\.label \}\)\)/,
    '_chipSource 应当只投影轴表，别在这里重写一份文案');
  // 单清认名单：'all' 只是三条过滤轴的关档值，拿它清排序轴会写出一个不存在的档
  assert.match(LOCAL_JS, /function resetLocalFilterAxis\(id\) \{\s*if \(!CHIP_AXIS_IDS\.includes\(id\)\) return;/,
    'resetLocalFilterAxis 少了白名单挡刀');
  assert.match(LOCAL_JS, /_axes\.byId\[id\]\.sync\(\);\s*filterLocalSongs\(\);/,
    '清档后既没同步按钮也没重新过筛');
  // 两个新出口都得上 window（index.html 的 onclick 只认全局名）
  assert.ok(LOCAL_JS.includes('window.resetLocalFilterAxis = resetLocalFilterAxis;'), '缺 window 桥：reset');
  assert.ok(LOCAL_JS.includes('window.clearLocalFilters = clearLocalFilters;'), '缺 window 桥：clear');
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
  // ③ 动作项漏掉 closeTbMenus ⇒ 收菜单钉必须命中
  const leaky = 'showFolderGroups()';
  assert.ok(!/closeTbMenus\(\)/.test(leaky), '收菜单钉应当抓到"只调动作不关菜单"');
  // ④ 反向：档位项若被"顺手统一"成收菜单 ⇒ 分叉判据必须命中
  const overClosed = 'cycleLocalQual();closeTbMenus()';
  assert.ok(/closeTbMenus/.test(overClosed), '档位项不许收菜单——这条判据抓的就是这种"统一"');
  // ⑤ CSS 去掉换行 ⇒ 判据必须失配
  assert.ok(!/flex-wrap/.test('.local-toolbar { display: flex; }'), '换行钉应当对无 flex-wrap 失配');
  // ⑥ 属性顺序换一下也该被解析到（否则菜单数一改判据就假绿）
  const reordered = menuItems('<div class="tb-dropdown">'
    + '<button class="tb-menu-item" id="x" onclick="f()">z</button></div>');
  assert.strictEqual(reordered.length, 1);
  assert.strictEqual(reordered[0].id, 'x');
  assert.strictEqual(reordered[0].onclick, 'f()');
});
