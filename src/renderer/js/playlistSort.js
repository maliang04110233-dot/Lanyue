/**
 * 用户歌单拖拽排序 — 纯函数（node 直测，无 DOM 依赖）
 *
 * 语义与播放队列拖拽（playQueueSort.applyPqDragMove）一致：
 * 落到目标行 = 占据该位置；这里只需返回新顺序，无播放下标换算。
 */

export function moveInList(list, from, to) {
  if (!Array.isArray(list) || list.length < 2) return null;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return null;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ── 视图级排序（不改存储顺序，只排展示 pairs；与搜索排序同型）──

export const PL_SORT_MODES = [
  { key: '', label: '↕ 默认序' },
  { key: 'title', label: '↕ 标题' },
  { key: 'artist', label: '↕ 歌手' },
  { key: 'added', label: '↕ 添加时间' },
];

export function nextPlSortMode(cur) {
  let idx = PL_SORT_MODES.findIndex((m) => m.key === cur);
  if (idx < 0) idx = 0; // 坏值视作默认序再前进
  return PL_SORT_MODES[(idx + 1) % PL_SORT_MODES.length].key;
}

function _cmpText(a, b) {
  const ta = String(a || '').trim();
  const tb = String(b || '').trim();
  if (!ta && !tb) return 0;
  if (!ta) return 1; // 缺字段垫底
  if (!tb) return -1;
  return ta.localeCompare(tb, 'zh');
}

/**
 * @param {Array<{song: Object, i: number}>} pairs filterPlaylistSongs 的产物（i=存储下标）
 * @param {string} mode ''/title/artist/added
 * @returns {Array} 新数组；同键按原顺序（i 升序）稳定
 */
export function sortPlaylistPairs(pairs, mode) {
  if (!Array.isArray(pairs)) return [];
  if (!mode || mode === 'added') {
    // 默认序与添加时间均按存储下标方向排（added 缺 addedAt 垫底）
    const out = pairs.slice();
    if (mode === 'added') {
      out.sort((a, b) => {
        const av = +((a && a.song && a.song.addedAt) || 0);
        const bv = +((b && b.song && b.song.addedAt) || 0);
        const am = a && a.song && a.song.addedAt ? av : Infinity;
        const bm = b && b.song && b.song.addedAt ? bv : Infinity;
        return am !== bm ? am - bm : a.i - b.i;
      });
    }
    return out;
  }
  const out = pairs.slice();
  out.sort((a, b) => {
    const sa = (a && a.song) || {};
    const sb = (b && b.song) || {};
    const r = mode === 'title' ? _cmpText(sa.title, sb.title)
      : mode === 'artist' ? _cmpText(sa.artist, sb.artist) : 0;
    return r || a.i - b.i;
  });
  return out;
}

// ── 歌单页卡片排序：系统收藏恒置顶，其余按档排 ──

export const PL_CARD_MODES = [
  { key: '', label: '↕ 默认' },
  { key: 'name', label: '↕ 名称' },
  { key: 'count', label: '↕ 曲数' },
  { key: 'recent', label: '↕ 最近更新' },
];

export function nextPlCardSortMode(cur) {
  let idx = PL_CARD_MODES.findIndex((m) => m.key === cur);
  if (idx < 0) idx = 0;
  return PL_CARD_MODES[(idx + 1) % PL_CARD_MODES.length].key;
}

/**
 * @param {Array} playlists 歌单卡片数据（system 标记者置顶不参与排序）
 * @param {string} mode ''/name/count/recent
 */
export function sortPlaylists(playlists, mode) {
  if (!Array.isArray(playlists)) return [];
  const clean = playlists.filter(Boolean);
  const sys = clean.filter((p) => p.system);
  const out = clean.filter((p) => !p.system).slice();
  if (mode === 'name') out.sort((a, b) => _cmpText(a.name, b.name));
  else if (mode === 'count') out.sort((a, b) => ((b.songs && b.songs.length) || 0) - ((a.songs && a.songs.length) || 0));
  else if (mode === 'recent') out.sort((a, b) => (+b.updatedAt || 0) - (+a.updatedAt || 0));
  return sys.concat(out);
}

/**
 * 卡片过滤：按 名称+描述 多词 AND 子串匹配（大小写不敏感）。
 * 空词直接透传原引用（调用侧免判）；脏条目（null）在过滤态剔除。
 * @param {Array} playlists
 * @param {string} kw
 */
export function filterPlaylists(playlists, kw) {
  if (!Array.isArray(playlists)) return [];
  const k = String(kw || '').trim().toLowerCase();
  if (!k) return playlists;
  const words = k.split(/\s+/);
  return playlists.filter(Boolean).filter((p) => {
    const hay = `${p.name || ''} ${p.desc || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
