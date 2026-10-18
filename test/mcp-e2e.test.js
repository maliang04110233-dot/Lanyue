/**
 * MCP 端到端：真 HTTP + 真协议层 + 真工具表，只有最底层的 callTool 是假的
 *
 * 为什么这一层非补不可：mcpServer.test.js 用假 handleMessage 只测鉴权壳，
 * mcpCore.test.js 直接调 handler 不经过 HTTP —— 两层各自绿着，但**从未有一次测试
 * 走完 tools/list → tools/call → 参数钳制 → 审计落盘**这条真实通路。
 * 17 个工具的名字、契约参数、审计字段任何一处对不上，今天都没有地方会红。
 *
 * 修复轮 1（评审 F-3）追加的是**最后一段路**：同一个 boot() + tools/call 骨架，底换成
 * 生产那条 `agentBridge.callTool`（getInvokeHandler + fn(null, ...args)），于是 P1 新增的
 * 四条只读工具是打在真 IPC handler 表上的，不是被 mock 掉的。「四条能被桥调通」这件事
 * 从此有回归保护 —— Task 4/6 会动装配顺序，顺序一漂这里立刻红，而不是等用户在现场
 * 看到某条工具永远报「通道未注册」。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createMcpServer } = require('../src/main/mcp/mcpServer');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');
const { toolsFromContract, AGENT_TOOLS } = require('../src/main/mcp/tools');
const { createAuditStore, summarizeArgs } = require('../src/main/mcp/auditStore');

const TOKEN = 'e2e-token-0123456789abcdef';

// ── Electron 打桩：让真 IPC handler 进得来（评审 F-3 追加的那段路）────────
// 与 test/ai-assistant-e2e.test.js、test/downloadTemplatePreview.test.js 同一套路：
// register.js 顶部 require('electron')，纯 node 下拿到的是「二进制路径字符串」，
// ipcMain 是 undefined —— 不打桩就一条 handler 都注册不进来，测试会误判成「桥没接上」。
// safeStorage 一并给出：prefs 的凭证键写入缺它会被静默拒掉，那是一枚看不懂的假失败。
// 落盘一律在 os.tmpdir() 下：本文件不往用户真实配置里读写任何东西。
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-e2e-userdata-'));
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-e2e-music-'));
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: (name) => (name === 'userData' ? userDataDir : musicDir), getVersion: () => '1.0.36' },
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
// 生产那条底：getInvokeHandler(channel) + fn(null, ...args)（event=null 的桥语义
// 已由 test/mcp-agent-bridge.test.js / test/ai-assistant-e2e.test.js 钉住，这里照用）
const { callTool: realCallTool } = require('../src/main/mcp/agentBridge');
const prefs = require('../src/utils/prefs');
const cookieStore = require('../src/utils/cookieStore');
prefs.init(userDataDir);
cookieStore.init(userDataDir);
require('../src/main/ipc/subscriptions').register();
require('../src/main/ipc/downloadTemplates').register();
require('../src/main/ipc/playlist').register();
// 'load-play-queue' 的真实 handler 长在 src/main/index.js:789（Electron 主入口的 boot 里，
// 纯 node 测试装不进整个 index.js）。这里按 test/ai-assistant-e2e.test.js 的既有做法用
// register.handle 注入同一条，返回值形状对齐 index.js:790 的 `loadPersistedPlayQueue() || { queue: [] }`。
register.handle('load-play-queue', () => ({
  queue: [{ id: '77', source: 'netease', title: '稻香', artist: '周杰伦' }],
  playIdx: 0, loopMode: 'list', isShuffled: false, updatedAt: 1,
}));

/** 既有那套假底：只有两条 canned 通道，其余按「未注册」处理 */
async function fakeCallTool(channel) {
  if (channel === 'search-music') return { songs: [{ id: '1', title: '双截棍' }] };
  if (channel === 'get-lyrics') return { error: '该源无歌词' };
  throw new Error(`未注册通道: ${channel}`);
}

