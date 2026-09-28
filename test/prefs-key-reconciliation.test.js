/**
 * pref 键的双向对账 —— 白名单既不是垃圾场，也不是许愿单
 *
 * src/main/ipc/prefs.js 的头注释自己写着「键全集 = 主进程 prefs.get() 读取的键 ∪
 * 渲染层 getPref/setPref 使用的键」，可这行承诺历来只有一个方向有人看守
 * （test/prefs-whitelist.test.js 钉「渲染层会写的键必须在白名单」）。反方向没人管，
 * 白名单就只进不出，实测两类漂移同时存在：
 *
 *  A 幽灵键（能写成功、没有任何人读）：downloadQuality / autoPlay / showLyrics /
 *    miniPlayerAlwaysOnTop —— 四枚从 v2 首个提交（4d06dbc）就挂在白名单里，界面上
 *    从没长出过对应控件。set-pref 对它们返回 true，等于对调用方承诺「设置已保存」，
 *    而这件事永远不会发生；老备份里的这些键还会被导入重新装回 prefs.json。
 *  B 死旋钮（有人读、没人能写）：subscriptionCheckIntervalHours —— 主进程每次算检查
 *    间隔都读它，但它不在白名单 ⇒ 渲染层任何写法都被拒，只有测试能直接塞进 prefs。
 *    用户看到的就是「订阅永远每 6 小时查一次，想改改不了」。
 *
 * 本文件把两个方向同时钉住，并给扫描器配自测：扫描器一旦坏掉，这两枚钉会永远绿着，
 * 那比没有钉更糟。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');

const prefs = require('../src/utils/prefs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-prefs189-'));
prefs.init(TMP);

const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs');
const cloudSync = require('../src/main/ipc/cloudSync');
const subs = require('../src/main/subscriptions');

const ROOT = path.join(__dirname, '..');
const HOUR = 3600 * 1000;

test.after(() => {
  prefs.destroy();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 扫描器 ─────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// 反向钉一律扫去掉注释后的代码：本文件要拿"删掉了哪些键"写进注释，连注释一起扫会被自己打红
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) walk(rel, out);
    else if (/\.(js|html|json)$/.test(ent.name)) out.push(rel);
  }
  return out;
}

/** 白名单声明字面量（它自己当然"引用"了每个键，必须摘掉再扫） */
const WHITELIST_DECL = /const ALLOWED_PREF_KEYS = new Set\(\[[\s\S]*?\]\);/;

/** 全仓可扫面：去掉注释的代码；prefs.js 额外去掉白名单声明本身 */
function codeBlobs() {
  const blobs = {};
  for (const rel of walk('src')) {
    let code = stripComments(read(rel));
    if (rel === 'src/main/ipc/prefs.js') code = code.replace(WHITELIST_DECL, '');
    blobs[rel] = code;
  }
  return blobs;
}

/** 白名单里没有任何消费方的键：k 在所有代码文件里都不再以带引号字面量出现。
 *  带引号才算 —— 渲染层那些 `downloadQuality: (q) => …` 是右键菜单的回调选项名，与 pref 无关。 */
function ghostKeys(keys, blobs = codeBlobs()) {
  return keys.filter((k) => !Object.values(blobs).some((code) => new RegExp(`['"]${k}['"]`).test(code)));
}

