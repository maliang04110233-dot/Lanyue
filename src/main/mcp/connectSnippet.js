/**
 * MCP 连接配置片段生成（纯函数）
 *
 * 为什么放在主进程侧而不是渲染层拼字符串：片段结构（url + Bearer 头 + mcpServers 键）
 * 是「揽乐作为被接入方」的契约的一部分，写错一个键名，用户的 Agent 就连不上，
 * 而渲染层没有任何测试能发现。这里可被 node --test 直接验证。
 *
 * 令牌来自 mcp-status（已加密存储、仅本机读取），片段只在渲染层临时展示与复制，
 * 不落任何盘 —— 令牌本身在设置页已可复制，复制片段不新增暴露面。
 */

'use strict';

const CLIENT_TEMPLATES = [
  { id: 'claude', label: 'Claude Desktop / Claude Code', hint: '粘贴进配置文件里的 mcpServers 段' },
  { id: 'cursor', label: 'Cursor', hint: '存成项目根目录的 .cursor/mcp.json' },
  { id: 'generic', label: '其它支持 MCP（Streamable HTTP）的客户端', hint: '找「添加 MCP Server / 自定义服务器」处粘贴' },
];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function buildConnectSnippet({ port, token, serverName = 'lanyue' }) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: '端口不合法' };
  if (!token) return { error: '尚未生成访问令牌，请先启用服务' };
  if (!NAME_RE.test(String(serverName))) return { error: '服务名只允许字母数字与 -_' };
  const obj = {
    mcpServers: {
      [String(serverName)]: {
        url: `http://127.0.0.1:${p}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return { text: JSON.stringify(obj, null, 2), servers: CLIENT_TEMPLATES.map(c => c.id) };
}

module.exports = { buildConnectSnippet, CLIENT_TEMPLATES };
