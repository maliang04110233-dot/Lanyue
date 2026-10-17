/**
 * 歌单详情弹层的「行操作」域（阶段 4，从 views/playlist.js 抽出）：
 * 行右键菜单、行定位/清拖痕、拖拽排序持久化、单曲移除。
 * 事件监听仍由 views/playlist.js 按实例注册（保持 per-?ck 语义不变），
 * 本模块只提供 handler —— 不在这层摸 document.addEventListener。
 * 只依赖纯函数模块、plState、core.js 与渲染层全局，不回调兼容层。
 */
import { t } from '../../i18n.js';
import { errBrief } from '../../errBrief.js';
import { openSongRowMenu } from '../../songMenu.js';
import { moveInList } from '../../playlistSort.js';
import { plState } from './state.js';
import { renderPlaylistDetailSongs, renderPlaylistList } from './core.js';
// ── 行右键菜单（业务项在 ../../songMenu.js 共享）──────────
function playlistRowContext(e) {
  const list = document.getElementById('playlistDetailSongs');
  const row = e.target && e.target.closest ? e.target.closest('.song-row') : null;
  if (!list || !row || !list.contains(row)) return;
  const idx = Number(row.getAttribute('data-pidx'));
  const song = plState._currentDetailSongs[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => playPlaylistSong(idx),
    download: () => downloadPlaylistSong(idx),
    downloadQuality: (q) => downloadPlaylistSong(idx, q),
    addToQueue: () => addPlaylistSongToQueue(idx),
    extra: [{
      icon: '✕', label: '从歌单移除', danger: true,
      onClick: () => removeSongFromPlaylist(String(song.id), String(song.source || '')),
    }],
  });
}
function _plRowUnder(e) {
  const list = document.getElementById('playlistDetailSongs');
  const row = e.target && e.target.closest ? e.target.closest('.song-row[data-pidx]') : null;
  if (!list || !row || !list.contains(row)) return null;
  const n = Number(row.getAttribute('data-pidx'));
  return Number.isFinite(n) ? { idx: n, row } : null;
}
function _plClearDragMarks() {
  document.querySelectorAll('.song-row.pl-dragging, .song-row.pl-drag-over')
    .forEach(el => el.classList.remove('pl-dragging', 'pl-drag-over'));
}
async function persistPlaylistOrder(from, to) {
  if (!plState._currentPlaylistId) return;
  const next = moveInList(plState._currentDetailSongs, from, to);
  if (!next) return;
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === plState._currentPlaylistId);
  if (!pl) return;
  renderPlaylistDetailSongs(next); // 先落视觉，失败再回滚
  try {
    const r = await api.saveUserPlaylist({ id: pl.id, name: pl.name, songs: next });
    if (!r || !r.success) throw new Error((r && r.error) || '保存失败');
    pl.songs = next;
    setState('userPlaylists', playlists);
    renderPlaylistList(playlists);
  } catch (err) {
    showToast(t('toast.plSortSaveFailed', { msg: errBrief(err) }), 'error');
    renderPlaylistDetailSongs(pl.songs || []);
  }
}
// ── 从歌单移除歌曲 ─────────────────────────────────────
async function removeSongFromPlaylist(songId, source) {
  if (!plState._currentPlaylistId) return;
  try {
    const result = await api.removeFromUserPlaylist(plState._currentPlaylistId, String(songId), String(source || ''));
    if (result.success) {
      const playlists = getState('userPlaylists') || [];
      const pl = playlists.find(p => p.id === plState._currentPlaylistId);
      if (pl) {
        pl.songs = pl.songs.filter(s => !(
          String(s.id) === String(songId) &&
          String(s.source || '') === String(source || '')
        ));
        setState('userPlaylists', playlists);
        renderPlaylistDetailSongs(pl.songs);
        renderPlaylistList(playlists);
      }
    }
  } catch (e) {
    showToast(t('toast.plRemoveFailed', { msg: errBrief(e) }), 'error');
  }
}

export {
  playlistRowContext,
  _plRowUnder,
  _plClearDragMarks,
  persistPlaylistOrder,
  removeSongFromPlaylist,
};
