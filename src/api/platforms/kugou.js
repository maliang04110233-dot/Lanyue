/**
 * 酷狗音乐平台实现
 *
 * 基于酷狗公开 Web API：
 *   - songsearch.kugou.com 搜索
 *   - kugou.com/yy/index.php 获取播放/下载 URL
 *   - lyrics.kugou.com 获取歌词
 */

const request = require('../request');
const logger = require('../../utils/logger');
const { decodeKrc } = require('../../utils/krcCodec');

// 编码/解码三种音质的 hash 到 id
const HASH_SEP = '::';

function encodeKugouId(fileHash, sqHash, hqHash) {
  return `${fileHash}${HASH_SEP}${sqHash || ''}${HASH_SEP}${hqHash || ''}`;
}

function decodeKugouId(encodedId) {
  const parts = encodedId.split(HASH_SEP);
  return {
    fileHash: parts[0] || '',
    sqHash: parts[1] || '',
    hqHash: parts[2] || '',
  };
}

// 随机设备 ID（酷狗需要，用一次生成缓存）
let _mid = '';

function getMid() {
  if (!_mid) {
    _mid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  return _mid;
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<Array>}
 */
async function kugouSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${Number(page) || 1}&pagesize=30&platform=WebFilter`;
  const result = await request(url, { timeout: 10000 });
  const songs = result?.data?.lists || [];
  return songs.map(s => ({
    title: s.SongName || '',
    artist: s.SingerName || '',
    album: s.AlbumName || '',
    cover: s.FileHash
      ? `https://imgessl.kugou.com/stdmusic/${s.FileHash.slice(0, 2)}/${s.FileHash}.jpg`
      : '',
    duration: (s.Duration || 0) * 1000,
    source: 'kugou',
    // 将三种音质的 hash 编码到 id 中，方便 getUrl 按需取用
    id: encodeKugouId(s.FileHash || '', s.SQFileHash || '', s.HQFileHash || ''),
  }));
}

/**
 * 获取下载 URL（使用酷狗移动端 API v3）
 */
async function kugouGetUrl(id, quality = 'standard') {
  const { fileHash, sqHash, hqHash } = decodeKugouId(id);

  let hash = fileHash;
  if (quality === 'lossless' && sqHash) hash = sqHash;
  else if (quality === 'hq' && hqHash) hash = hqHash;

  if (!hash) return { error: '缺少歌曲 hash', fatal: true };

  const extMap = { lossless: 'flac', hq: 'mp3', standard: 'mp3' };
  const ext = extMap[quality] || 'mp3';

  try {
    // 主链路：m.kugou.com 移动端 playInfo（免费曲直接返回 sharefs URL，
    // 付费曲返回 error=需要付费）。原 mobilecdn.kugou.com 在部分网络下
    // DNS 污染（解析到腾讯 CDN，证书不匹配直接 TLS 报错），已弃用。
    let playUrl = '';
    let payError = '';
    const info = await request(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`, { timeout: 10000 });
    if (info && typeof info === 'object') {
      playUrl = info.url || info.play_url || '';
      payError = info.error || '';
    }

    // 备选：trackercdn v2（key=md5(hash+kgcloudv2)）——部分网络下仍可用
    if (!playUrl) {
      try {
        const crypto = require('crypto');
        const key = crypto.createHash('md5').update(hash + 'kgcloudv2').digest('hex').toLowerCase();
        const cdnUrl = `https://trackercdn.kugou.com/i/v2/?appid=1005&pid=2&cmd=25&behavior=play&hash=${encodeURIComponent(hash)}&key=${encodeURIComponent(key)}&br=${quality === 'lossless' ? 2000 : quality === 'hq' ? 320 : 128}&mid=${encodeURIComponent(getMid())}`;
        const cdnResult = await request(cdnUrl, { timeout: 8000 });
        const cdnData = cdnResult?.data || cdnResult || {};
        if (cdnData.play_url) playUrl = cdnData.play_url;
      } catch (_e) { /* 备选失败走降级链 */ }
    }

    // 降级链：无损拿不到试 HQ，HQ 拿不到试标准
    if (!playUrl && quality === 'lossless') return kugouGetUrl(id, 'hq');
    if (!playUrl && quality === 'hq') return kugouGetUrl(id, 'standard');
    if (!playUrl) {
      // playInfo 明确说付费：版权错误码。文案只说本源没有整曲音源 ——
      // 跨源换源自af84b70 起默认关闭（fallbackPolicy.crossSourceEnabled），
      // 这里再写「已自动尝试其他源」就是在撒谎。
      if (payError && /付费|VIP|版权/.test(payError)) {
        return {
          error: `酷狗：${payError}（该曲需付费或会员，本源无整曲音源）`,
          code: 'COPYRIGHT_RESTRICTED',
          fatal: false,
        };
      }
      return {
        error: '酷狗音源获取受限（反爬保护），请改用网易云/QQ音乐/B站搜索相同歌曲下载',
        code: 'PLATFORM_CHANGED',
        fatal: true,
      };
    }

    return { url: playUrl, ext };
  } catch (e) {
    logger.warn('[kugou] getPlayUrl 失败:', e.message);
    return { error: e.message || '请求失败' };
  }
}

