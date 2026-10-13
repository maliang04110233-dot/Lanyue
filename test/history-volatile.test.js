/**
 * 降级为内存库时不得弄丢旧 history.json（2026-10-13 复审 P1-2）
 *
 * 旧实现里 _ensure() 无条件调 _importLegacy，而它成功后会 fs.renameSync
 * 把 history.json 改名成 .imported。当 DB 连续两次都打不开（userData 只读、
 * 杀软锁住 -wal、DB 损坏且备份重命名也失败）时，句柄已经退化成内存库：
 *
 *   内存库写入必然成功 → 改名照常发生 → 进程退出数据蒸发
 *   → 下次启动只剩空库 + 一个没人再读的 .imported ⇒ 历史永久消失。
 *
 * 也就是说：环境最差的时候，行为恰恰是最不可逆的。修复后这一态只记告警，
 * 旧文件原样留在磁盘上，等环境恢复（可写、锁解除）后仍能迁移。
 *
 * 本文件用「让 DatabaseSync 构造即抛错」模拟那个最差环境（node:sqlite 是
 * 内置模块，无需真的把 userData 设为只读）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * 让下一次 require('src/utils/history') 拿到一个「打开文件库必失败」的 DatabaseSync。
 *
 * 内存库必须放行：真实场景里退化的正是「文件库两次都失败 → 换成 :memory:」，
 * 而内存库本身总是开得了（否则就不是「降级」而是「彻底不可用」了）。
 */
function loadHistoryWithBrokenDb() {
  const sqlite = require('node:sqlite');
  const Orig = sqlite.DatabaseSync;
  sqlite.DatabaseSync = function PickyDatabaseSync(file) {
    if (typeof file === 'string' && file !== ':memory:') {
      throw new Error('mock: cannot open database file');
    }
    return new Orig(file);
  };
  delete require.cache[require.resolve(path.join(ROOT, 'src/utils/history'))];
  try {
    // 模块在加载时就把 DatabaseSync 解构进闭包，所以必须在 restore 之前 require
    return require(path.join(ROOT, 'src/utils/history'));
  } finally {
    sqlite.DatabaseSync = Orig;
  }
}

function freshHistory() {
  delete require.cache[require.resolve(path.join(ROOT, 'src/utils/history'))];
  return require(path.join(ROOT, 'src/utils/history'));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-volatile-'));
}

test('DB 打不开而退化为内存库时，旧 history.json 保持原样（不得改名）', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'history.json');
  const legacy = [{ id: '1', source: 'q', title: '老历史', status: 'done', savePath: 'D:/x.mp3' }];
  fs.writeFileSync(jsonPath, JSON.stringify(legacy), 'utf8');

  const history = loadHistoryWithBrokenDb();
  try {
    history.init(dir);
    assert.ok(fs.existsSync(jsonPath), '旧文件是磁盘上唯一的幸存副本，必须留着');
    assert.strictEqual(fs.existsSync(jsonPath + '.imported'), false,
      '这一态下改名等于永久删除历史（旧实现正是这里丢数据）');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), legacy,
      '不得改写旧文件内容');
    history.add({ id: '2', source: 'q', title: '新记录', status: 'done' });
    assert.ok(history.query({ limit: 10 }).items.length >= 1, '内存库仍应可读写');
  } finally {
    try { history.destroy(); } catch (_e) { /* mock 句柄可能已失效 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('对照组：DB 正常时迁移行为不变（成功导入并改名 .imported）', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'history.json');
  const legacy = [{ id: '1', source: 'q', title: '老历史', status: 'done' }];
  fs.writeFileSync(jsonPath, JSON.stringify(legacy), 'utf8');

  const history = freshHistory();
  try {
    history.init(dir);
    assert.ok(fs.existsSync(jsonPath + '.imported'), '正常路径仍应改名，避免下次重复迁移');
    assert.strictEqual(fs.existsSync(jsonPath), false, '原文件应已被改名');
    const rows = history.query({ limit: 10 });
    assert.strictEqual(rows.items.length, 1, '老历史应已进库');
    assert.strictEqual(rows.items[0].title, '老历史');
  } finally {
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
