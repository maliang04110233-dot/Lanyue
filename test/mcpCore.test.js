/**
 * 单元测试：MCP Server 核心（AI_MUSIC_RESEARCH P1）
 *
 * 两层纯逻辑，全部不触网、不依赖 electron：
 *   1. tools.toolsFromContract —— 从 ipcContract 白名单派生 MCP 工具面（JSON Schema）
 *   2. mcpCore.createMcpHandler —— JSON-RPC 2.0 分发（initialize/tools/list/tools/call）
 *
 * 安全底线也钉在这里：工具清单必须是显式白名单，
 * cookie / 文件路径 / 对话框 / prefs 写入类通道一律不得出现在工具面。
 */

const test = require('node:test');
const assert = require('node:assert');

const { AGENT_TOOLS, toolsFromContract } = require('../src/main/mcp/tools');
const { createMcpHandler, namedToPositional } = require('../src/main/mcp/mcpCore');
const { CHANNELS } = require('../src/shared/ipcContract');

// ── 1. 工具面派生 ────────────────────────────────────

test('tools: 每个白名单通道都能派生出合法 MCP 工具定义', () => {
  const tools = toolsFromContract();
  assert.strictEqual(tools.length, AGENT_TOOLS.length);
  for (const tdef of tools) {
    assert.match(tdef.name, /^[a-z][a-z0-9_]*$/, `工具名应为 snake_case: ${tdef.name}`);
    assert.ok(tdef.description && tdef.description.length > 4, `缺描述: ${tdef.name}`);
    assert.strictEqual(typeof tdef.inputSchema, 'object');
    assert.strictEqual(tdef.inputSchema.type, 'object');
    // 声明的 required 必须在 properties 里存在
    for (const r of tdef.inputSchema.required || []) {
      assert.ok(tdef.inputSchema.properties[r], `${tdef.name}.required 引用了未声明参数 ${r}`);
    }
  }
});

test('tools: inputSchema 从契约参数规格派生（str→maxLength，int→default/max）', () => {
  const search = toolsFromContract().find(t => t.name === 'search_music');
  assert.ok(search, 'search_music 应在工具面中');
  assert.strictEqual(search.channel, 'search-music');
  const props = search.inputSchema.properties;
  assert.strictEqual(props.keyword.type, 'string');
  assert.strictEqual(props.keyword.maxLength, 200);
  assert.deepStrictEqual(search.inputSchema.required, ['keyword']);
  assert.strictEqual(props.page.type, 'integer');
  assert.strictEqual(props.page.default, 1);
});

test('tools: 白名单纪律——敏感/破坏性通道不得进工具面', () => {
  const banned = [
    'get-cookies', 'save-cookie', 'clear-cookie', 'open-login-window',
    'set-pref', 'delete-file', 'rename-file', 'write-local-lrc',
    'export-all-data', 'import-all-data', 'update-id3-tags',
    'restart-and-install', 'download-update', 'open-external', 'open-folder',
  ];
  // 且所有（有通道的）工具通道必须真的是主进程 invoke 通道。
  // audience:'app' 的渲染层能力没有 IPC 通道 —— 它们的 channel 是 null，不在本判据内。
  const channels = new Set(toolsFromContract().map(t => t.channel).filter((c) => c !== null));
  for (const b of banned) assert.ok(!channels.has(b), `${b} 不应暴露为 MCP 工具`);
  // 且所有工具通道必须真的是主进程 invoke 通道
  for (const ch of channels) {
    assert.ok((CHANNELS[ch]?.invoke || []).includes('main'), `${ch} 不是 main invoke 通道`);
  }
});

// ── 2. 具名参数 → 契约位置参数 ───────────────────────

test('namedToPositional: 按契约参数名展开并复用 normalizeArgs 的钳制', () => {
  const r = namedToPositional('search-music', { keyword: '周杰伦', source: 'qq', page: 3 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.args, ['周杰伦', 'qq', 3]);
  // 缺省 int 命中契约默认值；多余键被无视
  const r2 = namedToPositional('search-music', { keyword: 'x', bogus: 1 });
  assert.deepStrictEqual(r2.args, ['x', undefined, 1]);
  // 类型非法 → 契约原样拒绝（对象不是字符串）
  const r3 = namedToPositional('search-music', { keyword: { a: 1 } });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /keyword/);
});

// ── 3. JSON-RPC 分发 ─────────────────────────────────

function makeHandler(opts = {}) {
  const calls = [];
  const handler = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: '9.9.9',
    callTool: async (channel, args) => {
      calls.push({ channel, args });
      if (opts.throwOn) throw new Error('boom');
      return opts.result !== undefined ? opts.result : { songs: [{ id: '1', source: 'qq', title: 'A' }] };
    },
  });
  return { handler, calls };
}

