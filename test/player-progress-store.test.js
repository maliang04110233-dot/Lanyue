/**
 * 守卫：播放进度记忆的写者必须串行（第 2 条缺陷，口径 B）
 *
 * 问题
 * ----
 * savePlayProgress 是「读 → 改 → 整体写回」三步：
 *
 *     const map = await api.getPref('playProgressMap') || {};
 *     map[key] = { time, savedAt: Date.now() };
 *     await api.setPref('playProgressMap', map);
 *
 * 三个写者各自独立触发，都没有排队：30 秒自动保存（timeupdate）、暂停
 * （togglePlay）、播完写 0（onAudioEnded）。两次读改写交错时，后落地那次
 * 用的是自己那次读到的陈旧快照整体覆盖 —— 症状是「进度没记住」
 * 或「明明播完的歌又冒出进度」。
 *
 * 这里把写入收进一个串行队列：每一次读改写完成后才放下一次，
 * 于是「读」永远看到前一次「写」的结果。
 *
 * 为什么单独成文件
 * ----------------
 * player.js 顶层依赖 audioPlayer 元素与十余个 import，测试里拉不起来。
 * 队列本身不碰 DOM，注入一对假 prefs 就能真跑交错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProgressWriter } from '../src/renderer/js/player/progressStore.js';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const PLAYER = stripComments(read('src/renderer/js/player.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 假 prefs：模拟主进程那次 IPC 的真实形状 —— 取回的是一份拷贝（结构化克隆），
 * 写回是整体覆盖。latency 用来制造交错窗口。
 */
function fakePrefs({ map = null, memory = true, latency = 5 } = {}) {
  const store = { playProgressMemory: memory, playProgressMap: map };
  const stats = { writes: 0, reads: 0, failedWrites: 0 };
  return {
    store,
    stats,
    async getPref(key) {
      await sleep(latency);
      if (key === 'playProgressMap') {
        stats.reads += 1;
        return store.playProgressMap == null ? undefined : structuredClone(store.playProgressMap);
      }
      return store[key];
    },
    async setPref(key, value) {
      await sleep(latency);
      stats.writes += 1;
      if (key === 'playProgressMap') store.playProgressMap = structuredClone(value);
      else store[key] = value;
    },
  };
}

/** 不带队列的读改写：本文件的「控制组」，用来证明假 prefs 真能表达这个竞态 */
async function naiveSave(api, key, time, savedAt) {
  const map = (await api.getPref('playProgressMap')) || {};
  map[key] = { time, savedAt };
  await api.setPref('playProgressMap', map);
}

// ── 1. 控制组：竞态确实可复现 ─────────────────────────

test('控制组：不串行的两个写者并发，后落地的会用陈旧快照整体覆盖', async () => {
  const api = fakePrefs({ map: {} });
  await Promise.all([naiveSave(api, 'a:1', 100, 1), naiveSave(api, 'b:2', 200, 2)]);
  const keys = Object.keys(api.store.playProgressMap);
  assert.equal(keys.length, 1,
    '两次读改写若真的交错，只会剩一个 key —— 假 prefs 没能表达竞态，下面的判据就是假的');
  assert.ok(!keys.includes('a:1'), '先发起那次被后落地那次覆盖了（丢失更新）');
});

// ── 2. 队列：同样的并发必须两个 key 都在 ──────────────

test('串行队列：两个写者并发，各自的 key 都要留住', async () => {
  const api = fakePrefs({ map: {} });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await Promise.all([w.save('a:1', 100), w.save('b:2', 200)]);

  const map = api.store.playProgressMap;
  assert.deepEqual(Object.keys(map).sort(), ['a:1', 'b:2'], '丢更新又回来了');
  assert.equal(map['a:1'].time, 100);
  assert.equal(map['b:2'].time, 200);
  assert.equal(api.stats.writes, 2, '两次写都该落盘');
});

test('串行队列：同一个 key 后写覆盖前写（播完的 0 不得被更早的快照复活）', async () => {
  const api = fakePrefs({ map: { 'a:1': { time: 30, savedAt: 1 } } });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  // 30 秒自动保存与「播完写 0」几乎同时触发
  await Promise.all([w.save('a:1', 120), w.save('a:1', 0)]);
  assert.equal(api.store.playProgressMap['a:1'].time, 0,
    '队列若允许交错，先读后写的那次会把 0 顶回 120 —— 已播完的歌又冒出进度');
});

test('写入顺序按发起顺序落地（FIFO，不是谁先完成谁先写）', async () => {
  const api = fakePrefs({ map: {} });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  const t = [0, 0, 0].map((_, i) => w.save(`k${i}`, i * 10));
  await Promise.all(t);
  assert.deepEqual(
    Object.entries(api.store.playProgressMap).map(([k, v]) => [k, v.time]).sort(),
    [['k0', 0], ['k1', 10], ['k2', 20]],
  );
  const times = Object.values(api.store.playProgressMap).map((v) => v.savedAt);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'savedAt 应随发起顺序单调不减');
});

test('save 返回的 promise 在本次写入落地后才 resolve（调用方可等到自己那次）', async () => {
  const api = fakePrefs({ map: {}, latency: 20 });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  const p = w.save('solo', 66);
  assert.deepEqual(api.store.playProgressMap, {}, 'await 之前不该已经落盘');
  await p;
  assert.equal(api.store.playProgressMap.solo.time, 66);
});

