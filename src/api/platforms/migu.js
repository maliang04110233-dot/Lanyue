/**
 * 咪咕音乐平台实现（2026-09-17 实测校准，非猜测）
 *
 * ── 三项能力的真实契约 ──────────────────────────────────────
 *
 * 搜索  GET pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do
 *         ?ua=Android_migu&version=5.0.1&text=<kw>&pageNo=<n>&pageSize=20&searchSwitch={...}
 *       → songResultData.result[]，每页 20 条，totalCount 可用
 *
 * 取流  HEAD c.musicapp.migu.cn/strategy/listen-song/v2.3
 *         ?toneFlag=PQ&copyrightId=0&contentId=<id>&resourceType=2&channel=0146921
 *       必须 HEAD（GET 只会返回「暂不提供试听地址」），服务端用 305 状态码把
 *       真实直链放在 Location 头里。UA 必须是 okhttp/3.14.9（伪移动客户端）。
 *       直链下载不需要 Referer（实测无 Referer 同样 206）。
 *
 * 歌词  GET c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do
 *         ?resourceId=<id>&resourceType=2&needSimple=00  → .resource[].lrcUrl
 *       再 GET lrcUrl 得标准 LRC 文本。
 *
 * ── 两个必须知道的限制 ──────────────────────────────────────
 *   1. copyrightId 传 0 即可（走免登录路径）。因此本平台 id 直接沿用
 *      contentId，不必把 copyrightId 编码进 id —— 保持了与其它平台一致的
 *      单一 id 契约（见 test/migu.test.js 的回归守卫）。
 *   2. 免登录只能拿 PQ 标准音质（约 2.9MB mp3）。toneFlag 传 LQ/PQ/HQ/SQ
 *      服务端都返回同一个文件，故 quality 参数在本平台上不产生实际差异。
 *
 * ── 与其它平台的差异 ────────────────────────────────────────
 *   搜索接口不返回时长，故 duration 恒为 0。跨源匹配的时长项（±5s）因此
 *   失效，但仍可靠「歌名 + 歌手」命中 2 分门槛（见 utils/matchMusic.js）。
 */

const https = require('https');
const http = require('http');
const request = require('../request');
const { asSong } = require('../songShape');
const { testAudioLink } = require('../request');
const logger = require('../../utils/logger');

const SEARCH_HOST = 'https://pd.musicapp.migu.cn';
const API_HOST = 'https://c.musicapp.migu.cn';
const REFERER = 'https://music.migu.cn/';

/** 搜索接口的客户端标识（query 参数） */
const API_UA = 'Android_migu';
const API_VERSION = '5.0.1';

/**
 * 取流接口的 User-Agent —— 必须是 okhttp。
 * 用浏览器 UA 会被拒（返回 500），实测确认。
 */
const STREAM_UA = 'okhttp/3.14.9';

/** 免登录可用的音质档位：PQ（标准） */
const TONE_FLAG = 'PQ';
const RESOURCE_TYPE = '2';

/** 音质 → toneFlag 映射。免登录下服务端不区分，保留映射以备后续带 Cookie 时生效。 */
const QUALITY_TONE = {
  lossless: { toneFlag: 'SQ', resourceType: 'E' },
  hq: { toneFlag: 'HQ', resourceType: '2' },
  standard: { toneFlag: 'PQ', resourceType: '2' },
};

/**
 * 搜索结果条目 → 项目统一歌曲结构
 *
 * 字段形态必须按真实返回处理：singers / albums / imgItems 都是**数组**
 * （裸取 s.singer 会是 undefined —— 实测踩过）。时长字段服务端不返回。
 *
 * @param {object} s
 * @returns {{id,title,artist,album,cover,duration,source}|null}
 */
function mapSong(s) {
  const id = String(s?.contentId || '').trim();
  if (!id) return null;
  const title = String(s?.name || '').trim();
  if (!title) return null;
  return asSong({
    id,
    title,
    artist: Array.isArray(s.singers)
      ? s.singers.map((x) => x && x.name).filter(Boolean).join('、')
      : String(s.singer || '').trim(),
    album: Array.isArray(s.albums)
      ? String((s.albums[0] && s.albums[0].name) || '').trim()
      : String(s.albumName || '').trim(),
    cover: Array.isArray(s.imgItems)
      ? String((s.imgItems[0] && s.imgItems[0].img) || '').trim()
      : '',
    duration: 0, // 搜索接口不返回时长（约定恒为毫秒，见 ../songShape.js）
    source: 'migu',
  });
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page - 从 1 开始（服务端 pageNo 语义即从 1 开始）
 * @returns {Promise<Array>}
 */
async function miguSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const searchSwitch = JSON.stringify({
    song: 1, album: 0, singer: 0, tagSong: 0, mvSong: 0, songlist: 0, bestShow: 1,
  });
  const params = new URLSearchParams({
    ua: API_UA,
    version: API_VERSION,
    text: keyword,
    pageNo: String(Math.max(1, parseInt(page, 10) || 1)),
    pageSize: '20',
    searchSwitch,
  });
  const res = await request(`${SEARCH_HOST}/MIGUM2.0/v1.0/content/search_all.do?${params}`, {
    headers: { Referer: REFERER },
    timeout: 8000,
  });
  const list = (res && res.songResultData && res.songResultData.result) || [];
  return (Array.isArray(list) ? list : []).map(mapSong).filter(Boolean);
}

