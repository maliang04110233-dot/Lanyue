/**
 * 单元测试：酷狗平台（推荐域补齐 + 纯函数 + 适配器接线）
 *
 * 背景：首页推荐页此前只覆盖 3 家（netease / qq / bilibili），因为酷狗只实现了
 * search 三件套。2026-09-18 给 manifest 补上 getTopList / getRecommendPlaylists
 * 后，registry 由「方法存在性」自动推导出能力位，首页即可覆盖到酷狗。
 *
 * 网络链路（榜单接口 / 歌单广场）由 .preview/_probe-kugou-*.cjs 实测覆盖；
 * 这里只测**无需网络、但回归代价高**的部分：
 *   - 榜单名 → rankid 映射（服务端下发，写错就静默空榜）
 *   - 分页（酷狗单页固定 30，取 100 必须翻页；翻错会漏歌或死循环）
 *   - 封面 URL 规范化（http→https 是**硬约束**：渲染层 https 上下文会拦掉混合内容，
 *     表现为「封面全裂」而不是报错）
 *   - 字段映射（duration 单位是秒，标准形态是毫秒，差 1000 倍）
 *   - 能力位是否真的由 manifest 推导出来（否则首页板块静默消失）
 *
 * 打桩方式：拦截 src/api/request.js，不发起真实网络请求。
 * 之所以不用 Module._load：本文件要 require 平台模块**之后**再替换 request，
 * 平台模块顶层已持有 request 引用，须走 require.cache 改导出对象本身。
 */

const test = require('node:test');
const assert = require('node:assert');

// ── 网络打桩 ───────────────────────────────────────────────
const request = require('../src/api/request');
const realRequest = request;
let calls = [];
let responder = () => ({});

// request.js 顶层导出的是函数本身，平台模块 `const request = require('../request')`
// 拿到的是同一个函数引用 —— 直接改 module.exports 影响不到已缓存的引用，
// 故改为**替换 require.cache 里模块的导出**并清掉平台模块缓存后重新 require。
const reqPath = require.resolve('../src/api/request');
const stubRequest = function stubbedRequest(url, opts) {
  calls.push({ url, opts });
  return Promise.resolve(responder(url, opts));
};
stubRequest.__real = realRequest;

require.cache[reqPath] = {
  id: reqPath,
  filename: reqPath,
  loaded: true,
  exports: stubRequest,
};

const kugouPath = require.resolve('../src/api/platforms/kugou');
delete require.cache[kugouPath];
const kugou = require(kugouPath);

const {
  encodeKugouId,
  decodeKugouId,
  kugouRankItemToSong,
  kugouNormalizeCover,
  KUGOU_RANK_PAGE_SIZE,
} = kugou._internal;

/** 每个用例前重置打桩状态 */
function resetStub(fn) {
  calls = [];
  responder = fn || (() => ({}));
}

/** 造一条榜单接口返回的歌曲条目 */
function rankSong(over = {}) {
  return {
    songname: '晴天',
    h5_author_name: '周杰伦',
    hash: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4',
    sqhash: 'SQ000000000000000000000000000000',
    '320hash': 'HQ000000000000000000000000000000',
    album_id: 1234567,
    remark: '叶惠美',
    duration: 269,
    album_sizable_cover: 'http://imge.kugou.com/stdmusic/{size}/cover.jpg',
    ...over,
  };
}

// ══════════════════════════════════════════════════════════
// 1. kugouNormalizeCover —— http→https 是硬约束
// ══════════════════════════════════════════════════════════

test('kugouNormalizeCover: http 强制升级为 https（否则渲染层按混合内容拦掉，封面全裂）', () => {
  const out = kugouNormalizeCover('http://imge.kugou.com/stdmusic/240/a.jpg');
  assert.ok(out.startsWith('https://'), `封面仍是 http，会被渲染进程拦掉: ${out}`);
});