/**
 * 歌词链路核心：按歌曲 hash 搜候选 → 下载 → （官方 KRC 时）逐字解码。
 *
 * ⚠️ 2026-09-18 实测修正三处旧 bug（此前酷狗歌词在真实请求下**完全拿不到**）：
 *   - search 必须带 `hash=`（纯 keyword 端点返回 0 候选），`lrctxt=1` 才会给出
 *     krctype 字段；
 *   - 候选字段/下载参数是 `accesskey`（全小写），旧代码写的 accessToken 取不到值；
 *   - 官方候选（krctype=1 且 contenttype≠1）只有 fmt=krc 有内容，格式为
 *     base64+XOR+zlib 封装的逐字歌词（解码在 utils/krcCodec）。
 *
 * @param {string} fileHash 酷狗歌曲 hash（非编码 id）
 * @param {number} [timelengthMs] 歌曲时长（毫秒，可选，提高匹配度）
 * @returns {Promise<{lrc:string, karaoke?:Object}>}
 */
async function fetchLyricByHash(fileHash, timelengthMs = 0) {
  if (!fileHash) return { lrc: '' };
  const timelength = timelengthMs > 0 ? `&timelength=${Number(timelengthMs) || 0}` : '';
  const searchUrl = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(fileHash)}&hash=${encodeURIComponent(fileHash)}&lrctxt=1${timelength}`;
  const searchResult = await request(searchUrl, { timeout: 8000 });
  const candidates = searchResult?.candidates || [];
  if (!candidates.length || !candidates[0].id) return { lrc: '' };

  const first = candidates[0];
  const fmt = (Number(first.krctype) === 1 && Number(first.contenttype) !== 1) ? 'krc' : 'lrc';
  const dlUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(first.id)}&accesskey=${encodeURIComponent(first.accesskey || '')}&fmt=${fmt}&charset=utf8`;
  const dl = await request(dlUrl, { timeout: 8000 });
  const content = dl?.content || '';
  if (!content) return { lrc: '' };

  if (fmt === 'krc') {
    try {
      const { parsed, lrc } = decodeKrc(content);
      return { lrc, karaoke: parsed };
    } catch (e) {
      logger.warn('[kugou] KRC 解码失败（不影响其余链路）:', e.message);
      return { lrc: '' };
    }
  }
  // 酷狗 lrc 内容为 base64 编码
  try {
    return { lrc: Buffer.from(content, 'base64').toString('utf-8') };
  } catch {
    return { lrc: content };
  }
}

/**
 * 获取歌词（按歌曲 id）。返回 { lrc, karaoke? }。
 * @param {string} id - encodeKugouId 编码的三 hash 串
 */
async function kugouGetLyrics(id) {
  if (!id) return { lrc: '' };
  try {
    const { fileHash } = decodeKugouId(id);
    return await fetchLyricByHash(fileHash);
  } catch (e) {
    logger.warn('酷狗获取歌词失败:', e.message);
    return { lrc: '' };
  }
}

/**
 * 按「歌名+歌手」取歌词：先歌曲搜索解析出 hash 与时长，再走同一歌词链路。
 */
async function kugouGetLyricsByTitle(title, artist) {
  if (!title) return { lrc: '' };
  try {
    const songs = await kugouSearch(`${title} ${artist || ''}`.trim(), 1);
    if (!songs.length) return { lrc: '' };
    const { fileHash } = decodeKugouId(songs[0].id);
    return await fetchLyricByHash(fileHash, songs[0].duration || 0);
  } catch (e) {
    logger.warn('酷狗歌词 fallback 搜索失败:', e.message);
    return { lrc: '' };
  }
}

/**
 * 搜索专辑
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{albums: Array, total: number, page: number}>}
 */
