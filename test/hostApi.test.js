/**
 * 单元测试：api/userSources/hostApi.js — 沙箱宿主 API 白名单
 *
 * 钉住三件事：
 *   1. 导出面与 HOST_API_METHODS 一致（自检：冻结对象的方法集合必须精确匹配）
 *   2. 每个方法都经 gateway 调用 + redact 脱敏
 *   3. 失败路径不吞 —— 脚本能看到原始错误（否则它无法决定是否重试）
 */

const test = require('node:test');
const assert = require('node:assert');

const { createHostApi, isHostApiLike, HOST_API_METHODS } = require('../src/api/userSources/hostApi');
const { HOST_API_METHODS: ValidatorMethods } = require('../src/main/userSourceValidator');

// ── 桩 ──────────────────────────────────────────────

/** 记录调用并返回可注入结果的 gateway 桩 */
function makeGateway(map = {}) {
  const calls = [];
  const fn = (name) => async (...args) => {
    calls.push({ method: name, args });
    if (name in map) return map[name](...args);
    return { ok: true, method: name };
  };
  const g = {
    search: fn('search'),
    getUrl: fn('getUrl'),
    getLyrics: fn('getLyrics'),
    getLyricsByTitle: fn('getLyricsByTitle'),
    getSongDetail: fn('getSongDetail'),
    getAlbumSongs: fn('getAlbumSongs'),
    getSingerSongs: fn('getSingerSongs'),
    getSingerAlbums: fn('getSingerAlbums'),
    getPlaylistSongs: fn('getPlaylistSongs'),
    getPlaylistDetail: fn('getPlaylistDetail'),
    getTopList: fn('getTopList'),
    getRecommendPlaylists: fn('getRecommendPlaylists'),
    getCategoryPlaylists: fn('getCategoryPlaylists'),
    getNewSongs: fn('getNewSongs'),
    getRadioStations: fn('getRadioStations'),
    getHotSingers: fn('getHotSingers'),
    getRanking: fn('getRanking'),
    hasCookie: fn('hasCookie'),
  };
  g._calls = calls;
  return g;
}

const makeLogger = () => {
  const entries = [];
  return {
    entries,
    log: (...a) => entries.push(['log', a]),
    warn: (...a) => entries.push(['warn', a]),
    error: (...a) => entries.push(['error', a]),
  };
};

const identityRedact = { apply: (v) => v };
/** 去掉 cookie 字段的脱敏桩 */
const stripCookieRedact = {
  apply: (v) => (v && typeof v === 'object' && 'cookie' in v
    ? { ...v, cookie: undefined }
    : v),
};

// ══════════════════════════════════════════════════════════
// A. 构造与自检
// ══════════════════════════════════════════════════════════

test('A. 缺 gateway → 立即抛错（早失败优于静默失效）', () => {
  assert.throws(() => createHostApi({}), /必须注入 gateway/);
});

test('A. redact 缺 apply → 立即抛错', () => {
  assert.throws(() => createHostApi({ gateway: makeGateway(), redact: {} }), /redact 必须提供 apply/);
});

test('A. 导出面与 HOST_API_METHODS 一致（自检不炸）', () => {
  const api = createHostApi({ gateway: makeGateway() });
  const actual = Object.keys(api).sort();
  assert.deepStrictEqual(actual, [...HOST_API_METHODS].sort());
});

test('A. HOST_API_METHODS 与 validator 导出的一致（两处不漂移）', () => {
  assert.deepStrictEqual([...HOST_API_METHODS].sort(), [...ValidatorMethods].sort());
});

test('A. 冻结：脚本无法篡改方法（篡改 = 绕过白名单）', () => {
  const api = createHostApi({ gateway: makeGateway() });
  assert.ok(Object.isFrozen(api), 'hostApi 实例必须冻结');
  assert.throws(() => { 'use strict'; api.platformSearch = () => {}; },
    /Cannot assign to read only property/);
});

test('A. isHostApiLike：合法实例返回 true', () => {
  const api = createHostApi({ gateway: makeGateway() });
  assert.strictEqual(isHostApiLike(api), true);
});

test('A. isHostApiLike：缺方法的对象返回 false', () => {
  assert.strictEqual(isHostApiLike({}), false);
  assert.strictEqual(isHostApiLike(null), false);
  assert.strictEqual(isHostApiLike('string'), false);
});

