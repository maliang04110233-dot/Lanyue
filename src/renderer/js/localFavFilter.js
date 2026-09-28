/**
 * 本地曲库「仅看收藏」过滤
 *
 * 纯函数：收藏键沿用 state.favoriteKeys 的 "id:source" 约定，本地歌键即
 * filePath:local（见 favorites.js localFavSong）。不碰 DOM，便于单测。
 */

export function favOnlyFilter(songs, favoriteKeys) {
  if (!Array.isArray(songs)) return [];
  if (!favoriteKeys || typeof favoriteKeys.has !== 'function') return [];
  return songs.filter(s =>
    s && s.filePath != null && favoriteKeys.has(String(s.filePath) + ':local'));
}
