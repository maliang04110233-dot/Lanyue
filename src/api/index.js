/**
 * 音乐 API 聚合层（v3 — 插件架构）
 *
 * 架构说明：
 *   - **平台 manifest 是唯一事实来源**：pluginRegistry 自动发现 platforms/ 目录，
 *     探针 / 换源候选 / CORS 白名单 / 链接识别 / 聚合条数 / 渲染层下拉
 *     全部由 registry 派生，本文件不再持有任何平台清单
 *   - 所有路由函数（searchMusic / getDownloadUrl / getLyrics 等）统一走插件系统
 *   - 新平台 = 在 platforms/ 新建 1 个文件，本文件无需改动
 *
 * 阶段 3 已移除：8 个原始平台模块再导出 + qqSearch/qqGetUrl/qqVerifyCookie 兼容别名。
 *   依据是全仓调用方普查（src/ test/ scripts/ .preview/ 零命中）。
 *   要取平台实现请用 registry.get(id) / registry.getCapabilities(id)，
 *   不要再从本模块 import 平台模块 —— 那会让"平台清单"重新长出第二份。
 */

const { defaultRegistry, loadPlatformPlugins } = require('./pluginRegistry');
const { createPlatformGateway } = require('./gateway');
const recommendations = require('./recommendations');
const logger = require('../utils/logger');
const { normalizeQQCookie, detectQQCookieType, extractQQUin, extractQQMusickey } = require('../utils/cookie');
const sourceHealth = require('../utils/sourceHealth');

// ── 注册平台插件（v3：registry 自动发现 platforms/ 目录）──────
// 平台顺序与各派生清单（探针 / 换源候选 / CORS 白名单 / 链接模式 /
// 聚合条数）全部由各平台 manifest 声明并派生，不再在此手写适配器。
// 新平台 = 在 platforms/ 新建 1 个文件。
const _registry = defaultRegistry;
loadPlatformPlugins(_registry);
logger.log(`[API] 平台加载完成，共 ${_registry.size} 个: ${_registry.getIds().join(', ')}`);

// ── Cookie 存储 ───────────────────────────────────────────
let cookieStore = null;

// ── 平台网关（v3 阶段 2：平台调用的唯一出口）─────────────────
// 所有对平台的调用都应经 gateway，而不是 registry.get(id).method()。
// gateway 负责：能力检查、cookie 注入、统一 safeRun、空值退化约定。
const gateway = createPlatformGateway({
  registry: _registry,
  getCookie: (platform) => getCookie(platform),
});
// 推荐域同样注入 gateway，消灭它原先的平台直连 + 手写分派
recommendations.setGateway(gateway);

function setCookieStore(store) {
  cookieStore = store;
  if (store) {
    const qqCookie = store.get('qq');
    if (qqCookie) _pushQQCookieToLib(qqCookie);
  }
  recommendations.setCookieReader(getCookie);
}
function getCookie(platform) {
  if (!cookieStore) return '';
  return cookieStore.get(platform) || '';
}

// ─── QQ 音乐 Cookie 全局状态管理 ──────────────────────────
function _pushQQCookieToLib(cookie) {
  const qqMusic = require('qq-music-api');
  if (cookie) {
    qqMusic.setCookie(normalizeQQCookie(cookie));
  } else {
    qqMusic.setCookie('');
  }
}
function updateCookie(platform, cookie) {
  if (platform !== 'qq') return;
  _pushQQCookieToLib(cookie || '');
}

// ─── 搜索聚合（插件架构版）─────────────────────────────────
async function searchMusic(keyword, source, page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return { songs: [], source: source || 'all', error: '搜索关键词不能为空' };
  }
  // M11: gateway.search 内部 safeRun 已吞异常并回退 []，永不 throw——
  // 原先这里的 try/catch 与 errors 收集是死代码，删除后行为不变
  if (source === 'all') {
    // all: 并行搜索所有平台，按 manifest 的 policies.aggregateLimit 截断
    const allPlugins = _registry.getAll();
    const results = await gateway.fanOut(allPlugins.map(p => p.id), (id) => gateway.search(id, keyword, 1));
    // 聚合条数由 manifest 的 policies.aggregateLimit 显式声明。
    // 原先是按数组下标硬编码 10/10/5 —— 在中间插入新平台会静默改变
    // 后面所有平台的聚合条数，且没有任何测试盯着。
    const songs = results.flatMap((r, i) => {
      if (!r.ok) return [];
      return (r.value || []).slice(0, allPlugins[i]._policies.aggregateLimit);
    });
    return { songs, source: 'all', error: null };
  }
  if (!_registry.has(source)) return { songs: [], source, error: `未知平台: ${source}` };
  const songs = await gateway.search(source, keyword, page);
  return { songs, source, error: null };
}

