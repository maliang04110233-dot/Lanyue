/**
 * 品牌名守卫：定名揽乐后，旧名不得再出现在会被用户看到的地方。
 *
 * 这条线的事故已经发生过一次——1af11b0 修「品牌文案静默退回旧名」，但
 * welcome.js 的欢迎卡标题又一次带着旧名合进主干。它之所以漏，是因为那一整块
 * 文案是硬编码中文、没接 i18n，而既有巡扫只认带引号的翻译键字面量，对
 * 「字面上出现的旧品牌」完全失明。
 *
 * 本守卫补的正是这一维：按字面量扫，不问它接没接词典。
 *
 * 只盯**代码**不盯注释——注释里提旧名是记录行为，界面上印旧名才是事故。
 * 判据用块注释状态机而不是「行首有 *」：CSS 块注释的续行行首没有 *，
 * 那样会漏掉 base.css / layout.css 的头部横幅。Python 的模块 docstring
 * 同理，用累计 """ 个数取奇偶判定。
 *
 * 旧名只认 MusicDL 一族（MusicDL / musicdl / Music-DL / Music_DL / music_dl）。
 * 连字符小写 music-downloader 是**保留包名**（package.json name 为升级链与
 * 更新缓存目录钉死），派生的 music-downloader-backup 同族保留；
 * \b 收口让 MusicDownloader（用户下载目录名，改=文件搬家）天然放过。
 *
 * 白名单两个方向都要成立：每一条都必须仍然命中（过期就红，逼着删），
 * 且每一个命中都必须被登记——合起来就是「命中集合 == 白名单集合」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ── 扫描面：用户会看到、或决定安装形态的地方 ────────────────────────
const SCAN_DIRS = ['src', 'build', 'scripts', 'hooks', '.github'];
const SCAN_ROOT_FILES = ['LICENSE', 'package.json', 'README.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.backup', '.preview', 'dist', 'release']);
const SKIP_EXACT = new Set(['package-lock.json']);
const CODE_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.json', '.html', '.css', '.md',
  '.py', '.sh', '.ps1', '.yml', '.yaml', '.bat', '.cmd',
]);

// 旧名只认 MusicDL 一族；两侧 \b 收口放过 MusicDownloader
const OLD_BRAND = /(?:^|[^A-Za-z])Music[-_ ]?DL(?:$|[^A-Za-z])/i;

// 白名单：精确到 文件:行，必须写理由
const ALLOWED = new Map([
  ['build/config.cjs:12', 'appId 钉死在旧拼写上：改动等于换应用身份，Windows 升级链断裂'],
  ['src/main/mcp/mcpCore.js:16', "MCP SERVER_NAME 是机器标识符，与保留的 appId 同族；改成 lanyue 会与 com.musicdl.app 互相打架"],
  ['scripts/write_tags.py:54', 'HTTP User-Agent 头必须保持 ASCII/latin-1，CJK 会直接让请求失败'],
  ['README.md:3', '名称史留档：这里必须保留旧名，否则读者无法理解 1.0.31 及更早的发布'],
]);

// 反向钉：新名必须在关键面上真的存在（防白名单清空后守卫空转）
const MUST_HAVE = new Map([
  ['package.json', /揽乐|Lanyue/],
  ['build/config.cjs', /揽乐|Lanyue/],
  ['src/renderer/js/lang/zh.json', /揽乐/],
  ['src/renderer/js/lang/en.json', /Lanyue/],
]);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      walk(abs, out);
      continue;
    }
    if (SKIP_EXACT.has(rel)) continue;
    if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(rel);
  }
}

function collect() {
  const out = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), out);
  for (const f of SCAN_ROOT_FILES) out.push(f);
  return out.sort();
}

/**
 * 只返回该文件里的**代码**行命中（1 起）；注释与文档字符串一律不算。
 * inBlock 是跨行状态，triple 累计到本次判断为止已见过的 """ 个数。
 */
