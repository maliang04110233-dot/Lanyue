/**
 * 叠层弹层的键盘归属——早注册的 capture 监听必须向确认框让位。
 *
 * 来龙：182 给 confirmDialog 装了 capture 相 stopImmediatePropagation 围堵，
 * 但当场记下一条文级欠账：围堵只对"后注册的"监听有效——同节点 capture 队列按
 * 注册序执行，welcome.js:49 在应用启动时就注册了 document-capture Esc 处理器，
 * 它永远跑在确认框前面。两层同开时一次 Esc 双抢：引导层和确认框一起关，
 * 用户按"取消"关个对话框，结果连新手引导都被顺手清了（未读信息永久丢失——
 * 「开始使用」写 welcomeSeen，走的就是 closeWelcome 这条路）。
 * 修法（契约而非补丁）：confirmDialog 导出 hasOpenConfirm()；任何比它早注册的
 * capture 键盘监听在处理前必须问一句"上面有没有确认框"，有即让位。
 * welcome 是本契约第一个、也是目前唯一一个外部履约者。
 *
 * 钉形：①双抢行为钉（domStub 真跑 welcome+confirmDialog 两模块的叠层，RED-first：
 * 修复前一次 Esc 两层全关）；②常规 Esc 仍关引导（让位不吞键的回归面）；
 * ③反向形状钉按巡扫口径堵未来——除 confirmDialog 自己外，谁再注册 document-capture
 * keydown，其文件必须引用 hasOpenConfirm，否则即红（口径同 171/178/185 形状巡扫）；
 * ④hasOpenConfirm 状态钉：开为真、关为假、单例复用期间恒真。
 *
 * 模块缓存口径：confirmDialog 走未加 query 的裸 URL——welcome 修复后的静态
 * import 解析到的正是这个裸实例，两边共享同一个 _current，行为测试才算真叠层。
 * welcome 每测要新鲜单例，但 ?tc= 破缓存只对"按 ESM 解析"的模块有效：
 * 本仓 package.json 无 type 字段，Node 对 .js 做语法探测——修复前的 welcome.js
 * 没有任何 ESM 语法 ⇒ 按 CJS 执行，而 CJS require 缓存键不含 query（实测二载
 * 不重执行，window 桥全部丢失）。故加载 welcome 前必须显式 delete require.cache，
 * 修复后它含 import 语句转为 ESM 探测，query 破缓存自然生效——两手 loader 兼容两个时代。
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

const CONFIRM_HREF = pathToFileURL(R('js', 'confirmDialog.js')).href; // 裸 URL：与 welcome 的依赖同实例
const loadConfirm = () => import(CONFIRM_HREF);
const req = createRequire(import.meta.url);
const loadWelcomeFresh = async () => {
  try { delete req.cache[req.resolve(R('js', 'views', 'welcome.js'))]; } catch (_e) { /* ESM 探测时代无此缓存项 */ }
  return import(pathToFileURL(R('js', 'views', 'welcome.js')).href + '?tc=' + Math.random());
};

// ── domStub：从 test/helpers/dom-stub.js 取（193 收口：182→186→193 三处手抄
// 已经漂过一次——welcome 换掉内联 onclick 后本文件的旧桩缺 querySelectorAll，
// 两个行为测当场炸；桩与被测实现必须同址演进，故收进唯一的家，见该文件头）──

/** 起一层全新引导浮层，返回 { doc, win, overlay } */
async function openWelcome() {
  const doc = makeDomStub();
  const win = {};
  globalThis.document = doc;
  globalThis.window = win;
  await loadWelcomeFresh();
  win.showWelcome();
  const overlay = doc.body.children.find((c) => c.className.includes('welcome-overlay'));
  assert.ok(overlay, '桩没找到引导浮层——类名变了要同步这张寻址表');
  return { doc, win, overlay };
}

