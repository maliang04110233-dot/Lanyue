/**
 * MusicDL 用户歌单视图
 *
 * 2026-09-14 重建：原文件因批量编辑事故留下 6 处函数体未闭合（靠文件尾
 * 游离 `}` 凑配平），且所有函数未挂 window——HTML onclick 无法调用，
 * 页面容器（userPlaylistGrid 等）也不存在于 index.html，属"从未接通"
 * 的半成品。本版修复结构 + 桥接 + 配套 UI 容器，与后端 ipc/playlist.js
 * （5 个 handler，prefs 持久化）完整接通。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';
import { FAVORITES_PLAYLIST_ID, subscribe } from '../state.js';
import { resolveQuality } from '../quality.js';
import { addDlChangeListener } from '../dlStatus.js';
import { nextPlSortMode, nextPlCardSortMode, PL_CARD_MODES } from '../playlistSort.js';
import { normalizeCoverUrl, pickFirstSongCover } from '../playlistCover.js';
import { findCrossPlaylistDupes, dedupeScanText, planConsolidate } from '../plDedupeScan.js';
import { enrichExportSongs, buildPathMap } from '../playlistExport.js';
import { mergeSongLists } from '../playlistMerge.js';
import { indexOfPlaying, flashRow } from '../locatePlaying.js';
import { sanitizeFileBase } from '../artistGroups.js';
import { plSongKey, splitBySelection, keysOf } from '../plBulkRemove.js';
import { planSelEnqueue, enqueueSkipSuffix } from '../plSelBatch.js';
import { nextPlDlMode } from '../plDlFilter.js';
import { dupPlaylistName, dupPlaylistPayload } from '../plDuplicate.js';
import { toTrackLines } from '../songListText.js';
import { copyText } from '../songShare.js';
import { isRangeClick, rangeKeys } from '../selectionRange.js';
import { registerDeleteScope } from '../deleteScope.js';
import { plState } from './playlist/state.js';
import { _plRenderIdle, _plRenderBusy } from './playlist/render.js';
import { playPlaylistSong, _playFrom, addPlaylistSongToQueue, downloadPlaylistSong, playAllPlaylist, downloadAllPlaylist } from './playlist/playback.js';
import { renderPlaylistList, openPlaylistDetail, closePlaylistDetail, _plVisiblePairs, renderPlaylistDetailSongs, _syncPlSortBtn, _syncPlDlBtn, _syncPlSelBtns } from './playlist/core.js';
import { playlistRowContext, _plRowUnder, _plClearDragMarks, persistPlaylistOrder, removeSongFromPlaylist } from './playlist/detail.js';

// ── 状态 ─────────────────────────────────────────────
// 模块级状态已迁出到 ./playlist/state.js 的 plState 对象（阶段 4 第 A 步）。
// 函数内部通过 plState._xxx 读写，与原模块级变量语义一致。

// ── 加载歌单列表 ──────────────────────────────────────
async function loadUserPlaylists() {
  try {
    const playlists = await api.getUserPlaylists();
    setState('userPlaylists', playlists || []);
    renderPlaylistList(playlists || []);
  } catch (e) {
    logger.error('加载歌单失败:', e);
    showToast(t('toast.plLoadFailed', { msg: errBrief(e) }), 'error');
  }
  // 回收站徽标跟着列表一起刷新（删除/撤销/恢复都经过这里；自身带 try/catch，不打扰主流程）
  refreshPlTrash();
}

// ── 渲染歌单列表 / 打开与关闭详情 / 渲染详情歌曲列表 ──
// 已抽到 ./playlist/core.js（含视图管线 _plVisiblePairs 与按钮同步）。
// loadUserPlaylists 留在本文件：它要回调本域 refreshPlTrash，避免反向依赖。
// 行右键菜单的 handler 已抽到 ./playlist/detail.js（监听仍按实例挂载）。
document.addEventListener('contextmenu', playlistRowContext);

// ── 拖拽排序（把手起拖 → 落到目标行占据该位置）──────────
// 复用现有 save-user-playlist 通道做全量 songs 覆盖，不新增 IPC。
plState._plDragFrom = -1;

// 行定位（_plRowUnder）与清拖痕（_plClearDragMarks）已抽到 ./playlist/detail.js。
document.addEventListener('dragstart', (e) => {
  if (!(e.target && e.target.closest && e.target.closest('.pl-drag-handle'))) return;
  // 分片还在跑 ⇒ 列表正在往下长。此时起拖，用户能瞄到的只有"已经画出来的那几片"，
  // 落点索引会按半个列表解释，persistPlaylistOrder 于是把歌挪到用户没瞄准的位置。
  // 宁可这一下不起拖（分片通常一两帧就完，窗口极短），也不写错序。
  if (_plRenderBusy()) { e.preventDefault(); return; }
  const hit = _plRowUnder(e);
  if (!hit) return;
  plState._plDragFrom = hit.idx;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(hit.idx)); // Firefox：不设数据不给拖
  }
  hit.row.classList.add('pl-dragging');
});

document.addEventListener('dragover', (e) => {
  if (plState._plDragFrom < 0) return;
  const hit = _plRowUnder(e);
  if (!hit || hit.idx === plState._plDragFrom) return;
  e.preventDefault();
  document.querySelectorAll('.song-row.pl-drag-over')
    .forEach(el => el.classList.remove('pl-drag-over'));
  hit.row.classList.add('pl-drag-over');
});

document.addEventListener('drop', (e) => {
  const from = plState._plDragFrom;
  plState._plDragFrom = -1;
  _plClearDragMarks();
  if (from < 0) return;
  // dragstart 拦过一次还不够：拖拽途中可能来了一次重渲染（别的动作保存了歌单、
  // 收藏同步触发了重画），那时 from 是**旧**列表的下标，落到新列表上就是错歌错位。
  // 这是 persistPlaylistOrder 的唯一入口，守住它就等于守住排序通道。
  if (_plRenderBusy()) return;
  const hit = _plRowUnder(e);
  if (!hit || hit.idx === from) return;
  e.preventDefault();
  persistPlaylistOrder(from, hit.idx);
});

document.addEventListener('dragend', () => {
  plState._plDragFrom = -1;
  _plClearDragMarks();
});

// 拖拽落点后的持久化已抽到 ./playlist/detail.js。
// ── 播放歌单中的歌曲 / 添加队列 / 下载（单曲·整单）──
// 已抽到 ./playlist/playback.js：playPlaylistSong / _playFrom / addPlaylistSongToQueue /
// downloadPlaylistSong / playAllPlaylist / downloadAllPlaylist 由该模块导出。
// 详情弹窗打开期间队列/历史变化 → 防抖重渲染徽标
plState._plDlTimer = null;
addDlChangeListener(() => {
  const modal = document.getElementById('playlistDetailModal');
  if (!modal || modal.classList.contains('hidden') || plState._plDlTimer) return;
  plState._plDlTimer = setTimeout(() => {
    plState._plDlTimer = null;
    if (plState._currentPlaylistId && plState._currentDetailSongs.length) renderPlaylistDetailSongs(plState._currentDetailSongs);
  }, 300);
});

// 单曲移除已抽到 ./playlist/detail.js（与行右键菜单 / 拖拽排序同域）。
// ── 多选批量移除───────────────────────────────
// 多选选择态的重置 / 工具条按钮同步已抽到 ./playlist/core.js（详情弹层的一部分）。
function togglePlBulkMode() {
  plState._plSelMode = !plState._plSelMode;
  if (!plState._plSelMode) { plState._plSelKeys = new Set(); plState._plSelAnchor = null; }
  renderPlaylistDetailSongs(plState._currentDetailSongs);
}

/**
 * 勾选/取消一行；按住 Shift 时把「锚点 → 本次点击」整段并入选中态。
 *
 * idx 是**存储序**下标（行号显示与 playPlaylistSong 都用它），连选要的是
 * **视图序**区间，所以先按 pairs 里的 i 找回该行在视图里的位置再算区间 ——
 * 排序模式下两者不一致，直接拿 idx 当视图下标会连错行。
 */