/**
 * @param {Object} [opts]
 * @param {(channel:string, args:any[]) => Promise<any>} [opts.callTool] 换底：默认假底，
 *   传 realCallTool 即打到上面注册进来的真 IPC handler（外部 Agent 生产链路用的就是它）
 */
async function boot({ callTool = fakeCallTool } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-e2e-'));
  const audit = createAuditStore({ filePath: path.join(dir, 'mcp-audit.json') });
  const seen = [];
  // 审计是 fire-and-forget：写盘不阻塞给 Agent 的应答（否则磁盘抖动会拖慢每次调用）。
  // 测试因此要显式 settle() 等落盘，而不是假设「响应回来 = 记录已写」。
  const pending = [];
  const handler = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: '1.0.36',
    source: 'agent',
    onCall: (e) => { pending.push(audit.record(e)); },
    callTool: async (channel, args) => {
      seen.push({ channel, args });
      return callTool(channel, args);
    },
  });
  const server = createMcpServer({ token: TOKEN, handleMessage: handler, onRejected: () => {} });
  const { port } = await server.start(0);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: server.stop, audit, seen, dir,
    settle: async () => { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}

const rpc = (url, id, method, params) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('e2e: initialize → tools/list 拿到白名单全量工具，且不外泄内部 channel 字段', async () => {
  const h = await boot();
  try {
    const i = await rpc(h.url, 1, 'initialize', { protocolVersion: '2025-03-26' });
    assert.strictEqual(i.status, 200);
    assert.strictEqual(i.body.result.serverInfo.name, 'musicdl');
    const l = await rpc(h.url, 2, 'tools/list', {});
    const tools = l.body.result.tools;
    // 这个 boot 直接喂 toolsFromContract() 的全量面（不过滤 destructive —— 它测的是
    // 协议层参数钳制与审计落盘，不是外部可见性；可见性由 agent-tool-registry 的
    // toolsForSource('agent') 钉着）。本 boot 喂的是全量面（P3 后 44 条），
    // 外部 Agent 实际看到的只有其中 31 条。
    assert.strictEqual(tools.length, AGENT_TOOLS.length, '工具数量与显式白名单不一致');
    assert.strictEqual(tools.length, 44, '白名单条目数变了 —— 先确认没有越红线扩面，再同步这条钉');
    assert.ok(tools.every(t => !('channel' in t)), 'channel 属内部字段，绝不能出现在 tools/list');
    assert.ok(tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
  } finally { await h.stop(); }
});

test('e2e: tools/call 成功 → 结果 JSON、isError=false、审计落盘一条', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 3, 'tools/call', { name: 'search_music', arguments: { keyword: '周杰伦', source: 'all', page: 1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.result.isError, false);
    assert.match(r.body.result.content[0].text, /双截棍/);
    await h.settle();
    await h.settle();
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].tool, 'search_music');
    assert.strictEqual(items[0].ok, true);
    assert.strictEqual(items[0].source, 'agent');
    assert.strictEqual(items[0].summary, '周杰伦');
    assert.ok(typeof items[0].ms === 'number');
  } finally { await h.stop(); }
});

test('e2e: 业务失败按 isError 回文本（Agent 能续对话），审计记 ok=false + err', async () => {
  const h = await boot();
  try {
    const r = await rpc(h.url, 4, 'tools/call', { name: 'get_lyrics', arguments: { id: '9' } });
    assert.strictEqual(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /该源无歌词/);
    await h.settle();
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items[0].ok, false);
    assert.match(items[0].err, /该源无歌词/);
  } finally { await h.stop(); }
});

test('e2e: 参数钳制走契约 —— 超长 keyword 被截断而不是原样落到 handler', async () => {
  const h = await boot();
  try {
    await rpc(h.url, 5, 'tools/call', { name: 'search_music', arguments: { keyword: 'x'.repeat(5000) } });
    const call = h.seen.find(s => s.channel);
    assert.ok(call, 'handler 没被调用');
    assert.ok(call.args[0].length <= 200, `契约里 keyword 是 t.str(200)，实到 ${call.args[0].length}`);
  } finally { await h.stop(); }
});

