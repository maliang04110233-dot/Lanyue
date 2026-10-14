/**
 * 智能歌单界面侧纪律（静态守卫，与 test/ai-assistant-ui.test.js 同律：本仓无 jsdom）
 *
 * 这四条各有真实的事故形态：
 *   ① 写库只有一处。生成（runSmartPlaylist）只问模型、只画预览；
 *      唯一落到 prefs 的动作是用户点「存为歌单」。谁把 saveUserPlaylist 挪进生成流程，
 *      谁就造出了一个「AI 未经确认改了用户曲库」的后门 —— 而这条通道不在 MCP 工具白名单里，
 *      轨道二那套逐条确认闸门管不到它，只能在这里钉死；
 *   ② 模型给的歌名与理由都可能含尖括号，一律 textContent，不许拼进 innerHTML；
 *   ③ 主进程只发 ASCII 令牌，文案的家在渲染层词典：令牌映射必须覆盖主进程会发的每一个，
 *      漏一个用户在英文界面上看到的就是一串大写字母；
 *   ④ 「AI 只看了前 400 首」必须说出来，不能让用户以为它读完了整个曲库。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');
const VIEW = read('js', 'views', 'smart-playlist.js');
const HTML = read('index.html');
const APP = read('js', 'app.js');
const zh = JSON.parse(read('js', 'lang', 'zh.json'));
const en = JSON.parse(read('js', 'lang', 'en.json'));

/** 本仓语言包是扁平点分键 */
const pick = (d, k) => (typeof d[k] === 'string' ? d[k] : undefined);

test('写库只有一处，且不在生成流程里', () => {
  const saves = VIEW.match(/api\.saveUserPlaylist\(/g) || [];
  assert.strictEqual(saves.length, 1, `saveUserPlaylist 应恰一处，实有 ${saves.length}`);
  const run = VIEW.match(/async function runSmartPlaylist\(\) \{([\s\S]*?)\n\}/);
  assert.ok(run, 'runSmartPlaylist 必须是顶层函数');
  assert.ok(!/saveUserPlaylist/.test(run[1]), '生成阶段不许写库：预览没被用户点头之前曲库不能变');
  const save = VIEW.match(/async function saveSmartPlaylist\(\) \{([\s\S]*?)\n\}/);
  assert.ok(save && /saveUserPlaylist/.test(save[1]), '「存为歌单」才是唯一的落库出口');
});

test('它不碰助手的工具通道：智能歌单不在 MCP 白名单里', () => {
  const used = [...VIEW.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(used)], ['smart-playlist-generate'],
    `智能歌单只该用那一条只读通道，实有 ${used.join(', ')}`);
  assert.ok(!/ai-assistant-tool-call/.test(VIEW), '借道工具执行等于绕过「只读」这条承诺');
});

test('动态文本一律 textContent，innerHTML 里不许插模型或歌曲字段', () => {
  const bad = VIEW.split('\n').filter(l => /innerHTML\s*=/.test(l) && /\$\{/.test(l));
  assert.deepStrictEqual(bad, [], 'innerHTML 里禁止插动态文案: ' + bad.join(' | '));
  assert.match(VIEW, /el\.textContent = /, '行文本应走 textContent');
});

test('主进程每个 ASCII 令牌都有中文与英文文案', () => {
  // 主进程侧会发的令牌（test/smart-playlist-primary.test.js 与 service 测试钉住的那批）
  const TOKENS = ['NO_KEY', 'EMPTY_PROMPT', 'NO_CANDIDATES', 'PLAYLIST_NOT_FOUND', 'LLM_FAILED', 'NO_PICKS'];
  const keys = new Set([...VIEW.matchAll(/\b([A-Z][A-Z_]{2,}):\s*'(smartPl\.[^']+)'/g)].map(m => m[1]));
  assert.deepStrictEqual([...keys].sort(), [...TOKENS].sort(),
    `令牌映射应与主进程发的完全一致，缺 ${TOKENS.filter(t => !keys.has(t)).join(',')}`);
  const mapped = [...VIEW.matchAll(/\b([A-Z][A-Z_]{2,}):\s*'(smartPl\.[^']+)'/g)];
  for (const m of mapped) {
    const k = m[2];
    assert.ok(pick(zh, k), `zh 缺键 ${k}（${m[1]}）`);
    assert.ok(pick(en, k), `en 缺键 ${k}（${m[1]}）`);
    assert.ok(!/[\u4e00-\u9fff]/.test(pick(en, k)), `${k} 的英文译文里不该有中文`);
  }
});

test('用到的 smartPl.* / toast.* 键中英齐备且占位符同集合', () => {
  const keys = new Set();
  for (const m of VIEW.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)) if (m[1].includes('.')) keys.add(m[1]);
  for (const m of HTML.matchAll(/data-i18n="(smartPl\.[^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size >= 10, `取词太少（${keys.size}），接线大概没走词典`);
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
  assert.match(VIEW, /if \((\w+\.)?truncated > 0\)/, '要按 truncated 分支，而不是恒不显示');
  assert.match(VIEW, /smartPl\.truncated/);
  assert.match(zh['smartPl.truncated'] || '', /\{n\}/, 'zh 要带首数占位符');
  assert.match(en['smartPl.truncated'] || '', /\{n\}/, 'en 要带首数占位符');
});

test('勾选可撤：预览每行都能被用户去掉，落库只收勾上的', () => {
  assert.match(VIEW, /_keep\[[^\]]*\]\s*=\s*!_keep/, '行点击要翻转该行的保留状态');
  const save = VIEW.match(/async function saveSmartPlaylist\(\) \{([\s\S]*?)\n\}/);
  assert.match(save[1], /_keep/, '存单必须以用户的勾选为准');
  assert.match(VIEW, /smartPl\.picked/, '要有一条「共 N 首」之类的确认信息');
});

test('入口、面板与导出齐全，且不挂 AI 功能开关', () => {
  assert.match(HTML, /id="smartPlPanel"/);
  assert.match(HTML, /id="smartPlToggleBtn"[^>]*onclick="toggleSmartPanel\(\)"/);
  const tag = HTML.match(/<button[^>]*id="smartPlToggleBtn"[^>]*>/);
  assert.ok(tag && !/data-feature=/.test(tag[0]), '面板挂在歌单页里，不该被 FEATURES.ai 一起关掉');
  assert.match(APP, /import '\.\/views\/smart-playlist\.js';/);
  for (const fn of ['toggleSmartPanel', 'runSmartPlaylist', 'saveSmartPlaylist']) {
    assert.match(VIEW, new RegExp(`window\\.${fn} = ${fn}`), `${fn} 没挂 window（内联 onclick 只认 window）`);
  }
});

test('ID 唯一：新增的那批 id 在整个 index.html 里只出现一次', () => {
  for (const id of ['smartPlPanel', 'smartPlToggleBtn', 'smartPlScope', 'smartPlPrompt',
    'smartPlGenBtn', 'smartPlStatus', 'smartPlResult', 'smartPlName', 'smartPlReason', 'smartPlList']) {
    const n = (HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `id="${id}" 出现 ${n} 次（getElementById 只会拿到第一个）`);
  }
});
