/**
 * 汽水音乐平台实现（2026-09-17 实测校准，非猜测）
 *
 * ⚠️ 本平台曾被判为「风控静默拒绝、需要 JSVMP 逆向」—— 那个判断是错的。
 * 真因只是**缺客户端身份头**：补上 LunaPC 的 UA 与 `X-Luna-*` 系列头之后，
 * 同一个端点立刻返回 108KB 真实 JSON。而据此推断"需要签名"的
 * `x-helios` / `x-medusa`，实际是客户端源码里的**硬编码固定值**，不是动态签名。
 * ⇒ 见到「200 + 空 body」先换真实客户端身份复测，再下"有风控"的结论。
 *
 * ── 三项能力的真实契约 ──────────────────────────────────────
 *
 * 搜索  GET api.qishui.com/luna/search/track
 *         ?<安卓客户端参数矩阵>&q=<kw>&cursor=<n*20>&count=20&_rticket=<ms>
 *       UA: LunaPC/3.4.0(388267242)
 *       X-Luna-Background-Type: foreground / X-Luna-Is-Background-Req: 0 /
 *       X-Luna-Is-Local-User: 1 / X-Helios: <硬编码>
 *       → { result_groups: [{ data: [{ entity: { track } }] }] }
 *       ⚠️ 结果不在顶层数组里，要下钻 result_groups[].data[].entity.track；
 *          判据用「entity.track 存在」而非 group.type（实测该字段是 undefined）。
 *
 * 取流  GET music.douyin.com/qishui/share/track?track_id=<id>   （手机 UA）
 *       页面内嵌 `_ROUTER_DATA = {...}`，其
 *       loaderData.track_page.audioWithLyricsOption.url 即直链。
 *       ⚠️ 免登录只有这一条路，**不需要签名、不需要 AES 解密**。
 *          实测 206 / audio/mp4，且**不需要 Referer**。
 *       ⚠️ 2026-09-21 第四轮实测修正：**这条 url 有时只是试听片段**
 *          （声称 251s 实为 29s、声称 324s 实为 60s），且 `awl.duration`
 *          给的是曲目标称时长而非片段长度 —— 故取流侧必须核对
 *          「字节数 ÷ 声称时长」反推的码率，见 isImpliedBitrateImpossible。
 *
 * 歌词  同一个分享页：audioWithLyricsOption.lyrics.sentences[]
 *       → 每句 { startMs, endMs, text, words: [{ text, startMs, endMs }] }
 *       本实现按句输出标准 LRC（逐字时间轴 words 不消费 —— 渲染层格式未验证，
 *       保守用通用按句格式，避免整段歌词被 parseLrc 丢弃）。
 *
 * ── 三个必须知道的限制 ──────────────────────────────────────
 *   1. `duration` 单位不一致：**搜索**返回毫秒（track.duration），**分享页**
 *      返回秒（awl.duration）。混用会导致时长差 1000 倍、跨源匹配全灭。
 *   2. 免登录只有一档音质（实测 ≈130kbps）。label_info.quality_only_vip_can_play
 *      标着 lossless 需会员，故 quality 参数在本平台不产生实际差异。
 *   3. 歌词末句的 endMs 是 Number.MAX_SAFE_INTEGER（表示"持续到结束"），
 *      拼 LRC 时必须忽略 endMs，只取 startMs。
 */

const request = require('../request');
const { testAudioLink } = require('../request');
const logger = require('../../utils/logger');

const SEARCH_HOST = 'https://api.qishui.com';
const SHARE_HOST = 'https://music.douyin.com';
const REFERER = 'https://music.douyin.com/';

/** 搜索接口的客户端 UA（必须 LunaPC，浏览器 UA 会拿到空 body） */
const LUNA_UA = 'LunaPC/3.4.0(388267242)';
/** 分享页是移动端页面，要手机 UA */
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** X-Helios 是客户端源码里的硬编码值（非动态签名），失配时才需要更新 */
const HELIOS = 'SicAACJWDNiSHEX4DSBVXo3+TNXAHXt9Af6CkPaMTmSX1Jcg';

const SEARCH_HEADERS = {
  'User-Agent': LUNA_UA,
  'Content-Type': 'application/json; charset=utf-8',
  'X-Luna-Background-Type': 'foreground',
  'X-Luna-Is-Background-Req': '0',
  'X-Luna-Is-Local-User': '1',
  'X-Helios': HELIOS,
};

