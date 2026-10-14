/**
 * MCP 调用审计存储
 *
 * 钉四件事：① 写了能读回（最新在前）；② 容量封顶不无限增长；
 * ③ 敏感值绝不进磁盘（审计文件里搜得到「周杰伦」搜不到密钥 —— 前者是审计的
 * 可读性，后者一旦落盘就等于把计费凭证抄进一个不带加密的 JSON）；
 * ④ 并发读-改-写不丢条目、损坏文件不炸。②③④ 都是本仓历史事故的同族
 * （生成历史就是因为并发整文件覆盖丢过条目，损坏 JSON 曾经每次冷启动重复读+备份）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuditStore, summarizeArgs, SENSITIVE_ARG_RE } = require('../src/main/mcp/auditStore');

const tmpFile = (name = 'mcp-audit.json') =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-audit-')), name);

const mkEntry = (over = {}) => ({
  ts: 1, tool: 'search_music', source: 'agent', ok: true, ms: 10, argsKeys: ['keyword'], summary: '', ...over,
});

test('record→list：最新在前，字段原样读回', async () => {
  const store = createAuditStore({ filePath: tmpFile() });
  await store.record(mkEntry({ ts: 1, tool: 'search_music' }));
  await store.record(mkEntry({ ts: 2, tool: 'add_to_queue', ok: false, err: '平台无结果' }));
  const items = await store.list({ limit: 10 });
  assert.deepStrictEqual(items.map(i => i.tool), ['add_to_queue', 'search_music']);
  assert.strictEqual(items[0].err, '平台无结果');
  assert.strictEqual(items[0].source, 'agent');
});

test('容量封顶：超出丢最旧', async () => {
  const store = createAuditStore({ filePath: tmpFile(), maxEntries: 3 });
  for (let i = 0; i < 5; i++) await store.record(mkEntry({ ts: i, tool: `t${i}` }));
  assert.deepStrictEqual((await store.list({ limit: 99 })).map(i => i.ts), [4, 3, 2]);
});

test('list 的 limit 生效且不报错', async () => {
  const store = createAuditStore({ filePath: tmpFile() });
  for (let i = 0; i < 5; i++) await store.record(mkEntry({ ts: i }));
  assert.strictEqual((await store.list({ limit: 2 })).length, 2);
  assert.strictEqual((await store.list({})).length, 5);
});

test('clear：清空后读为空，文件仍在（不留「读不到=没开过」的歧义）', async () => {
  const f = tmpFile();
  const store = createAuditStore({ filePath: f });
  await store.record(mkEntry());
  await store.clear();
  assert.deepStrictEqual(await store.list({ limit: 10 }), []);
  assert.ok(fs.existsSync(f), 'clear 应写空数组而不是删文件');
});

test('并发写入不丢条目', async () => {
  const store = createAuditStore({ filePath: tmpFile(), maxEntries: 50 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.record(mkEntry({ ts: i, tool: `t${i}` }))));
  assert.strictEqual((await store.list({ limit: 100 })).length, 20);
});

test('损坏的审计文件：按空处理，后续写入照常', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ 半截', 'utf8');
  const store = createAuditStore({ filePath: f });
  assert.deepStrictEqual(await store.list({ limit: 10 }), []);
  await store.record(mkEntry());
  assert.strictEqual((await store.list({ limit: 10 })).length, 1);
});

test('summarizeArgs：普通检索词留摘要，敏感键只留名', () => {
  const s = summarizeArgs({ keyword: '周杰伦 现场', aiMusicApiKey: 'mk-SECRET-123', page: 2 });
  assert.deepStrictEqual(s.argsKeys.slice().sort(), ['aiMusicApiKey', 'keyword', 'page']);
  assert.strictEqual(s.summary, '周杰伦 现场');
  assert.ok(!JSON.stringify(s).includes('mk-SECRET-123'), '敏感值不许出现在摘要产物里');
});

// 判据不能是「键名里含 key 就算敏感」：keyword 含 key，按那写法几乎每次搜索的
// 摘要都会被抹空，审计就退化成「有人调过 search_music，但不知道搜了什么」。
test('敏感判据按词段而非子串：keyword 不是敏感参数，ApiKey/token 是', () => {
  const { isSensitiveArg } = require('../src/main/mcp/auditStore');
  for (const k of ['keyword', 'songId', 'page', 'source', 'playlistId', 'q']) {
    assert.strictEqual(isSensitiveArg(k), false, `${k} 被误判成敏感参数，摘要会集体消失`);
  }
  for (const k of ['aiMusicApiKey', 'access_token', 'cookie', 'Authorization', 'sessionId', 'clientSecret']) {
    assert.strictEqual(isSensitiveArg(k), true, `${k} 必须判为敏感`);
  }
});

test('审计文件里搜不到敏感值（端到端一次）', async () => {
  const f = tmpFile();
  const store = createAuditStore({ filePath: f });
  const args = { cookie: 'SESSION=abc', q: '夜跑' };
  await store.record(mkEntry({ ...summarizeArgs(args), tool: 'search_music' }));
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('SESSION=abc'), 'Cookie 值不得落审计盘');
  assert.ok(raw.includes('夜跑'), '普通检索词应保留 —— 没有它的审计等于没用');
  assert.ok(SENSITIVE_ARG_RE.test('cookie'), '判据本身要能被单独钉住，防止将来误改');
});
