/**
 * 全局快捷键可自定义 —— 白名单、默认态、去重与三侧对账
 *
 * 改造前的真实状态（src/main/index.js:388）：四枚媒体键写死在函数体里的字面量数组，
 * 设置页只有一枚「全局媒体键」总开关。用户能做的一切是「全用」或「全不用」：
 * 键盘没有媒体键的人（绝大多数笔记本）拿不到任何便利，想让 ⏯ 让位给别人的人只能整个关掉。
 *
 * 本文件钉住这个功能的四条不变量：
 *  A 判据只有一处：accelerator 白名单、目标清单、默认值、去重规则全在 src/shared/accelerators.js，
 *    主进程不再持有第二份（T9 直接查源码里不许再出现媒体键字面量）。
 *  B 升级不改变行为：默认映射逐字复现改造前那三枚绑定（T2）。
 *  C 三侧对齐：index.html 的下拉项 / settings.js 的 prefs 表 / prefs 白名单，
 *    任何一侧偷偷漂移都会被对应那枚钉打红（T5~T7）。
 *  D 文案有键：新增长出来的中文都走词典，zh/en 成对（T8）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE_REL = 'src/shared/accelerators.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

function exists(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch (_e) { return false; }
}

/** 去掉块注释与行注释：对账一律看真代码，注释里举的例子不许算数 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 懒加载：模块不存在时给出的是「还没有这个文件」，而不是 require 抛栈把后面的钉一起吞掉 */
function acc() {
  assert.ok(exists(MODULE_REL), `缺模块 ${MODULE_REL}：全局快捷键的判据之家还没落地`);
  delete require.cache[require.resolve('../' + MODULE_REL)];
  return require('../' + MODULE_REL);
}

// ── A：模块形状 ────────────────────────────────────────

test(' 模块导出齐全（白名单/目标清单/归一/读绑定/默认 prefs）', () => {
  const m = acc();
  for (const name of ['ALLOWED_ACCELERATORS', 'UNBOUND', 'SHORTCUT_TARGETS',
    'normalizeAccelerator', 'readBindings', 'defaultShortcutPrefs']) {
    assert.ok(name in m, `未导出 ${name}`);
  }
  assert.ok(Array.isArray(m.ALLOWED_ACCELERATORS) && m.ALLOWED_ACCELERATORS.length >= 4);
  assert.strictEqual(m.UNBOUND, '', '未绑定必须用空串：它同时是 <option value=""> 的形状');
});

test('自检：HTML 下拉项解析器真的能发现被删掉的候选键', () => {
  const html = `
    <select id="settingShortcutNext"><option value="">x</option><option value="MediaNextTrack">y</option></select>`;
  assert.deepStrictEqual(parseSelectOptions(html).settingShortcutNext, ['', 'MediaNextTrack']);
  // 少一个 option 必须被解析成少一个值（解析器若只会「找到就算」，T5 是假钉）
  assert.deepStrictEqual(parseSelectOptions(html).settingShortcutNext.length, 2);
  assert.deepStrictEqual(parseSelectOptions('<div id="settingShortcutNext"></div>').settingShortcutNext, undefined);
});

