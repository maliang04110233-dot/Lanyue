/**
 * 失效历史项「⬇ 批量重新下载」
 *
 * 153 给的是"这些歌我不想要了 ⇒ 把死账删干净"；本增量给另一半：
 * "歌我还想听，只是文件被我删了 ⇒ 一次把它们重新下回来"。
 * 现状缺口：retryFailedFromHistory 恒查 status='error'，够不到"成功过但文件没了"的行；
 * 想重下只能对着 🚫 行逐条点 🔄，而清理入口还会把"其实还想要"的歌一起删掉记录。
 *
 * 一条要紧的取舍：重下**不许**带 forceRedownload。判定失效是点击前那一刻的 stat 结果，
 * 从弹出确认到逐条入队之间文件可能被同步盘放回来 —— 那时主进程查重（findDownloaded
 * 自己会核磁盘）应当跳过它，而不是覆盖式重下一遍。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { pickDeadEntries } = require('../src/utils/deadRefs');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const loadFilters = async () => import(`../src/renderer/js/historyFilters.js?ck=${Math.random()}`);

// 载荷构造（deadRetryPayload）在9fb2b05 挪进了中性的 enqueuePayload.js（第二个消费方 =
// 播放失败就地重下）。它的行为测试跟着模块搬去 test/play-failure-retry.test.js，
// 本文件只留历史页这一侧的汇总文案 / 确认文案 / 接线。

test('deadRetrySummary：四种去向各报各的数，"文件又回来了"要说明白', async () => {
  const { deadRetrySummary } = await loadFilters();
  const t = deadRetrySummary({ added: 3, dup: 1, had: 2, fail: 1 });
  assert.match(t, /入队 3/);
  assert.match(t, /已在队列 1/);
  assert.match(t, /失败 1/);
  assert.match(t, /又回来了|又在了/); // had 的成因，不是"已下载跳过"那么含糊
});

test('deadRetrySummary：一首都没入队时不许用成功口气', async () => {
  const { deadRetrySummary } = await loadFilters();
  const t = deadRetrySummary({ added: 0, dup: 0, had: 4, fail: 0 });
  assert.doesNotMatch(t, /✅/);
  assert.match(t, /ℹ️|⚠️/);
});

test('pickDeadEntries：把重下要用的 album/quality 一并带上去（规则仍只在主进程一处）', () => {
  const out = pickDeadEntries([
    { id: '1', source: 'netease', status: 'done', missing: true, title: 'A', artist: 'B', album: 'C', quality: 'lossless' },
    { id: '2', source: 'netease', status: 'done', missing: true, title: 'D', artist: 'E' },
  ]);
  assert.equal(out[0].album, 'C');
  assert.equal(out[0].quality, 'lossless');
  assert.equal(out[1].album, '');
  // 缺音质时留空，由入队载荷统一兜底：默认值只该有一个家
  assert.equal(out[1].quality, '');
});

test('deadConfirmText：重下模式的问句不许写成"删除记录"，并把两条路都摆出来', async () => {
  const { deadConfirmText } = await loadFilters();
  const t = deadConfirmText([{ id: '1', source: 'x', title: 'T', artist: 'A' }], 10, 'redownload');
  assert.match(t, /加入下载队列|重新下载/);
  assert.doesNotMatch(t, /确认删除/);
  assert.match(t, /清理失效/);   // 只想删记录的人该被指去 153 那个入口
  assert.match(t, /扫描|放回/);  // "文件其实还在别处"的止损提示
});

test('接线：历史页重下入口二次判活、用 deadEntries、确认之后才入队、且不动任何记录', () => {
  const src = read('src/renderer/js/views/history.js');
  const start = src.indexOf('async function redownloadDeadHistory');
  assert.ok(start > -1, 'redownloadDeadHistory 必须存在');
  const rest = src.slice(start + 10);
  const end = rest.search(/\n(?:async )?function /);
  const fn = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(fn.length > 200 && fn.length < src.length, '函数体必须被正确截取');
  assert.match(fn, /markMissing: true/);          // 重新判活，而不是信页面上的旧结论
  assert.match(fn, /deadEntries/);                // 死账集合由主进程给（153 的单一规则之家）
  assert.match(fn, /enqueuePayloadFor/);          // 载荷构造走共用纯函数（155 起住 enqueuePayload.js）
  assert.match(fn, /classifyRetryResult/);        // 去向分类同样只有一家在 enqueuePayload.js
  const enqueueAt = fn.indexOf('api.addToQueue');
  const confirmAt = fn.indexOf('askConfirm(');
  assert.ok(confirmAt > -1 && enqueueAt > confirmAt, '确认必须在入队之前');
  assert.doesNotMatch(fn, /removeHistory|dlForgetKeys/); // 本增量只重下，删账是 153 的事
  assert.match(fn, /switchDlSubTab\('queue'\)/);   // 下起来了就把用户带到队列
});

test('接线：工具栏按钮只在当前页真有失效行时出现（常态零占位，绕开头部拥挤）', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<button class="tab" id="historyRedlBtn" onclick="redownloadDeadHistory\(\)"[^>]*hidden>/);
  const src = read('src/renderer/js/views/history.js');
  assert.match(src, /historyRedlBtn/);
  assert.match(src, /\.hidden = /);               // 渲染时按当页死账数决定显隐
});

test('接线：命令面板入口 + 清理确认文案里给出"还想要就重下"的另一条路', async () => {
  const palette = read('src/renderer/js/commandPalette.js');
  assert.match(palette, /id: 'dl-redl-dead'/);
  assert.match(palette, /redownloadDeadHistory/);
  const { deadConfirmText } = await loadFilters();
  const text = deadConfirmText([{ id: '1', source: 'x', title: 'T', artist: 'A' }], 10);
  assert.match(text, /重新下载|重下/); // 只说"删除"会把还想要的歌劝进错误入口
});

test('零新通道：重下只用既有 api 方法，query-history 的参数形状逐字未动', () => {
  const KNOWN = ['queryHistory', 'getHistoryStats', 'addToQueue', 'removeHistory', 'clearHistory', 'openFolder', 'exportPlaylist'];
  const used = new Set([...read('src/renderer/js/views/history.js').matchAll(/api\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
  assert.deepEqual([...used].filter((k) => !KNOWN.includes(k)), []);
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'query-history': \{ invoke: MAIN, args: \[\['opts', t\.obj\(\)\]\] \}/);
});