function codeHits(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  const hashLine = ['.py', '.sh', '.ps1', '.bat', '.cmd'].includes(ext);
  const hits = [];
  let inBlock = false;
  let triple = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ext === '.py') {
      const m = line.match(/"""/g);
      if (m) triple += m.length;
    }
    // 块注释跨行：未闭合时，本行到 */ 之前都属注释，*/ 之后才算代码
    let from = 0;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      inBlock = false;
      from = close + 2;
    }
    const code = line.slice(from);
    let comment = (hashLine && !!/^\s*#/.exec(line)) || !!/^\s*\/\//.exec(line);
    if (!comment && ext === '.py' && triple % 2 === 1) comment = true;
    if (!comment) {
      const open = code.indexOf('/*');
      if (open !== -1 && code.indexOf('*/', open + 2) === -1) {
        inBlock = true;
        comment = true;
      }
    }
    if (!comment && OLD_BRAND.test(code)) hits.push(i + 1);
  }
  return hits;
}

/** 全量命中 → Map<文件, 行号[]> */
function allHits() {
  const map = new Map();
  for (const rel of collect()) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    const hits = codeHits(rel, text);
    if (hits.length) map.set(rel, hits);
  }
  return map;
}

const key = (f, n) => `${f}:${n}`;

test('扫描面非空且覆盖渲染层——守卫空转比守卫出错更危险', () => {
  const files = collect();
  assert.ok(files.length >= 150, `扫描面只剩 ${files.length} 个文件，SCAN_DIRS 可能配错了`);
  assert.ok(files.some((f) => f.startsWith('src/renderer/js/views/')),
    '渲染层视图没被扫到——那正是旧名复发的地方');
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('build/config.cjs'));
});

test('旧名判据自检：认得到一族变体，也放过保留名与下载目录名', () => {
  for (const bad of ['MusicDL', 'musicdl', 'Music-DL', 'Music_DL', 'music_dl',
                     'name = \'MusicDL\'', '[MusicDL][preload]', 'com.musicdl.app']) {
    assert.ok(OLD_BRAND.test(bad), `应当判定为旧名：${bad}`);
  }
  for (const ok of ['music-downloader', 'MusicDownloader', 'music-downloader-backup',
                    'downloaded', 'MUSIC_DIR_NAME']) {
    assert.ok(!OLD_BRAND.test(ok), `应当放过：${ok}`);
  }
});

test('白名单过期即红：登记的每一行都必须仍然命中', () => {
  const hits = allHits();
  const stale = [];
  for (const k of ALLOWED.keys()) {
    const [f, n] = k.split(':');
    const lines = hits.get(f) || [];
    if (!lines.includes(Number(n))) stale.push(k);
  }
  assert.deepEqual(stale, [],
    `这些白名单条目已经过期（那一行不再命中旧名），删掉它们：${stale.join(', ')}`);
});

test('白名单每条必须是非注释命中——豁免不能退化成注释免责', () => {
  for (const k of ALLOWED.keys()) {
    const [f, n] = k.split(':');
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    const line = lines[Number(n) - 1];
    assert.ok(line !== undefined, `${k} 指向空行，文件已改动`);
    assert.ok(OLD_BRAND.test(line), `${k} 该行已不再含旧名：${line}`);
  }
});

test('主判据：扫描面内的代码行旧名命中集合 == 白名单集合', () => {
  const hits = allHits();
  const found = new Set();
  for (const [f, lines] of hits) for (const n of lines) found.add(key(f, n));
  const unlisted = [...found].filter((k) => !ALLOWED.has(k)).sort();
  const expected = new Set(ALLOWED.keys());
  const missing = [...expected].filter((k) => !found.has(k)).sort();
  assert.deepEqual(unlisted, [],
    `界面上还能看到旧品牌名，必须改成揽乐：\n  ${unlisted.join('\n  ')}`);
  assert.deepEqual(missing, [], `白名单登记了但已无命中：${missing.join(', ')}`);
});

test('反向钉：新名必须在关键面上真实存在', () => {
  for (const [rel, rx] of MUST_HAVE) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(rx.test(text), `${rel} 里找不到新名（${rx}）——新名可能被整批回退`);
  }
});
