/**
 * 订阅检查里「什么都没取到」不等于「检查成功、没有新歌」
 *
 * 症状（都在 src/main/subscriptions.js 的 runCheck 里，写回顺序造成的）：
 * gateway 对缺能力、需登录、VIP/私密歌单一律**静默返回空数组**（不抛异常），
 * 而 runCheck 先 `entry.lastCheckError = ''`、再无条件 `entry.lastSeenIds = seenIds`，
 * 于是这一次"空手而归"被记成一次成功检查：
 *   D1 订阅卡片显示「上次检查 <时间>」且不带任何告警 —— 界面说它在守护，其实什么都没拿到；
 *   D2 更要命的是**首次**检查为空：lastSeenIds 被播成空快照（hasSeeded 立刻变 true，
 *      「待首次检查」标记消失），下一次真数据到达时整单 200 首全部算成「新增」——
 *      头注释承诺的「首次检查静默播种，避免订阅瞬间刷屏 + autoDownload 把整个歌单灌进队列」
 *      被一次空结果绕过，防的是同一个坑却漏了这个入口；
 *   D3 已正常播种后再遇到空清单：并集语义只保证"老歌不复活成新增"，但 lastSeenIds 仍被
 *      空数组重新赋值（丢不掉，因为并集），而 lastCheckError 被抹成 '' —— 抽风这件事无人知晓。
 *
 * 修法（判定收成一家，而不是在原来那段里补 if）：新增纯函数 applyCheckToEntry(entry, songs, now)。
 * 空/非数组 = 「这次没取到数据」：只写 lastCheckError + 推进 lastCheckedAt（按检查间隔退避，
 * 免得变成每 60s 打一次平台），lastSeenIds / newSongs 一字不动；只有真拿到清单才清错误、写快照。
 * runCheck 从此不再自己写这两个字段（见下方接线钉）。零新 IPC、零渲染层改动 ——
 * 卡片早就渲染 lastCheckError 与「待首次检查」，缺的只是有人如实写它。
 *
 * 分工：本文件是真行为测（纯函数在 Node 里直调，含"先空后满"的连编剧本）；
 * "写回只剩这一家"这类跨函数形状另走源码钉（扫描前 stripComments，口径同 eq-behaviour）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const prefs = require('../src/utils/prefs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-sub188-'));
prefs.init(tmpDir);

const subs = require('../src/main/subscriptions');
const { makeEntry, applyCheckToEntry, EMPTY_CHECK_ERROR, MAX_NEW_SONGS } = subs._internal;

test.after(() => {
  prefs.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const song = (id) => ({ id: String(id), source: 'netease', title: 'T' + id, artist: 'A' });
const list = (...ids) => ids.map(song);
/** 走一遍"这次检查"的写回，返回新 entry（生产里 runCheck 会 Object.assign 回原对象） */
const check = (entry, songs, now = NOW) => applyCheckToEntry(entry, songs, now).entry;

// ── D1：空清单必须留下可见的凭据 ──────────────────────────

test('空数组判为「这次没取到数据」：写错误、不报新增、不排自动下载', () => {
  const e = makeEntry('playlist', 'netease', '42', '我的歌单');
  const r = applyCheckToEntry(e, [], NOW);
  assert.equal(r.entry.lastCheckError, EMPTY_CHECK_ERROR, '空清单必须记账，否则卡片只说"检查成功"');
  assert.ok(/未取到|没有.*曲目/.test(EMPTY_CHECK_ERROR || ''), '错误文案要点明"没取到曲目"，别写成技术性空串');
  assert.equal(r.freshCount, 0);
  assert.deepEqual(r.toEnqueue, [], '什么都没取到时不许给出队名单');
  assert.equal(r.entry.lastSeenIds, null, 'D2 的根：空清单不得播种');
  assert.equal(r.empty, true);
});

