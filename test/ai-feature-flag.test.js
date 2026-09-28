/**
 * AI 功能总开关（入口级关停，代码与 IPC 通道全部保留）
 *
 * 用户口径是「删掉 AI 创作功能」，但选择了可逆那版：不拆 api/主进程/契约/偏好键，
 * 只把用户能走进去的入口关掉。于是这一增量的全部风险都不在"关不掉"，
 * 而在**关不全** —— 侧栏、命令面板（含最近使用）、搜索页口语按钮、程序化 switchTab
 * 是四条独立通路，漏一条就是"看着删了其实还能进"。所以这里的钉分三类：
 *   ① 真行为：features.js 的纯判定、applyFeatureFlags 的摘除、filterByFeature 的过滤；
 * ② 顺序：switchTab 的守卫必须发生在它动任何页面 display 之前（同c084172 的教训，
 *      存在性钉会放过"守卫写在末尾、页面已经渲染完"的静默失效）；
 *   ③ 反漂移：开关值只准有一处，入口宿主只准靠 data-feature 声明，
 *      新增入口漏挂时第 5/6 条钉会红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('src/renderer/index.html');
const APP_JS = read('src/renderer/js/app.js');
const PALETTE_JS = read('src/renderer/js/commandPalette.js');

async function freshFeatures() {
  return import('../src/renderer/js/features.js?tc=' + Math.random());
}

// ── ① 纯判定：默认关，且判定是"未开即关"（未知特性名不放行，防拼错静默漏挂）──
test('开关：AI 默认关，tabAllowed 只放行已开特性的 tab', async () => {
  const f = await freshFeatures();
  assert.strictEqual(f.featureOn('ai'), false, 'AI 入口默认应为关');
  assert.strictEqual(f.featureOn('home'), false, '没登记过的特性不能当开启');
  assert.strictEqual(f.tabAllowed('ai-music'), false, 'AI 创作页不能进');
  assert.strictEqual(f.tabAllowed('converter'), true, '未登记特性的 tab 一律放行');
});

// ── ② 真行为：applyFeatureFlags 摘除宿主节点 ──
function fakeHost(feature) {
  return { dataset: { feature }, _removed: false, remove() { this._removed = true; } };
}
test('applyFeatureFlags：关掉的特性摘除其全部宿主，未关的不许动', async () => {
  const f = await freshFeatures();
  const aiNav = fakeHost('ai');
  const aiBtn = fakeHost('ai');
  const keep = fakeHost('never-registered-but-on');
  const root = { querySelectorAll: () => [aiNav, aiBtn, keep] };
  f.applyFeatureFlags(root, { on: (name) => name === 'never-registered-but-on' });
  assert.ok(aiNav._removed && aiBtn._removed, '两个 AI 宿主都要被摘掉');
  assert.ok(!keep._removed, '特性仍开着的宿主不能误伤');
});

// ── ③ 真行为：命令面板过滤是纯函数，且"最近使用"共用同一份表 ──
test('filterByFeature：关掉 AI 后 nav-ai 不在表里，无特性声明的命令不受影响', async () => {
  const f = await freshFeatures();
  const cmds = [
    { id: 'nav-ai', feature: 'ai' },
    { id: 'nav-home' },
    { id: 'pl-fav', feature: 'ai' },
  ];
  const off = f.filterByFeature(cmds, () => false);
  assert.deepStrictEqual(off.map(c => c.id), ['nav-home']);
  const on = f.filterByFeature(cmds, () => true);
  assert.strictEqual(on.length, 3, '翻 true 即完整恢复，不残留过滤');
});

test('命令面板两条通路都吃同一张过滤表（rankCommands 与最近使用不许漏一条）', () => {
  const start = PALETTE_JS.indexOf('function _refresh(query)');
  assert.ok(start > 0, '_refresh 找不到，落点变了？');
  const refresh = PALETTE_JS.slice(start, PALETTE_JS.indexOf('\n}', start));
  assert.ok(refresh.length > 0 && refresh.length < 1200, '_refresh 切片不靠谱，钉要重看');
  assert.match(PALETTE_JS, /const PALETTE_COMMANDS = filterByFeature\(COMMANDS, featureOn\)/,
    '没有从 COMMANDS 派生出过滤表 —— 开关挂不上面板');
  assert.match(refresh, /rankCommands\(\s*query,\s*PALETTE_COMMANDS\)/,
    '排序通路还在吃原始 COMMANDS，AI 命令仍能搜出来');
  assert.match(refresh, /pickRecents\(_loadRecents\(\),\s*PALETTE_COMMANDS\)/,
    '最近使用还在投影原始 COMMANDS，存过 nav-ai 的用户能把它复活');
  assert.match(PALETTE_JS, /\{\s*id:\s*'nav-ai'[\s\S]{0,160}?feature:\s*'ai'/,
    'nav-ai 没声明 feature，等于没挂开关');
  // 完备性：任何指向 AI 页的命令都必须挂 feature:'ai'（不是只钉 nav-ai 这一条）——
  // 以后往面板加 AI 创作类命令时，漏挂直接红，而不是"关掉了却还能搜到"。
  const leaks = PALETTE_JS.split('\n')
    .filter(l => /^\s*\{ id:/.test(l) && /ai-music|aiMusic|AI 创作|AI 音乐/.test(l) && !/feature:\s*'ai'/.test(l));
  assert.deepStrictEqual(leaks, [], '有指向 AI 页的命令没挂开关：\n' + leaks.join('\n'));
});

// ── ④ 顺序：switchTab 的守卫要在它碰任何页面之前 ──
test('switchTab 的 AI 守卫发生在改任何 display 之前（顺序钉）', () => {
  const start = APP_JS.indexOf('function switchTab(tab, btn)');
  assert.ok(start > 0, 'switchTab 找不到，落点变了？');
  const body = APP_JS.slice(start, APP_JS.indexOf('\n}', APP_JS.indexOf("tab === 'home'")));
  const guard = body.indexOf('tabAllowed(');
  const firstDisplay = body.search(/style\.display|classList\.(add|remove)\(/);
  assert.ok(guard >= 0, 'switchTab 里没有 tabAllowed 守卫');
  assert.ok(firstDisplay >= 0, 'switchTab 里没找到页面切换语句，钉要重看');
  assert.ok(guard < firstDisplay,
    '守卫写在页面切换之后 —— AI 页会先渲染完再被拦，等于没拦');
  assert.match(body.slice(guard, guard + 260), /switchTab\('home'\)|tab = 'home'/,
    '被关掉的 tab 要有明确回落，不能静默停在原地');
});

// ── ⑤ 入口宿主：两处静态宿主都声明了 data-feature="ai" ──
// 只截两处宿主所在的小窗口再断言：整份 index.html 参与 assert 输出会淹掉失败信息。
test('index.html：侧栏 AI 项与搜索框口语按钮都挂了 data-feature="ai"', () => {
  const nav = HTML.slice(HTML.indexOf('data-tab="ai-music"') - 40, HTML.indexOf('data-tab="ai-music"') + 120);
  assert.match(nav, /data-feature="ai"/, '侧栏 AI 创作项没挂开关宿主');
  assert.match(nav, /onclick="switchTab\('ai-music'/, '侧栏宿主应是那个导航按钮本身');
  const nl = HTML.slice(HTML.indexOf('doNaturalSearch()') - 120, HTML.indexOf('doNaturalSearch()') + 40);
  assert.match(nl, /data-feature="ai"/, '搜索页 ✨ 口语搜索按钮没挂开关宿主');
  assert.strictEqual((HTML.match(/data-feature="ai"/g) || []).length, 2,
    'AI 宿主数变了 —— 要么加了新入口（该挂的要挂），要么摘掉了（钉要跟着收）');
  assert.match(APP_JS, /applyFeatureFlags\(/, '启动时没人调用 applyFeatureFlags，摘除不会发生');
});

// ── ⑥ 反漂移：开关值只准一处，全 renderer 不许再手写第二份 ──
test('开关登记表只有一处：其它文件不得再手写特性值', () => {
  const feats = read('src/renderer/js/features.js');
  assert.match(feats, /ai:\s*false/, 'FEATURES 里 AI 这一项得显式写着 false');
  const secondCopy = /FEATURES\s*[:=]|\bai:\s*(true|false)\b/;
  const offenders = [];
  for (const rel of ['src/renderer/js/app.js', 'src/renderer/js/commandPalette.js',
    'src/renderer/js/router.js', 'src/renderer/js/views/search.js', 'src/renderer/index.html']) {
    if (secondCopy.test(read(rel))) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [], '出现了第二份特性开关值 —— 翻开关时要改两处即漂移');
});
