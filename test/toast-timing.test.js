/**
 * toast 计时契约钉 —— 181 记下「toast 计时未经真机验证」的欠账，
 * 这里用 domStub + 小 ttl 真实定时器把它钉进 CI（不 fake 全局 setTimeout：
 * 仓里多路在途用例吃真实计时，动全局属越界）。
 *
 * 契约面（toast.js showToast + utils.js showActionToast，两家共用 #toastContainer）：
 *   ① 到期自散：先挂 toast-out 退场动画，250ms 后真移除——不留"永远挂在屏上"的反馈；
 *   ② 点动作钮 = 就地关闭 + 回调恰一次——撤销/仍要下载这类动作钮不许双触发；
 *   ③ 无容器静默返回——toast 是锦上添花，DOM 缺位时不许把调用方（15 处 await 链）炸穿；
 *   ④ 未知类型回落 info 皮；tone 只认 warn/success 两族（155 结构收口 + 177 开族的时间面）。
 *
 * 治理/回归钉钉的是既有不变量，落地即绿属预期（口径同 177/178/181）；
 * 非空转靠三枚变异验证：摘 remove → ①红、摘 onConfirm 调用 → ②红、摘容器 guard → ③红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 DOM 桩：两条 toast 实现真用到的面（getElementById/createElement/
//    appendChild/remove/children/click 监听/style）─────────────────

/**
 * 最小 DOM 桩。
 *
 * ⚠ 这里刻意**不提供 `parent` 字段**（2026-10-13 移除）。真实 DOM 的元素没有
 * `parent` 属性，只有 `parentElement` / `parentNode`；此前桩里恰好有个 parent，
 * 于是 `el.parent` 在测试里为真、在生产里恒为 undefined —— 实现因此写出
 * `if (!el || !el.parent) return;`，真机上每次到期都提前返回，**toast 永不离场**。
 * 桩比真实 DOM 多给一个字段，等于替实现把 bug 藏起来。现在字段名用 owner，
 * 谁再写 el.parent 会**当场** undefined 而红。
 */
function stubEl(tag) {
  return {
    tag, owner: null, children: [], className: '', textContent: '', style: {}, _l: {},
    appendChild(c) { c.owner = this; this.children.push(c); return c; },
    remove() {
      if (this.owner) this.owner.children = this.owner.children.filter((x) => x !== this);
      this.owner = null;
    },
    // contains 是真实 DOM 的 API（Node.contains），toast.js 用它判"这条还在屏上吗"
    contains(el) { return this.children.includes(el); },
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); },
    click() { (this._l.click || []).forEach((fn) => fn({ type: 'click', target: this })); },
  };
}

const container = stubEl('div');
const doc = {
  createElement: (tag) => stubEl(tag),
  getElementById: (id) => (id === 'toastContainer' && doc._hasContainer ? container : null),
  _hasContainer: true,
};
globalThis.document = doc;
globalThis.window = {}; // toast.js/utils.js 顶层挂 window.* 桥；translateMessage 缺席=中文默认态

const { showToast } = await import(pathToFileURL(R('js', 'toast.js')).href);
const { showActionToast } = await import(pathToFileURL(R('js', 'utils.js')).href);

// ── ① 到期自散 ───────────────────────────────────────────

test('showToast：duration 到点先挂 toast-out 退场动画，250ms 后真从容器移除（到期自散契约）', async () => {
  container.children.length = 0;
  showToast('自散测试', 'info', 20);
  assert.equal(container.children.length, 1, '入容器即上屏');
  await sleep(60);
  const el = container.children[0];
  assert.ok(/toast-out/.test(el.style.animation || ''), '退场先行：到点先挂动画而不是瞬间消失');
  assert.equal(container.children.length, 1, '动画期间还在屏上');
  await sleep(400);
  assert.equal(container.children.length, 0, '动画 250ms 后必须真移除');
});

// ── ② 点击即关 + 恰一次 ──────────────────────────────────

test('showActionToast：点动作钮=就地关闭且回调恰一次，ttl 到点不二次触发（撤销钮不许双触发）', async () => {
  container.children.length = 0;
  let confirms = 0;
  showActionToast({ text: '已删除歌单', btnLabel: '撤销', onConfirm: () => { confirms += 1; }, ttl: 120 });
  const el = container.children[0];
  const btn = el.children.find((c) => c.className === 'toast-action-btn');
  assert.ok(btn, '动作钮必须存在（155 结构收口的行为面）');
  btn.click();
  assert.equal(confirms, 1, '点击即回调');
  assert.equal(container.children.length, 0, '点击即关，不等 ttl');
  await sleep(300);
  assert.equal(confirms, 1, 'ttl 到点不得把回调再触发一次');
  assert.equal(container.children.length, 0);
});

// ── ② 的另一半：没人按也一样离场，但不许碰回调 ──────────

