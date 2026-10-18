/**
 * 5sing 原创音乐平台实现（2026-09-17 实测校准，非猜测）
 *
 * 5sing 是酷狗旗下的原创/翻唱基地 —— 曲库与主流平台**互补**（不计入版权曲），
 * 且提供真实三档音质（含无损 SQ），是现有音源里少数能免登录拿到无损的源。
 *
 * ── 三项能力的真实契约 ──────────────────────────────────────
 *
 * 搜索  GET search.5sing.kugou.com/home/json
 *         ?keyword=<kw>&sort=1&page=<n>&filter=0&type=0
 *       必带 Referer: https://5sing.kugou.com/
 *       → { list: [{ songId, songName, singer, typeEname, typeName, ... }], pageInfo }
 *       ⚠️ songName 内嵌高亮标签（搜索「稻香」得到 `<em class="keyword">稻香</em>`），
 *          必须剥 HTML —— 否则歌名带着标签进 UI 和文件名。
 *
 * 取流  GET mobileapi.5sing.kugou.com/song/getSongUrl?songid=<id>&songtype=<type>
 *       → data.{sq,hq,lq}url + 各自的 url_backup / md5 / size / ext
 *       ⚠️ songtype **必填且必须正确**：缺失或传错（实测传 bz/yc）服务端一律
 *          返回 code=28「歌曲不存在」且三档 url 全空。因此 id 必须编码 songtype。
 *       ⚠️ 三档是**真的不同文件**（实测 sq=无损 / hq=5.4MB / lq=3.6MB），按
 *          sq→hq→lq 顺序试；大量曲目只有 lq，所以必须逐级降级。
 *
 * 歌词  GET mobileapi.5sing.kugou.com/song/newget
 *         ?songid=<id>&songtype=<type>&songfields=&userfields=
 *       → data.dynamicWords（标准 LRC）
 *       ⚠️ 约半数曲目该字段为空串（实测 5 个关键词 × 3 条样本，空/非空各半）
 *          —— 空字符串要走回落，不要当作"没歌词"报错。同接口还回
 *          user.I（歌手头像，可作封面）与 user.NN（昵称）。
 *
 * ── 两个必须知道的限制 ──────────────────────────────────────
 *   1. 搜索接口**不返回时长**，故 duration 恒为 0。跨源匹配的时长项因此失效，
 *      仍可靠「歌名 + 歌手」命中 2 分门槛（见 utils/matchMusic.js）。
 *   2. 搜索接口**不返回封面**，故 cover 恒为空串（详情接口才有 user.I，
 *      但 getLyrics 契约只返回字符串，不为此多打一次请求）。
 */

const request = require('../request');
const { asSong } = require('../songShape');
const { testAudioLink } = require('../request');
const logger = require('../../utils/logger');

const SEARCH_HOST = 'http://search.5sing.kugou.com';
const API_HOST = 'http://mobileapi.5sing.kugou.com';
const REFERER = 'https://5sing.kugou.com/';
const HEADERS = { Referer: REFERER };

/** 音质档位：sq 无损 / hq 320k / lq 128k（三档对应三个不同文件） */
const QUALITY_ORDER = ['sq', 'hq', 'lq'];
const QUALITY_BR = { sq: null, hq: 320000, lq: 128000 };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/**
 * 剥 HTML 标签与实体（歌名/歌手里的高亮标签必须清掉）
 *
 * 实体替换用单次正则 + 映射表，而不是顺序 replace：顺序替换会把
 * `&amp;lt;` 二次解码成 `<`，单次扫描则正确地停在 `&lt;`。
 *
 * @param {*} s
 * @returns {string}
 */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * id 编码：`<songId>_<typeEname>`
 *
 * 为什么必须带 typeEname：取流接口的 songtype 是路径选择参数（fc 翻唱 / bz 伴奏 /
 * yc 原创走不同分支），缺失或错误一律「歌曲不存在」。项目对外契约是单一 id
 * （getUrl(id) / getLyrics(id) 只收一个参数），故把两者拼进 id。
 *
 * 顺序选 `songId_type` 而非 `type_songId`：万一某处对 id 做 parseInt，
 * 前者解析出正确的 songId，后者得到 NaN。
 *
 * @param {string|number} songId
 * @param {string} type
 * @returns {string}
 */
function encodeId(songId, type) {
  return `${String(songId)}_${String(type)}`;
}

/**
 * id 解码（形状不合法返回 null，由调用方转成 BAD_PARAMS）
 * @param {string} id
 * @returns {{songId:string,type:string}|null}
 */
function decodeId(id) {
  const s = String(id == null ? '' : id);
  const i = s.lastIndexOf('_');
  if (i <= 0 || i === s.length - 1) return null;
  const songId = s.slice(0, i);
  const type = s.slice(i + 1);
  if (!/^\d+$/.test(songId) || !/^[a-z]{2}$/i.test(type)) return null;
  return { songId, type };
}

/**
 * 搜索结果条目 → 项目统一歌曲结构
 *
 * ⚠️ 伴奏曲的 singer 字面值是字符串 "NULL"，要归一成空串 —— 否则会作为
 * 歌手名进入跨源匹配（normalizeArtists 后得到 "null"）与文件名。
 *
 * @param {object} s
 * @returns {{id,title,artist,album,cover,duration,source}|null}
 */
