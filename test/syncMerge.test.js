/**
 * 单元测试：utils/syncMerge.js — WebDAV 快照合并核心
 *
 * 跑：npm test（或 node --test test/syncMerge.test.js）
 *
 * 合并语义（对齐 lx/any-listen 的 snapshot + mergeFromSnapshot 思路）：
 *   - 歌单：按 id 并集；同 id 以 updatedAt 较新者为基底，
 *     另一方独有的歌曲按 songKey(id:source) 并进来（无墓碑，删除不跨设备传播）
 *   - 下载模板：按 id 并集；同 id updatedAt 新者胜
 *   - 历史记录：按 id+source 去重，finishedAt 新者胜，输出按 finishedAt 倒序
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  mergePlaylists, mergeTemplates, mergeHistory, mergeSnapshotData,
} = require('../src/utils/syncMerge');

const song = (id, source, title) => ({ id, source, title });

test('mergePlaylists: 双方独有歌单都保留', () => {
  const local = [{ id: 'a', name: '本地', songs: [], updatedAt: 10 }];
  const remote = [{ id: 'b', name: '远端', songs: [], updatedAt: 20 }];
  const r = mergePlaylists(local, remote);
  assert.deepStrictEqual(r.map(p => p.id).sort(), ['a', 'b']);
});

test('mergePlaylists: 同 id 取新者为基底 + 旧方独有歌曲并入', () => {
  const local = [{
    id: 'a', name: '本地新名', updatedAt: 100,
    songs: [song('1', 'qq', 'X'), song('2', 'qq', 'Y')],
  }];
  const remote = [{
    id: 'a', name: '远端旧名', updatedAt: 50,
    songs: [song('1', 'qq', 'X旧'), song('3', 'netease', 'Z')],
  }];
  const r = mergePlaylists(local, remote);
  assert.strictEqual(r.length, 1);
  // 元数据以较新的本地为基底
  assert.strictEqual(r[0].name, '本地新名');
  assert.strictEqual(r[0].updatedAt, 100);
  // 歌曲：本地两首保持原顺序与内容，远端独有的 Z 并进来；重叠的 1:qq 不重复不被旧值覆盖
  assert.deepStrictEqual(r[0].songs.map(s => `${s.id}:${s.source}:${s.title}`), [
    '1:qq:X', '2:qq:Y', '3:netease:Z',
  ]);
});

test('mergePlaylists: 同 id 同歌不同源不算重复', () => {
  const local = [{ id: 'a', updatedAt: 2, songs: [song('1', 'netease', 'N')] }];
  const remote = [{ id: 'a', updatedAt: 1, songs: [song('1', 'qq', 'Q')] }];
  const r = mergePlaylists(local, remote);
  assert.strictEqual(r[0].songs.length, 2);
});

test('mergePlaylists: updatedAt 相同以本地为准；脏输入按空处理', () => {
  const local = [{ id: 'a', name: 'L', updatedAt: 7, songs: [] }];
  const remote = [{ id: 'a', name: 'R', updatedAt: 7, songs: [] }];
  assert.strictEqual(mergePlaylists(local, remote)[0].name, 'L');
  assert.deepStrictEqual(mergePlaylists(null, undefined), []);
});

test('mergeTemplates: 按 id 并集，同 id updatedAt 新者胜', () => {
  const local = [
    { id: 't1', path: 'D:/new', updatedAt: 10 },
    { id: 't2', path: 'D:/onlyLocal', updatedAt: 5 },
  ];
  const remote = [{ id: 't1', path: 'D:/old', updatedAt: 3 }];
  const r = mergeTemplates(local, remote);
  assert.strictEqual(r.find(t => t.id === 't1').path, 'D:/new');
  assert.ok(r.some(t => t.id === 't2'));
});

test('mergeHistory: 按 id+source 去重取 finishedAt 新者，倒序输出', () => {
  const local = [
    { id: '1', source: 'qq', title: '新', status: 'done', finishedAt: 100 },
    { id: '2', source: 'qq', title: 'B', status: 'done', finishedAt: 50 },
  ];
  const remote = [
    { id: '1', source: 'qq', title: '旧', status: 'error', finishedAt: 30 },
    { id: '3', source: 'netease', title: 'C', status: 'done', finishedAt: 80 },
  ];
  const r = mergeHistory(local, remote);
  assert.deepStrictEqual(r.map(e => `${e.id}:${e.source}:${e.title}`), [
    '1:qq:新', '3:netease:C', '2:qq:B',
  ]);
});

test('mergeHistory: 同 id 不同源是两条记录', () => {
  const r = mergeHistory(
    [{ id: '1', source: 'qq', finishedAt: 1 }],
    [{ id: '1', source: 'netease', finishedAt: 2 }],
  );
  assert.strictEqual(r.length, 2);
});

test('mergeSnapshotData: 三类数据各走各的合并规则', () => {
  const local = {
    userPlaylists: [{ id: 'a', updatedAt: 1, songs: [] }],
    downloadTemplates: [{ id: 't1', updatedAt: 1 }],
    downloadHistory: [{ id: '1', source: 'qq', finishedAt: 1 }],
  };
  const remote = {
    userPlaylists: [{ id: 'b', updatedAt: 1, songs: [] }],
    downloadTemplates: [{ id: 't2', updatedAt: 1 }],
    downloadHistory: [{ id: '2', source: 'qq', finishedAt: 2 }],
  };
  const m = mergeSnapshotData(local, remote);
  assert.deepStrictEqual(m.userPlaylists.map(p => p.id).sort(), ['a', 'b']);
  assert.deepStrictEqual(m.downloadTemplates.map(t => t.id).sort(), ['t1', 't2']);
  assert.strictEqual(m.downloadHistory.length, 2);
  // 缺键按空处理
  const m2 = mergeSnapshotData({}, undefined);
  assert.deepStrictEqual(m2.userPlaylists, []);
});

// ── 外部数据 id 修复（2026-09 审计：恶意快照 id 直达渲染层 onclick → XSS）──

test('mergeTemplates: 远端快照中的非法 id 被修复为安全形式且条目保留', () => {
  const remote = [{ id: "a');alert(1);//", name: 'evil', path: 'D:/music', updatedAt: 2 }];
  const out = mergeTemplates([], remote);
  assert.strictEqual(out.length, 1);
  assert.doesNotMatch(String(out[0].id), /['";()]/, 'id 不得残留可注入 HTML/JS 的字符');
  assert.match(String(out[0].id), /^[A-Za-z0-9_-]+$/);
  assert.strictEqual(out[0].name, 'evil');
});

test('mergePlaylists: 本地+远端非法 id 同样修复，合法 id 原样保留', () => {
  const local = [{ id: 'ok_1', updatedAt: 1, songs: [] }];
  const remote = [{ id: '<script>', updatedAt: 1, songs: [] }];
  const m = mergePlaylists(local, remote);
  assert.ok(m.some(p => p.id === 'ok_1'), '合法 id 不应被改动');
  assert.ok(m.every(p => /^[A-Za-z0-9_-]+$/.test(String(p.id))), '所有 id 必须安全');
});

test('repairIds: 非对象条目过滤、非法 id 换成带前缀的安全 id 且互不重复', () => {
  const { repairIds } = require('../src/utils/syncMerge');
  const out = repairIds([null, 'str', { id: 12345 }, { id: 'x y' }, { id: 'x y' }], 'tpl');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].id, 12345, '纯数字 id 视为安全');
  const fixed = out.slice(1).map(t => t.id);
  assert.ok(fixed.every(id => /^tpl_fixed_[0-9a-f]{16}(_\d+)?$/.test(String(id))),
    '修复 id 形如 tpl_fixed_<哈希>（可选去重后缀）');
  assert.strictEqual(new Set(fixed).size, 2, '同一列表内的相同坏 id 不得撞车');
});

test('repairIds 确定性：同一坏 id 无论修几次都得到同一个新 id', () => {
  const { repairIds } = require('../src/utils/syncMerge');
  const first = repairIds([{ id: "a');alert(1);//" }], 'pl')[0].id;
  const second = repairIds([{ id: "a');alert(1);//" }], 'pl')[0].id;
  assert.strictEqual(first, second,
    '修复必须与「本进程此前修过什么」无关，否则 412 重试会把同一条目拆成两条');
});

test('P2-6：412 重试的二次合并不会把一个条目变成两个', () => {
  // 复现旧缺陷：首次合并修出 ..._seqA，冲突重试时远端仍是原始坏 id，
  // 再修出 ..._seqB，并集按 id 合并 ⇒ 一条变两条。
  const { mergePlaylists } = require('../src/utils/syncMerge');
  const bad = [{ id: "evil');x", name: '同一条', updatedAt: 5, songs: [] }];
  const afterFirst = mergePlaylists([], bad);              // 首次合并
  const afterSecond = mergePlaylists(afterFirst, bad);     // 412 后重合并（远端内容未变）
  assert.strictEqual(afterSecond.length, 1,
    '同一逻辑条目在重试合并后仍只有一条（旧实现会变成两条并持续扩散）');
});
