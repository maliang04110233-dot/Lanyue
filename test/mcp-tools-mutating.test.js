/**
 * 「哪些工具是写操作」的登记表
 *
 * 助手（轨道二）与外部 Agent（轨道一）共用同一张工具表白名单，但助手多一条规矩：
 * 写操作必须用户点过确认才放行。这条规矩的地基是「mutating 标记」，
 * 所以它必须在**工具表**里，而不是在助手里另写一份工具名清单 ——
 * 两份清单迟早漂移成「助手以为要确认、其实不用」或反过来。
 */
const test = require('node:test');
const assert = require('node:assert');

const { AGENT_TOOLS, MUTATING_TOOL_NAMES, toolsFromContract } = require('../src/main/mcp/tools');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');

// 这三个是红线内侧仅有的「会让外部世界发生变化」的动作，增删都要先想清楚
const EXPECTED = ['add_to_queue', 'add_to_playlist', 'toggle_favorite'];

test('mutating 标记恰好覆盖三个写操作，且都真的在白名单里', () => {
  assert.deepStrictEqual([...MUTATING_TOOL_NAMES].sort(), EXPECTED.slice().sort());
  const flagged = AGENT_TOOLS.filter(t => t.mutating).map(t => t.name).sort();
  assert.deepStrictEqual(flagged, EXPECTED.slice().sort(), '标记与集合必须是同一份事实');
  for (const n of EXPECTED) {
    assert.ok(AGENT_TOOLS.some(t => t.name === n), `${n} 不在白名单里却被标成写操作`);
  }
  // 查询类一律不得标 mutating：标了就是给助手凭空加确认负担，也说明登记表漂了
  for (const t of AGENT_TOOLS) {
    if (!EXPECTED.includes(t.name)) assert.ok(!t.mutating, `${t.name} 不该被标为写操作`);
  }
});

test('toolsFromContract 透传 mutating（渲染层与主进程读同一份，不各写一份清单）', () => {
  const tools = toolsFromContract();
  assert.strictEqual(tools.find(t => t.name === 'search_music').mutating, false);
  assert.strictEqual(tools.find(t => t.name === 'add_to_queue').mutating, true);
});

test('mutating 不外泄给 MCP tools/list（协议面只有 name/description/inputSchema）', async () => {
  const handle = createMcpHandler({
    tools: toolsFromContract(), serverVersion: '1.0.0', callTool: async () => ({}),
  });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  for (const t of r.result.tools) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'],
      `工具面多返回了字段: ${Object.keys(t)}`);
  }
});
