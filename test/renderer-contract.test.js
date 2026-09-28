/**
 * 契约测试：渲染层 window 公开面（player.js / utils.js）
 *
 * 为什么需要它
 * ------------
 * 渲染层没有 DOM 测试基础设施（无 jsdom），无法在 node:test 里真跑 ——
 * 而 index.html 里 **109 处 onclick / onchange 直接靠裸标识符调用**这些函数
 * （如 `onclick="togglePlay()"`、`onclick="resetEq()"`），
 * 一旦某个函数忘了挂 window，或者拆分文件时漏了 re-export：
 *   - 语法合法、eslint 通过（no-undef 在渲染层 override 里是 off）
 *   - 只有用户真点到那个按钮才炸，且报的是 "xxx is not defined"
 *
 * 所以本测试做两件事：
 *   1. 把「已挂 window 的函数名」钉成契约，拆分时误删会立刻失败
 *   2. 反向校验 index.html 里每个 onclick 裸标识符都真的可达
 *      （这是更本质的一条 —— 它直接模拟浏览器点击时能否解析到）
 *
 * ⚠️ 本文件只做静态源码分析，不 require 渲染层模块（它们顶层就碰 document）。
 *    这是有意为之，不是省事。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLAYER = path.join(ROOT, 'src', 'renderer', 'js', 'player.js');
const UTILS = path.join(ROOT, 'src', 'renderer', 'js', 'utils.js');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

/** 读取源码，统一换行，避免 CRLF 影响行级断言 */
function readSrc(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 收集源码里所有 window 挂载点。
 *
 * 本仓存在**两种**挂载形态，必须都认（只认一种会大量误报）：
 *   1. `window.foo = ...`（可带缩进 —— converter.js 在 init 函数内挂）
 *   2. `Object.assign(window, { foo, bar })`（ai-music.js / converter.js 用）
 */
function collectWindowExports(src) {
  const out = new Set();

  // 形态 1：window.<name> =  （允许行首空白）
  const assignRe = /^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = assignRe.exec(src))) out.add(m[1]);

  // 形态 2：Object.assign(window, { ... })
  // 用括号配平切出对象字面量，避免嵌套对象把边界切错
  const oaRe = /Object\.assign\(\s*window\s*,\s*\{/g;
  while ((oaRe.exec(src))) {
    const start = oaRe.lastIndex; // 指向 '{' 之后
    let depth = 1;
    let i = start;
    // 跳过字符串内容，避免 '{' / '}' 出现在字符串里影响配平
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i++; // 跳过转义
          i++;
        }
      } else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    // 取键名：`foo,` / `foo}` / `foo: bar` / 简写与别名都要
    const keyRe = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=[,}:\s])/g;
    let k;
    while ((k = keyRe.exec(body))) out.add(k[1]);
  }

  return out;
}

/**
 * 提取 index.html 中 on* 属性里的**顶层调用标识符**。
 * 例如 onclick="event.stopPropagation();playRecommendSong(x)" → 认 playRecommendSong；
 * onclick="window.nextSong()" → 认 nextSong（window. 前缀剥掉）。
 * 只取「函数调用」形态，忽略 document / event / this 这类内建。
 */
function collectHtmlOnclickIdents(html) {
  const out = new Set();
  const attrRe = /\son[a-z]+\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    const body = m[1];
    // 匹配 标识符(  —— 不要求行首，因为常出现在分号/续写之后
    const callRe = /(?:^|[^\w.$])(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(body))) out.add(c[1]);
  }
  return out;
}

// ── player.js 公开面 ────────────────────────────────────
const playerSrc = readSrc(PLAYER);
const playerExports = collectWindowExports(playerSrc);

test('player.js 已挂 window 的函数数不少于 42（拆分时误删会失败）', () => {
  // 基线 42 = 44 个 `window.x =` 字面匹配 减去 2 个 window.addEventListener
  // （那是 DOM 事件注册，不是导出）。
  assert.ok(
    playerExports.size >= 42,
    `实际 ${playerExports.size} 个；若确实有意收缩，请同步更新本基线`
  );
});

test('player.js 的 window 公开面覆盖 EQ 簇全部函数（EQ 拆出 player/eq.js 后必须 re-export）', () => {
  // EQ 簇是「自持状态、对外仅依赖 audio/logger」的一组，最可能被优先拆分。
  // 拆出后若忘了在 player.js re-export 并挂 window，HTML 上的
  // onclick="resetEq()" / applyEqPreset() 等会直接失效。
  const eqFns = [
    'applyEqPreset', 'toggleEqBypass', 'setEqBand', 'resetEq',
    'saveEqSettings', 'restoreEqPresetSetting', 'cycleEqPreset',
  ];
  const missing = eqFns.filter((f) => !playerExports.has(f));
  assert.deepStrictEqual(missing, [], `EQ 簇缺少 window 挂载: ${missing.join(', ')}`);
});