test('非数组（gateway 吞错后的各种形状）一律按「没取到」处理', () => {
  const e = makeEntry('playlist', 'netease', '42', 'x');
  for (const bad of [null, undefined, {}, '[]', 0]) {
    const r = applyCheckToEntry(e, bad, NOW);
    assert.equal(r.empty, true, `${JSON.stringify(bad)} 不该算一次有效检查`);
    assert.equal(r.entry.lastCheckError, EMPTY_CHECK_ERROR);
    assert.equal(r.entry.lastSeenIds, null, '快照字段不许被脏输入改写');
  }
});

test('空清单也推进 lastCheckedAt：不这么做就会从每 6 小时变成分钟打平台', () => {
  const e = makeEntry('playlist', 'netease', '42', 'x');
  const r = applyCheckToEntry(e, [], NOW);
  assert.equal(r.entry.lastCheckedAt, NOW,
    '调度器按 lastCheckedAt 判到期；不推进 = 60s tick 每次都重试同一项（风控自找的）');
});

// ── D2：首次为空埋下的整单刷屏 ────────────────────────────

test('连编：第一次空、第二次拿到 3 首 —— 不得把整单报成「新增」（头注释承诺的那一格）', () => {
  const e0 = makeEntry('playlist', 'netease', '42', '老歌单');
  const e1 = check(e0, []);
  assert.equal(e1.lastSeenIds, null, '前置：空清单没有把它播成"已播种"');
  const r2 = applyCheckToEntry(e1, list(1, 2, 3), NOW + 1000);
  assert.equal(r2.freshCount, 0,
    '今天的真实症状：空快照让 3 首老歌全算成新歌，红点 +1 且 autoDownload 会直接灌队列');
  assert.deepEqual(r2.entry.newSongs, [], '静默播种那次不该产生未读');
  assert.deepEqual(r2.entry.lastSeenIds.map(String), ['1', '2', '3'], '但快照要落下，此后才谈得上"新增"');
  assert.equal(r2.entry.lastCheckError, '', '真拿到清单了，前一次的告警该复位');
});

test('连编：首次就拿到 3 首 → 第二次多了 1 首，只有那 1 首算新增', () => {
  let e = makeEntry('playlist', 'netease', '42', 'x');
  e = check(e, list(1, 2, 3), NOW);
  assert.deepEqual(e.newSongs, [], '首次播种静默（既有语义，本增量不许做坏）');
  const r = applyCheckToEntry(e, list(1, 2, 3, 4), NOW + 1000);
  assert.equal(r.freshCount, 1);
  assert.deepEqual(r.entry.newSongs.map((s) => String(s.id)), ['4']);
});

// ── D3：抽风不得擦掉既有状态 ──────────────────────────────

test('已播种后遇到空清单：旧快照与未读红点原样保留（一次抽风不能擦掉用户没看完的新歌）', () => {
  let e = makeEntry('playlist', 'netease', '42', 'x');
  e = check(e, list(1, 2, 3), NOW);
  e = check(e, list(1, 2, 3, 4, 5), NOW + 1000);
  assert.equal(e.newSongs.length, 2, '前置：此刻有 2 首未读');
  const before = e.lastSeenIds.slice();
  const r = applyCheckToEntry(e, [], NOW + 2000);
  assert.deepEqual(r.entry.lastSeenIds, before, '快照只进不出，且空清单连"出"的机会都不该有');
  assert.deepEqual(r.entry.newSongs.map((s) => String(s.id)), ['5', '4'],
    '未读列表与顺序都得保着 —— 它归用户"看过了"这个动作管，不归一次失败检查管');
  assert.equal(r.entry.lastCheckError, EMPTY_CHECK_ERROR);
});

test('失败那次不动 newCount 的分子：红点数在抽风前后一致', () => {
  let e = makeEntry('playlist', 'netease', '42', 'x');
  e = check(e, list(1, 2), NOW);
  e = check(e, list(1, 2, 3), NOW + 1000);
  const n = (e.newSongs || []).length;
  assert.ok(n > 0, '前置：先攒出未读');
  const after = check(e, [], NOW + 2000);
  assert.equal((after.newSongs || []).length, n);
});

// ── 自动入队的闸门（同一次判定里给出名单，别在调用方再摸一遍条件）──

