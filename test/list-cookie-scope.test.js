/**
 * 「取曲目」这一族必须带上登录态
 *
 * gateway 的头注释第 2 条写着「统一注入 cookie」，但只有 search / getUrl /
 * getSongDetail / verifyCookie / getRanking 真拿到，**取曲目族一个都没有**：
 * getPlaylistSongs / getAlbumSongs / getSingerSongs 调平台时不带 cookie。
 * netease 的 SDK 明确支持按次传 cookie（本文件最后两测实证），于是：
 *   D1 需要登录的歌单/会员专辑 → 平台侧返回空 → gateway 折叠成 []
 *      （188 只是让这件事在订阅卡片上"可见"了，可见不等于可治）；
 *   D2 用户就算在「设置 › 账号」里粘好了网易云 Cookie，歌单展开与订阅新歌
 *      仍然看不到 VIP 内容 —— 那份 Cookie 在这条路上从来没被用上；
 *   D3 「哪个方法要 cookie」这件事在 gateway 里有两个家：推荐域有
 *      WITH_COOKIE_METHODS 这个显式清单，取曲目族则连清单都没有（纯漏）。
 *
 * 修法：取曲目三个方法改走推荐域那个**已有**的统一入口（它们与 recommendCall
 * 的语义完全同形：无能力/抛错 ⇒ []），并把那份清单扩成「末位需要 cookie 的方法」
 * 全仓唯一一处（原 WITH_COOKIE_METHODS 改名搬家）。
 *
 * 刻意不做的：qq 侧的 songlist/album 走 qq-music-api 的 `api()` 客户端模式，
 * 该 SDK 的 cookie 只存在于它自带的 server 路由里（util/request.js 读
 * globalCookie.userCookie()，api() 模式下 globalCookie 是 undefined），
 * 要靠 cookie 取 QQ 歌单必须换掉请求路径 —— 那是另一个工程，见项目记忆候选清单。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPlatformGateway } = require('../src/api/gateway');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取曲目族：本次要带上登录态的三个方法 */
const LIST_METHODS = ['getPlaylistSongs', 'getAlbumSongs', 'getSingerSongs'];

function makeRegistry(plugins) {
  const ids = Object.keys(plugins);
  return {
    get: id => plugins[id],
    getIds: () => [...ids],
    getAll: () => ids.map(id => plugins[id]).filter(Boolean),
    has: id => !!plugins[id],
    getCapabilities: id => plugins[id] && plugins[id]._caps,
    size: ids.length,
  };
}

/** 桩平台：记录每次调用的完整入参 */
function stubPlatform(id, methods) {
  const seen = [];
  const plugin = { id, _caps: {} };
  for (const m of methods) {
    plugin[m] = (...args) => { seen.push({ method: m, args }); return [{ id: 's1' }]; };
    plugin._caps[m] = true;
  }
  return { plugin, seen };
}

test('取曲目三方法都把该平台 cookie 作为末位参数交给平台实现', async () => {
  const { plugin, seen } = stubPlatform('netease', LIST_METHODS);
  // _caps 由方法名推导，与 CAPABILITY_METHODS 同义：这里直接按方法名点亮即可（gateway 只看方法存在性）
  const gw = createPlatformGateway({
    registry: makeRegistry({ netease: plugin }),
    getCookie: id => `COOKIE_OF_${id}`,
  });
  await gw.getPlaylistSongs('netease', '888', 200);
  await gw.getAlbumSongs('netease', 'album-1', 99);
  await gw.getSingerSongs('netease', 'singer-1', 30);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].args, ['888', 200, 'COOKIE_OF_netease']);
  assert.deepEqual(seen[1].args, ['album-1', 99, 'COOKIE_OF_netease']);
  assert.deepEqual(seen[2].args, ['singer-1', 30, 'COOKIE_OF_netease']);
});

test('无 cookie 时末位是空串而不是 undefined（平台实现的形参默认值才生效）', async () => {
  const { plugin, seen } = stubPlatform('netease', ['getPlaylistSongs']);
  const gw = createPlatformGateway({ registry: makeRegistry({ netease: plugin }), getCookie: () => '' });
  await gw.getPlaylistSongs('netease', '1');
  assert.equal(seen[0].args[2], '');
  assert.equal(seen[0].args.length, 3);
});

test('cookie 读取抛错不许拖垮取数（沿用 cookieFor 的容错语义）', async () => {
  const { plugin, seen } = stubPlatform('netease', ['getPlaylistSongs']);
  const gw = createPlatformGateway({
    registry: makeRegistry({ netease: plugin }),
    getCookie: () => { throw new Error('cookieStore 未初始化'); },
  });
  assert.deepEqual(await gw.getPlaylistSongs('netease', '1'), [{ id: 's1' }]);
  assert.equal(seen[0].args[2], '');
});

test('平台没这个能力 ⇒ 返回 [] 且一次 cookie 都不读（别白摸 cookieStore）', async () => {
  let reads = 0;
  const { plugin } = stubPlatform('kugou', ['search']);
  const gw = createPlatformGateway({
    registry: makeRegistry({ kugou: plugin }),
    getCookie: () => { reads += 1; return 'x'; },
  });
  assert.deepEqual(await gw.getPlaylistSongs('kugou', '1'), []);
  assert.deepEqual(await gw.getAlbumSongs('kugou', '1'), []);
  assert.deepEqual(await gw.getSingerSongs('kugou', '1'), []);
  assert.equal(reads, 0, '取不到数据的路上还去读登录态，等于把隐私暴露在注定失败的调用里');
});

