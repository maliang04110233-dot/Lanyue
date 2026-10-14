/**
 * 助手编排：纯函数 + 依赖注入（与 nlSearchService 同一模式，单测不触网）
 *
 * 这一层的存在理由有三条，每条都是一枚测试：
 *   ① 模型给的 JSON 经常带毛刺（解释文字、代码块）——解析必须容错，且解析失败
 *      要退成「把这段话当回复」而不是整轮报错（nlSearch 的兜底同构）；
 *   ② steps 是**执行指令**，工具名不在白名单里就必须丢掉，不能等到执行时才拒；
 *   ③ 历史与工具结果会吃 token，裁剪规则要长在纯函数里，不能散在界面里。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildSystemPrompt, parseAssistantReply, planAssistantTurn, trimHistory, formatToolResults,
  MAX_STEPS_PER_TURN,
} = require('../src/api/services/aiAssistantService');
const { toolsFromContract } = require('../src/main/mcp/tools');

const TOOLS = toolsFromContract();

test('系统提示带全部白名单工具名，且写明严格 JSON 协议', () => {
  const p = buildSystemPrompt(TOOLS);
  for (const t of TOOLS) assert.ok(p.includes(t.name), `提示里没有 ${t.name}`);
  assert.match(p, /"steps"/);
  assert.match(p, /只输出/);
});

test('解析：干净 JSON、带解释文字、带代码块三种毛刺都要能吃下', () => {
  const a = parseAssistantReply('{"reply":"帮你找","steps":[{"tool":"search_music","args":{"keyword":"夜跑"}}]}');
  assert.strictEqual(a.reply, '帮你找');
  assert.strictEqual(a.steps.length, 1);

  const b = parseAssistantReply('好的！\n```json\n{"reply":"ok","steps":[]}\n```');
  assert.strictEqual(b.reply, 'ok');
  assert.deepStrictEqual(b.steps, []);

  // 解析不出 JSON ⇒ 整段当回复，steps 为空（功能不回归，用户至少看到话）
  const c = parseAssistantReply('我还不能理解这句话');
  assert.strictEqual(c.reply, '我还不能理解这句话');
  assert.deepStrictEqual(c.steps, []);
});

test('steps 里的非白名单工具、args 非对象、超上限都要被丢掉', () => {
  const fake = [
    { tool: 'rm_rf', args: {} },                       // 不在白名单
    { tool: 'search_music', args: '不是对象' },          // args 形状非法
    { tool: 'search_music', args: { keyword: 'a' } },
    { tool: 'get_lyrics', args: { id: '1' } },
    { tool: 'list_platforms', args: {} },
    { tool: 'history_stats', args: {} },
    { tool: 'source_health', args: {} },                // 第 5 个 → 截断
  ];
  const r = parseAssistantReply(JSON.stringify({ reply: 'x', steps: fake }));
  assert.strictEqual(r.steps.length, MAX_STEPS_PER_TURN);
  assert.deepStrictEqual(r.steps.map(s => s.tool), ['search_music', 'get_lyrics', 'list_platforms', 'history_stats']);
});

test('trimHistory：只留末尾 N 条，且首条必须是 user（孤立的工具结果开头会让模型误读）', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: i % 3 === 0 ? 'user' : 'assistant', content: i === 25 ? '{"tool_results":[]}' : `m${i}` });
  }
  const out = trimHistory(msgs, 6);
  assert.ok(out.length <= 6);
  assert.strictEqual(out[0].role, 'user');
  assert.ok(!out[0].content.startsWith('{"tool_results"'), '开头不该是一条工具结果');
});

test('formatToolResults：结果作为一条 user 消息回喂，单条截断到上限', () => {
  const m = formatToolResults([
    { tool: 'search_music', ok: true, text: 'x'.repeat(9000) },
    { tool: 'get_lyrics', ok: false, text: 'boom' },
  ]);
  assert.strictEqual(m.role, 'user');
  const parsed = JSON.parse(m.content);
  assert.strictEqual(parsed.tool_results.length, 2);
  assert.ok(parsed.tool_results[0].text.length <= 4000);
  assert.strictEqual(parsed.tool_results[1].ok, false);
});

test('planAssistantTurn：注入假 chat，跑通「系统提示 + 历史 + 解析」全链', async () => {
  let got = null;
  const r = await planAssistantTurn({
    messages: [{ role: 'user', content: '来点夜跑的歌' }],
    tools: TOOLS,
    chat: async (m) => {
      got = m;
      return '{"reply":"找好了","steps":[{"tool":"search_music","args":{"keyword":"夜跑 中文"}}]}';
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reply, '找好了');
  assert.strictEqual(got[0].role, 'system');
  assert.strictEqual(got[1].content, '来点夜跑的歌');
});

test('planAssistantTurn：chat 抛错时回 ok:false 且不吞掉原因的长度上限', async () => {
  const r = await planAssistantTurn({
    messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
    chat: async () => { throw new Error('401 unauthorized'); },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /401/);
  assert.ok(r.error.length <= 200);
});

test('planAssistantTurn：空历史直接回 EMPTY，不出网（省一次计费）', async () => {
  let called = 0;
  const r = await planAssistantTurn({ messages: [], tools: TOOLS, chat: async () => { called++; return '{}'; } });
  assert.deepStrictEqual(r, { ok: false, error: 'EMPTY' });
  assert.strictEqual(called, 0);
});
