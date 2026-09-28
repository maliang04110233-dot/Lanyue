/**
 * 浮层注册表——data-attribute 契约（148/151/185「手抄清单必漏」律的第四次立法）
 * 偿还建层时登记的六浮层 Esc 债 + ⑩ 把 HTML 契约属性送上实弹桥接
 * 把注册表推到动态层——⑪ 形状巡扫钉住「造浮层必自报」，⑫ 实弹选样
 * 动态层 Esc 契约首批偿还——⑬ 全量对账台账（28 枚动态自报点逐枚授契约/立豁免），
 *          ⑭ '-' 哨兵实弹选样（睡眠定时自定义弹层：开→Esc→离场→守卫清空），
 *          ⑮ display 切换单例成对摘除钉（M5 变异逃逸后补立：收起只改 display 不摘契约=幽灵浮层永吞 Esc）
 *
 * 来龙：_anyModalOpen() 与 closeActiveModal() 各自手抄了一份浮层 id 清单。
 * 195 实测抓到活体证据：cmdkOverlay 从来不在两份清单里——背景键守卫与 Esc
 * 关闭对命令面板双双失明，195 只能靠面板自己的 capture 围堵做第二保险。
 * 巡扫还照出更老的反例：shortcutsHelp/convertModal/dlTemplateEditorModal/
 * playlistTrashModal 同样不在 _anyModalOpen 表里——浮层开着按 Space 会触发
 * 全局播放/暂停（130 行的守卫漏它们）。清单每加一个浮层就要记得改两处，
 * 而事实证明没人记得。
 *
 * 修法（本文件钉的就是这个契约）：浮层身份写进浮层自己的 DOM——
 *   data-modal                裸属性：计入背景键守卫面（_anyModalOpen 扫描）
 *   data-modal-close="fn|-"   Esc 可关：fn=调 window[fn]()；'-' 哨兵=直接 remove()
 *   data-modal-pri="N"        多层同开时按降序逐层关（缺省 0，同序稳定=DOM 序）
 * 两份手抄拆掉，注册表 = DOM 本身。esc-closable 五枚（help 100 / cmdk 95 /
 * playlist 90 / edit 80 / settings 70）完整保住 legacy 的关闭次序；
 * 建层时其余只入守卫面——「六浮层 Esc 不可关」作为登记债由 ⑥ 的反裸登记
 * 钉锁住，199 逐视图核实关闭语义后全额偿还（见 ⑥ CLOSABLE 注释与 ⑩ 实弹桥接）。
 *
 * RED 形状预告：①⑤ 首轮会死在桩的选择器 throw 上——legacy _anyModalOpen 末行
 * 查 '.welcome-overlay' 类选择器，不在承诺面内。桩拒绝为旧清单编造答案，
 * 这个 throw 本身就是手抄清单的验尸报告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDomStub, dispatchKey } from './helpers/dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const readFile = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

const req = createRequire(import.meta.url);
const SHORTCUTS_PATH = R('js', 'shortcuts.js');
const PALETTE_PATH = R('js', 'commandPalette.js');

async function loadFresh(absPath, qtag) {
  try { delete req.cache[req.resolve(absPath)]; } catch (_e) { /* ESM 时代无此缓存项 */ }
  return import(pathToFileURL(absPath).href + '?' + qtag + '=' + Math.random());
}

/** 装一个带全局环境的 shortcuts.js 新鲜实例（IIFE 会在 import 时挂 document 监听）。 */
async function loadShortcuts(doc) {
  global.document = doc;
  global.window = {
    location: { hostname: 'localhost', protocol: 'file:' },
    addEventListener: () => {},
  };
  global.window.document = doc;
  return loadFresh(SHORTCUTS_PATH, 'sr');
}

/** 造一个浮层：mod=带 data-modal；close/pri=关闭契约；hidden=初始收起。 */
function addModal(doc, { mod = true, close, pri, hidden = false, tag = 'div' } = {}) {
  const el = doc.createElement(tag);
  if (mod) el.setAttribute('data-modal', '');
  if (close !== undefined) el.setAttribute('data-modal-close', close);
  if (pri !== undefined) el.setAttribute('data-modal-pri', String(pri));
  if (hidden) el.classList.add('hidden');
  doc.body.appendChild(el);
  return el;
}

