/**
 * 首页榜单「▶ 播放全部」
 *
 * 钉两件事：
 *   1. planSectionPlay 的取数语义（过滤词生效、保持原始顺序、截断标记）；
 *   2. 接线 —— 两个入口（分区卡片 + 完整榜单弹层）都指向 playAllHomeChart，
 *      且该函数真走共享计划器，而不是自己再写一遍 slice/filter。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// 渲染层是 ESM、测试是 CJS：cache-buster 保证每次跑都取到当前磁盘内容
const lib = () => import(`../src/renderer/js/homePlayAll.js?ck=${Math.random()}`);

const mk = n => Array.from({ length: n }, (_, i) => ({ id: String(i), title: `歌${i}`, artist: 'A' }));

test('空/脏输入不炸，返回空计划', async () => {
  const { planSectionPlay } = await lib();
  for (const bad of [undefined, null, 'x', {}, [null, undefined, 0]]) {
    const r = planSectionPlay(bad, '');
    assert.ok(Array.isArray(r.songs));
    assert.equal(r.total, r.songs.length);
    assert.equal(r.truncated, false);
  }
  assert.deepEqual(planSectionPlay(null, '').songs, []);
  assert.deepEqual(planSectionPlay([null, { id: 'ok', title: 't' }], '').songs, [{ id: 'ok', title: 't' }]);
});

test('过滤词生效且保持榜单原序（同 homeFilter 语义）', async () => {
  const { planSectionPlay } = await lib();
  const data = [
    { id: '1', title: '晴天', artist: '周杰伦' },
    { id: '2', title: '稻香', artist: '周杰伦' },
    { id: '3', title: '海阔天空', artist: 'Beyond' },
  ];
  assert.deepEqual(planSectionPlay(data, '周杰伦').songs.map(s => s.id), ['1', '2']);
  assert.deepEqual(planSectionPlay(data, '  BEYOND  ').songs.map(s => s.id), ['3']);
  assert.equal(planSectionPlay(data, '没有这首').total, 0);
  // 大小写/trim 与分区渲染同一函数，弹层与卡片不可能各说各话
  assert.deepEqual(planSectionPlay(data, '').songs.map(s => s.id), ['1', '2', '3']);
});

test('截断：入队上限生效并打上 truncated 标记', async () => {
  const { PLAY_ALL_LIMIT, planSectionPlay } = await lib();
  const data = mk(250);
  const r = planSectionPlay(data, '');
  assert.equal(r.songs.length, PLAY_ALL_LIMIT);
  assert.equal(r.total, 250);
  assert.equal(r.truncated, true);
  assert.equal(r.songs[0].id, '0'); // 取的是榜头，不是随机一段
  assert.equal(r.songs[PLAY_ALL_LIMIT - 1].id, String(PLAY_ALL_LIMIT - 1));

  const exact = planSectionPlay(mk(100), '', 100);
  assert.equal(exact.truncated, false); // 恰好等于上限不算截断
  assert.equal(exact.songs.length, 100);

  const filtered = planSectionPlay(mk(300).map((s, i) => ({ ...s, title: i % 2 ? '偶' : '奇' })), '偶', 10);
  assert.equal(filtered.songs.length, 10);
  assert.equal(filtered.total, 150); // total 是命中总量，供文案说「共 N 首」
});

test('limit 非法值回落全量（不会 slice(NaN) 出空队列）', async () => {
  const { planSectionPlay } = await lib();
  const data = mk(5);
  for (const bad of [0, -1, NaN, undefined, 'abc', null]) {
    const r = planSectionPlay(data, '', bad);
    assert.equal(r.songs.length, 5, `limit=${String(bad)} 应取全量`);
    assert.equal(r.truncated, false);
  }
});

test('文案：截断时明说只入了前 N 首', async () => {
  const { playAllToastText } = await lib();
  assert.equal(playAllToastText('热歌榜', 80, 80, false), '▶ 正在播放热歌榜（共 80 首）');
  assert.equal(playAllToastText('热歌榜', 100, 233, true), '▶ 正在播放热歌榜（共 233 首，已入前 100 首）');
});

// ── 接线 ──────────────────────────────────────────────

test('两个入口都接 playAllHomeChart，且函数走共享计划器', () => {
  const home = read('src/renderer/js/views/home.js');
  assert.ok(/from '\.\.\/homePlayAll\.js'/.test(home), '未导入 homePlayAll');
  assert.equal((home.match(/playAllHomeChart\('/g) || []).length, 2, '分区/弹层应各有一个入口');
  const fn = home.slice(home.indexOf('async function playAllHomeChart'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.length > 100, '未找到 playAllHomeChart 实现');
  assert.ok(body.includes('planSectionPlay(_getSection(sec), _homeFilterStr)'), '未复用计划器或未带过滤词');
  assert.ok(body.includes('closeHomeChartModal()'), '弹层未先关闭，遮罩会压在播放器上');
  assert.ok(body.includes("setState('playQueue', songs)"), '没有整单入队');
  assert.ok(body.includes('await loadAndPlay(songs[0])'), '没有从第一首开始播放');
  assert.ok(body.includes('playAllToastText'), '提示文案未走共享函数');
  assert.ok(!/filterHomeSection/.test(body), '不该在视图里自己过滤一遍');
  // 按钮文案：超过入队上限必须写「前 N 首」，不能谎报整榜都会播
  const list = home.slice(home.indexOf('function listHtml'), home.indexOf('function songRowsHtml'));
  assert.ok(list.includes('PLAY_ALL_LIMIT'), 'listHtml 未处理入队上限');
  assert.ok(/前 \$\{PLAY_ALL_LIMIT\}/.test(list), '超限文案未区分「前 N 首」');
  // 最近播放的既有入口不能被顺手改掉
  const recent = home.slice(home.indexOf('async function playAllRecent'));
  assert.ok(recent.slice(0, recent.indexOf('\n}\n')).includes('正在播放最近播放'), 'playAllRecent 被改写');
  assert.ok(home.includes('window.playAllHomeChart = playAllHomeChart;'), '缺全局桥接（onclick 调不到）');
  assert.ok(/^\s*playAllHomeChart,$/m.test(home), '缺 ES Module 导出');
});