test('e2e: 洪水调用触发 429；协议方法不进审计', async () => {
  const h = await boot();
  try {
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(h.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'ping', params: {} }),
      });
      if (res.status === 429) rejected += 1;
    }
    assert.ok(rejected >= 1, `默认容量 120/秒，200 次连打应有拒绝，实为 ${rejected}`);
    await h.settle();
    assert.strictEqual((await h.audit.list({ limit: 10 })).length, 0, 'ping 不进审计');
  } finally { await h.stop(); }
});

test('e2e: 摘要判据与协议层用的是同一份（防第二套敏感参数规则）', () => {
  const s = summarizeArgs({ aiMusicApiKey: 'mk-xxx', keyword: '夜跑' });
  assert.strictEqual(s.summary, '夜跑');
  assert.ok(!JSON.stringify(s).includes('mk-xxx'));
});

// ── P1 新增四条只读工具：真实调用路径的取证（评审 F-3）──────────────────
// 这条 path 上没有任何一环是测试自造的：真 HTTP、真鉴权、真协议层、真登记表、真契约
// 钳制、真审计落盘，底是生产的 agentBridge.callTool，handler 是 ipc/*.js 里那几个真的。
const TPL_PATH = path.join(musicDir, '{artist}');

/** 订阅 / 下载模板 / 本地红心：三份数据都只写进临时 prefs（tmpdir 下） */
function seedLocalLibrary() {
  prefs.set('subscriptions', [{
    key: 'playlist:netease:3778975116', type: 'playlist', platform: 'netease',
    targetId: '3778975116', name: '周杰伦热门歌单', lastSeenIds: ['1'],
    lastCheckedAt: 1700000000000, lastCheckError: '', newSongs: [],
    autoDownload: false, addedAt: 1700000000000,
  }]);
  prefs.set('downloadTemplates', [{
    id: 'tpl_seed_1', name: '按歌手归档', path: TPL_PATH, subpath: '{artist}',
    createdAt: 1, updatedAt: 1,
  }]);
  prefs.set('activeDownloadTemplate', 'tpl_seed_1');
  prefs.set('userPlaylists', [{
    id: 'favorites', name: '收藏', system: true, songs: [
      { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000 },
      { id: '9', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 },
    ],
  }]);
}

