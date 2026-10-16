/**
 * 「哪些工具是写操作」的登记表
 *
 * 助手（轨道二）与外部 Agent（轨道一）共用同一张工具表白名单，但助手多一条规矩：
 * 写操作必须用户点过确认才放行。这条规矩的地基是登记表的 risk 分层
 * （mutating 由它派生，不再手写），
 * 所以它必须在**工具表**里，而不是在助手里另写一份工具名清单 ——
 * 两份清单迟早漂移成「助手以为要确认、其实不用」或反过来。
 */
const test = require('node:test');
const assert = require('node:assert');

const { AGENT_TOOLS, MUTATING_TOOL_NAMES, toolsFromContract } = require('../src/main/mcp/tools');
const { createMcpHandler } = require('../src/main/mcp/mcpCore');

// P2 后「会让外部世界发生变化」的动作 = 13 条 write + 7 条 destructive，增删都要先想清楚
const EXPECTED = [
  'add_playlist_to_downloads', 'add_to_playlist', 'add_to_queue', 'cancel_download',
  'clear_all_downloads', 'clear_finished_downloads', 'clear_history', 'delete_download_template',
  'delete_user_playlist', 'remove_from_playlist', 'remove_history', 'remove_queue_item',
  'reorder_queue_item', 'retry_download', 'save_download_template', 'set_download_queue_paused',
  'subscribe_add', 'subscribe_mark_seen', 'toggle_favorite', 'unsubscribe',
];

test('非只读恰好 20 条：risk 分层与 MUTATING_TOOL_NAMES 必须是同一份事实', () => {
  assert.deepStrictEqual([...MUTATING_TOOL_NAMES].sort(), EXPECTED.slice().sort());
  const flagged = AGENT_TOOLS.filter(t => t.risk !== 'read').map(t => t.name).sort();
  assert.deepStrictEqual(flagged, EXPECTED.slice().sort(), 'risk 与集合必须是同一份事实');
  for (const n of EXPECTED) {
    assert.ok(AGENT_TOOLS.some(t => t.name === n), `${n} 不在白名单里却被标成写操作`);
  }
  // 查询类一律只能是 read：漂成 write 就是给助手凭空加确认负担
  for (const t of AGENT_TOOLS) {
    if (!EXPECTED.includes(t.name)) assert.strictEqual(t.risk, 'read', `${t.name} 不该被标为写操作`);
  }
});

test('toolsFromContract 从 risk 派生 mutating（渲染层与主进程读同一份，不各写一份清单）', () => {
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
