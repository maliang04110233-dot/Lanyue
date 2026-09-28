/**
 * eq-behaviour.test.js — EQ 簇守卫（静态分析风格沿用 platform-contract）
 *
 * 为什么是静态分析而非 DOM 测试：项目 devDependencies 无 jsdom，
 * 渲染层无法在 node --test 里实例化。故沿用 platform-contract.test.js /
 * renderer-contract.test.js 的同款手法——扫描源码文本断言结构。
 *
 * 37a57af 起 EQ 真实接入音频链路，原「现状钉」按其文件头预案**反转成正向钉**：
 *   A. eqFilters 必有填充点、音频图创建点恰好只在 eq.js（回退即红）
 *   B. restoreEqPresetSetting 三键齐读（eqPreset/eqBypass/eqGains），
 *      手调增益跨重启存活；_gains 是增益唯一真身（图未建也记账）
 * 若将来 EQ 又被拆下，请把 A/B 恢复成现状钉而不是删测试。
 *
 * 注意：所有扫描前都会 stripComments——历史版本的注释里曾故意提及
 * createBiquadFilter 等标识符说明缺陷，不能把注释当成代码证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

/** 去掉块注释与行注释，避免把"说明文字"误判为"代码事实" */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const EQ_SRC = read('src/renderer/js/player/eq.js');
const EQ_CODE = stripComments(EQ_SRC);
const PLAYER_CODE = stripComments(read('src/renderer/js/player.js'));
const PLAYER_SRC = read('src/renderer/js/player.js');
const HTML_SRC = read('src/renderer/index.html');

/** eq.js 的 export 名字集合：兼容 `export function f` 与独立 `export { a, b }` */
function exportsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

const EQ_PUBLIC = [
  'applyEqPreset', 'cycleEqPreset', 'resetEq', 'restoreEqPresetSetting',
  'saveEqSettings', 'setEqBand', 'toggleEqBypass',
];
// eq.js 另有两个仅供频谱可视化模块 import 的图访问器（不走 onclick/window）
// matchPresetName 纯函数（同上，不经 player 中转）
// preampTrimDb 输出级 trim 纯函数（ESM-only，链首 preamp 增益与单测消费；
//          原名 clipGuardDb —— 名字承诺了「削波保护」而它只是听感取向的固定 trim）
const EQ_ALL = [...EQ_PUBLIC, 'ensureAudioGraph', 'getAnalyser', 'matchPresetName', 'preampTrimDb'].sort();

// ── A. 音频图已接通（正向钉）────────────────────────
test('eq.js: eqFilters 存在填充点（EQ 已接入音频图，回退即红）', () => {
  const fills = [...EQ_CODE.matchAll(/eqFilters\s*(?:\.push\s*\(|\[[^\]]*\]\s*=(?!=))/g)];
  assert.ok(
    fills.length >= 1,
    'eqFilters 不再有任何填充点 —— EQ 图构建被删/回退，UI 又成死控件了'
  );
});