test('player.js 的 window 公开面覆盖播放控制核心（HTML onclick 依赖）', () => {
  const core = [
    'togglePlay', 'nextSong', 'prevSong', 'cyclePlayMode', 'cyclePlaybackRate',
    'toggleMute', 'toggleLyricsArea', 'togglePlayerMore', 'closePlayerMore',
    'updatePlayerCard', 'setPlayerState', 'refreshPlayerState',
  ];
  const missing = core.filter((f) => !playerExports.has(f));
  assert.deepStrictEqual(missing, [], `缺少 window 挂载: ${missing.join(', ')}`);
});

test('player.js 不再残留已移除的环形进度实现（UI 重设计的清理成果）', () => {
  // 环形进度已随方形封面重设计移除；若拆分时误把旧代码带回来，这条会失败。
  assert.ok(!/RING_CIRCUMFERENCE/.test(playerSrc), '不应再出现 RING_CIRCUMFERENCE');
  assert.ok(!/function\s+updateRingProgress/.test(playerSrc), '不应再定义 updateRingProgress');
});

test('player.js 的顶栏状态只有 refreshPlayerState 一个判据（防回退到多判据）', () => {
  // 曾经 app.js pause 分支看 currentPlaying、play 分支无条件写「正在播放」，
  // 导致换歌时文案错乱。refreshPlayerState 把判据统一为「audio 真实状态」。
  assert.ok(/export\s+function\s+refreshPlayerState/.test(playerSrc),
    'refreshPlayerState 应存在且被 export');
  // 不该再有「依据 currentPlaying 推导暂停态」的写法
  assert.ok(!/currentPlaying'\s*\)\s*\?\s*'已暂停'/.test(playerSrc),
    '不应依据 currentPlaying 推导「已暂停」——应看 audio.paused');
});

// ── utils.js 公开面（渲染层平台名的唯一来源）────────────
const utilsSrc = readSrc(UTILS);
const utilsExports = collectWindowExports(utilsSrc);

test('utils.js 导出平台名解析的唯一入口 platformName', () => {
  for (const f of ['platformName', 'getPlatforms', 'setPlatforms',
    'fallbackPlatformIds', 'applyPlatformBadgeTheme']) {
    assert.ok(utilsExports.has(f), `utils.js 应挂 window.${f}`);
  }
});

test('utils.js 不再手写平台名映射表（应走主进程清单，仅保留兜底）', () => {
  // FALLBACK_PLATFORM_NAMES 是「降级路径」而非第二事实来源：
  // 它的存在是必要的（无头验证台会桩掉 app.js，IPC 可能未就绪），
  // 但绝不允许再出现第二份 srcLabel 式的映射表。
  const tables = utilsSrc.match(/const\s+\w*(PLATFORM|SOURCE|LABEL)\w*\s*=\s*\{/gi) || [];
  assert.ok(tables.length <= 1,
    `平台映射表最多 1 份（FALLBACK_PLATFORM_NAMES），实际 ${tables.length}: ${tables.join(', ')}`);
});

// ── 反向校验：HTML 的 onclick 目标必须真的可达 ──────────
test('index.html 里 onclick 调用的自定义标识符都能在 window 上找到', () => {
  const html = readSrc(INDEX_HTML);
  const used = collectHtmlOnclickIdents(html);

  // 浏览器/JS 内建与本地变量，不属于「需要挂 window」的范畴
  const builtins = new Set([
    'document', 'window', 'event', 'this', 'Number', 'String', 'Boolean',
    'Array', 'Object', 'JSON', 'Math', 'Date', 'parseInt', 'parseFloat',
    'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent',
    'if', 'for', 'while', 'switch', 'return', 'typeof', 'function', 'catch',
    'delete', 'new', 'void', 'await', 'async', 'getElementById',
  ]);

  // 收集全仓所有 window.<name> 挂载点（不止 player/utils —— 各 view 也挂）
  const allExports = new Set();
  const jsDir = path.join(ROOT, 'src', 'renderer', 'js');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      for (const name of collectWindowExports(readSrc(full))) allExports.add(name);
    }
  };
  walk(jsDir);

  const missing = [...used]
    .filter((n) => !builtins.has(n) && !allExports.has(n))
    .sort();

  assert.deepStrictEqual(
    missing, [],
    `以下标识符被 index.html 调用但没有任何 window 挂载点（点击即 "is not defined"）：\n  ${missing.join('\n  ')}`
  );
});