// ══════════════════════════════════════════════════════════
// B. 调用路径
// ══════════════════════════════════════════════════════════

test('B. platformSearch 调 gateway.search 并返回结果', async () => {
  const g = makeGateway({ search: () => [{ id: '1', title: '测试曲' }] });
  const api = createHostApi({ gateway: g });
  const r = await api.platformSearch('netease', '周杰伦', 1);
  assert.deepStrictEqual(r, [{ id: '1', title: '测试曲' }]);
  assert.strictEqual(g._calls[0].method, 'search');
  assert.deepStrictEqual(g._calls[0].args, ['netease', '周杰伦', 1]);
});

test('B. platformGetUrl 调 gateway.getUrl', async () => {
  const g = makeGateway({ getUrl: () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' }) });
  const api = createHostApi({ gateway: g });
  const r = await api.platformGetUrl('netease', '1', 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(g._calls[0].method, 'getUrl');
});

test('B. platformHasCookie 调 gateway.hasCookie', async () => {
  const g = makeGateway({ hasCookie: () => true });
  const api = createHostApi({ gateway: g });
  const r = await api.platformHasCookie('netease');
  assert.strictEqual(r, true);
});

test('B. 每个方法都经 redact 脱敏', async () => {
  const g = makeGateway({ getUrl: () => ({ url: 'x', cookie: 'SECRET_VALUE' }) });
  const api = createHostApi({ gateway: g, redact: stripCookieRedact });
  const r = await api.platformGetUrl('netease', '1', 'standard');
  assert.ok(!('cookie' in r) || r.cookie === undefined, 'cookie 字段必须被剥掉');
});

test('B. 默认 redact 是 identity（不改变结果）', async () => {
  const g = makeGateway({ search: () => [{ id: '1' }] });
  const api = createHostApi({ gateway: g });
  const r = await api.platformSearch('netease', 'kw', 1);
  assert.deepStrictEqual(r, [{ id: '1' }]);
});

// ══════════════════════════════════════════════════════════
// C. 失败路径
// ══════════════════════════════════════════════════════════

test('C. gateway 抛错时 hostApi 不吞（脚本能看到原始错误）', async () => {
  const g = makeGateway({
    getUrl: () => { throw new Error('CDN 403'); },
  });
  const api = createHostApi({ gateway: g, logger: makeLogger() });
  await assert.rejects(
    () => api.platformGetUrl('netease', '1', 'standard'),
    /CDN 403/,
  );
});

test('C. 失败时日志记了 sourceId（审计归因）', async () => {
  const g = makeGateway({ getUrl: () => { throw new Error('boom'); } });
  const logger = makeLogger();
  const api = createHostApi({ gateway: g, logger, sourceId: 'user:mycloud' });
  await assert.rejects(() => api.platformGetUrl('netease', '1', 'standard'));
  const warnEntries = logger.entries.filter((e) => e[0] === 'warn');
  assert.ok(warnEntries.length > 0, '失败必须记日志');
  assert.ok(warnEntries[0][1].join(' ').includes('user:mycloud'), '日志必须带 sourceId');
});

test('C. 成功时日志记了 sourceId 与方法名', async () => {
  const g = makeGateway({ search: () => [] });
  const logger = makeLogger();
  const api = createHostApi({ gateway: g, logger, sourceId: 'user:x' });
  await api.platformSearch('netease', 'kw', 1);
  const logEntries = logger.entries.filter((e) => e[0] === 'log');
  assert.ok(logEntries.length > 0);
  assert.ok(logEntries[0][1].join(' ').includes('platformSearch'), '日志必须带方法名');
  assert.ok(logEntries[0][1].join(' ').includes('user:x'), '日志必须带 sourceId');
});

test('C. logger 不可用时不影响调用', async () => {
  const g = makeGateway({ search: () => [{ id: '1' }] });
  const api = createHostApi({ gateway: g, logger: { log: () => { throw new Error('logger 炸了'); }, warn: () => { throw new Error('warn 炸了'); } } });
  const r = await api.platformSearch('netease', 'kw', 1);
  assert.deepStrictEqual(r, [{ id: '1' }]);
});
