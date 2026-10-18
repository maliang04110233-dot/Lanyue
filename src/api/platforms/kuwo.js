/**
 * 酷我音乐平台实现（参考 musicdl 的 kuwo 源 + 实测校准）
 *
 * 数据面（2026-09-16 复测）：
 *   - 搜索: 官方 web 接口 searchMusicBykeyWord —— 可用（返回 30 条）
 *   - 下载: antiserver 官方直链，免费 128k mp3 —— 可用（经 testAudioLink 预检：
 *           status 200 / audio/mpeg；无版权曲返回 200 + text/plain，预检识别为 not-audio）
 *   - 中转无损: kw-api.cenguigui.cn —— DNS 已失效，保留作恢复位
 *   - 歌词: m.kuwo.cn get_lrc —— 可用（返回 44 行，输出标准 LRC）
 */

const request = require('../request');
const { asSong } = require('../songShape');
const { testAudioLink } = require('../request');
const logger = require('../../utils/logger');
const { USER_AGENT } = require('../../utils/userAgent');

const HEADERS = { 'User-Agent': USER_AGENT };

/** MUSIC_228908 → 228908 */
function normalizeId(rid) {
  return String(rid || '').replace(/^MUSIC_/i, '');
}

function coverUrl(s) {
  const raw = s.hts_MVPIC || s.albumpic || s.web_albumpic_short || s.pic || '';
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) return raw;
  // web_albumpic_short 是相对路径（如 albumcover/xx/yy/zz.jpg）
  return raw.startsWith('albumcover') ? 'https://img4.kuwo.cn/star/' + raw : raw;
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page - 从 1 开始
 * @returns {Promise<Array>}
 */
async function kuwoSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const params = new URLSearchParams({
    vipver: '1', client: 'kt', ft: 'music', cluster: '0', strategy: '2012',
    encoding: 'utf8', rformat: 'json', mobi: '1', issubtitle: '1',
    show_copyright_off: '1', pn: String(Math.max(0, page - 1)), rn: '30', all: keyword,
  });
  const res = await request(`http://www.kuwo.cn/search/searchMusicBykeyWord?${params}`, {
    headers: HEADERS,
    timeout: 8000,
  });
  const list = res?.abslist || [];
  return list
    .map((s) => asSong({
      id: normalizeId(s.MUSICRID || s.musicrid),
      title: String(s.SONGNAME || s.songName || '').replace(/<[^>]+>/g, '').trim(),
      artist: String(s.ARTIST || s.artist || '').replace(/&amp;/g, ', ').trim(),
      album: String(s.ALBUM || s.album || '').replace(/&amp;/g, ', ').trim(),
      cover: coverUrl(s),
      // 源单位是秒（DURATION），折算成约定的毫秒
      duration: (parseInt(s.DURATION || s.duration, 10) || 0) * 1000,
      source: 'kuwo',
    }))
    .filter((s) => s.id);
}

/**
 * 中转无损解析（当前失效，保留作恢复位——中转站复活后无需改代码自动生效）
 * @returns {Promise<{url,ext,size}|null>}
 */
