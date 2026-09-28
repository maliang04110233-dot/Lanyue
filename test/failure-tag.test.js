/**
 * 失败原因徽标的口径收口 + 历史行就地显示
 *
 * 症状：同一个失败错误码，全仓有三份互不相认的说法 ——
 *   ① diagnose.js DIAG_TABLE：cause/advice/heal（「怎么办」那一套）
 *   ② views/download.js ERROR_TAGS：短标签 + 颜色（队列行的「是什么」徽标）
 *   ③ views/download.js:442 的 /^(VIP_REQUIRED|AUTH_EXPIRED|LOGIN_REQUIRED)$/：
 *      鉴权码清单，和 diagnose.js 的 AUTH_CODES 是同一份规则的第二只手抄
 * 码表加一个码要改两处、鉴权判定加一个码要改三处，漏一处就出现
 * 「诊断弹层说得出原因、队列徽标是空的」这类跨页不一致。
 *
 * 编号说明：159/160 由并发会话先落地（删重确认框、侧边栏分组），本增量是它之后的 162。
 *
 * 本增量的形状：码表只留 DIAG_TABLE 一家（徽标短标签/颜色作为它的字段），
 * 徽标渲染与鉴权判定都从 diagnose.js 导出；下载历史因此白捡一个徽标 ——
 * 153 让 ✅ 不再骗人，本轮让 ❌ 行不点开 🆘 也能一眼看出是哪类失败。
 *
 * 历史行徽标必须按 status 把关：history.add 是 {...existing, ...entry} 合并写，
 * 成功的 entry 不带 errorCode，先失败后成功的记录仍留着上一次的失败码，
 * 不看 status 就会给 ✅ 行戴上 ❌ 的帽子。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const fresh = () => import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);

/** diagnose 码表里的全部平台回写码（与 src/shared/errors.js 的取流侧码对齐） */
const CODES = [
  'VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED', 'COPYRIGHT_RESTRICTED',
  'UNAVAILABLE', 'CDN_EMPTY', 'NETWORK_TIMEOUT', 'NO_AUDIO_STREAM', 'UNKNOWN_PLATFORM',
];

// ── failureTagHtml：徽标渲染唯一一家 ──────────────────────

test('failureTagHtml：鉴权码给出队列原来那份短标签（口径搬家不改用户看到的字）', async () => {
  const { failureTagHtml } = await fresh();
  assert.match(failureTagHtml('VIP_REQUIRED'), />需VIP</, '需VIP');
  assert.match(failureTagHtml('AUTH_EXPIRED'), />Cookie过期</);
  assert.match(failureTagHtml('LOGIN_REQUIRED'), />需登录</);
  assert.match(failureTagHtml('COPYRIGHT_RESTRICTED'), />版权受限</);
  assert.match(failureTagHtml('CDN_EMPTY'), />CDN异常</);
  assert.match(failureTagHtml('NETWORK_TIMEOUT'), />网络超时</);
  assert.match(failureTagHtml('UNKNOWN_PLATFORM'), />未知平台</);
});

