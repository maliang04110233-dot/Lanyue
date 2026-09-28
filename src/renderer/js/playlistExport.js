/**
 * 歌单详情导出 m3u 的纯函数
 *
 * export-playlist IPC 行内容取 `song.filePath || song.url || ''`，
 * 而用户歌单存的是原始搜索结果（两者皆无）。这里按视图回填：
 * 下载过的歌 → 历史里的本地文件路径（离线可播），
 * 在线歌     → songShare.songPageUrl 反向构造的平台歌曲页链接。
 * 只产副本不改原对象（歌单存储与渲染共享引用，污染会进 prefs）。
 * 无 DOM / api 依赖，node 可直接单测。
 */
import { songPageUrl } from './songShare.js';

/** 下载历史 items → {source:id → filePath}，同键首条（最新完成）优先 */
export function buildPathMap(items) {
  const map = {};
  for (const e of Array.isArray(items) ? items : []) {
    if (!e || e.source == null || e.id == null || !e.filePath) continue;
    const k = `${e.source}:${e.id}`;
    if (!(k in map)) map[k] = e.filePath;
  }
  return map;
}

/** 导出视图：本地路径优先，其次平台页链接；两者皆无留空行 */
export function enrichExportSongs(songs, pathMap) {
  return (Array.isArray(songs) ? songs : []).filter(Boolean).map((s) => {
    const local = s.source != null && s.id != null && pathMap
      ? pathMap[`${s.source}:${s.id}`] : null;
    const out = { ...s };
    if (local) out.filePath = local;
    else {
      const page = songPageUrl(s);
      if (page) out.url = page;
    }
    return out;
  });
}
