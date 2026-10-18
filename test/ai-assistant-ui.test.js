/**
 * 助手页的接线纪律（静态守卫）
 *
 * 助手是「模型能替你动手」的界面，三类事故最容易漏：
 *   ① 写操作没弹确认（界面上漏 await，或 await 忘了写 —— 不 await 的确认框等于没有确认）；
 *   ② 把远端/模型文本用 innerHTML 拼进 DOM（歌名与模型回复都可能含尖括号）；
 *   ③ 界面里攒中文，英文界面就漏（本仓 toast-i18n 台账的老账）。
 * 真行为在 node 下起不了 DOM（本仓无 jsdom），所以这三条都按源码形状钉，
 * 再加一条「可用通道恰为白名单」的集合钉防扩权。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');
const VIEW = read('js', 'views', 'ai-assistant.js');
const HTML = read('index.html');
const zh = JSON.parse(read('js', 'lang', 'zh.json'));
const en = JSON.parse(read('js', 'lang', 'en.json'));

/** 本仓语言包是**扁平点分键**（"nav.aggregate" 这种），不是嵌套对象 */
function pick(dict, key) {
  return typeof dict[key] === 'string' ? dict[key] : undefined;
}

test('危险步骤仍走模态：askConfirm 恰一处，且判据是 risk === destructive', () => {
  const calls = VIEW.match(/await\s+askConfirm\(/g) || [];
  assert.strictEqual(calls.length, 1, '助手页应恰有一处 await askConfirm(');
  assert.match(VIEW, /meta\.risk === 'destructive'/, '单项弹确认的判据不在了');
  assert.match(VIEW, /scope = 'single'/, '危险步骤必须发 single，批量令牌换不到它');
  // 认「被拒分支里到底做了什么」，不认缩进字符数：确认后的 `if (!confirmed)` 块
  // 里不得出现 invoke，且必须以 continue 跳过这一步（两个事实，谁被删了都会红）。
  const seg = VIEW.split('if (!confirmed) {')[1];
  assert.ok(seg, '确认返回 false 必须有跳过这一步的分支');
  const block = seg.slice(0, seg.indexOf('\n    } else'));
  assert.ok(!/\binvoke\(/.test(block), '被拒后不得调用工具通道');
  assert.match(block, /continue;/, '被拒后应跳过这一步继续下一个');
  assert.ok(VIEW.includes("import { askConfirm } from '../confirmDialog.js';"));
});

test('模型/歌曲文本一律 textContent 上屏，不许拼进 innerHTML', () => {
  const bad = VIEW.split('\n').filter(l => /innerHTML\s*=/.test(l) && /\$\{/.test(l));
  assert.deepStrictEqual(bad, [], 'innerHTML 里禁止插动态文案: ' + bad.join(' | '));
});

test('助手页用到的 assistant.* / toast.* / nav.* 键必须中英齐备且占位符同集合', () => {
  const keys = new Set();
  for (const m of VIEW.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)) {
    if (m[1].includes('.')) keys.add(m[1]);
  }
  for (const m of HTML.matchAll(/data-i18n="((?:assistant|nav)\.[^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size >= 12, `取词太少（${keys.size}），接线大概没走词典`);
  for (const k of keys) {
    const a = pick(zh, k), b = pick(en, k);
    assert.ok(typeof a === 'string' && a.trim(), `zh 缺键 ${k}`);
    assert.ok(typeof b === 'string' && b.trim(), `en 缺键 ${k}`);
    const pa = (a.match(/\{(\w+)\}/g) || []).sort().join(',');
    const pb = (b.match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.strictEqual(pa, pb, `${k} 中英占位符不同集合: ${pa} vs ${pb}`);
  }
});

/**
 * Key 录入口的三条纪律（2026-10-15 起是「面板」而不是「Key 行」）：AI 创作页被
 * FEATURES.ai 关着，助手页必须自带配 Key 的地方；而那个地方是共用面板
 * （js/aiProviderPanel.js），不是本页自己攒的一根输入框 —— 界面直读直写
 * aiMusicApiKey 会把 {厂商:Key} 的整包映射拖过进程边界，覆盖式写法还会抹掉别家凭据。
 */
test('助手页的 Key 录入口 = 共用面板容器，界面侧不碰那把 secret', () => {
  const at = HTML.indexOf('id="assistantProviderPanel"');
  assert.ok(at > 0, '助手页没有厂商面板容器（配 Key 的入口就没了）');
  assert.ok(!/id="assistantKeyInput"/.test(HTML), '助手页还留着自家那根 Key 输入框');
  assert.match(VIEW, /mountProviderPanel\(/, '助手页没挂共用面板');
  assert.ok(!/aiMusicApiKey/.test(VIEW), '助手页不该再直读直写那把 secret');
  const logs = VIEW.split('\n').filter(l => /logger\.|console\./.test(l));
  const leaks = logs.filter(l => /apiKey|assistantKey|_key\b/.test(l));
  assert.deepStrictEqual(leaks, [], 'Key 不得进日志: ' + leaks.join(' | '));
});

test('助手可用面 = MCP 白名单，一条通道都不多', () => {
  const { AGENT_TOOLS } = require('../src/main/mcp/tools');
  const used = new Set([...VIEW.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]));
  for (const ch of ['ai-assistant-tools', 'ai-assistant-plan', 'ai-assistant-tool-call']) {
    assert.ok(used.has(ch), `助手页应调用 ${ch}`);
  }
  // 除这三条自身，界面侧不得再 invoke 别的工具通道（扩权要么走白名单要么走不通）
  const others = [...used].filter(c => !c.startsWith('ai-assistant-'));
  assert.deepStrictEqual(others, [], '助手页绕道调了别的通道: ' + others.join(', '));
  assert.strictEqual(AGENT_TOOLS.length, 44, '工具数变了：SECURITY/README/本钉三处口径要一起改');
});

test('循环有上界：回合数封顶，否则坏回复能刷爆队列与计费', () => {
  assert.match(VIEW, /MAX_TURNS\s*=\s*6/);
  assert.match(VIEW, /turn < MAX_TURNS/, '循环必须有上界');
});

test('入口与页面：侧栏 assistant 条目、switchTab 三处、window 导出齐全', () => {
  assert.match(HTML, /data-tab="assistant"[\s\S]{0,140}onclick="switchTab\('assistant',this\)"/);
  assert.match(HTML, /data-i18n="nav\.assistant"/);
  assert.match(HTML, /id="aiAssistantPage"/);
  const APP = read('js', 'app.js');
  assert.match(APP, /getElementById\('aiAssistantPage'\)/);
  assert.match(APP, /aiAssistantPage\.style\.display = 'none'/);
  assert.match(APP, /tab === 'assistant'/);
  assert.match(APP, /import '\.\/views\/ai-assistant\.js';/);
  for (const fn of ['sendAssistant', 'clearAssistant']) {
    assert.match(VIEW, new RegExp(`function ${fn}\\(`), `缺函数 ${fn}`);
    assert.match(VIEW, new RegExp(`window\\.${fn} = ${fn};`), `${fn} 没挂 window（内联 onclick 只认 window）`);
  }
});

/**
 * 助手不挂 AI 开关：它是「用本应用已有能力做事」的入口，用的是设置页里那个
 * 已存在的 MiniMax Key（AI 创作页同一把）。FEATURES.ai 管的是 AI 创作页
 * （见 ai-feature-flag.test.js），把助手也关了就等于「关掉生图页顺手禁掉搜索助手」。
 */
test('助手入口不受 FEATURES.ai 管，且 FEATURES.ai 仍是 false', () => {
  // 只看助手按钮自己的标签：侧栏相邻的 ai-music 条目带 data-feature="ai"，按窗口扫会误伤
  const tag = HTML.match(/<button[^>]*data-tab="assistant"[^>]*>/);
  assert.ok(tag, '侧栏没有助手入口');
  assert.ok(!/data-feature=/.test(tag[0]), '助手入口挂上 AI 开关就等于被关掉');
  const features = read('js', 'features.js');
  assert.ok(!/assistant/.test(features), 'TAB_FEATURES 里不该登记 assistant');
  assert.match(features, /ai:\s*false/, 'FEATURES.ai 必须仍是 false');
});
