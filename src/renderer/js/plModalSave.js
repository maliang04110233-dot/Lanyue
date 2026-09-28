/**
 * 平台歌单/专辑弹层 → 我的歌单
 *
 * 弹层此前的落点只有下载（加入队列/仅未下载）与整单连播；想「整单收藏成
 * 我的歌单」只能逐行加已有单。本模块补两个零通道落点：
 * 存为歌单（saveUserPlaylist 新建，在线引用不落盘）与
 * 加进歌单（勾选行喂既有 quickAddToPlaylist 选单弹层，引擎端 id+source 去重）。
 * 投影白名单剥掉弹层运行时字段（勾选态、本地检测等不污染存储行），
 * albumMid 保留——我的歌单详情里专辑链接要它。纯函数，node 可直测。
 */

const ROW_FIELDS = ['id', 'source', 'title', 'artist', 'album', 'albumMid', 'duration', 'cover'];

/** 纯函数：勾选下标集合 × 弹层歌曲 → 勾选歌数组（按原序；越界/空位跳过） */
export function pickCheckedSongs(songs, checkedSet) {
  const list = Array.isArray(songs) ? songs : [];
  const idxs = Array.from(checkedSet || []).sort((a, b) => a - b);
  const out = [];
  for (const i of idxs) {
    if (Number.isInteger(i) && i >= 0 && i < list.length && list[i]) out.push(list[i]);
  }
  return out;
}

/** 纯函数：平台歌曲行 → 存储白名单行（运行时字段不落盘） */
export function toPlaylistRows(songs) {
  const list = Array.isArray(songs) ? songs : [];
  return list.filter(Boolean).map((s) => {
    const row = {};
    for (const f of ROW_FIELDS) {
      if (s[f] !== undefined) row[f] = s[f];
    }
    row.addedAt = Date.now();
    return row;
  });
}

/** 纯函数：saveUserPlaylist 载荷（无名回退「平台歌单」，封面取首张已知图） */
export function buildSavedPlaylist(meta, rows) {
  const m = meta || {};
  const list = Array.isArray(rows) ? rows : [];
  const firstCover = list.find(r => r && r.cover);
  return {
    name: String(m.name || '').trim() || '平台歌单',
    desc: `${String(m.src || '').trim() || '平台'} 歌单 · ${list.length} 首`,
    cover: (firstCover && firstCover.cover) || '',
    songs: list,
  };
}
