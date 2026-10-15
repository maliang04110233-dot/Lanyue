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
const { chatConfigFrom, isConfigToken } = require('../../api/aiProviders');
const { scrubToolText } = require('../../shared/outboundScrub');

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

  handle('ai-assistant-plan', async (_, messages, context) => {
    // 取的是「当前厂商那根 Key」，不是整包映射：映射里存着别家的凭据。
    // 界面只填了别家而选了 DeepSeek 时，这里必须照样报 NO_KEY —— 让它带着
    // 空串往下走，用户看到的是一句读不懂的「生成失败」。
    const { apiKey } = chatConfigFrom((k) => prefs.get(k));
    if (!apiKey) return { ok: false, error: 'NO_KEY' };
    try {
      return await planAssistantTurn({
        messages: Array.isArray(messages) ? messages : [],
        tools: toolsFromContract(),
        // 状态摘要由渲染层每回合现读（只有它有 getState），长度闸有两处、各管一段：
        // 契约 t.str(1600) 管运输，服务里那枚管提示拼装 —— 两个数是同一个，有钉守着。
        context,
        chat: (m) => assistantChat({ messages: m, apiKey }),
      });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : '';
      logger.warn('[assistant] 回合失败:', msg || e);
      // 配置类令牌（端点被闸拒、Key 没配、型号不合法）得原样递上去：把它们压成
      // LLM_FAILED，用户读到的是「请求失败」，而真正要改的是配置页。
      return { ok: false, error: isConfigToken(msg) ? msg : 'LLM_FAILED' };
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
    // 工具返回值是第二条出网路：它下一步就要进模型上下文，所以在本进程就剥干净，
    // 不留给渲染层「记得剥」这件事（它会）。外部 Agent 那条不剥——那是本机程序在读本机数据。
    const text = scrubToolText(content ? String(content.text || '') : '');
    const isError = !!(result && result.isError);
    return { ok: !isError, isError, text: text.slice(0, 8000) };
  });
}

module.exports = { register, _bridgeForTest: _handle };
