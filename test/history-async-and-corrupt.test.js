/**
 * 判活走异步（P2-9）与损坏历史自愈（P2-10）
 *
 * P2-9：findDownloaded 内部是 fs.existsSync，而它被放在**逐首循环**里
 *   （批量入队 download.js、订阅轮询 subscriptions.js）。网络盘/离线 NAS 上单次
 *   stat 可达数十毫秒，几百首批量会把主进程（= UI 线程）卡住一整轮 —— 而仓库自己
 *   的规矩就写着「主进程即 UI 线程：判活必须异步 stat」。
 *
 * P2-10：safeReadJson 遇到损坏只把它复制成 .bak，原名原样留着 ⇒ 每次冷启动都重演
 *   一遍「整文件读 + 复制」，坏文件与 .bak 长期共存，那段历史永远进不了库。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-async-'));
}

test('P2-9：findDownloadedAsync 与同步版语义一致（命中 / 文件已删自愈 / 无记录）', async () => {
  const dir = tmpDir();
  const history = freshHistory();
  const realFile = path.join(dir, 'song.mp3');
  try {
    history.init(dir);
    fs.writeFileSync(realFile, 'x');

    // 无记录
    assert.strictEqual(await history.findDownloadedAsync('nope', 'qq'), null);
    assert.strictEqual(history.findDownloaded('nope', 'qq'), null);

    // 命中
    history.add({ id: '1', source: 'qq', title: 'A', status: 'done', savePath: realFile });
    const hit = await history.findDownloadedAsync('1', 'qq');
    assert.ok(hit, '异步版应命中');
    assert.strictEqual(hit.savePath, realFile);
    assert.deepStrictEqual(
      Object.keys(hit).sort(), Object.keys(history.findDownloaded('1', 'qq')).sort(),
      '两版返回形状必须一致');

    // 文件已删 ⇒ 自愈（回收 assets 行，徽标与去重随之失效）
    fs.unlinkSync(realFile);
    assert.strictEqual(await history.findDownloadedAsync('1', 'qq'), null);
    assert.strictEqual(history.findDownloaded('1', 'qq'), null);
  } finally {
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-9（守卫钉）：入队/订阅路径一律不许用同步判活', () => {
  // 下载 IPC 已按域拆分：判活调用点在 queue.js，取流域单独守卫
  for (const rel of ['src/main/ipc/download.js', 'src/main/ipc/download/stream.js', 'src/main/ipc/download/queue.js', 'src/main/subscriptions.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/history\.findDownloaded\(/.test(src),
      `${rel} 仍在用同步判活 findDownloaded（应改用 findDownloadedAsync）—— `
      + '主进程即 UI 线程，网络盘上一次 stat 就够窗口卡一下');
  }
});

test('P2-10：损坏的 history.json 被隔离改名，.bak 保留，且第二次启动干净', () => {
  const dir = tmpDir();
  try {
    const jsonPath = path.join(dir, 'history.json');
    fs.writeFileSync(jsonPath, '{ 这是损坏的 json', 'utf8');

    let history = freshHistory();
    history.init(dir);
    try { history.destroy(); } catch (_e) { /* 忽略 */ }

    const quarantined = fs.readdirSync(dir).filter(n => n.startsWith('history.json.corrupt-'));
    assert.strictEqual(quarantined.length, 1,
      '损坏文件应被改名隔离，否则每次冷启动都重演读+备份');
    assert.ok(fs.existsSync(jsonPath + '.bak'), '.bak 必须保留（用户可手工抢救）');
    assert.strictEqual(fs.existsSync(jsonPath), false, '原名不该继续留着反复触发');

    // 隔离后原名已不存在 ⇒ 第二次启动既不再读它、也不再备份
    history = freshHistory();
    history.init(dir);
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
    const after = fs.readdirSync(dir);
    assert.strictEqual(after.filter(n => n.startsWith('history.json.corrupt-')).length, 1,
      '第二次启动不该再产生新的隔离文件（隔离没生效或被重复触发）');
    assert.ok(!after.includes('history.json'), '原名不该被重建');
    assert.ok(!after.includes('history.json.imported'),
      '损坏文件不该被当成可迁移的旧历史');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-10（对照）：合法 history.json 仍按旧约定改名 .imported，不被隔离', () => {
  const dir = tmpDir();
  try {
    const jsonPath = path.join(dir, 'history.json');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { id: '1', source: 'qq', title: '老历史', status: 'done' },
    ]), 'utf8');

    const history = freshHistory();
    history.init(dir);
    assert.ok(fs.existsSync(jsonPath + '.imported'), '合法文件应改名 .imported');
    assert.strictEqual(fs.existsSync(jsonPath), false);
    const rows = history.query({ limit: 10 }).items;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].title, '老历史');
    try { history.destroy(); } catch (_e) { /* 忽略 */ }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