/** 安卓客户端参数矩阵（照抄实测可用的一组，改动其中任何一项都可能触发空 body） */
const CLIENT_PARAMS = {
  device_platform: 'android', os: 'android', ssmix: 'a',
  cdid: '46556f98-1720-4248-83da-62b74b60b46a', channel: 'xiaomi_8478_64',
  aid: '386088', app_name: 'luna', version_code: '100198030', version_name: '19.8.0',
  manifest_version_code: '100198030', update_version_code: '100198030',
  resolution: '1080*1920', dpi: '480', device_type: 'ABR-AL80', device_brand: 'HUAWEI',
  language: 'zh', os_api: '35', os_version: '15', ac: 'wifi', device_model: 'ABR-AL80',
  save_power: '0', font_size: '1.00', luna_first_launch_apk_type: 'normal_apk',
  is_car_play: '0', battery: '0.99', network_speed: '10156', hybrid_version_code: '100198030',
  tz_name: 'Asia/Shanghai', tz_offset: '28800', package: 'com.luna.music', charge: '0',
  luna_apk_type: 'normal_apk', output_device_type: 'Phone', volume: '1.00', brightness: '0.08',
  need_personal_recommend: '1', is_teen_mode: '0', sim_region: 'cn', android_device_type: 'default',
  iid: '2204957404569386', device_id: '2204957404565290',
};

const PAGE_SIZE = 20;

/** 查询串编码：与实测脚本一致（encodeURIComponent，`*` 不编码） */
function buildQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

/**
 * 封面对象 → 完整 URL
 *
 * 抖音图床的结构是 `{ uri, urls: [前半段...], template_prefix }`，
 * 拼接方式为 `urls[0] + uri + '~c5_375x375.jpg'`
 * —— 与分享页直接给出的 coverURL 逐字节一致（实测比对过），故这个后缀是准的。
 *
 * @param {{uri?:string,urls?:string[]}|string} urlCover
 * @param {string} [suffix]
 * @returns {string}
 */
function pickCover(urlCover, suffix = '~c5_375x375.jpg') {
  if (!urlCover) return '';
  if (typeof urlCover === 'string') return urlCover;
  const base = Array.isArray(urlCover.urls) ? String(urlCover.urls[0] || '') : '';
  const uri = String(urlCover.uri || '');
  if (!base || !uri) return '';
  return `${base}${uri}${suffix}`;
}

/**
 * 搜索结果条目 → 项目统一歌曲结构
 * @param {object} tk - entity.track
 * @returns {{id,title,artist,album,cover,duration,source}|null}
 */