test('kugouNormalizeCover: 替换 {size} 占位符', () => {
  assert.strictEqual(
    kugouNormalizeCover('http://imge.kugou.com/stdmusic/{size}/a.jpg', 300),
    'https://imge.kugou.com/stdmusic/300/a.jpg',
  );
});

test('kugouNormalizeCover: size 默认 240；显式传入时生效', () => {
  assert.ok(kugouNormalizeCover('http://x/{size}/a.jpg').includes('/240/'));
  assert.ok(kugouNormalizeCover('http://x/{size}/a.jpg', 300).includes('/300/'));
});

test('kugouNormalizeCover: 已是 https 的 URL 不被重复改写', () => {
  assert.strictEqual(
    kugouNormalizeCover('https://imge.kugou.com/a.jpg'),
    'https://imge.kugou.com/a.jpg',
  );
});

test('kugouNormalizeCover: 空/非字符串返回空串（渲染层走 SVG 占位，不留裂图）', () => {
  assert.strictEqual(kugouNormalizeCover(''), '');
  assert.strictEqual(kugouNormalizeCover(null), '');
  assert.strictEqual(kugouNormalizeCover(undefined), '');
  assert.strictEqual(kugouNormalizeCover(123), '');
  assert.strictEqual(kugouNormalizeCover({}), '');
});

test('kugouNormalizeCover: 大写 HTTP:// 也能改写', () => {
  assert.ok(kugouNormalizeCover('HTTP://imge.kugou.com/a.jpg').startsWith('https://'));
});

// ══════════════════════════════════════════════════════════
// 2. kugouRankItemToSong —— 字段映射
// ══════════════════════════════════════════════════════════

test('kugouRankItemToSong: 常规字段映射正确', () => {
  const s = kugouRankItemToSong(rankSong());
  assert.strictEqual(s.title, '晴天');
  assert.strictEqual(s.artist, '周杰伦');
  assert.strictEqual(s.album, '叶惠美');
  assert.strictEqual(s.albumMid, '1234567');
  assert.strictEqual(s.source, 'kugou');
  assert.strictEqual(s.cover, 'https://imge.kugou.com/stdmusic/240/cover.jpg');
});

test('kugouRankItemToSong: duration 由秒转毫秒（差 1000 倍，曾是最易错处）', () => {
  const s = kugouRankItemToSong(rankSong({ duration: 269 }));
  assert.strictEqual(s.duration, 269000);
  assert.strictEqual(kugouRankItemToSong(rankSong({ duration: 0 })).duration, 0);
  assert.strictEqual(kugouRankItemToSong(rankSong({ duration: undefined })).duration, 0);
});

