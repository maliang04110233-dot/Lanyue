/**
 * IPC 层测试：get-download-url-smart 的 options 透传
 *
 * 背景（2026-10-22，P0 换源参数化，见 docs/design/P0-fallback-params.md）：
 *   resolveTrackService 新增第三参 options，渲染层 → 主进程的 IPC 通道
 *   也要能传下去。本文件钉住三件事：
 *     1. 契约声明了 options 参数（形状校验走 t.obj()）
 *     2. handler 把 options 原样透传给 api.getDownloadUrlSmart
 *     3. handler 拒绝 onToggleSource 函数（跨进程传不了）并防住脏入参
 *
 * 沿用 test/mcp-e2e.test.js 的 electron 桩套路：register.js 顶部
 * require('electron')，纯 node 下拿到二进制路径字符串，不打桩就注册不进来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ── Electron 打桩 ────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-smart-url-'));
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: (name) => (name === 'userData' ? userDataDir : userDataDir), getVersion: () => '1.0.36' },
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

const register = require('../src/main/ipc/register');
const prefs = require('../src/utils/prefs');
prefs.init(userDataDir);

// 注册取流域的 handler（stream.js 的 register 函数）
require('../src/main/ipc/download/stream').register();

// 从 register 拿到原始 handler（不经 ipcMain）
const handler = register.getInvokeHandler('get-download-url-smart');
assert.ok(handler, 'get-download-url-smart 必须已注册');

// 记录 api.getDownloadUrlSmart 收到的调用，用于断言透传
const calls = [];

test('handler 把 options 原样透传给 api.getDownloadUrlSmart', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async (song, quality, options) => {
    calls.push({ song, quality, options });
    return { url: 'https://cdn/x.mp3', ext: 'mp3' };
  };
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    const opts = { allowToggleSource: false, isRefresh: true };
    const r = await handler(null, song, 'standard', opts);
    assert.ok(r && r.url, '应返回结果');
    assert.deepStrictEqual(calls[0].options, opts, 'options 必须原样到达 api 层');
    assert.strictEqual(calls[0].song.id, '1');
    assert.strictEqual(calls[0].quality, 'standard');
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('handler 不传 options 时传 undefined（零回归：旧调用方两参调用）', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async (song, quality, options) => {
    calls.push({ song, quality, options });
    return { url: 'https://cdn/x.mp3', ext: 'mp3' };
  };
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    await handler(null, song, 'standard');
    assert.strictEqual(calls[calls.length - 1].options, undefined, '旧调用方两参调用不应传 options');
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('handler 拒绝 onToggleSource 函数（跨进程传不了，且绝不放行）', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async (song, quality, options) => {
    calls.push({ song, quality, options });
    return { url: 'https://cdn/x.mp3', ext: 'mp3' };
  };
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    const fn = () => {};
    // IPC 实际传的是结构化克隆，函数会变成 null —— 但这里直接调 handler，
    // 传的是真实函数，handler 必须在第三道防线拦住它
    const opts = { allowToggleSource: true, onToggleSource: fn };
    const r = await handler(null, song, 'standard', opts);
    assert.ok(r && r.url, '取流本身仍应成功');
    // onToggleSource 绝不能出现在到达 api 层的 options 里
    const got = calls[calls.length - 1].options;
    assert.ok(got, 'allowToggleSource 保留时应有 options');
    assert.strictEqual(got.allowToggleSource, true);
    assert.ok(!('onToggleSource' in got), 'onToggleSource 绝不能透传');
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('handler 丢弃 onToggleSource 但保留其余合法键', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async (song, quality, options) => {
    calls.push({ song, quality, options });
    return { url: 'https://cdn/x.mp3', ext: 'mp3' };
  };
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    const opts = { allowToggleSource: true, isRefresh: true, onToggleSource: () => {} };
    await handler(null, song, 'standard', opts);
    const got = calls[calls.length - 1].options;
    assert.ok(got, 'allowToggleSource 保留时应有 options');
    assert.strictEqual(got.allowToggleSource, true);
    assert.strictEqual(got.isRefresh, true);
    assert.ok(!('onToggleSource' in got), 'onToggleSource 绝不能透传');
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('handler 处理脏入参：options 是 null/数组/垃圾值时不炸', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' });
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    for (const bad of [null, undefined, [], 'string', 42]) {
      const r = await handler(null, song, 'standard', bad);
      assert.ok(r && r.url, `options=${JSON.stringify(bad)} 时取流仍应成功`);
    }
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('handler 忽略非布尔的 allowToggleSource（脏值不污染语义）', async () => {
  const api = require('../src/api');
  const orig = api.getDownloadUrlSmart;
  api.getDownloadUrlSmart = async (song, quality, options) => {
    calls.push({ song, quality, options });
    return { url: 'https://cdn/x.mp3', ext: 'mp3' };
  };
  try {
    const song = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };
    const opts = { allowToggleSource: 'false', isRefresh: 'yes' };
    await handler(null, song, 'standard', opts);
    const got = calls[calls.length - 1].options;
    // 字符串值不是布尔 ⇒ 两个键都该被丢掉 ⇒ options 为 undefined
    // （不是 null：handler 必须传 undefined 才能让 service 层的默认参数生效）
    assert.strictEqual(got, undefined, '脏值应被丢弃而非当成 true/false');
  } finally {
    api.getDownloadUrlSmart = orig;
  }
});

test('契约声明了 get-download-url-smart 的 options 参数（形状校验走 t.obj()）', () => {
  const contract = require('../src/shared/ipcContract');
  const entry = contract.CHANNELS['get-download-url-smart'];
  assert.ok(entry, '通道必须存在');
  const argNames = entry.args.map((a) => a[0]);
  assert.deepStrictEqual(argNames, ['song', 'quality', 'options'], 'args 应含 options');
  assert.strictEqual(entry.args[2][1].k, 'obj', 'options 的规格必须是 t.obj()');
});

test('契约工具能正确校验 options 形状（不拒绝合法对象，不放过非对象）', () => {
  const contract = require('../src/shared/ipcContract');
  const { normalizeArgs } = contract;
  const ok = normalizeArgs('get-download-url-smart', [
    { id: '1' }, 'standard', { allowToggleSource: false },
  ]);
  assert.ok(ok.ok, '合法 options 应通过');
  assert.strictEqual(ok.args[2].allowToggleSource, false);

  const bad = normalizeArgs('get-download-url-smart', [
    { id: '1' }, 'standard', 'not-an-object',
  ]);
  // t.obj() 只做类型判定；字符串不是对象 ⇒ 应该不通过
  assert.ok(!bad.ok, '字符串 options 应被拒');
});
