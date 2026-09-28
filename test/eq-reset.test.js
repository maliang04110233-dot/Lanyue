/**
 * 重置均衡器真正归零（三键齐写 + 高亮/bypass 复位 + 恢复默认含 EQ）
 *
 * 症状（一处"重置"只做了一半，且骗过三处界面）：eq.js 头注释自称
 * 「三个偏好键在预设/手调/重置/bypass 四个动作里都会写」，但 resetEq() 只写
 * eqGains 并把滑块推到 0 —— 于是：
 *   D1 预设按钮的高亮仍停在「摇滚」：滑条读 0、按钮说"当前是摇滚曲线"，当场互相打脸；
 *   D2 eqPreset  pref 仍是 'rock'，重启后 restoreEqPresetSetting 照旧名恢复 —— 重置活不过一次重启；
 *   D3 eqBypass 不动：EQ 处于「关闭」时按重置，按钮仍写着 🔇 EQ关闭，用户接着拖滑条发现没声音变化
 *      （bypass 还开着），这一次"重置"反而把人骗得更深。
 *   D4 均衡器就摆在设置页「播放」tab 上，而「恢复所有设置为默认值」不碰它 —— 承诺与兑现的落差
 *      （与 169 的死开关、177 的表外语言同族）。
 *
 * 修法（唯一家）：EQ 的"默认态"早就有完整定义了 —— applyEqPreset('flat') 会写三键、推滑块、
 * 改标签、切高亮。resetEq 该委派给它，而不是自带一份只做一半的归零循环（168 立法：一处行为一个家）。
 *
 * 分工：本文件是**真行为测**（Node 里动态 import eq.js，桩 DOM + 桩 api 收 prefs）——
 * eq.js 在 ensureEqGraph 里对 window.AudioContext 与 #audioPlayer 都做了存在性检查，
 * 没有图也能跑完整状态机，所以不必伪造 Web Audio。只有"设置页接线"两条走源码钉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const countOf = (s, sub) => s.split(sub).length - 1;

const EQ_BAND_COUNT = 5;
const PRESET_NAMES = ['flat', 'pop', 'rock', 'classic', 'vocal', 'dance', 'jazz', 'bass'];

/** 等异步 prefs 落笔（saveEqPresetSetting / saveEqSettings 是 fire-and-forget） */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** 只认 eq.js 实际用到的那几个选择器 —— 测试侧脚手架，不进生产码 */
function domStub() {
  const mk = (o) => Object.assign({
    classList: {
      _set: new Set(Object.values(o.classes || {})),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } },
      contains(c) { return this._set.has(c); },
    },
  }, o);

  const sliders = [];
  const labels = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    sliders.push(mk({ id: 'eq_' + i, value: 0 }));
    labels.push(mk({ id: 'eq_val_' + i, textContent: '0dB' }));
  }
  const byId = {};
  sliders.forEach((s) => { byId[s.id] = s; });
  labels.forEach((l) => { byId[l.id] = l; });
  const bypassBtn = mk({ id: 'eqBypassBtn', textContent: 'EQ 开启' });
  byId.eqBypassBtn = bypassBtn;
  const presetBtns = PRESET_NAMES.map((n) => mk({ dataset: { eqPreset: n } }));

  global.document = {
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => {
      if (sel === '#eqPanel input[type=range]') return sliders;
      if (sel === '#eqPanel [id^=eq_val_]') return labels;
      if (sel === '.eq-preset-btn') return presetBtns;
      const m = /^\[data-eq-preset="([^"]+)"\]$/.exec(sel);
      if (m) return presetBtns.filter((b) => b.dataset.eqPreset === m[1]);
      return [];
    },
  };
  // 不给 AudioContext：ensureEqGraph 走"没有图也照样记 _gains"那条既有分支
  global.window = { addEventListener: () => {} };
  const prefs = {};
  global.api = {
    setPref: async (k, v) => { prefs[k] = JSON.parse(JSON.stringify(v)); return true; },
    getPref: async (k) => prefs[k],
  };
  return { prefs, sliders, labels, bypassBtn, presetBtns };
}

const freshEq = () => import('../src/renderer/js/player/eq.js?tc=' + Math.random());

// ── 真行为：重置之后三处界面与三笔 pref 必须一起归位 ──────────

test('resetEq 之后 eqPreset/eqBypass/eqGains 三键齐归默认（头注释的承诺，今天只兑现了三分之一）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  await flush();
  assert.deepEqual(dom.prefs.eqGains, [4, 2, -1, 1, 3], '前置：摇滚曲线确实生效了');

  eq.resetEq();
  await flush();
  assert.deepEqual(dom.prefs.eqGains, [0, 0, 0, 0, 0], '增益该归零');
  assert.equal(dom.prefs.eqPreset, 'flat',
    "eqPreset 还留着 'rock' —— 重启后 restoreEqPresetSetting 照旧名恢复，重置活不过一次重启");
  assert.equal(dom.prefs.eqBypass, false,
    'eqBypass 不动 = 重启后 EQ 仍是关闭态');
});

test('EQ 关闭态下按重置：按钮回到「EQ开启」，eq-bypassed 类摘掉（重置不该把人留在坑里）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  eq.toggleEqBypass();
  await flush();
  assert.match(dom.bypassBtn.textContent, /EQ关闭/, '前置：此刻确实是 bypass 态');

  eq.resetEq();
  await flush();
  assert.match(dom.bypassBtn.textContent, /EQ开启/,
    '滑条已是 0 但按钮还写着「EQ关闭」：用户接着拖滑条会以为 EQ 坏了');
  assert.equal(dom.bypassBtn.classList.contains('eq-bypassed'), false, '类名要跟着状态走');
});

