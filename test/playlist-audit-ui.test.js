/**
 * 歌单语义运维界面侧纪律（静态守卫，与 test/smart-playlist-ui.test.js 同律：本仓无 jsdom）
 *
 * 这四条与智能歌单是同一批纪律，只是方向相反（那里是「挑」，这里是「修」）：
 *   ① 生成（runPlAudit）只问模型、只画预览，一个字节都不许写库；
 *      「改名」与「移除勾选」是两个独立按钮，各自只调既有通道
 *      （save-user-playlist / remove-from-user-playlist），不新增写接口。
 *   ② 模型给的名字/描述/理由都可能含尖括号，一律 textContent，不许拼进 innerHTML；
 *   ③ 主进程只发 ASCII 令牌，文案的家在渲染层词典：ERR_KEYS 必须覆盖主进程会发的每一个，
 *      漏一个用户在英文界面上看到的就是一串大写字母；
 *   ④ 「AI 只看了前 400 首」必须说出来，不能让用户以为它读完了整个歌单。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');
const VIEW = read('js', 'playlistAudit.js');
const HTML = read('index.html');
const APP = read('js', 'app.js');
const zh = JSON.parse(read('js', 'lang', 'zh.json'));
const en = JSON.parse(read('js', 'lang', 'en.json'));

const pick = (d, k) => (typeof d[k] === 'string' ? d[k] : undefined);

test('写库只在两个既有出口里，生成阶段不写库', () => {
  const run = VIEW.match(/async function runPlAudit\(\) \{([\s\S]*?)\n\}/);
  assert.ok(run, 'runPlAudit 必须是顶层函数');
  assert.ok(!/saveUserPlaylist/.test(run[1]), '生成阶段不许写库：体检结果没被用户点头之前曲库不能变');
  assert.ok(!/removeFromUserPlaylist/.test(run[1]), '生成阶段不许删歌');
  // 应用动作的两个出口
  const apply = VIEW.match(/async function applyPlAuditRemove\(\) \{([\s\S]*?)\n\}/);
  assert.ok(apply && /removeFromUserPlaylist/.test(apply[1]), '「移除勾选」必须走 removeFromUserPlaylist');
  const suggest = VIEW.match(/async function applyPlAuditSuggest\(.*?\) \{([\s\S]*?)\n\}/);
  assert.ok(suggest && /saveUserPlaylist/.test(suggest[1]), '「改名/换描述」必须走 saveUserPlaylist');
  // 写库调用总数 = 2（两个出口各一次），不新增
  const saves = VIEW.match(/api\.saveUserPlaylist\(/g) || [];
  assert.strictEqual(saves.length, 1, `saveUserPlaylist 应恰一处，实有 ${saves.length}`);
  const removes = VIEW.match(/api\.removeFromUserPlaylist\(/g) || [];
  assert.strictEqual(removes.length, 1, `removeFromUserPlaylist 应恰一处，实有 ${removes.length}`);
});

test('动态文本一律 textContent，innerHTML 里不许插模型或歌曲字段', () => {
  const bad = VIEW.split('\n').filter(l => /innerHTML\s*=/.test(l) && /\$\{/.test(l));
  assert.deepStrictEqual(bad, [], 'innerHTML 里禁止插动态文案: ' + bad.join(' | '));
  assert.match(VIEW, /\.textContent = /, '行文本应走 textContent');
});

test('主进程每个 ASCII 令牌都有中文与英文文案', () => {
  const TOKENS = ['EMPTY', 'PLAYLIST_NOT_FOUND', 'NO_KEY', 'NO_CANDIDATES', 'NO_AUDIT', 'LLM_FAILED'];
  const keys = new Set([...VIEW.matchAll(/^\s{2}([A-Z][A-Z_]{2,}):\s*'plAudit\.[^']+'/gm)].map(m => m[1]));
  assert.deepStrictEqual([...keys].sort(), [...TOKENS].sort(),
    `令牌映射应与主进程发的完全一致，缺 ${TOKENS.filter(t => !keys.has(t)).join(',')}`);
  const mapped = [...VIEW.matchAll(/^\s{2}([A-Z][A-Z_]{2,}):\s*'(plAudit\.[^']+)'/gm)];
  for (const m of mapped) {
    const k = m[2];
    assert.ok(pick(zh, k), `zh 缺键 ${k}（${m[1]}）`);
    assert.ok(pick(en, k), `en 缺键 ${k}（${m[1]}）`);
    assert.ok(!/[\u4e00-\u9fff]/.test(pick(en, k)), `${k} 的英文译文里不该有中文`);
  }
});

test('用到的 plAudit.* 键中英齐备且占位符同集合', () => {
  const keys = new Set();
  for (const m of VIEW.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)) if (m[1].includes('.')) keys.add(m[1]);
  assert.ok(keys.size >= 15, `取词太少（${keys.size}），接线大概没走词典`);
  for (const k of keys) {
    const a = pick(zh, k), b = pick(en, k);
    assert.ok(typeof a === 'string' && a.trim(), `zh 缺键 ${k}`);
    assert.ok(typeof b === 'string' && b.trim(), `en 缺键 ${k}`);
    const pa = (a.match(/\{(\w+)\}/g) || []).sort().join(',');
    const pb = (b.match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.strictEqual(pa, pb, `${k} 中英占位符不同集合: ${pa} vs ${pb}`);
  }
});

test('截断必须说出口：AI 只看了前 N 首时界面要报', () => {
  assert.match(VIEW, /if \(truncated > 0\)/, '要按 truncated 分支，而不是恒不显示');
  assert.match(VIEW, /plAudit\.truncated/);
  assert.match(zh['plAudit.truncated'] || '', /\{n\}/, 'zh 要带首数占位符');
  assert.match(en['plAudit.truncated'] || '', /\{n\}/, 'en 要带首数占位符');
});

test('勾选可撤：每行都能被用户去掉，移除只收勾上的', () => {
  assert.match(VIEW, /entry\.checked = cb\.checked/, '行 checkbox 的 change 要更新记录状态');
  const apply = VIEW.match(/async function applyPlAuditRemove\(\) \{([\s\S]*?)\n\}/);
  assert.match(apply[1], /\.checked/, '移除必须以用户的勾选为准');
});

test('入口与面板齐全：歌单详情页有「修」按钮，app 引入模块', () => {
  assert.match(HTML, /onclick="openPlAudit\(/);
  assert.match(HTML, /data-ico="dna"[^>]*>修/, '详情页要有可见入口');
  assert.match(APP, /import '\.\/playlistAudit\.js';/, 'app.js 必须引入运维面板模块');
  for (const fn of ['openPlAudit', 'closePlAudit', 'runPlAudit', 'applyPlAuditRemove', 'applyPlAuditSuggest']) {
    assert.match(VIEW, new RegExp(`window\\.${fn} = ${fn}`), `${fn} 没挂 window（内联 onclick 只认 window）`);
  }
});

test('面板 ID 唯一：新增的那批 id 在整个 index.html 里只出现一次', () => {
  // 面板是 JS 动态创建的，id 不在 index.html 里，所以这里检查「不在 index.html 里重复」
  const ids = ['plAuditModal', 'plAuditPrompt', 'plAuditRunBtn', 'plAuditStatus', 'plAuditResult', 'plAuditSuggest', 'plAuditList'];
  for (const id of ids) {
    // 面板由 JS 创建；index.html 里不该有同名 id（否则 getElementById 语义冲突）
    const n = (HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 0, `index.html 里不应静态声明 id="${id}"（面板由 JS 建）`);
  }
});