test('kugouRankItemToSong: id 编码三档音质 hash（下载侧据此择优，不能只剩 fileHash）', () => {
  const s = kugouRankItemToSong(rankSong());
  const d = decodeKugouId(s.id);
  assert.strictEqual(d.fileHash, 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4');
  assert.strictEqual(d.sqHash, 'SQ000000000000000000000000000000');
  assert.strictEqual(d.hqHash, 'HQ000000000000000000000000000000');
});

test('kugouRankItemToSong: 缺 sqhash/320hash 时降级为空串（取流侧已有降级链）', () => {
  const s = kugouRankItemToSong(rankSong({ sqhash: undefined, '320hash': undefined }));
  const d = decodeKugouId(s.id);
  assert.strictEqual(d.fileHash, 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4');
  assert.strictEqual(d.sqHash, '');
  assert.strictEqual(d.hqHash, '');
});

test('kugouRankItemToSong: 缺 h5_author_name 时从 filename 切出歌手', () => {
  const s = kugouRankItemToSong(rankSong({ h5_author_name: '', filename: '周杰伦 - 晴天' }));
  assert.strictEqual(s.artist, '周杰伦');
  // songname 优先于 filename 作标题
  assert.strictEqual(s.title, '晴天');
});

test('kugouRankItemToSong: filename 无分隔符时不硬切（歌手留空胜过切错）', () => {
  const s = kugouRankItemToSong(rankSong({ h5_author_name: '', filename: '晴天' }));
  assert.strictEqual(s.artist, '');
});

test('kugouRankItemToSong: 缺 hash 或标题返回 null（不产出半残条目）', () => {
  assert.strictEqual(kugouRankItemToSong(rankSong({ hash: '' })), null);
  assert.strictEqual(kugouRankItemToSong(rankSong({ songname: '', filename: '' })), null);
  assert.strictEqual(kugouRankItemToSong(null), null);
  assert.strictEqual(kugouRankItemToSong(undefined), null);
  assert.strictEqual(kugouRankItemToSong('str'), null);
});

test('kugouRankItemToSong: songname 缺失时回退 filename 作标题', () => {
  const s = kugouRankItemToSong(rankSong({ songname: '', filename: '周杰伦 - 晴天' }));
  assert.strictEqual(s.title, '周杰伦 - 晴天');
});

test('kugouRankItemToSong: album_id 缺失时 albumMid 为空串而非 "undefined"', () => {
  const s = kugouRankItemToSong(rankSong({ album_id: undefined }));
  assert.strictEqual(s.albumMid, '');
});

// ══════════════════════════════════════════════════════════
// 3. kugouGetTopList —— 映射 / 分页 / 容错
// ══════════════════════════════════════════════════════════

test('getTopList: 榜单名 → rankid 映射（4 个上首页的榜都在）', () => {
  const { KUGOU_TOP_MAP } = kugou._internal;
  for (const name of ['飙升榜', '网络热歌榜', '短视频热歌榜', 'TOP500']) {
    assert.ok(KUGOU_TOP_MAP[name], `榜单「${name}」未登记 rankid`);
    assert.strictEqual(typeof KUGOU_TOP_MAP[name], 'number');
  }
});

test('getTopList: 未知榜名返回 [] 且**不发起请求**', async () => {
  resetStub(() => ({ songs: { list: [rankSong()] } }));
  const out = await kugou.kugouGetTopList('不存在的榜');
  assert.deepStrictEqual(out, []);
  assert.strictEqual(calls.length, 0, '未知榜名不应打网络，避免无谓请求');
});

test('getTopList: 请求 URL 带上正确 rankid', async () => {
  resetStub(() => ({ songs: { list: [rankSong()] } }));
  await kugou.kugouGetTopList('飙升榜', 1);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('rankid=6666'), `URL 未带 rankid=6666: ${calls[0].url}`);
});

test('getTopList: 支持直接传数字 rankid', async () => {
  resetStub(() => ({ songs: { list: [rankSong()] } }));
  await kugou.kugouGetTopList(8888, 1);
  assert.ok(calls[0].url.includes('rankid=8888'));
});

test('getTopList: limit <= 30 时只请求 1 页', async () => {
  resetStub(() => ({ songs: { list: [rankSong()] } }));
  await kugou.kugouGetTopList('飙升榜', 30);
  assert.strictEqual(calls.length, 1);
});

test('getTopList: limit=100 时翻 4 页（单页恒 30，取 100 必须翻页）', async () => {
  // 每页返回 30 条；酷狗单页固定 30，pagesize 参数不生效
  resetStub(() => ({ songs: { list: Array.from({ length: 30 }, (_, i) => rankSong({ hash: `H${i}` })) } }));
  const out = await kugou.kugouGetTopList('飙升榜', 100);
  assert.strictEqual(out.length, 100, `应取到 100 条，实际 ${out.length}`);
  assert.strictEqual(calls.length, 4, `应翻 4 页，实际 ${calls.length}`);
  // 页码递增且不重复
  assert.deepStrictEqual(
    calls.map(c => /page=(\d+)/.exec(c.url)[1]),
    ['1', '2', '3', '4'],
  );
});

test('getTopList: 翻页遇到空页立即停止（不空转到 pages 上限）', async () => {
  let n = 0;
  resetStub(() => {
    n += 1;
    return { songs: { list: n === 1 ? Array.from({ length: 30 }, (_, i) => rankSong({ hash: `H${i}` })) : [] } };
  });
  const out = await kugou.kugouGetTopList('飙升榜', 100);
  assert.strictEqual(out.length, 30);
  assert.strictEqual(calls.length, 2, '第 2 页为空后应停止，不应继续请求第 3/4 页');
});

test('getTopList: 结果被 slice 到 limit（翻页会超采）', async () => {
  resetStub(() => ({ songs: { list: Array.from({ length: 30 }, (_, i) => rankSong({ hash: `H${i}` })) } }));
  const out = await kugou.kugouGetTopList('飙升榜', 35);
  assert.strictEqual(out.length, 35);
  assert.strictEqual(calls.length, 2);
});

test('getTopList: 响应结构不符（缺 songs.list）返回 [] 而不是抛错', async () => {
  resetStub(() => ({}));
  assert.deepStrictEqual(await kugou.kugouGetTopList('飙升榜', 10), []);
});

test('getTopList: request 抛错时吞掉异常返回 []（首页板块不能因单源拖垮整页）', async () => {
  resetStub(() => { throw new Error('boom'); });
  assert.deepStrictEqual(await kugou.kugouGetTopList('飙升榜', 10), []);
});

test('getTopList: 条目里有非法项时跳过而不是整体失败', async () => {
  resetStub(() => ({ songs: { list: [rankSong(), null, { hash: '' }, rankSong({ hash: 'H2', songname: '夜曲' })] } }));
  const out = await kugou.kugouGetTopList('飙升榜', 10);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].title, '夜曲');
});