async function kugouSearchAlbum(keyword, page = 1) {
  const url = `https://mobilecdn.kugou.com/api/v3/search/album?keyword=${encodeURIComponent(keyword)}&page=${Number(page) || 1}&pagesize=30&sort=1`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  const total = result?.data?.total || 0;
  return {
    albums: list.map(a => ({
      id: String(a.albumid || a.albumID || ''),
      mid: String(a.albumid || a.albumID || ''),
      title: a.albumname || a.albumName || '',
      artist: a.singername || a.singerName || '',
      cover: a.imgurl || (a.albumid ? `https://imgessl.kugou.com/album/${String(a.albumid).slice(0, 2)}/${a.albumid}.jpg` : ''),
      songCount: a.songcount || a.songCount || 0,
      publishTime: (a.publishtime || a.publishTime || '').replace(/\s.*$/, ''),
      source: 'kugou',
    })),
    total,
    page,
  };
}

/**
 * 搜索歌手
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{singers: Array, total: number, page: number}>}
 */
async function kugouSearchSinger(keyword, page = 1) {
  const url = `https://mobilecdn.kugou.com/api/v3/search/singer?keyword=${encodeURIComponent(keyword)}&page=${Number(page) || 1}&pagesize=10`;
  const result = await request(url, { timeout: 10000 });
  const list = Array.isArray(result?.data) ? result.data : (result?.data?.info || []);
  const total = result?.data?.total || list.length;
  return {
    singers: list.map(s => ({
      id: String(s.singerid || s.singerID || s.id || ''),
      mid: String(s.singerid || s.singerID || s.id || ''),
      name: s.singername || s.singerName || '',
      avatar: s.imgurl || s.pic || s.imgsmall || '',
      songCount: s.songcount || s.songCount || 0,
      albumCount: s.albumcount || s.albumCount || 0,
      source: 'kugou',
    })),
    total,
    page,
  };
}

/**
 * 获取专辑内歌曲
 * @param {string|number} albumId
 * @param {number} limit
 */
async function kugouGetAlbumSongs(albumId, limit = 999) {
  const url = `https://mobilecdn.kugou.com/api/v3/album/song?albumid=${encodeURIComponent(albumId)}&page=1&pagesize=${encodeURIComponent(limit)}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  return list.map(s => {
    const parts = (s.filename || s.songname || '').split(' - ');
    const title = parts.length > 1 ? parts.slice(1).join(' - ') : (s.filename || '');
    const artist = parts.length > 1 ? parts[0] : '';
    return {
      id: (s.hash || '') + '::' + (s.sqhash || '') + '::' + (s.hqhash || ''),
      title,
      artist,
      album: s.album_name || '',
      cover: s.imgurl || (s.hash ? `https://imgessl.kugou.com/stdmusic/${s.hash.slice(0, 2)}/${s.hash}.jpg` : ''),
      duration: (s.duration || 0) * 1000,
      source: 'kugou',
    };
  });
}

/**
 * 获取歌手热门歌曲
 */
async function kugouGetSingerSongs(singerId, limit = 50) {
  const url = `https://mobilecdn.kugou.com/api/v3/singer/song?singerid=${encodeURIComponent(singerId)}&page=1&pagesize=${encodeURIComponent(Math.min(limit, 100))}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  return list.slice(0, limit).map(s => {
    const parts = (s.filename || '').split(' - ');
    const title = parts.length > 1 ? parts.slice(1).join(' - ') : (s.filename || '');
    const artist = parts.length > 1 ? parts[0] : '';
    return {
      id: (s.hash || '') + '::' + (s.sqhash || '') + '::' + (s.hqhash || ''),
      title,
      artist,
      album: s.album_name || '',
      cover: s.imgurl || (s.hash ? `https://imgessl.kugou.com/stdmusic/${s.hash.slice(0, 2)}/${s.hash}.jpg` : ''),
      duration: (s.duration || 0) * 1000,
      source: 'kugou',
    };
  });
}

/**
 * 获取歌手专辑列表
 */
