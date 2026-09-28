/**
 * 首页平台 tab 互斥切换
 *
 * 纯函数部分（homePlatTabs.js）可真跑；DOM 接线部分只能静态钉 ——
 * home.js 顶层就有 document 访问，node 下 import 不可行（同其它视图增量）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOME_PLAT_LS_KEY, nextPlatTab, normalizePlatTab, platIdsOf } from '../src/renderer/js/homePlatTabs.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const HOME = read('../src/renderer/js/views/home.js');
const CSS = read('../src/renderer/styles/content.css');
const HTML = read('../src/renderer/index.html');

const IDS = ['netease', 'qq', 'bilibili', 'kugou'];

// ── 纯函数 ────────────────────────────────────────────────
test('platIdsOf 从注册表派生顺序，脏项跳过（不再抄第二份平台清单）', () => {
  assert.deepEqual(platIdsOf([{ plat: 'netease' }, { plat: 'qq' }, { plat: 'kugou' }]),
    ['netease', 'qq', 'kugou']);
  assert.deepEqual(platIdsOf([{ plat: '' }, { plat: null }, {}, { plat: 'qq' }]), ['qq']);
  assert.deepEqual(platIdsOf(null), []);
  assert.deepEqual(platIdsOf('nope'), []);
  assert.equal(HOME_PLAT_LS_KEY, 'homeActivePlat');
});

test('normalizePlatTab：未知/缺失回落首个平台，空清单返回 null', () => {
  assert.equal(normalizePlatTab(IDS, 'qq'), 'qq');
  assert.equal(normalizePlatTab(IDS, 'tencent'), 'netease');
  assert.equal(normalizePlatTab(IDS, null), 'netease');
  assert.equal(normalizePlatTab(IDS, undefined), 'netease');
  assert.equal(normalizePlatTab([], 'qq'), null);
});

test('nextPlatTab：←/→ 两端回绕，未知当前项从头开始', () => {
  assert.equal(nextPlatTab(IDS, 'netease', 1), 'qq');
  assert.equal(nextPlatTab(IDS, 'kugou', 1), 'netease', '最后一个右移回到第一个');
  assert.equal(nextPlatTab(IDS, 'netease', -1), 'kugou', '第一个左移到最后一个');
  assert.equal(nextPlatTab(IDS, 'qq', -1), 'netease');
  assert.equal(nextPlatTab(IDS, 'qq', 0), 'qq', 'delta 0 原地不动');
  assert.equal(nextPlatTab(IDS, 'ghost', 1), 'netease');
  assert.equal(nextPlatTab(IDS, 'qq', undefined), 'qq', 'delta 缺失按 0 处理，不 NaN');
  assert.equal(nextPlatTab([], 'qq', 1), null);
  assert.equal(nextPlatTab(['netease'], 'netease', 1), 'netease', '单平台循环仍是自己');
});

// ── 接线钉 ────────────────────────────────────────────────
test('home.js 接线：tab 切换取代锚点滚动，旧纵向翻页代码不得复活', () => {
  assert.ok(
    HOME.includes("import { platIdsOf, normalizePlatTab, nextPlatTab, HOME_PLAT_LS_KEY } from '../homePlatTabs.js';"),
    '必须走 homePlatTabs.js 纯函数');

  assert.ok(HOME.includes([
    'function showHomePlatform(plat, btn) {',
    '  const target = normalizePlatTab(_platIds, plat);',
  ].join('\n')), '缺少 showHomePlatform 入口');
  assert.equal(countOf(HOME, 'function showHomePlatform('), 1, 'showHomePlatform 只能有一处定义');

  // 显隐 + 按需加载 + 回顶：三者缺一即「点了没反应」或「切过去停在半屏」
  assert.ok(HOME.includes('el.hidden = el.dataset.plat !== target;'), '平台块未按 target 做显隐');
  assert.ok(HOME.includes('loadPlatform(target);'), '切 tab 未触发按需加载');
  assert.ok(HOME.includes('root.scrollTop = 0;'), '切 tab 未回到顶部');

  // 骨架渲染：块与 tab 都按 _activePlat 决定初始态
  assert.ok(HOME.includes(`<section class="plat-block" id="\${_blockId(p.plat)}" data-plat="\${p.plat}"\${on ? '' : ' hidden'}>`),
    'plat-block 初始 hidden 未接线');
  assert.ok(HOME.includes(`class="anchor-chip\${on ? ' active' : ''}"`), 'tab 初始 active 未接线');
  assert.ok(HOME.includes(`onclick="showHomePlatform('\${escQ(p.plat)}',this)"`), 'tab 点击未接 showHomePlatform');

  // 纵向翻页的那套机制必须彻底消失（留着就是两套真相）
  for (const gone of ['scrollToHomeBlock', 'observeBlocks', '_bindAnchorSpy',
    '_syncActiveAnchor', '_setActiveAnchor', 'IntersectionObserver', '_observer']) {
    assert.ok(!HOME.includes(gone), `旧的纵向翻页残留：${gone}`);
  }
  assert.ok(!/window\.scrollToHomeBlock\s*=/.test(HOME),
    '不得再挂同名不同参的旧桥接（静默陷阱）');
  assert.ok(HOME.includes('window.showHomePlatform = showHomePlatform;'), '缺 window 桥接');
  assert.ok(HOME.includes('window.switchPlatTab = (plat) => showHomePlatform(plat);'),
    '自动化入口 switchPlatTab 应指向新语义');

  // 启动只加载当前 tab
  assert.ok(HOME.includes([
    '    renderHomeShell();',
    '    // 只加载当前 tab：其余平台等用户切过去再按需加载',
    '    showHomePlatform(_activePlat);',
  ].join('\n')), '首页入口未接「只加载当前 tab」');
});

test('上次所选平台持久化走 localStorage，且异常静默降级', () => {
  assert.ok(HOME.includes('const _platIds = platIdsOf(HOME_PLATFORMS);'),
    'tab 清单必须派生自 HOME_PLATFORMS');
  assert.ok(HOME.includes('let _activePlat = normalizePlatTab(_platIds, _storedPlat());'),
    '初始 tab 应取回上次所选');
  assert.ok(HOME.includes('localStorage.getItem(HOME_PLAT_LS_KEY)'), '缺 localStorage 读取');
  assert.ok(HOME.includes('localStorage.setItem(HOME_PLAT_LS_KEY, plat)'), '缺 localStorage 写入');
  const ls = HOME.slice(HOME.indexOf('function _storedPlat'), HOME.indexOf('let _activePlat'));
  assert.equal(countOf(ls, 'try {'), 2, '读写两处都必须各自 try');
});

test('←/→ 键盘切换有边界守卫（输入框/弹窗/非首页一律放行）', () => {
  const start = HOME.indexOf("if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;");
  const call = HOME.indexOf('showHomePlatform(next, null);');
  assert.ok(start > 0 && call > start, '未找到方向键处理块');
  const handler = HOME.slice(start, HOME.indexOf('});', call));
  assert.ok(handler.includes("t.tagName === 'INPUT'"), '输入框内不得抢方向键');
  assert.ok(handler.includes('isContentEditable'), '可编辑区不得抢方向键');
  assert.ok(handler.includes("window.isTabPageVisible?.('homePage')"), '只在首页视图生效（164 起问页面可见，不问导航高亮 —— 见 renderer-audit 的探针收口钉）');
  assert.ok(handler.includes('_homeModalOpen()'), '弹窗打开时不得抢方向键');
  // 曾经的事故：写成 querySelector('.playlist-modal-overlay') 判弹窗，但 index.html 里
  // 六个弹层常驻 DOM（.hidden 控显隐）→ 判定恒真 → 方向键静默失效。
  const helper = HOME.slice(HOME.indexOf('function _homeModalOpen'), HOME.indexOf('document.addEventListener', HOME.indexOf('function _homeModalOpen')));
  assert.ok(helper.includes("classList.contains('hidden')"),
    '弹窗判定必须看可见性（含 hidden 类即视为关闭），不能只按类名查存在性');
  assert.ok(!helper.includes("querySelector('.playlist-modal-overlay')"),
    '不得再用「存在即开着」的判定');
  assert.ok(handler.includes('e.preventDefault();'), '接管后须阻止默认横向滚动');
  assert.ok(handler.includes('showHomePlatform(next, null);'), '守卫通过后须真正切平台');
});

test('CSS 必须压过作者 display：.plat-block[hidden] 与 index.html 注释同步', () => {
  assert.ok(CSS.includes('.plat-block[hidden] { display: none !important; }'),
    '缺这条时 .plat-block{display:flex} 会盖掉 UA 的 [hidden]，切平台等于没切');
  assert.ok(!CSS.includes('.anchor-chip.in-view'), '滚动监视已删，in-view 属死规则');
  assert.ok(!/\.plat-block\s*\{[^}]*scroll-margin-top/.test(CSS),
    '不再作为滚动锚点，scroll-margin-top 属误导');

  assert.ok(HTML.includes('<!-- 平台 tab 条：互斥切换，一次只显示一个平台（←/→ 循环） -->'),
    'index.html 结构注释需与新行为一致');
  assert.ok(!HTML.includes('三平台内容同时存在，不再 tab 互斥'),
    '旧注释与新行为相反，必须删净');
});

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
