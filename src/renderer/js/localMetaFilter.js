/**
 * 本地曲库「元数据完整度」视图过滤 —— 纯函数（node 可单测，零 DOM）
 *
 * /123 让音质看得见 / 筛得出；这一轴管「标签填得全不全」：
 * 「一键补全」（封面+歌词）跑完之后，曲库里仍会剩下缺专辑、缺歌手/标题、
 * 封面拉不到的行，逐行翻找成本高。这里给一条循环切换的完整度轴，
 * 与格式轴（107）、收藏轴（89）、音质轴（123）、排序轴（35）同为
 * 会话级视图开关，可叠加。
 *
 * 判定只用扫描期已落库的字段（cover / album / artist / title / embeddedLyrics）：
 * 内嵌歌词来自 ID3 USLT；sidecar .lrc 需逐首发 IPC 才知道有没有，本轴不碰
 * （违背「零新通道」），故歌词一项文案写明「内嵌」。
 */

/** 循环顺序（'all' 回到起点） */
const META_MODES = ['all', 'no-cover', 'no-album', 'no-artist', 'no-lyric'];

/**
 * 按钮文案：默认态报轴名（🏷 完整度 = 不按完整度筛），切态后只报值，
 * "有没有在筛"由 .active 高亮表示（views/local.js cycleLocalMeta）。
 * 旧写法「🏷 完整度: 缺歌手或标题」是常驻按钮被挤成逐字竖排的根因，
 * 完整口径挪进按钮 title。
 */
const MODE_LABEL = {
  all: '🏷 完整度',
  'no-cover': '🏷 缺封面',
  'no-album': '🏷 缺专辑',
  'no-artist': '🏷 缺歌手/标题',
  'no-lyric': '🏷 缺内嵌歌词',
};

/** 非空字符串（去首尾空白）才算「有」 */
function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 单曲是否属于某完整度视图。
 * @param {object} song 本地曲目（扫描结果对象）
 * @param {string} mode
 */
function matchMetaMode(song, mode) {
  if (!mode || mode === 'all') return true;
  if (!META_MODES.includes(mode)) return true;
  const s = song || {};
  if (mode === 'no-cover') return !s.cover;
  if (mode === 'no-album') return !hasText(s.album);
  if (mode === 'no-artist') return !hasText(s.artist) || !hasText(s.title);
  if (mode === 'no-lyric') return !hasText(s.embeddedLyrics);
  return true;
}

/** 循环下一态；未知值（脏 localStorage 等）一律回 'all' */
function nextMetaMode(mode) {
  const i = META_MODES.indexOf(mode);
  return i < 0 ? 'all' : META_MODES[(i + 1) % META_MODES.length];
}

function metaModeLabel(mode) {
  return MODE_LABEL[mode] || MODE_LABEL.all;
}

/** 按完整度模式过滤；非数组入参返回空数组，'all'/未知模式原样浅拷贝 */
function filterByMeta(songs, mode) {
  const arr = Array.isArray(songs) ? songs : [];
  if (!mode || mode === 'all') return arr.slice();
  if (!META_MODES.includes(mode)) return arr.slice();
  return arr.filter((s) => s && matchMetaMode(s, mode));
}

export {
  META_MODES, hasText,
  matchMetaMode, nextMetaMode, metaModeLabel, filterByMeta,
};