async function kugouGetSingerAlbums(singerId, pageNo = 1, pageSize = 20) {
  const url = `https://mobilecdn.kugou.com/api/v3/singer/album?singerid=${encodeURIComponent(singerId)}&page=${encodeURIComponent(pageNo)}&pagesize=${encodeURIComponent(pageSize)}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  const total = result?.data?.total || 0;
  return {
    albums: list.map(a => ({
      id: String(a.albumid || a.albumID || ''),
      mid: String(a.albumid || a.albumID || ''),
      title: a.albumname || a.albumName || '',
      artist: a.singername || a.singerName || '',
      cover: a.imgurl || (a.albumid ? `https://imgessl.kugou.com/album/${String(a.albumid).slice(0, 2)}/${a.albumid}.jpg` : ''),
      songCount: a.songcount || a.songCount || 0,
      publishTime: (a.publishtime || a.publishTime || '').replace(/\s.*$/, ''),
      source: 'kugou',
    })),
    total,
    page: pageNo,
  };
}

/**
 * 榜单名 → rankid 映射。
 *
 * 与 netease 的 NETEASE_TOP_MAP 同一约定：榜单是**产品配置**（投放哪几个榜
 * 是产品决定），不是平台能力，故不能由 registry 推导，只能显式声明。
 *
 * rankid 取自 `https://m.kugou.com/rank/list&json=true`（实测返回 55 个榜单），
 * 这里只登记要上首页的四个，与 netease 的「飙升/热歌/新歌/原创」四榜对齐。
 */
const KUGOU_TOP_MAP = {
  飙升榜: 6666,
  网络热歌榜: 82831,
  短视频热歌榜: 52144,
  TOP500: 8888,
};

/**
 * 榜单分页固定 30 条/页 —— 接口的 pagesize 由服务端决定（实测恒为 30），
 * 传 pagesize 参数不生效。故「取 100 条」需要分页请求，见 kugouGetTopList。
 */
const KUGOU_RANK_PAGE_SIZE = 30;

/**
 * 把榜单接口的歌曲条目转成标准歌曲对象。
 *
 * 字段来源（实测 m.kugou.com/rank/info）：
 *   - songname            「甲乙丙丁 (你我怎么两清)」——标题
 *   - h5_author_name      「李佳薇」——歌手（单独字段，无需从 filename 切分）
 *   - hash/sqhash/320hash 三种音质的 hash，直接喂 encodeKugouId 让下载侧择优
 *   - album_sizable_cover 形如 http://imge.kugou.com/stdmusic/{size}/xxx.jpg
 *   - duration            单位是**秒**（标准图谱里 duration 是毫秒，此处必须 ×1000）
 *   - album_id            专辑 ID
 *
 * ⚠️ 封面 URL **必须把 http 升级为 https**：榜单接口下发的是 `http://imge.kugou.com/...`，
 *    而渲染进程处于 https 上下文，混合内容会被直接拦掉（图全裂）。
 *    实测 https 下同一路径返回 200 image/jpeg。{size} 占位符替换为 240
 *    （榜单行封面实际渲染 36px，取 240 是为 2x/3x 屏留余量）。
 */
function kugouRankItemToSong(s) {
  if (!s || typeof s !== 'object') return null;
  const fileHash = s.hash || '';
  if (!fileHash) return null;

  const title = s.songname || s.filename || '';
  if (!title) return null;

  // 歌手优先取 h5_author_name；缺失时从 filename 的 "歌手 - 歌名" 里切
  let artist = s.h5_author_name || '';
  if (!artist && s.filename && String(s.filename).includes(' - ')) {
    artist = String(s.filename).split(' - ')[0];
  }

  return {
    id: encodeKugouId(fileHash, s.sqhash || '', s['320hash'] || ''),
    title,
    artist,
    album: s.remark || '',
    albumMid: s.album_id ? String(s.album_id) : '',
    cover: kugouNormalizeCover(s.album_sizable_cover),
    duration: (s.duration || 0) * 1000,
    source: 'kugou',
  };
}

/**
 * 封面 URL 规范化：http → https，并把 {size} 占位符换成分辨率。
 * @param {string} url
 * @param {number} [size]
 * @returns {string} 不可用时返回空串（渲染层会走 SVG 占位，不留裂图）
 */
