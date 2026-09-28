/**
 * 新手引导层的键盘契约——把 182 的三件套推广到第二个模态。
 * （工号说明：起工时记 187，落库时 187–192 已被并发线用尽，顺延为 193。）
 *
 * 来龙：186 收口 Esc 归属时明记欠账「welcome 层的 Tab/焦点陷阱未立法，本增量只收
 * Esc 归属」。引导层是键盘用户的黑洞：打开后焦点不进去（Tab 从页面背景开始爬，
 * 第一站就是浮层底下看不见的导航钮）、浮层上 4 颗钮全靠内联 onclick 桥接全局函数
 * （node 里不可测、也过不了 CSP 化的将来）、关闭后焦点凭空丢（182 立的"归还 opener"
 * 规矩没人履约）、没有 role=dialog/aria-modal 语义。另有一处行为错配：Esc 走的是
 * closeWelcome()＝永久写 welcomeSeen——UI 上「稍后再说」才是一次性关闭，Esc 作为
 * 无标记的"退出"不该替用户做永久决定，对齐保守出口 welcomeLater()。
 * 层级账：content.css 的 .welcome-overlay 裸写 z-index:1500，压在确认框（--z-overlay
 * =1000）之上——视觉上引导层"盖住"确认框，键盘上却是确认框赢（186），画出来的顶层
 * 和按键归属的顶层两个标准。改走同档 token：确认框永远后挂载，同档 DOM 序即叠序，
 * 视觉与键盘归一。
 *
 * 钉形（domStub 行为层，桩承 182/186 并补三件真 DOM 语义——innerHTML 解析钮、
 * click 冒泡、querySelectorAll 寻焦；三件都已收进 test/helpers/dom-stub.js 这个
 * 唯一的家，186 同址共用，⑧是它的自测）：
 * ①初始焦点落「稍后再说」（保守出口——回车即确认的路径不指向永久关闭）；
 * ②Tab/Shift+Tab 只在 4 钮间循环且 preventDefault（焦点陷阱）；
 * ③Esc＝「稍后再说」：浮层消失但 welcomeSeen 一个字都不写，且按键被封在层内；
 * ④两条关闭路径（Esc / 点「开始使用」）焦点都归还 opener；
 * ⑤确认框叠上时引导层整体让位（承 186）——新装的围堵不得抢在确认框前吞 Tab；
 * ⑥引导层独开时围堵成立：空格不漏给背景播放快捷键；
 * ⑦形状钉：welcome.js 有 role=dialog/aria-modal、模板零内联 onclick（动作走
 *   data-welcome+委托，口径同 176 的"内联桥不留"）；content.css 层级走 token 不裸值；
 * ⑧桩自测：innerHTML 解析出的钮序就是真 DOM 的 Tab 序（寻址表不漂）。
 * RED 预期：①②③④⑥⑦修复前全红（行为缺位），⑤落地即绿（新围堵的护栏面——防的是
 * 本次实现"围堵过头"伤到 186 的让位，变异验证背书）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDomStub, findClass, dispatchKey, flush } from './helpers/dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

const CONFIRM_HREF = pathToFileURL(R('js', 'confirmDialog.js')).href; // 裸 URL：与 welcome 的依赖同实例
const loadConfirm = () => import(CONFIRM_HREF);
const req = createRequire(import.meta.url);
const loadWelcomeFresh = async () => {
  try { delete req.cache[req.resolve(R('js', 'views', 'welcome.js'))]; } catch (_e) { /* ESM 探测时代无此缓存项 */ }
  return import(pathToFileURL(R('js', 'views', 'welcome.js')).href + '?tc=' + Math.random());
};

// ── domStub：从 test/helpers/dom-stub.js 取（收口——桩只有一个家，
// 本文件对它补出的三件真 DOM 语义已在 helper 里，186 同址共用；⑧是它的自测）──

/**
 * 起一层全新引导浮层。opts.opener=true 时先在背景聚焦一颗"菜单钮"（测焦点归还）。
 * 返回 { doc, win, overlay, api, seen }——seen 是背景快捷键监听（冒泡相，同 shortcuts.js 层）。
 */
async function openWelcome(opts = {}) {
  const doc = makeDomStub();
  const win = {};
  const api = { calls: [], setPref(k, v) { this.calls.push([k, v]); }, getPref: async () => false };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.api = api;
  let trigger = null;
  if (opts.opener) {
    trigger = doc.createElement('button');
    trigger.textContent = '重新查看新手引导';
    trigger.focus();
  }
  await loadWelcomeFresh();
  win.showWelcome();
  const overlay = doc.body.children.find((c) => c.className.includes('welcome-overlay'));
  assert.ok(overlay, '桩没找到引导浮层——类名变了要同步这张寻址表');
  const seen = [];
  doc.addEventListener('keydown', (ev) => seen.push(ev.key)); // 冒泡相位 = 背景快捷键的家
  return { doc, win, overlay, api, seen, trigger };
}

const byText = (overlay, label) => {
  const hit = overlay.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(hit, `浮层里找不到「${label}」钮——文案搬家要同步这张寻址表`);
  return hit;
};

test('行为：引导层打开后初始焦点落「稍后再说」——回车即走的保守出口，不是永久关闭', async () => {
  const { doc, overlay } = await openWelcome();
  assert.equal(doc.activeElement, byText(overlay, '稍后再说'),
    '焦点必须进浮层且落在一次性关闭钮上：落在「开始使用」等于键盘用户回车即永久销毁引导');
});

