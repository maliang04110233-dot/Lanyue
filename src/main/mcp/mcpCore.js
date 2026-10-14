/**
 * MCP JSON-RPC 2.0 核心（P1）—— 纯函数 + 依赖注入，单测不触网不碰 electron
 *
 * 只实现 MCP Streamable HTTP 的最小子集（对桌面端本地 Agent 足够）：
 *   initialize / notifications/* / ping / tools/list / tools/call
 * SSE 流式与 sampling 等高级能力刻意不做：工具结果都是一次性 JSON。
 *
 * callTool(channel, positionalArgs) 由 HTTP 层注入（最终落到 register.js
 * 的 handler 注册表）。工具执行失败按 MCP 约定回 isError:true 的内容而不是
 * 协议错误 —— 让 Agent 能把错误文本喂回模型继续对话。
 */

const { CHANNELS, normalizeArgs } = require('../../shared/ipcContract');
// 参数摘要（含「什么算敏感参数」的判据）只有 auditStore 一份实现：
// 协议层另写一遍就会漂移成两套规则，敏感值迟早从其中一套漏出去。
const { summarizeArgs } = require('./auditStore');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'musicdl';

/** 具名参数 → 契约位置参数（复用主进程同一套 normalizeArgs 钳制/拒绝逻辑） */
function namedToPositional(channel, namedArgs, channels = CHANNELS) {
  const specs = channels[channel] && channels[channel].args;
  const obj = (namedArgs && typeof namedArgs === 'object' && !Array.isArray(namedArgs)) ? namedArgs : {};
  if (!specs) return { ok: true, args: [] };
  const positional = specs.map(([name]) => obj[name]);
  return normalizeArgs(channel, positional);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(id, isError, text) {
  return rpcResult(id, { content: [{ type: 'text', text: String(text) }], isError });
}

/**
 * @param {Object} deps
 * @param {Array} deps.tools   toolsFromContract() 的产物（含 channel 内部字段）
 * @param {string} deps.serverVersion
 * @param {(channel:string, args:any[])=>Promise<any>} deps.callTool
 * @param {(entry:Object)=>void} [deps.onCall] 每次 tools/call 的审计回调（entry 见 auditStore）
 * @param {'agent'|'assistant'} [deps.source] 调用方身份：外部 Agent 还是应用内助手
 * @returns {(msg:Object) => Promise<Object|null>} JSON-RPC 分发；通知返回 null
 */
function createMcpHandler({ tools, serverVersion, callTool, onCall = null, source = 'agent' }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  // tools/list 面剔除内部字段（channel 不外泄给 Agent）
  const publicTools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  const brief = (s) => String(s == null ? '' : s).slice(0, 200);
  function audit(base, namedArgs, ok, err) {
    if (!onCall) return;
    const { argsKeys, summary } = summarizeArgs(namedArgs);
    onCall({ ...base, source, ok, argsKeys, summary, ...(err ? { err: brief(err) } : {}) });
  }

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
    }
    const { id = null, method, params } = msg;

    // 通知：有义务收到，无义务应答
    if (method.startsWith('notifications/')) return null;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: String(serverVersion || '0.0.0') },
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: publicTools });

      case 'tools/call': {
        const name = params && params.name;
        const tool = byName.get(name);
        if (!tool) return rpcError(id, -32602, `未知工具: ${String(name).slice(0, 64)}`);
        const base = { ts: Date.now(), tool: name };
        const named = params && params.arguments;
        const r = namedToPositional(tool.channel, named);
        if (!r.ok) {
          // 被契约拒掉的调用也是事实：审计里没有它，「有人试过但没权限」就查不到
          audit(base, named, false, r.error);
          return toolText(id, true, r.error);
        }
        let result;
        try {
          result = await callTool(tool.channel, r.args);
        } catch (e) {
          audit({ ...base, ms: Date.now() - base.ts }, named, false, e.message || e);
          return toolText(id, true, `工具执行失败: ${brief(e.message || e)}`);
        }
        const businessError = !!(result && typeof result === 'object' && result.error);
        audit({ ...base, ms: Date.now() - base.ts }, named, !businessError,
          businessError ? (result.error && result.error.message) || result.error : '');
        return toolText(id, businessError, JSON.stringify(result === undefined ? null : result));
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

module.exports = { createMcpHandler, namedToPositional, PROTOCOL_VERSION, SERVER_NAME };
