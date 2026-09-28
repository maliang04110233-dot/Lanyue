/**
 * 列表加载态骨架屏（设计验收 qa-3 回写真 app）
 *
 * 来龙去脉：原型规格声明「异步加载 300ms 内出骨架」，Check 阶段认可为工程交付项，
 * 验收时记为 qa-3 deviation —— 真 app 里只有首页推荐区有骨架（d39982c 那批），
 * 搜索/歌单/专辑/歌手/曲库扫描这 9 处等待时间更长（网络往返 300ms~数秒）的地方
 * 仍是「一根转圈 + 一行字」：结果落地的瞬间列表从 40px 撑到 1200px，
 * 分页条被推走、用户视线失去落点，这正是骨架屏要解决的问题。
 *
 * 本测试锁三件事：
 * 1. 骨架生成只有 skeleton.js 一个家（首页那份实现迁进来，不许各视图各写一套行）；
 * 2. 9 处加载态逐处钉形状（song/album/singer/local 要和真实行的封面尺寸一致，
 *    否则骨架本身就成了跳变源）；
 * 3. CSS 里骨架缩略图尺寸与真实封面尺寸必须同源（用数值比对，不是字符串比对）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// skeleton.js 是纯字符串生成（不碰 document、不碰 api），node 下可直接动态导入
const load = async () => import('../src/renderer/js/skeleton.js?tc=' + Math.random());

/** 首页原实现的逐字节产物 —— 迁移不得改变已上线的观感 */
const HOME_ROW =
  '<div class="skel-row"><div class="skel-avatar"></div>'
  + '<div class="skel-lines"><div class="skel-line w60"></div>'
  + '<div class="skel-line w40"></div></div></div>';

function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// ── 纯函数：形状 ────────────────────────────────────────

test('skeletonHtml(list) 与首页原实现逐字节一致（迁移零观感变化）', async () => {
  const m = await load();
  assert.equal(m.skeletonHtml('list', 2), HOME_ROW + HOME_ROW);
});

test('行类骨架按形状带修饰类，且行数精确', async () => {
  const m = await load();
  for (const kind of ['song', 'album', 'singer', 'local']) {
    const html = m.skeletonHtml(kind, 3);
    assert.equal(countOf(html, `<div class="skel-row skel-row--${kind}">`), 3,
      `${kind} 应恰好 3 行并带自身修饰类`);
    assert.equal(countOf(html, HOME_ROW), 0, `${kind} 不得产出裸 .skel-row（会退回 36px 小封面）`);
  }
});

test('grid 只出卡片不出行', async () => {
  const m = await load();
  const html = m.skeletonHtml('grid', 6);
  assert.equal(countOf(html, '<div class="skel-card"></div>'), 6);
  assert.ok(!html.includes('skel-row'), '九宫格里不该混进行形状');
});

test('未知形状回落普通行（打错字不许白屏）', async () => {
  const m = await load();
  const html = m.skeletonHtml('songg', 2);
  assert.equal(html, HOME_ROW + HOME_ROW, '拼错的 kind 应退化成裸行而不是返回空串');
});

test('行数默认与真实一页可见量相当，并由模块给出常量（不许各调用点自填数字）', async () => {
  const m = await load();
  assert.equal(m.SKEL_ROWS, 10, '搜索/曲库这类整页列表默认 10 行');
  assert.equal(countOf(m.skeletonHtml('song'), '<div class="skel-row skel-row--song">'), m.SKEL_ROWS,
    '省略 count 时用 SKEL_ROWS');
});

test('count 为 0 时不产出空壳行', async () => {
  const m = await load();
  assert.equal(m.skeletonHtml('song', 0), '');
});

// ── 纯函数：文案（反馈不许因换骨架而丢失）────────────────

test('caption 有则恰好一条且排在骨架之前', async () => {
  const m = await load();
  const html = m.skeletonHtml('song', 2, '搜索中...');
  assert.equal(countOf(html, '<div class="skel-cap">搜索中...</div>'), 1);
  assert.ok(html.indexOf('skel-cap') < html.indexOf('skel-row'), '状态文字要在骨架上方');
});