// ── 3. 队列不能因为一次失败就死锁 ────────────────────

test('写盘抛错不得卡住队列：后续写入照常落地', async () => {
  const api = fakePrefs({ map: {} });
  let boom = true;
  const w = createProgressWriter({
    getPref: api.getPref,
    setPref: (k, v) => {
      if (boom) { boom = false; return Promise.reject(new Error('disk full')); }
      return api.setPref(k, v);
    },
  });
  await w.save('first', 10);
  assert.deepEqual(api.store.playProgressMap, {}, '首次写盘失败，不该有任何新增落下去');
  await w.save('second', 20);
  assert.equal(api.store.playProgressMap.second.time, 20, '队列被一次 reject 毒死了');
});

test('读盘抛错同样只吃掉这一次写入，队列继续', async () => {
  let first = true;
  const api = fakePrefs({ map: {} });
  const w = createProgressWriter({
    getPref: (k) => {
      if (first && k === 'playProgressMap') { first = false; return Promise.reject(new Error('ipc down')); }
      return api.getPref(k);
    },
    setPref: api.setPref,
  });
  await w.save('a', 1);
  await w.save('b', 2);
  assert.equal(api.store.playProgressMap.b.time, 2);
});

// ── 4. 记忆开关与容量 ────────────────────────────────

test('playProgressMemory 关闭时一个字都不写', async () => {
  const api = fakePrefs({ map: { old: { time: 5, savedAt: 1 } }, memory: false });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await w.save('a:1', 100);
  assert.equal(api.stats.writes, 0, '关了记忆还写盘，等于把用户清掉的进度又存回去');
  assert.deepEqual(api.store.playProgressMap, { old: { time: 5, savedAt: 1 } });
});

test('无记忆开关记录（undefined）按开启处理：与旧判据一致', async () => {
  const api = fakePrefs({ map: {} });
  api.store.playProgressMemory = undefined;
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await w.save('a:1', 100);
  assert.equal(api.store.playProgressMap['a:1'].time, 100);
});

test('首次写入时 prefs 里没有 playProgressMap（getPref 返回 undefined）', async () => {
  const api = fakePrefs({ map: null });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await w.save('a:1', 7);
  assert.deepEqual(Object.keys(api.store.playProgressMap), ['a:1']);
  assert.equal(api.store.playProgressMap['a:1'].time, 7);
});

test('超过 200 首时按 savedAt 裁到最新 200 条', async () => {
  const base = {};
  for (let i = 0; i < 200; i += 1) base[`k${i}`] = { time: i, savedAt: i + 1 };
  const api = fakePrefs({ map: base, latency: 0 });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await w.save('fresh', 999);
  const map = api.store.playProgressMap;
  assert.equal(Object.keys(map).length, 200, '裁完该正好留 200 条');
  assert.equal(map.fresh.time, 999, '新写的那条必须在');
  assert.equal(map.k0, undefined, 'savedAt 最小的那条该被挤掉');
  assert.equal(map.k1.time, 1, '只挤掉一条，第二旧的保留');
});

test('脏数据（savedAt 缺失）不得让裁剪抛错', async () => {
  const api = fakePrefs({ map: { junk: { time: 1 } }, latency: 0 });
  const w = createProgressWriter({ getPref: api.getPref, setPref: api.setPref });
  await w.save('a', 1);
  assert.ok(api.store.playProgressMap.a);
});

// ── 5. player.js 接线 ────────────────────────────────

test('player.js 的 savePlayProgress 走队列，不再自己读改写', () => {
  assert.match(PLAYER, /import\s*\{\s*createProgressWriter\s*\}\s*from\s*['"]\.\/player\/progressStore\.js['"]/);
  assert.match(PLAYER, /const _progressWriter = createProgressWriter\(/);
  const m = PLAYER.match(/function savePlayProgress\(song, time\)[\s\S]*?\n\}/);
  assert.ok(m, '没找到 savePlayProgress（结构变了要同步改这条钉子）');
  assert.match(m[0], /_progressWriter\.save\(/, 'savePlayProgress 要把写入交给队列');
  assert.ok(!/getPref\(\s*['"]playProgressMap['"]\s*\)/.test(m[0]),
    '函数体里还留着直接读快照 = 丢更新的老路');
  assert.ok(!/setPref\(\s*['"]playProgressMap['"]/.test(m[0]),
    '函数体里还留着直接整体写回');
});

test('player.js 三个写者仍都经 savePlayProgress 收口（不许绕过队列直写）', () => {
  const calls = PLAYER.match(/savePlayProgress\(/g) || [];
  // 定义处一次 + 30 秒自动保存、暂停、播完三个写者
  assert.equal(calls.length, 4, 'savePlayProgress 调用点应为 4（含定义），实际 ' + calls.length);
  const direct = PLAYER.match(/setPref\(\s*['"]playProgressMap['"]/g) || [];
  assert.deepEqual(direct, [], '渲染层再有第二处整体写回，队列就管不住了');
});

test('恢复读取（restorePlayProgress）不动：读路径没有竞态，加锁只会多一次 IPC', () => {
  const m = PLAYER.match(/async function restorePlayProgress\(song\)[\s\S]*?\n\}/);
  assert.ok(m, '没找到 restorePlayProgress');
  assert.match(m[0], /getPref\(\s*['"]playProgressMap['"]\s*\)/);
});