test('行为：Tab/Shift+Tab 焦点只在 4 颗钮间循环且 preventDefault——浮层底下没有可去的地方', async () => {
  const { doc, overlay } = await openWelcome();
  const order = ['去登录', '去设置', '稍后再说', '开始使用'].map((t) => byText(overlay, t));
  // 初始在 稍后再说(2)：真 DOM 的浏览器默认会跳出浮层——preventDefault 是我们接管 Tab 的铁证
  const expect = [[3, false], [0, false], [1, false], [2, false]];
  let ev;
  for (const [want, shift] of expect) {
    ev = dispatchKey(doc, 'Tab', doc.activeElement, shift);
    assert.equal(doc.activeElement, order[want], `Tab 应走到「${order[want].textContent}」`);
  }
  assert.ok(ev.defaultPrevented, 'Tab 必须 preventDefault，否则浏览器原生换焦点会走出浮层');
  order[3].focus(); // 真 DOM 里 keydown 只可能从聚焦元素发出，桩必须同形
  ev = dispatchKey(doc, 'Tab', order[3], true); // 开始使用 ←Shift+Tab→ 稍后再说
  assert.equal(doc.activeElement, order[2], 'Shift+Tab 应逆向循环');
});

test('行为：Esc 等同「稍后再说」——浮层关闭但 welcomeSeen 一个字都不写，且这次 Esc 不外漏', async () => {
  const { doc, overlay, api, seen } = await openWelcome();
  dispatchKey(doc, 'Escape', doc.activeElement);
  await flush();
  assert.ok(!doc.body.children.includes(overlay), 'Esc 应关闭引导层');
  assert.deepEqual(api.calls, [],
    'Esc 是无标记的"退出"，不得替用户做永久决定（写 welcomeSeen=开始使用 的路径）');
  assert.deepEqual(seen, [], '模态开着按键不得漏到背景监听');
});

test('行为：关闭后焦点归还唤起它的元素——Esc 路径与点「开始使用」路径都要还', async () => {
  const a = await openWelcome({ opener: true });
  assert.equal(a.doc.activeElement, byText(a.overlay, '稍后再说'), '先确认焦点在浮层内');
  dispatchKey(a.doc, 'Escape', a.doc.activeElement);
  await flush();
  assert.equal(a.doc.activeElement, a.trigger, 'Esc 关闭后焦点必须回到菜单钮');

  const b = await openWelcome({ opener: true });
  byText(b.overlay, '开始使用').click();
  await flush();
  assert.ok(!b.doc.body.children.includes(b.overlay), '点「开始使用」应关闭浮层');
  assert.deepEqual(b.api.calls, [['welcomeSeen', true]], '「开始使用」才是写永久标记的那颗钮');
  assert.equal(b.doc.activeElement, b.trigger, '按钮路径关闭后同样归还焦点');
});

test('行为：确认框叠在引导层上时，引导层的围堵必须整体让位——186 的契约不容新代码反噬', async () => {
  const { doc, overlay } = await openWelcome();
  const { askConfirm } = await loadConfirm();
  const p = askConfirm('确认删除歌单？');
  const confOverlay = doc.body.children[doc.body.children.length - 1];
  const cancelBtn = findClass(confOverlay, 'confirm-dialog-cancel');
  const okBtn = findClass(confOverlay, 'confirm-dialog-ok');

  dispatchKey(doc, 'Tab', cancelBtn); // 引导层的 capture 监听跑在前面：它若围堵，确认框就废了
  assert.equal(doc.activeElement, okBtn, '确认框开着时 Tab 归确认框的焦点陷阱管');
  assert.ok(doc.body.children.includes(overlay), '引导层纹丝不动');

  dispatchKey(doc, 'Escape', okBtn);
  assert.equal(await Promise.race([p, 'pending']), false, 'Esc 关的是确认框');
  assert.ok(doc.body.children.includes(overlay), '确认后关层不吞引导层（186 回归面）');
});

test('行为：引导层独开时空格不漏背景——播放快捷键不得越过模态动背后的页面', async () => {
  const { doc, seen } = await openWelcome();
  dispatchKey(doc, ' ', doc.body);
  assert.deepEqual(seen, [], '空格 keydown 必须被封在引导层内（player.js 的播放键在背景）');
});

test('形状钉：引导层自带 dialog 语义、动作零内联 onclick、层级走 --z-overlay token', () => {
  const src = read('js', 'views', 'welcome.js');
  assert.ok(/role['"]?\s*[,:]\s*['"]?dialog|setAttribute\(\s*['"]role['"]/.test(src), '需要 role=dialog');
  assert.ok(/aria-modal/.test(src), '需要 aria-modal');
  assert.ok(!/onclick\s*=/.test(src), '内联 onclick 绝迹——动作走 data-welcome + 事件委托（可测性 + 176 的内联桥纪律）');
  assert.ok(/data-welcome/.test(src), '委托契约的挂点必须存在');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'content.css'), 'utf8').replace(/\r\n/g, '\n');
  const rule = css.match(/\.welcome-overlay\s*{[^}]*}/);
  assert.ok(rule, 'content.css 里找不到 .welcome-overlay 规则');
  assert.ok(/z-index:\s*var\(--z-overlay\)/.test(rule[0]),
    '层级必须走 var(--z-overlay)：裸值 1500 会把引导层画在确认框之上，与 186 的键盘归属（确认框赢）当面打架');
});

test('桩自测：innerHTML 解析出的钮序即模板序——寻址表不漂，行为钉才有地基', async () => {
  const { overlay } = await openWelcome();
  assert.deepEqual(overlay.querySelectorAll('button').map((b) => b.textContent),
    ['去登录', '去设置', '稍后再说', '开始使用']);
});
