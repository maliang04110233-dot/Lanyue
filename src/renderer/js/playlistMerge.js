/**
 * 歌单合并纯函数
 *
 * 把来源歌单的歌合入目标歌单：目标序保持，源内新歌按源序追加。
 * 去重键与徽标体系同口径：source:id（id 用 String 归一，平台返回
 * number/string 混用）；缺 source 或 id 的歌退到 t:标题|歌手（小写、
 * 空白归一）；两者都凑不出的条目一律放行合入（宁可重复不可丢歌）。
 * 输出全部为浅拷贝——合入结果写回 prefs 时不回指调用方的数组元素。
 */

export function mergeKeyOf(song) {
  if (!song || typeof song !== 'object') return null;
  if (song.source != null && song.id != null && song.id !== '') {
    return `${song.source}:${String(song.id)}`;
  }
  const title = (song.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!title) return null;
  const artist = (song.artist || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `t:${title}|${artist}`;
}

/**
 * @param {Array} baseSongs 目标歌单歌曲（保持原顺序在前）
 * @param {Array} addSongs  来源歌单歌曲（新歌按其顺序追加）
 * @returns {{songs: Array, added: number, dup: number}}
 */
export function mergeSongLists(baseSongs, addSongs) {
  const base = Array.isArray(baseSongs) ? baseSongs : [];
  const add = Array.isArray(addSongs) ? addSongs : [];
  const songs = [];
  const seen = new Set();

  for (const s of base) {
    if (!s || typeof s !== 'object') continue;
    const k = mergeKeyOf(s);
    if (k) {
      if (seen.has(k)) continue; // 目标自身带重复也顺手收敛
      seen.add(k);
    }
    songs.push({ ...s });
  }

  let added = 0;
  let dup = 0;
  for (const s of add) {
    if (!s || typeof s !== 'object') continue;
    const k = mergeKeyOf(s);
    if (k) {
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
    }
    songs.push({ ...s });
    added++;
  }
  return { songs, added, dup };
}

if (typeof window !== 'undefined') {
  window.mergeSongLists = mergeSongLists;
  window.mergeKeyOf = mergeKeyOf;
}