test('getTopList: limit 非法值被归一（0 / 负数 → 至少 1 条）', async () => {
  resetStub(() => ({ songs: { list: [rankSong()] } }));
  assert.strictEqual((await kugou.kugouGetTopList('飙升榜', 0)).length, 1);
  assert.strictEqual((await kugou.kugouGetTopList('飙升榜', -5)).length, 1);
});

test('KUGOU_RANK_PAGE_SIZE 与实测单页条数一致（写错会导致翻页数算错）', () => {
  assert.strictEqual(KUGOU_RANK_PAGE_SIZE, 30);
});

// ══════════════════════════════════════════════════════════
// 4. kugouGetRecommendPlaylists —— 真实响应结构
// ══════════════════════════════════════════════════════════

/** 造一份**实测形态**的歌单广场响应：info 是 list 的直接子数组 */
function plistResp(info) {
  return { plist: { list: { total: 600, has_next: true, info } } };
}

test('getRecommendPlaylists: 按实测结构解析 plist.list.info（不是嵌套的 list[].list.info）', async () => {
  resetStub(() => plistResp([
    { specialid: 111, specialname: '华语流行', imgurl: 'http://imge.kugou.com/{size}/a.jpg', playcount: 10483000, songcount: 50 },
  ]));
  const out = await kugou.kugouGetRecommendPlaylists(10);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '111');
  assert.strictEqual(out[0].name, '华语流行');
  assert.strictEqual(out[0].cover, 'https://imge.kugou.com/300/a.jpg');
  assert.strictEqual(out[0].playCount, 10483000);
  assert.strictEqual(out[0].songCount, 50);
  assert.strictEqual(out[0].source, 'kugou');
});

test('getRecommendPlaylists: 封面用 300 档（歌单是卡片大图，240 会糊）', async () => {
  resetStub(() => plistResp([{ specialid: 1, specialname: 'x', imgurl: 'http://i/{size}/a.jpg' }]));
  const out = await kugou.kugouGetRecommendPlaylists(1);
  assert.ok(out[0].cover.includes('/300/'), `歌单封面应取 300 档: ${out[0].cover}`);
});