// ── ① 守卫面按形状扫描：可见的 data-modal 即在场，hidden 即离场 ──
// RED 形态：legacy 的 getElementById 清单不认识测试浮层，末行 '.welcome-overlay'
// 类选择器被本家桩按承诺面 ⑦ 直接 throw——旧清单在桩面前无处遁形。
test('① 守卫面按形状扫描：可见的 data-modal 即在场，hidden 即离场', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  assert.equal(sc._anyModalOpen(), false, '无浮层时守卫面应为空');
  const closed = addModal(doc, { hidden: true });
  assert.equal(sc._anyModalOpen(), false, 'hidden 的浮层不算在场');
  const open = addModal(doc, {});
  assert.equal(sc._anyModalOpen(), true, '可见 data-modal 即在场');
  open.classList.add('hidden');
  assert.equal(sc._anyModalOpen(), false, '收起后即刻离场（class 是活的，不是开层时快照）');
  closed.remove();
});

// ── ② Esc 按 data-modal-pri 降序逐层关；同开只关一层；关成后 preventDefault ──
test('② Esc 按 data-modal-pri 降序逐层关；同开只关一层；关成后 preventDefault', async () => {
  const doc = makeDomStub();
  await loadShortcuts(doc); // 只吃它的 IIFE 挂监听副作用，②全程走实弹 dispatchKey
  // DOM 序故意为 B→A→C：若实现按 DOM 序偷懒关闭，A(pri=90) 就不会第一个倒下
  const b = addModal(doc, { close: 'closeB', pri: 80 });
  const a = addModal(doc, { close: 'closeA', pri: 90 });
  const c = addModal(doc, { close: 'closeC' }); // 无 pri → 缺省 0，最后
  const calls = [];
  const hide = (el, name) => () => { calls.push(name); el.classList.add('hidden'); };
  global.window.closeA = hide(a, 'closeA');
  global.window.closeB = hide(b, 'closeB');
  global.window.closeC = hide(c, 'closeC');

  const ev1 = dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeA'], '第一层 Esc 只关最高优先级（A，尽管 B 在 DOM 里更靠前）');
  assert.equal(ev1.defaultPrevented, true, '关了一层就该吃掉这次 Esc');

  dispatchKey(doc, 'Escape', doc.body);
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeA', 'closeB', 'closeC'], '连按逐层下台阶（pri 降序，缺省 0 殿后）');

  const ev4 = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(calls.length, 3, '全部收起后注册表无事可做');
  assert.equal(ev4.defaultPrevented, false, '没人可关时不吞键（legacy 语义：false→不 preventDefault）');
});

// ── ③ '-' 哨兵：无导出关闭函数的浮层（帮助弹层）由注册表直接摘除 ──
test('③ 短横哨兵 close="-"：无导出关闭函数的浮层由注册表直接摘除', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  const el = addModal(doc, { close: '-', pri: 100 });
  assert.ok(sc.closeActiveModal(), "'-' 浮层可关 → true");
  assert.ok(!doc.body.children.includes(el), "注册表按 '-' 摘除节点本体");
  assert.equal(sc._anyModalOpen(), false, '摘除后守卫面清空');
});

// ── ④ 守卫-only 浮层（只带 data-modal）：拦背景键，但 Esc 不越权代关 ──
// 绿即所愿：legacy 里这四枚子 modal Esc 本就关不掉，本测防的是实现"顺手过正"
// ——在逐视图关闭语义未核实前，注册表不许自作主张。
test('④ 守卫-only 浮层（只带 data-modal）：拦背景键，但 Esc 不越权代关', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  const el = addModal(doc, {});
  assert.equal(sc._anyModalOpen(), true, '守卫-only 也算在场（Space/searchListKey 让位）');
  assert.equal(sc.closeActiveModal(), false, '未登记关闭契约的浮层，Esc 不得动它');
  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, false, '未关成就不吃 Esc');
  assert.ok(doc.body.children.includes(el), '浮层本体原封不动');
});