test('无 caption 时不产生空的占位行', async () => {
  const m = await load();
  assert.ok(!m.skeletonHtml('song', 2).includes('skel-cap'));
});

// ── 纯模块边界 ──────────────────────────────────────────

test('skeleton.js 零依赖：不 import、不碰 api/window/document（纯渲染层字符串）', async () => {
  const src = read('js', 'skeleton.js');
  assert.ok(!/^\s*import\s/m.test(src), '骨架生成不该引入任何依赖');
  assert.ok(!/\b(api|window|document)\b/.test(src), '不得触碰宿主对象（否则 node 侧无法直测）');
});

// ── 接线钉：只有一个家 ──────────────────────────────────

test('home.js 交出骨架实现，只留「本节用哪种形状」的判断', () => {
  const hm = read('js', 'views', 'home.js');
  assert.ok(!/function _skeletonHtml/.test(hm), '骨架生成不许有第二个家');
  assert.ok(!hm.includes('skel-card'), '首页不许再自己写骨架标记');
  assert.ok(!hm.includes('<div class="skel-row"'), '同上');
  assert.ok(hm.includes("import { skeletonHtml } from '../skeleton.js'"), '改从公共模块取');
  assert.ok(hm.includes("skeletonHtml('list', LIST_FOLD)"),
    '榜单行数仍由首页的 LIST_FOLD 决定（折叠几行就占几行高）');
  assert.ok(hm.includes("skeletonHtml('grid', 6)"), '歌单九宫格 6 格');
});

// ── 接线钉：9 处加载态 ──────────────────────────────────

test('搜索域六处加载态各按其真实形状出骨架，且沿用原本文案', () => {
  const src = read('js', 'views', 'search.js');
  const pins = [
    // doSearch：搜索类型即形状（song/album/singer 三个 tab 的行高互不相同）
    "skeletonHtml(_searchType, SKEL_ROWS, '搜索中...')",
    // AI 聚合搜索：结果一定是单曲行
    "skeletonHtml('song', SKEL_ROWS, 'AI 理解中，正在聚合搜索...')",
    // 专辑链接弹窗 / 专辑详情 / 歌手详情：落进容器的都是曲目或专辑行
    "skeletonHtml('song', SKEL_ROWS, '加载中...')",
    "skeletonHtml('song', SKEL_ROWS, '加载专辑中...')",
    "skeletonHtml(tab === 'songs' ? 'song' : 'album', SKEL_ROWS, '加载中...')",
  ];
  for (const p of pins) {
    assert.ok(src.includes(p), `未找到接线：${p}`);
  }
  assert.equal(countOf(src, "skeletonHtml('song', SKEL_ROWS, '加载中...')"), 2,
    '两处「加载中...」（专辑链接弹窗 / 歌手详情外壳）都要有骨架；'
    + '歌手详情的内容区按页签分形状，另见下一条钉');
});

test('歌单弹窗与专辑弹窗（app.js）两处加载态换骨架', () => {
  const src = read('js', 'app.js');
  assert.ok(src.includes("import { skeletonHtml, SKEL_ROWS } from './skeleton.js'"), 'app.js 需引入');
  assert.ok(src.includes("skeletonHtml('song', SKEL_ROWS, '加载中...')"), 'openPlaylistModal');
  assert.ok(src.includes("skeletonHtml('song', SKEL_ROWS, '加载专辑中...')"), 'openAlbumView');
});

test('曲库扫描换 local 形状骨架（扫描是全站最慢的等待）', () => {
  const src = read('js', 'views', 'local.js');
  assert.ok(src.includes("import { skeletonHtml, SKEL_ROWS } from '../skeleton.js'"), 'local.js 需引入');
  assert.ok(src.includes("skeletonHtml('local', SKEL_ROWS, '扫描中...')"), '形状要对齐 .local-row');
});

test('反向钉：JS 里不得再有 spinner 式列表加载态（骨架是唯一形态）', () => {
  const files = ['js/app.js', 'js/views/search.js', 'js/views/local.js', 'js/views/home.js'];
  for (const f of files) {
    assert.equal(countOf(read(...f.split('/')), 'class="loading"'), 0,
      `${f} 仍有 spinner 加载态：列表等待一律出骨架`);
  }
});