test('e2e: P1 新增四条只读工具经真实 IPC handler 调通，出网文本与审计形状各归各', async () => {
  seedLocalLibrary();
  const h = await boot({ callTool: realCallTool });
  try {
    const cases = [
      ['list_subscriptions', {}, /周杰伦热门歌单/],
      ['list_download_templates', {}, /按歌手归档/],
      ['get_play_queue', {}, /稻香/],
      ['aggregate_library', { opts: { markDuplicates: true } }, /晴天/],
    ];
    const texts = {};
    for (let i = 0; i < cases.length; i++) {
      const [name, args, re] = cases[i];
      const r = await rpc(h.url, 20 + i, 'tools/call', { name, arguments: args });
      assert.strictEqual(r.status, 200, name);
      assert.ok(!r.body.error, `${name} 被回成协议错误: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.result.isError, false, `${name}: ${JSON.stringify(r.body.result)}`);
      texts[name] = r.body.result.content[0].text;
      assert.match(texts[name], re, `${name} 的出网文本里没有真 handler 的结果`);
    }
    // 四条各自落到登记表写的那条通道上（通道名来自 tools.js，不是这里写的）
    assert.deepStrictEqual(h.seen.map((s) => s.channel),
      ['subscribe-list', 'get-download-templates', 'load-play-queue', 'aggregate-cross-source'],
      '四条新工具指向的通道变了 —— 桥打到的不是主进程那个实现');
    // 聚合是真跑出来的：两条同曲跨源都保留，且恰好一条被选为代表条目
    const agg = JSON.parse(texts.aggregate_library);
    assert.strictEqual(agg.songs.length, 2, '跨源两条都该留在合并结果里');
    assert.strictEqual(agg.songs.filter((s) => s._primary === true).length, 1, '每簇恰好一个代表条目');
    assert.deepStrictEqual(agg.failed, [], '默认路径聚合本地红心，零网络');
    // 如实记录**今天**确实出网的字段（评审 F-C1）：脱敏闸是 Task 4 的活，在那之前
    // path/subpath 会原样进 content[0].text。Task 4 落地时这条连同 tools.js 里的描述
    // 一起改 —— 别让「已脱敏」这件事靠一句注释自证。
    const tpl = JSON.parse(texts.list_download_templates);
    assert.strictEqual(tpl.templates[0].path, TPL_PATH, '本机绝对路径今天仍原样出网（既成事实，非承诺）');
    assert.strictEqual(tpl.templates[0].subpath, '{artist}');
    assert.strictEqual(tpl.active, 'tpl_seed_1');

    await h.settle();
    const items = await h.audit.list({ limit: 10 });
    assert.deepStrictEqual(items.map((i) => i.tool),
      ['aggregate_library', 'get_play_queue', 'list_download_templates', 'list_subscriptions'],
      '审计是 unshift 语义：最新一条在最前');
    for (const it of items) {
      assert.strictEqual(it.source, 'agent');
      assert.strictEqual(it.ok, true, `${it.tool} 该记成功`);
      assert.strictEqual(typeof it.ts, 'number');
      assert.strictEqual(typeof it.ms, 'number');
      // summary 的口径与 search_music 那枚钉一致：只取第一个非敏感**字符串**参数的值。
      // 这四条要么无参、要么只收对象，所以恒为空 —— 参数值一个都不落盘。
      assert.strictEqual(it.summary, '', `${it.tool} 的 summary 不该有值`);
    }
    assert.deepStrictEqual(items.map((i) => i.argsKeys), [['opts'], [], [], []],
      'argsKeys 只记参数键名，不记值');
    // 落盘的原始文本里也不许出现参数值/结果值（含本机路径那一段）
    const rawAudit = fs.readFileSync(path.join(h.dir, 'mcp-audit.json'), 'utf8');
    for (const v of ['周杰伦热门歌单', '按歌手归档', '晴天', '稻香', '{artist}']) {
      assert.ok(!rawAudit.includes(v), `审计文本里出现了参数/结果值 ${v}`);
    }
  } finally { await h.stop(); }
});

test('e2e: aggregate_library 的 opts 传非对象 —— 按 MCP 约定回 isError 内容而不是协议错误，且审计落一条 ok=false', async () => {
  const h = await boot({ callTool: realCallTool });
  try {
    const r = await rpc(h.url, 31, 'tools/call', { name: 'aggregate_library', arguments: { opts: 'nope' } });
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.error, `契约拒绝不该升格成 JSON-RPC 错误: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /aggregate-cross-source/);
    assert.match(r.body.result.content[0].text, /应为对象/);
    assert.strictEqual(h.seen.length, 0, '被契约拒掉的调用不该落到 handler');

    await h.settle();
    const items = await h.audit.list({ limit: 5 });
    assert.strictEqual(items.length, 1, '被拒的调用也是事实，要进审计');
    assert.strictEqual(items[0].tool, 'aggregate_library');
    assert.strictEqual(items[0].source, 'agent');
    assert.strictEqual(items[0].ok, false);
    assert.deepStrictEqual(items[0].argsKeys, ['opts']);
    // 口径与 search_music 那枚同源：opts 不是敏感键名、传进来的是字符串，
    // 于是它的值进 summary（这里就是那句 'nope'）。审计要能回答「它试了什么」。
    assert.strictEqual(items[0].summary, 'nope');
    assert.match(items[0].err, /应为对象/);
  } finally { await h.stop(); }
});
