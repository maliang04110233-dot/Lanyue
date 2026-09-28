/**
 * 下载历史失败行就地诊断（跨页反馈一致性）
 *
 * 症状：队列里的失败行有 🆘，下载历史里的 ❌ 行只有一个 🔄 ——
 * 队列清空或重启之后，失败记录就只剩"当年失败过"，原因、建议、下一步全查不到。
 * 而 diagnose.diagnoseFailure 恒从 queueSnapshot 按 taskId 找任务，
 * 历史记录根本没有 taskId，所以接不上。
 *
 * 本增量的形状：诊断"该出现哪些按钮"收成纯函数 diagHeals 一家（队列与历史共用），
 * 「怎么办」的具体动作由调用方页面给（队列=retryQueueItem / 历史=retryFromHistory），
 * 于是通用弹层不再假设自己只服务于下载队列。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const fresh = () => import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);

/** 取顶层函数体：本仓模块函数一律顶格 `function X(`，体内首个行首 `}` 即结束 */
function fnBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at > -1, `找不到 ${header}`);
  const rest = src.slice(at + header.length);
  const end = rest.indexOf('\n}');
  assert.ok(end > 20, `${header} 函数体过短，截取边界不对`);
  return rest.slice(0, end);
}

// ── diagHeals：按钮显隐规则唯一一家 ──────────────────────

test('diagHeals：鉴权类给「前往设置」，并保留「立即重试」（Cookie 更新后当场再试）', async () => {
  const { diagHeals, classifyFailure } = await fresh();
  let retried = 0;
  const acts = diagHeals(classifyFailure('AUTH_EXPIRED', ''), { retry: () => { retried++; } });
  assert.deepEqual(acts.map((a) => a.label), ['前往设置', '立即重试']);
  assert.equal(acts[0].primary, true, '主按钮仍是「前往设置」——去设置才是根治');
  assert.equal(acts[1].primary, false);
  acts[1].run();
  assert.equal(retried, 1, 'run 必须是页面给的那个动作本身，可执行');
});

test('diagHeals：网络类只给重试，不给设置', async () => {
  const { diagHeals, classifyFailure } = await fresh();
  const acts = diagHeals(classifyFailure('NETWORK_TIMEOUT', ''), { retry: () => {} });
  assert.deepEqual(acts.map((a) => a.label), ['立即重试']);
});

test('diagHeals：版权受限 / CDN 空数据这类没有一键动作，就不许凭空造按钮', async () => {
  const { diagHeals, classifyFailure } = await fresh();
  assert.deepEqual(diagHeals(classifyFailure('COPYRIGHT_RESTRICTED', ''), { retry: () => {} }), []);
  assert.deepEqual(diagHeals(classifyFailure('CDN_EMPTY', ''), { retry: () => {} }), []);
});

test('diagHeals：页面没提供重试动作时，可重试类也不出现指向别处的按钮', async () => {
  const { diagHeals, classifyFailure } = await fresh();
  // 设置是全局导航，任何页面都点得动 → 保留
  assert.deepEqual(diagHeals(classifyFailure('AUTH_EXPIRED', ''), {}).map((a) => a.label), ['前往设置']);
  // 重试需要本页的动作 → 没给就没有
  assert.deepEqual(diagHeals(classifyFailure('NETWORK_TIMEOUT', ''), {}), []);
  assert.deepEqual(diagHeals(classifyFailure('', ''), undefined).map((a) => a.label), []);
});

test('diagHeals：入参残缺（null/未知 heal）不炸，只返回空数组', async () => {
  const { diagHeals } = await fresh();
  assert.deepEqual(diagHeals(null, null), []);
  assert.deepEqual(diagHeals({ heal: 'teleport' }, { retry: () => {} }), []);
  assert.deepEqual(diagHeals(undefined, undefined), []);
});

// ── 接线：通用弹层不再自带队列专属判断 ────────────────────

