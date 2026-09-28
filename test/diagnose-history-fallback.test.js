/**
 * 命令面板的失败诊断在队列清空后够到下载历史
 *
 * 编号说明：159/160/161/163 由并发会话先落地，162 是我的上一轮，本增量是 164。
 *
 * 症状：⌘K 的「🆘 诊断最近一个失败任务」和「🩹 失败诊断报告」都只读 queueSnapshot，
 * 而队列是易失的 —— 重启即清空。于是最常见的场景恰恰是它说瞎话的时候：昨天下了十首
 * 红了八首，今天开机想弄清为什么，两条入口一起回「队列里没有失败任务」，
 * 而历史里那八条 errorCode 全在（158 已经把 errorCode 落进失败历史）。
 *
 * 本增量的形状：只加一个纯函数 pickFailureSource（队列优先、队列没有才用历史兜底），
 * 两条入口各接一次。刻意不做的事：① 不把两边合并成一份清单去重 —— queue 的 taskId 与
 * 历史的 id 不同源（一个是下载任务号、一个是平台曲目号），拿 title 去重是猜，
 * 宁可只在队列空时兜底；② 历史来源的报告不给「一键重试」—— retryableFailureCount
 * 从此只数带 taskId 的条目，够不着的动作不占按钮（158 的「缺动作就少一个按钮」同一条纪律）。
 * 历史行没有 taskId 还照算的原因分组，因此兜底报告仍然说得出原因，只是把去处指回历史页。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIAG = 'src/renderer/js/diagnose.js';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const fresh = () => import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);

/** 队列里的失败行（有 taskId ⇒ 重试够得着） */
const qErr = (title, code) => ({ status: 'error', taskId: 't_' + title, title, errorCode: code, error: '' });
/** 历史里的失败行（有 id 无 taskId ⇒ 重试够不着，这是两边的本质差别） */
const hErr = (title, code) => ({ status: 'error', id: 's_' + title, title, errorCode: code, error: '' });

// ── pickFailureSource：谁提供失败清单，唯一一家 ──────────────

test('pickFailureSource：队列有失败就只认队列（历史不参与，两边永不相加）', async () => {
  const { pickFailureSource } = await fresh();
  const r = pickFailureSource([qErr('a', 'NETWORK_TIMEOUT'), { status: 'done', title: 'b' }], [hErr('c', 'AUTH_EXPIRED')]);
  assert.equal(r.origin, 'queue');
  assert.deepEqual(r.items.map(i => i.title), ['a']);
  assert.equal(r.latest.title, 'a', '队列快照按入队顺序，「最近一个」取最后入的那条');
});

test('pickFailureSource：队列清空（重启）后由历史兜底', async () => {
  const { pickFailureSource } = await fresh();
  const r = pickFailureSource([], [hErr('c', 'AUTH_EXPIRED'), { status: 'done', title: 'd' }, hErr('e', 'CDN_EMPTY')]);
  assert.equal(r.origin, 'history');
  assert.deepEqual(r.items.map(i => i.title), ['c', 'e']);
  assert.equal(r.latest.title, 'c', '历史查询按 recent（seq DESC）排，「最近一个」是第一条 —— 两个来源的次序相反，这条差别必须有名字，交给调用方各记一遍迟早记错');
});

test('pickFailureSource：队列只剩成功行也算清空', async () => {
  const { pickFailureSource } = await fresh();
  const r = pickFailureSource([{ status: 'done', title: 'a' }, { status: 'downloading', title: 'b' }], [hErr('c', 'X')]);
  assert.equal(r.origin, 'history');
  assert.equal(r.items.length, 1);
});

test('pickFailureSource：两边都没有失败 ⇒ 空清单 + null（调用处照旧提示，不编造）', async () => {
  const { pickFailureSource } = await fresh();
  assert.deepEqual(pickFailureSource([], []), { items: [], origin: null, latest: null });
  assert.deepEqual(pickFailureSource(null, null), { items: [], origin: null, latest: null });
  assert.deepEqual(pickFailureSource([null, undefined], [null]), { items: [], origin: null, latest: null });
});

// ── 报告的重试只数够得着的 ────────────────────────────────

