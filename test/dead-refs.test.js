/**
 * 下载历史里的「死账」——记录还在，文件早没了
 *
 * 症状（用户视角）：手工清理过下载目录 / 换硬盘 / 把音乐整批挪走后 ——
 *   下载历史仍是一片 ✅，行尾 ▶ 点了报「本地文件读不到」，
 *   搜索页照旧挂着「✔ 已下载」徽标（dlStatus 只读历史表，从不看磁盘），
 *   「⤴ 导出 m3u」把不存在的文件路径写进播放列表，
 *   「总计 / 成功 N」的统计也一直虚高。
 * 机理：历史表存的是下载成功那一刻的 save_path，此后磁盘发生什么它一无所知。
 * /152 治的是"文件还在但路径变了"（改名），本增量治另一半：
 *   文件真没了 ⇒ 记录本身就是死的，该让用户一次清干净，而不是逐条右键删。
 * 这里全部走真件（真 sqlite / 真 fsAsync.exists / 真临时文件），不用 mock。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  markMissing,
  pickDeadEntries,
  MAX_MARK_CHECK,
} = require('../src/utils/deadRefs');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('markMissing：只给 done 且有路径的行下判断，别的行一律不碰', async () => {
  const dir = tmp('musicdl-dead-');
  const alive = path.join(dir, 'alive.mp3');
  fs.writeFileSync(alive, 'x');
  const gone = path.join(dir, 'gone.mp3');

  const input = [
    { id: '1', source: 'netease', status: 'done', savePath: alive },
    { id: '2', source: 'netease', status: 'done', savePath: gone },
    { id: '3', source: 'qq', status: 'error', savePath: gone },      // 失败行本来就没文件
    { id: '4', source: 'qq', status: 'done', savePath: '' },          // 没路径可判
    { id: '5', source: 'qq', status: 'done' },                         // 连字段都没有
    { id: '6', source: 'qq', status: 'done', savePath: '   ' },        // 空白路径判不了
  ];
  const fsa = require('../src/utils/fsAsync');
  const out = await markMissing(input, fsa.exists);

  assert.equal(out[0].missing, false, '文件在 ⇒ 明确判活，前端才敢把 ▶ 留着');
  assert.equal(out[1].missing, true, '文件没了 ⇒ 判死');
  assert.ok(!('missing' in out[2]), '失败行不参与判活：它从来就不该有文件');
  assert.ok(!('missing' in out[3]), '没有 savePath 的行没有任何可查的东西，别乱标');
  assert.ok(!('missing' in out[4]));
  assert.ok(!('missing' in out[5]), '纯空白路径经归一后是空串，等同没有路径');
  // 入参保真：返回新数组新对象，原记录一字未动（历史查询结果可能被别处持有）
  assert.notEqual(out, input);
  assert.ok(!('missing' in input[0]));
  assert.ok(!('missing' in input[1]));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('markMissing：同一路径只 stat 一次（同一首歌可能在历史里出现多次）', async () => {
  const dir = tmp('musicdl-dead-dedupe-');
  const gone = path.join(dir, 'gone.mp3');
  const calls = [];
  const exists = async p => { calls.push(p); return false; };
  const out = await markMissing([
    { id: 'a', source: 'netease', status: 'done', savePath: gone },
    { id: 'b', source: 'qq', status: 'done', savePath: gone },
    // 反斜杠写法与正斜杠写法必须算同一路径 —— 判等自己抄一份必然漂移（148/151 的教训）
    { id: 'c', source: 'kuwo', status: 'done', savePath: gone.replace(/\//g, '\\') },
  ], exists);
  assert.equal(calls.length, 1, `每个不同路径只该 stat 一次，实际 ${calls.length} 次`);
  assert.deepEqual(out.map(o => o.missing), [true, true, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('markMissing：判活本身出错时一律按"还活着"处理，绝不误杀', async () => {
  const broken = async () => { throw new Error('EACCES'); };
  const out = await markMissing([
    { id: '1', source: 'netease', status: 'done', savePath: 'D:/music/a.mp3' },
  ], broken);
  assert.equal(out[0].missing, false, '读不到结论就留下这行 —— 错杀一条记录用户是找不回来的');
  const nofn = await markMissing([{ id: '1', source: 'x', status: 'done', savePath: 'D:/a.mp3' }], null);
  assert.deepEqual(nofn, [{ id: '1', source: 'x', status: 'done', savePath: 'D:/a.mp3' }]);
  assert.deepEqual(await markMissing(null, async () => true), [], '非数组成了一律给空，不抛');
  assert.deepEqual(await markMissing('x', async () => true), []);
  const junk = await markMissing([null, 'x', { id: '1', source: 'a', status: 'error' }], async () => { throw new Error('nope'); });
  assert.deepEqual(junk, [null, 'x', { id: '1', source: 'a', status: 'error' }], '脏行原样退回，且绝不因判活失败而标死');
});

test('markMissing：一次最多判 MAX_MARK_CHECK 个不同路径，超出部分不标（宁缺毋滥）', async () => {
  const items = [];
  for (let i = 0; i < MAX_MARK_CHECK + 5; i++) {
    items.push({ id: String(i), source: 'netease', status: 'done', savePath: `D:/m/${i}.mp3` });
  }
  let n = 0;
  const out = await markMissing(items, async () => { n += 1; return false; });
  assert.equal(n, MAX_MARK_CHECK, '超限后不再 stat（历史页可能是 limit=100000 的全量查询）');
  assert.equal(out.filter(o => 'missing' in o).length, MAX_MARK_CHECK);
  assert.ok(!('missing' in out[MAX_MARK_CHECK]), '没判过的行不许带 missing，前端据此不会误删');
});

test('pickDeadEntries：只挑判死且认得出身份的行，按 source:id 去重，并带上点名要用的歌名', () => {
  const picked = pickDeadEntries([
    { id: '1', source: 'netease', missing: true, title: '晴天', artist: '周杰伦' },
    { id: '1', source: 'netease', missing: true, title: '晴天', artist: '周杰伦' },   // 同一条记录被查了两遍
    { id: '2', source: 'qq', missing: true },
    { id: '3', source: 'qq', missing: false },
    { id: '4', source: 'qq' },                        // 压根没判
    { id: null, source: 'qq', missing: true },        // 删不掉：没有主键
    { id: '5', source: '', missing: true },           // 同上
    null,
    'junk',
  ]);
  // 82ae415 起载荷多两个字段（重下要用 album/quality）：不变量随消费方扩了，
  // 改的是期望值而不是放松断言 —— 键集仍需逐字对上，多一个少一个都算漂移。
  // 注意 quality 是空串不是 'standard'：默认值归入队载荷那一家管，这里只搬运
  assert.deepEqual(picked, [
    { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', album: '', quality: '' },
    { id: '2', source: 'qq', title: '', artist: '', album: '', quality: '' },
  ]);
  for (const bad of [null, undefined, 'x', {}]) {
    assert.deepEqual(pickDeadEntries(bad), []);
  }
});

test('清理文案：说清只删记录不动文件，没清掉时不许报成功', async () => {
  const { deadSummary, deadConfirmText } = await import('../src/renderer/js/historyFilters.js');
  assert.match(deadSummary(3, 12), /3/);
  assert.match(deadSummary(3, 12), /12/);
  assert.ok(!/已清理/.test(deadSummary(0, 12)), '一条都没清掉，就不能说"已清理"');
  assert.match(deadSummary(0, 12), /没有/);

  const dead = [];
  for (let i = 0; i < 7; i++) dead.push({ id: String(i), source: 'netease', title: `歌${i}`, artist: '歌手' });
  const text = deadConfirmText(dead, 40);
  assert.ok(text.includes('7 条'), '先报数再问，用户才知道自己在确认什么');
  assert.match(text, /只删记录/);
  assert.match(text, /不会.*改动|未做.*改动|不碰/);
  assert.match(text, /取消/, '整库挪盘时全是"失效"，必须给出一条反悔的路');
  assert.ok(text.includes('歌0') && text.includes('歌手'), '点名前几条，一眼看出是不是自己挪走的');
  assert.ok(!text.includes('歌6'), '超过 5 条只列前 5 条，弹层不许变成长名单');
  assert.equal(deadConfirmText([], 0).includes('0 条'), true, '空列表也要能正常出文案（调用方会先拦住）');
});

test('真 sqlite 端到端：判活 → 挑死账 → remove → 徽标数据源同步变干净', async () => {
  const history = require('../src/utils/history');
  const fsa = require('../src/utils/fsAsync');
  const dir = tmp('musicdl-dead-his-');
  const songDir = tmp('musicdl-dead-songs-');
  const alive = path.join(songDir, 'alive.mp3');
  const gone = path.join(songDir, 'gone.mp3');
  fs.writeFileSync(alive, 'x');

  history.init(dir);
  history.clear();
  history.add({ id: '1', source: 'netease', title: '还在', status: 'done', savePath: alive, finishedAt: 1000 });
  history.add({ id: '2', source: 'qq', title: '没了', status: 'done', savePath: gone, finishedAt: 2000 });
  history.add({ id: '3', source: 'qq', title: '失败的', status: 'error', savePath: '', finishedAt: 3000 });

  const { items } = history.query({ limit: 100 });
  const marked = await markMissing(items, fsa.exists);
  assert.equal(marked.find(m => m.id === '1').missing, false);
  assert.equal(marked.find(m => m.id === '2').missing, true);
  assert.ok(!('missing' in marked.find(m => m.id === '3')), '失败记录不进清理范围');

  const dead = pickDeadEntries(marked);
  assert.equal(dead.length, 1);
  assert.equal(history.remove(dead), 1);

  const after = history.query({ limit: 100 }).items;
  assert.deepEqual(after.map(a => a.id).sort(), ['1', '3'], '死账走了，活账和失败账都留下');
  assert.equal(history.findDownloaded('1', 'netease').savePath, alive, '没中的记录不能被顺手删掉');
  assert.equal(history.findDownloaded('2', 'qq'), null);
  assert.ok(fs.existsSync(alive) && !fs.existsSync(gone), '清理只动记录，磁盘一个字节都不碰');

  history.destroy();
  for (const d of [dir, songDir]) fs.rmSync(d, { recursive: true, force: true });
});

test('接线：query-history 按 opts.markMissing 判活并把待删清单算好带上，契约不为此新增通道', () => {
  const ipc = read('src/main/ipc/history.js');
  assert.ok(ipc.includes("require('../../utils/deadRefs')"), 'query-history 没接判活');
  assert.match(ipc, /o\.markMissing/, 'handler 没读 opts.markMissing');
  assert.ok(ipc.indexOf('history.query(') < ipc.indexOf('markMissing('), '先查库再判活');
  assert.ok(/markMissing\(.*exists/.test(ipc), '判活要用异步 exists，主进程不许同步 stat');
  assert.ok(ipc.includes('pickDeadEntries('), '待删清单必须由主进程用同一处规则算出');
  assert.ok(ipc.includes('deadEntries'), '判活结果要随查询返回值一起上去，前端才不必自己再推一遍');

  const contract = read('src/shared/ipcContract.js');
  assert.ok(!/'[a-z-]*(dead|missing|stale|purge|clean-history|check-path)'/.test(contract), '不该为此功能新增通道名');
  assert.match(contract, /'query-history':\s*\{ invoke: MAIN, args: \[\['opts', t\.obj\(\)\]\] \}/, 'opts 是自由对象，判活开关不必改契约形状');
});

test('接线：历史页把判活带进查询、行上如实说，并给出清理入口', () => {
  const local = read('src/renderer/js/views/history.js');
  assert.ok(/markMissing:\s*true/.test(local), '历史页查询没要求判活');
  assert.ok(local.includes('missing'), '渲染层得用上主进程如实上报的判活结果');
  assert.match(local, /async function cleanDeadHistory/, '没有清理入口');
  const clean = local.slice(local.indexOf('async function cleanDeadHistory'));
  assert.ok(clean.includes('removeHistory('), '清理走既有 remove-history，不开新通道');
  assert.ok(clean.includes('deadEntries'), '待删清单用主进程算好的那份，规则不许在渲染层再抄一遍');
  assert.ok(!/\.missing === true/.test(clean), '清理逻辑不得自己判死（那是主进程那一处规则）');
  assert.ok(clean.indexOf('confirm(') < clean.indexOf('removeHistory('), '删用户记录前必须先问一声');
  assert.ok(clean.includes('dlForgetKeys'), '记录删了还得把骗人的「✔ 已下载」徽标一起摘掉');
  // 导出 m3u 不该再把死路径写进播放列表
  const m3u = local.slice(local.indexOf('async function exportHistoryM3u'), local.indexOf('async function retryFromHistory'));
  assert.ok(/missing/.test(m3u), '导出 m3u 仍在写已失效的文件路径');

  const dl = read('src/renderer/js/dlStatus.js');
  assert.ok(/export function dlForgetKeys/.test(dl), 'dlStatus 没有摘徽标的出口');
  assert.ok(dl.includes('window.dlForgetKeys'), '按本项目约定桥到 window 供 HTML/其他视图调用');

  const html = read('src/renderer/index.html');
  assert.match(html, /onclick="cleanDeadHistory\(\)"/, '工具栏缺按钮');

  const palette = read('src/renderer/js/commandPalette.js');
  assert.ok(palette.includes('cleanDeadHistory'), '命令面板也该能到（与其他历史动作同构）');
});

test('接线：判活规则收成一处，别处不得再抄一份 path 判等', () => {
  const src = read('src/utils/deadRefs.js');
  assert.ok(src.includes("require('./relinkRefs')"), '路径归一又抄第二份（148/151/152 同一课）');
  assert.ok(!/replace\(\/\\\\\/\/g/.test(src), '不得自己写 replace(/\\\\/g,…)，用 canonPath');
});
