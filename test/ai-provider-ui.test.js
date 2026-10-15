/**
 * 厂商配置的界面侧（静态形状钉 + 词典齐备）
 *
 * 本仓无 jsdom，视图侧按源码形状钉（与 test/ai-assistant-ui.test.js 同一套路）。
 * 这里守的四件事，每件都对应一种真实事故：
 *   ① 名单不许在渲染层镜像 —— 镜像要靠测试才不分叉，而经通道取根本不会分叉；
 *   ② Key 本体不许跨界 —— 界面只需要「这家配过没有」，写 Key 走保存通道；
 *   ③ 覆盖式写 secret 的那个 bug（setPref 直接写新串 = 抹掉别家凭据）不许复活；
 *   ④ 选了不能合成音乐的厂商，AI 创作页的音乐按钮必须当场关住，
 *      而不是让用户点下去才发现主进程回了 MUSIC_UNSUPPORTED（那是一次无用的跨进程往返）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8').replace(/\r\n/g, '\n');

const PANEL = read('js', 'aiProviderPanel.js');
const MUSIC = read('js', 'views', 'ai-music.js');
const ASSIST = read('js', 'views', 'ai-assistant.js');
const SMART = read('js', 'views', 'smart-playlist.js');
const HTML = read('index.html');
const zh = JSON.parse(read('js', 'lang', 'zh.json'));
const en = JSON.parse(read('js', 'lang', 'en.json'));

const pick = (dict, key) => (typeof dict[key] === 'string' ? dict[key] : undefined);

/** 扫全部渲染层文件（js/html/json），返回命中给定正则的路径清单 */
function scanRe(re) {
  const hits = [];
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(ROOT, 'src', 'renderer', rel), { withFileTypes: true })) {
      const p = path.posix.join(rel, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|html|json)$/.test(ent.name) && re.test(stripComments(read(p)))) hits.push(p);
    }
  };
  walk('');
  return hits;
}