test('resetEq 之后高亮落在「默认」按钮上（滑条读 0、按钮说摇滚 = 当场打脸）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('bass');
  await flush();
  const active = (n) => dom.presetBtns.find((b) => b.dataset.eqPreset === n).classList.contains('eq-preset-active');
  assert.equal(active('bass'), true, '前置：重低音正被高亮');

  eq.resetEq();
  await flush();
  assert.equal(active('flat'), true, '重置后「默认」该是高亮的那枚');
  assert.equal(active('bass'), false, '旧预设的高亮必须摘掉');
});

test('五条滑块与 dB 标签随重置回到 0（既有行为，委派之后不许做坏）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('vocal');
  await flush();
  eq.resetEq();
  await flush();
  dom.sliders.forEach((s, i) => {
    assert.equal(Number(s.value), 0, `第 ${i} 段滑块`);
    assert.equal(dom.labels[i].textContent, '0dB', `第 ${i} 段读数`);
  });
});

test('手调一格再重置：该段归零（resetEq 走的是完整默认态，不只是清 _gains）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.setEqBand(2, 6);
  await flush();
  eq.resetEq();
  await flush();
  assert.deepEqual(dom.prefs.eqGains, [0, 0, 0, 0, 0]);
});

test('flat 预设确实是全零曲线（resetEq 委派给它的前提）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('pop');
  await flush();
  eq.applyEqPreset('flat');
  await flush();
  assert.deepEqual(dom.prefs.eqGains, [0, 0, 0, 0, 0],
    "EQ_PRESETS.flat 若不再是全零，'重置'= applyEqPreset('flat') 就不成立");
});

// ── 唯一家：不许有两份"归零" ────────────────────────────────

test('bypass 按钮只有一处赋值点，三条路（预设/开关/启动恢复）都调它', () => {
  const src = read('src/renderer/js/player/eq.js');
  assert.equal(countOf(src, "'🎚️ EQ开启'"), 1,
    '按钮文案写两遍 = 必然有一处忘了改（本轮修的就是 applyEqPreset 漏了这一格）');
  assert.equal(countOf(src, "'🔇 EQ关闭'"), 1, '同上');
  assert.equal(countOf(src, '_syncBypassBtn()'), 4,
    '一处定义 + 三处调用：applyEqPreset / toggleEqBypass / restoreEqPresetSetting');
});

test('resetEq 委派 applyEqPreset("flat")，且不再自带第二份滑块归零循环', () => {
  const src = read('src/renderer/js/player/eq.js');
  const at = src.indexOf('export function resetEq()');
  assert.ok(at > -1, '找不到 resetEq');
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  assert.match(body, /applyEqPreset\(\s*'flat'\s*\)/,
    "默认态只许有一份定义（applyEqPreset('flat')），第二份必然长歪 —— 本轮的 bug 就是它");
  assert.ok(!/getElementById\('eq_/.test(body),
    '自建滑块循环就是"第二份归零"，它正是漏掉高亮与 bypass 的那只手');
  assert.ok(!/saveEqSettings\(\)/.test(body),
    '写 pref 的家在 applyEqPreset 里，resetEq 不该再抄一笔');
});

// ── 设置页接线（渲染层跑不起来，钉文本）──────────────────────

test('设置页「恢复所有设置为默认值」把均衡器算进去（它就在那页上）', () => {
  const src = read('src/renderer/js/views/settings.js');
  const at = src.indexOf('async function resetAllSettings()');
  assert.ok(at > -1, '找不到 resetAllSettings');
  const body = src.slice(at, src.indexOf('\n}\n', at) + 3);
  assert.match(body, /resetEq\s*\(/,
    '均衡器面板就在「播放」tab 里，恢复默认却绕开它 = 又一次半兑现');
  // 钉的是「对用户说的那句话」，不是函数体里我自己的注释 —— 早先按整段 body 找"均衡器"
  // 时，注释替文案顶了钉，变异（从弹窗文案里删掉均衡器）当场不红，这才改窄到 askConfirm 的入参。
  // 把这句话搬进了词典：入参变成了 t('toast.resetConfirm')，所以钉改成两截 ——
  // ① 调用点确实按键取词，② 词典里那句仍然点名均衡器。少任何一截都不算兑现承诺。
  assert.match(body, /askConfirm\(\s*t\('toast\.resetConfirm'\)\s*\)/,
    '确认弹窗的文案必须按键取自词典（源码里手抄一份中文 = 英文界面照旧漏中文）');
  const said = String(require('../src/renderer/js/lang/zh.json')['toast.resetConfirm']);
  assert.ok(said.length > 10, '词典里取不到确认弹窗的文案');
  assert.match(said, /均衡器/,
    '确认弹窗要点名它会复原均衡器（157 的 F2 纪律：承诺要说全）');
});

test('EQ 与设置页接线不引入契约外的 api 调用（零新 IPC 通道）', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  for (const p of ['src/renderer/js/player/eq.js', 'src/renderer/js/views/settings.js']) {
    const src = read(p);
    const used = [...src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1])
      .filter((k) => k !== 'invoke');
    assert.deepEqual(used.filter((k) => !(k in METHODS)), [], `${p} 有契约外方法`);
    const invoked = [...src.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(invoked.filter((c) => !(c in CHANNELS)), [], `${p} 有契约外通道`);
  }
});