test('retryableFailureCount：历史来源条目（无 taskId）不占「一键重试」', async () => {
  const { groupFailures, retryableFailureCount } = await fresh();
  const histOnly = groupFailures([hErr('a', 'NETWORK_TIMEOUT'), hErr('b', 'CDN_EMPTY')]);
  assert.equal(histOnly.length, 2, '分组照常（诊断仍要说得出原因）');
  assert.equal(retryableFailureCount(histOnly), 0, '但这一页没有能一键重试的东西');
  const mixed = groupFailures([qErr('c', 'NETWORK_TIMEOUT'), hErr('d', 'NETWORK_TIMEOUT')]);
  assert.equal(retryableFailureCount(mixed), 1, '只有带 taskId 的那条算数');
});

test('groupFailures：历史行缺 title 时回落「未知曲目」，不渲染 undefined', async () => {
  const { groupFailures } = await fresh();
  const g = groupFailures([{ status: 'error', id: 'x', errorCode: 'AUTH_EXPIRED' }]);
  assert.deepEqual(g[0].songs.map(s => s.title), ['未知曲目']);
  assert.equal(g[0].songs[0].taskId, undefined, '历史条目不许被伪造成带 taskId');
});

// ── 接线：两条入口都过 pickFailureSource，且用的是既有频道 ──────────────

test('接线：diagnoseLatestFailure 与 openFailureReport 共用一份取数，都走 pickFailureSource', () => {
  const src = read(DIAG);
  const feed = src.slice(src.indexOf('async function _failureSources'), src.indexOf('const AUTH_CODES'));
  const latest = src.slice(src.indexOf('function diagnoseLatestFailure'), src.indexOf('async function _failureSources'));
  const report = src.slice(src.indexOf('function openFailureReport'), src.indexOf('if (typeof document'));
  assert.ok(feed.length > 0 && latest.length > 0 && report.length > 0, '三个函数都该在同一个文件里（取数只住一家）');
  assert.equal((src.match(/queryHistory\(/g) || []).length, 1, '历史查询在 diagnose.js 里只许出现一次');
  assert.match(feed, /status: 'error', sort: 'recent', limit: 200/, '兜底查询必须点名只要失败、按最近在前、且有界（不把全库拉进内存）');
  for (const [name, body] of [['diagnoseLatestFailure', latest], ['openFailureReport', report]]) {
    assert.match(body, /_failureSources\(/, `${name} 应从统一取数入口拿清单`);
    assert.doesNotMatch(body, /status === 'error'/, `${name} 不该再自己筛队列（规则住一家）`);
  }
});

test('接线：历史来源的报告写明出处，并把去处指回历史页（不给够不着的重试按钮）', () => {
  const src = read(DIAG);
  assert.match(src, /来自下载历史/, '出处要如实说出来，用户才知道这不是队列那份');
  assert.match(src, /switchDlSubTab\('history'\)/, '历史来源给一个转页动作，替代够不着的重试');
  // 重试按钮的显示条件只看 retryableFailureCount（它对历史条目恒为 0），不许另开旁路
  // 注意从 _renderFailReport 起切：`body.appendChild(foot)` 在单条诊断弹层里也有，
  // 直接对全文件 indexOf 会取到前面那个 ⇒ 截出空串（写这条时踩过一次）
  const rp = src.slice(src.indexOf('function _renderFailReport'));
  const foot = rp.slice(rp.indexOf('const retryable = retryableFailureCount'), rp.indexOf('panel.appendChild(header)'));
  assert.ok(foot.length > 20, '页脚区域要真切到了东西（空串说明锚点取错了）');
  assert.match(foot, /if \(retryable > 0\)/);
  assert.equal((foot.match(/switchDlSubTab\('history'\)/g) || []).length, 1, '转页按钮只加一处（别和重试按钮混在一个分支里）');
});

test('零新通道：diagnose.js 用到的 api 方法全在契约 METHODS 里', () => {
  const { METHODS } = require('../src/shared/ipcContract.js');
  const used = [...new Set([...read(DIAG).matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]))];
  assert.ok(used.includes('queryHistory'), '本轮接的是既有历史查询');
  assert.deepEqual(used.filter(k => !(k in METHODS)), [], `出现了契约外的方法：${used.join(',')}`);
});
