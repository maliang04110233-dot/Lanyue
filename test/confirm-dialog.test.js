/**
 * （起工时记 174，落库时让号两次后为 176）：不可逆操作确认弹层 confirmDialog 的契约测试。
 *
 * 现状缺口：全渲染层 15 处不可逆操作用的是浏览器原生 confirm()——
 *   ① 外观是操作系统的灰白小窗，与霓虹深色主题当面割裂（QA 维度"组件使用"）；
 *   ② Electron 的 file:// 源会在标题栏露出 "file:// 显示此对话框" 技术行；
 *   ③ 最要命：159/157 特意写好的多行点名文案（「\n\n• 影响A\n• 影响B」），
 *      原生对话框会把换行压平成一行——诚实点名的 F2 纪律文案被浏览器吃掉。
 * 立法（沿用 168「同一个规则只许有一个家」）：确认弹层只有 confirmDialog.js 一个家；
 *   反向钉按形状扫，新代码再写原生弹窗即红。
 * 修法升级：钉从"裸 confirm("泛化为原生弹窗全族（alert/prompt/confirm 裸调用
 *   + window/self/globalThis 前缀变体，堵旧钉排除类漏掉 window.confirm 的点前缀洞），
 *   扫描面从 src/renderer/js 扩到 index.html 内联脚本。现网全族零命中，钉下即绿，
 *   非空转由三枚变异验证 + 族钉自测（命中/不误伤各一组）背书。
 * 行为层：domStub 驱动真 askConfirm 的键盘/焦点契约——Enter 归聚焦钮、
 *   Tab 两钮循环、Esc 取消且不外漏、关闭后焦点归还 opener、空格不漏背景。
 *   五测先红（对着 176 的旧实现各验过失败原因）后绿，非事后补测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// confirmDialog 的模型层是纯函数（DOM 只活在 askConfirm 体内），node 可直接 import
const load = async () => import(pathToFileURL(R('js', 'confirmDialog.js')).href + '?tc=' + Math.random());

// ── 模型层：文案归一化 ─────────────────────────────────────

test('confirmDetails：字符串入参照样变成 title，单行文案 lines 为空（没正文就不硬凑回显）', async () => {
  const { confirmDetails } = await load();
  const d = confirmDetails('确认清空所有下载任务？');
  assert.equal(d.title, '确认清空所有下载任务？');
  assert.deepEqual(d.lines, []);
  assert.equal(d.danger, false);
  assert.equal(d.okLabel, '确认');
  assert.equal(d.cancelLabel, '取消');
});

test('confirmDetails：含换行的多行文案按行拆开——原生 confirm 压平的行，弹层必须一行一行显示', async () => {
  const { confirmDetails } = await load();
  const text = '确认删除歌单「叶惠美」？\n\n• 歌单里有 10 首歌 —— 删的只是这份清单\n• 删除后 5 秒内可点「撤销」原样找回';
  const d = confirmDetails(text);
  assert.equal(d.title, '确认删除歌单「叶惠美」？');
  assert.deepEqual(d.lines, [
    '• 歌单里有 10 首歌 —— 删的只是这份清单',
    '• 删除后 5 秒内可点「撤销」原样找回',
  ]);
});

test('confirmDetails：对象入参可点名标题/按钮/危险级，空行只当分隔不进 lines', async () => {
  const { confirmDetails } = await load();
  const d = confirmDetails({
    title: '彻底删除？',
    lines: [],
    text: '第一行\n\n第二行',
    okLabel: '彻底删除',
    danger: true,
  });
  assert.equal(d.title, '彻底删除？');
  assert.deepEqual(d.lines, ['第一行', '第二行']);
  assert.equal(d.okLabel, '彻底删除');
  assert.equal(d.danger, true);
});

test('confirmDetails：入参宽容——null/undefined/数字都不炸，回落成字符串文案', async () => {
  const { confirmDetails } = await load();
  assert.equal(confirmDetails().title, '确认执行该操作？');
  assert.equal(confirmDetails(null).title, '确认执行该操作？');
  assert.equal(confirmDetails(42).title, '42');
});

// ── 反向钉：原生弹窗家族全仓绝迹（176 只钉了裸 confirm(，178 把立法升为全族）──
// 按形状扫两支：① 裸 alert(/prompt(/confirm( 调用；② window./self./globalThis. 前缀变体。
// ②是补 176 的洞：旧钉排除类 [^A-Za-z0-9_.$] 把点前缀一并排除，window.confirm( 恰好漏网。
// 派生名不误伤：askConfirm(/showAlert(/buildPrompt( 前置字母不匹配①；ui.confirmDialog( 非全局前缀不匹配②。

const BARE_NATIVE_DIALOG = /(^|[^A-Za-z0-9_.$])(alert|prompt|confirm)\s*\(/;
const QUALIFIED_NATIVE_DIALOG = /(^|[^A-Za-z0-9_$])(window|self|globalThis)\s*\.\s*(alert|prompt|confirm)\s*\(/;
const isNativeDialog = (line) => BARE_NATIVE_DIALOG.test(line) || QUALIFIED_NATIVE_DIALOG.test(line);

function nativeDialogOffenders() {
  const offenders = [];
  const check = (abs, src) => {
    src.split('\n').forEach((line, i) => {
      if (isNativeDialog(line)) offenders.push(`${path.relative(ROOT, abs)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  };
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html)$/.test(ent.name)) continue;
      check(p, fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  walk(R()); // src/renderer 全量：js 子目录 + index.html 内联脚本
  return offenders;
}

test('渲染层源码与 index.html 原生弹窗家族（alert/prompt/confirm 及 window/self/globalThis 前缀）绝迹——弹层唯一家是应用内模块', () => {
  assert.deepEqual(nativeDialogOffenders(), [], '仍有原生弹窗调用:\n' + nativeDialogOffenders().join('\n'));
});

test('族钉本身非空转：三族裸调用与三种全局前缀全命中，派生名与属性名零误伤', () => {
  for (const s of [
    'alert(1)',
    'if (confirm("删?"))',
    'const v = prompt("名字");',
    'window.alert(msg)',
    'self.prompt(x)',
    'globalThis.confirm && globalThis.confirm(1)',
  ]) {
    assert.ok(isNativeDialog(s), `应命中: ${s}`);
  }
  for (const s of [
    'await askConfirm("确认删除？")',
    'showAlert(msg)',
    'uiConfirm(x)',
    'buildPrompt(q)',
    'deadConfirmText(n)',
    'this.promptCount(1)',
    'ui.confirmDialog.render()',
  ]) {
    assert.ok(!isNativeDialog(s), `应不误伤: ${s}`);
  }
});

// ── 接线钉：16 个调用点全部改走 askConfirm ──────────────────

const ASK_SITES = [
  ['app.js', 1],
  ['lyricEditor.js', 1],
  ['views/ai-music.js', 1],
  ['views/download.js', 1],
  ['views/dragdrop.js', 1],
  ['views/history.js', 3],
  ['views/local-stats.js', 1],
  ['views/playlist.js', 4],
  ['views/settings.js', 3],
];

test('16 处不可逆操作全部接线 askConfirm，且调用处必带 await（不 await 的确认框等于没有确认）', async () => {
  let total = 0;
  for (const [f, n] of ASK_SITES) {
    const src = read('js', ...f.split('/'));
    const calls = src.match(/await\s+askConfirm\(/g) || [];
    assert.equal(calls.length, n, `${f} 应有 ${n} 处 await askConfirm(`);
    assert.ok(src.includes("import { askConfirm } from './confirmDialog.js';")
      || src.includes("import { askConfirm } from '../confirmDialog.js';"),
    `${f} 需 import askConfirm`);
    total += calls.length;
  }
  assert.equal(total, 16, '调用点总数必须等于 16——多了少了都要先改这张表再改代码');
});

// ── 弹层自身的纪律 ────────────────────────────────────────

test('confirmDialog 弹层体纪律：文案全部 textContent 上屏（点名的歌单/文件名可能含尖括号），危险按钮走 token 不裸色', async () => {
  const src = read('js', 'confirmDialog.js');
  // 弹层展示用户数据（歌单名/文件名），禁止把入参拼进 innerHTML
  const innerHtmlLines = src.split('\n').filter(l => /innerHTML\s*=/.test(l));
  assert.ok(innerHtmlLines.every(l => !/\$\{[^}]*(title|line|text|okLabel|cancelLabel)/.test(l)),
    'innerHTML 里禁止插用户文案: ' + innerHtmlLines.filter(l => /\$\{[^}]*(title|line|text|okLabel|cancelLabel)/.test(l)).join(' | '));
  assert.ok(/danger/.test(src), '危险级（不可逆）按钮必须有区分');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src.split('\n').filter(l => !/^\s*[//*]/.test(l)).join('\n')),
    '样式全部走 CSS 类/token，JS 里不裸写色值');
});

test('样式落位钉：confirm-dialog 类写进 overlays.css，层级用 --z-overlay token（键盘可达增量立的规矩）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'overlays.css'), 'utf8');
  assert.ok(/\.confirm-dialog-overlay\b/.test(css), 'overlays.css 需有 .confirm-dialog-overlay');
  assert.ok(/\.confirm-dialog\b/.test(css), 'overlays.css 需有 .confirm-dialog');
  assert.ok(/\.confirm-dialog\.danger .*--red/.test(css), '危险按钮必须挂 --red token');
  const overlayRule = css.match(/\.confirm-dialog-overlay\s*{[^}]*}/);
  assert.ok(overlayRule && /var\(--z-overlay\)/.test(overlayRule[0]),
    '弹层层级必须用 var(--z-overlay)，不裸写数字（161 键盘可达的 token 纪律）');
});

test('无障碍钉：确认/取消按钮都可被键盘触发，弹层带 role=dialog 与 aria-modal', () => {
  const src = read('js', 'confirmDialog.js');
  assert.ok(/role.{0,4}dialog/.test(src), '需要 role=dialog');
  assert.ok(/aria-modal/.test(src), '需要 aria-modal');
  assert.ok(/\.focus\(\)/.test(src), '打开时必须把焦点放进弹层（原生窗抢不走键盘，弹层不能）');
  assert.ok(/Escape/.test(src) && /keydown/.test(src), 'Esc 必须等同取消');
});

// ── 行为层：domStub 驱动真 askConfirm（补 176 的行为级欠账）──
// 181 把"窄窗溢出"钉成几何契约后，剩下的欠账全是行为级：Enter 劫持、
// 焦点陷阱、焦点归还、键盘围堵。askConfirm 的 DOM 依赖只有
// createElement/body.appendChild/addEventListener(capture)/focus/remove，
// 一个 60 行的桩就能真跑（方法论同 179 的 eq-reset：桩只做被测代码真用到的部分）。

function stubEl(tag, doc) {
  return {
    tag, parent: null, children: [], className: '', textContent: '', attrs: {}, _l: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    },
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); },
    focus() { doc.activeElement = this; },
    click() { (this._l.click || []).forEach((fn) => fn({ type: 'click', target: this })); },
  };
}

function makeDomStub() {
  const doc = {
    activeElement: null, _cap: [], _bub: [],
    createElement: (tag) => stubEl(tag, doc),
    addEventListener(type, fn, capture) { (capture ? doc._cap : doc._bub).push({ type, fn }); },
    removeEventListener(type, fn, capture) {
      const arr = capture ? doc._cap : doc._bub;
      const i = arr.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  doc.body = stubEl('body', doc);
  return doc;
}

function findClass(el, cls) {
  if (el.className.split(/\s+/).includes(cls)) return el;
  for (const c of el.children) {
    const hit = findClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

// 键盘事件按真实 DOM 的相位语义派发：document 捕获 → 目标 → document 冒泡；
// stopPropagation 掐断后续节点，stopImmediatePropagation 连同节点后续监听也掐断。
function dispatchKey(doc, key, target) {
  const ev = {
    key, type: 'keydown', target,
    defaultPrevented: false, propagationStopped: false, immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
  };
  const run = (list) => {
    for (const l of list) {
      if (ev.immediateStopped) return;
      if (l.type === 'keydown') l.fn(ev);
    }
  };
  run([...doc._cap]);
  if (!ev.propagationStopped) run((target && target._l.keydown) || []);
  if (!ev.propagationStopped) run([...doc._bub]);
  return ev;
}

const flush = () => new Promise((r) => setImmediate(r));

async function openDialog(doc, opts) {
  globalThis.document = doc;
  const { askConfirm } = await load(); // ?tc= 随机数保证每次拿到新鲜的单例状态
  const d = { doc, settled: 'pending', value: null };
  askConfirm(opts == null ? '确认删除？' : opts).then((v) => { d.settled = true; d.value = v; });
  d.overlay = doc.body.children[doc.body.children.length - 1];
  d.okBtn = findClass(d.overlay, 'confirm-dialog-ok');
  d.cancelBtn = findClass(d.overlay, 'confirm-dialog-cancel');
  assert.ok(d.okBtn && d.cancelBtn, '桩没找到弹层按钮——弹层类名变了要同步这张寻址表');
  return d;
}

test('行为：Enter 归属于当前聚焦按钮——焦点停在「取消」时绝不确认不可逆操作', async () => {
  const doc = makeDomStub();
  const d = await openDialog(doc, { title: '彻底删除？', okLabel: '彻底删除', danger: true });
  assert.equal(doc.activeElement, d.cancelBtn, '初始焦点应在取消钮（回车即确认的另一条路是指边取消）');
  dispatchKey(doc, 'Enter', d.cancelBtn);
  await flush();
  assert.equal(d.settled, 'pending',
    '全局 Enter 不得越权代按确认钮——那会让"焦点在取消、按回车却执行了不可逆删除"');
  d.cancelBtn.click(); // 浏览器原生激活：Enter 按下的是聚焦的那颗钮
  await flush();
  assert.equal(d.value, false, '聚焦取消钮后的激活应取消');
});

test('行为：Esc 取消弹层，且这次 Esc 被封在弹层内——后台快捷键监听看不见它', async () => {
  const doc = makeDomStub();
  const seen = [];
  doc.addEventListener('keydown', (ev) => seen.push(ev.key)); // 冒泡相位，与 shortcuts.js 同层
  const d = await openDialog(doc);
  dispatchKey(doc, 'Escape', d.cancelBtn);
  await flush();
  assert.equal(d.value, false, 'Esc = 取消');
  assert.deepEqual(seen, [], '模态打开时按键不得漏到背景监听');
});

test('行为：Tab 焦点陷阱——焦点只在取消/确认两钮间循环，且必须 preventDefault', async () => {
  const doc = makeDomStub();
  const d = await openDialog(doc);
  const ev1 = dispatchKey(doc, 'Tab', d.cancelBtn);
  assert.equal(doc.activeElement, d.okBtn, 'Tab 应把焦点从取消推到确认');
  const ev2 = dispatchKey(doc, 'Tab', d.okBtn);
  assert.equal(doc.activeElement, d.cancelBtn, '再 Tab 应回到取消而不是逃去背景元素');
  assert.ok(ev1.defaultPrevented && ev2.defaultPrevented,
    'Tab 必须 preventDefault——否则浏览器原生换焦点会走出弹层');
});

test('行为：关闭后焦点归还唤起它的元素——不回还则键盘用户每次确认完都丢了位置', async () => {
  const doc = makeDomStub();
  const trigger = doc.createElement('button');
  trigger.focus();
  const d = await openDialog(doc);
  assert.equal(doc.activeElement, d.cancelBtn, '打开时焦点进弹层');
  dispatchKey(doc, 'Escape', d.cancelBtn);
  await flush();
  assert.equal(doc.activeElement, trigger, '关闭后焦点必须回到打开前聚焦的元素');
});

test('行为：空格不漏背景——弹层开着时空格 keydown 不得漏给 player.js 的播放快捷键', async () => {
  const doc = makeDomStub();
  const seen = [];
  doc.addEventListener('keydown', (ev) => seen.push(ev.key));
  const d = await openDialog(doc);
  dispatchKey(doc, ' ', d.okBtn);
  await flush();
  assert.equal(d.settled, 'pending', '空格 keydown 不该由我们代劳确认（原生按钮激活留给浏览器）');
  assert.deepEqual(seen, [], '空格不得漏到背景的播放/暂停快捷键');
});

test('行为：点确认钮 resolve true / 点遮罩 resolve false（原生 confirm 语义等价面）', async () => {
  const doc = makeDomStub();
  const d1 = await openDialog(doc, '清空全部任务？');
  d1.okBtn.click();
  await flush();
  assert.equal(d1.value, true);
  const d2 = await openDialog(doc, '清空全部任务？');
  (d2.overlay._l.click || []).forEach((fn) => fn({ type: 'click', target: d2.overlay }));
  await flush();
  assert.equal(d2.value, false, '点遮罩 = 取消');
});

test('行为：同一时刻只有一个确认框——第二个调用复用同一 Promise 且不开第二层', async () => {
  const doc = makeDomStub();
  globalThis.document = doc;
  const { askConfirm } = await load();
  const p1 = askConfirm('删A？');
  const p2 = askConfirm('删B？');
  assert.equal(p1, p2, '并发调用必须复用同一个 Promise（单例阻塞语义）');
  assert.equal(doc.body.children.length, 1, '不得叠出第二层弹层');
});