function mapTrack(tk) {
  const id = String(tk?.id ?? '').trim();
  if (!id) return null;
  const title = String(tk?.name || '').trim();
  if (!title) return null;
  return {
    id,
    title,
    artist: Array.isArray(tk.artists)
      ? tk.artists.map((a) => a && a.name).filter(Boolean).join('、')
      : '',
    album: String((tk.album && tk.album.name) || '').trim(),
    cover: pickCover(tk.album && tk.album.url_cover),
    duration: Number(tk.duration) || 0, // ⚠️ 毫秒（与分享页的秒不同）
    source: 'soda',
  };
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page - 从 1 开始（映射为 cursor = (page-1)*20）
 * @returns {Promise<Array>}
 */
async function sodaSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const p = Math.max(1, parseInt(page, 10) || 1);
  const query = buildQuery({
    ...CLIENT_PARAMS,
    q: keyword,
    cursor: String((p - 1) * PAGE_SIZE),
    count: String(PAGE_SIZE),
    _rticket: String(Date.now()),
  });
  const res = await request(`${SEARCH_HOST}/luna/search/track?${query}`, {
    headers: SEARCH_HEADERS,
    timeout: 10000,
  });
  const groups = (res && res.result_groups) || [];
  const out = [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    for (const it of ((g && g.data) || [])) {
      const tk = (it && it.entity && it.entity.track) || (it && it.track);
      if (!tk || !tk.id) continue;
      const mapped = mapTrack(tk);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

/**
 * 从分享页 HTML 提取 `_ROUTER_DATA = {...}` 的 JSON
 *
 * 用花括号平衡扫描而非非贪婪正则：歌词文本里完全可能出现 `};` 让正则提前截断。
 * 扫描时需跟踪字符串状态与转义，否则引号内的花括号会算错层级。
 *
 * @param {string} html
 * @returns {object|null}
 */
function extractRouterData(html) {
  const s = String(html || '');
  const anchor = s.search(/_ROUTER_DATA\s*=\s*/);
  if (anchor < 0) return null;
  const start = s.indexOf('{', anchor);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = start; p < s.length; p++) {
    const ch = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, p + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

/** 分享页解析结果的短时缓存（getUrl 与 getLyrics 常先后命中同一 track） */
const _shareCache = new Map();
const SHARE_TTL_MS = 5 * 60 * 1000;
const SHARE_CACHE_MAX = 50;

/**
 * 拉取并解析分享页
 * @param {string} trackId
 * @returns {Promise<{url,duration,lyrics,name,artist}|null>}
 */
async function fetchShare(trackId) {
  const key = String(trackId);
  const hit = _shareCache.get(key);
  if (hit && Date.now() - hit.at < SHARE_TTL_MS) return hit.data;

  const html = await request(
    `${SHARE_HOST}/qishui/share/track?track_id=${encodeURIComponent(key)}`,
    {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
      retries: 1,
    },
  );
  const meta = extractRouterData(html);
  if (!meta) return null;
  const page = (meta.loaderData && meta.loaderData.track_page) || {};
  const awl = page.audioWithLyricsOption || {};
  const data = {
    url: String(awl.url || '').trim(),
    duration: (Number(awl.duration) || 0) * 1000, // 统一为毫秒：分享页给的是秒，搜索路径给的是毫秒
    lyrics: (awl.lyrics && awl.lyrics.sentences) || [],
    name: String(awl.trackName || '').trim(),
    artist: String(awl.artistName || '').trim(),
  };
  _shareCache.set(key, { at: Date.now(), data });
  if (_shareCache.size > SHARE_CACHE_MAX) _shareCache.delete(_shareCache.keys().next().value);
  return data;
}

/** 毫秒 → `mm:ss.xx`（LRC 时间轴，渲染层 parseLrc 只认这个形态） */
function fmtLrcTime(ms) {
  // 先按 10ms 取整再换算：否则 59.999s 会被 toFixed(2) 进成 "60.00"，
  // 输出 `[01:60.00]` 这种非法时间轴（秒位不该出现 60）
  const total = Math.max(0, Math.round((Number(ms) || 0) / 10) * 10) / 1000;
  const mm = Math.floor(total / 60);
  const ss = total - mm * 60;
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

/**
 * sentences[] → 标准 LRC
 *
 * 只取 startMs（末句的 endMs 是 MAX_SAFE_INTEGER，代表"到结束"，用了会得到天文数字）。
 *
 * @param {Array<{startMs?:number,text?:string}>} sentences
 * @returns {string}
 */
function sentencesToLrc(sentences) {
  return (Array.isArray(sentences) ? sentences : [])
    .map((s) => {
      const ms = Number(s && s.startMs);
      const txt = String((s && s.text) || '').replace(/\s+/g, ' ').trim();
      if (!Number.isFinite(ms) || ms < 0 || !txt) return '';
      return `[${fmtLrcTime(ms)}]${txt}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** 由体积与时长估算码率（分享页给的是秒，正好可用） */
function estimateBr(sizeBytes, durationSec) {
  if (!sizeBytes || !durationSec) return null;
  const kbps = Math.round((sizeBytes * 8) / durationSec / 1000);
  return kbps > 0 ? kbps * 1000 : null;
}

/**
 * 音乐流码率下限（bps）。低于它的「平均码率」不可能是完整音轨。
 *
 * 依据：本应用触及的免费档实测全是 128kbps 量级（汽水整曲反推 126~129k、
 * 酷我/咪咕/网易云 standard 均 128k），取 64k 已留一倍余量。
 * 反例教训（2026-09-21 第五轮实测）：下限一开始取 32k，结果「199s 的歌给 60s」
 * 这一档漏网 —— 它的反推码率是 39k，仍在音乐编码合理区间之下。
 */
const MIN_MUSIC_BITRATE = 64000;

/**
 * 反推码率是否低到「这些字节装不下这么多秒」⇒ 手里的其实是片段。
 *
 * 汽水分享页的 `duration` 是**曲目标称时长**，与 `url` 指向的字节无关；
 * 而 `estimateBr` 又用这两个数互相推导，使得 size*8/br 恒等于声称时长 ——
 * 下游任何「拿体积核对长度」的判据都会被这层自洽屏蔽，只有在 soda 本地
 * 用「码率物理下限」这个**独立**证据才拆得穿（见文件顶部的实测三例）。
 *
 * @param {number|null} sizeBytes 预检实测字节数
 * @param {number|null} durationSec 分享页声称时长（秒）
 * @returns {boolean}
 */
function isImpliedBitrateImpossible(sizeBytes, durationSec) {
  if (!sizeBytes || !durationSec) return false;
  return (sizeBytes * 8) / durationSec < MIN_MUSIC_BITRATE;
}

/**
 * 获取下载 URL
 *
 * 流程：分享页 → audioWithLyricsOption.url → 音频预检。
 * 预检的意义与其它平台一致：把「拿得到地址但地址不可用」在取流阶段暴露，
 * 让上层 getDownloadUrlSmart 能触发换源，而不是把坏链丢给下载器。
 *
 * @param {string} id - track id
 * @param {string} [quality] - 免登录下服务端只有一档，本参数不产生差异
 * @returns {Promise<{url,ext,size,br,via}|{error,code,fatal}>}
 */
async function sodaGetUrl(id, _quality = 'standard') {
  if (!id) return { error: '缺少歌曲 ID', code: 'BAD_PARAMS', fatal: true };
  try {
    const share = await fetchShare(id);
    const url = (share && share.url) || '';
    if (!/^https?:\/\//.test(url)) {
      return {
        error: '汽水暂无可用音源（该曲可能需要会员）',
        code: 'VIP_REQUIRED',
        fatal: true,
      };
    }
    // 实测不需要 Referer，但带上无副作用，且能规避后续 CDN 策略收紧
    const probe = await testAudioLink(url, { headers: { Referer: REFERER }, timeout: 10000 });
    if (!probe.ok) {
      logger.warn('[soda] 直链预检未通过:', url.slice(0, 80), probe.reason || probe.status);
      return { error: '汽水音源暂不可用', code: 'CDN_EMPTY', fatal: true };
    }
    const durationSec = share.duration / 1000; // share.duration 是毫秒，码率估算吃秒
    const br = estimateBr(probe.sizeBytes, durationSec);
    if (isImpliedBitrateImpossible(probe.sizeBytes, durationSec)) {
      logger.warn(`[soda] 声称 ${durationSec}s 只有 ${probe.sizeBytes} 字节，判为试听片段`);
      return {
        error: '汽水分享页仅有试听片段（无整曲音源）',
        code: 'NO_AUDIO_STREAM',
        fatal: true,
      };
    }
    return {
      url,
      ext: probe.ext || 'm4a',
      size: probe.sizeBytes,
      br,
      requestedBr: br,
      via: 'share:_ROUTER_DATA',
    };
  } catch (e) {
    logger.warn('[soda] getUrl 失败:', e.message);
    return { error: e.message, code: 'FETCH_FAILED', fatal: false };
  }
}

/**
 * 获取歌词（与取流共用同一个分享页，靠短时缓存避免重复请求）
 * @param {string} id - track id
 * @returns {Promise<string>} 标准 LRC 文本；失败返回空串（上层会回落网易云/酷狗）
 */
async function sodaGetLyrics(id) {
  if (!id) return '';
  try {
    const share = await fetchShare(id);
    return sentencesToLrc(share && share.lyrics);
  } catch (e) {
    logger.warn('[soda] 歌词获取失败:', e.message);
    return '';
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'soda',
  name: '汽水音乐',
  nameEn: 'Soda Music',
  icon: '🥤',
  badge: { bg: 'rgba(244,114,182,.14)', fg: '#f472b6', border: 'rgba(244,114,182,.24)' },
  // 网络事实：搜索(api.qishui) / 分享页(music.douyin)
  // 音频与封面 CDN 子域是动态的（按地域/节点变化），精确枚举不完，故用后缀匹配
  hosts: {
    origins: [
      'https://api.qishui.com',
      'https://music.douyin.com',
    ],
    originSuffixes: ['.douyinvod.com', '.douyinpic.com'],
  },
  linkPatterns: [],
  policies: { order: 80, fallbackSource: true, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: sodaSearch,
  getUrl: sodaGetUrl,
  getLyrics: sodaGetLyrics,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  sodaSearch,
  sodaGetUrl,
  sodaGetLyrics,
  // 内部纯函数：仅作单测断言入口，不属于对外契约
  _internal: {
    mapTrack, pickCover, buildQuery, extractRouterData,
    sentencesToLrc, fmtLrcTime, estimateBr, CLIENT_PARAMS,
  },
};