/** 去掉注释（块注释与行注释），只留可执行代码 —— 说明文字里举例提到厂商名/中文不算违规 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// ── ① 名单只在登记表，界面不镜像 ─────────────────────────

test('厂商名一个都不许出现在渲染层（下拉的数据源是通道，不是界面侧名单）', () => {
  const hits = scanRe(/MiniMax|DeepSeek|通义千问|月之暗面|智谱|豆包|moonshot|dashscope|bigmodel|volces|deepseek/i);
  assert.deepStrictEqual(hits, [], '渲染层镜像了厂商名单: ' + hits.join(', '));
});

test('面板把 api.aiProviderConfig 的结果当唯一数据源画下拉（不自己列 option）', () => {
  assert.match(PANEL, /api\.aiProviderConfig\(/, '面板没走配置通道');
  assert.match(PANEL, /\.providers\b/, '下拉应遍历通道给的 providers 数组');
  assert.match(PANEL, /cfg\.providers\.map|providers\.map\(/, 'option 应由 providers 映射出来');
});

// ── ② / ③ Key 的进出边界 ────────────────────────────────

test('渲染层不再直读直写 aiMusicApiKey（读 = Key 跨界，写 = 覆盖掉别家的 Key）', () => {
  const hits = scanRe(/aiMusicApiKey/);
  assert.deepStrictEqual(hits, [], '界面侧还直接碰这把 secret：' + hits.join(', '));
});

test('保存走 aiProviderSave，Key 与配置一份 patch 交出去', () => {
  assert.match(PANEL, /api\.aiProviderSave\(/, '面板没走保存通道');
  assert.match(PANEL, /key\s*=\s*\{\s*vendorId/, 'Key 必须带它属于哪家（映射的键就是厂商 id）');
});

test('Key 输入框是 password 型，外来字符串一律过 escHtml 才进模板', () => {
  assert.match(PANEL, /type="password"/, 'Key 输入框必须是 password 型');
  for (const expr of ['x.label', 'x.id', 'cur.model', 'cur.baseUrl', 'p.defaultModel', 'p.keyUrl', 't(\'ai.']) {
    assert.ok(PANEL.includes(`escHtml(${expr}`), `${expr} 未经 escHtml 就进了模板`);
  }
});

// ── 共用一处，不许两处各攒一套 ───────────────────────────

test('AI 创作页与助手页挂的是同一个面板模块', () => {
  for (const [name, src] of [['ai-music', MUSIC], ['ai-assistant', ASSIST]]) {
    assert.match(src, /aiProviderPanel\.js/, `${name} 没挂共用面板`);
    assert.match(src, /mountProviderPanel\(/, `${name} 没调用挂载入口`);
  }
  assert.match(PANEL, /export async function mountProviderPanel/);
  assert.match(HTML, /id="assistantProviderPanel"/, '助手页没有面板容器');
});

test('两处挂载都幂等：同一容器重复挂载靠挂载表去重，不叠第二份控件', () => {
  assert.match(PANEL, /_hosts\.has\(host\)/, '没有挂载表判重');
  assert.ok(!/id="aipProvider"/.test(PANEL), '控件用 id 会在两页撞车（label 的 for 只能绑第一份）');
});

// ── ④ 音乐合成只在 MiniMax 那一侧关住 ────────────────────

test('AI 创作页按 supportsMusic 当场关住音乐生成，并给出人话解释', () => {
  assert.match(MUSIC, /supportsMusic/, '创作页没读厂商的音乐能力');
  assert.match(MUSIC, /musicUnsupported/, '关掉音乐生成时要解释为什么（词典词条）');
  // 不许再把 Key 本体当参数递给 IPC（主进程自己按当前厂商取）
  const sends = MUSIC.split('\n').filter((l) => /apiKey:/.test(l));
  assert.deepStrictEqual(sends, [], '创作页还在把 apiKey 传进 IPC: ' + sends.join(' | '));
});

test('配置类令牌只在面板那一份表里翻译，视图遇到陌生的都交给它', () => {
  // 各视图再攒一张 BAD_BASE_URL/ENDPOINT_BLOCKED 的表，就是将来两处漂移的开始：
  // 面板改了、创作页没改，同一个失败在两页说出两句话。
  for (const [name, src] of [['assistant', ASSIST], ['smart-playlist', SMART]]) {
    assert.match(src, /providerErrText\(/, `${name} 没把配置类失败交给共用判据`);
    assert.ok(!/BAD_BASE_URL|ENDPOINT_BLOCKED/.test(stripComments(src)),
      `${name} 自己镜像了一份配置令牌表`);
  }
  for (const tok of ['BAD_BASE_URL', 'BAD_MODEL', 'LLM_HTTP', 'ENDPOINT_BLOCKED', 'NO_KEY']) {
    assert.ok(PANEL.includes(tok), `面板漏了令牌 ${tok}（漏一个就是把 ASCII 码印给用户）`);
  }
});

// ── 词典：中英齐备、占位符同集合 ─────────────────────────

test('面板与三个视图用到的点分键必须中英齐备且占位符同集合', () => {
  const keys = new Set();
  for (const src of [PANEL, MUSIC, ASSIST, SMART]) {
    for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)) {
      if (m[1].includes('.')) keys.add(m[1]);
    }
    // 令牌表里的值是 ERR_KEYS[code] 再 t(key) 取的，字面量不在 t() 调用里 —— 漏扫它就是
    // 「接了一个新令牌、词典少一行」，英文界面上印出来的会是键名本身
    for (const m of src.matchAll(/:\s*'((?:ai|assistant|smartPl|toast)\.[A-Za-z0-9]+)'/g)) keys.add(m[1]);
  }
  for (const m of HTML.matchAll(/data-i18n="(ai\.[^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.has('ai.errBaseUrl'), '面板应翻译端点错误（配置类失败不该只有一句「失败」）');
  assert.ok(keys.has('ai.errNoKey'), '令牌表里的键也得进词典对账');
  for (const k of keys) {
    const a = pick(zh, k), b = pick(en, k);
    assert.ok(typeof a === 'string' && a.trim(), `zh 缺键 ${k}`);
    assert.ok(typeof b === 'string' && b.trim(), `en 缺键 ${k}`);
    const pa = (a.match(/\{(\w+)\}/g) || []).sort().join(',');
    const pb = (b.match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.strictEqual(pa, pb, `${k} 中英占位符不同集合: ${pa} vs ${pb}`);
  }
});

test('面板文案全部走词典，界面里不攒中文（切到 English 才不漏）', () => {
  const cjk = /[\u4e00-\u9fa5]/;
  const bad = stripComments(PANEL).split('\n').filter((l) => cjk.test(l));
  assert.deepStrictEqual(bad, [], '面板里有硬编码中文: ' + bad.join(' | '));
});
