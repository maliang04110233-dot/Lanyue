/**
 * 预设高亮改为「曲线的函数」—— 手调滑块后按钮不再指着摇滚说"当前是摇滚"
 *
 * 症状（179 只修好了重置那条路，这扇门当时就记在候选里）：
 * eq.js 里有两份"当前是什么曲线"的状态 —— `_gains`（头注释第 31 行自称"唯一真身"）
 * 和 `currentEqPreset`（它的影子抄本）。手调滑块只动前者：
 *   D1 拖完低音滑条，曲线已不是 rock，「摇滚」按钮上的 eq-preset-active 却还亮着 ——
 *      界面当场指着一堆数字说谎，且滑条读数与它互相打脸；
 *   D2 拖完松手只写 eqGains，eqPreset 仍存 'rock' —— 高亮不只是花架子，它重启后还会复活；
 *   D3 重启 restoreEqPresetSetting 恢复的曲线是对的（按 eqGains），点亮名字是错的（按 eqPreset）
 *      —— 用户下次开机看到的仍是「摇滚」，错误状态被固化；
 *   D4 头注释承诺「三个偏好键在预设/手调/重置/bypass 四个动作里都会写」，手调那格其实不写
 *      eqPreset —— 177/179/184 同族的"注释与代码各说各话"。
 *
 * 修法（消灭影子状态，而不是给它补一次同步）：高亮与 eqPreset 一律由 matchPresetName(_gains)
 * 现推 —— 曲线是唯一事实源，镜子只能是它的函数。currentEqPreset 整个变量删掉：
 * 只要它还在，就总有某条路径忘记更新它（168 立法：同一个事实只许有一个家）。
 * 无匹配时存 'custom'（新值，老版本读到它会走 EQ_PRESETS 校验失败 → 回退，向后兼容），
 * 并在均衡器面板上显式标出「自定义」，免得"哪个都没亮"被读成控件坏了。
 *
 * 分工：本文件是真行为测（Node 里动态 import eq.js，桩 DOM + 桩 api 收 prefs，
 * 无 AudioContext 也能跑完整状态机 —— 与 179 同一套路）；影子状态是否真被删净、
 * 词典是否补齐这类"跨文件形状"另走源码钉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const countOf = (s, sub) => s.split(sub).length - 1;

/**
 * 去掉块/行注释，注释换成等量空格（行号与偏移不变）。
 * 本增量的头注释要写清楚"删掉的是哪个影子变量"，反向钉若连注释一起扫，
 * 就会被自己的说明文字打进红 —— 口径同 eq-behaviour.test.js 的 stripComments。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const eqCode = () => stripComments(read('src/renderer/js/player/eq.js'));

const EQ_BAND_COUNT = 5;
const PRESET_NAMES = ['flat', 'pop', 'rock', 'classic', 'vocal', 'dance', 'jazz', 'bass'];
/** 测试侧抄一份 rock 曲线：真身是 EQ_PRESETS.rock，用它做"手调前后"的对照 */
const ROCK = [4, 2, -1, 1, 3];