// ── ⑤ 命令面板实弹：195 的账在这里还——面板开，注册表必须看得见、关得掉 ──
test('⑤ 命令面板实弹：195 的账在这里还——面板开，注册表必须看得见、关得掉', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  global.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
  const pal = await loadFresh(PALETTE_PATH, 'pc');
  global.window.switchTab = () => {};
  const bgBtn = doc.createElement('button');
  doc.body.appendChild(bgBtn);
  bgBtn.focus();
  pal.openCommandPalette();

  assert.equal(sc._anyModalOpen(), true, '面板开着 = 守卫在场（手抄清单时代的 cmdkOverlay 盲区就此封堵）');
  const overlay = doc.getElementById('cmdkOverlay');
  assert.ok(overlay, '面板宿主就位');
  assert.equal(overlay.getAttribute('data-modal-close'), 'closeCommandPalette');
  assert.equal(overlay.getAttribute('data-modal-pri'), '95');

  assert.equal(sc.closeActiveModal(), true, '注册表该能关面板');
  assert.ok(overlay.classList.contains('hidden'), '关闭走面板自己的 teardown（挂 hidden），而非注册表越权拆节点');
  assert.equal(sc._anyModalOpen(), false, 'teardown 后离场');
});

// ── ⑥ index.html 全量对账：守卫面浮层必有去向——授关闭契约或登记为债（反裸登记） ──
test('⑥ index.html 全量对账：浮层要么授关闭契约、要么在 DEBT 立债，新漏对账即红', async () => {
  const html = readFile('index.html');
  const CLOSABLE = {
    playlistModal: ['closePlaylistModal', '90'],
    editOverlay: ['closeEdit', '80'],
    settingsOverlay: ['closeSettings', '70'],
    // 199 偿还：六枚关闭语义逐视图核实——函数体全是纯「hidden + 状态复位」，
    // 无写盘无破坏副作用；且六枚背景早就是「点背景即关」（onclick 里
    // event.target===this && closeXxx()），Esc 只是既有可供性的键盘同义。
    // pri 按层叠定：editor/select 会从 detail 之上打开（92/93 > 88），
    // dlTemplateEditor 在设置页内打开（75 > settingsOverlay 70，否则 Esc 先关宿主、子层悬空）。
    convertModal: ['closeConvertModal'],
    dlTemplateEditorModal: ['closeDlTemplateEditor', '75'],
    playlistDetailModal: ['closePlaylistDetail', '88'],
    playlistEditorModal: ['closePlaylistEditor', '92'],
    playlistTrashModal: ['closePlaylistTrash'],
    playlistSelectModal: ['closePlaylistSelectModal', '93'],
  };
  const DEBT = []; // 198 登记六笔，199 还清；新浮层裸挂 data-modal 未授契约必须先在此立债（附核实计划）
  const seen = new Set();
  for (const m of html.matchAll(/<div[^>]* data-modal[ >][^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])[1];
    assert.ok(!seen.has(id), id + ' 重复登记？');
    seen.add(id);
    if (DEBT.includes(id)) {
      assert.ok(!m[0].includes('data-modal-close='), id + ' 在债册中，不应已授关闭契约');
      continue;
    }
    assert.ok(id in CLOSABLE, id + ' 未对账——新浮层须先补 ⑩ 桥接测再授契约或立债（反裸登记钉）');
    const [fn, pri] = CLOSABLE[id];
    assert.ok(m[0].includes('data-modal-close="' + fn + '"'),
      id + ' 应登记关闭契约 data-modal-close="' + fn + '"');
    if (pri) assert.ok(m[0].includes('data-modal-pri="' + pri + '"'),
      id + ' 应带优先级 ' + pri);
  }
  for (const id of [...Object.keys(CLOSABLE), ...DEBT]) {
    assert.ok(seen.has(id), id + ' 在册但 DOM 缺席——浮层被搬走/改名，对账册须同步');
  }
  // 契约函数必须真挂在 window 上：注册表按 window[name] 找函数，
  // 挂空 = 每次 Esc 白吃不放行（closeActiveModal 对缺席函数仍返回 true 的 legacy 语义）
  const srcs = ['js/app.js', 'js/views/local.js', 'js/views/settings.js',
    'js/views/playlist.js', 'js/converter-core.js', 'js/commandPalette.js', 'js/shortcuts.js']
    .map((f) => readFile(f)).join('\n');
  for (const [fn] of Object.values(CLOSABLE)) {
    assert.ok(new RegExp('window\\.' + fn + '\\s*=').test(srcs),
      fn + ' 必须挂 window（注册表按 window 寻函数）');
  }
});