test('getRecommendPlaylists: 无 specialid 的条目被剔除', async () => {
  resetStub(() => plistResp([
    { specialname: '无 id 的歌单' },
    { specialid: 2, specialname: '正常歌单' },
  ]));
  const out = await kugou.kugouGetRecommendPlaylists(10);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '2');
});

test('getRecommendPlaylists: global_specialid 可作 id 兜底', async () => {
  resetStub(() => plistResp([{ global_specialid: 9, specialname: 'x' }]));
  const out = await kugou.kugouGetRecommendPlaylists(10);
  assert.strictEqual(out[0].id, '9');
});

test('getRecommendPlaylists: 无名歌单被剔除（卡片无标题等于坏项）', async () => {
  resetStub(() => plistResp([{ specialid: 3 }, { specialid: 4, specialname: '有名' }]));
  const out = await kugou.kugouGetRecommendPlaylists(10);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '4');
});

test('getRecommendPlaylists: 响应结构不符返回 []', async () => {
  resetStub(() => ({}));
  assert.deepStrictEqual(await kugou.kugouGetRecommendPlaylists(10), []);
});

test('getRecommendPlaylists: request 抛错返回 []', async () => {
  resetStub(() => { throw new Error('boom'); });
  assert.deepStrictEqual(await kugou.kugouGetRecommendPlaylists(10), []);
});

test('getRecommendPlaylists: 结果受 limit 约束', async () => {
  resetStub(() => plistResp(Array.from({ length: 30 }, (_, i) => ({ specialid: i + 1, specialname: `p${i}` }))));
  assert.strictEqual((await kugou.kugouGetRecommendPlaylists(8)).length, 8);
});

test('getRecommendPlaylists: 封面缺失时为空串（不留 http 残串）', async () => {
  resetStub(() => plistResp([{ specialid: 1, specialname: 'x', imgurl: '' }]));
  const out = await kugou.kugouGetRecommendPlaylists(1);
  assert.strictEqual(out[0].cover, '');
});

// ══════════════════════════════════════════════════════════
// 5. kugouGetRankList —— 榜单有效性自检入口
// ══════════════════════════════════════════════════════════

test('getRankList: 解析 rank.list，缺 id/name 的条目被剔除', async () => {
  resetStub(() => ({
    rank: {
      list: [
        { rankid: 6666, rankname: '飙升榜', img_9: 'http://i/{size}/a.jpg' },
        { rankid: 0, rankname: '' },
      ],
    },
  }));
  const out = await kugou.kugouGetRankList();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '6666');
  assert.strictEqual(out[0].name, '飙升榜');
  assert.ok(out[0].cover.startsWith('https://'));
});

test('getRankList: request 抛错返回 []', async () => {
  resetStub(() => { throw new Error('boom'); });
  assert.deepStrictEqual(await kugou.kugouGetRankList(), []);
});

test('getRankList: 硬编码的 4 个 rankid 都在服务端下发的榜单清单里', async () => {
  // 这是**可主动执行的过期检查**：rankid 是服务端下发的，运营调整后会失效，
  // 失效表现是「首页榜单静默变空」。本用例用打桩数据验证解析链路；
  // 真实网络校验见 .preview/_probe-kugou-detail.cjs（不入仓库）。
  const { KUGOU_TOP_MAP } = kugou._internal;
  resetStub(() => ({
    rank: { list: Object.entries(KUGOU_TOP_MAP).map(([, id]) => ({ rankid: id, rankname: 'x' })) },
  }));
  const declared = await kugou.kugouGetRankList();
  const ids = new Set(declared.map(r => Number(r.id)));
  for (const [name, id] of Object.entries(KUGOU_TOP_MAP)) {
    assert.ok(ids.has(id), `榜单「${name}」的 rankid ${id} 不在服务端清单里`);
  }
});

