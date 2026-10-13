/**
 * 导入的历史不许刚落地就被淘汰（2026-10-13 复审 P2-5）
 *
 * 旧实现给导入条目分配的是**当前最小 seq 往下递减**，而 _trim() 按
 * `ORDER BY seq DESC LIMIT MAX_ENTRIES` 保留最新 ⇒ 本机历史已满 5000 条时，
 * 刚导入的条目排在最旧一侧，导入结束后的 _trim 把它们**第一个**删掉，
 * 而 added 计数照加。于是同步页提示「下载历史：导入 N 条」，实际一条都没留下，
 * 而且用户完全无从察觉（下次同步还会再导一次、再丢一次）。
 *
 * 修复：导入条目排在当前最大 seq **之后**，被淘汰的只会是本机最旧的条目。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function freshHistory() {
  delete require.cache[require.resolve(path.join(ROOT, 'src/utils/history'))];
  return require(path.join(ROOT, 'src/utils/history'));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-import-'));
}

test('本机历史满额后导入的条目仍留在库里，且计数如实', () => {
  const dir = tmpDir();
  const history = freshHistory();
  const MAX = history.MAX_ENTRIES;
  try {
    history.init(dir);
    // 填满上限（add 的 seq 由 AUTOINCREMENT 递增，最后一条 seq 最大）
    for (let i = 0; i < MAX; i++) {
      history.add({ id: `old_${i}`, source: 'q', title: `旧记录 ${i}`, status: 'done' });
    }
    assert.strictEqual(history.query({ limit: 1 }).total, MAX, '前提：本机已满额');

    const incoming = Array.from({ length: 10 }, (_, i) => ({
      id: `new_${i}`, source: 'q', title: `导入记录 ${i}`, status: 'done',
    }));
    const added = history.importEntries(incoming);

    assert.strictEqual(added, 10, '计数必须等于导入条数');
    const titles = new Set();
    // 拉全部（含分页）确认 10 条都在
    for (let off = 0; off < MAX + 20; off += 500) {
      for (const row of history.query({ limit: 500, offset: off }).items) titles.add(row.title);
    }
    for (let i = 0; i < 10; i++) {
      assert.ok(titles.has(`导入记录 ${i}`),
        `导入记录 ${i} 不该在导入后立刻被 _trim 淘汰（旧实现就是这样丢数据的）`);
    }
  } finally {
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('导入的条目排在最新一侧（按默认排序出现在最前）', () => {
  const dir = tmpDir();
  const history = freshHistory();
  try {
    history.init(dir);
    history.add({ id: 'old', source: 'q', title: '旧记录', status: 'done', finishedAt: 1 });
    history.importEntries([{ id: 'new', source: 'q', title: '导入记录', status: 'done', finishedAt: 2 }]);
    const first = history.query({ limit: 1 }).items[0];
    assert.strictEqual(first.title, '导入记录',
      '导入条目应被视为「最新」，否则会被后续任何一次 trim 优先牺牲');
  } finally {
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
