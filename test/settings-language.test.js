/**
 * 界面语言的三处对齐（下拉回填 / 单一保存路径 / 恢复默认真的换回中文）
 *
 * 症状（都是"语言"这一条设置与现实脱节，同一条线上的三个洞）：
 *   D1 打开设置页，语言下拉永远显示「中文」—— 加载函数按 GENERAL_PREFS 表回填，
 *      而 language 不在表里（它住在 index.html 的内联 onchange 上）。界面已经是
 *      English，下拉却说 zh；用户以为没记住，只好再切一次。
 *   D2 「恢复默认设置」不清 language —— 同一张表派生默认值，不在表里就不在重置清单里。
 *      点了恢复出厂，界面仍是英文。
 *   D3 保存路径有两只手：内联 onchange 调 i18n.setLanguage（写 pref + 换字典），
 *      若只把 language 塞进表，通用 change 监听器会再写一笔 pref = 双写。
 *
 * 为什么用这张表：恢复默认的默认值一律由 GENERAL_PREFS 派生（158 起立的规矩，
 * 手抄清单已被发现漏过 6 项）。表既是"有哪些设置"的唯一答案，语言不在表里
 * 就等于它不是个设置 —— 补进表是三处对齐的地基，摘掉内联 onchange 是它的前置。
 *
 * 分工：本文件里"表/接线/重置"三条是源码钉（渲染层跑不起来，只能钉文本，
 * 见 test/download-path.test.js 同族），pref 那一笔往返走真实 handler ——
 * 契约校验、传输层信封、prefs 落盘只有真实调用链才会走到。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const countOf = (s, sub) => s.split(sub).length - 1;

/** 取 function 声明体（从声明行到下一个顶层空行前最后一个 } —— 够用且失败会响） */
function fnBody(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `源码里找不到 ${decl}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > -1, `${decl} 的结束括号没找到`);
  return src.slice(at, end + 3);
}

// ── 真实 handler：language 这一笔 pref 往返（重置能不能落地，取决于这里）──

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-lang-userdata-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
prefs.init(userDataDir);
require('../src/main/ipc/prefs').register();

const { ENVELOPE_KEY } = require('../src/shared/ipcContract');
async function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  const env = await fn({}, ...args);
  assert.equal(env[ENVELOPE_KEY], 1, '必须是传输层信封');
  assert.equal(env.ok, true, '不该抛错: ' + (env.error && env.error.message));
  return env.data;
}

test('language 在 set-pref 白名单里，且写-读-改回 zh 全程落地（重置的地基没坏）', async () => {
  const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs');
  assert.equal(ALLOWED_PREF_KEYS.has('language'), true, '不在白名单 = 写入被静默拒绝');

  assert.equal(await invoke('set-pref', 'language', 'en'), true, '切英文必须写成功');
  assert.equal(await invoke('get-pref', 'language'), 'en');
  assert.equal(prefs.get('language'), 'en', '信封那侧读的必须是同一份盘');

  assert.equal(await invoke('set-pref', 'language', 'zh'), true, '恢复默认那一笔必须写成功');
  assert.equal(await invoke('get-pref', 'language'), 'zh');
});

// ── D1+D2：语言进表（回填与重置都由表派生）────────────────

test('GENERAL_PREFS 表里有 language 行，控件 id 与 index.html 对得上', () => {
  const src = read('src/renderer/js/views/settings.js');
  const table = src.slice(src.indexOf('const GENERAL_PREFS'), src.indexOf('// 命名模板实时预览'));
  assert.ok(table.includes('GENERAL_PREFS'), '表本身不见了');
  const row = table.match(/language:\s*\{([^}]*)\}/);
  assert.ok(row, `language 不在表里 —— 不在表里就等于它不是个设置：不回填、也不被恢复默认`);
  assert.match(row[1], /key:\s*'language'/);
  assert.match(row[1], /default:\s*'zh'/, '默认语言必须是中文（与 i18n 的兜底一致）');
  assert.match(row[1], /el:\s*'settingLanguage'/);
  assert.match(read('src/renderer/index.html'), /id="settingLanguage"/, '控件 id 与表对不上');
});

test('恢复默认把语言换回中文（清 pref 之外还要真的换字典）', () => {
  const src = read('src/renderer/js/views/settings.js');
  const body = fnBody(src, 'async function resetAllSettings()');
  assert.match(body, /i18n\.setLanguage\(GENERAL_PREFS\.language\.default\)/,
    '只 setPref 不重翻译 = 界面仍是英文（主题的 applyTheme 就是同样的两步，见本函数里那一行）');
  assert.ok(!/quality:\s*'standard'/.test(body),
    '重置清单必须由表派生，不许再手抄一份默认值');
});

// ── D3：保存路径只留一只手 ────────────────────────────────

test('index.html 不再内联调 setLanguage（表接管后它就是第二条保存路径）', () => {
  const html = read('src/renderer/index.html');
  assert.ok(!/i18n\.setLanguage/.test(html),
    '内联 onchange 与通用 change 监听器同触一次 = 同一笔 pref 写两遍');
  assert.match(html, /id="settingLanguage"/, '控件本身要在');
});

test('通用 change 监听器为 language 走 i18n（写 pref + 换字典都在 setLanguage 一家），且 setPref 只有一笔', () => {
  const src = read('src/renderer/js/views/settings.js');
  const body = fnBody(src, 'function setupGeneralSettingListeners()');
  assert.match(body, /cfg\.key === 'language'/, 'language 分支不见了');
  assert.match(body, /i18n\.setLanguage\(val\)/, '该走 setLanguage：它写 pref、换字典并重新翻译');
  assert.equal(countOf(body, 'api.setPref(cfg.key, val)'), 1,
    '通用那一笔 setPref 只能存在一处（language 走 else 之外的分支）');
  assert.ok(/else\s*\{[\s\S]{0,80}api\.setPref\(cfg\.key, val\)/.test(body),
    'language 分支必须与普通分支互斥，否则两笔 pref 先后覆盖');
});

test('设置页接线不引入契约外的 api 调用（零新 IPC 通道）', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  const src = read('src/renderer/js/views/settings.js');
  const used = [...src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1])
    .filter((k) => k !== 'invoke');
  const bad = used.filter((k) => !(k in METHODS));
  assert.deepEqual(bad, [], `契约外的 api 方法：${bad.join(', ')}`);
  const invoked = [...src.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  const badCh = invoked.filter((c) => !(c in CHANNELS));
  assert.deepEqual(badCh, [], `契约外的通道：${badCh.join(', ')}`);
});