function togglePlSongSel(idx, e) {
  const song = plState._currentDetailSongs[idx];
  if (!song) return;
  const k = plSongKey(song);
  if (isRangeClick(e)) {
    const pairs = _plVisiblePairs(plState._currentDetailSongs);
    const at = pairs.findIndex((p) => p.i === idx);
    if (at >= 0) {
      for (const key of rangeKeys(pairs.map((p) => plSongKey(p.song)), plState._plSelAnchor, at)) {
        plState._plSelKeys.add(key);
      }
      renderPlaylistDetailSongs(plState._currentDetailSongs);
      return;
    }
  }
  if (plState._plSelKeys.has(k)) plState._plSelKeys.delete(k);
  else plState._plSelKeys.add(k);
  plState._plSelAnchor = k;
  renderPlaylistDetailSongs(plState._currentDetailSongs);
}

/** 全选/取消全选「当前过滤视图」的歌（隐形歌不动） */
function plSelectAllVisible() {
  const pairs = _plVisiblePairs(plState._currentDetailSongs);
  const vis = keysOf(pairs.map(p => p.song));
  if (!vis.size) { showToast(t('toast.plNoVisibleSongs'), 'info'); return; }
  const allOn = [...vis].every(k => plState._plSelKeys.has(k));
  for (const k of vis) {
    if (allOn) plState._plSelKeys.delete(k);
    else plState._plSelKeys.add(k);
  }
  renderPlaylistDetailSongs(plState._currentDetailSongs);
}

