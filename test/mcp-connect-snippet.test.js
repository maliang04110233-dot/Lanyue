/**
 * MCP 连接配置片段
 *
 * 这一段 JSON 是「揽乐作为被接入方」的契约：键名写错一个字符，用户的 Agent 就连不上，
 * 而在渲染层拼字符串的话没有任何测试能发现。所以片段生成放在主进程侧、可被 node --test 直接跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildConnectSnippet, CLIENT_TEMPLATES } = require('../src/main/mcp/connectSnippet');

test('片段是可直接粘贴的 JSON，含 url 与 Bearer 头', () => {
  const r = buildConnectSnippet({ port: 39217, token: 'abc123' });
  assert.ok(!r.error);
  const parsed = JSON.parse(r.text);
  assert.deepStrictEqual(parsed.mcpServers.lanyue, {
    url: 'http://127.0.0.1:39217/mcp',
    headers: { Authorization: 'Bearer abc123' },
  });
});

test('无令牌时不给片段：宁缺不造一个连不上的配置', () => {
  for (const bad of ['', undefined, null]) {
    const r = buildConnectSnippet({ port: 39217, token: bad });
    assert.strictEqual(r.error, '尚未生成访问令牌，请先启用服务');
  }
});

test('端口非法同样拒绝（避免生成 127.0.0.1:NaN 这种配置）', () => {
  assert.ok(buildConnectSnippet({ port: 0, token: 'x' }).error);
  assert.ok(buildConnectSnippet({ port: 70000, token: 'x' }).error);
  assert.ok(buildConnectSnippet({ port: 'abc', token: 'x' }).error);
});

test('每张客户端模板都真的能被自己的片段喂饱（模板与片段同源）', () => {
  const r = buildConnectSnippet({ port: 39217, token: 'abc123' });
  for (const c of CLIENT_TEMPLATES) {
    assert.ok(r.text.includes('mcpServers'), `${c.id} 模板要求 mcpServers 键`);
    assert.ok(c.hint.length > 10, `${c.id} 模板要有落点说明`);
  }
  assert.ok(CLIENT_TEMPLATES.some(c => c.id === 'claude'), '至少覆盖 Claude 系');
  assert.ok(CLIENT_TEMPLATES.some(c => c.id === 'cursor'), '至少覆盖 Cursor');
});

test('serverName 可覆盖但必须过白名单字符（防注入到客户端配置里）', () => {
  assert.ok(JSON.parse(buildConnectSnippet({ port: 1, token: 'x', serverName: 'my_lanyue' }).text).mcpServers.my_lanyue);
  assert.ok(buildConnectSnippet({ port: 1, token: 'x', serverName: 'bad name/../x' }).error);
});