test('autoDownload 只在"真新增且非播种"那一次给出名单；关着时永远为空', () => {
  const on = makeEntry('playlist', 'netease', '42', 'x');
  on.autoDownload = true;
  const seeded = check(on, list(1, 2), NOW);
  assert.deepEqual(applyCheckToEntry(seeded, list(1, 2, 3), NOW + 1000).toEnqueue.map((s) => String(s.id)), ['3']);
  assert.deepEqual(applyCheckToEntry(seeded, [], NOW + 2000).toEnqueue, [], '空清单不得喂自动下载');

  const off = makeEntry('playlist', 'netease', '42', 'x');
  const offSeeded = check(off, list(1, 2), NOW);
  assert.equal(offSeeded.autoDownload, false, '前置：默认就是关');
  assert.deepEqual(applyCheckToEntry(offSeeded, list(1, 2, 3), NOW + 1000).toEnqueue, [],
    '开关关着就不该有名单（与上面 on 的那次唯一差别就是这个开关）—— 名单本身就是结论的一部分，调用方不该再判一次 autoDownload');
});

test('未读列表仍是「新的在前 + 截到上限」（既有语义回归，委派之后不许做坏）', () => {
  const many = list(...Array.from({ length: MAX_NEW_SONGS + 5 }, (_, i) => i + 1));
  let e = makeEntry('playlist', 'netease', '42', 'x');
  e = check(e, many, NOW);
  const r = applyCheckToEntry(e, many.concat(song(999)), NOW + 1000);
  assert.ok(r.entry.newSongs.length <= MAX_NEW_SONGS, 'prefs.json 不许被单次检查撑爆');
  assert.equal(String(r.entry.newSongs[0].id), '999', '新的在前');
});

// ── 接线钉：写回只剩这一家 ────────────────────────────────

test('runCheck 不再自己写 lastSeenIds / lastCheckError —— 判定与写回同一家，才有"顺序不会错"', () => {
  const src = stripComments(read('src/main/subscriptions.js'));
  const at = src.indexOf('async function runCheck(');
  assert.ok(at > -1, '找不到 runCheck');
  const body = src.slice(at, src.indexOf('\n}\n', at) + 3);
  assert.match(body, /applyCheckToEntry\s*\(/, 'runCheck 必须经这一家写回');
  assert.ok(!/entry\.lastSeenIds\s*=/.test(body),
    '裸写快照就是 D2 的那只手：一旦允许，就总有分支（比如空清单）忘记它');
  assert.ok(!/entry\.lastCheckError\s*=\s*['"]['"]/.test(body),
    '"先清错误再判定"就是 D1/D3 的成因；复位只许发生在真拿到清单那次');
  assert.equal((src.match(/applyCheckToEntry\s*\(/g) || []).length, 2,
    '一处定义 + 一处调用：多出一处调用 = 第二份判定口径，回潮只是时间问题');
  assert.match(body, /toEnqueue/, '自动入队名单必须来自同一次判定');
});

test('错误文案仍走渲染层已有的那张嘴（lastCheckError 在瘦身视图与卡片里都还活着）', () => {
  const src = read('src/main/subscriptions.js');
  assert.match(src, /lastCheckError:\s*e\.lastCheckError/, '_listView 若不再带这个字段，写了也没人看得见');
  const view = read('src/renderer/js/views/subscriptions.js');
  assert.match(view, /e\.lastCheckError/, '卡片渲染错误的那一行是本增量的唯一出口，摘掉就等于没修');
});

test('本增量零新 IPC：订阅模块的 safeSend 通道清单不变', () => {
  const src = stripComments(read('src/main/subscriptions.js'));
  const chans = [...new Set([...src.matchAll(/safeSend\(\s*'([^']+)'/g)].map((m) => m[1]))];
  assert.deepEqual(chans, ['subscriptions-updated', 'queue-updated'],
    '多一个通道 = 主进程 + 契约 + preload 三处连锁，本增量不需要（后者是自动入队顺带推的队列刷新，早已存在）');
});