test('rpc: initialize 返回协议版本 / 能力 / 服务信息', async () => {
  const { handler } = makeHandler();
  const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.strictEqual(r.id, 1);
  assert.ok(!r.error);
  assert.ok(r.result.protocolVersion);
  assert.ok(r.result.capabilities.tools);
  assert.strictEqual(r.result.serverInfo.name, 'musicdl');
  assert.strictEqual(r.result.serverInfo.version, '9.9.9');
});

test('rpc: notifications/* 无响应（返回 null）', async () => {
  const { handler } = makeHandler();
  const r = await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(r, null);
});

test('rpc: 未知方法 → -32601', async () => {
  const { handler } = makeHandler();
  const r = await handler({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.strictEqual(r.error.code, -32601);
});

test('rpc: tools/list 返回派生工具面', async () => {
  const { handler } = makeHandler();
  const r = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(Array.isArray(r.result.tools));
  assert.ok(r.result.tools.some(t => t.name === 'search_music'));
});

test('rpc: tools/call 成功——具名参数进 callTool，结果序列化进 content', async () => {
  const { handler, calls } = makeHandler();
  const r = await handler({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_music', arguments: { keyword: '晴天', source: 'all', page: 1 } },
  });
  assert.deepStrictEqual(calls, [{ channel: 'search-music', args: ['晴天', 'all', 1] }]);
  assert.strictEqual(r.result.isError, false);
  const payload = JSON.parse(r.result.content[0].text);
  assert.strictEqual(payload.songs[0].title, 'A');
});

test('rpc: tools/call 未知工具 → -32602 协议错误', async () => {
  const { handler, calls } = makeHandler();
  const r = await handler({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
  assert.strictEqual(r.error.code, -32602);
  assert.strictEqual(calls.length, 0);
});

test('rpc: 工具执行异常 / 契约参数非法 → isError:true 而不是断连', async () => {
  const { handler: h1 } = makeHandler({ throwOn: true });
  const r1 = await h1({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: 'x' } } });
  assert.strictEqual(r1.result.isError, true);
  assert.match(r1.result.content[0].text, /boom/);

  const { handler: h2 } = makeHandler();
  const r2 = await h2({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: { evil: 1 } } } });
  assert.strictEqual(r2.result.isError, true);
  assert.match(r2.result.content[0].text, /keyword/);
});

// ── 3. onCall 审计钩子 ───────────────────────────────

test('onCall：每次 tools/call 都产出一条审计（成功与业务失败都记）', async () => {
  const tools = [{
    name: 'search_music', channel: 'search-music',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } },
  }];
  const entries = [];
  const handler = createMcpHandler({
    tools, serverVersion: '1.0.0',
    callTool: async (channel, args) => (args[0] === 'boom' ? { error: '平台无结果' } : { songs: [] }),
    onCall: (e) => entries.push(e),
  });
  await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: '周杰伦' } } });
  await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: 'boom' } } });
  assert.strictEqual(entries.length, 2, '两次调用都要有记录');
  assert.strictEqual(entries[0].tool, 'search_music');
  assert.strictEqual(entries[0].ok, true);
  assert.strictEqual(entries[0].summary, '周杰伦');
  assert.deepStrictEqual(entries[0].argsKeys, ['keyword']);
  assert.strictEqual(entries[1].ok, false, '业务失败（isError）也是审计对象');
  assert.strictEqual(entries[1].source, 'agent');
});

test('onCall：未知工具不产审计，抛错要产 err 字段', async () => {
  const entries = [];
  const handler = createMcpHandler({
    tools: [{ name: 'get_lyrics', channel: 'get-lyrics', inputSchema: { type: 'object', required: ['id'], properties: { id: {} } } }],
    serverVersion: '1.0.0',
    callTool: async () => { throw new Error('网络不可达'); },
    onCall: (e) => entries.push(e),
  });
  await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.strictEqual(entries.length, 0, '工具名都不存在时无从审计');
  await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_lyrics', arguments: { id: '1' } } });
  assert.strictEqual(entries[0].ok, false);
  assert.match(entries[0].err, /网络不可达/);
});

test('onCall：契约参数校验失败不执行工具，也不该假装成功记账', async () => {
  const entries = [];
  let executed = 0;
  const handler = createMcpHandler({
    tools: [{ name: 'search_music', channel: 'search-music', inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } } }],
    serverVersion: '1.0.0',
    callTool: async () => { executed += 1; return {}; },
    onCall: (e) => entries.push(e),
  });
  const r = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_music', arguments: { keyword: { evil: 1 } } } });
  assert.strictEqual(r.result.isError, true);
  assert.strictEqual(executed, 0);
  assert.strictEqual(entries.length, 1, '被拒的调用同样是一次「有人试过」的事实');
  assert.strictEqual(entries[0].ok, false);
});
