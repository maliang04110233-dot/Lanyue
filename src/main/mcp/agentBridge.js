/**
 * AI 调用方的进程内执行面（外部 Agent 与应用内助手共用）
 *
 * 一个桥 = 工具白名单 + 契约钳制 + 审计 + 「落到主进程 handler」四件事的装配点。
 * 装配只有一处，两个 caller 就不可能漂成两套规矩（助手的参数钳制比外部 Agent
 * 松、或者助手不写审计，都是这类漂移的实锤形态）。
 *
 * callTool 的 event 传 null：白名单里的 handler 均不依赖 sender（依赖 sender 的
 * 通道不进白名单，这条纪律由 test/ai-assistant-gate.test.js 的白名单钉兜住）。
 */

const { getInvokeHandler } = require('../ipc/register');
const { createMcpHandler } = require('./mcpCore');
const { toolsFromContract } = require('./tools');
const auditSink = require('./auditSink');

async function callTool(channel, args) {
  const fn = getInvokeHandler(channel);
  if (!fn) throw new Error(`通道未注册: ${channel}`);
  return fn(null, ...args);
}

/**
 * @param {Object} deps
 * @param {'agent'|'assistant'} deps.source 调用方身份，写进审计
 * @param {string} [deps.serverVersion]
 * @param {(entry:Object)=>void} [deps.onCall] 覆盖默认落点（HTTP 层要顺手数限流）
 */
function createAgentBridge({ source, serverVersion = '0.0.0', onCall = null }) {
  return createMcpHandler({
    tools: toolsFromContract(),
    callTool,
    source,
    serverVersion,
    onCall: onCall || ((entry) => { auditSink.record(entry); }),
  });
}

module.exports = { createAgentBridge, callTool };
