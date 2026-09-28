/**
 * 下载历史排序
 *   - src/shared/historySort.js —— 主进程 ORDER BY 白名单（注入面由构造消除）
 *   - src/renderer/js/historySort.js —— 档位循环与文案，键必须与白名单逐一对应
 *   - utils/history.query({sort}) —— 真 SQLite 验跨页排序语义
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HISTORY_SORTS, HISTORY_SORT_KEYS, resolveSortOrder, normalizeHistorySort } =
  require('../src/shared/historySort');

const freshEsm = (p) => import(`../${p}?ck=${Math.random()}`);

test('白名单：每个档位都是本模块内写死的 ORDER BY 片段，未知键回落最新在前', () => {
  assert.equal(resolveSortOrder('oldest'), 'seq ASC');
  assert.equal(resolveSortOrder('title'), HISTORY_SORTS.title);
  assert.ok(HISTORY_SORTS.title.includes('COLLATE NOCASE'), '曲名序该忽略大小写');
  assert.ok(HISTORY_SORTS.size.includes('json_extract'), '大小序取 data 里的 size 字段');
  // 每条片段都以 `, seq DESC` 收尾（除单调键外）→ 同值行顺序稳定，翻页不跳行
  for (const k of ['title', 'artist', 'size']) {
    assert.ok(HISTORY_SORTS[k].endsWith('seq DESC'), `${k} 缺稳定序兜底`);
  }
});

test('注入钉：把 SQL 片段当 sort 传进来也只能拿回默认序', () => {
  const evil = "seq DESC; DROP TABLE history; --";
  assert.equal(resolveSortOrder(evil), HISTORY_SORTS.recent);
  assert.equal(resolveSortOrder('__proto__'), HISTORY_SORTS.recent);
  assert.equal(resolveSortOrder(null), HISTORY_SORTS.recent);
  assert.equal(resolveSortOrder(undefined), HISTORY_SORTS.recent);
  assert.equal(resolveSortOrder(123), HISTORY_SORTS.recent);
  for (const raw of [evil, 'title; DELETE FROM assets', { sort: 'oldest' }]) {
    assert.ok(Object.values(HISTORY_SORTS).includes(resolveSortOrder(raw)), '输出必须落在白名单内');
  }
  assert.equal(normalizeHistorySort('recent'), 'recent');
  assert.equal(normalizeHistorySort('nope'), 'recent');
});

test('档位对账：渲染层循环表的键与主进程白名单一字不差（顺序也钉）', async () => {
  const { SORT_MODES, DEFAULT_SORT } = await freshEsm('src/renderer/js/historySort.js');
  assert.deepEqual(SORT_MODES, HISTORY_SORT_KEYS, '两侧档位漂移 = 按钮能选出主进程不认的键');
  assert.equal(DEFAULT_SORT, 'recent');
});

test('循环：末档回到首档，未知档位从首档继续，文案回落不抛', async () => {
  const { SORT_MODES, nextSortMode, sortLabel } = await freshEsm('src/renderer/js/historySort.js');
  assert.equal(nextSortMode('recent'), SORT_MODES[1]);
  assert.equal(nextSortMode(SORT_MODES[SORT_MODES.length - 1]), SORT_MODES[0]);
  assert.equal(nextSortMode('garbage'), SORT_MODES[0], '未知档 indexOf=-1 → 回落首档');
  assert.ok(sortLabel('size').includes('大小') || sortLabel('size').includes('更大'));
  assert.equal(sortLabel('garbage'), sortLabel('recent'), '未知档文案回落');
});

test('normalizeSortParam：默认档不进 opts，非法值静默丢弃', async () => {
  const { normalizeSortParam } = await freshEsm('src/renderer/js/historySort.js');
  assert.equal(normalizeSortParam('recent'), '');
  assert.equal(normalizeSortParam(''), '');
  assert.equal(normalizeSortParam(undefined), '');
  assert.equal(normalizeSortParam("seq DESC; --"), '');
  assert.equal(normalizeSortParam('oldest'), 'oldest');
});

test('buildHistoryQuery：sort 与关键词/状态/来源共存，默认序不发多余键', async () => {
  const { buildHistoryQuery } = await freshEsm('src/renderer/js/historyFilters.js');
  assert.deepEqual(buildHistoryQuery({ sort: 'recent' }, 0, 50), { limit: 50, offset: 0 });
  assert.deepEqual(
    buildHistoryQuery({ keyword: '晴', status: 'done', source: 'qq', sort: 'title' }, 2, 50),
    { limit: 50, offset: 100, keyword: '晴', status: 'done', source: 'qq', sort: 'title' },
  );
});

test('真库排序：oldest/title/artist/size 各得其所，默认与非法值仍最新在前', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-sort-'));
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  // 插入顺序 = seq 顺序：A 最早、B 中间、C 最新
  history.add({ id: 'a', source: 'qq', title: 'Beta', artist: 'zz', status: 'done', finishedAt: 1000, size: 10 });
  history.add({ id: 'b', source: 'qq', title: 'alpha', artist: 'aa', status: 'done', finishedAt: 2000, size: 30 });
  history.add({ id: 'c', source: 'qq', title: 'Gamma', artist: 'mm', status: 'error', finishedAt: 3000, size: 20 });

  const ids = (opts) => history.query(opts).items.map(s => s.id);
  assert.deepEqual(ids(), ['c', 'b', 'a'], '默认序不变（老调用方零感知）');
  assert.deepEqual(ids({ sort: 'oldest' }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ sort: 'title' }), ['b', 'a', 'c'], 'alpha < Beta < Gamma（忽略大小写）');
  assert.deepEqual(ids({ sort: 'artist' }), ['b', 'c', 'a']);
  assert.deepEqual(ids({ sort: 'size' }), ['b', 'c', 'a']);
  assert.deepEqual(ids({ sort: "seq ASC; DROP TABLE history; --" }), ['c', 'b', 'a'], '注入串回落默认序');
  assert.deepEqual(ids({ sort: 'title', limit: 2, offset: 2 }), ['c'], '排序 + 分页：第 2 页拿到末位行');
  assert.equal(history.query({ sort: 'size' }).total, 3);
});

test('接线钉：历史页有排序档位状态、按钮与查询透传，主进程走白名单', async () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const view = read(path.join('src', 'renderer', 'js', 'views', 'history.js'));
  assert.ok(view.includes("_historySort = nextSortMode(_historySort)"), '换档未走循环函数');
  assert.ok(view.includes('sort: _historySort'), '排序没进查询参数');
  assert.ok(view.includes('historySortBtn'), '按钮未渲染');
  assert.ok(/querySelectorAll\('button\[data-hst\]'\)/.test(view),
    '状态高亮仍扫全部 button —— 会把排序钮误标 active');
  const store = read(path.join('src', 'utils', 'history.js'));
  assert.ok(store.includes('ORDER BY ${orderBy}'), '主进程未接白名单');
  // 只钉「列表查询」那一条：_trim 的淘汰水位线本来就按 seq DESC 取，属另一语义
  assert.ok(!/SELECT data FROM history\$\{ws\} ORDER BY seq DESC/.test(store),
    '列表查询的硬编码 ORDER BY 复活');
  const palette = read(path.join('src', 'renderer', 'js', 'commandPalette.js'));
  assert.ok(palette.includes("'his-sort'"), '命令面板缺排序档位入口');
});