async function removeCheckedFromPlaylist() {
  if (!plState._plSelKeys.size) { showToast(t('toast.plPickRemoveFirst'), 'warn'); return; }
  if (!plState._currentPlaylistId) return;
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === plState._currentPlaylistId);
  if (!pl) return;
  const { keep, removed } = splitBySelection(pl.songs || [], plState._plSelKeys);
  if (!removed.length) { plState._plSelKeys = new Set(); _syncPlSelBtns(); return; }
  if (!await askConfirm(t('toast.plConfirmRemove', { count: removed.length, name: pl.name }))) return;
  try {
    const r = await api.saveUserPlaylist({
      id: pl.id, name: pl.name, desc: pl.desc || '', cover: pl.cover || '', songs: keep,
    });
    if (r && r.success && r.playlist) {
      const i = playlists.findIndex(p => p.id === pl.id);
      if (i >= 0) {
        playlists[i] = r.playlist;
        setState('userPlaylists', playlists);
      }
      plState._plSelKeys = new Set();
      renderPlaylistDetailSongs(r.playlist.songs || []);
      renderPlaylistList(playlists);
      showToast(t('toast.plRemoved', { count: removed.length }), 'success');
    } else {
      showToast((r && r.error) || t('toast.plRemoveFailedShort'), 'error');
    }
  } catch (e) {
    logger.error('[removeCheckedFromPlaylist] 失败:', e);
    showToast(t('toast.plRemoveFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 多选批量动作：下载已勾选 / 播放已勾选 ─────────
/** 按歌单存储序取出勾选的歌（与99移除同一条链：键集现算，隐形/已消失的自然跳过） */
function _plSelPicked() {
  return splitBySelection(plState._currentDetailSongs, plState._plSelKeys).removed;
}

async function plSelDownload() {
  const picked = _plSelPicked();
  if (!picked.length) { showToast(t('toast.plPickDownloadFirst'), 'warn'); return; }
  const saveDir = getState('saveDir');
  const { toEnqueue, skipped } = planSelEnqueue(picked, getState('queueSnapshot') || []);
  let queued = 0, dlSkipped = 0;
  for (const song of toEnqueue) {
    try {
      // 批量场景：历史已下载且文件还在 → 主进程静默跳过，这里只计数（同整单入队）
      const r = await api.addToQueue({ ...song, saveDir, quality: resolveQuality(song.source) });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    } catch (e) { logger.warn('歌单多选入队失败:', song.title, e.message); }
  }
  showToast(t('toast.plBatchQueued', { count: queued, extra: enqueueSkipSuffix(skipped, dlSkipped) }),
    queued || dlSkipped ? 'success' : 'info', 3200);
}

async function plSelPlay() {
  const picked = _plSelPicked();
  if (!picked.length) { showToast(t('toast.plPickPlayFirst'), 'warn'); return; }
  // 勾选的歌单独组成播放队列，从第一首起连播（整单 playQueue 被替换是刻意语义）
  await _playFrom(picked, 0);
}

// ── 新建 / 编辑歌单 ────────────────────────────────────
function openPlaylistEditor(playlistId) {
  const modal = document.getElementById('playlistEditorModal');
  const titleEl = document.getElementById('playlistEditorTitle');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');
  const coverInput = document.getElementById('playlistEditorCover');
  const pickBtn = document.getElementById('playlistCoverPick');
  if (!modal || !nameInput) return;

  if (playlistId) {
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (pl) {
      titleEl.textContent = '✏️ 编辑歌单';
      nameInput.value = pl.name;
      descInput.value = pl.desc || '';
      if (coverInput) coverInput.value = pl.cover || '';
      // 「用首曲封面」只在歌内可能有封面的已有歌单里可用
      if (pickBtn) pickBtn.style.display = (pl.songs || []).length ? '' : 'none';
      modal.dataset.editId = playlistId;
    }
  } else {
    titleEl.textContent = '📋 新建歌单';
    nameInput.value = '';
    descInput.value = '';
    if (coverInput) coverInput.value = '';
    if (pickBtn) pickBtn.style.display = 'none';
    delete modal.dataset.editId;
  }

  modal.classList.remove('hidden');
  nameInput.focus();
}

/** 一键把歌单里第一张歌曲封面填进封面输入框 */
function useFirstSongCover() {
  const modal = document.getElementById('playlistEditorModal');
  const coverInput = document.getElementById('playlistEditorCover');
  const pl = (getState('userPlaylists') || []).find(p => p.id === modal.dataset.editId);
  const c = pickFirstSongCover(pl && pl.songs);
  if (!c) { showToast(t('toast.plNoCoverInSongs'), 'warn'); return; }
  coverInput.value = c;
}

function closePlaylistEditor() {
  document.getElementById('playlistEditorModal').classList.add('hidden');
}

async function savePlaylist() {
  const modal = document.getElementById('playlistEditorModal');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');
  const coverInput = document.getElementById('playlistEditorCover');
  if (!modal || !nameInput) return;

  const name = nameInput.value.trim();
  if (!name) {
    showToast(t('toast.plNameRequired'), 'warn');
    nameInput.focus();
    return;
  }

  // 封面留空=清除（''），非法协议直接拦下（normalizeCoverUrl 非 http(s) → null）
  const cover = coverInput ? normalizeCoverUrl(coverInput.value) : '';
  if (cover === null) {
    showToast(t('toast.plCoverHttpRequired'), 'warn');
    if (coverInput) coverInput.focus();
    return;
  }

  const editId = modal.dataset.editId;
  const playlists = getState('userPlaylists') || [];
  const pl = editId ? playlists.find(p => p.id === editId) : undefined;

  const payload = {
    ...(editId ? { id: editId } : {}),
    name,
    desc: descInput.value.trim(),
    cover,
    songs: pl ? pl.songs : [],
  };

  try {
    const result = await api.saveUserPlaylist(payload);
    if (result.success) {
      await loadUserPlaylists();
      closePlaylistEditor();
      showToast(editId ? t('toast.plUpdated') : t('toast.plCreated'), 'success');
    } else {
      showToast(result.error || t('toast.saveFailed'), 'error');
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

// ── 编辑 / 删除歌单 ───────────────────────────────────
function editPlaylist(playlistId) {
  openPlaylistEditor(playlistId);
}

async function deletePlaylist(playlistId) {
  // （审计 F2）：删除必见影响 —— 确认框点名歌单与歌数，
  // 删后 5 秒撤销窗口（走 utils.showActionToast，回收站兜底见 main/ipc/playlist.js）
  const pl = (getState('userPlaylists') || []).find(p => p && p.id === playlistId);
  if (!pl) { showToast(t('toast.plNotFound'), 'warn'); return; }
  const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
  if (!await askConfirm(t('toast.plConfirmDelete', { name: pl.name, count: n }))) return;
  try {
    const result = await api.deleteUserPlaylist(playlistId);
    if (result.success) {
      await loadUserPlaylists();
      showActionToast({
        text: t('toast.plDeleted', { name: pl.name }),
        btnLabel: t('toast.undo'),
        ttl: 5000,
        onConfirm: () => undoDeletePlaylist(pl),
      });
    } else {
      showToast(result.error || t('toast.deleteFailedShort'), 'error');
    }
  } catch (e) {
    showToast(t('toast.deleteFailedMsg', { msg: errBrief(e) }), 'error');
  }
}

/** 撤销删除：攥着被删对象的完整副本走既有 save-user-playlist 原 id 保存，
 *  主进程"带 id 却不在列表 ⇒ 查回收站放回"分支承接（零新 IPC 通道） */
async function undoDeletePlaylist(pl) {
  try {
    const back = await api.saveUserPlaylist(pl);
    if (back && back.success) {
      await loadUserPlaylists();
      showToast(t('toast.plUndoDeleted', { name: pl.name }), 'success');
    } else {
      showToast((back && back.error) || t('toast.plUndoFailedShort'), 'error');
    }
  } catch (e) {
    showToast(t('toast.plUndoFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 回收站视图（F2 第三层兜底 —— 没赶上 5 秒撤销的歌单在这里找回）──
// 数据源仍是既有 get-user-playlists 频道（opts.trash=true 换视图），零新 IPC 通道；
// 恢复走 save-user-playlist 的"带 id 却不在列表 ⇒ 从回收站放回"分支，
// 彻底删除走 delete-user-playlist 的"再删一次回收站里的 id"分支。
plState._plTrash = [];

async function refreshPlTrash() {
  try {
    plState._plTrash = (await api.getUserPlaylists({ trash: true })) || [];
  } catch (e) {
    // 徽标刷新失败不该惊动用户主流程，静默保持上一次状态
    logger.warn('回收站计数刷新失败:', e);
    return;
  }
  const btn = document.getElementById('plTrashBtn');
  if (btn) {
    btn.style.display = plState._plTrash.length ? '' : 'none';
    btn.textContent = t('pl.trash.btn', { n: plState._plTrash.length });
  }
  const modal = document.getElementById('playlistTrashModal');
  if (modal && !modal.classList.contains('hidden')) renderPlTrashList();
}

/** 渲染弹窗内容：每行「歌单名 · N 首歌 · 剩余 X 天」+ 恢复 / 彻底删除 */
function renderPlTrashList() {
  const box = document.getElementById('playlistTrashList');
  if (!box) return;
  if (!plState._plTrash.length) {
    box.innerHTML = `<div class="empty" style="padding:24px 0;">${t('pl.trash.empty')}</div>`;
    return;
  }
  box.innerHTML = plState._plTrash.map(e => {
    const pl = e.playlist || {};
    const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
    const when = new Date(e.deletedAt || 0);
    const dateStr = t('pl.trash.date', { m: when.getMonth() + 1, d: when.getDate() });
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--stroke-1);">
      <div style="flex:1;min-width:0;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${esc(pl.name || t('pl.trash.unnamed'))}</div>
        <div style="font-size:12px;color:var(--fg-3);">${t('pl.trash.meta', { n, date: dateStr, days: e.daysLeft ?? '?' })}</div>
      </div>
      <button class="btn-sm" onclick="restoreTrashedPlaylist('${escQ(pl.id)}')">${t('pl.trash.restore')}</button>
      <button class="btn-sm" style="color:var(--c-danger);" onclick="purgeTrashedPlaylist('${escQ(pl.id)}')">${t('pl.trash.purge')}</button>
    </div>`;
  }).join('');
}

function openPlaylistTrash() {
  const modal = document.getElementById('playlistTrashModal');
  if (!modal) return;
  renderPlTrashList();
  modal.classList.remove('hidden');
  refreshPlTrash();
}

function closePlaylistTrash() {
  document.getElementById('playlistTrashModal').classList.add('hidden');
}

async function restoreTrashedPlaylist(playlistId) {
  const e = plState._plTrash.find(t => t.playlist && t.playlist.id === playlistId);
  if (!e) { showToast(t('toast.plNotInTrash'), 'warn'); return; }
  try {
    const r = await api.saveUserPlaylist(e.playlist);
    if (r && r.success) {
      await loadUserPlaylists();
      showToast(t('toast.plRestored', { name: e.playlist.name }), 'success');
    } else {
      showToast((r && r.error) || t('toast.plRestoreFailedShort'), 'error');
    }
  } catch (err) {
    showToast(t('toast.plRestoreFailed', { msg: errBrief(err) }), 'error');
  }
}

async function purgeTrashedPlaylist(playlistId) {
  // 彻底删除是真正不可逆的一层，确认框照 F2 纪律点名歌单与歌数
  const e = plState._plTrash.find(t => t.playlist && t.playlist.id === playlistId);
  if (!e) { showToast(t('toast.plNotInTrash'), 'warn'); return; }
  const pl = e.playlist;
  const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
  if (!await askConfirm(t('toast.plConfirmPurge', { name: pl.name, count: n }))) return;
  try {
    const r = await api.deleteUserPlaylist(playlistId);
    if (r && r.success) {
      await refreshPlTrash();
      showToast(t('toast.plPurged', { name: pl.name }), 'success');
    } else {
      showToast((r && r.error) || t('toast.deleteFailedShort'), 'error');
    }
  } catch (err) {
    showToast(t('toast.deleteFailedMsg', { msg: errBrief(err) }), 'error');
  }
}


// ── 快速添加到歌单（搜索结果右键/批量工具条调用；单曲或数组皆可）──
async function quickAddToPlaylist(songOrList) {
  try {
    const list = Array.isArray(songOrList) ? songOrList.filter(Boolean) : [songOrList];
    if (!list.length) return;
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
      showToast(t('toast.plCreateFirst'), 'warn');
      openPlaylistEditor(null);
      return;
    }
    if (playlists.length === 1) {
      if (list.length === 1) await addToPlaylistAndNotify(playlists[0].id, list[0]);
      else await _addListToPlaylist(playlists[0].id, list);
      return;
    }
    showPlaylistSelectModal(list, playlists);
  } catch (e) {
    logger.error('[quickAddToPlaylist] error:', e);
  }
}

function showPlaylistSelectModal(song, playlists) {
  try {
    const modal = document.getElementById('playlistSelectModal');
    const list = document.getElementById('playlistSelectList');
    if (!modal || !list) return;

    list.innerHTML = playlists.map(pl => `
      <div class="playlist-select-item" tabindex="0" role="button" onclick="addToSelectedPlaylist('${escQ(pl.id)}')">
        <span class="playlist-select-icon">🎼</span>
        <span class="playlist-select-name">${esc(pl.name)}</span>
        <span class="playlist-select-count" style="font-size:11px;color:var(--neon-dim);">${pl.songs?.length || 0} 首</span>
      </div>
    `).join('');

    modal.dataset.song = JSON.stringify(song);
    modal.classList.remove('hidden');
  } catch (e) {
    logger.error('[showPlaylistSelectModal] error:', e);
  }
}

function closePlaylistSelectModal() {
  document.getElementById('playlistSelectModal').classList.add('hidden');
}

async function addToSelectedPlaylist(playlistId) {
  try {
    const modal = document.getElementById('playlistSelectModal');
    const songStr = modal.dataset.song;
    if (!songStr) return;
    const raw = JSON.parse(songStr);
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.length) return;
    if (list.length === 1) await addToPlaylistAndNotify(playlistId, list[0]);
    else await _addListToPlaylist(playlistId, list);
    closePlaylistSelectModal();
  } catch (e) {
    logger.error('[addToSelectedPlaylist] error:', e);
  }
}

/** 批量逐条加歌（引擎端自带 id+source 去重=skipped）；一次汇总 toast */
async function _addListToPlaylist(playlistId, list) {
  let added = 0, skipped = 0, failed = 0, lastPl = null;
  for (const song of list) {
    try {
      const r = await api.addToUserPlaylist(playlistId, song);
      if (r && r.success) {
        if (r.skipped) skipped++;
        else { added++; if (r.playlist) lastPl = r.playlist; }
      } else failed++;
    } catch (_e) { failed++; }
  }
  if (lastPl) {
    const playlists = getState('userPlaylists') || [];
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx >= 0) {
      playlists[idx] = lastPl;
      setState('userPlaylists', playlists);
      renderPlaylistList(playlists);
      if (plState._currentPlaylistId === playlistId) renderPlaylistDetailSongs(lastPl.songs || []);
    }
  }
  // 汇总串三段都是词条，段间分隔用语言中立的间隔号（同 app.js:1057 的批量入队汇总）：
  // 分句硬编码中文时 LEDGER 判据失明（首实参是 parts.join(...) 表达式，扫不到字面量），
  // 台账归零而英文界面照旧整句中文 —— 只把分隔符接进词典是"假进度"里最隐蔽的一种。
  const parts = [];
  if (added) parts.push(t('toast.batchQueued', { count: added, extra: '' }));
  if (skipped) parts.push(t('toast.plBatchSkipped', { count: skipped }));
  if (failed) parts.push(t('toast.plBatchAddFailed', { count: failed }));
  showToast(parts.length ? parts.join(t('toast.listSeparator')) : t('toast.plNothingAdded'), added ? 'success' : 'warn');
}

async function addToPlaylistAndNotify(playlistId, song) {
  try {
    const result = await api.addToUserPlaylist(playlistId, song);
    if (result.success) {
      if (result.skipped) {
        showToast(t('toast.plSongAlreadyIn'), 'warn');
      } else {
        showToast(t('toast.plSongAdded'), 'success');
        const playlists = getState('userPlaylists') || [];
        const idx = playlists.findIndex(p => p.id === playlistId);
        if (idx >= 0) {
          playlists[idx] = result.playlist;
          setState('userPlaylists', playlists);
          // 该歌单详情弹层开着：外部入口（右键加歌等）也即时可见
          if (plState._currentPlaylistId === playlistId) renderPlaylistDetailSongs(result.playlist.songs || []);
        }
      }
    }
  } catch (e) {
    showToast(t('toast.plAddFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 详情过滤框（藏行不重排，行索引恒为原始下标）────────
function onPlaylistSongFilterInput(v) {
  plState._plSongKw = String(v || '');
  if (plState._currentPlaylistId) renderPlaylistDetailSongs(plState._currentDetailSongs);
}

// ── 详情视图排序（只排展示 pairs，不动存储顺序；排序中拖把手隐藏）──
// 详情排序按钮的文案同步已抽到 ./playlist/core.js（详情弹层的一部分）。
function cyclePlaylistSort() {
  plState._plSortMode = nextPlSortMode(plState._plSortMode);
  _syncPlSortBtn();
  if (plState._currentPlaylistId) renderPlaylistDetailSongs(plState._currentDetailSongs);
}

// ── 详情下载状态过滤循环（plDlFilter.js 纯函数的接线层）──
// 判定复用 dlStatusFor（与行内徽标同一来源），'done' 之外都算未下载
// 详情下载状态过滤按钮的文案同步已抽到 ./playlist/core.js（详情弹层的一部分）。
function cyclePlDlFilter() {
  plState._plDlMode = nextPlDlMode(plState._plDlMode);
  _syncPlDlBtn();
  if (plState._currentPlaylistId) renderPlaylistDetailSongs(plState._currentDetailSongs);
}

// ── 歌单页卡片排序循环（收藏系统单恒置顶，不参与排）────
function cyclePlCardSort() {
  plState._plCardSortMode = nextPlCardSortMode(plState._plCardSortMode);
  const btn = document.getElementById('playlistCardSortBtn');
  if (btn) {
    const m = PL_CARD_MODES.find((x) => x.key === plState._plCardSortMode);
    btn.textContent = m ? m.label : '↕ 默认';
  }
  renderPlaylistList(getState('userPlaylists') || []);
}

/** 卡片搜索：按名称/描述即时过滤（会话级，与排序叠加：先过滤后排序） */
function filterPlaylistCards() {
  const el = document.getElementById('playlistCardFilter');
  plState._plCardKw = el ? el.value : '';
  renderPlaylistList(getState('userPlaylists') || []);
}

// ── 歌单内快捷加歌（搜索→逐条添加，弹层不关可连加）────
plState._plAddEl = null;
plState._plAddSongs = [];
plState._plAddReqId = 0;

function _ensurePlAddModal() {
  if (plState._plAddEl && document.body.contains(plState._plAddEl)) return plState._plAddEl;
  const div = document.createElement('div');
  div.id = 'plAddModal';
  div.className = 'playlist-modal-overlay hidden';
  div.setAttribute('data-modal', '');
  div.setAttribute('data-modal-close', 'closePlaylistAddSongs');
  // 静态模板 innerHTML：不含任何用户数据，数据行走 _renderPlAddList 逐条 esc
  div.innerHTML = `
    <div class="playlist-modal" style="min-width:420px;max-width:560px;max-height:70vh;display:flex;flex-direction:column;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">${t('pl.add.title')}</span>
        <button class="playlist-modal-close" onclick="closePlaylistAddSongs()">✕</button>
      </div>
      <div style="display:flex;gap:8px;padding:12px 16px 4px;">
        <input type="text" class="setting-input" id="plAddInput" placeholder="${t('pl.add.placeholder')}" style="flex:1;" onkeydown="if(event.key==='Enter')doPlAddSearch()">
        <button class="btn-primary" style="flex-shrink:0;padding:6px 14px;" onclick="doPlAddSearch()">${t('pl.add.search')}</button>
      </div>
      <div id="plAddResults" class="playlist-modal-body" style="flex:1;min-height:0;overflow-y:auto;padding:8px 16px 16px;"></div>
    </div>`;
  div.addEventListener('click', (e) => { if (e.target === div) closePlaylistAddSongs(); });
  document.body.appendChild(div);
  plState._plAddEl = div;
  return div;
}

function openPlaylistAddSongs() {
  if (!plState._currentPlaylistId) { showToast(t('toast.plOpenFirst'), 'warn'); return; }
  const m = _ensurePlAddModal();
  m.classList.remove('hidden');
  const input = document.getElementById('plAddInput');
  input.value = getState('currentKeyword') || '';
  input.focus();
  input.select();
  document.getElementById('plAddResults').innerHTML =
    `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.add.hint')}</div>`;
}

function closePlaylistAddSongs() {
  if (plState._plAddEl) plState._plAddEl.classList.add('hidden');
}

async function doPlAddSearch() {
  const kw = (document.getElementById('plAddInput').value || '').trim();
  const box = document.getElementById('plAddResults');
  if (!kw) { showToast(t('toast.plKeywordRequired'), 'warn'); return; }
  const reqId = ++plState._plAddReqId;
  box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.add.searching')}</div>`;
  try {
    const r = await api.searchMusic(kw, 'all', 1);
    if (reqId !== plState._plAddReqId) return; // 慢响应旧请求丢弃
    plState._plAddSongs = (r && r.songs) || [];
    if (!plState._plAddSongs.length) {
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${r && r.error ? t('pl.add.searchError', { msg: esc(r.error) }) : t('pl.add.noResult')}</div>`;
      return;
    }
    _renderPlAddList();
  } catch (e) {
    if (reqId === plState._plAddReqId) {
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.add.searchFailed', { msg: esc(errBrief(e)) })}</div>`;
    }
  }
}

function _inCurrentPlaylist(song) {
  return plState._currentDetailSongs.some(s =>
    String(s.id) === String(song.id) && String(s.source || '') === String(song.source || ''));
}

function _renderPlAddList() {
  const box = document.getElementById('plAddResults');
  if (!box) return;
  box.innerHTML = plState._plAddSongs.map((s, i) => {
    const added = _inCurrentPlaylist(s);
    return `
    <div class="song-row">
      <div class="song-info">
        <div class="song-title" title="${esc(s.title)}">${esc(s.title) || '未知'}</div>
        <div class="song-meta">${esc(s.artist) || '未知'}${s.source ? ' · ' + esc(s.source) : ''}</div>
      </div>
      <span class="song-duration">${s.duration ? fmtDuration(s.duration) : '--:--'}</span>
      <div class="song-actions">
        <button class="action-btn" ${added ? 'disabled' : ''} onclick="plAddPick(${i})" title="${added ? t('pl.add.alreadyIn') : t('pl.add.addTo')}">${added ? '✓' : '➕'}</button>
      </div>
    </div>`;
  }).join('');
}

async function plAddPick(i) {
  const song = plState._plAddSongs[i];
  if (!song || !plState._currentPlaylistId) return;
  try {
    const r = await api.addToUserPlaylist(plState._currentPlaylistId, song);
    if (!r || !r.success) { showToast((r && r.error) || t('toast.plAddFailedShort'), 'error'); return; }
    if (r.skipped) showToast(t('toast.plSongAlreadyIn'), 'warn');
    else {
      showToast(t('toast.plSongAddedTitle', { title: song.title || '' }), 'success');
      const playlists = getState('userPlaylists') || [];
      const idx = playlists.findIndex(p => p.id === plState._currentPlaylistId);
      if (idx >= 0 && r.playlist) {
        playlists[idx] = r.playlist;
        setState('userPlaylists', playlists);
        renderPlaylistDetailSongs(r.playlist.songs || []);
      }
    }
    _renderPlAddList(); // 该行刷成 ✓，可继续加下一首
  } catch (e) {
    showToast(t('toast.plAddFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 导出当前打开歌单为 m3u（playlistExport 纯函数的接线层）──────
// 存储序全量导出（过滤/排序只是视图）；下载歌回填本地路径，在线歌回填平台页链接
plState._plExportBusy = false;

async function exportCurrentPlaylistM3u() {
  const songs = plState._currentDetailSongs || [];
  if (!songs.length) { showToast(t('toast.plNothingToExport'), 'warn', 2500); return; }
  if (plState._plExportBusy) return;
  plState._plExportBusy = true;
  try {
    const titleEl = document.getElementById('playlistDetailTitle');
    const name = (titleEl && titleEl.textContent.trim()) || '歌单';
    let pathMap = {};
    try {
      const h = await api.queryHistory({ status: 'done', limit: 100000 });
      pathMap = buildPathMap((h && h.items) || []);
    } catch (_e) { /* 历史不可用时退化为全页链接导出 */ }
    const r = await api.exportPlaylist({
      songs: enrichExportSongs(songs, pathMap),
      format: 'm3u',
      name: 'Lanyue-' + sanitizeFileBase(name),
    });
    if (r && r.canceled) return;
    if (r && r.success) showToast(t('toast.plExported', { count: songs.length, path: r.path }), 'success', 3500);
    else showToast((r && r.error) || t('toast.exportFailedShort'), 'error');
  } catch (e) {
    showToast(t('toast.exportFailed', { msg: errBrief(e) }), 'error');
  } finally {
    plState._plExportBusy = false;
  }
}

// ── 合并其他歌单进本歌单（playlistMerge 纯函数的接线层）──────
plState._plMergeEl = null;
plState._plMerging = false;

function _ensurePlMergeModal() {
  if (plState._plMergeEl && document.body.contains(plState._plMergeEl)) return plState._plMergeEl;
  const div = document.createElement('div');
  div.id = 'plMergeModal';
  div.className = 'playlist-modal-overlay hidden';
  div.setAttribute('data-modal', '');
  div.setAttribute('data-modal-close', 'closePlaylistMergePicker');
  // 静态模板不含用户数据；歌单行经 esc/escQ 逐条渲染
  div.innerHTML = `
    <div class="playlist-modal" style="min-width:420px;max-width:560px;max-height:70vh;display:flex;flex-direction:column;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">${t('pl.merge.title')}</span>
        <button class="playlist-modal-close" onclick="closePlaylistMergePicker()">✕</button>
      </div>
      <div id="plMergeList" class="playlist-modal-body" style="flex:1;min-height:0;overflow-y:auto;padding:8px 16px 16px;"></div>
    </div>`;
  div.addEventListener('click', (e) => { if (e.target === div) closePlaylistMergePicker(); });
  document.body.appendChild(div);
  plState._plMergeEl = div;
  return div;
}

async function openPlaylistMergePicker() {
  if (!plState._currentPlaylistId) { showToast(t('toast.plOpenFirst'), 'warn'); return; }
  const m = _ensurePlMergeModal();
  m.classList.remove('hidden');
  const box = document.getElementById('plMergeList');
  box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.merge.loading')}</div>`;
  try {
    const all = (await api.getUserPlaylists()) || [];
    const others = all.filter(p => p && p.id && p.id !== plState._currentPlaylistId);
    if (!others.length) {
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.merge.none')}</div>`;
      return;
    }
    box.innerHTML = others.map(p => `
      <div class="song-row">
        <div class="song-info">
          <div class="song-title">${esc(p.name) || t('pl.merge.unnamed')}</div>
          <div class="song-meta">${(p.songs || []).length} 首${p.desc ? ' · ' + esc(p.desc) : ''}</div>
        </div>
        <div class="song-actions">
          <button class="action-btn" onclick="mergePlaylistIntoCurrent('${escQ(p.id)}')" title="${t('pl.merge.hint')}">${t('pl.merge.do')}</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${t('pl.merge.failed', { msg: esc(errBrief(e)) })}</div>`;
  }
}

function closePlaylistMergePicker() {
  if (plState._plMergeEl) plState._plMergeEl.classList.add('hidden');
}

async function mergePlaylistIntoCurrent(srcId) {
  if (!plState._currentPlaylistId || plState._plMerging) return;
  if (srcId === plState._currentPlaylistId) { showToast(t('toast.plMergeSelf'), 'warn'); return; }
  plState._plMerging = true;
  try {
    // 实时重拉两侧：卡片列表 state 可能已被其他入口改脏
    const all = (await api.getUserPlaylists()) || [];
    const target = all.find(p => p && p.id === plState._currentPlaylistId);
    const src = all.find(p => p && p.id === srcId);
    if (!target || !src) { showToast(t('toast.plGone'), 'warn'); return; }
    const merged = mergeSongLists(target.songs || [], src.songs || []);
    if (!merged.added) {
      showToast(t('toast.plMergeNothing', { name: src.name, dup: merged.dup }), 'info');
      return;
    }
    const r = await api.saveUserPlaylist({ id: target.id, name: target.name, songs: merged.songs });
    if (!r || !r.success) { showToast(t('toast.plMergeFailedMsg', { msg: (r && r.error) || t('toast.unknownError') }), 'error'); return; }
    renderPlaylistDetailSongs((r.playlist && r.playlist.songs) || merged.songs);
    loadUserPlaylists(); // 卡片曲数/排序随合并后数据刷新
    closePlaylistMergePicker();
    showToast(t('toast.plMergeDone', { name: src.name, added: merged.added, dup: merged.dup }), 'success', 3500);
  } catch (e) {
    showToast(t('toast.plMergeFailed', { msg: errBrief(e) }), 'error');
  } finally {
    plState._plMerging = false;
  }
}

// 🧹 清理本歌单内重复歌：复用合入键（平台:id，无键退 标题|歌手），保留首次出现
plState._plDedupeBusy = false;

async function dedupeCurrentPlaylist() {
  if (!plState._currentPlaylistId || plState._plDedupeBusy) return;
  plState._plDedupeBusy = true;
  try {
    const all = (await api.getUserPlaylists()) || [];
    const pl = all.find(p => p && p.id === plState._currentPlaylistId);
    if (!pl) { showToast(t('toast.plGone'), 'warn'); return; }
    const before = (pl.songs || []).length;
    const merged = mergeSongLists(pl.songs || [], []);
    const removed = before - merged.songs.length;
    if (!removed) { showToast(t('toast.plNoDupSongs'), 'info'); return; }
    const r = await api.saveUserPlaylist({ id: pl.id, name: pl.name, songs: merged.songs });
    if (!r || !r.success) { showToast(t('toast.plCleanFailedMsg', { msg: (r && r.error) || t('toast.unknownError') }), 'error'); return; }
    renderPlaylistDetailSongs((r.playlist && r.playlist.songs) || merged.songs);
    loadUserPlaylists(); // 卡片曲数同步
    showToast(t('toast.plDeduped', { removed, kept: merged.songs.length }), 'success', 3000);
  } catch (e) {
    showToast(t('toast.plCleanFailed', { msg: errBrief(e) }), 'error');
  } finally {
    plState._plDedupeBusy = false;
  }
}

// 📋 另存副本：实时重拉整单原样复制（在线曲目 source+id 全带走），撞名递增让位；
// 无 id 的 save-user-playlist 即新建，零新通道
plState._plDupBusy = false;

async function duplicateCurrentPlaylist() {
  if (!plState._currentPlaylistId || plState._plDupBusy) return;
  plState._plDupBusy = true;
  try {
    const all = (await api.getUserPlaylists()) || [];
    const pl = all.find(p => p && p.id === plState._currentPlaylistId);
    if (!pl) { showToast(t('toast.plGone'), 'warn'); return; }
    const newName = dupPlaylistName(pl.name, all.map(p => p && p.name).filter(Boolean));
    const r = await api.saveUserPlaylist(dupPlaylistPayload(pl, newName));
    if (!r || !r.success) { showToast(t('toast.plCopyFailedMsg', { msg: (r && r.error) || t('toast.unknownError') }), 'error'); return; }
    loadUserPlaylists(); // 卡片列表随新副本刷新
    showToast(t('toast.plCopied', { name: newName, count: (pl.songs || []).length }), 'success', 3000);
  } catch (e) {
    showToast(t('toast.plCopyFailed', { msg: errBrief(e) }), 'error');
  } finally {
    plState._plDupBusy = false;
  }
}

// 📋 复制曲单：当前过滤视图整成一行一首纯文本（歌名 - 歌手）进剪贴板，
// 发群聊直接贴清单；是行级分享文案（带链接），这里是清单级，零新通道
async function copyPlaylistListText() {
  const lines = toTrackLines(_plVisiblePairs(plState._currentDetailSongs).map(p => p.song));
  if (!lines.length) { showToast(t('toast.plNothingToCopy'), 'info'); return; }
  const ok = await copyText(lines.join('\n'));
  showToast(ok ? t('toast.plCopiedTitles', { count: lines.length }) : t('toast.copyFailed'), ok ? 'success' : 'error', 2500);
}

// ── 🧮 跨歌单重复检测：纯函数扫描 + 报告弹层 + 复制，零新通道 ──
plState._dedupeGroups = [];

function showDedupeModal(groups) {
  plState._dedupeGroups = groups;
  const old = document.getElementById('dedupeScanModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dedupeScanModal';
  overlay.className = 'playlist-modal-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.innerHTML = `
    <div class="playlist-modal" style="max-width:540px;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">🧮 跨歌单重复 · ${groups.length} 首</span>
        <button class="playlist-modal-close" onclick="closeDedupeScanModal()">✕</button>
      </div>
      <div class="playlist-modal-body" style="max-height:60vh;overflow-y:auto;">
        ${groups.map((g, i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--stroke-1);">
            <div style="min-width:0;">
              <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.title)}${g.artist ? ` <span style="opacity:0.6;font-weight:400;font-size:12px;">${esc(g.artist)}</span>` : ''}</div>
              <div style="font-size:12px;color:var(--neon-dim);">${g.where.map(w => esc(w)).join('、')}</div>
            </div>
            <span style="flex:none;font-size:12px;color:var(--neon-dim);">×${g.where.length}</span>
            <button class="tab" style="flex:none;" title="保留在首见歌单，从其余歌单移出这一首（不删文件）" onclick="consolidateDup(${i})">🧲 收拢</button>
          </div>`).join('')}
        <div style="margin-top:12px;">
          <button class="btn-primary" onclick="copyDedupeScanReport()">📋 复制报告</button>
        </div>
      </div>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeDedupeScanModal(); };
  document.body.appendChild(overlay);
}

function scanCrossPlaylistDupes() {
  const pls = (getState('userPlaylists') || []).filter(p => p && Array.isArray(p.songs));
  if (pls.length < 2) { showToast(t('toast.plNeedTwoForDup'), 'info'); return; }
  const groups = findCrossPlaylistDupes(pls);
  if (!groups.length) { showToast(t('toast.plNoCrossDup', { count: pls.length }), 'success', 2500); return; }
  showDedupeModal(groups);
}

function closeDedupeScanModal() {
  const m = document.getElementById('dedupeScanModal');
  if (m) m.remove();
}

async function copyDedupeScanReport() {
  const body = dedupeScanText(plState._dedupeGroups);
  if (!body) { showToast(t('toast.plNothingToCopyContent'), 'info'); return; }
  const ok = await copyText(`🧮 揽乐 跨歌单重复报告（${plState._dedupeGroups.length} 首）\n${body}`);
  showToast(ok ? t('toast.plDupReportCopied') : t('toast.copyFailed'), ok ? 'success' : 'error', 2500);
}

/** 🧲 收拢一组重复：留首见单、其余整单更新，写完重扫刷新弹层 */
async function consolidateDup(i) {
  const g = plState._dedupeGroups[i];
  if (!g || !g.key) { showToast(t('toast.plNoKeyToConsolidate'), 'warn'); return; }
  const plan = planConsolidate(getState('userPlaylists') || [], g.key);
  if (!plan) { showToast(t('toast.plSongChanged'), 'info'); closeDedupeScanModal(); return; }
  if (!await askConfirm(t('toast.plConfirmConsolidate', { title: g.title, keep: plan.keepPlName, others: plan.updates.length, removed: plan.removed }))) return;
  try {
    let done = 0;
    for (const u of plan.updates) {
      const r = await api.saveUserPlaylist(u);
      if (r && r.success) done++;
    }
    if (!done) { showToast(t('toast.plConsolidateNone'), 'error'); return; }
    if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
    showToast(t('toast.plConsolidated', { title: g.title, keep: plan.keepPlName, removed: plan.removed }), 'success', 3000);
    const rest = findCrossPlaylistDupes((getState('userPlaylists') || []).filter(p => p && Array.isArray(p.songs)));
    if (rest.length) showDedupeModal(rest); else closeDedupeScanModal();
  } catch (e) {
    logger.error('[consolidateDup] 失败:', e);
    showToast(t('toast.plConsolidateFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 初始化 ────────────────────────────────────────────
// 收藏状态变化 → 收藏夹详情即时同步（行内 ♥ 取消收藏后该行立刻消失）。
// router 每次进歌单页都会调 initPlaylistView，故用一次性绑定防重复订阅。
plState._plFavSyncBound = false;
function _bindFavDetailSync() {
  if (plState._plFavSyncBound) return;
  plState._plFavSyncBound = true;
  subscribe('userPlaylists', (pls) => {
    if (plState._currentPlaylistId !== FAVORITES_PLAYLIST_ID) return;
    const modal = document.getElementById('playlistDetailModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const pl = (pls || []).find(p => p && p.id === FAVORITES_PLAYLIST_ID);
    if (pl) renderPlaylistDetailSongs(pl.songs || []);
  });
}

function initPlaylistView() {
  _bindFavDetailSync();
  loadUserPlaylists();
}

// 🎯 定位正在播放的歌：行选择器 data-pidx 存的是存储序下标，排序视图也能命中
//
// 为什么必须 async：data-pidx 落在第 150 行的那种歌，只有等分片全部追加完
// 才在 DOM 里。旧版同步查一次就下结论，于是大歌单里"点定位"恒弹
// toast.plRowNotVisible —— 那句诊断把用户往排序/过滤上带，而真实原因只是
// 渲染还没跑完。改成先 await 分片落地，再判断可见性。
async function locatePlayingInDetail() {
  if (!plState._currentPlaylistId) { showToast(t('toast.plOpenOneFirst'), 'info'); return; }
  const cur = typeof getState === 'function' ? getState('currentPlaying') : null;
  const idx = indexOfPlaying(plState._currentDetailSongs, cur);
  if (idx < 0) { showToast(t('toast.plNotInThisPlaylist'), 'info'); return; }
  await _plRenderIdle();
  let row = document.querySelector(`#playlistDetailSongs .song-row[data-pidx="${idx}"]`);
  if (!row && plState._plSongKw) { // 被关键词过滤藏了：清过滤重渲染后再找（这一轮也要等）
    plState._plSongKw = '';
    await renderPlaylistDetailSongs(plState._currentDetailSongs);
    row = document.querySelector(`#playlistDetailSongs .song-row[data-pidx="${idx}"]`);
  }
  if (!row) { showToast(t('toast.plRowNotVisible'), 'info'); return; }
  flashRow(row);
}

// ── window 桥接（HTML onclick / 跨模块调用）────────────
window.loadUserPlaylists = loadUserPlaylists;
window.openPlaylistDetail = openPlaylistDetail;
window.closePlaylistDetail = closePlaylistDetail;
window.playPlaylistSong = playPlaylistSong;
window.addPlaylistSongToQueue = addPlaylistSongToQueue;
window.downloadPlaylistSong = downloadPlaylistSong;
window.downloadAllPlaylist = downloadAllPlaylist;
window.exportCurrentPlaylistM3u = exportCurrentPlaylistM3u;
window.openPlaylistMergePicker = openPlaylistMergePicker;
window.closePlaylistMergePicker = closePlaylistMergePicker;
window.mergePlaylistIntoCurrent = mergePlaylistIntoCurrent;
window.dedupeCurrentPlaylist = dedupeCurrentPlaylist;
window.copyPlaylistListText = copyPlaylistListText;
window.locatePlayingInDetail = locatePlayingInDetail;
// 分片排空句柄也桥出去：local.js（localGridRenderIdle）与 converter.js
// （converterRenderIdle）都这么做，本文件是三家里唯一没有的。桥出去有两个用处 ——
// 别的视图/命令面板可以"等列表画完"再做按下标的操作，测试也不必再靠
// setTimeout 猜帧数（那正是首版测试假红/挂死的来源）。
window.playlistRenderIdle = _plRenderIdle;
window.playAllPlaylist = playAllPlaylist;
window.removeSongFromPlaylist = removeSongFromPlaylist;
window.openPlaylistEditor = openPlaylistEditor;
window.useFirstSongCover = useFirstSongCover;
window.onPlaylistSongFilterInput = onPlaylistSongFilterInput;
window.cyclePlaylistSort = cyclePlaylistSort;
window.cyclePlCardSort = cyclePlCardSort;
window.filterPlaylistCards = filterPlaylistCards;
window.openPlaylistAddSongs = openPlaylistAddSongs;
window.closePlaylistAddSongs = closePlaylistAddSongs;
window.doPlAddSearch = doPlAddSearch;
window.plAddPick = plAddPick;
window.closePlaylistEditor = closePlaylistEditor;
window.savePlaylist = savePlaylist;
window.editPlaylist = editPlaylist;
window.deletePlaylist = deletePlaylist;
// 回收站视图（弹窗行内按钮经 onclick 全局调用）
window.refreshPlTrash = refreshPlTrash;
window.openPlaylistTrash = openPlaylistTrash;
window.closePlaylistTrash = closePlaylistTrash;
window.restoreTrashedPlaylist = restoreTrashedPlaylist;
window.purgeTrashedPlaylist = purgeTrashedPlaylist;
window.quickAddToPlaylist = quickAddToPlaylist;
window.closePlaylistSelectModal = closePlaylistSelectModal;
window.addToSelectedPlaylist = addToSelectedPlaylist;
window.initPlaylistView = initPlaylistView;
window.togglePlBulkMode = togglePlBulkMode;
window.togglePlSongSel = togglePlSongSel;
window.plSelectAllVisible = plSelectAllVisible;
window.removeCheckedFromPlaylist = removeCheckedFromPlaylist;
window.plSelDownload = plSelDownload;
window.plSelPlay = plSelPlay;
window.cyclePlDlFilter = cyclePlDlFilter;
window.duplicateCurrentPlaylist = duplicateCurrentPlaylist;
window.scanCrossPlaylistDupes = scanCrossPlaylistDupes;
window.closeDedupeScanModal = closeDedupeScanModal;
window.copyDedupeScanReport = copyDedupeScanReport;
window.consolidateDup = consolidateDup;

// ── Delete 键作用域 ────────────────────────────────────
// run 走的就是「🗑 移除」按钮那个函数：确认弹窗、toast、选中态清理一律不另写一份。
// modalId 声明自己属于哪个浮层，shortcuts.js 用它排除「上层还压着别的弹窗」的情况。
registerDeleteScope({
  id: 'playlist-detail',
  order: 10,
  active: () => plState._plSelMode
    && !document.getElementById('playlistDetailModal')?.classList.contains('hidden'),
  count: () => plState._plSelKeys.size,
  run: () => removeCheckedFromPlaylist(),
  modalId: 'playlistDetailModal',
});