// ─── 专辑搜索（插件架构版）─────────────────────────────────
async function searchAlbum(keyword, source = 'qq', page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return { albums: [], total: 0 };
  }

  if (source !== 'all') {
    return await gateway.searchAlbum(source, keyword, page);
  }

  // all: 并行搜索所有支持专辑的平台（能力由 registry 推导）
  const ids = gateway.platformsWith('album');
  const results = await gateway.fanOut(ids, (id) => gateway.searchAlbum(id, keyword, page));
  const allAlbums = [];
  const seen = new Set();
  for (const r of results) {
    if (!r.ok || !r.value || !Array.isArray(r.value.albums)) continue;
    for (const a of r.value.albums) {
      if (a.mid && seen.has(a.mid)) continue;
      if (a.mid) seen.add(a.mid);
      allAlbums.push(a);
    }
  }
  allAlbums.sort((a, b) => {
    if (!a.publishTime && !b.publishTime) return 0;
    if (!a.publishTime) return 1;
    if (!b.publishTime) return -1;
    return b.publishTime.localeCompare(a.publishTime);
  });
  return { albums: allAlbums, total: allAlbums.length, page };
}

// ─── 下载 URL 聚合（插件架构版）────────────────────────────
async function getDownloadUrl(id, source, quality) {
  return gateway.getUrl(source, id, quality);
}

// ── 智能取流（换源机制）───────────────────────────────────
// 实现已抽到 services/resolveTrackService.js（Sprint B）：
//   本文件只保留「组装依赖 + 薄委托」的 facade 角色。
// 换源策略（何时换、候选从哪来、健康度怎么记）全在 service 内，
// 使该策略可独立单测（桩注入，不触网、不加载平台）。

const { findMatchedCandidates } = require('../utils/matchMusic');
const { createResolveTrackService } = require('./services/resolveTrackService');
const { crossSourceEnabled } = require('./services/fallbackPolicy');
const request = require('./request');

const resolveTrack = createResolveTrackService({
  getUrl: (id, source, quality) => gateway.getUrl(source, id, quality),
  searchFn: (platformId, keyword, page) => gateway.search(platformId, keyword, page),
  hasCookie: (platformId) => !!getCookie(platformId),
  findCandidates: findMatchedCandidates,
  sourceHealth,
  // 候选直链预检：HEAD 被拒自动退化为 Range GET（见 request.testAudioLink）
  probeUrl: (url) => request.testAudioLink(url, { timeout: 6000 }),
  // 换源禁用平台清单：懒加载 prefs —— 本模块被大量测试 require，
  // 不在模块初始化期拖入 prefs 的磁盘路径依赖；未 init 时 get 自然落空按无禁用。
  getDisabledPlatforms: () => require('../utils/prefs').get('fallbackDisabledPlatforms'),
  // 跨源换源总开关：产品口径见 fallbackPolicy.crossSourceEnabled ——
  // 搜索结果里的歌只播它自己平台的音源，拿不到就诚实失败，不拿别家整曲冒充。
  fallbackEnabled: crossSourceEnabled,
});

/**
 * 智能取流：本源 → （总开关开启且）失败可换源 → 跨源匹配候选逐个试。
 * 兼容 facade：签名与返回形状与重构前完全一致（零回归）。
 *
 * @param {object} song 完整歌曲对象：{ id, source, title, artist, duration, _altSource? }
 * @param {string} quality
 * @returns {Promise<{url,ext,...}|{error,code,...}>}
 */
async function getDownloadUrlSmart(song, quality) {
  return resolveTrack.resolve(song, quality);
}

// 源健康度快照（设置页探针展示用）
function getSourceHealthMap(sources) {
  return sourceHealth.getHealthMap(sources);
}

// 主动探针结果记入滑动窗口（与被动下载结果共用同一分数）
function recordProbeResult(source, ok) {
  sourceHealth.recordResult(source, !!ok);
}