// ── ⑦ 反向钉：两份手抄必须死透（短路与 legacy 清单的任何复辟形状都不许留） ──
test('⑦ 反向钉：两份手抄必须死透（短路与 legacy 清单的任何复辟形状都不许留）', async () => {
  const src = readFile('js/shortcuts.js');
  const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' 应仍存在');
    return m[0];
  };
  const scan = grab('_anyModalOpen');
  const close = grab('closeActiveModal');
  for (const [where, body] of [['_anyModalOpen', scan], ['closeActiveModal', close]]) {
    assert.ok(!body.includes('getElementById'), where + ' 不许再按 id 点名（手抄清单复辟形状）');
    assert.ok(!body.includes('const ids'), where + ' 不许再藏 id 数组');
    assert.ok(!/playlistModal|editOverlay|settingsOverlay|cmdkOverlay|shortcutsHelp|welcome/.test(body),
      where + ' 不许出现具体浮层名');
  }
  assert.ok(scan.includes('[data-modal'), '_anyModalOpen 应改为按注册表形状扫描');
  assert.ok(close.includes('[data-modal-close'), 'closeActiveModal 应改为按注册表形状扫描');
  assert.ok(!src.includes("'.welcome-overlay'"),
    'welcome 的守卫改走 data-modal 属性，类名暗号从 shortcuts.js 退役');
});

// ── ⑧ 帮助浮层就地注册：创建点挂身份 + '-' 契约 + 最高优先级；实弹 Esc 摘除 ──
test('⑧ 帮助浮层就地注册：创建点挂身份 + 短横哨兵契约 + 最高优先级；实弹 Esc 摘除', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  sc.showShortcutsHelp();
  const help = doc.getElementById('shortcutsHelp');
  assert.ok(help, '帮助浮层已创建');
  assert.notEqual(help.getAttribute('data-modal'), null, '帮助浮层自报家门（守卫面曾漏它 → Space 漏按全局播放）');
  assert.equal(help.getAttribute('data-modal-close'), '-');
  assert.equal(help.getAttribute('data-modal-pri'), '100', '帮助永远最先倒下（legacy「优先关闭」注释的属性化）');

  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, true, '实弹 Esc 经 handleKey→注册表关帮助（legacy 行为保真）');
  assert.equal(doc.getElementById('shortcutsHelp'), null, '帮助浮层被摘除');
});

// ── ⑨ 桩自测（扫描器自带自测律）：承诺面 ⑦ 的四种形状 + 未知形式必须炸 ──
test('⑨ 桩自测（扫描器自带自测律）：承诺面 ⑦ 的四种形状 + 未知形式必须炸', async () => {
  const doc = makeDomStub();
  const plain = doc.createElement('div');
  plain.setAttribute('data-x', '');
  const also = doc.createElement('div');
  also.setAttribute('data-x', 'anything');
  also.classList.add('hidden');
  const named = doc.createElement('div');
  named.id = 'zz-top';
  const btn = doc.createElement('button');
  doc.body.appendChild(plain); doc.body.appendChild(also); doc.body.appendChild(named); doc.body.appendChild(btn);

  assert.equal(doc.querySelectorAll('[data-x]').length, 2, '[attr] 认属性存在，值为空串也算');
  assert.equal(doc.querySelector('[data-x]:not(.hidden)'), plain, ':not(.cls) 按 token 剔除');
  assert.equal(doc.querySelector('#zz-top'), named, 'document 级从 body 起走');
  assert.equal(doc.body.querySelectorAll('button')[0], btn, "tag 形式不回归");
  assert.throws(() => doc.querySelector('.welcome-overlay'), /桩只承诺/,
    '未知形式宁可炸，不静默答"无一人"');
});

