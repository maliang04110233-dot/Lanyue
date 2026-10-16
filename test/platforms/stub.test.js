/**
 * 桩平台测试 — 验证测试基础设施本身
 *
 * 确保 platformStub 辅助工具工作正常，为后续平台测试提供可靠基础。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createPlatformStub,
  createPlatformStubs,
  mockRequest,
  mockCookieStore,
  assertValidManifest,
} = require('../helpers/platformStub.js');

// ── createPlatformStub ──────────────────────────────────

test('createPlatformStub: 创建默认桩平台', () => {
  const stub = createPlatformStub();
  assert.strictEqual(stub.id, 'test-platform');
  assert.strictEqual(stub.name, 'Test Platform');
  assert.deepStrictEqual(stub.hosts.origins, ['example.com']);
  assert.strictEqual(typeof stub.search, 'function');
  assert.strictEqual(typeof stub.getUrl, 'function');
});

test('createPlatformStub: 覆盖默认值', () => {
  const stub = createPlatformStub({
    id: 'custom',
    name: 'Custom Platform',
    hosts: { origins: ['custom.com'] },
  });
  assert.strictEqual(stub.id, 'custom');
  assert.strictEqual(stub.name, 'Custom Platform');
  assert.deepStrictEqual(stub.hosts.origins, ['custom.com']);
});

test('createPlatformStub: 自定义 search 实现', async () => {
  const stub = createPlatformStub({
    search: async () => [{ id: '1', title: 'Test Song' }],
  });
  const result = await stub.search('test', 1, '');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, 'Test Song');
});

// ── createPlatformStubs ────────────────────────────────

test('createPlatformStubs: 批量创建桩平台', () => {
  const stubs = createPlatformStubs({
    netease: { name: 'Netease' },
    qq: { name: 'QQ Music' },
  });
  assert.strictEqual(Object.keys(stubs).length, 2);
  assert.strictEqual(stubs.netease.id, 'netease');
  assert.strictEqual(stubs.qq.id, 'qq');
});

// ── mockRequest ─────────────────────────────────────────

test('mockRequest: 替换 request 模块', async () => {
  const restore = mockRequest(async () => ({ data: 'mocked' }));

  const request = require('../../src/api/request');
  const result = await request('https://example.com');
  assert.deepStrictEqual(result, { data: 'mocked' });

  restore();
  // 恢复后应重新加载真实模块
  delete require.cache[require.resolve('../../src/api/request')];
});

test('mockRequest: 支持根据 URL 返回不同结果', async () => {
  const restore = mockRequest(async (url) => {
    if (url.includes('search')) return { data: { lists: [] } };
    if (url.includes('song')) return { data: { url: 'https://example.com/song.mp3' } };
    return {};
  });

  const request = require('../../src/api/request');
  const searchResult = await request('https://example.com/search');
  const songResult = await request('https://example.com/song');

  assert.ok(searchResult.data);
  assert.ok(songResult.data);

  restore();
  delete require.cache[require.resolve('../../src/api/request')];
});

// ── mockCookieStore ─────────────────────────────────────

test('mockCookieStore: 替换 cookie 存储', async () => {
  const cookies = { netease: 'test-cookie' };
  const restore = mockCookieStore(cookies);

  const cookieStore = require('../../src/utils/cookieStore');
  assert.strictEqual(cookieStore.getCookie('netease'), 'test-cookie');
  assert.strictEqual(cookieStore.getCookie('qq'), '');

  cookieStore.setCookie('qq', 'qq-cookie');
  assert.strictEqual(cookies.qq, 'qq-cookie');

  restore();
  delete require.cache[require.resolve('../../src/utils/cookieStore')];
});

// ── assertValidManifest ─────────────────────────────────

test('assertValidManifest: 合法 manifest 通过', () => {
  const stub = createPlatformStub();
  assert.doesNotThrow(() => assertValidManifest(stub, 'test'));
});

test('assertValidManifest: 缺少 id 时抛错', () => {
  const stub = createPlatformStub();
  delete stub.id;
  assert.throws(() => assertValidManifest(stub, 'test'), /缺少 id/);
});

test('assertValidManifest: 缺少 search 时抛错', () => {
  const stub = createPlatformStub();
  delete stub.search;
  assert.throws(() => assertValidManifest(stub, 'test'), /缺少必需实现方法 search/);
});

test('assertValidManifest: 缺少 hosts.origins 时抛错', () => {
  const stub = createPlatformStub();
  delete stub.hosts;
  assert.throws(() => assertValidManifest(stub, 'test'), /缺少 hosts.origins/);
});
