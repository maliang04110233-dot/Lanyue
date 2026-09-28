/**
 * 歌单「另存副本」纯函数
 *
 * 副本 = 用 save-user-playlist 的「无 id 即新建」通道原样复制一份：
 * 在线曲目（source+id）原样带走，m3u 本地匹配那套会丢歌的路子不走。
 * 撞名策略：`X (副本)` → 占用则 `X (副本2)`、`X (副本3)`… 逐个让位。
 */

function dupPlaylistName(name, existingNames) {
  const base = String(name == null ? '' : name).trim() || '歌单';
  const taken = new Set((existingNames || []).map(n => String(n)));
  let cand = base + ' (副本)';
  for (let i = 2; taken.has(cand); i++) cand = base + ' (副本' + i + ')';
  return cand;
}

/** 新建载荷：刻意不含 id —— 带 id 会变成整单更新覆盖原单 */
function dupPlaylistPayload(pl, newName) {
  const src = pl || {};
  return {
    name: newName,
    desc: String(src.desc || ''),
    cover: String(src.cover || ''),
    songs: Array.isArray(src.songs) ? src.songs.slice() : [],
  };
}

export { dupPlaylistName, dupPlaylistPayload };
