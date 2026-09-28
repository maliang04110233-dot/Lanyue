/**
 * 搜索页批量收藏—— 纯函数，node 可直测
 *
 * 红心是 toggle 语义，批量收藏若不排除已收藏的歌，再点一下反而把它们
 * 取消出收藏夹。判重直接对着 favoriteKeys 集合（state.js favKey =
 * 'id:source'）；本模块不 import state —— keyOf 由调用方注入，保持零依赖。
 */

/**
 * 把勾选歌曲分成「待收藏」与「已在收藏夹」。
 * @param {Array} songs 候选（null / 无 id 的行静默丢弃 —— 红心键依赖 id）
 * @param {Set<string>|Array<string>} favKeys 收藏键集合
 * @param {(song)=>string} keyOf song => 收藏键
 * @returns {{toFav:Array, already:number}} toFav 保持入参原序
 */
export function planBatchFav(songs, favKeys, keyOf) {
  const toFav = [];
  let already = 0;
  const keys = favKeys instanceof Set ? favKeys : new Set(favKeys || []);
  for (const s of songs || []) {
    if (!s || s.id == null) continue;
    if (keys.has(keyOf(s))) already++;
    else toFav.push(s);
  }
  return { toFav, already };
}

/** 汇总 toast 后缀：0 首已收藏时整段省略 */
export function favSkipSuffix(already) {
  return already > 0 ? `（跳过 ${already} 首已收藏）` : '';
}
