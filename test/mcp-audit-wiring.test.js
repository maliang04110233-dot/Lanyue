/**
 * MCP 审计接线（静态守卫）
 *
 * ipc/mcp.js 依赖 electron，起不来真实现场，所以按本仓既有做法钉源码形状：
 * 漏接 onCall、漏声明契约、或者把审计文件塞进 WebDAV 导出，都会在这里变红 ——
 * 三者都是「实现完但没生效」的经典形态。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const MCP_IPC = read('src/main/ipc/mcp.js');
const CONTRACT = read('src/shared/ipcContract.js');
const CLOUD = read('src/main/ipc/cloudSync.js');
const AUDIT = read('src/main/mcp/auditStore.js');

test('createMcpHandler 收到 onCall，且摘要函数复用 auditStore（不许第二套判据）', () => {
  assert.match(MCP_IPC, /onCall:/, 'MCP 服务没接审计钩子 —— 审计文件永远为空');
  const core = read('src/main/mcp/mcpCore.js');
  assert.match(core, /require\('\.\/auditStore'\)/, '协议层没有复用 auditStore 的参数摘要');
  assert.ok(!/SENSITIVE_ARG_RE\s*=/.test(core), '协议层另写了一份敏感参数判据');
});

test('两条审计通道都在契约里，且 invoke 给 main', () => {
  for (const ch of ['mcp-audit', 'mcp-audit-clear']) {
    assert.match(CONTRACT, new RegExp(`'${ch}':\\s*\\{\\s*invoke:\\s*MAIN`), `${ch} 未声明进契约`);
    assert.match(MCP_IPC, new RegExp(`handle\\('${ch}'`), `${ch} 未注册 handler`);
  }
});

test('审计文件不进 WebDAV 快照/导出（可观测数据里含检索词，属本机隐私）', () => {
  assert.ok(!/mcp-audit/.test(CLOUD), 'cloudSync 里出现审计文件名 —— 它会被同步出去');
  assert.match(AUDIT, /SENSITIVE_ARG_RE/);
});

test('限流计数随 mcp-status 暴露给设置页', () => {
  assert.match(MCP_IPC, /rateLimited:\s*_rateLimited/);
  const statusIdx = MCP_IPC.indexOf('function _status()');
  assert.ok(statusIdx >= 0 && MCP_IPC.slice(statusIdx, statusIdx + 700).includes('rateLimited'));
});

test('连接片段（含令牌）不进审计与云同步', () => {
  assert.ok(!/mcp-connect-snippet/.test(CLOUD));
  // 只截 mcp-audit 这一条 handler 的函数体：片段 handler 里出现 buildConnectSnippet 是应该的，
  // 「不该出现」的是审计 handler 顺手把令牌一起返回 —— 那等于把凭证抄进可观测面。
  const start = MCP_IPC.indexOf("handle('mcp-audit'");
  assert.ok(start >= 0, 'mcp-audit handler 找不到，钉要重看');
  const body = MCP_IPC.slice(start, MCP_IPC.indexOf('\n  });', start));
  assert.ok(body.length > 0 && body.length < 900, 'mcp-audit 函数体切片不靠谱');
  assert.ok(!/connectSnippet/i.test(body), '审计通道顺手返回片段会把令牌带进可观测面');
});