/** prefs.get 形态的取值器：主进程侧就是这个签名，测试用同一签名免得测两遍 */
function prefSource(map) {
  return (key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
}

// ── B：升级即刻的行为等价 ──────────────────────────────

test(' 默认映射逐字复现改造前写死的那三枚媒体键', () => {
  const m = acc();
  // 全新安装：prefs 里什么都没有，取值器一律回 undefined
  const got = m.readBindings(() => undefined);
  assert.deepStrictEqual(got, [
    { accelerator: 'MediaPlayPause', id: 'playPause', channel: 'tray-toggle-play' },
    { accelerator: 'MediaPreviousTrack', id: 'prev', channel: 'tray-prev' },
    { accelerator: 'MediaNextTrack', id: 'next', channel: 'tray-next' },
  ], '默认态必须与升级前一模一样：用户没动过设置就不许感到行为变了（显示/隐藏窗口默认不抢键）');
});

test(' 每个目标的默认值都在白名单里（未绑定除外）', () => {
  const m = acc();
  const bad = m.SHORTCUT_TARGETS
    .filter((t) => t.default !== m.UNBOUND && !m.ALLOWED_ACCELERATORS.includes(t.default))
    .map((t) => `${t.id}=${t.default}`);
  assert.deepStrictEqual(bad, [], '默认值不在白名单 = 出厂即归一，界面与注册行为对不上：' + bad.join(', '));
});

test(' 默认 prefs 表每次都是新对象（防止调用方就地改坏出厂值）', () => {
  const m = acc();
  const a = m.defaultShortcutPrefs();
  a[m.SHORTCUT_TARGETS[0].prefKey] = 'Ctrl+Alt+Space';
  assert.notStrictEqual(m.defaultShortcutPrefs(), a, 'defaultShortcutPrefs 返回了同一个对象');
  assert.ok(m.SHORTCUT_TARGETS.every((t) => t.prefKey in m.defaultShortcutPrefs()));
});

// ── 归一：外部数据（备份导入/手改 prefs.json）不得越界 ──

test(' 归一只放行白名单与未绑定，其余回落该目标默认值', () => {
  const m = acc();
  assert.strictEqual(m.normalizeAccelerator('Ctrl+Alt+Space', 'MediaPlayPause'), 'Ctrl+Alt+Space');
  assert.strictEqual(m.normalizeAccelerator(m.UNBOUND, 'MediaPlayPause'), m.UNBOUND,
    '主动解绑是合法意图，不能被回落成默认键盖掉');
  for (const junk of [undefined, null, 0, {}, [], 'MediaPlayPause ', 'mediaplaypause', 'Ctrl+Alt+', '  ']) {
    assert.strictEqual(m.normalizeAccelerator(junk, 'MediaNextTrack'), 'MediaNextTrack',
      '垃圾值 ' + JSON.stringify(junk) + ' 应回落默认：不能把用户的其它键抢掉');
  }
});

test(' 一枚键只能有一个动作：按目标清单顺序先到先得', () => {
  const m = acc();
  const [playPause, prev, next] = m.SHORTCUT_TARGETS;
  const prefs = m.defaultShortcutPrefs();
  // 把「上一首」「下一首」都指向同一枚键：只有清单里靠前的那个拿得到
  prefs[prev.prefKey] = 'Ctrl+Alt+Space';
  prefs[next.prefKey] = 'Ctrl+Alt+Space';
  const got = m.readBindings(prefSource(prefs));
  const dupes = got.filter((b) => b.accelerator === 'Ctrl+Alt+Space');
  assert.strictEqual(dupes.length, 1, '同一 accelerator 注册两次：Electron 会把第二次的回调静默吞掉');
  assert.strictEqual(dupes[0].id, prev.id);
  assert.ok(got.some((b) => b.id === playPause.id));
});

test(' 解绑与垃圾值混合输入不崩、顺序稳定', () => {
  const m = acc();
  const prefs = { [m.SHORTCUT_TARGETS[0].prefKey]: m.UNBOUND, [m.SHORTCUT_TARGETS[2].prefKey]: 42 };
  const got = m.readBindings(prefSource(prefs));
  assert.deepStrictEqual(got.map((b) => b.id), ['prev', 'next'],
    'playPause 被解绑应缺席；next 拿到垃圾值应回落默认键后仍在场');
});

// ── C：三侧对账 ────────────────────────────────────────

/** index.html 里每个 .setting-select 的 id → option value 序列 */
function parseSelectOptions(html) {
  const out = {};
  const re = /<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  let mm;
  while ((mm = re.exec(html))) {
    const vals = [];
    const ore = /<option\b[^>]*\bvalue="([^"]*)"/g;
    let om;
    while ((om = ore.exec(mm[2]))) vals.push(om[1]);
    out[mm[1]] = vals;
  }
  return out;
}

