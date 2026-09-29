/**
 * 守卫：3-C 质量策略的双语 key 与设置页接线
 *
 * 本仓有两条既有纪律，这里把 3-C 也钉进去：
 *   1. zh / en 两份语言包必须**键集合完全一致**（缺一个键 ⇒ 切到英文就露 key）；
 *   2. 键必须是**扁平点分键**（"settings.policy.title"），不是嵌套对象
 *      —— 本仓语言包一律扁平，t() 按点分路径取值，嵌套写法会静默落空。
 *
 * 另附：pref 白名单接线（不是死旋钮）+ window 导出齐全（inline onclick 靠它）。
 *
 * 注：本文件刻意**不用** t('settings.policy.q.' + q) 这类动态拼键——
 * toast-i18n 的扫描器只认字面量键，拼出来的前缀会被判成"缺席的键"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
const en = JSON.parse(read('src/renderer/js/lang/en.json'));
const SETTINGS_JS = read('src/renderer/js/views/settings.js');
const INDEX_HTML = read('src/renderer/index.html');
const PREFS_JS = read('src/main/ipc/prefs.js');

const { QUALITY_RULE_IDS, QUALITY_RANK } = require('../src/utils/qualityPolicy');

/** 本仓语言包是扁平键：zh['settings.policy.title'] 直接命中 */
const KEY_BASE = [
  'settings.policy.title',
  'settings.policy.hint',
  'settings.policy.empty',
  'settings.policy.resetDone',
  'settings.policy.toggle',
  'settings.policy.up',
  'settings.policy.down',
  'settings.policy.remove',
  'settings.policy.scopeArtist',
  'settings.policy.scopeAlbum',
];
const QUALITY_KEYS = Object.keys(QUALITY_RANK).map((q) => `settings.policy.q.${q}`);
const RULE_KEYS = QUALITY_RULE_IDS.map((r) => `settings.policy.rule.${r}`);

// ── 1. 双语键集合一致 ──────────────────────────────────

test('语言包：zh / en 键集合完全一致', () => {
  const a = Object.keys(zh).sort();
  const b = Object.keys(en).sort();
  const onlyZh = a.filter((k) => !b.includes(k));
  const onlyEn = b.filter((k) => !a.includes(k));
  assert.deepEqual(onlyZh, [], `zh 有而 en 缺: ${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `en 有而 zh 缺: ${onlyEn.join(', ')}`);
});

// ── 2. 3-C 的键存在、是扁平写法、且双语都有 ──────────────

test('3-C 键齐备：全部以扁平点分键存在且双语都有', () => {
  for (const k of [...KEY_BASE, ...QUALITY_KEYS, ...RULE_KEYS]) {
    assert.equal(typeof zh[k], 'string', `zh 缺扁平键 ${k}`);
    assert.equal(typeof en[k], 'string', `en 缺扁平键 ${k}`);
    assert.ok(zh[k].trim().length, `zh 的 ${k} 是空串`);
    assert.ok(en[k].trim().length, `en 的 ${k} 是空串`);
  }
});

test('3-C 键齐备：没有退化成嵌套对象（本仓语言包一律扁平）', () => {
  for (const [code, j] of [['zh', zh], ['en', en]]) {
    assert.equal(j.settings && typeof j.settings.policy, 'undefined',
      `${code} 的 settings.policy 是嵌套对象：t() 走点分路径取不到，会静默显示裸键`);
  }
});

test('3-C 键齐备：规则名集合与求值器登记的规则一一对应', () => {
  const present = Object.keys(zh).filter((k) => k.startsWith('settings.policy.rule.'))
    .map((k) => k.slice('settings.policy.rule.'.length)).sort();
  assert.deepEqual(present, [...QUALITY_RULE_IDS].sort(),
    '规则文案与 qualityPolicy.QUALITY_RULE_IDS 不一致（加规则忘了加文案？）');
});

test('3-C 键齐备：档位文案集合与档位序一致（漏一个就出空白 option）', () => {
  const present = Object.keys(zh).filter((k) => k.startsWith('settings.policy.q.'))
    .map((k) => k.slice('settings.policy.q.'.length)).sort();
  assert.deepEqual(present, Object.keys(QUALITY_RANK).sort(), '档位文案与 QUALITY_RANK 不一致');
});

test('3-C 键齐备：en 不含中文（漏翻译会直接印在英文界面上）', () => {
  const CJK = /[\u4e00-\u9fff]/;
  for (const k of [...KEY_BASE, ...QUALITY_KEYS, ...RULE_KEYS]) {
    assert.ok(!CJK.test(en[k]), `en 的 ${k} 含中文: ${en[k]}`);
  }
});

// ── 3. 设置页真正用到了这些键（防止改了代码忘了改文案）──

test('3-C 接线：设置页字面量引用的 settings.policy.* 键都在语言包里', () => {
  const used = new Set();
  // 只取字面量：'settings.policy.xxx'，跳过前缀拼接（'settings.policy.rule.' + id）
  for (const m of SETTINGS_JS.matchAll(/t\('(settings\.policy\.[a-zA-Z_.]+)'\)/g)) {
    if (!m[1].endsWith('.')) used.add(m[1]);
  }
  assert.ok(used.size >= 1, `应至少引用几处 policy 键，实得 ${used.size}`);
  for (const key of used) {
    assert.equal(typeof zh[key], 'string', `设置页用到 ${key}，但 zh 语言包里没有`);
    assert.equal(typeof en[key], 'string', `设置页用到 ${key}，但 en 语言包里没有`);
  }
});

test('3-C 接线：HTML 的 data-i18n 指向的 policy 键都存在', () => {
  const keys = [...INDEX_HTML.matchAll(/data-i18n="(settings\.policy\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 1, 'HTML 里应有 data-i18n="settings.policy.*"');
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `HTML 引用 ${key}，但语言包里没有`);
  }
});

test('3-C 接线：规则容器与四个规则 id 在 HTML/JS 两侧一致', () => {
  assert.match(INDEX_HTML, /id="qualityPolicyList"/, '缺规则容器');
  for (const id of QUALITY_RULE_IDS) {
    assert.ok(SETTINGS_JS.includes(`'${id}'`), `设置页未登记规则 ${id}`);
  }
});

// ── 4. pref 接线：不是死旋钮 ──────────────────────────

test('3-C 接线：qualityPolicyRules 在 set-pref 白名单里（否则用户改不动）', () => {
  assert.match(PREFS_JS, /'qualityPolicyRules'/, '未注册进 ALLOWED_PREF_KEYS = 死旋钮');
});

// ── 5. window 导出齐全（inline onclick 靠 window 找函数）──

test('3-C 接线：inline handler 用到的每个函数都有 window 导出', () => {
  const used = new Set();
  for (const m of SETTINGS_JS.matchAll(/(?:onclick|onchange)="(resetQualityPolicy|toggleQualityPolicy|moveQualityPolicy|removeQualityPolicy)\(/g)) {
    used.add(m[1]);
  }
  used.add('addQualityPolicy'); // HTML 里通过 onchange 调用
  for (const fn of used) {
    assert.match(SETTINGS_JS, new RegExp(`window\\.${fn} = ${fn};`),
      `${fn} 被 inline handler 调用但没导出到 window ⇒ 点击即 ReferenceError`);
  }
});