test('failureTagHtml：九个码个个有徽标（漏一个就是加码时只补诊断不补徽标的老毛病）', async () => {
  const { failureTagHtml } = await fresh();
  for (const code of CODES) {
    const html = failureTagHtml(code);
    assert.ok(html.length > 0, `${code} 没有徽标`);
    assert.match(html, /class="fail-tag"/, `${code} 徽标未走统一的 .fail-tag`);
    assert.match(html, /color:var\(--/, `${code} 徽标没带语义色`);
  }
});

test('failureTagHtml：无码 / 未知码一律不渲染（宁可没有，也不许猜一个原因给用户）', async () => {
  const { failureTagHtml } = await fresh();
  assert.equal(failureTagHtml(''), '');
  assert.equal(failureTagHtml(null), '');
  assert.equal(failureTagHtml(undefined), '');
  assert.equal(failureTagHtml('IO_ERROR'), '', '未收录进诊断码表的码不许凭空造徽标');
  assert.equal(failureTagHtml('INFERRED'), '', '关键词推断出来的伪码不是平台回写码');
});

test('failureTagHtml：徽标是短标签不是句子（它挤在行内，长文案属于诊断弹层）', async () => {
  const { failureTagHtml } = await fresh();
  for (const code of CODES) {
    const html = failureTagHtml(code);
    const m = html.match(/^<span class="fail-tag" style="color:var\(--[a-z-]+\)">([^<]*)<\/span>$/);
    assert.ok(m, `${code} 徽标不是「一处渲染」产出的形状：${html}`);
    assert.ok(m[1].length <= 8, `${code} 徽标文案过长：${m[1]}`); // 最长的仍是队列原有说法「Cookie过期」
    assert.ok(!/。|，/.test(m[1]), `${code} 徽标写成了句子：${m[1]}`);
  }
});

// ── isAuthFailure：鉴权判定唯一一家 ──────────────────────

test('isAuthFailure：只有 VIP / Cookie 过期 / 需登录这三类算「自动重试没意义」', async () => {
  const { isAuthFailure } = await fresh();
  for (const code of ['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED']) {
    assert.equal(isAuthFailure(code), true, `${code} 应判为鉴权类`);
  }
  for (const code of ['CDN_EMPTY', 'NETWORK_TIMEOUT', 'UNAVAILABLE', 'NO_AUDIO_STREAM',
    'COPYRIGHT_RESTRICTED', 'UNKNOWN_PLATFORM']) {
    assert.equal(isAuthFailure(code), false, `${code} 不该被跳过重试`);
  }
});

test('isAuthFailure：空值与非字符串安全（无码失败是最常见情形，不能抛）', async () => {
  const { isAuthFailure } = await fresh();
  for (const v of [undefined, null, '', 0, 'UNKNOWN', {}]) {
    assert.equal(isAuthFailure(v), false, `${String(v)} 不该算鉴权`);
  }
});

// ── 单一住处：三份抄本收成一家 ────────────────────────────

test('download.js 不再自带码表与手抄鉴权正则', () => {
  const src = read('src/renderer/js/views/download.js');
  assert.ok(!src.includes('ERROR_TAGS'), 'ERROR_TAGS 还留在队列页 = 第二份码表');
  assert.ok(!/VIP_REQUIRED:/.test(src), 'download.js 里仍逐码列了错误码');
  assert.ok(!/\^\(VIP_REQUIRED\|AUTH_EXPIRED\|LOGIN_REQUIRED\)\$/.test(src),
    '内联鉴权正则仍在 = AUTH_CODES 的第二只手抄');
  assert.match(src, /import \{[^}]*failureTagHtml[^}]*\} from '\.\.\/diagnose\.js'/,
    '队列页应从 diagnose.js 取徽标');
  assert.match(src, /import \{[^}]*isAuthFailure[^}]*\} from '\.\.\/diagnose\.js'/);
  assert.match(src, /failureTagHtml\(s\.errorCode\b/, '队列行须继续渲染徽标');
  assert.match(src, /if \(isAuthFailure\(s\.errorCode\)\) continue/, '批量重试须走统一鉴权判定');
});

test('鉴权三码在渲染层只许出现在 diagnose.js 一处', () => {
  const dir = path.join(ROOT, 'src', 'renderer', 'js');
  const hits = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        if (/AUTH_EXPIRED/.test(s) && /LOGIN_REQUIRED/.test(s)) {
          hits.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
      }
    }
  })(dir);
  assert.deepEqual(hits, ['src/renderer/js/diagnose.js'],
    `鉴权码清单被抄到了多处：${hits.join(', ')}`);
});

