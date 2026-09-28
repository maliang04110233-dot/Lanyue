/**
 * 命令面板（Ctrl/⌘+K）的键盘/焦点契约——182 三件套推广到第三个模态。
 *
 * 来龙（全部实测于改动前的 commandPalette.js，非推测）：面板是全站最常被键盘唤起
 * 的浮层，却没有一条键盘契约——
 * ① open 用 setTimeout(…,30) 延后聚焦：30ms 窗口里键无处安放，测试面也无法
 *    同步断言"呼出即可打字"；
 * ② close 只 put 一个 hidden 类：焦点凭空丢（182/193 立的"归还 opener"没人履约），
 *    键盘用户 Ctrl+K 用完一次，Tab 得从页面头重新爬；
 * ③ 无封层：面板开着，键照样漏给 document 冒泡层的 shortcuts.js handleKey 与
 *    模块自己的 onGlobalKey——焦点一旦不在输入框（见⑥），↑↓Enter 会同时驱动
 *    背景搜索列表（shortcuts.js 的 searchListKey 分支只认 activeElement 是否
 *    在输入框，而 _anyModalOpen() 的手抄清单里根本没有 cmdkOverlay）；
 * ④ 无 Tab 陷阱：Tab 一走就出面板，背景导航钮全部可达，模态形同虚设；
 * ⑤ Esc 语义本身没错（关面板不写任何持久状态），但焦点一旦 Tab 出面板，
 *    Esc 走到 shortcuts.js 的 closeActiveModal()——那串手抄 id 清单同样没有
 *    cmdkOverlay，Esc 关不掉面板，Ctrl+K 又 toggles，用户被自己的面板锁死；
 * ⑥ 无 role=dialog/aria-modal：读屏软件不知道"世界被换成了面板"；
 * ⑦ IME 黑洞：placeholder 明晃晃写着"输入命令名 / 拼音 / 别称"，可 Enter 处理
 *    不看 isComposing——拼音候选挂着时按回车是"选字"，面板却当成"执行高亮命令"，
 *    中文用户还没打完字面板就炸了（arrow 同理，翻页键被面板抢走）。
 *
 * 修法画像（实现层，本文件先立法）：capture 围堵承 193「让位优先于围堵」——
 * hasOpenConfirm() 先让位，随后 stopImmediatePropagation 封层；封层后 Ctrl+K
 * 的 toggle 通道必须由面板自己实现（否则自家围堵反手掐死自己的召唤键，面板
 * 开得出关不回）；Tab/Shift+Tab 在面板 focusables 间循环且 preventDefault；
 * ↑↓/Enter 从输入框私有监听上收到围堵层统一处理（一个键一个家，输入框监听
 * 与围堵层并存=两处立法），且一律先看 isComposing；关闭走公共 teardown：
 * 摘监听 + hidden + 焦点归还 opener；初始焦点改同步 focus()。
 *
 * 钉形：domStub 行为层（桩承 193 之家，本增量补 classList/getElementById/
 * id 注册/input 解析，见 ⑩ 自测）。⑤⑧ 是防"实现过正"的护栏（预期在修复前
 * 即绿：现状无围堵自然不漏；围堵装上后若忘留 Ctrl+K 通道或忘让位，它们红）。
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
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

const CONFIRM_HREF = pathToFileURL(R('js', 'confirmDialog.js')).href; // 裸 URL：与面板依赖同实例

// 本契约专用 drain：命令体排在 setTimeout(0)，setImmediate 与它同轮竞态、先后
// 不保证（④ 曾因此把 'search' 漏进 ⑦ 的记录器）。注册更晚的 setTimeout(0) 则
// 必然后注册者先不入队、按 FIFO 排在其后——等它落地即保证前面的命令都已执行。
const flush = () => new Promise((r) => setTimeout(r, 0));
const req = createRequire(import.meta.url);
const PALETTE_PATH = R('js', 'commandPalette.js');

async function loadPaletteFresh(doc) {
  try { delete req.cache[req.resolve(PALETTE_PATH)]; } catch (_e) { /* ESM 探测时代无此缓存项 */ }
  global.document = doc;
  global.window = global.window && global.window.location ? global.window : {
    location: { hostname: 'localhost', protocol: 'file:' },
    addEventListener: () => {},
  };
  global.window.document = doc;
  global.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
  return import(pathToFileURL(PALETTE_PATH).href + '?pc=' + Math.random());
}