/** 主进程自己会写的键（不经 set-pref，故不必进白名单） */
function mainSelfWritten(blobs = codeBlobs()) {
  const out = new Set();
  for (const code of Object.values(blobs)) {
    for (const m of code.matchAll(/prefs\.set\(\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1]);
  }
  return out;
}

/** 主进程/utils 用字面量读到的键 */
function mainReadKeys(blobs = codeBlobs()) {
  const out = new Set();
  for (const code of Object.values(blobs)) {
    for (const m of code.matchAll(/prefs\.get\(\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1]);
  }
  return out;
}

/** 有人读、却没人能写的死旋钮：既不在 set-pref 白名单，主进程也不会自己写 */
function deadKnobs(blobs = codeBlobs()) {
  const selfWritten = mainSelfWritten(blobs);
  return [...mainReadKeys(blobs)].filter((k) => !ALLOWED_PREF_KEYS.has(k) && !selfWritten.has(k));
}

// ── 0. 扫描器自测（钉本身先证明自己会红）─────────────────

const GHOST4 = ['downloadQuality', 'autoPlay', 'showLyrics', 'miniPlayerAlwaysOnTop'];

test('扫描器自测：合成幽灵必被逮、真键不误逮、注释与无引号属性名不算消费方', () => {
  const blobs = {
    'a.js': `const t = 'theme'; prefs.get('subscriptionCheckIntervalHours'); // 'autoPlay' 只在注释里
      const menu = { downloadQuality: (q) => q };`,
  };
  assert.deepEqual(ghostKeys(['theme', 'zzNoSuchPrefKey'], blobs), ['zzNoSuchPrefKey']);
  assert.deepEqual(ghostKeys(['autoPlay'], blobs), [], '注释里的字面量不能算消费方');
  assert.deepEqual(ghostKeys(['downloadQuality'], blobs), ['downloadQuality'],
    '无引号的对象属性名（右键菜单回调名）不是 pref 引用，不该把它当成消费方');
  // 真白名单里确有消费方的键，扫面必须认得（否则第 1 测会恒红在错的地方）
  assert.deepEqual(ghostKeys(['theme', 'saveDir', 'searchHistory', 'convertOutputDir'], codeBlobs()), []);
});

test('扫描器自测：死旋钮判据既认自写键、也认白名单键，只留真空档', () => {
  const blobs = {
    'x.js': `prefs.get('userPlaylists'); prefs.set('userPlaylists', []);
             prefs.get('theme'); prefs.get('zzNeverWritten');`,
  };
  const dead = deadKnobs(blobs);
  assert.ok(dead.includes('zzNeverWritten'), '只读不写又不在白名单 = 死旋钮，必须被逮');
  assert.ok(!dead.includes('userPlaylists'), '主进程自写的键不该算死旋钮');
  assert.ok(!dead.includes('theme'), '白名单里的键有写入口，不该算死旋钮');
});

// ── 1. 两个方向的对账 ───────────────────────────────────

test('白名单里没有幽灵键：每个可写的 pref 键都有人读（头注释承诺的键全集）', () => {
  assert.deepEqual(ghostKeys([...ALLOWED_PREF_KEYS]), [],
    '这些键 set-pref 会回 true，却没有任何代码读它们 —— 要么补消费方，要么从白名单删掉');
});

test('没有死旋钮：主进程读的每个字面量键都有写入口', () => {
  assert.deepEqual(deadKnobs(), [],
    '这些键被 prefs.get 读着，却既不在 set-pref 白名单也不被主进程写入 —— 用户永远改不动它');
});

test('点名单：四枚幽灵键已从白名单删净（写了会成功、但永远不生效的假开关）', () => {
  for (const k of GHOST4) assert.ok(!ALLOWED_PREF_KEYS.has(k), `${k} 仍可写入，却无人读取`);
  const code = stripComments(read('src/main/ipc/prefs.js')).replace(WHITELIST_DECL, '');
  for (const k of GHOST4) {
    assert.ok(!new RegExp(`['"]${k}['"]`).test(code), `${k} 仍留在 prefs.js 的代码里`);
  }
});

// ── 2. 幽灵键删掉后的边界：不能顺手把活键也删了 ──────────

test('活音质/播放键一枚不少：删幽灵不等于清库', () => {
  for (const k of ['quality', 'qualityBySource', 'playbackRate', 'playerVolume', 'afterQueueDone',
    'eqBypass', 'lyricsVisible', 'clipboardWatch', 'welcomeSeen', 'subscriptionCheckIntervalHours']) {
    assert.ok(ALLOWED_PREF_KEYS.has(k), `${k} 是有消费方的真设置键，不该消失`);
  }
});

test('导入侧真行为：老备份里的幽灵键不再被装回，正常键照旧通过', () => {
  const legacy = { theme: 'neon', autoPlay: true, showLyrics: true, downloadQuality: 'hq', miniPlayerAlwaysOnTop: true };
  const { kept, droppedDirs } = cloudSync.pickImportablePrefs(legacy);
  assert.equal(kept.theme, 'neon');
  assert.equal(droppedDirs, 0);
  for (const k of ['autoPlay', 'showLyrics', 'downloadQuality', 'miniPlayerAlwaysOnTop']) {
    assert.ok(!(k in kept), `${k} 已无消费方，备份里的残留值不该再装回 prefs.json`);
  }
});

// ── 3. 死旋钮的兑现：订阅检查间隔真的能改、真的生效 ──────

test('_intervalMs 真按 pref 走：设 3 小时就是 3 小时，字符串 12（输入框交来的）也认', () => {
  const { _intervalMs } = subs._internal;
  prefs.set('subscriptionCheckIntervalHours', 3);
  assert.equal(_intervalMs(), 3 * HOUR);
  prefs.set('subscriptionCheckIntervalHours', '12');
  assert.equal(_intervalMs(), 12 * HOUR);
  prefs.set('subscriptionCheckIntervalHours', 168);
  assert.equal(_intervalMs(), 168 * HOUR);
});

test('未设置与脏值一律回落到默认档，且越界值被夹在可用区间内', () => {
  const { _intervalMs, DEFAULT_CHECK_INTERVAL_HOURS, MIN_CHECK_INTERVAL_HOURS, MAX_CHECK_INTERVAL_HOURS } = subs._internal;
  assert.equal(DEFAULT_CHECK_INTERVAL_HOURS, 6, '默认档是 6 小时，改动它要连设置页的 default 一起改');
  prefs.set('subscriptionCheckIntervalHours', 'abc');
  assert.equal(_intervalMs(), DEFAULT_CHECK_INTERVAL_HOURS * HOUR);
  for (const bad of [0, -5, 0.5, null, '', {}, undefined]) {
    prefs.set('subscriptionCheckIntervalHours', bad);
    assert.ok(_intervalMs() >= MIN_CHECK_INTERVAL_HOURS * HOUR, `${JSON.stringify(bad)} 应落到下限`);
  }
  prefs.set('subscriptionCheckIntervalHours', 99999);
  assert.equal(_intervalMs(), MAX_CHECK_INTERVAL_HOURS * HOUR, '上限必须封顶，否则等于悄悄关掉自动检查');
});

test('下限不得小于调度器醒来的粒度（设了更快却不会更快 = 又一个假开关）', () => {
  const { MIN_CHECK_INTERVAL_HOURS } = subs._internal;
  assert.ok(MIN_CHECK_INTERVAL_HOURS * HOUR >= subs._internal.CHECK_TICK_MS,
    '检查间隔下限必须 ≥ 调度 tick，否则用户调到最小也毫无变化');
});

// ── 4. 接线契约：间隔这一档真的长在设置页上，且两份数字是一家 ──

test('设置页真的能改检查间隔：登记表有条目、DOM 有数字框、上下限与主进程同源', () => {
  const settings = stripComments(read('src/renderer/js/views/settings.js'));
  const html = read('src/renderer/index.html');
  const { DEFAULT_CHECK_INTERVAL_HOURS, MIN_CHECK_INTERVAL_HOURS, MAX_CHECK_INTERVAL_HOURS } = subs._internal;
  const row = settings.match(/subscriptionCheckIntervalHours:\s*\{\s*key:\s*'subscriptionCheckIntervalHours',\s*default:\s*(\d+),\s*el:\s*'(\w+)'\s*\}/);
  assert.ok(row, 'GENERAL_PREFS 里没有订阅检查间隔 —— 回填与「恢复默认」都够不到它');
  assert.equal(Number(row[1]), DEFAULT_CHECK_INTERVAL_HOURS, '设置页 default 与主进程默认档漂移了');
  const el = html.match(new RegExp(`<input[^>]*id="${row[2]}"[^>]*>`));
  assert.ok(el, `设置页缺少 #${row[2]}`);
  const attrs = el[0];
  assert.match(attrs, /type="number"/, '间隔必须是数字输入');
  assert.match(attrs, new RegExp(`min="${MIN_CHECK_INTERVAL_HOURS}"`), '输入框下限与主进程夹逼不一致');
  assert.match(attrs, new RegExp(`max="${MAX_CHECK_INTERVAL_HOURS}"`), '输入框上限与主进程夹逼不一致');
});

test('新行的双语词典齐备（只加中文=切到 English 后该行退化成中文）', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const html = read('src/renderer/index.html');
  const key = (html.match(/data-i18n="([^"]+)"[^>]*>[^<]*订阅[^<]*检查[^<]*</) || [])[1];
  assert.ok(key, '订阅检查间隔的 label 没挂 data-i18n');
  assert.ok(zh[key], `zh.json 缺 ${key}`);
  assert.ok(en[key], `en.json 缺 ${key}`);
  assert.notEqual(en[key], zh[key], '英文词条照抄了中文');
});

test('零新 IPC：pref 读写仍只走既有四个通道，新档位不另开通道', () => {
  const code = stripComments(read('src/main/ipc/prefs.js'));
  const channels = [...code.matchAll(/handle\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(channels.sort(), ['get-pref', 'get-search-history', 'set-pref', 'set-search-history']);
  const settings = stripComments(read('src/renderer/js/views/settings.js'));
  assert.ok(/api\.setPref\(cfg\.key, val\)/.test(settings),
    '设置页改走通用写入口（新档位不该另开一条跨进程路）');
});