test(' 设置页四枚下拉的候选项与白名单逐字相等（多一枚少一枚都算漂移）', () => {
  const m = acc();
  const selects = parseSelectOptions(read('src/renderer/index.html'));
  const expected = [m.UNBOUND].concat(m.ALLOWED_ACCELERATORS);
  const missing = [];
  for (const t of m.SHORTCUT_TARGETS) {
    const id = 'settingShortcut' + t.id[0].toUpperCase() + t.id.slice(1);
    const got = selects[id];
    if (!got) { missing.push(`${id} 不存在`); continue; }
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      missing.push(`${id} 实有=${JSON.stringify(got)} 应为=${JSON.stringify(expected)}`);
    }
  }
  assert.deepStrictEqual(missing, [], '设置页候选项与主进程白名单不符：\n  ' + missing.join('\n  '));
});

test(' 四个 pref 键都在 set-pref 白名单里（否则是只能读不能改的死旋钮）', () => {
  const m = acc();
  const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs');
  const bad = m.SHORTCUT_TARGETS.filter((t) => !ALLOWED_PREF_KEYS.has(t.prefKey)).map((t) => t.prefKey);
  assert.deepStrictEqual(bad, [], '这些键渲染层写不进去：' + bad.join(', '));
});

test(' 渲染层 prefs 表的默认值与判据之家逐字相等（这张表同时管回填与恢复默认）', () => {
  const m = acc();
  const code = stripComments(read('src/renderer/js/views/settings.js'));
  const bad = [];
  for (const t of m.SHORTCUT_TARGETS) {
    const id = 'settingShortcut' + t.id[0].toUpperCase() + t.id.slice(1);
    // 一条表项：key: 'shortcutNext', ... default: 'MediaNextTrack', el: 'settingShortcutNext'
    const re = new RegExp(`key:\\s*'${t.prefKey}'[^\\n]*`);
    const line = code.match(re);
    if (!line) { bad.push(`GENERAL_PREFS 里没有 ${t.prefKey}`); continue; }
    if (!line[0].includes(`el: '${id}'`)) bad.push(`${t.prefKey} 的 el 不是 ${id}`);
    const def = line[0].match(/default:\s*(null|'([^']*)'|[^\s,]+)/);
    const raw = def ? def[1] : undefined;
    // 未绑定写成空串：它正是 <option value=""> 的形状，回填时 String('') 能选中美文那条
    const want = `'${t.default}'`;
    if (raw !== want) bad.push(`${t.prefKey} 默认值=${raw} 应为=${want}`);
  }
  assert.deepStrictEqual(bad, [], '渲染层与 src/shared/accelerators.js 漂移：\n  ' + bad.join('\n  '));
});