test('eq.js: 音频图创建点存在且全仓只此一处（createMediaElementSource/createBiquadFilter）', () => {
  const pattern = /\.(createBiquadFilter|createMediaElementSource|createGain)\s*\(/;
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      if (pattern.test(stripComments(fs.readFileSync(full, 'utf8')))) {
        offenders.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.resolve('src'));
  assert.deepEqual(
    offenders, ['src/renderer/js/player/eq.js'],
    '音频图创建点应当只有 eq.js 一处；多出文件 = 第二套劫持 #audioPlayer 的图（会打架）'
  );
});

test('index.html/lang: "EQ 未接入"警告已随修复下线，不许阴魂复现', () => {
  assert.ok(!HTML_SRC.includes('eqNotEffective'), 'eqNotEffective 警告复现——要么 EQ 真被拆下（恢复现状钉），要么文案错位');
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  assert.ok(!('settings.general.eqNotEffective' in zh), 'zh.json 残留 eqNotEffective 键');
  assert.ok(!('settings.general.eqNotEffective' in en), 'en.json 残留 eqNotEffective 键');
});

// ── B. eqGains 读写闭环（正向钉）───────────────────────────
test('eq.js: saveEqSettings 写入 prefs.eqGains，且值来自 _gains 真身（非空图镜像）', () => {
  assert.ok(
    /setPref\(\s*['"]eqGains['"]/.test(EQ_CODE),
    'saveEqSettings 不再写 eqGains，行为已变'
  );
  assert.ok(
    /_gains\.slice\(\)/.test(EQ_CODE),
    'getEqGains 不以 _gains 为真身 —— 图未建时会存回空数组（前的老 bug 复现）'
  );
});

test('eq.js: restoreEqPresetSetting 三键齐读（手调增益跨重启存活）', () => {
  const start = EQ_CODE.indexOf('async function restoreEqPresetSetting');
  assert.ok(start >= 0, '未找到 restoreEqPresetSetting');
  const end = EQ_CODE.indexOf('\n}', start);
  const body = EQ_CODE.slice(start, end);
  const readKeys = [...body.matchAll(/getPref\(\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
  assert.deepEqual(
    readKeys.sort(), ['eqBypass', 'eqGains', 'eqPreset'],
    `restoreEqPresetSetting 读取的 key 变了：${JSON.stringify(readKeys)}`
  );
});

test('eq.js: 启动恢复接线在首次 playing（用户手势后），不在模块加载期劫持音频', () => {
  assert.ok(
    /addEventListener\(\s*['"]playing['"]/.test(EQ_CODE) && /once:\s*true/.test(EQ_CODE),
    '缺少一次性 playing 恢复接线——启动即建图会被自动播放策略卡在 suspended 憋死输出'
  );
});

// ── C. 公开面（拆分的核心约束） ────────────────────────
test('eq.js: 公开面恰为 11 个函数（7 个 UI 面 + 2 个图访问器 + 2 个派生纯函数）', () => {
  assert.deepEqual(
    exportsOf(EQ_CODE), EQ_ALL,
    'eq.js 的 export 面变化了，player.js 的 re-export、window 挂载与 visualizer 的 import 需同步'
  );
});

// preampTrimDb 是 ESM-only 导出（player.js 的 import/再导出面里没有它），
// 但它**不是**没人用 —— _mirrorToGraph 逐次曲线变化都在调它。这条钉的是「不许有人
// 顺手把它挪进 player.js 的桥接面」：那是 7 个 HTML onclick 认的面，多一个名字就多
// 一处 window 挂载与 re-export 的同步负担，而它对 onclick 毫无用处。
test('eq.js: preampTrimDb 不许混进 player.js 的桥接面（ESM-only，与 visualizer 同路）', () => {
  assert.ok(!EQ_PUBLIC.includes('preampTrimDb'), '它不是 UI 面，混进去会让「7 个函数」这层台账失真');
  const m = PLAYER_CODE.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player\/eq\.js'/);
  assert.ok(m && !/\bpreampTrimDb\b/.test(m[1]), 'player.js 不该 import 它（它归 eq.js 内部与单测消费）');
  assert.match(
    EQ_CODE,
    /preampNode\.gain\.value\s*=\s*Math\.pow\(10,\s*preampTrimDb\(eff\)\s*\/\s*20\)/,
    'preamp 增益必须由 preampTrimDb 驱动，不许就地心算第二份 trim（否则改名/改口径会漏掉镜像点）'
  );
});

test('player.js: 从 ./player/eq.js import 的恰是 7 个 UI 函数（图访问器不经 player 中转）', () => {
  // 注意：不能用 [\s\S]*? 桥接——前面的 stats.js import 会先被匹配到。
  // 用 [^}]* 限定在单个 import 语句的括号内，并锚定 eq.js 的 from。
  const m = PLAYER_CODE.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player\/eq\.js'/);
  assert.ok(m, 'player.js 未从 ./player/eq.js import —— re-export 会 ReferenceError');
  const imported = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.deepEqual(imported, EQ_PUBLIC, 'import 的名字集合与 eq.js 的 export 面不一致');
});

test('player.js: re-export 了 eq.js 的全部公开函数', () => {
  const m = PLAYER_CODE.match(/export\s*\{([\s\S]*?)\}\s*;/);
  assert.ok(m, 'player.js 未见 re-export 语句');
  const reexported = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.deepEqual(reexported, EQ_PUBLIC, 're-export 的名字集合与 eq.js 的 export 面不一致');
});

test('player.js: 7 个 EQ 函数仍挂在 window 上（index.html onclick 的存活前提）', () => {
  for (const n of EQ_PUBLIC) {
    assert.ok(
      new RegExp(`window\\.${n}\\s*=`).test(PLAYER_CODE),
      `window.${n} 未挂载 —— index.html 的 onclick="${n}(...)" 会静默失效`
    );
  }
});

test('player.js: EQ 实现已清空（不应再有 EQ_BANDS / EQ_PRESETS / eqFilters 定义）', () => {
  const leaked = [];
  for (const sym of ['const EQ_BANDS', 'const EQ_PRESETS', 'const eqFilters', 'let eqBypassed', 'function matchPresetName', 'function getEqGains']) {
    if (PLAYER_CODE.includes(sym)) leaked.push(sym);
  }
  assert.deepEqual(leaked, [], `player.js 仍残留 EQ 实现：${leaked.join(', ')}（拆分未完成或发生回退）`);
});

// ── D. 反向检查：保证这些断言真的在读源码 ────────────────
test('自检: stripComments 生效且扫描器能看见真实代码', () => {
  assert.ok(!stripComments('/* createBiquadFilter() */ let a = 1;').includes('createBiquadFilter'), '块注释未剥离');
  assert.ok(!stripComments('let a = 1; // eqFilters.push(x)').includes('eqFilters'), '行注释未剥离');
  assert.ok(stripComments('const x = eqFilters.push(1);').includes('eqFilters'), '代码被误剥离');
  assert.equal(PLAYER_SRC.length, read('src/renderer/js/player.js').length, 'PLayer_SRC 读取异常');
  assert.ok(PLAYER_SRC.includes('audioCtx'), 'player.js 读取内容异常（探针文件自检）');
});
