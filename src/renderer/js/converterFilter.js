/**
 * 转换页关键词过滤纯逻辑：歌名 / 歌手 / 专辑 三字段大小写不敏感包含匹配。
 * 无 DOM / api 依赖，node 可直接单测。
 *
 * 为什么单独成模块：这条过滤原先内联在 views/converter.js 的 filterConverterSongs() 里，
 * 而「扫描到新库」的三条路径（scanLocalForConvert / loadLocalSongsForConvert ×2）都只调
 * renderConverterSongs()，它读的是 state.convFiltered —— 于是新库配旧过滤结果，
 * 列表与计数陈旧（修）。抽成纯函数后行为可被真实单测覆盖，
 * 而不是只靠源码字面钉（字面钉曾把 renderLocalSongs 的 bug 钉成「预期」）。
 */

function normKw(kw) {
  return typeof kw === 'string' ? kw.trim().toLowerCase() : '';
}

/** 单曲是否命中关键词；空关键词视为全命中 */
function matchConverterKw(song, kw) {
  const k = normKw(kw);
  if (!k) return true;
  const s = song || {};
  return String(s.title || '').toLowerCase().includes(k)
    || String(s.artist || '').toLowerCase().includes(k)
    || String(s.album || '').toLowerCase().includes(k);
}

/** 过滤歌曲数组；空关键词返回浅拷贝（调用方拿到的永远是数组，可安全 setState） */
function filterConverterSongsByKw(songs, kw) {
  const arr = Array.isArray(songs) ? songs : [];
  if (!normKw(kw)) return arr.slice();
  return arr.filter((s) => matchConverterKw(s, kw));
}

export { normKw, matchConverterKw, filterConverterSongsByKw };
