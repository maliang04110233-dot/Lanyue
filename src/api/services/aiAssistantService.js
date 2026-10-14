/**
 * 应用内 AI 助手编排（轨道二）—— 纯函数 + 依赖注入，单测不触网
 *
 * 协议刻意用「严格 JSON 的一段话」而不是厂商的 function-calling 字段：
 *   ① 现用的 MiniMax 兼容端点是否支持 tools/tool_responses 不在本仓控制范围，
 *      把它当**必需能力**写死 = 换个上游就整体失灵；
 *   ② 白名单校验、步数上限、参数钳制本来就在主进程那侧（契约 + 桥），
 *      JSON 协议让这些防线一处都不必搬；
 *   ③ 与 parseSearchQueries（P0-A 的关键词改写）同构，容错口径已有先例。
 *
 * 循环在渲染层：本模块只做「一次回合」——把历史喂给模型、拿回 reply 与 steps。
 */

const MAX_STEPS_PER_TURN = 4;
const MAX_HISTORY_MESSAGES = 20;
const MAX_RESULT_CHARS = 4000;

/** 工具目录 → 系统提示（名字、说明、参数键名都来自契约派生的同一份工具表） */
function buildSystemPrompt(tools) {
  const lines = (tools || []).map((t) => {
    const props = Object.entries((t.inputSchema && t.inputSchema.properties) || {})
      .map(([k, v]) => `${k}${v && v.type ? `:${v.type}` : ''}`);
    const req = ((t.inputSchema && t.inputSchema.required) || []).join(',');
    return `- ${t.name}(${props.join(', ')})${req ? ` 必填:${req}` : ''} —— ${t.description}`;
  });
  return `你是桌面音乐下载应用「揽乐」内置的助手，只能通过下列工具做事，不能编造歌曲 id / 歌单 id。

可用工具（名字必须完全一致，未列出的能力就是没有）：
${lines.join('\n')}

回答方式：只输出一个 JSON 对象，不要 markdown 代码块之外的任何解释文字。形如：
{"reply":"给用户看的一句话","steps":[{"tool":"search_music","args":{"keyword":"轻快 中文 晨跑"}}]}

规则：
- 不需要动手就 "steps":[]。
- 一次最多 ${MAX_STEPS_PER_TURN} 个 steps；拿不准先查后动。
- 查询类工具可以直接执行；加入队列、加入歌单、红心收藏这三类会改动用户的东西，主进程会逐条向用户请求确认，你照常提交即可。
- 用户没给具体歌手/歌名时，用 search_music 或 ai_search_music 找。
- reply 用中文，一句话说清你做了什么或需要什么信息，不要复述 JSON。`;
}

function _coerceSteps(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    if (!allowed.has(s.tool)) continue;            // 白名单外的指令在这里就消失
    if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) continue;
    out.push({ tool: String(s.tool), args: s.args });
    if (out.length === MAX_STEPS_PER_TURN) break;
  }
  return out;
}

/** 容错解析：整段 JSON → 抠第一个 {…} → 退化为纯文本回复 */
function parseAssistantReply(text) {
  const fallback = { reply: typeof text === 'string' ? text.trim() : '', steps: [] };
  if (typeof text !== 'string' || !text.trim()) return { reply: '', steps: [] };
  let obj = null;
  try {
    obj = JSON.parse(text.trim());
  } catch (_e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (_e2) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return fallback;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : (fallback.reply || '');
  return { reply, steps: _coerceSteps(obj.steps, ALLOWED_TOOL_NAMES) };
}

/** 只留末尾 max 条；若截出来的第一条不是用户话（孤立的工具结果开头会让模型把上下文读反）就丢掉 */
function trimHistory(messages, max = MAX_HISTORY_MESSAGES) {
  const list = Array.isArray(messages) ? messages.slice(-max) : [];
  while (list.length && (list[0].role !== 'user' || typeof list[0].content !== 'string'
    || list[0].content.startsWith('{"tool_results"'))) {
    list.shift();
  }
  return list;
}

/** 一轮执行结果回喂成一条 user 消息（协议里没有 tool role，就用用户口吻把 JSON 递回去） */
function formatToolResults(results, max = MAX_RESULT_CHARS) {
  return {
    role: 'user',
    content: JSON.stringify({
      tool_results: (results || []).map(r => ({
        tool: String(r.tool || ''),
        ok: r.ok === true,
        text: String(r.text || '').slice(0, max),
      })),
    }),
  };
}

/**
 * @param {Object} deps
 * @param {Array} deps.messages - 不含 system 的历史
 * @param {Array} deps.tools    - toolsFromContract() 的产物（name + inputSchema）
 * @param {(messages:Array)=>Promise<string>} deps.chat - 一次出网：messages → 模型文本
 */
async function planAssistantTurn({ messages, tools, chat }) {
  const history = trimHistory(messages);
  if (!history.length) return { ok: false, error: 'EMPTY' };
  const sys = { role: 'system', content: buildSystemPrompt(tools) };
  let text;
  try {
    text = await chat([sys, ...history]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  const { reply, steps } = parseAssistantReply(text);
  if (!reply && !steps.length) return { ok: false, error: 'EMPTY_REPLY' };
  return { ok: true, reply, steps };
}

// 校验面 = 真实工具白名单（单测与主进程读同一份，不各攒一份）。
// 做成入参会出现「测试传小表所以通过、生产传大表所以放行」的两套判据。
const { toolsFromContract } = require('../../main/mcp/tools');
const ALLOWED_TOOL_NAMES = new Set(toolsFromContract().map(t => t.name));

module.exports = {
  buildSystemPrompt, parseAssistantReply, planAssistantTurn, trimHistory, formatToolResults,
  MAX_STEPS_PER_TURN, MAX_HISTORY_MESSAGES, MAX_RESULT_CHARS,
};