// ── 歌词聚合（插件架构版）─────────────────────────────────
async function getLyrics(id, source, title, artist) {
  // 优先按来源获取
  const primary = await gateway.getLyrics(source, id);
  if (primary.lrc) return primary;

  // fallback 1：用 title/artist 去网易云搜（netease 是实现该兜底的首选源）
  if (title) {
    const results = await gateway.search('netease', `${title} ${artist}`, 1);
    if (results.length > 0) {
      const r = await gateway.getLyrics('netease', results[0].id);
      if (r.lrc) return r;
    }
  }

  // fallback 2：交给实现了 getLyricsByTitle 的平台按"歌名+歌手"兜底
  // （原先直连 kugou 的私有函数 ⇒ 绕过插件抽象，新平台无法参与这条 fallback）
  // 平台集合由 registry 的能力推导（capabilities.lyricsByTitle）决定。
  if (title) {
    for (const platformId of gateway.platformsWith('lyricsByTitle')) {
      const r = await gateway.getLyricsByTitle(platformId, title, artist);
      if (r.lrc) return r;
    }
  }

  return { lrc: '' };
}

// ─── 粘贴链接智能识别（cobalt 式「贴链接即得歌」）──────────
const { parseMusicLink, detectShortLink } = require('../utils/linkParser');

/**
 * 解析用户输入：链接 → { matched, song?, album?, playlist?, shortLink? }
 *
 * 单曲链接拉详情；专辑/歌单链接返回 { type, id, title } 由渲染层
 * 走现有专辑/歌单曲目流程（getAlbumSongs / getPlaylistSongs）。
 * 平台短链（163cn.tv / b23.tv）无法本地解析，返回 shortLink 标记。
 */
async function getSongByLink(text) {
  const link = parseMusicLink(text);
  if (!link) {
    const short = detectShortLink(text);
    if (short) return { matched: false, shortLink: short };
    return { matched: false };
  }

  // 单曲：按平台拉详情
  if (link.type === 'song') {
    // 平台是否支持由 manifest 的 getSongDetail 方法存在性决定（capabilities.linkDetail）；
    // 原先这里是四路 if-else 硬编码，加平台必须回来加分支。
    const song = await gateway.getSongDetail(link.platform, link.id);
    if (!song) return { matched: true, link, error: '未能获取歌曲信息（链接可能已失效或需要登录）' };
    return { matched: true, link, song };
  }

  // 专辑/歌单：只解析出 { type, id }，渲染层复用现有曲目录入流程
  return { matched: true, link };
}

// ─── Cookie 验证聚合（插件架构版）──────────────────────────
async function verifyCookie(platform, cookie) {
  return gateway.verifyCookie(platform, cookie);
}

// ─── 首页推荐 / 歌单 ───────────────────────────────────
const getHomeRecommendations = recommendations.getHomeRecommendations;
const getHomeSection         = recommendations.getHomeSection;
const getPlaylistSongs       = recommendations.getPlaylistSongs;
const getAlbumSongs          = recommendations.getAlbumSongs;
const searchSinger           = recommendations.searchSinger;
const getSingerSongs         = recommendations.getSingerSongs;
const getSingerAlbums        = recommendations.getSingerAlbums;

module.exports = {
  // 路由（插件架构）
  searchMusic,
  searchAlbum,
  getDownloadUrl,
  getDownloadUrlSmart,
  getSourceHealthMap,
  recordProbeResult,
  getLyrics,
  verifyCookie,
  getSongByLink,
  parseMusicLink,
  detectShortLink,
  // Cookie
  setCookieStore,
  getCookie,
  updateCookie,
  // 推荐
  getHomeRecommendations,
  getHomeSection,
  getPlaylistSongs,
  getAlbumSongs,
  searchSinger,
  getSingerSongs,
  getSingerAlbums,
  // 转发 utils/cookie
  detectQQCookieType,
  normalizeQQCookie,
  extractQQUin,
  extractQQMusickey,
  // 插件注册中心（供外部检查）
  registry: _registry,
  // 平台网关（平台调用的推荐入口；registry 用于查询事实，gateway 用于调用）
  gateway,
  // 统一错误码
  AppError: require('../shared/errors').AppError,
};