// ── ⑩ HTML 契约实弹桥接：从 index.html 读契约属性注入桩，注册表按 HTML 所言实弹关闭 ──
// 钉住「HTML 属性不是死文本」：⑥ 所定的 pri 层叠必须在 closeActiveModal 一层为真。
// 属性逐字从 HTML 抄，不手搓——HTML 改了契约，这里的剧本自动跟（或对不上账即红）。
test('⑩ HTML 契约实弹桥接：叠层浮层按 HTML 所定次序逐层关', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc); // IIFE 挂 handleKey，全程走实弹 dispatchKey
  const html = readFile('index.html');
  const els = {};
  for (const m of html.matchAll(/<div[^>]* data-modal[ >][^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])[1];
    const el = doc.createElement('div');
    el.id = id;
    el.classList.add('hidden');
    el.setAttribute('data-modal', ''); // 正则已筛过带此属性的 div，原样复刻
    const cm = /data-modal-close="([^"]+)"/.exec(m[0]);
    const pm = /data-modal-pri="([^"]+)"/.exec(m[0]);
    if (cm) el.setAttribute('data-modal-close', cm[1]);
    if (pm) el.setAttribute('data-modal-pri', pm[1]);
    doc.body.appendChild(el); // 注入序 = 文档序，② 的稳定排序承诺继续成立
    els[id] = el;
  }
  for (const id of ['playlistDetailModal', 'playlistEditorModal', 'playlistSelectModal',
    'playlistTrashModal', 'settingsOverlay', 'dlTemplateEditorModal']) {
    assert.ok(els[id], id + ' 四件套缺席，桥接剧本无主角');
  }
  const calls = [];
  for (const el of Object.values(els)) {
    const fn = el.getAttribute('data-modal-close');
    if (fn) global.window[fn] = () => { calls.push(fn); el.classList.add('hidden'); };
  }
  const open = (...ids) => {
    for (const el of Object.values(els)) el.classList.add('hidden');
    ids.forEach((i) => els[i].classList.remove('hidden'));
    calls.length = 0;
  };

  open('playlistDetailModal', 'playlistEditorModal');
  assert.equal(sc._anyModalOpen(), true, '叠层在场 = 守卫面在场');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistEditor'], 'editor 盖在 detail 上：先关顶层（92>88），不是底层的 detail');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistEditor', 'closePlaylistDetail'], '再按关底层——逐层退');
  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, false, '两层都收起后 Esc 交还自由');

  open('playlistDetailModal', 'playlistSelectModal');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistSelectModal'], '加入歌单浮层盖 detail：select 先关（93>88）');

  open('settingsOverlay', 'dlTemplateEditorModal');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeDlTemplateEditor'], '模板编辑器寄在设置页内：先关子再关母（75>70），否则宿主倒下子层悬空');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeDlTemplateEditor', 'closeSettings'], '子退位后母才走');

  open('playlistTrashModal');
  assert.equal(sc._anyModalOpen(), true, '回收站浮层在场');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistTrash'], '独开一枚缺省 pri 的浮层也关得动');
  assert.equal(sc._anyModalOpen(), false, '关闭函数挂 hidden 即离场（契约与守卫面同一事实源）');
});

