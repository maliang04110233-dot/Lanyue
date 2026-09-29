/**
 * 本地曲库「格式过滤」—— 纯函数（node 可单测，无 DOM 依赖）
 *
 * 与「♥ 仅收藏」「排序」同为会话级视图开关：只在曲库里实际存在的扩展名之间循环，
 * 曲库没有的格式（如没下过 FLAC）不会出现，杜绝空转；
 * 当前格式随扫描失效时下一击自动回落 all。判定只看 filePath 扩展名，不碰文件内容。
 */

/** 单曲扩展名（小写，无扩展名回 ''） */
function extOf(song) {
  const p = String((song && song.filePath) || '');
  const m = p.match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? m[1].toLowerCase() : '';
}

/** 曲库实际存在的格式：按数量降序、同数按字母升序 */
function listFormats(songs) {
  const count = new Map();
  for (const s of (Array.isArray(songs) ? songs : [])) {
    const e = extOf(s);
    if (!e) continue;
    count.set(e, (count.get(e) || 0) + 1);
  }
  return Array.from(count.keys())
    .sort((a, b) => (count.get(b) - count.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

/** 循环下一态：all → 格式1 → … → 格式n → all；当前格式已不在曲库则回落 all */
function nextFmtMode(mode, formats) {
  const list = Array.isArray(formats) ? formats : [];
  if (mode === 'all') return list.length ? list[0] : 'all';
  const i = list.indexOf(mode);
  if (i < 0) return 'all';
  return i + 1 < list.length ? list[i + 1] : 'all';
}

/**
 * 按钮文案（mode 来自扩展名白名单，无注入面）：默认态报轴名「🎞 格式」= 不按格式筛，
 * 切到某一格式后只报扩展名；"有没有在筛"由 .active 高亮表示（views/local.js cycleLocalFmt）。
 */
function fmtModeLabel(mode) {
  return (!mode || mode === 'all') ? '🎞 格式' : `🎞 ${mode.toUpperCase()}`;
}

/** 按扩展名过滤视图歌曲；all/空/非法值原样返回（顺序不动） */
function filterByFmt(songs, mode) {
  const arr = Array.isArray(songs) ? songs : [];
  if (!mode || mode === 'all') return arr.slice();
  return arr.filter((s) => extOf(s) === mode);
}

export { extOf, listFormats, nextFmtMode, fmtModeLabel, filterByFmt };
