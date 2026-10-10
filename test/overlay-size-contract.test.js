/**
 * 弹层尺寸契约钉（真机排版欠账的静态收口）
 *
 * 来龙去脉：176/177/180 连留了三笔「未做真机验证」的欠账（确认弹层 440px
 * 窄窗换行？庆祝 toast 9 秒长文案撑不撑破？统计弹层标题？）——Electron 窗口
 * browser-use 接不上、vite dev 又没有 preload 的 api，目测路线在 CI 里走不通。
 * 但"排版会不会破"其实不必眼睛：真机风险全部由一个几何事实罩住——主窗
 * minWidth=900（src/main/index.js，用户缩不更窄），于是任何弹层只要满足
 * 「裸固定宽 ≤ minWidth−40（滚动条与呼吸位冗余）」或「自带 max-width 护栏」，
 * 就不可能横向溢出；长文案只要钉面允许换行（无 white-space:nowrap、
 * flex 子项 min-width:0）就不会截断。巡扫实况：最大裸宽 640（home-chart-modal），
 * 880 的 settings-panel 有 92vw 护栏，confirm-dialog 有 calc(100vw-32px) 护栏，
 * toast-action 420px 且 toast-action-text min-width:0——三笔欠账全部可证收敛。
 *
 * 立法按形状扫（168 铁律）：CSS 里 selector 含 panel/modal/dialog/wizard/picker/sheet
 * 且声明裸 width:Npx（N≥300）的规则，必须「同规则带 max-width」或「N ≤ 阈值」，
 * 阈值从主窗 minWidth 现场派生（不手抄数字——177 语言增量同理：常数只能有一个家）。
 * 将来谁新写一个 .xxx-modal { width: 1200px } 不挂护栏，这里直接红。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

// ── 阈值派生：主窗 minWidth 是这份契约的唯一数字来源 ──────────

const MIN_WIDTH = (() => {
  const m = read('src', 'main', 'windowManager.js').match(/minWidth:\s*(\d+)/);
  assert.ok(m, '主窗必须显式声明 minWidth——尺寸契约的锚点不能被删');
  return Number(m[1]);
})();
const BARE_LIMIT = MIN_WIDTH - 40; // 滚动条 + 两侧呼吸位的冗余

// ── CSS 规则形状巡扫 ───────────────────────────────────────

function cssRules() {
  const rules = [];
  const dir = path.join(ROOT, 'src', 'renderer', 'styles');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    const src = read('src', 'renderer', 'styles', f);
    // selector 段不许含 @（排除 @media/@keyframes 外壳，其内层规则仍能单独命中）
    for (const m of src.matchAll(/([^{}/@]+)\{([^{}]*)\}/g)) {
      rules.push({ file: f, sel: m[1].trim(), decls: m[2] });
    }
  }
  return rules;
}

const PANEL_SEL = /\.(?:[\w-]*(?:panel|modal|dialog|wizard|picker|sheet))\b/i;

test('弹层固定宽度契约：裸 width≥300px 的 panel/modal/dialog 规则必须自带 max-width 护栏或不超主窗 minWidth−40', () => {
  const offenders = [];
  for (const r of cssRules()) {
    if (!PANEL_SEL.test(r.sel)) continue;
    const w = r.decls.match(/(?:^|;)\s*width:\s*(\d+)px/);
    if (!w || Number(w[1]) < 300) continue;
    if (/max-width/.test(r.decls)) continue; // 自带护栏，放行
    if (Number(w[1]) <= BARE_LIMIT) continue; // 窄于安全线，放行
    offenders.push(`${r.file} ${r.sel}: width:${w[1]}px（阈值 ${BARE_LIMIT}，无 max-width）`);
  }
  assert.deepEqual(offenders, [],
    `以下弹层会在最小窗口下横向溢出:\n${offenders.join('\n')}\n修法：加 max-width:calc(100vw - 32px) 或收窄到 ≤${BARE_LIMIT}px`);
});

// ── 三笔真机欠账的正向契约钉 ────────────────────────────────

test('confirm 弹层（176 欠账）：440px 定宽带视口护栏，标题与逐行文案不禁换行——F2 多行点名文案必须真能换行', () => {
  const rules = cssRules().filter((r) => /\.confirm-dialog/.test(r.sel));
  const box = rules.find((r) => /\.confirm-dialog\s*$/.test(r.sel));
  assert.ok(box, '.confirm-dialog 基规则必须在位');
  assert.match(box.decls, /max-width:\s*calc\(/, '弹层必须带 calc 视口护栏');
  assert.match(box.decls, /width:\s*440px/);
  for (const r of rules) {
    assert.ok(!/white-space:\s*nowrap/.test(r.decls),
      `.confirm-dialog 家族禁止 nowrap（${r.sel}）——原生 confirm 压平换行的旧病不许从 CSS 侧复发`);
  }
});

test('行动 toast（177 欠账）：长文案容器带 max-width 且文本项 min-width:0——90 字庆祝文案换行不撑破、按钮不被挤出去', () => {
  const rules = cssRules();
  const action = rules.find((r) => /\.toast-action\s*$/.test(r.sel));
  assert.ok(action && /max-width:\s*\d+px/.test(action.decls), '.toast-action 必须有 max-width');
  const wPx = Number(action.decls.match(/max-width:\s*(\d+)px/)[1]);
  assert.ok(wPx <= BARE_LIMIT, `toast 宽度 ${wPx}px 不得超安全线 ${BARE_LIMIT}px`);
  const text = rules.find((r) => /toast-action-text/.test(r.sel));
  assert.ok(text && /min-width:\s*0/.test(text.decls) && /flex:\s*1/.test(text.decls),
    '.toast-action-text 必须 flex:1 + min-width:0——缺 min-width:0 时长词会把按钮挤出容器');
});

test('统计弹层（180 欠账）：500px 裸宽在 minWidth 派生安全线内（若将来加宽必须挂护栏，由首测罩着）', () => {
  const stats = cssRules().find((r) => /\.stats-panel\s*$/.test(r.sel));
  const w = Number(stats.decls.match(/width:\s*(\d+)px/)[1]);
  assert.ok(w <= BARE_LIMIT, `stats-panel ${w}px 应仍 ≤ 安全线 ${BARE_LIMIT}px`);
});
