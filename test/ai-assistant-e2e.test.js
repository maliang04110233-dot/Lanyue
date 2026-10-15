/**
 * 助手全链：目录 → 回合 → 确认闸门 → 桥执行 → 审计
 *
 * 为什么还要一枚 e2e：前面每层各自绿过（桥会审计、闸门会拒、服务会解析），
 * 「助手页真的走过这条链」却没人钉过 —— 轨道一的教训就是两层各自绿着、
 * 全链无人走过（见 test/mcp-e2e.test.js 的来由）。
 *
 * 这里不起渲染层（无 jsdom），用主进程的真实通道 handler：
 * register.js 的 handler 表在测试里手工灌一个假 search-music / add-to-queue，
 * 于是参数钳制、错误语义、审计形状全是真的，只有业务实现是假的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ── Electron 打桩（与 test/crossSourceAggregate-primary.test.js 同一套路）──
// ipc/register 顶部 require('electron')，纯 node 下拿到的是「二进制路径字符串」，
// ipcMain 是 undefined —— 不打桩的话 register.handle() 第一行就崩，
// 测试会误判成「助手没接上」而其实是装载失败。
// safeStorage 必须可用：aiMusicApiKey 是 SECRET_KEY，缺它就写不进 pref，
// 回合通道会一直回 NO_KEY，那是桩的问题不是接线的问题。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-e2e-el-'));
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => stubDir, getVersion: () => '1.0.0' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const register = require('../src/main/ipc/register');
const auditSink = require('../src/main/mcp/auditSink');
const assistant = require('../src/main/ipc/ai-assistant');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'asst-e2e-')); }

/**
 * 取「主进程内部复用」的那条路：getInvokeHandler 给的是**未包装**的原始 handler
 * （不经 ipcMain 的信封与 normalizeArgs）—— 助手的桥自己会做 normalizeArgs，
 * 所以这里要的就是原始 handler，等价于「渲染层 invoke 之后主进程真正跑的那段」。
 * 调用时首位传 null 当 event：白名单里的 handler 不依赖 sender。
 */
function handlerOf(ch) {
  const fn = register.getInvokeHandler(ch);
  if (!fn) throw new Error(`测试取不到 handler: ${ch}`);
  return (...args) => fn(null, ...args);
}

/**
 * 审计是 fire-and-forget（mcpCore 不等 onCall 的写盘 Promise），所以不能假设
 * 「工具调用返回 = 审计已落盘」。_enqueue 是串行的：此刻再排一条屏障记录并 await，
 * 屏障之前的写入必然都已落地 —— 比 setTimeout 猜时间确定得多。
 */
const BARRIER = '__flush_barrier__';
async function flushAudit() {
  await auditSink.store().record({ ts: 0, tool: BARRIER, source: 'test', ok: true });
  return (await auditSink.store().list({ limit: 50 })).filter(e => e.tool !== BARRIER);
}

assistant.register();

test('目录：21 个工具且恰好 3 个非只读（P1 只加只读面）', async () => {
  const r = await handlerOf('ai-assistant-tools')();
  assert.strictEqual(r.tools.length, 21);
  assert.deepStrictEqual(r.tools.filter(t => t.mutating).map(t => t.name).sort(),
    ['add_to_playlist', 'add_to_queue', 'toggle_favorite']);
  assert.deepStrictEqual(r.tools.filter(t => t.risk === 'destructive').map(t => t.name), [],
    'P1 不该出现 destructive');
});

test('闸门：写操作不带确认直接拒，带确认才落到 handler，且被拒的不进审计', async () => {
  auditSink._setUserDataDirForTest(tmpDir());
  let executed = 0;
  register.handle('add-to-queue', async () => { executed += 1; return { ok: true }; });

  const denied = await handlerOf('ai-assistant-tool-call')('add_to_queue', { song: { id: '1', title: 'x' } }, false);
  assert.deepStrictEqual(denied, { ok: false, error: 'NEED_CONFIRM' });
  assert.strictEqual(executed, 0, '被拒的调用不该执行');

  const allowed = await handlerOf('ai-assistant-tool-call')('add_to_queue', { song: { id: '1', title: 'x' } }, true);
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(executed, 1);

  const items = await flushAudit();
  assert.strictEqual(items.length, 1, '被拒的调用不进桥，因此审计只有一行');
  assert.strictEqual(items[0].source, 'assistant', '审计要分得出是谁干的');
  assert.strictEqual(items[0].tool, 'add_to_queue');
});

test('未知工具：令牌化拒绝，不碰桥', async () => {
  const r = await handlerOf('ai-assistant-tool-call')('delete_all_playlists', {}, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'UNKNOWN_TOOL');
});

test('参数钳制与外部 Agent 同一条码：超长 keyword 被截到 200', async () => {
  auditSink._setUserDataDirForTest(tmpDir());
  let seen = null;
  register.handle('search-music', async (_e, keyword) => { seen = keyword; return { songs: [] }; });
  const r = await handlerOf('ai-assistant-tool-call')('search_music', { keyword: 'K'.repeat(500) }, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.length, 200, '助手侧的钳制比外部 Agent 松 = 两套规矩');
});

test('没有 API Key：回合通道回 NO_KEY 且不出网', async () => {
  const prefs = require('../src/utils/prefs');
  prefs.set('aiMusicApiKey', '');
  const r = await handlerOf('ai-assistant-plan')([{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(r, { ok: false, error: 'NO_KEY' });
});

/**
 * 配置类令牌必须原样到界面：闸把端点拒了，用户要改的是配置页；
 * 报成 LLM_FAILED 的话，界面上是一句「请求失败」，而失败根本不在模型那侧。
 * 用 169.254.169.254（链路本地，云上是偷元数据那个地址）：IP 字面量不查 DNS，
 * 闸必然在出网前拒掉。
 *
 * 两处接线是本用例的一部分，不是铺垫：
 *   · setPrefsGetter —— 主进程在 ipc/ai-music 注册时注入，测试里不注入的话
 *     ai-music 落回 MiniMax 老端点，这条用例就变成打真网络（实测确实打过）；
 *   · 把 https.request 换成"打出去就抛"—— 闸若在链上被绕过，这里立刻红，
 *     而不是让"零出网"这件事悄悄靠外网条件成立。
 */
test('端点被闸拒：回合通道回 ENDPOINT_BLOCKED，不是 LLM_FAILED', async () => {
  const https = require('node:https');
  const prefs = require('../src/utils/prefs');
  const aiMusic = require('../src/api/ai-music');
  const realRequest = https.request;
  https.request = () => { throw new Error('LEAKED_OUTBOUND'); };
  aiMusic.setPrefsGetter((key) => prefs.get(key));
  prefs.set('aiProvider', 'deepseek');
  prefs.set('aiMusicApiKey', JSON.stringify({ deepseek: 'sk-e2e-not-a-real-key' }));
  prefs.set('aiProviderBaseUrl', 'https://169.254.169.254');
  try {
    const r = await handlerOf('ai-assistant-plan')([{ role: 'user', content: 'hi' }]);
    assert.deepStrictEqual(r, { ok: false, error: 'ENDPOINT_BLOCKED' });
  } finally {
    https.request = realRequest;
    aiMusic.setPrefsGetter(null);
    prefs.set('aiProviderBaseUrl', '');
    prefs.set('aiMusicApiKey', '');
  }
});