// ══════════════════════════════════════════════════════════
// 6. id 编码往返
// ══════════════════════════════════════════════════════════

test('encodeKugouId / decodeKugouId 往返一致（含缺档情形）', () => {
  const full = encodeKugouId('A', 'B', 'C');
  assert.deepStrictEqual(decodeKugouId(full), { fileHash: 'A', sqHash: 'B', hqHash: 'C' });
  const onlyFile = encodeKugouId('A', '', '');
  assert.deepStrictEqual(decodeKugouId(onlyFile), { fileHash: 'A', sqHash: '', hqHash: '' });
  const noArg = encodeKugouId('A');
  assert.deepStrictEqual(decodeKugouId(noArg), { fileHash: 'A', sqHash: '', hqHash: '' });
});

// ══════════════════════════════════════════════════════════
// 7. 适配器接线：能力位由 manifest 推导（本次补齐的核心收益）
// ══════════════════════════════════════════════════════════

test('酷狗 manifest 已声明 getTopList / getRecommendPlaylists（方法存在 = 能力存在）', () => {
  assert.strictEqual(typeof kugou.getTopList, 'function');
  assert.strictEqual(typeof kugou.getRecommendPlaylists, 'function');
});

test('registry 从 manifest 自动推导出 topList / recommendPlaylists 能力位', () => {
  const api = require('../src/api/index.js');
  const caps = api.registry.getCapabilities('kugou');
  assert.strictEqual(caps.topList, true,
    'topList 能力位未推导出来 —— 请确认 pluginRegistry.CAPABILITY_METHODS 含 getTopList');
  assert.strictEqual(caps.recommendPlaylists, true,
    'recommendPlaylists 能力位未推导出来 —— 请确认 CAPABILITY_METHODS 含 getRecommendPlaylists');
});

test('gateway.getTopList 能真正取到酷狗榜单数据（经能力位分派，UI 的实际调用路径）', async () => {
  resetStub((url) => {
    if (url.includes('/rank/info/')) {
      return { songs: { list: [rankSong()] } };
    }
    return {};
  });
  const { createPlatformGateway } = require('../src/api/gateway');
  const api = require('../src/api/index.js');
  const gw = createPlatformGateway({ registry: api.registry });
  const out = await gw.getTopList('kugou', '飙升榜', 5);
  assert.ok(Array.isArray(out) && out.length === 1, 'gateway 未从酷狗取到榜单数据');
  assert.strictEqual(out[0].source, 'kugou');
});

test('gateway.platformsWith 把 kugou 列入 topList 能力方（首页据此决定渲染哪家）', () => {
  const { createPlatformGateway } = require('../src/api/gateway');
  const api = require('../src/api/index.js');
  const gw = createPlatformGateway({ registry: api.registry });
  assert.ok(gw.platformsWith('topList').includes('kugou'),
    'kugou 未出现在 topList 能力方里 —— 首页榜单板块会静默少一家');
  assert.ok(gw.platformsWith('recommendPlaylists').includes('kugou'),
    'kugou 未出现在 recommendPlaylists 能力方里');
});

test('酷狗仍保留 search 三件套且未虚报专辑/歌手之外的能力', () => {
  const api = require('../src/api/index.js');
  const p = api.registry.get('kugou');
  assert.ok(p, 'kugou 未注册到插件中心');
  assert.strictEqual(typeof p.search, 'function');
  assert.strictEqual(typeof p.getUrl, 'function');
  assert.strictEqual(typeof p.getLyrics, 'function');
  // 酷狗确实实现了专辑/歌手接口，故这两项应为 true；cookie 未实现应为 false
  const caps = api.registry.getCapabilities('kugou');
  assert.strictEqual(caps.cookie, false, '酷狗未实现 cookie 登录，不应虚报');
});