test('行为：引导层+确认框叠层时一次 Esc 只关确认框——早注册的 capture 监听必须让位（182 欠账）', async () => {
  const { doc, overlay } = await openWelcome();
  const { askConfirm } = await loadConfirm();
  const p = askConfirm('确认删除歌单？');
  const confOverlay = doc.body.children[doc.body.children.length - 1];
  const cancelBtn = findClass(confOverlay, 'confirm-dialog-cancel');
  assert.ok(cancelBtn, '桩没找到确认钮');

  dispatchKey(doc, 'Escape', cancelBtn);
  const answered = await Promise.race([p, 'pending']);
  assert.equal(answered, false, 'Esc 应把确认框判为取消');
  assert.ok(doc.body.children.includes(overlay),
    '确认框开着时，Esc 不得越权顺带关掉新手引导层——两层同开只关最上面那层');
});

test('行为：没有确认框时，Esc 照旧关引导层——让位契约不吞常规按键', async () => {
  const { doc, overlay } = await openWelcome();
  dispatchKey(doc, 'Escape', doc.body);
  assert.ok(!doc.body.children.includes(overlay), '无叠层时 Esc 必须照常关闭引导层');
});

test('状态钉：hasOpenConfirm 随确认框开合翻转——这是全体叠层监听者的问话接口', async () => {
  const doc = makeDomStub();
  globalThis.document = doc;
  const { askConfirm, hasOpenConfirm } = await loadConfirm();
  assert.equal(typeof hasOpenConfirm, 'function', 'confirmDialog 必须导出 hasOpenConfirm');
  assert.equal(hasOpenConfirm(), false, '未开框应为假');
  const p = askConfirm('删？');
  assert.equal(hasOpenConfirm(), true, '开框期间应为真');
  p.then((v) => { void v; });
  askConfirm('再删？').then((v) => { void v; }); // 单例复用路径，不新开第二层
  assert.equal(hasOpenConfirm(), true, '复用同一 Promise 期间仍为真');
  const confOverlay = doc.body.children[doc.body.children.length - 1];
  findClass(confOverlay, 'confirm-dialog-cancel').click();
  await flush();
  assert.equal(hasOpenConfirm(), false, '关闭后应归位为假');
});

// ── 反向形状钉：capture keydown 注册者的履约巡扫 ────────────────
// document 级 capture keydown 是"跑得比确认框早"的特权位。特权位只有一个合法
// 持有者（confirmDialog 自己）；其余持有者必须引用 hasOpenConfirm 表示会让位。
// 口径同 171/178/185：按形状扫整个渲染层，新代码再设一个不让位的 capture 监听即红。

const CAPTURE_KEYDOWN = /addEventListener\(\s*['"]keydown['"]\s*,\s*[^,)]+,\s*true\s*\)/;

function captureKeydownFiles() {
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      if (src.split('\n').some((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && CAPTURE_KEYDOWN.test(l))) {
        hits.push({ rel: path.relative(ROOT, p).replace(/\\/g, '/'), src });
      }
    }
  };
  walk(R('js'));
  return hits;
}

test('反向钉：除 confirmDialog 外，任何 document-capture keydown 持有者都必须引用 hasOpenConfirm（会问话才配抢跑）', () => {
  const offenders = captureKeydownFiles()
    .filter((f) => !f.rel.endsWith('confirmDialog.js'))
    .filter((f) => !f.src.includes('hasOpenConfirm'))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], '以下文件注册了 capture keydown 却不向确认框让位:\n' + offenders.join('\n'));
});

test('巡扫钉本身非空转：命中/不误伤各有一组样本', () => {
  assert.ok(CAPTURE_KEYDOWN.test("document.addEventListener('keydown', _escHandler, true);"));
  assert.ok(CAPTURE_KEYDOWN.test('document.addEventListener("keydown", onKey, true);'), '双引号形也须命中');
  assert.ok(!CAPTURE_KEYDOWN.test("document.addEventListener('keydown', handleKey);"), '冒泡注册不是特权位，不误伤');
  assert.ok(!CAPTURE_KEYDOWN.test("el.addEventListener('keydown', (e) => {}, { capture: true });"), '非第三参 true 的对象形暂不在本契约面（现网零使用，见测试头）');
  const hits = captureKeydownFiles().map((f) => f.rel);
  assert.ok(hits.includes('src/renderer/js/views/welcome.js'), '巡扫面必须真罩住现存的 welcome.js');
  assert.ok(hits.some((h) => h.endsWith('confirmDialog.js')), '巡扫面必须真罩住 confirmDialog 自己');
});
