/**
 * 守卫：007 判据② 播放会话快照与恢复
 *
 * 纯函数层（sessionSnapshotUsable）：可用性口径只有一家——
 *   队列非空 / idx 整数且在界内 / 7 天新鲜度 / 当前条目存在。
 *   boot 侧与任何未来消费方共用，不得各自另判（各判各的必然漂移）。
 * 接线层：player.js 三写点（换歌/暂停恢复/beforeunload）+ 瘦身纪律
 *   （cover/coverBase64 不得入 prefs）+ boot-restore 读回布状态不发声。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// ── 纯函数：sessionSnapshotUsable（从 player.js 源内联提取运行）──────
// player.js 是 ESM 且依赖 DOM/api，不能直接 require；把函数体抠出来在
// node:test 里跑（口径漂移由下面的接线钉兜底：源里必须真有同款函数）。
const PLAYER = read('src/renderer/js/player.js');
const fnSrc = PLAYER.match(/export function sessionSnapshotUsable\(sess, now = Date\.now\(\)\) \{[\s\S]*?\n\}/);
assert.ok(fnSrc, 'player.js 必须导出 sessionSnapshotUsable（boot 侧共用的可用性口径）');
const usable = new Function('SESSION_MAX_AGE_MS', `return (${fnSrc[0].replace('export ', '')});`)(7 * 24 * 3600 * 1000);

const NOW = Date.now();
const good = (over = {}) => ({ queue: [{ id: 1, source: 'nc' }, { id: 2, source: 'qq' }], idx: 1, at: NOW, ...over });

test('可用性：合法快照通过', () => {
  assert.strictEqual(usable(good()), true);
});

test('可用性：空队列 / idx 出界 / 非整数 / 当前条目缺失 一律拒绝', () => {
  assert.strictEqual(usable(good({ queue: [] })), false, '空队列');
  assert.strictEqual(usable(good({ idx: 2 })), false, 'idx 越上界');
  assert.strictEqual(usable(good({ idx: -1 })), false, 'idx 负数');
  assert.strictEqual(usable(good({ idx: 1.5 })), false, '非整数');
  assert.strictEqual(usable(good({ queue: [{ id: 1, source: 'nc' }] })), false, 'idx 指向被瘦身删掉的槽位后错位');
  assert.strictEqual(usable(null), false, 'null');
  assert.strictEqual(usable('x'), false, '非对象');
});

test('可用性：超过 7 天的快照过期（陈旧现场不如干净启动）', () => {
  assert.strictEqual(usable(good({ at: NOW - 8 * 24 * 3600 * 1000 })), false, '8 天前');
  assert.strictEqual(usable(good({ at: NOW - 6 * 24 * 3600 * 1000 })), true, '6 天前仍可用');
  assert.strictEqual(usable(good({ at: NaN })), false, 'at 缺失/非法');
});

// ── 接线钉 ────────────────────────────────────────────────

test('接线：player.js 三个写点齐备（换歌 / 暂停与恢复 / beforeunload）', () => {
  assert.match(PLAYER, /const SESSION_PREF_KEY = 'lastSession';/, '快照键名必须是字面量（白名单对账靠字面量扫描）');
  const hits = PLAYER.split('\n').filter((l) => l.includes('saveSessionSnapshot();')).length;
  assert.ok(hits >= 4, `saveSessionSnapshot() 调用点应 ≥4（loadAndPlay / 暂停 / 恢复 / beforeunload），实得 ${hits}`);
});

test('瘦身纪律：_slimSessionSong 白名单字段，cover 系字段绝不入快照', () => {
  const slim = PLAYER.match(/function _slimSessionSong\(s\) \{[\s\S]*?\n\}/);
  assert.ok(slim, '缺 _slimSessionSong');
  assert.ok(!/cover/.test(slim[0].replace(/coverBase64/, '')), '瘦身函数不得提及 cover（本地歌 base64 封面会把 prefs 撑爆）');
  for (const f of ['id', 'source', 'title', 'artist', 'duration', 'filePath']) {
    assert.ok(slim[0].includes(f), `瘦身必须保留 ${f}（恢复播放/取流/本地直连都要用）`);
  }
});

test('接线：boot-restore 读回布状态不发声，续播走 togglePlay 现成分支', () => {
  const boot = read('src/renderer/js/boot-restore.js');
  assert.match(boot, /getPref\('lastSession'\)/, 'boot 必须读 lastSession');
  for (const s of ["setState('playQueue'", "setState('playIdx'", "setState('currentPlaying'"]) {
    assert.ok(boot.includes(s), `boot 恢复必须布 ${s}`);
  }
  assert.match(boot, /布状态不发声|只布状态/, '「恢复为暂停态、不自动出声」的设计意图必须留在注释里');
  // 不许出现 boot 侧直接调 playSongByIdx/loadAndPlay 之类的自动续播
  assert.ok(!/playSongByIdx|loadAndPlay\(/.test(boot), 'boot 不得自动发声（自动续播是产品决策，未获裁决不得夹带）');
});

test('白名单：lastSession 已登记（prefs-key-reconciliation 的字面量对账面）', () => {
  const prefs = read('src/main/ipc/prefs.js');
  assert.ok(prefs.includes("'lastSession'"), "ALLOWED_PREF_KEYS 缺 lastSession ⇒ 死旋钮");
});

test('i18n：恢复提示双语在位', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  assert.ok(zh['playback.sessionRestored'] && zh['playback.sessionRestored'].includes('{title}'));
  assert.ok(en['playback.sessionRestored'] && en['playback.sessionRestored'].includes('{title}'));
});
