/**
 * 本地曲库「音质视图过滤」—— 纯函数（node 可单测，零 DOM）
 *
 * 让每首的标称/实测音质看得见，但看得见不等于筛得出来：
 * 批量扫描之后想「只听真无损」「只看可疑的那几首」「把无损容器里
 * 还没验过的挑出来排成一队」，仍需逐行看徽标。这里给一条循环切换的音质轴，
 * 与格式轴（107）、收藏轴（89）、排序轴（35）同为会话级视图开关，可叠加。
 *
 * 实测结果由调用方以 probeOf(filePath) 注入 —— 本模块不认识 _probeCache，
 * 也不起进程：没实测过的歌一律按「只有标称」处理。
 */

import { extOf } from './localFormatFilter.js';

/** 无损类容器扩展名：标称无损，真伪待验 */
const LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv', 'dsf', 'dff']);

/** 循环顺序（'all' 回到起点） */
const QUALITY_MODES = ['all', 'nominal', 'verified', 'suspect', 'unprobed'];

/**
 * 按钮文案：默认态报「这条轴叫什么」（🧪 音质 = 不按音质筛），
 * 切到某一态后只报值（🧪 真无损），"有没有在筛"由 .active 高亮表示
 * （见 views/local.js 的 cycleLocalQual）。旧写法「🧪 音质: 仅实测真无损」
 * 十枚常驻按钮挤在一行里会被压成逐字竖排，完整口径挪进按钮 title。
 */
const MODE_LABEL = {
  all: '🧪 音质',
  nominal: '🧪 标称无损',
  verified: '🧪 真无损',
  suspect: '🧪 存疑/伪',
  unprobed: '🧪 待验',
};

/** 该曲是否属于「无损容器」（只看扩展名，不碰文件） */
function inLosslessContainer(song) {
  return LOSSLESS_EXT.has(extOf(song));
}

/**
 * 单曲是否属于某音质视图。
 * @param {object} song
 * @param {object|null} probe 实测结果（audioProbe 形状，未测/失败传 null）
 * @param {string} mode
 */
function matchQualityMode(song, probe, mode) {
  if (!mode || mode === 'all') return true;
  if (!QUALITY_MODES.includes(mode)) return true;
  const ok = probe && probe.ok ? probe : null;
  if (mode === 'nominal') return inLosslessContainer(song);
  if (mode === 'unprobed') return inLosslessContainer(song) && !ok;
  if (!ok) return false;
  if (mode === 'verified') return ok.verdict === 'lossless';
  if (mode === 'suspect') return ok.verdict === 'suspicious' || ok.verdict === 'lossy';
  return true;
}

/** 循环下一态；未知值（脏 localStorage 等）一律回 'all' */
function nextQualMode(mode) {
  const i = QUALITY_MODES.indexOf(mode);
  return i < 0 ? 'all' : QUALITY_MODES[(i + 1) % QUALITY_MODES.length];
}

function qualModeLabel(mode) {
  return MODE_LABEL[mode] || MODE_LABEL.all;
}

/** 按音质模式过滤；probeOf 缺省时全部按「未实测」处理 */
function filterByQuality(songs, probeOf, mode) {
  const arr = Array.isArray(songs) ? songs : [];
  if (!mode || mode === 'all') return arr.slice();
  const probeOfFn = typeof probeOf === 'function' ? probeOf : () => null;
  return arr.filter((s) => s && matchQualityMode(s, probeOfFn(s && s.filePath), mode));
}

export {
  LOSSLESS_EXT, QUALITY_MODES, inLosslessContainer,
  matchQualityMode, nextQualMode, qualModeLabel, filterByQuality,
};