async function relayLossless(id) {
  try {
    const res = await request(`https://kw-api.cenguigui.cn/?id=${encodeURIComponent(id)}&type=song&level=lossless&format=json`, {
      headers: HEADERS, timeout: 6000, retries: 0,
    });
    const d = res?.data || {};
    if (!d.url || !/^https?:\/\//.test(d.url)) return null;
    // M7: 中转站是第三方服务，其响应不可信 —— 返回的直链只接受 kuwo 自家
    // 域名，否则等于它可指挥本应用请求任意主机
    let host = '';
    try { host = new URL(d.url).hostname; } catch (_e) { return null; }
    if (!/(^|\.)kuwo\.cn$/i.test(host)) {
      logger.warn('[kuwo] 中转返回非 kuwo 域直链，丢弃:', host);
      return null;
    }
    const test = await testAudioLink(d.url, { headers: { Referer: 'http://www.kuwo.cn/' } });
    if (!test.ok) return null;
    return { url: d.url, ext: test.ext, size: test.sizeBytes, via: 'relay:cenguigui' };
  } catch (e) {
    logger.warn('[kuwo] 中转解析失败:', e.message);
    return null;
  }
}

/**
 * 官方 antiserver 直链（免费 128k mp3）
 * 返回纯文本 URL；无版权时返回 "refuse request!" 之类文本
 * @returns {Promise<{url,ext}|null>}
 */
async function antiserverMp3(id) {
  const res = await request(
    `http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_${encodeURIComponent(id)}`,
    { headers: HEADERS, timeout: 8000 },
  );
  const url = String(res || '').trim();
  if (!/^https?:\/\//.test(url)) return null;
  return { url, ext: 'mp3' };
}

/**
 * 获取下载 URL
 * 品质策略：lossless/hq 先试中转无损（失败自动落到官方 128k），standard 直接官方
 * @param {string} id
 * @param {string} quality - lossless | hq | standard
 * @returns {Promise<{url,ext,size,via}|{error,code,fatal}>}
 */
async function kuwoGetUrl(id, quality = 'standard') {
  if (!id) return { error: '缺少歌曲 ID', code: 'BAD_PARAMS', fatal: true };
  try {
    const wantLossless = quality === 'lossless' || quality === 'hq';
    if (wantLossless) {
      const relayed = await relayLossless(id);
      if (relayed) {
        logger.log(`[kuwo] 中转命中: ${relayed.via} ext=${relayed.ext}`);
        return { ...relayed, br: null, requestedBr: null };
      }
    }
    const official = await antiserverMp3(id);
    if (official) {
      const test = await testAudioLink(official.url, { headers: { Referer: 'http://www.kuwo.cn/' } });
      if (test.ok) {
        return { ...official, size: test.sizeBytes, br: 128000, requestedBr: 128000, via: 'official:antiserver' };
      }
      logger.warn('[kuwo] antiserver 直链预检未通过:', official.url.slice(0, 60));
    }
    return { error: '酷我暂无可用音源（该歌曲可能无版权）', code: 'UNAVAILABLE', fatal: true };
  } catch (e) {
    logger.warn('[kuwo] getUrl 失败:', e.message);
    return { error: e.message, code: 'FETCH_FAILED', fatal: false };
  }
}

/**
 * 酷我 lrclist → 标准 LRC 文本
 *
 * 必须输出 [mm:ss.xx]文本 形式：渲染层 parseLrc 的正则只认带方括号的时间轴，
 * 缺方括号会让整段歌词被静默丢弃（回归保护见 test/kuwo.test.js）。
 * lineTimeStr 本身已是 mm:ss.xx，直接套括号；时间或文本为空的行剔除。
 * @param {Array<{lineTimeStr?:string, lineLyric?:string}>} lines
 * @returns {string}
 */
function lrcFromLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => {
      const t = String(l?.lineTimeStr || '').trim();
      const txt = String(l?.lineLyric || '').trim();
      return t && txt ? `[${t}]${txt}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 获取歌词（m.kuwo.cn get_lrc，2026-09-16 实测可用，返回 44 行）
 * @param {string} id
 * @returns {Promise<string>} 标准 LRC 文本；失败返回空串
 */
async function kuwoGetLyrics(id) {
  if (!id) return '';
  try {
    const res = await request(`http://m.kuwo.cn/newh5/singsong/get_lrc?rid=${encodeURIComponent(id)}`, {
      headers: HEADERS, timeout: 6000,
    });
    return lrcFromLines(res?.data?.lrclist);
  } catch (e) {
    logger.warn('[kuwo] 歌词获取失败:', e.message);
    return '';
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'kuwo',
  name: '酷我音乐',
  nameEn: 'Kuwo',
  icon: '🎧',
  badge: { bg: 'rgba(46,127,255,.14)', fg: 'var(--c-info)', border: 'rgba(46,127,255,.22)' },
  // 网络事实：搜索(www) / 取流(antiserver) / 歌词(m) / 封面(img4)
  hosts: {
    origins: [
      'http://www.kuwo.cn',
      'http://antiserver.kuwo.cn',
      'http://m.kuwo.cn',
      'https://img4.kuwo.cn',
    ],
  },
  linkPatterns: [],
  policies: { order: 50, fallbackSource: true, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: kuwoSearch,
  getUrl: kuwoGetUrl,
  getLyrics: kuwoGetLyrics,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  kuwoSearch,
  kuwoGetUrl,
  kuwoGetLyrics,
  // 内部纯函数：仅作单测断言入口，不属于对外契约
  _internal: { normalizeId, coverUrl, lrcFromLines },
};
