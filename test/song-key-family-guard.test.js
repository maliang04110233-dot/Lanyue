/**
 * songKey 键族守卫（D-26）
 *
 * 本仓库有两套同名 songKey，服务不同用途：
 *   - 族 A（id + ':' + source）：曲库去重键，持久化在 playlists.json，跨文件共享
 *   - 族 B（source + U+241F + id）：跨源聚合的簇内临时键，不落盘
 *
 * 历史上因「同名工具函数各自实现」导致两族互不可比、_primary 恒 false、
 * 聚合推荐整体失效而单测全绿（P0）。修法是统一 handler 内的比较，
 * 而不是合并两族：合并会破坏 playlists.json 存量键，需要数据迁移。
 *
 * 本守卫钉死「族内唯一 + 族间不混用」，走真实模块导出，不 grep 源码。
 * P0 的 _primary 行为由 crossSourceAggregate-primary.test.js 覆盖，此处不重复。
 *
 * 故意变异时应红：
 *   1. 聚合模块 songKey 改用 A 族格式 => 族 B 键形状断言红
 *   2. 曲库侧任一处改分隔符 => 族 A 逐字兼容断言红
 *   3. 任一族被改成另一族格式 => 互不可替代断言红
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// 桩 Electron：ipc/playlist 依赖 ipcMain/app/safeStorage；safeStorage 可用
// 才能让 secretStore 进入非 insecure 态、cookieStore.set 正常落盘。
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-keyfam-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
      shell: { trashItem: async () => {}, showItemInFolder() {} },
    };
  }
  return originalLoad(request, parent, isMain);
};

const aggregate = require('../src/utils/crossSourceAggregate.js');
const syncMerge = require('../src/utils/syncMerge.js');
const ipcPlaylist = require('../src/main/ipc/playlist');

const A_SEP = ':';
const B_SEP = "␟"; // 族 B 分隔符 U+241F

const song = (id, source) => ({ id, source, title: "晴天", artist: "周杰伦", duration: 269000 });

test('族 B 键形状：source + U+241F + id，同 id 不同源必须不同', () => {
  const a = aggregate.songKey(song('1', 'netease'));
  const b = aggregate.songKey(song('1', 'qq'));
  assert.notStrictEqual(a, b, '跨源同 id 必须产出不同聚合键');
  assert.strictEqual(a, 'netease' + B_SEP + '1', '族 B 键形状漂移，实际 "' + a + '"');
  assert.strictEqual(b, 'qq' + B_SEP + '1', '族 B 键形状漂移，实际 "' + b + '"');
});

test('族 A 键逐字兼容：playlist.js 为权威实现', () => {
  assert.strictEqual(ipcPlaylist.songKey(song('1', 'netease')), '1:netease', '族 A 键格式漂移');
});

test('两族互不可替代：同一首歌产出不同键且互不含对方分隔符', () => {
  const s = song('1', 'netease');
  const ka = ipcPlaylist.songKey(s);
  const kb = aggregate.songKey(s);
  assert.notStrictEqual(ka, kb, '两族键必须不同，否则说明某族被误改成同一实现');
  assert.ok(ka.indexOf(B_SEP) === -1, '族 A 键不得含族 B 分隔符');
  assert.ok(kb.indexOf(A_SEP) === -1, '族 B 键不得含族 A 分隔符');
});

test('两族键在取值互换时不意外相等（防被混入同一 Set）', () => {
  const x = song('1', '2');
  const y = song('2', '1');
  assert.notStrictEqual(ipcPlaylist.songKey(x), aggregate.songKey(y));
  assert.notStrictEqual(ipcPlaylist.songKey(y), aggregate.songKey(x));
});

test('syncMerge 去重与族 A 逐字一致：同键歌不重复并入，异键保留', () => {
  // updatedAt 必须显式给出：相等时 mergePlaylists 取 local 侧，
  // 会让 older 整体落败、掩盖键格式问题。
  const newer = { id: 'pl-1', name: 'x', updatedAt: 200, songs: [song('1', 'netease')] };
  const older = { id: 'pl-1', name: 'x', updatedAt: 100, songs: [song('1', 'netease'), song('2', 'qq')] };
  // mergePlaylists(local[], remote[]) 收数组，不收单个歌单对象
  const merged = syncMerge.mergePlaylists([newer], [older]);
  const keys = (merged[0].songs || []).map((s) => ipcPlaylist.songKey(s));
  assert.strictEqual(new Set(keys).size, keys.length, '合并后不应出现重复曲库键');
  assert.ok(keys.includes('2:qq'), '不同源不同 id 的歌应保留');
  assert.ok(keys.includes('1:netease'), '同键歌应保留一份');
});