test('平台抛错仍然折叠成 []（与既有语义一字不差，本次只是多传一个参数）', async () => {
  const plugin = {
    id: 'netease', _caps: {},
    getPlaylistSongs: () => { throw new Error('上游 500'); },
  };
  const gw = createPlatformGateway({ registry: makeRegistry({ netease: plugin }), getCookie: () => 'c' });
  assert.deepEqual(await gw.getPlaylistSongs('netease', '1'), []);
});

test('回归：既有 cookie 注入面不许被我搬家搬掉', async () => {
  const { plugin, seen } = stubPlatform('netease',
    ['search', 'getUrl', 'getSongDetail', 'getTopList', 'getRanking', 'getPlaylistSongs']);
  const gw = createPlatformGateway({
    registry: makeRegistry({ netease: plugin }),
    getCookie: () => 'CK',
  });
  await gw.search('netease', '周杰伦', 1);
  assert.equal(seen[0].args[2], 'CK', 'search 一直是带 cookie 的');
  await gw.getSongDetail('netease', 'id1');
  assert.equal(seen[1].args[1], 'CK');
  await gw.getTopList('netease', '飙升榜', 10);
  assert.deepEqual(seen[2].args, ['飙升榜', 10], '不需要登录态的推荐方法不许被顺手加参');
  await gw.getRanking('netease', 10);
  assert.deepEqual(seen[3].args, [10, 'CK'], 'B 站排行那条历史注入仍要在');
});

test('搬家记账：清单只有一个家，取曲目三方法都经统一入口', () => {
  const src = stripComments(read('src/api/gateway.js'));
  const lists = [...src.matchAll(/'get(PlaylistSongs|AlbumSongs|SingerSongs)'/g)].map(m => m[0]);
  assert.ok(lists.length >= 3, '清单里找不到取曲目三方法');
  for (const m of LIST_METHODS) {
    assert.match(src, new RegExp(`recommendCall\\(platformId, '${m}'`), `${m} 没走统一入口（又在手写第二份调用样板）`);
    assert.ok(!new RegExp(`plugin\\.${m}\\(`).test(src), `${m} 仍在调用点手拼 cookie 参数`);
  }
  // 全仓只许有一份「哪些方法要末位 cookie」的清单
  const decls = [...src.matchAll(/Object\.freeze\(new Set\(\[[^\]]*\]\)\)/g)]
    .filter(s => /getRanking|getPlaylistSongs/.test(s[0]));
  assert.equal(decls.length, 1, `末位 cookie 方法清单有 ${decls.length} 份（两份必然漂移）`);
});

// ── netease 侧：SDK 到底吃不吃这个 cookie ──────────────────────

const SDK_PATH = require.resolve('NeteaseCloudMusicApi');
const realSdk = require(SDK_PATH);
const SDK_METHODS = new Set(['playlist_detail', 'album', 'artists']);

let sdkCalls = [];
let respond = null;

const sdkStub = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    assert.ok(SDK_METHODS.has(prop), `测试桩未覆盖 SDK 方法 ${prop}（新增依赖必须显式加进来，否则打桩静默失效）`);
    return async (args) => {
      sdkCalls.push({ method: prop, args });
      if (!respond) throw new Error(`未打桩的 SDK 调用 ${prop}()`);
      return respond(prop, args);
    };
  },
});

let adapter;
test.before(async () => {
  require.cache[SDK_PATH].exports = sdkStub;
  delete require.cache[require.resolve('../src/api/platforms/netease')];
  adapter = require('../src/api/platforms/netease');
});
test.after(() => {
  require.cache[SDK_PATH].exports = realSdk;
});

/** 造一份最小可用响应：三条路各自读自己的字段 */
function bodyFor(method) {
  if (method === 'playlist_detail') return { body: { playlist: { tracks: [{ id: 1, name: 'T', ar: [{ name: 'A' }], al: { id: 9, name: 'AL' } }] } } };
  if (method === 'album') return { body: { songs: [{ id: 2, name: 'T2', ar: [{ name: 'A' }], al: { id: 9, name: 'AL' }, dt: 1 }] } };
  return { body: { hotSongs: [{ id: 3, name: 'T3', ar: [{ name: 'A' }], al: { id: 9, name: 'AL' }, dt: 1 }] } };
}

test('netease 把 cookie 透传进 SDK：VIP/私密歌单从此取得到', async () => {
  for (const [fn, method, args] of [
    ['getPlaylistSongs', 'playlist_detail', ['123', 200, 'MUSIC_A=1']],
    ['getAlbumSongs', 'album', ['456', 999, 'MUSIC_A=1']],
    ['getSingerSongs', 'artists', ['789', 50, 'MUSIC_A=1']],
  ]) {
    sdkCalls = [];
    respond = m => bodyFor(m);
    const songs = await adapter[fn](...args);
    assert.ok(Array.isArray(songs) && songs.length, `${fn} 返回形态坏了`);
    assert.equal(sdkCalls[0].method, method);
    assert.equal(sdkCalls[0].args.cookie, 'MUSIC_A=1', `${fn} 没把 cookie 交给 SDK —— 登录态在这条路上又丢了`);
  }
});

test('没有 cookie 时不许塞一个空 cookie 进 SDK 参数（污染它的兜底逻辑）', async () => {
  for (const fn of ['getPlaylistSongs', 'getAlbumSongs', 'getSingerSongs']) {
    sdkCalls = [];
    respond = m => bodyFor(m);
    await adapter[fn]('1', 10);
    assert.ok(!('cookie' in sdkCalls[0].args), `${fn} 空 cookie 也照样传了键`);
  }
});

test('SDK 抛错时平台侧不吞成假成功（gateway 负责折叠，见上面那测）', async () => {
  sdkCalls = [];
  respond = () => { throw new Error('上游 460'); };
  await assert.rejects(() => adapter.getPlaylistSongs('1', 10), /460/);
});
