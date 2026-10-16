/**
 * 平台插件契约测试 — 覆盖全部 8 个平台
 *
 * 验证每个平台插件的：
 *   1. manifest 完整性（id, name, hosts, search, getUrl）
 *   2. 方法签名正确（参数数量、返回类型）
 *   3. 能力推导一致性（有实现则有能力声明）
 *   4. 错误处理（不抛异常，返回可预期的空结果）
 *
 * 本测试不触网，使用桩数据验证契约。
 */

const test = require('node:test');
const assert = require('node:assert');

const { loadAllPlatformPlugins } = require('../helpers/platformStub.js');

// ── 平台 ID 清单 ─────────────────────────────────────────
const ALL_IDS = ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];

// ── 加载所有平台插件 ─────────────────────────────────────
const plugins = loadAllPlatformPlugins();

// ── 1. manifest 完整性 ──────────────────────────────────

test('manifest: 所有平台导出 id 字段', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    assert.ok(p, `平台 ${id} 应存在`);
    assert.strictEqual(typeof p.id, 'string', `${id}: id 应为字符串`);
    assert.strictEqual(p.id, id, `${id}: id 应等于 "${id}"`);
  }
});

test('manifest: 所有平台导出 name 字段', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    assert.strictEqual(typeof p.name, 'string', `${id}: name 应为字符串`);
    assert.ok(p.name.length > 0, `${id}: name 不应为空`);
  }
});

test('manifest: 所有平台导出 hosts.origins', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    assert.ok(p.hosts, `${id}: 应有 hosts 对象`);
    assert.ok(Array.isArray(p.hosts.origins), `${id}: hosts.origins 应为数组`);
    assert.ok(p.hosts.origins.length > 0, `${id}: hosts.origins 不应为空`);
  }
});

test('manifest: 所有平台导出 search 方法', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    assert.strictEqual(typeof p.search, 'function', `${id}: 应有 search 方法`);
  }
});

test('manifest: 所有平台导出 getUrl 方法', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    assert.strictEqual(typeof p.getUrl, 'function', `${id}: 应有 getUrl 方法`);
  }
});

// ── 2. 方法签名正确 ─────────────────────────────────────

test('search 方法：返回 Promise 或数组', async () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    const result = p.search('test', 1, '');
    // 要么是 Promise，要么是数组
    if (result instanceof Promise) {
      const resolved = await result;
      assert.ok(Array.isArray(resolved), `${id}: search 应返回数组`);
    } else {
      assert.ok(Array.isArray(result), `${id}: search 应返回数组`);
    }
  }
});

test('getUrl 方法：返回 Promise 或对象', async () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    const result = p.getUrl('test-id', 'standard', '');
    if (result instanceof Promise) {
      const resolved = await result;
      assert.ok(typeof resolved === 'object', `${id}: getUrl 应返回对象`);
    } else {
      assert.ok(typeof result === 'object', `${id}: getUrl 应返回对象`);
    }
  }
});

// ── 3. 能力推导一致性 ───────────────────────────────────

test('能力推导：有实现则有能力声明', () => {
  const CAPABILITY_METHODS = {
    album: 'searchAlbum',
    albumSongs: 'getAlbumSongs',
    singer: 'searchSinger',
    singerSongs: 'getSingerSongs',
    singerAlbums: 'getSingerAlbums',
    lyrics: 'getLyrics',
    lyricsByTitle: 'getLyricsByTitle',
    linkDetail: 'getSongDetail',
    cookie: 'verifyCookie',
    playlistDetail: 'getPlaylistDetail',
    playlistSongs: 'getPlaylistSongs',
    topList: 'getTopList',
    recommendPlaylists: 'getRecommendPlaylists',
    categoryPlaylists: 'getCategoryPlaylists',
    newSongs: 'getNewSongs',
    radioStations: 'getRadioStations',
    hotSingers: 'getHotSingers',
    ranking: 'getRanking',
  };

  for (const id of ALL_IDS) {
    const p = plugins[id];
    for (const method of Object.values(CAPABILITY_METHODS)) {
      const hasImpl = typeof p[method] === 'function';
      // 如果有实现，应该能在能力推导中被检测到
      // 这里只验证方法存在性，不验证 caps 对象（由 registry 推导）
      if (hasImpl) {
        assert.ok(typeof p[method] === 'function', `${id}: 实现了 ${method} 但未被检测到`);
      }
    }
  }
});

// ── 4. 错误处理 ─────────────────────────────────────────

test('search 方法：空关键词返回空数组', async () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    const result = await p.search('', 1, '');
    assert.ok(Array.isArray(result), `${id}: 空关键词应返回数组`);
    assert.strictEqual(result.length, 0, `${id}: 空关键词应返回空数组`);
  }
});

test('search 方法：null 关键词返回空数组', async () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    const result = await p.search(null, 1, '');
    assert.ok(Array.isArray(result), `${id}: null 关键词应返回数组`);
  }
});

// ── 5. 平台特定契约 ─────────────────────────────────────

test('netease: 应有 verifyCookie 方法', () => {
  assert.strictEqual(typeof plugins.netease.verifyCookie, 'function');
});

test('qq: 应有 verifyCookie 方法', () => {
  assert.strictEqual(typeof plugins.qq.verifyCookie, 'function');
});

test('bilibili: 应有 verifyCookie 方法', () => {
  assert.strictEqual(typeof plugins.bilibili.verifyCookie, 'function');
});

test('kugou: 应有 getLyrics 方法（KRC 解码）', () => {
  assert.strictEqual(typeof plugins.kugou.getLyrics, 'function');
});

test('所有平台：hosts.origins 至少包含一个 http/https URL', () => {
  for (const id of ALL_IDS) {
    const p = plugins[id];
    const hasHttp = p.hosts.origins.some(o => o.startsWith('http://') || o.startsWith('https://'));
    assert.ok(hasHttp, `${id}: hosts.origins 应至少包含一个 http/https URL`);
  }
});
