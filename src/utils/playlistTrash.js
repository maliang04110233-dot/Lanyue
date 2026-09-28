/**
 * 歌单回收站规则—— 纯数组函数，不碰 prefs / fs，node 可单测
 *
 * 审计 F2 的第一层：删除必须可撤销。此前 delete-user-playlist 是
 * `playlists.filter(...)` 的硬删，含几十首歌的歌单一确认就人间蒸发。
 * 本模块把"删"变成"挪进独立 prefs 键 playlistTrash"：
 *   - 不往 userPlaylists 数组里掺墓碑 —— 它有 14 处消费方（fileRelink、
 *     cloudSync、渲染层派生态……），混进 deleted 标记必然处处漏判；
 *   - 回收站单独存键，云同步/导出都不带上它（删了又跨设备复活是另一码事，
 *     撤销这件事本来就是本机 5 秒内的动作）；
 *   - 保留 30 天（TTL）+ 条数上限（MAX_TRASH），超旧的在启动时清。
 *
 * 撤销不需要新 IPC 通道：渲染层手里就有被删对象的完整副本，走既有
 * save-user-playlist 带回原 id 保存 → 主进程在列表里找不到 → 查回收站
 * → 就地恢复（契约 args 形状一字未动）。
 */

/** 回收站保留时长：30 天。到期彻底删除（8be067b 的回收站视图以此为倒计时锚） */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 回收站条数上限：删得再多也只留最近这些，防 prefs.json 无限膨胀 */
const MAX_TRASH = 200;

/** 天数换算基准（trashView 的 daysLeft 用） */
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function _arr(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * 删除 = 挪进回收站。
 * 找不到 id ⇒ removed=null 且原样退回两个数组（调用方据此报"歌单不存在"）。
 * 返回全新数组，入参零突变。
 */
function trashRemove(playlists, trash, id, now) {
  const list = _arr(playlists);
  const tr = _arr(trash);
  const idx = list.findIndex(p => p && p.id === id);
  if (idx < 0) return { playlists: list, trash: tr, removed: null };
  const next = list.slice();
  const [pl] = next.splice(idx, 1);
  let nextTrash = [{ playlist: pl, deletedAt: now }, ...tr];
  if (nextTrash.length > MAX_TRASH) nextTrash = nextTrash.slice(0, MAX_TRASH);
  return { playlists: next, trash: nextTrash, removed: pl };
}

/**
 * 撤销 = 从回收站放回（由 save-user-playlist 的"带 id 但列表里找不到"分支调用）。
 * playlist 用调用方递来的对象原样插入队首，id 保持不变 ——
 * 一切按 id 记的东西（封面缓存等）都靠这个不变量。
 *   - id 已在列表（比如云同步又把它带回来了）⇒ 只清回收站条目，restored=null、inPlaylist=true；
 *   - 回收站里也没有 ⇒ restored=null、inPlaylist=false，调用方走原新建逻辑。
 */
function trashRestore(playlists, trash, playlist) {
  const list = _arr(playlists);
  const tr = _arr(trash);
  const id = playlist && playlist.id;
  if (!id) return { playlists: list, trash: tr, restored: null, inPlaylist: false };
  const idx = tr.findIndex(e => e && e.playlist && e.playlist.id === id);
  if (idx < 0) return { playlists: list, trash: tr, restored: null, inPlaylist: list.some(p => p && p.id === id) };
  const nextTrash = tr.slice();
  nextTrash.splice(idx, 1);
  if (list.some(p => p && p.id === id)) {
    return { playlists: list, trash: nextTrash, restored: null, inPlaylist: true };
  }
  return { playlists: [playlist, ...list], trash: nextTrash, restored: playlist, inPlaylist: false };
}

/**
 * 启动时清掉过期条目。deletedAt 不是数字的脏条目按"最老"处理一并清 ——
 * 这种条目恢复出去也是来路不明的半成品。
 */
function purgeExpired(trash, now) {
  const tr = _arr(trash);
  const kept = [];
  const purged = [];
  for (const e of tr) {
    const ok = e && e.playlist
      && typeof e.deletedAt === 'number'
      && now - e.deletedAt < TRASH_TTL_MS;
    (ok ? kept : purged).push(e);
  }
  return { trash: kept, purged };
}

/**
 * 回收站列表视图：脏条目就地丢弃、新删的排前面，并替渲染层把
 * "还剩几天"算好 —— TTL 的默认值只有本模块一个家，渲染层不许自己拿 30 去减。
 * playlist 保持原样嵌套（不摊平）：恢复走 save-user-playlist 时传的就是这份原货，
 * 掺进 daysLeft 之类的视图字段会把它污染进 userPlaylists。
 */
function trashView(trash, now) {
  return _arr(trash)
    .filter(e => e && e.playlist && typeof e.deletedAt === 'number')
    .slice()
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .map(e => ({
      playlist: e.playlist,
      deletedAt: e.deletedAt,
      daysLeft: Math.max(1, Math.ceil((e.deletedAt + TRASH_TTL_MS - now) / DAY_IN_MS)),
    }));
}

/** 从回收站彻底删除（渲染层对已进站 id 再调一次 delete-user-playlist 即触发） */
function trashPurge(trash, id) {
  const tr = _arr(trash);
  const idx = tr.findIndex(e => e && e.playlist && e.playlist.id === id);
  if (idx < 0) return { trash: tr, purged: null };
  const next = tr.slice();
  const [entry] = next.splice(idx, 1);
  return { trash: next, purged: entry };
}

module.exports = { trashRemove, trashRestore, purgeExpired, trashView, trashPurge, TRASH_TTL_MS, MAX_TRASH };