test('粘贴链接搜索的等待期也得有骨架（占位写在链接识别之前）', () => {
  const src = read('js', 'views', 'search.js');
  const skel = src.indexOf("skeletonHtml(_searchType, SKEL_ROWS, '搜索中...')");
  const link = src.indexOf('if (await handleLinkInput(');
  assert.ok(skel > 0 && link > skel,
    '链接识别本身是一次网络往返，占位若写在 await 之后则该期间界面毫无反应');
});

test('占位提前了就得负责收回：链接交给弹窗展示时不许留下假加载中', () => {
  const src = read('js', 'views', 'search.js');
  // 专辑/歌单链接分支只弹窗、不写列表区 —— 若不清场，弹窗一关列表就永远停在骨架上
  // （旧写法里占位写在 await 之后，所以不会有这个问题；本增量把它提前了，代价在这里补）。
  const capture = src.indexOf('const prevHtml = _dom.songList ? _dom.songList.innerHTML :');
  const write = src.indexOf('const skelHtml = skeletonHtml(');
  assert.ok(capture > 0 && capture < write, '必须在写骨架之前记下搜索前的内容');
  assert.ok(src.includes('if (_dom.songList && _dom.songList.innerHTML === skelHtml) _dom.songList.innerHTML = prevHtml;'),
    '接管判据要用「列表内容仍是那串骨架」：单曲链接分支自己写过列表，不能误伤');
});

// ── CSS：尺寸必须与真实行同源 ───────────────────────────

function firstRuleNum(cssFile, selector, prop) {
  const css = read(...cssFile.split('/'));
  const i = css.indexOf(selector);
  assert.ok(i > 0, `未找到 CSS 选择器 ${selector}`);
  const block = css.slice(i, css.indexOf('}', i));
  const mm = block.match(new RegExp(prop + '\\s*:\\s*(\\d+)px'));
  assert.ok(mm, `${selector} 里没有 ${prop}:Npx：${block}`);
  return Number(mm[1]);
}

test('骨架缩略图默认 36px 走 --skel-thumb 变量（形状由修饰类决定）', () => {
  const css = read('styles', 'content.css');
  assert.ok(/\.skel-avatar\s*{[^}]*width:\s*var\(--skel-thumb,\s*36px\)/.test(css),
    '.skel-avatar 的宽高必须由 --skel-thumb 提供，默认 36px 保持首页榜单原样');
});

test('四种行骨架的封面尺寸与真实行完全一致（否则骨架自己就是跳变源）', () => {
  const pairs = [
    ['song', '.skel-row--song', '.song-cover'],
    ['album', '.skel-row--album', '.album-cover'],
    ['singer', '.skel-row--singer', '.singer-avatar'],
    ['local', '.skel-row--local', '.local-row-cover'],
  ];
  for (const [kind, skelSel, realSel] of pairs) {
    const skelFile = 'styles/content.css';
    const realFile = realSel === '.song-cover' ? 'styles/content.css' : 'styles/player.css';
    const skel = firstRuleNum(skelFile, skelSel, '--skel-thumb');
    const real = firstRuleNum(realFile, realSel, 'width');
    assert.equal(skel, real, `${kind} 骨架封面 ${skel}px ≠ 真实 ${real}px，加载完会跳`);
  }
});

test('歌手骨架跟真实行一样是圆头像', () => {
  const css = read('styles', 'content.css');
  assert.ok(/\.skel-row--singer\s+\.skel-avatar\s*{[^}]*border-radius:\s*50%/.test(css),
    '.singer-avatar 是 50% 圆，骨架用方角会显出形状差');
});

test('骨架状态文字有独立样式且用弱化色（不与 empty-state 抢层级）', () => {
  const css = read('styles', 'content.css');
  assert.ok(/\.skel-cap\s*{/.test(css), '缺 .skel-cap 样式：默认无字号会盖过骨架的分量');
});