// ── ⑪ 动态浮层自报钉（形状巡扫）：198 的律在动态层的第五次适用 ──
// 来龙：198/199 收口的都是 index.html 里的静态浮层。巡扫照出动态层的同型盲区：
// 20 个 JS 文件用 createElement + className/id 赋 '…Overlay/…Modal' 造浮层挂 body，
// 一个都不自报 data-modal——它们在各自视图里开着时，_anyModalOpen 一律失明，
// Space 全局播放/暂停与其余背景键从探雷器、睡眠定时、批量导入……背后漏过。
// 修法与 198 同构：不建第三份清单（那正是被拆掉的东西），钉按形状判定——
// 凡是「给元素赋 overlay/modal 名 + 挂 body」的文件，自报数必须盖过创建点数。
// 新写一个浮层忘了自报，CI 即红，不需要任何人记得往哪份名单补一行。
// contextMenu.js 故意不在打击面：右键菜单是瞬态指针跟随物（mousedown 即散），
// 归它自己的 _onKey/detach 管，与"模态挡背景"不是同一语义——如日后改判
// 需要入守卫面，届时它以自报过钉，无需动本测。
test('⑪ 动态浮层自报钉（形状巡扫）：造 overlay/modal 挂 body 的文件必须自报 data-modal', async () => {
  const JS_ROOT = R('js');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(JS_ROOT);
  const CREATE = /(?:^|\s)(\w+)\.(?:className|id)\s*=\s*['"][^'"]*(?:[Oo]verlay|[Mm]odal)[^'"]*['"]/;
  const SELF = /setAttribute\(\s*['"]data-modal['"]/;
  const leaks = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (!CREATE.test(src) || !src.includes('document.body.appendChild')) continue;
    // 点级对账：数「创建点」（同变量的 id/className 连续赋值算一块）。只按文件级
    // 判"有自报即绿"的话，同文件第二枚新浮层忘自报会漏网（变异 M4 首轮实证的短板）。
    const lines = src.split('\n');
    let sites = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = CREATE.exec(lines[i]);
      if (!m) continue;
      const blockRe = new RegExp('^\\s*' + m[1] + '\\.(?:id|className)\\s*=');
      let j = i;
      while (j + 1 < lines.length && blockRe.test(lines[j + 1])) j++;
      sites += 1;
      i = j;
    }
    const selfs = (src.match(new RegExp(SELF.source, 'g')) || []).length;
    if (selfs < sites) leaks.push(path.relative(JS_ROOT, f).replace(/\\/g, '/') + '（创建点 ' + sites + ' > 自报 ' + selfs + '）');
  }
  assert.deepEqual(leaks, [], '动态创建的浮层必须逐点自报守卫身份（开着时背景键不得漏过）：\n' + leaks.join('\n'));
});

// ── ⑫ 动态浮层实弹选样：确认弹层（全应用最高频模态）在守卫面进得场、出得干净 ──
// ⑪ 是创建点级对账钉，防的是「忘了自报」；⑫ 防的是「自报了却不对」——生命周期
// 真实走一遭：askConfirm 挂 body → _anyModalOpen 真 → 走它自己的取消钮收起
// （overlay.remove()，非 hidden 切换）→ 守卫面即刻清空。remove 与 hidden 两条
// 离场路都要被 :not(.hidden) 扫描正确消化，这里钉 remove 这条（动态层的常态）。
test('⑫ 动态浮层实弹选样：确认弹层开着守卫必须看得见，remove 收起即刻离场', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  const cd = await loadFresh(R('js', 'confirmDialog.js'), 'cf');
  const pending = cd.askConfirm('确认清空所有下载任务？');

  const overlay = doc.querySelector('[data-modal]');
  assert.ok(overlay, '确认框宿主已自报 data-modal（⑪ 的形状在真创建点生效）');
  assert.equal(overlay.getAttribute('data-modal-close'), null,
    '守卫-only：本增量不越权授 Esc 契约——confirm 的键盘归属自成一家（182/186），逐层核实是后账');
  assert.equal(sc._anyModalOpen(), true, '确认框在场 = Space/背景键让位（此前它开着照样漏）');

  const cancel = doc.body.querySelectorAll('button')
    .find((b) => (b.className || '').split(/\s+/).includes('confirm-dialog-cancel'));
  assert.ok(cancel, '取消钮在位');
  cancel.click();
  await pending;
  assert.equal(sc._anyModalOpen(), false, 'overlay.remove() 后守卫面即刻清空');
});