test('showActionToast：没人按也到期自散，且回调不顺手触发（到点消失≠替你决定）', async () => {
  container.children.length = 0;
  let confirms = 0;
  showActionToast({ text: '没人按', btnLabel: '仍要下载', onConfirm: () => { confirms += 1; }, ttl: 20 });
  await sleep(450);
  assert.equal(container.children.length, 0, 'ttl 到点必须自散');
  assert.equal(confirms, 0, '自散不是确认——过期后撤销窗口关闭，回调保持沉默');
});

// ── ③ 无容器静默返回 ─────────────────────────────────────

test('无 #toastContainer 时两种 toast 都静默返回（toast 是锦上添花，不许把调用方炸穿）', () => {
  doc._hasContainer = false;
  try {
    assert.doesNotThrow(() => showToast('没容器', 'error', 10));
    assert.doesNotThrow(() => showActionToast({ text: '没容器', btnLabel: '钮', onConfirm: () => {} }));
  } finally {
    doc._hasContainer = true;
  }
});

// ── ④ 类型/tone 回落 ─────────────────────────────────────

test('未知 type 回落 info 皮；tone 只认两族：默认 warn、177 庆祝 success（类名钉死在 base.css 既有族）', async () => {
  container.children.length = 0;
  showToast('怪类型', 'no-such-type', 10);
  assert.equal(container.children[0].className, 'toast toast-info', '未知类型必须落到有皮的 info');
  showActionToast({ text: '警告族', btnLabel: '钮' });
  showActionToast({ text: '庆祝族', btnLabel: '钮', tone: 'success' });
  const [warnEl, okEl] = container.children.slice(1);
  assert.equal(warnEl.className, 'toast toast-warn toast-action');
  assert.equal(okEl.className, 'toast toast-success toast-action');
  warnEl.remove(); okEl.remove(); // 收摊：不等 6 秒默认 ttl
});

// ── ⑤ 同文案合并（刷屏防护，2026-10-13）────────────────────
// 现场：自动跳曲时一句失败文案两三秒内连来十几条，整个界面被糊住、不可操作。

test('同文案在屏时重复 → 合并成「原文 ×N」，不新起一条', async () => {
  container.children.length = 0;
  showToast('连着失败', 'warn', 300);
  showToast('连着失败', 'warn', 300);
  showToast('连着失败', 'warn', 300);
  assert.equal(container.children.length, 1, '同文案只许占一条，否则就是刷屏');
  assert.equal(container.children[0].textContent, '连着失败 ×3', '重复次数要看得见');
  await sleep(700);
  assert.equal(container.children.length, 0, '合并后的那条照常到期自散（合并不等于永驻）');
});

// ── ⑥ 在屏上限 ─────────────────────────────────────────────

test('不同文案超过 6 条 → 踢掉最早的（反馈不是许愿池）', async () => {
  container.children.length = 0;
  for (let i = 1; i <= 10; i++) showToast(`上限测试${i}`, 'warn', 60);
  assert.equal(container.children.length, 6, '在屏上限 6 条');
  assert.equal(container.children[0].textContent, '上限测试5', '被踢的该是最早那四条');
  await sleep(500); // 等 TTL 收摊，不留定时器给后续用例
  assert.equal(container.children.length, 0);
});

// ── ⑦ 离场后同文案要能重新起一条 ─────────────────────────────

test('上一条已离场 → 同文案重新起新条（去重不得把文案永久锁死）', async () => {
  container.children.length = 0;
  showToast('复发测试', 'warn', 30);
  await sleep(400); // 等它走完退场
  showToast('复发测试', 'warn', 30);
  assert.equal(container.children.length, 1, '离场后同文案必须能再来一次');
  assert.equal(container.children[0].textContent, '复发测试', '新的一条不该带 ×2 的历史计数');
  await sleep(400);
});

// ── 桩与真实 DOM 同步（2026-10-13 加；本轮第三次的同一类坑）────────────────
// 同一个错误当天踩了三次：登记簿 key（测试用 registerStream 的返回值原样回查，
// 真机传的是 Chromium 规范化后的形态）、CSP（扫到了注释里的 <audio> 字样）、
// 以及这里的 el.parent（桩多给了一个真实 DOM 没有的字段）。
// 共同点：**测试环境比真实运行时"更友好"，于是把 bug 藏起来**。
// 这条门禁把「看似合理、实则不存在」的 DOM 属性钉死。

test('toast 家族不许用真实 DOM 里不存在的属性（el.parent 是本轮踩过的坑）', () => {
  for (const f of ['toast.js', 'utils.js']) {
    // 剥注释再扫：toast.js 的注释里**故意**留着 el.parent 的反例说明
    const code = fs.readFileSync(path.join(R(), 'js', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    assert.ok(
      !/\.parent\b/.test(code),
      `js/${f} 用了 .parent：真实 DOM 只有 parentElement / parentNode，没有 parent。`
      + '在测试桩上它为真、在真机上恒为 undefined，会让"到期离场"永远提前 return。',
    );
  }
});