test('kugou 已进入换源候选源列表', () => {
  const { CANDIDATE_SOURCES } = require('../src/utils/matchMusic');
  assert.ok(CANDIDATE_SOURCES.includes('kugou'), 'kugou 未加入 CANDIDATE_SOURCES');
});

// ══════════════════════════════════════════════════════════
// 歌词链路（2026-09-18 实测修正 + KRC 逐字歌词）
//
// 旧实现三处已实证失效（真实请求全部拿不到歌词）：
//   1. search 只带 keyword 不带 hash —— 酷狗该端点对纯 keyword 返回 0 候选；
//   2. id 参数其实是 encodeKugouId 编码的三 hash 串，当 keyword 用必然搜不到；
//   3. 候选字段与下载参数都是 accesskey（全小写），旧代码写 accessToken。
// 新契约：getLyrics/getLyricsByTitle 返回 { lrc, karaoke? }（krctype=1 官方
// 逐字歌词解出 karaoke 结构，普通 lrc 候选不挂该字段）。
// ══════════════════════════════════════════════════════════

const fs = require('node:fs');
const KRC_B64 = fs.readFileSync(
  require('node:path').join(__dirname, 'fixtures', 'platforms', 'kugou.qingtian.krc.txt'), 'utf8',
).trim();

/** 歌词服务桩：search 返回官方 krc 候选，download 返回真实 KRC 样本 */
function lyricStub(extra = {}) {
  resetStub((url) => {
    if (url.includes('lyrics.kugou.com/search')) {
      return { candidates: [{ id: '274944371', accesskey: 'AK123', krctype: 1, contenttype: 0, ...extra.candidate }] };
    }
    if (url.includes('lyrics.kugou.com/download')) return extra.download || { content: KRC_B64 };
    return {};
  });
}

test('getLyrics: 用解码后的 fileHash 搜歌词（hash+lrctxt=1），不再把编码 id 当 keyword', async () => {
  lyricStub();
  const r = await kugou.getLyrics(encodeKugouId('HASHFILE', 'HASHSQ', 'HASHHQ'));
  const sCall = calls.find(c => c.url.includes('lyrics.kugou.com/search'));
  assert.ok(sCall, '未发起歌词 search');
  assert.ok(sCall.url.includes('hash=HASHFILE'), `search 未用解码 fileHash: ${sCall.url}`);
  assert.ok(sCall.url.includes('lrctxt=1'), 'search 缺 lrctxt=1（决定候选含 krc）');
  assert.ok(typeof r === 'object' && r.lrc.includes('[00:02.250]词：周杰伦'), 'KRC 未解出 LRC 行');
});

test('getLyrics: krctype=1 官方候选走 fmt=krc + accesskey（全小写），产出逐字 karaoke', async () => {
  lyricStub();
  const r = await kugou.getLyrics(encodeKugouId('H1', '', ''));
  const dCall = calls.find(c => c.url.includes('lyrics.kugou.com/download'));
  assert.ok(dCall.url.includes('fmt=krc'), `未走 krc 格式: ${dCall.url}`);
  assert.ok(dCall.url.includes('accesskey=AK123'), `下载参数应为 accesskey: ${dCall.url}`);
  assert.ok(!/accessToken=/.test(dCall.url), '旧 accessToken 参数名仍在链路里');
  assert.strictEqual(r.karaoke.meta.ti, '晴天');
  const line = r.karaoke.lines.find(l => l.words.map(w => w.text).join('') === '词：周杰伦');
  assert.ok(line && line.words[0].startMs === 2250, 'karaoke 逐字结构缺失');
});