function kugouNormalizeCover(url, size = 240) {
  if (!url || typeof url !== 'string') return '';
  return url.replace('{size}', String(size)).replace(/^http:\/\//i, 'https://');
}

/**
 * 排行榜曲目。
 *
 * @param {string|number} name - 榜单名（见 KUGOU_TOP_MAP）或直接给 rankid
 * @param {number} limit - 期望条数；酷狗单页固定 30，超出则翻页拉取
 * @returns {Promise<Array>} 标准歌曲对象数组；失败返回 []
 */
async function kugouGetTopList(name, limit = 30) {
  const rankId = typeof name === 'number' ? name : KUGOU_TOP_MAP[name];
  if (!rankId) return [];

  try {
    const want = Math.max(1, limit);
    const pages = Math.ceil(want / KUGOU_RANK_PAGE_SIZE);
    const out = [];

    // 串行翻页：酷狗对同域并发较敏感，且首页一次只要 30 条（1 页），
    // 多页只发生在「查看完整榜单」弹窗里，慢一点可接受。
    for (let page = 1; page <= pages; page++) {
      const url = `https://m.kugou.com/rank/info/?rankid=${encodeURIComponent(rankId)}&page=${encodeURIComponent(page)}&json=true`;
      const result = await request(url, { timeout: 10000 });
      const list = result?.songs?.list || [];
      if (!list.length) break; // 翻到底了
      for (const raw of list) {
        const song = kugouRankItemToSong(raw);
        if (song) out.push(song);
      }
      if (out.length >= want) break;
    }

    return out.slice(0, want);
  } catch (e) {
    logger.warn(`[kugou] getTopList 失败 (rankid=${rankId}):`, e.message || e);
    return [];
  }
}

/**
 * 榜单清单（供 UI 展示可选榜单，或验证 rankid 是否仍有效）。
 *
 * 之所以单独提供：酷狗的 rankid 是**服务端下发的**，可能随运营调整而失效。
 * 硬编码映射一旦过期就会静默返回空榜单 —— 这个方法让「榜单还有效吗」
 * 可被主动查询，而不是只能靠用户发现首页空了。
 *
 * @returns {Promise<Array<{id:string,name:string,cover:string}>>}
 */
async function kugouGetRankList() {
  try {
    const result = await request('https://m.kugou.com/rank/list&json=true', { timeout: 10000 });
    const list = result?.rank?.list || [];
    return list.map(r => ({
      id: String(r.rankid || ''),
      name: r.rankname || '',
      cover: kugouNormalizeCover(r.img_9 || r.banner_9 || ''),
      source: 'kugou',
    })).filter(r => r.id && r.name);
  } catch (e) {
    logger.warn('[kugou] getRankList 失败:', e.message || e);
    return [];
  }
}

/**
 * 推荐歌单。
 *
 * 酷狗**没有**「个性化推荐歌单」这类接口（不同于 netease 的 personalized /
 * QQ 的 recommend）。可用的是歌单广场：
 *   https://m.kugou.com/plist/index&json=true
 * 返回官方精选歌单（实测 total=600，每页 30，带 has_next 可供翻页），
 * 语义上最接近「推荐歌单」。
 *
 * 响应结构（实测，与初版猜测的嵌套完全不同 —— 故此处按真实结构解析）：
 *   { plist: { list: { total, has_next, info: [ 歌单, ... ] } } }
 *                          ^^^^ info 是**直接数组**，不是 list[].list.info
 *
 * 歌单条目字段（实测）：
 *   specialid      数字 ID（下载侧要的）
 *   specialname    歌单名
 *   imgurl         封面，含 {size} 占位符
 *   playcount      播放量（另有 play_count_text 是「1048.3万」这种已格式化串）
 *   songcount      曲目数
 *
 * 若后续发现更合适的接口，只需替换本函数体，manifest 与 UI 都不用动。
 *
 * @param {number} limit
 * @returns {Promise<Array<{id,name,cover,playCount,source}>>}
 */
async function kugouGetRecommendPlaylists(limit = 30) {
  try {
    const result = await request('https://m.kugou.com/plist/index&json=true', { timeout: 10000 });
    const info = result?.plist?.list?.info || [];
    return info
      .filter(p => p && (p.specialid || p.global_specialid))
      .map(p => ({
        id: String(p.specialid || p.global_specialid),
        name: p.specialname || p.intro || '',
        cover: kugouNormalizeCover(p.imgurl || '', 300),
        playCount: p.playcount || 0,
        songCount: p.songcount || 0,
        source: 'kugou',
      }))
      .filter(p => p.name)
      .slice(0, limit);
  } catch (e) {
    logger.warn('[kugou] getRecommendPlaylists 失败:', e.message || e);
    return [];
  }
}

/**
 * 按 hash 拉单曲详情（粘贴链接智能识别用）
 *
 * 链接里只有单 hash（无 SQ/HQ hash），id 用 encodeKugouId(hash,'','') 编码——
 * kugouGetUrl 对缺失的高品质 hash 已有降级处理。
 * @param {string} hash 歌曲 FileHash
 * @returns {Promise<object|null>} 标准歌曲对象，拉不到返回 null
 */
async function kugouGetSongDetail(hash) {
  if (!hash) return null;
  try {
    const url = `https://mobilecdn.kugou.com/api/v3/song/detail?hash=${encodeURIComponent(hash)}&mid=${encodeURIComponent(getMid())}`;
    const detail = await request(url, { timeout: 10000 });
    const info = detail?.data?.info?.[0] || detail?.data || {};
    if (!info || (!info.hash && !info.FileName && !info.songname)) return null;
    // 接口同时回传 SQ/HQ hash 时编码进 id，下载侧可上更高音质
    const fileHash = info.hash || hash;
    const sqHash = info.sq_hash || info.SQFileHash || '';
    const hqHash = info.hq_hash || info.HQFileHash || '';
    const title = info.songname || info.FileName || (info.filename ? String(info.filename).split(' - ').pop() : '');
    if (!title) return null;
    return {
      id: encodeKugouId(fileHash, sqHash, hqHash),
      title,
      artist: info.singername || info.SingerName || '',
      album: info.albumname || info.AlbumName || '',
      cover: fileHash
        ? `https://imgessl.kugou.com/stdmusic/${String(fileHash).slice(0, 2)}/${fileHash}.jpg`
        : '',
      duration: (info.duration || info.Duration || 0) * 1000,
      source: 'kugou',
    };
  } catch (e) {
    logger.warn(`[kugou] song detail 失败 (hash=${String(hash).slice(0, 12)}...):`, e.message || e);
    return null;
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'kugou',
  name: '酷狗音乐',
  nameEn: 'Kugou',
  icon: '🎸',
  badge: { bg: 'rgba(16,185,129,.14)', fg: 'var(--c-ok)', border: 'rgba(16,185,129,.22)' },
  // 酷狗音频域有多个动态前缀，精确枚举不完，故额外做后缀匹配
  hosts: {
    origins: ['https://www.kugou.com'],
    originSuffixes: ['.kugou.com'],
  },
  linkPatterns: [
    // 单曲：mixsong/12345.html（数字即 id）
    { type: 'song', re: /kugou\.com\/mixsong\/(\d{4,15})\.html/, extract: m => m[1] },
    // 单曲：/song/xxx.html?hash=YYYY（hash 即 id）
    { type: 'song', re: /kugou\.com\/song\/[a-z0-9]+\.html\?hash=([A-Fa-f0-9]{20,40})/, extract: m => m[1] },
    // 专辑：/album/xxx.html（slug 型 id，保持原样）
    { type: 'album', re: /kugou\.com\/album\/([a-z0-9_-]{6,40})\.html/, extract: m => m[1] },
  ],
  policies: { order: 40, fallbackSource: true, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: kugouSearch,
  getUrl: kugouGetUrl,
  getLyrics: kugouGetLyrics,
  // 按标题兜底取词：供 api/index 的歌词 fallback 遍历（原先是被直连的私有函数）
  getLyricsByTitle: kugouGetLyricsByTitle,
  getSongDetail: kugouGetSongDetail,
  searchAlbum: kugouSearchAlbum,
  getAlbumSongs: kugouGetAlbumSongs,
  searchSinger: kugouSearchSinger,
  getSingerSongs: kugouGetSingerSongs,
  getSingerAlbums: kugouGetSingerAlbums,
  // 推荐域（2026-09-18 补齐）：此前酷狗只实现 search 三件套，
  // 首页推荐页因此覆盖不到它。方法存在即能力存在 —— 补上这三个，
  // registry 会自动推导出 topList / recommendPlaylists 能力位，
  // gateway 的 recommendCall 立即可用，无需改动 gateway 或 UI。
  getTopList: kugouGetTopList,
  getRecommendPlaylists: kugouGetRecommendPlaylists,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  kugouSearch,
  kugouGetUrl,
  kugouGetSongDetail,
  kugouGetLyrics,
  kugouGetLyricsByTitle,
  kugouSearchAlbum,
  kugouSearchSinger,
  kugouGetAlbumSongs,
  kugouGetSingerSongs,
  kugouGetSingerAlbums,
  kugouGetTopList,
  kugouGetRankList,
  kugouGetRecommendPlaylists,
  KUGOU_TOP_MAP,
  // 内部纯函数：仅作单测断言入口，不属于对外契约
  _internal: {
    encodeKugouId,
    decodeKugouId,
    kugouRankItemToSong,
    kugouNormalizeCover,
    KUGOU_TOP_MAP,
    KUGOU_RANK_PAGE_SIZE,
  },
};