test('接线：弹层按钮一律出自 diagHeals，队列专属动作不得硬编在通用层', () => {
  const body = fnBody(read('src/renderer/js/diagnose.js'), 'function _renderDiag(task, d, ctx)');
  assert.match(body, /diagHeals\(d, ctx\)/);
  assert.doesNotMatch(body, /retryQueueItem/, '重试动作归调用方给，通用层不许认识队列');
  assert.doesNotMatch(body, /\.heal ===/, '按钮显隐规则只剩 diagHeals 一家');
  assert.doesNotMatch(body, /data-tab="settings"/, '导航动作同样只在 diagHeals 一侧');
});

test('接线：队列入口自己带 retry 动作（原行为逐字保留：按 taskId 重试）', () => {
  const src = read('src/renderer/js/diagnose.js');
  const body = fnBody(src, 'function diagnoseFailure(taskId)');
  assert.match(body, /showDiagnosis\(task, \{ retry:/);
  assert.match(body, /window\.retryQueueItem\(task\.taskId\)/);
});

// ── 接线：历史页就地诊断 ─────────────────────────────────

const HISTORY = 'src/renderer/js/views/history.js';

test('接线：历史页 error 行有 🆘，且只在 error 行（done 行没失败可诊断，dead 行已有专门文案）', () => {
  const src = read(HISTORY);
  assert.match(src, /const diagBtn = /);
  assert.match(src, /onclick="diagnoseHistoryItem\(\$\{idx\}\)">🆘</);
  assert.match(src, /\$\{s\.status === 'error' \|\| dead \? retryBtn : ''\}\$\{s\.status === 'error' \? diagBtn : ''\}/);
});

test('接线：历史行诊断吃本页记录 + 本页重试动作，不新增任何 IPC 调用', () => {
  const src = read(HISTORY);
  const body = fnBody(src, 'function diagnoseHistoryItem(idx)');
  assert.match(body, /_historyItems\[idx\]/);
  assert.match(body, /showDiagnosis\(/);
  assert.match(body, /retry: \(\) => retryFromHistory\(/);
  assert.doesNotMatch(body, /\bapi\./, '诊断是纯读已有字段，不该顺手新增通道调用');
  // 行随翻页失效：诚实说明而不是弹一个空层
  assert.ok(body.indexOf('showToast') < body.indexOf('showDiagnosis('));
  assert.match(body, /已不在本页|请刷新/);
});

test('接线：历史行右键菜单同样有诊断项，且排在重新下载之后、收藏之前', () => {
  const body = fnBody(read(HISTORY), 'function historyRowContext(e)');
  assert.match(body, /status === 'error'[\s\S]{0,120}🆘/);
  const diagAt = body.indexOf('诊断失败原因');
  const retryAt = body.indexOf("'重新下载'");
  assert.ok(retryAt > -1 && diagAt > retryAt, '诊断项跟着重试项出现，顺序与队列侧一致');
});

test('接线：诊断入口既进导出块又进 window 桥（行内 onclick 走全局）', () => {
  const src = read(HISTORY);
  // 钉「showDiagnosis 在这个 import 语句里」即可：同模块后续会长出兄弟导出（162 就加了 failureTagHtml）
  assert.match(src, /import \{[^}]*\bshowDiagnosis\b[^}]*\} from '\.\.\/diagnose\.js';/);
  assert.match(src, /window\.diagnoseHistoryItem = diagnoseHistoryItem;/);
  const exportBlock = src.slice(src.indexOf('export {'));
  assert.match(exportBlock.slice(0, exportBlock.indexOf('}')), /diagnoseHistoryItem,/);
});

// ── 零新通道 / 既有契约未动 ─────────────────────────────

test('零新通道：诊断只读既有字段，query-history 契约形状逐字未动', () => {
  const used = new Set([...read(HISTORY).matchAll(/api\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const KNOWN = ['queryHistory', 'getHistoryStats', 'addToQueue', 'removeHistory', 'clearHistory', 'openFolder', 'exportPlaylist'];
  assert.deepEqual([...used].filter((k) => !KNOWN.includes(k)), []);
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'query-history': \{ invoke: MAIN, args: \[\['opts', t\.obj\(\)\]\] \}/);
});