/** 等 fire-and-forget 的 prefs 落笔 */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function domStub(seedPrefs = {}) {
  const mk = (o) => Object.assign({
    style: o.style || {},
    classList: {
      _set: new Set(o.classes || []),
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
  const hint = mk({ id: 'eqCustomHint', textContent: '自定义', style: { display: 'none' } });
  byId.eqCustomHint = hint;
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
  global.window = { addEventListener: () => {} };
  const prefs = Object.assign({}, seedPrefs);
  global.api = {
    setPref: async (k, v) => { prefs[k] = JSON.parse(JSON.stringify(v)); return true; },
    getPref: async (k) => prefs[k],
  };
  const activeNames = () => presetBtns.filter((b) => b.classList.contains('eq-preset-active')).map((b) => b.dataset.eqPreset);
  return { prefs, sliders, labels, bypassBtn, presetBtns, hint, activeNames };
}

const freshEq = () => import('../src/renderer/js/player/eq.js?tc=' + Math.random());

// ── 纯函数：派生的那唯一一只手 ────────────────────────────

test('matchPresetName 认得每条预设，认不出时如实返回 null（不许瞎猜最近的一条）', async () => {
  const eq = await freshEq();
  assert.equal(typeof eq.matchPresetName, 'function',
    'eq.js 没出这个派生函数 —— 高亮就还得靠某条路径记得去更新影子变量');
  assert.equal(eq.matchPresetName([0, 0, 0, 0, 0]), 'flat');
  assert.equal(eq.matchPresetName(ROCK), 'rock');
  assert.equal(eq.matchPresetName([6, 3, -1, -1, 0]), 'bass');
  assert.equal(eq.matchPresetName([4, 2, -1, 1, 4]), null, '差 1dB 就不是 rock，不许回落到它');
  assert.equal(eq.matchPresetName([1, 2, 3]), null, '段数不符不得当作任何预设');
  assert.equal(eq.matchPresetName(null), null);
  assert.equal(eq.PRESET_CUSTOM, 'custom', '存进 pref 的"自定义"哨兵值');
});

// ── 真行为：手调那一刻高亮就得改口 ──────────────────────

test('套摇滚后手调一格：所有预设高亮熄灭，「自定义」标记亮出（D1）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  assert.deepEqual(dom.activeNames(), ['rock'], '前置条件：选完预设确实点亮摇滚（否则本测只在"从来没亮过"里空转）');
  assert.equal(dom.hint.style.display, 'none', '前置条件：命中预设时不该标自定义');

  eq.setEqBand(0, 9);
  assert.deepEqual(dom.activeNames(), [],
    '曲线已经不是任何预设，按钮必须全灭 —— 亮着就是指着数字说谎');
  assert.notEqual(dom.hint.style.display, 'none',
    '全灭得有个说法，否则用户读成"控件坏了"');
});

test('手调后松手（saveEqSettings 那一次提交）：eqPreset 与 eqGains 一起落地（D2 + 头注释的承诺）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  eq.setEqBand(0, 9);
  await eq.saveEqSettings();
  await flush();
  assert.equal(dom.prefs.eqPreset, 'custom', 'eqPreset 仍存 rock = 高亮的谎能活过重启');
  assert.deepEqual(dom.prefs.eqGains, [9, 2, -1, 1, 3]);
});

test('把手调的那格改回原值：曲线重新等于 rock，高亮又亮回摇滚（派生而非一次性标记）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  eq.setEqBand(0, 9);
  assert.deepEqual(dom.activeNames(), []);
  eq.setEqBand(0, ROCK[0]);
  assert.deepEqual(dom.activeNames(), ['rock'],
    '派生的意思就是"能被改回去"：若这里仍全灭，说明高亮是只写一次的标记而非函数');
  assert.equal(dom.hint.style.display, 'none');
});

// ── 真行为：重启路径（错误状态今天会被固化）─────────────

test('重启后 eqPreset 存着 rock 而曲线是手调的：恢复曲线正确、一个都不亮、标「自定义」（D3）', async () => {
  const dom = domStub({ eqPreset: 'rock', eqGains: [4, 2, -1, 1, 4], eqBypass: false });
  const eq = await freshEq();
  await eq.restoreEqPresetSetting();
  await flush();
  assert.equal(dom.sliders[4].value, 4, '前置条件：eqGains 确实被恢复（曲线是对的）');
  assert.deepEqual(dom.activeNames(), [],
    '今天的真实症状：曲线不是 rock，按钮却按存过的名字点亮摇滚');
  assert.notEqual(dom.hint.style.display, 'none');
});

test('重启后曲线恰好等于某个预设：即便 pref 里存的是 custom，也照曲线点亮那个预设', async () => {
  const dom = domStub({ eqPreset: 'custom', eqGains: ROCK, eqBypass: false });
  const eq = await freshEq();
  await eq.restoreEqPresetSetting();
  await flush();
  assert.deepEqual(dom.activeNames(), ['rock'],
    '派生只看曲线：存过的名字不参与高亮，否则又回到"按名字画镜子"');
  assert.equal(dom.hint.style.display, 'none');
});