function mapSong(s) {
  const songId = String(s?.songId ?? '').trim();
  const type = String(s?.typeEname ?? '').trim();
  if (!/^\d+$/.test(songId) || !type) return null;
  const title = stripHtml(s.songName);
  if (!title) return null;
  const singer = stripHtml(s.singer);
  return asSong({
    id: encodeId(songId, type),
    title,
    artist: /^null$/i.test(singer) ? '' : singer,
    album: '',
    cover: '',
    duration: 0, // 搜索接口不返回时长（约定恒为毫秒，见 ../songShape.js）
    source: 'fivesing',
  });
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page - 从 1 开始
 * @returns {Promise<Array>}
 */
async function fivesingSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const params = new URLSearchParams({
    keyword,
    sort: '1',
    page: String(Math.max(1, parseInt(page, 10) || 1)),
    filter: '0',
    type: '0',
  });
  const res = await request(`${SEARCH_HOST}/home/json?${params}`, { headers: HEADERS, timeout: 8000 });
  const list = (res && res.list) || (res && res.data && res.data.list) || [];
  return (Array.isArray(list) ? list : []).map(mapSong).filter(Boolean);
}

/**
 * 获取下载 URL
 *
 * 品质策略：按 quality 决定**起始档位**，随后逐级降级（大量曲目只有 lq，
 * 不做降级会误判为「无音源」）。每档先试主链再试 backup 域。
 *
 * @param {string} id - `<songId>_<typeEname>`
 * @param {string} [quality] - lossless | hq | standard
 * @returns {Promise<{url,ext,size,br,via}|{error,code,fatal}>}
 */
async function fivesingGetUrl(id, quality = 'standard') {
  const parsed = decodeId(id);
  if (!parsed) return { error: '缺少歌曲 ID', code: 'BAD_PARAMS', fatal: true };
  try {
    const res = await request(
      `${API_HOST}/song/getSongUrl?songid=${encodeURIComponent(parsed.songId)}&songtype=${encodeURIComponent(parsed.type)}`,
      { headers: HEADERS, timeout: 8000 },
    );
    const d = (res && res.data) || {};

    const start = quality === 'lossless' ? 0 : quality === 'hq' ? 1 : 2;
    for (let i = start; i < QUALITY_ORDER.length; i++) {
      const q = QUALITY_ORDER[i];
      const primary = String(d[`${q}url`] || '').trim();
      const backup = String(d[`${q}url_backup`] || '').trim();
      for (const cand of [primary, backup]) {
        if (!/^https?:\/\//.test(cand)) continue;
        const probe = await testAudioLink(cand, { headers: HEADERS });
        if (probe.ok) {
          return {
            url: cand,
            ext: probe.ext || String(d[`${q}ext`] || '').trim() || 'mp3',
            size: probe.sizeBytes || Number(d[`${q}size`]) || null,
            br: QUALITY_BR[q] ?? null,
            requestedBr: QUALITY_BR[q] ?? null,
            via: `official:${q}`,
          };
        }
        logger.warn(`[fivesing] ${q} 直链预检未通过:`, cand.slice(0, 70));
      }
    }
    return { error: '5sing 暂无可用音源', code: 'UNAVAILABLE', fatal: true };
  } catch (e) {
    logger.warn('[fivesing] getUrl 失败:', e.message);
    return { error: e.message, code: 'FETCH_FAILED', fatal: false };
  }
}

/**
 * 歌词文本 → 只保留带时间轴的行
 *
 * 必须输出 `[mm:ss.xx]文本`：渲染层 parseLrc 的正则只认带方括号的时间轴，
 * 缺方括号会让整段歌词被静默丢弃（同酷我 lrcFromLines 的约束）。
 *
 * dynamicWords 里的换行在不同曲目上可能是真换行，也可能是字面 `\n` 两字符
 * （实测两种都出现过），所以先统一成真换行再分行。
 *
 * @param {string} raw
 * @returns {string}
 */
function lrcFromDynamicWords(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\r\\n|\\n|\\r/g, '\n');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\[\d{1,2}:\d{1,2}([.:]\d{1,3})?\]/.test(l))
    .join('\n');
}

/**
 * 获取歌词（newget 的 dynamicWords）
 * @param {string} id - `<songId>_<typeEname>`
 * @returns {Promise<string>} 标准 LRC 文本；失败或该曲无词返回空串（上层会回落网易云/酷狗）
 */
async function fivesingGetLyrics(id) {
  const parsed = decodeId(id);
  if (!parsed) return '';
  try {
    const res = await request(
      `${API_HOST}/song/newget?songid=${encodeURIComponent(parsed.songId)}&songtype=${encodeURIComponent(parsed.type)}&songfields=&userfields=`,
      { headers: HEADERS, timeout: 6000 },
    );
    const d = (res && res.data) || {};
    return lrcFromDynamicWords(d.dynamicWords);
  } catch (e) {
    logger.warn('[fivesing] 歌词获取失败:', e.message);
    return '';
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'fivesing',
  name: '5sing',
  nameEn: '5sing',
  icon: '🎤',
  badge: { bg: 'rgba(251,146,60,.14)', fg: '#fb923c', border: 'rgba(251,146,60,.24)' },
  // 网络事实：搜索(search) / 取流与歌词(mobileapi) / 页面(5sing)
  hosts: {
    origins: [
      'http://search.5sing.kugou.com',
      'http://mobileapi.5sing.kugou.com',
      'https://5sing.kugou.com',
    ],
  },
  linkPatterns: [],
  policies: { order: 70, fallbackSource: true, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: fivesingSearch,
  getUrl: fivesingGetUrl,
  getLyrics: fivesingGetLyrics,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  fivesingSearch,
  fivesingGetUrl,
  fivesingGetLyrics,
  // 内部纯函数：仅作单测断言入口，不属于对外契约
  _internal: { mapSong, stripHtml, encodeId, decodeId, lrcFromDynamicWords, QUALITY_ORDER },
};