/**
 * 开一次全新的面板：背景先放一颗"导航钮"当 opener，document 冒泡层放监听
 * 当"背景快捷键收件人"（shortcuts.js 同相位）。返回的 seen 即围堵要挡住的漏面。
 * prefocus=true（默认）模拟"焦点已进面板"的现状（修复前由 30ms 定时器达成、
 * 修复后由同步聚焦达成），让 ②③⑥⑦ 的焦点断言落在真环境里；① 例外——它钉的
 * 就是"open 返回的同一拍焦点已在输入框"，不许测试自己代劳。
 */
async function openPalette(opts = {}) {
  const { prefocus = true } = opts;
  const doc = makeDomStub();
  const bgBtn = doc.createElement('button');
  bgBtn.textContent = '背景导航';
  doc.body.appendChild(bgBtn);
  bgBtn.focus(); // 呼出前的聚焦元素 = opener
  const seen = [];
  doc.addEventListener('keydown', (e) => seen.push(e.key));
  const pal = await loadPaletteFresh(doc);
  const calls = [];
  global.window.switchTab = (tab) => calls.push(['switchTab', tab]);
  pal.openCommandPalette();
  const input = doc.getElementById('cmdkInput');
  if (prefocus && input) input.focus();
  return { doc, pal, seen, calls, overlay: doc.getElementById('cmdkOverlay'), input, bgBtn };
}

const list = (overlay) => overlay.querySelectorAll('button'); // 面板里的命令行钮
const isOpen = (overlay) => !!overlay && !overlay.classList.contains('hidden');

test('① 呼出即可打字：同步聚焦输入框，面板带 dialog/aria-modal 语义', async () => {
  const { doc, overlay, input } = await openPalette({ prefocus: false });
  assert.ok(isOpen(overlay), '面板应可见');
  assert.equal(doc.activeElement, input, 'open 后焦点必须已在输入框（同步，不等定时器）');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
});

test('② Esc 关面板且焦点归还唤起它的元素；不写任何持久状态', async () => {
  const { doc, overlay, bgBtn } = await openPalette();
  dispatchKey(doc, 'Escape', doc.getElementById('cmdkInput'));
  assert.ok(!isOpen(overlay), 'Esc 后面板应隐藏');
  assert.equal(doc.activeElement, bgBtn, '焦点应归还 opener（182/193 规矩）');
  assert.equal(global.localStorage.getItem('cmdkRecents'), null, '只关不执行，最近使用不得被顺手写入');
});

test('③ Enter 执行高亮命令：先关面板归还焦点，下一拍才跑命令', async () => {
  const { doc, pal, overlay, calls, bgBtn } = await openPalette();
  assert.equal(list(overlay).length > 0, true, '空查询应有候选行');
  dispatchKey(doc, 'Enter', doc.getElementById('cmdkInput'));
  assert.ok(!isOpen(overlay), '执行即关');
  assert.equal(doc.activeElement, bgBtn, '执行路径也必须归还 opener');
  assert.deepEqual(calls, [], '命令体不得在关层前同步跑');
  await flush();
  assert.deepEqual(calls, [['switchTab', 'home']], '首行=前往搜歌（发现）');
  assert.equal(typeof pal.openCommandPalette, 'function');
});

test('④ 围堵：面板开着，普通键一个字都不许漏给背景快捷键层', async () => {
  const { doc, seen, calls } = await openPalette();
  for (const k of [' ', 'x', 'ArrowDown', 'Enter']) dispatchKey(doc, k, doc.getElementById('cmdkInput'));
  assert.deepEqual(seen, [], '冒泡层（shortcuts.js 同相位）不应收到任何键');
  // Enter 被围堵层正确消化执行了——命令体排在一拍后，必须就地吸收到本测自己的
  // calls 里，否则它会落进后续测试新装的记录器（⑦ 曾被这样凭空炸出 'search'）
  await flush();
  assert.equal(calls.length, 1, '本测自己消化的 Enter 恰好执行一条命令');
});

test('⑤ 护栏：自家围堵不得掐死 Ctrl+K 的 toggle 通道（开得出也要关得回）', async () => {
  const { doc, overlay } = await openPalette();
  dispatchKey(doc, 'k', doc.getElementById('cmdkInput'), { ctrlKey: true });
  assert.ok(!isOpen(overlay), '面板开着时 Ctrl+K 应关闭面板');
});