test('bypass 不改曲线也不改高亮；恢复默认仍走那一家（179 的委派不许被本增量破）', async () => {
  const dom = domStub();
  const eq = await freshEq();
  eq.applyEqPreset('rock');
  eq.toggleEqBypass();
  await flush();
  assert.deepEqual(dom.activeNames(), ['rock'], 'bypass 是"暂时不生效"，不是"换了曲线"');
  assert.equal(dom.prefs.eqPreset, 'rock');
  assert.equal(dom.prefs.eqBypass, true, '三键合写的一家若漏了 eqBypass，重启后 EQ 又悄悄开着');
  eq.resetEq();
  await flush();
  assert.deepEqual(dom.activeNames(), ['flat'], '重置后必须点亮「默认」：flat 也是一条真实曲线');
  assert.equal(dom.hint.style.display, 'none');
  assert.equal(dom.prefs.eqPreset, 'flat');
  assert.equal(dom.prefs.eqBypass, false);
  assert.deepEqual(dom.prefs.eqGains, [0, 0, 0, 0, 0]);
});

// ── 形状钉：影子状态必须真的没了 ─────────────────────────

test('currentEqPreset 这个影子变量被删净（留着它就总有路径忘记同步，D1 就是这么来的）', () => {
  const src = eqCode();   // 扫代码不扫注释：头注释里要写"删掉的是谁"，见上方 stripComments
  assert.ok(!/currentEqPreset/.test(src),
    'eq.js 仍有 currentEqPreset：曲线已经声明过唯一真身是 _gains，第二份"当前预设"必然漂移');
  assert.equal(countOf(src, 'eq-preset-active'), 1,
    '高亮的写入口只许有一面镜子（现在有三条路各自画，正是 179 的前车之鉴）');
});

test('三条会改曲线/改状态的路都叫同一个派生镜子，而不是各自 querySelectorAll', () => {
  const src = eqCode();
  const body = (decl) => {
    const i = src.indexOf(decl);
    assert.ok(i >= 0, `找不到 ${decl}`);
    const end = src.indexOf('\n}\n', i);
    return src.slice(i, end);
  };
  ['export function applyEqPreset(name) {', 'export function setEqBand(index, gain) {', 'export async function saveEqSettings() {'].forEach((decl) => {
    assert.match(body(decl), /_syncPresetHighlight\(\)/, `${decl} 必须经同一面镜子画高亮`);
  });
  assert.match(body('async function restoreEqPresetSetting()'), /_syncPresetHighlight\(\)/);
  assert.match(body('export async function saveEqSettings()'), /saveEqPresetSetting|setPref\('eqPreset'/,
    '手调提交必须连 eqPreset 一起写，否则谎话能活过重启');
});

// ── 接线与契约 ───────────────────────────────────────────

test('「自定义」标记在 index.html 里存在，且 zh/en 词典都有这个 i18n 键（177 的教训：漏词典=英文界面露裸串）', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<span id="eqCustomHint"[^>]*data-i18n="settings\.general\.eqCustom"/,
    'eq.js 靠这个 id 找到标记；缺节点则"全灭"永远没有解释');
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const pick = (o) => o['settings.general.eqCustom'];   // 词典是扁平点号键，不是嵌套对象
  assert.equal(typeof pick(zh), 'string', 'zh 词典缺 settings.general.eqCustom');
  assert.equal(typeof pick(en), 'string', 'en 词典缺 settings.general.eqCustom');
  assert.notEqual(pick(en), pick(zh), 'en 必须是另一种语言，不许照抄中文');
});

test('本增量不引入契约外的 api 方法与通道（零新 IPC）', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  const src = eqCode();   // 同上：键清单只认代码，不认说明文字
  const used = [...src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]).filter((k) => k !== 'invoke');
  const bad = [...new Set(used.filter((k) => !(k in METHODS)))];
  assert.deepEqual(bad, [], 'eq.js 里契约外的 api 方法：' + bad.join(', '));
  const invoked = [...src.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(invoked.filter((c) => !(c in CHANNELS)))], [], 'eq.js 里契约外的通道');
  const prefs = [...src.matchAll(/setPref\('([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(prefs)].sort(), ['eqBypass', 'eqGains', 'eqPreset'],
    'EQ 的写键清单变了就必须同步头注释与 179/184 的口径');
});