test('徽标外观由 .fail-tag 一处定义，且不再出现 var(...)22 这种拼不出色的死声明', () => {
  const css = read('src/renderer/styles/content.css');
  const at = css.indexOf('.fail-tag');
  assert.ok(at > -1, '.fail-tag 规则缺失');
  assert.equal((css.match(/\.fail-tag\s*\{/g) || []).length, 1, '.fail-tag 规则应恰好一处');
  const rule = css.slice(css.indexOf('{', at), css.indexOf('}', at) + 1);
  assert.match(rule, /color-mix\(in srgb/,
    '徽标底色须用 color-mix 算：老写法 var(--色)22 是无效 CSS，从来没生效过');
  const bad = ['src/renderer/js/views/download.js', 'src/renderer/js/views/history.js']
    .filter((f) => read(f).includes('}22') || read(f).includes('}44'));
  assert.deepEqual(bad, [], '页面里仍在拼 `var(--色)22`，那串 CSS 从不生效');
});

// ── 历史行接入 ───────────────────────────────────────────

test('历史失败行就地显示原因徽标，且只在 error 行显示', () => {
  const src = read('src/renderer/js/views/history.js');
  assert.match(src, /import \{[^}]*failureTagHtml[^}]*\} from '\.\.\/diagnose\.js'/,
    '历史页应从 diagnose.js 取徽标，而不是自己造句');
  assert.ok(!/ERROR_TAGS|VIP_REQUIRED:/.test(src), '历史页不许再开一份码表');
  const row = src.slice(src.indexOf('_historyItems.map'), src.indexOf('exportHistoryM3u'));
  assert.match(row, /s\.status === 'error' \? failureTagHtml\(s\.errorCode\b/,
    '徽标必须按 status 把关：合并写会留下上一次失败的 errorCode，不看 status 就是给 ✅ 戴 ❌ 的帽子');
  assert.ok(!/!s\.status|dead \? failureTagHtml/.test(row), '判活失效行（🚫）不是失败行，不该出现原因徽标');
});

test('徽标两条消费路径都零新 IPC 通道', () => {
  const { METHODS } = require('../src/shared/ipcContract.js');
  for (const f of ['src/renderer/js/views/download.js', 'src/renderer/js/views/history.js']) {
    const used = [...read(f).matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
    const extra = used.filter((k) => !(k in METHODS));
    assert.deepEqual(extra, [], `${f} 引入了契约外的 api 调用：${extra.join(', ')}`);
  }
});

// ── 徽标本身即诊断入口 ────────────────────────────
//
// 症状：162 让行内戴上了「需VIP / Cookie过期」，158+164 让 🆘 弹层会说「怎么办」，
// 但这两样在空间上是分开的 —— 用户的眼睛落在徽标上，手却要摸到行尾那枚按钮。
// 队列进入批量选择模式时行尾 🆘 整组隐藏，那一刻徽标是唯一的失败线索，却点不动。
// 修法：failureTagHtml 接第二参 {fn, arg}，由页面把「这一行该调哪个入口」交给徽标。
// 通用层依旧不认识任何一页的动作（158 立的规矩），拿到的只是入口名 + 机器生成的 id。

test('徽标挂上点击：先掐掉行级 onclick，再调页面交来的入口', async () => {
  const { failureTagHtml } = await fresh();
  const html = failureTagHtml('NETWORK_TIMEOUT', { fn: 'diagnoseFailure', arg: 'lx7ab_3f9k2c' });
  assert.match(html, /^<span class="fail-tag"/, '它仍是那枚徽标，不是换成了别的控件');
  assert.match(html, /role="button"/, '可点的非按钮元素要报出角色（读屏与队列行内已有的点击区同一写法）');
  assert.match(html, /tabindex="0"/);
  assert.match(html, /title="[^"]*诊断[^"]*"/, '悬停须说清点下去会看到什么');
  assert.match(html, /onclick="event\.stopPropagation\(\);diagnoseFailure\('lx7ab_3f9k2c'\)"/,
    '徽标在队列的 queue-info 点击区内部，不 stopPropagation 就是"点开诊断顺便展开详情"');
  assert.match(html, /cursor:pointer/, '看不出来能点的入口等于没有入口');
  assert.match(html, />网络超时<\/span>$/, '徽标文案一字不许动（长文案属于弹层）');
});

test('不给动作时长相与 162 一字不差（九码全数无 onclick / 无指针 / 无角色）', async () => {
  const { failureTagHtml } = await fresh();
  for (const code of CODES) {
    const html = failureTagHtml(code);
    assert.ok(!/onclick|cursor|title=|role=|tabindex/.test(html),
      `${code} 无动作时不该长出可点痕迹：${html}`);
  }
});

test('数字参数按数值传入（历史行号与行尾 🆘 的 diagnoseHistoryItem(idx) 同一口径）', async () => {
  const { failureTagHtml } = await fresh();
  const html = failureTagHtml('CDN_EMPTY', { fn: 'diagnoseHistoryItem', arg: 3 });
  assert.match(html, /diagnoseHistoryItem\(3\)/, '行号是数值，不该被引号变成字符串');
  assert.match(failureTagHtml('CDN_EMPTY', { fn: 'diagnoseHistoryItem', arg: 0 }), /diagnoseHistoryItem\(0\)/,
    '第一行的行号 0 是合法值，不许被当成空值丢掉');
});

test('参数形状不合规就不挂点击：徽标层没有转义器，宁可退回不可点徽标', async () => {
  const { failureTagHtml } = await fresh();
  const plain = failureTagHtml('NETWORK_TIMEOUT');
  const bad = [
    { fn: 'f', arg: "a'b" }, { fn: 'f', arg: 'a"b' }, { fn: 'f', arg: '<script>' },
    { fn: 'f', arg: 'x;alert(1)' }, { fn: 'f', arg: 'a b' }, { fn: 'f', arg: '' },
    { fn: 'f', arg: NaN }, { fn: 'f', arg: -1 }, { fn: 'f', arg: 1.5 },
    { fn: '', arg: 1 }, { fn: 'a-b', arg: 1 }, { fn: 'window.x', arg: 1 }, { fn: null, arg: 1 },
    {}, null, undefined, 'f', ['f'], 42,
  ];
  for (const diag of bad) {
    assert.equal(failureTagHtml('NETWORK_TIMEOUT', diag), plain,
      `${JSON.stringify(diag)} 不该挂上点击`);
  }
});

test('接线：队列把 taskId 交给徽标（批量选择模式下行尾 🆘 会隐藏）', () => {
  const src = read('src/renderer/js/views/download.js');
  assert.match(src, /failureTagHtml\(s\.errorCode, \{ fn: 'diagnoseFailure', arg: s\.taskId \}\)/,
    '队列行徽标未接诊断入口');
});

test('接线：历史把行号交给徽标，与行尾 🆘 共用同一个 diagnoseHistoryItem', () => {
  const src = read('src/renderer/js/views/history.js');
  const row = src.slice(src.indexOf('_historyItems.map'), src.indexOf('exportHistoryM3u'));
  assert.match(row, /failureTagHtml\(s\.errorCode, \{ fn: 'diagnoseHistoryItem', arg: idx \}\)/,
    '历史行徽标未接诊断入口');
  assert.match(row, /onclick="diagnoseHistoryItem\(\$\{idx\}\)">🆘</,
    '行尾按钮与徽标必须调同一个入口，否则两处入口会各自漂移');
});

test('诊断入口都是页面已挂在 window 上的既有函数（零新 IPC、零新入口）', () => {
  assert.match(read('src/renderer/js/diagnose.js'), /window\.diagnoseFailure = diagnoseFailure;/);
  assert.match(read('src/renderer/js/views/history.js'), /window\.diagnoseHistoryItem = diagnoseHistoryItem;/);
});

test('徽标渲染保持纯函数：不碰 api / window / document（Node 里直接测得动）', () => {
  const src = read('src/renderer/js/diagnose.js');
  const body = src.slice(src.indexOf('export function failureTagHtml'), src.indexOf('function _closeDiag'));
  assert.ok(body.length > 0, 'failureTagHtml 与 _closeDiag 的相对位置变了，本钉取不到片段');
  for (const re of [/\bapi\./, /\bwindow\./, /\bdocument\./]) {
    assert.ok(!re.test(body), `徽标渲染里出现了 ${re}，纯函数口径会被打破（测试得在 Node 里跑）`);
  }
});