test('⑥ Tab 陷阱：焦点只在面板内循环且 preventDefault，背景钮永不可达', async () => {
  const { doc, pal, overlay, input, bgBtn } = await openPalette();
  const ev = dispatchKey(doc, 'Tab', input);
  assert.equal(ev.defaultPrevented, true, 'Tab 必须被拦下（否则焦点爬出面板）');
  const items = list(overlay);
  assert.equal(doc.activeElement, items[0], 'Tab 从输入框应到第一行命令钮');
  // 键盘事件只能从聚焦元素发出（193-② 同款桩语义）：发 Tab 前先把手动到该站
  items[items.length - 1].focus();
  dispatchKey(doc, 'Tab', items[items.length - 1]);
  assert.equal(doc.activeElement, input, '末行再 Tab 回绕到输入框');
  input.focus();
  dispatchKey(doc, 'Tab', input, { shiftKey: true });
  assert.equal(doc.activeElement, items[items.length - 1], 'Shift+Tab 反向回绕');
  bgBtn.focus();
  const ev2 = dispatchKey(doc, 'Tab', bgBtn);
  assert.ok(!ev2.defaultPrevented || doc.activeElement !== bgBtn, '焦点已出面板属既成事实，但不得再有第二次');
  assert.equal(typeof pal.closeCommandPalette, 'function');
});

test('⑦ IME 护身符：拼音未上屏（isComposing）时 Enter/↑↓ 归输入法，面板不得抢', async () => {
  const { doc, pal, overlay, calls } = await openPalette();
  const input = doc.getElementById('cmdkInput');
  dispatchKey(doc, 'Enter', input, { isComposing: true });
  assert.ok(isOpen(overlay), '合成中的 Enter 是"选字"，不得执行命令关面板');
  dispatchKey(doc, 'ArrowDown', input, { isComposing: true });
  await flush();
  assert.deepEqual(calls, [], '合成期间不得有任何命令落地');
  assert.equal(typeof pal.closeCommandPalette, 'function');
});

test('⑧ 让位（承186）：确认框叠在面板上时，面板围堵整体收手，Esc 归确认框', async () => {
  const { doc, overlay } = await openPalette();
  const conf = await import(CONFIRM_HREF);
  let settled = 'pending';
  conf.askConfirm('确认删除该歌单？').then((v) => { settled = v; });
  dispatchKey(doc, 'Escape', doc.getElementById('cmdkInput'));
  await flush();
  assert.equal(conf.hasOpenConfirm(), false, '确认框应先于面板被 Esc 关掉');
  assert.equal(settled, false, 'Esc 对确认框 = 取消（176/182 既有语义，本钉防面板抢键改写它）');
  assert.ok(isOpen(overlay), '让位后面板必须原样开着——Esc 归上面那层，不归面板');
});

test('⑨ 形状钉：面板零内联 onclick；输入框不再自带第二套 keydown 家（一个键一个家）', () => {
  const src = read('js', 'commandPalette.js');
  assert.equal(/onclick\s*=/.test(src), false, '内联桥不留（176 纪律）');
  assert.equal(/setTimeout\(\(\) => input\.focus\(\)/.test(src), false, '同步聚焦后不得残留延时聚焦 hack');
  // 围堵层上收键盘后，输入框私有 keydown 监听就是第二个家——必须拆掉
  assert.equal(/input\.addEventListener\('keydown'/.test(src), false, '键位语义只许在围堵层一处立法');
});

test('⑩ 桩自测：本次新承诺的 DOM 语义与真 DOM 契约一致（寻址表不漂）', async () => {
  const doc = makeDomStub();
  const host = doc.createElement('div');
  host.innerHTML = '<input id="probeIn" class="c1 c2" placeholder="ph"><div id="probeBox" class="box"></div>';
  assert.equal(doc.getElementById('probeIn').tag, 'input', '模板解析出的 id 必须进 getElementById 索引');
  assert.equal(doc.getElementById('probeBox').tag, 'div');
  const probe = doc.getElementById('probeIn');
  assert.equal(probe.getAttribute('placeholder'), 'ph');
  assert.equal(probe.classList.contains('c1'), true);
  probe.classList.toggle('c3');
  assert.equal(probe.className, 'c1 c2 c3', 'classList 必须骑在 className 字符串上（同源）');
  probe.classList.remove('c1');
  assert.equal(probe.classList.contains('c1'), false);
  const wrap = doc.createElement('div');
  wrap.id = 'outer';
  wrap.appendChild(probe);
  assert.equal(wrap.querySelector('#probeIn'), probe, '#id 后代寻物');
  assert.equal(wrap.querySelector('#probeBox'), null, '别人的后代不许串门');
  probe.remove();
  assert.equal(doc.getElementById('probeIn'), null, 'remove 后 id 索引必须摘除');
  const ev = dispatchKey(doc, 'k', null, { ctrlKey: true, isComposing: true });
  assert.equal(ev.ctrlKey, true);
  assert.equal(ev.isComposing, true);
});