/**
 * 只取响应头的 Location（never reject，失败返回空串）
 *
 * 为什么必须自己实现而不是用 request()：
 *   1. 咪咕用 305 状态码传直链，request() 把 3xx 当重定向跟随，会把 Location 丢掉
 *   2. request() 会累积 body，而这里只需要响应头
 *   3. GET 无效（返回「暂不提供试听地址」），必须 HEAD
 *
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<string>} location，失败为空串
 */
function headLocation(url, timeout = 8000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return resolve(''); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: { 'User-Agent': STREAM_UA, Accept: '*/*' },
      timeout,
    }, (res) => {
      res.resume(); // 丢弃 body，只留响应头
      resolve(res.headers.location || '');
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

/**
 * 获取下载 URL
 *
 * 流程：HEAD listen-song/v2.3 → Location 直链 → 音频预检。
 * 预检的意义与酷我一致：把「拿得到地址但地址不可用」的情况在取流阶段就暴露，
 * 让上层 getDownloadUrlSmart 能触发换源，而不是把坏链丢给下载器。
 *
 * @param {string} id - contentId
 * @param {string} [quality] - lossless | hq | standard（免登录下服务端不区分）
 * @returns {Promise<{url,ext,br,via}|{error,code,fatal}>}
 */
async function miguGetUrl(id, quality = 'standard') {
  if (!id) return { error: '缺少歌曲 ID', code: 'BAD_PARAMS', fatal: true };
  try {
    const tone = QUALITY_TONE[quality] || QUALITY_TONE.standard;
    const params = new URLSearchParams({
      toneFlag: TONE_FLAG,
      copyrightId: '0', // 免登录路径：必须显式传 0，不传该参数会 500
      contentId: String(id),
      resourceType: RESOURCE_TYPE,
      channel: '0146921',
    });
    const url = await headLocation(`${API_HOST}/strategy/listen-song/v2.3?${params}`);
    if (!/^https?:\/\//.test(url)) {
      return { error: '咪咕暂无可用音源（该歌曲可能需要会员）', code: 'UNAVAILABLE', fatal: true };
    }
    const probe = await testAudioLink(url, { headers: { Referer: REFERER } });
    if (!probe.ok) {
      logger.warn('[migu] 直链预检未通过:', url.slice(0, 80), probe.reason || probe.status);
      return { error: '咪咕音源暂不可用', code: 'CDN_EMPTY', fatal: true };
    }
    return {
      url,
      ext: probe.ext || 'mp3',
      size: probe.sizeBytes,
      br: 128000,
      requestedBr: tone.toneFlag === 'SQ' ? null : 128000,
      via: 'official:listen-song/v2.3',
    };
  } catch (e) {
    logger.warn('[migu] getUrl 失败:', e.message);
    return { error: e.message, code: 'FETCH_FAILED', fatal: false };
  }
}

/**
 * 获取歌词
 *
 * 两步：contentId → resourceinfo.do 拿 lrcUrl → 取回 LRC 文本。
 * （搜索结果里也直接带 lyricUrl，但 getLyrics 只收到 id，故走详情接口。）
 *
 * @param {string} id - contentId
 * @returns {Promise<string>} 标准 LRC 文本；失败返回空串（上层会回落网易云/酷狗）
 */
async function miguGetLyrics(id) {
  if (!id) return '';
  try {
    const info = await request(
      `${API_HOST}/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${encodeURIComponent(id)}&resourceType=2&needSimple=00`,
      { headers: { Referer: REFERER }, timeout: 6000 },
    );
    const res = Array.isArray(info && info.resource) ? info.resource[0] : (info && info.resource);
    const lrcUrl = String((res && res.lrcUrl) || '');
    if (!/^https?:\/\//.test(lrcUrl)) return '';
    const lrc = await request(lrcUrl, { headers: { Referer: REFERER }, timeout: 6000 });
    return typeof lrc === 'string' ? lrc.trim() : '';
  } catch (e) {
    logger.warn('[migu] 歌词获取失败:', e.message);
    return '';
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'migu',
  name: '咪咕音乐',
  nameEn: 'Migu',
  icon: '🎼',
  badge: { bg: 'rgba(167,139,250,.14)', fg: 'var(--neon-purple)', border: 'rgba(167,139,250,.24)' },
  // 网络事实：CORS 白名单由此派生（搜索 pd / 详情与取流 c / 资源 d / 音频 CDN freetyst）
  hosts: {
    origins: [
      'https://pd.musicapp.migu.cn',
      'https://c.musicapp.migu.cn',
      'https://d.musicapp.migu.cn',
      'https://freetyst.nf.migu.cn',
      'https://music.migu.cn',
    ],
  },
  linkPatterns: [],
  policies: { order: 60, fallbackSource: true, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在，capabilities 由此推导）────────
  search: miguSearch,
  getUrl: miguGetUrl,
  getLyrics: miguGetLyrics,

  // ── 老式具名导出（阶段 3 清理前保留，测试与外部调用方在用）──
  miguSearch,
  miguGetUrl,
  miguGetLyrics,
  // 内部纯函数：仅作单测断言入口，不属于对外契约
  _internal: { mapSong, headLocation, QUALITY_TONE },
};