// ── ⑬ 动态层全量对账：每一枚 data-modal 自报点都要在台账里安家（授契约或立豁免）──
// 来龙：201 开了守卫面的动态层口子，但「Esc 关得掉吗」仍是欠账——28 枚
// 动态自报点里只有 2 枚早带契约（cmdk 95 / help 100），3 枚自管豁免
// （confirmDialog=182/186 的焦点围堵自成一家；welcome=193 的 Esc 走 welcomeLater
// 有持久写盘，绝非纯摘除，交给注册表反而绕开保守出口；home chart=开合挂卸自己的
// _chartEscHandler），其余 23 枚本轮逐枚核实后授契约：
//   · 13 枚授 '-' 哨兵——其背景关闭本体就是 remove()/等价的 getElementById+remove
//     纯摘除（含 artistGroups 这种 id 动态传入、注册表不可能按名寻函数的），
//     浮层自身即全部状态，无名可授也无复位可丢；
//   · 9 枚授具名函数——背景钮 onclick 调的就是该函数（键盘同义），其中
//     closeBatchImport/closeNameBatch 的 _running/_searching 拦截在函数体内，
//     Esc 与点背景走同一道闸门，守卫语义零特化；
//   · lyricEditor 是常驻 DOM 单例，收起=隐藏+摘身份，'-' 会把家拆了——新挂
//     window.closeLyricEditor 具名出口。
// 层叠实证仅一对：诊断面板开着时可从内部弹失败报告（_renderFailReport 不关 diag），
// failReport 授 pri=10 顶层先关；其余「无叠层实证，不臆造优先级」（199 同口径）。
// 台账格式：文件 → 按创建点出现序的契约列表；null=自管豁免；'-'/具名 加 :pri=N 后缀。
// 新浮层裸挂不立账=红、契约与账不符=红、具名函数没挂 window=红（注册表按
// window[fn] 寻函数，挂空=每次 Esc 白吃不放行——⑥ 同款反向钉推到动态层）。
test('⑬ 动态层 Esc 契约全量对账：28 枚自报点逐枚授契约或立豁免', async () => {
  const JS_ROOT = R('js');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(JS_ROOT);
  const srcOf = {};
  for (const f of files) srcOf[path.relative(JS_ROOT, f).replace(/\\/g, '/')] =
    fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

  const GRANTS = {
    'afterQueueDone.js': ['fn:cancelAfterQueueCountdown'],
    'artistGroups.js': ['-'],
    'batchProbe.js': ['fn:closeProbeReport'],
    'commandPalette.js': ['fn:closeCommandPalette:pri=95'],
    'confirmDialog.js': [null],
    'diagnose.js': ['-', '-:pri=10'],
    'dismissed.js': ['-'],
    'folderGroups.js': ['-'],
    'historyTrend.js': ['-'],
    'lyricEditor.js': ['fn:closeLyricEditor'],
    'player/stats.js': ['-'],
    'scheduledDownload.js': ['fn:closeScheduledPanel'],
    'shortcuts.js': ['-:pri=100'],
    'sleepTimer.js': ['-'],
    'songGroups.js': ['fn:closeSongGroupsModal'],
    'views/ai-music.js': ['-', '-'],
    'views/batchImport.js': ['fn:closeBatchImport'],
    'views/home.js': [null],
    'views/local-stats.js': ['-', '-'],
    'views/local.js': ['-'],
    'views/nameBatch.js': ['fn:closeNameBatch'],
    'views/playlist.js': ['fn:closePlaylistAddSongs', 'fn:closePlaylistMergePicker', '-'],
    'views/welcome.js': [null],
  };

  const problems = [];
  const named = [];
  for (const [file, src] of Object.entries(srcOf)) {
    const lines = src.split('\n');
    const sites = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /(?:^|\s)(\w+)\.setAttribute\(\s*['"]data-modal['"]\s*,\s*['"]['"]\s*\)/.exec(lines[i]);
      if (!m) continue;
      const v = m[1];
      let close;
      let pri;
      for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
        const c = new RegExp(v + '\\.setAttribute\\(\\s*[\'"]data-modal-close[\'"]\\s*,\\s*[\'"]([^\'"]*)[\'"]').exec(lines[j]);
        if (c) { close = c[1]; break; }
      }
      for (let j = i + 1; j <= Math.min(i + 6, lines.length - 1); j++) {
        const q = new RegExp(v + '\\.setAttribute\\(\\s*[\'"]data-modal-pri[\'"]\\s*,\\s*[\'"]([0-9]+)[\'"]').exec(lines[j]);
        if (q) { pri = q[1]; break; }
      }
      sites.push({ close, pri });
    }
    if (!sites.length) continue;
    const want = GRANTS[file];
    if (!want) { problems.push(file + '：新增自报点未立账 ' + JSON.stringify(sites)); continue; }
    if (want.length !== sites.length) {
      problems.push(file + '：台账 ' + want.length + ' 枚 ≠ 实际创建点 ' + sites.length + ' 枚');
      continue;
    }
    sites.forEach((s, k) => {
      const w = want[k];
      if (w === null) {
        if (s.close !== undefined) problems.push(file + '#' + k + '：豁免浮层被人授了契约「' + s.close + '」——自管键盘被抢归属');
        return;
      }
      const mm = /^(fn:[^:]+|-)(?::pri=([0-9]+))?$/.exec(w);
      assert.ok(mm, '台账格式自校验：' + w);
      const wantClose = mm[1] === '-' ? '-' : mm[1].slice(3);
      if (s.close !== wantClose) problems.push(file + '#' + k + '：契约「' + s.close + '」≠ 台账「' + w + '」');
      const wantPri = mm[2];
      if (s.pri !== wantPri) problems.push(file + '#' + k + '：pri「' + s.pri + '」≠ 台账「' + wantPri + '」');
      if (wantClose !== '-') named.push(wantClose);
    });
  }
  for (const fn of named) {
    const mounted = Object.values(srcOf).some((src) => new RegExp('window\\.' + fn + '\\s*=').test(src));
    assert.ok(mounted, '具名关闭函数必须挂 window（注册表按 window[fn] 寻函数）：' + fn);
  }
  assert.deepEqual(problems, [], '动态浮层的 Esc 契约必须逐枚立账——裸挂、擅改、抢自管皆红：\n' + problems.join('\n'));
});