test(' 总开关与四枚下拉共用一个重注册出口', () => {
  const code = stripComments(read('src/renderer/js/views/settings.js'));
  const m = acc();
  const defs = code.match(/function reapplyGlobalShortcuts\(/g) || [];
  assert.strictEqual(defs.length, 1, '重注册出口必须只有一个：各写一遍就会互相覆盖注册顺序');
  // 定义行 `function reapplyGlobalShortcuts() {` 里也含这个字面量，排除掉才是调用点
  const calls = code.match(/(?<!function )reapplyGlobalShortcuts\(\)/g) || [];
  assert.strictEqual(calls.length, 1, '五个消费方应通过判据函数汇到一处，而不是五处各调一次');
  // 那一处调用必须由「是不是快捷键相关 pref」驱动，且总开关与四个动作全在里面
  const branch = code.match(/if \(isShortcutPref\(cfg\.key\)\) \{\s*\n\s*reapplyGlobalShortcuts\(\);/);
  assert.ok(branch, 'change 监听里没有走 isShortcutPref 的重注册分支：改了键不会立刻生效');
  const setDecl = code.match(/const SHORTCUT_PREF_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(setDecl, '没有 SHORTCUT_PREF_KEYS 这张清单');
  const listed = setDecl[1].match(/'[^']*'/g).map((s) => s.slice(1, -1));
  const missing = ['globalShortcuts'].concat(m.SHORTCUT_TARGETS.map((t) => t.prefKey))
    .filter((k) => !listed.includes(k));
  assert.deepStrictEqual(missing, [], '这些键改了不会重注册：' + missing.join(', '));
  assert.deepStrictEqual(listed.filter((k) => k !== 'globalShortcuts'
    && !m.SHORTCUT_TARGETS.some((t) => t.prefKey === k)), [],
    '清单里躺着判据之家不认识的动作键（改名后忘同步 = 静默失灵）');
});

test(' 恢复默认也会重注册（借道 change 事件，不新开第二个出口）', () => {
  const code = stripComments(read('src/renderer/js/views/settings.js'));
  const reset = code.slice(code.indexOf('async function resetAllSettings'));
  assert.ok(reset.length > 100, '没找到 resetAllSettings');
  assert.match(reset, /getElementById\('settingGlobalShortcuts'\)[\s\S]{0,160}dispatchEvent\(new Event\('change'\)\)/,
    '「恢复默认」写完 prefs 却不重注册：系统里仍压着用户旧的那几枚全局键，直到重启才对上');
});

// ── D：判据之家唯一 ────────────────────────────────────

test(' 主进程不再自带第二份媒体键清单', () => {
  const m = acc();
  // shortcuts 代码从 index.js 拆到 src/main/shortcuts.js（v1.0.36 架构整理），
  // 判据之家检查 src/main/ 目录下的任何文件是否从 shared/accelerators 导入
  const mainShortcutsCode = stripComments(read('src/main/shortcuts.js'));
  assert.ok(/require\('\.\.\/shared\/accelerators'\)/.test(mainShortcutsCode),
    '主进程 shortcuts 模块没有走 shared 判据之家');
  // 兜底：index.js 不应再出现 accelerators 字面量（已迁走）
  const indexCode = stripComments(read('src/main/index.js'));
  const leaked = m.ALLOWED_ACCELERATORS.filter((a) => indexCode.includes(`'${a}'`));
  assert.deepStrictEqual(leaked, [],
    '这些 accelerator 字面量又回到 index.js 了（改一处漏一处的老毛病）：' + leaked.join(', '));
});

test(' 显示/隐藏窗口是主进程内动作，不借道新 IPC 通道', () => {
  const m = acc();
  const showHide = m.SHORTCUT_TARGETS.find((t) => t.id === 'showHide');
  assert.strictEqual(showHide.channel, null, 'showHide 不该有通道：它是主进程自己的窗口动作');
  const { CHANNELS } = require('../src/shared/ipcContract');
  const names = Object.keys(CHANNELS);
  const before = names.filter((c) => /shortcut/i.test(c));
  assert.deepStrictEqual(before, ['set-global-shortcuts'],
    '快捷键相关通道必须仍只有那一条既有的：' + before.join(', '));
});

test(' 新增文案 zh/en 成对且都进了词典', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
    (v && typeof v === 'object') ? flat(v, p + k + '.') : [p + k]);
  const zhKeys = new Set(flat(zh));
  const enKeys = new Set(flat(en));
  const html = read('src/renderer/index.html');
  const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((s) => s[1])
    .filter((k) => /^settings\.general\.shortcut/.test(k));
  assert.ok(used.length >= 5, '设置页里几乎没有快捷键相关词条的接线（' + used.length + '）');
  const missing = used.filter((k) => !zhKeys.has(k) || !enKeys.has(k));
  assert.deepStrictEqual(missing, [], 'HTML 引用了某侧词典里没有的键：' + missing.join(', '));
  const asymmetric = [...zhKeys].filter((k) => /^settings\.general\.shortcut/.test(k) && !enKeys.has(k))
    .concat([...enKeys].filter((k) => /^settings\.general\.shortcut/.test(k) && !zhKeys.has(k)));
  assert.deepStrictEqual(asymmetric, [], 'shortcut 相关键 zh/en 不成对：' + [...new Set(asymmetric)].join(', '));
});
