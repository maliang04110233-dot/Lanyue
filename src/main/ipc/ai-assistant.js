/**
 * 应用内 AI 助手 IPC（轨道二）
 *
 * 三条通道 = 助手能做的事的全部面：
 *   ai-assistant-tools      目录（含 mutating），渲染层据此决定何时弹确认
 *   ai-assistant-plan       一次 LLM 回合（主进程出网，编排循环在渲染层）
 *   ai-assistant-tool-call  执行一个白名单工具，走与外部 Agent 同一条桥
 *
 * 为什么循环在渲染层：确认框只有 UI 拿得到。把它做成主进程↔渲染层的往返
 * （send 问、invoke 答、超时、孤儿请求）是拿三层新机制换一句「先问用户」，
 * 而闸门本身只需要一个布尔参数 —— 谁调都要确认，界面上的按钮只是它的来源。
 *
 * 错误一律回 ASCII 令牌：主进程不产文案，文案的家是渲染层词典（toast-i18n 的规矩）。
 */

const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { createAgentBridge } = require('../mcp/agentBridge');
const { toolsFromContract } = require('../mcp/tools');
const { planAssistantTurn } = require('../../api/services/aiAssistantService');
const { assistantChat } = require('../../api/ai-music');

// 桥是惰性的：第一次工具调用才装配，注册本身不起服务、不读令牌
let _bridge = null;
function _handle() {
  if (_bridge) return _bridge;
  _bridge = createAgentBridge({
    source: 'assistant',
    serverVersion: (() => {
      try { return require('electron').app.getVersion(); } catch (_e) { return '0.0.0'; }
    })(),
  });
  return _bridge;
}

function register() {
  handle('ai-assistant-tools', () => ({
    tools: toolsFromContract().map(({ name, description, mutating }) => ({ name, description, mutating })),
  }));

  handle('ai-assistant-plan', async (_, messages) => {
    const apiKey = prefs.get('aiMusicApiKey');
    if (!apiKey) return { ok: false, error: 'NO_KEY' };
    try {
      return await planAssistantTurn({
        messages: Array.isArray(messages) ? messages : [],
        tools: toolsFromContract(),
        chat: (m) => assistantChat({ messages: m, apiKey }),
      });
    } catch (e) {
      logger.warn('[assistant] 回合失败:', e && e.message ? e.message : e);
      return { ok: false, error: 'LLM_FAILED' };
    }
  });

  handle('ai-assistant-tool-call', async (_, name, args, confirmed) => {
    const tool = toolsFromContract().find(t => t.name === name);
    if (!tool) return { ok: false, error: 'UNKNOWN_TOOL' };
    // 闸门：写操作没有 confirmed===true 就不执行。确认来自界面，但判据在这里。
    if (tool.mutating && confirmed !== true) return { ok: false, error: 'NEED_CONFIRM' };
    const msg = await _handle()({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args && typeof args === 'object' ? args : {} },
    });
    if (msg && msg.error) {
      return { ok: false, error: 'TOOL_FAILED', text: String(msg.error.message || '').slice(0, 200) };
    }
    const result = msg && msg.result;
    const content = (result && result.content && result.content[0]) || null;
    const text = content ? String(content.text || '') : '';
    const isError = !!(result && result.isError);
    return { ok: !isError, isError, text: text.slice(0, 8000) };
  });
}

module.exports = { register, _bridgeForTest: _handle };