test('getLyrics: krctype≠1 候选走 fmt=lrc，返回 { lrc } 不挂 karaoke', async () => {
  const plain = Buffer.from('[00:01.000]你好', 'utf8').toString('base64');
  lyricStub({ candidate: { krctype: 2, contenttype: 2 }, download: { content: plain } });
  const r = await kugou.getLyrics(encodeKugouId('H1', '', ''));
  const dCall = calls.find(c => c.url.includes('lyrics.kugou.com/download'));
  assert.ok(dCall.url.includes('fmt=lrc'), `普通候选应走 lrc: ${dCall.url}`);
  assert.strictEqual(r.lrc, '[00:01.000]你好');
  assert.strictEqual(r.karaoke, undefined);
});

test('getLyrics: 无候选 / 解码失败 / 网络异常 ⇒ { lrc: 空串 }，绝不抛错（歌词缺失不能拖垮下载）', async () => {
  lyricStub({ candidate: null });
  calls = [];
  resetStub((url) => {
    if (url.includes('lyrics.kugou.com/search')) return { candidates: [] };
    return {};
  });
  assert.deepStrictEqual(await kugou.getLyrics(encodeKugouId('H1', '', '')), { lrc: '' });

  resetStub(() => { throw new Error('network down'); });
  assert.deepStrictEqual(await kugou.getLyrics('anything'), { lrc: '' });

  // 空 id
  assert.deepStrictEqual(await kugou.getLyrics(''), { lrc: '' });
});

test('getLyricsByTitle: 先歌曲搜索拿 hash+时长，再走同一歌词链路（timelength 用毫秒）', async () => {
  resetStub((url) => {
    if (url.includes('song_search_v2')) {
      return { data: { lists: [{ SongName: '晴天', SingerName: '周杰伦', FileHash: 'FILEHASH1', Duration: 269, SQFileHash: '', HQFileHash: '' }] } };
    }
    if (url.includes('lyrics.kugou.com/search')) {
      return { candidates: [{ id: 'X1', accesskey: 'AK2', krctype: 1, contenttype: 0 }] };
    }
    if (url.includes('lyrics.kugou.com/download')) return { content: KRC_B64 };
    return {};
  });
  const r = await kugou.getLyricsByTitle('晴天', '周杰伦');
  const sCall = calls.find(c => c.url.includes('lyrics.kugou.com/search'));
  assert.ok(sCall.url.includes('hash=FILEHASH1'), '未按歌曲搜索解析出的 hash 搜词');
  assert.ok(sCall.url.includes('timelength=269000'), 'timelength 应为毫秒（269s→269000）');
  assert.ok(r.lrc.includes('[00:02.250]词：周杰伦'));
});

test('gateway.getLyrics: 平台返回 {lrc,karaoke} 对象时透传不丢逐字数据，返回字符串时兼容旧形态', async () => {
  lyricStub();
  const { createPlatformGateway } = require('../src/api/gateway');
  const api = require('../src/api/index.js');
  const gw = createPlatformGateway({ registry: api.registry });
  const out = await gw.getLyrics('kugou', encodeKugouId('H1', '', ''));
  assert.ok(out.lrc.includes('[00:02.250]'), 'gateway 丢了 lrc');
  assert.strictEqual(out.karaoke?.meta?.ti, '晴天', 'gateway 把 karaoke 字段折丢了');
});

// ── 取流受限文案（换源总开关关闭，不得再承诺换源）────
test('getUrl：playInfo 判付费 ⇒ 只说清要付费，不谎称"已自动尝试其他源"', async () => {
  resetStub((url) => (String(url).includes('getSongInfo.php') ? { error: '该曲需付费' } : {}));
  const r = await kugou.getUrl(
    encodeKugouId('A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4', '', ''), 'standard');
  assert.ok(!r.url, '受限曲绝不能给出直链');
  assert.strictEqual(r.code, 'COPYRIGHT_RESTRICTED');
  assert.match(String(r.error), /该曲需付费/, '保留平台原话，用户才知道要开会员');
  assert.doesNotMatch(String(r.error), /其他源|已自动尝试/,
    '跨源换源默认已关闭（fallbackPolicy.crossSourceEnabled），这句话是假的');
});