// ── ⑭ 动态层实弹选样：'-' 哨兵从真创建点到真注册表一枪打穿 ──
// 选睡眠定时自定义弹层（sleepTimer.openSleepCustomDialog）：纯 createElement、
// 背景点击=摘除，'-' 契约的标本。RED 阶段死因=契约缺席（201 只入守卫面）。
test('⑭ 动态层实弹选样：睡眠自定义弹层登记「-」哨兵，Esc 当场摘除守卫清空', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  await loadFresh(R('js', 'sleepTimer.js'), 'spt');
  assert.equal(typeof global.window.openSleepCustomDialog, 'function',
    'sleepTimer 在桩环境可加载且桥接函数在位');
  global.window.openSleepCustomDialog();
  const overlay = doc.querySelector('[data-modal-close]');
  assert.ok(overlay, '自定义弹层开着且带 Esc 契约（RED 阶段缺的就是这枚属性）');
  assert.equal(overlay.getAttribute('data-modal-close'), '-',
    '「-」：纯摘除关闭与背景等价，浮层自身即全部状态');
  assert.equal(sc._anyModalOpen(), true, '弹层在场=守卫在场');
  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, true, 'Esc 被注册表吃掉（顶层摘除）');
  assert.equal(sc._anyModalOpen(), false, 'remove() 后守卫面即刻清空');
  const ev2 = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev2.defaultPrevented, false, '无浮层可关时 Esc 交还自由');
});

// ── ⑮ display 切换单例成对摘除钉（形状巡扫）──
// M5 变异逃逸补立的账：注册表关闭选择器只过滤 .hidden 类，不认识 style.display——
// 收起走 display='none' 的常驻单例若把 data-modal-close 留在 DOM 上，就成了永远
// 在场又关不掉的幽灵浮层，每次全局 Esc 被它白吃。此钉按形状扫全动态层：
// 同一变量既挂 data-modal 身份、又被 display='none' 收起，收起点 +6 行内必须
// 成对摘除身份与契约，缺一即红。RED 证据=变异 M5（摘掉 removeAttribute 那行⑮即红）。
test('⑮ display 切换单例必须成对摘身份与契约（幽灵 Esc 形状钉）', () => {
  const JS_ROOT = R('js');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(JS_ROOT);
  const problems = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const modalVars = new Set();
    for (const ln of lines) {
      const m = ln.match(/(\w+)\.setAttribute\(\s*['"]data-modal['"]/);
      if (m) modalVars.add(m[1]);
    }
    lines.forEach((ln, i) => {
      const m = ln.match(/(\w+)\.style\.display\s*=\s*['"]none['"]/);
      if (!m || !modalVars.has(m[1])) return;
      const v = m[1];
      const win = lines.slice(i, i + 7).join('\n');
      const stripped = win.includes(v + ".removeAttribute('data-modal')")
        && win.includes(v + ".removeAttribute('data-modal-close')");
      if (!stripped) {
        problems.push(path.relative(JS_ROOT, f).replace(/\\/g, '/') + ':' + (i + 1)
          + ' ' + v + ' 以 display 收起却未成对摘除 data-modal/data-modal-close（幽灵浮层永吞 Esc）');
      }
    });
  }
  assert.deepEqual(problems, []);
});

