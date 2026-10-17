/**
 * 歌单视图核心（阶段 4，从 views/playlist.js 抽出）：
 * 歌单卡片网格渲染 + 详情弹层的打开/关闭/渲染，以及详情工具条按钮的同步。
 *
 * 这是其余歌单域（拖拽 / 多选 / 回收站 / 快速添加 / 合并去重…）共同依赖的
 * 「下行」核心：本模块只依赖纯函数模块、plState、playlist/render.js 与渲染层
 * 全局（esc/escAttr/escQ/fmtDuration/getState/document），不回调 views/playlist.js
 * —— 各域经 playlist.js 导入本模块使用，依赖严格单向、无环。
 *
 * loadUserPlaylists 特意留在 playlist.js：它要回调本域的 refreshPlTrash，
 * 一并抽走会让 core 与回收站域互相依赖（且 loadView 对入口文件带 ?ck 缓存戳，
 * 经兼容层的环会落到第二个实例上）。
 */
import { t } from '../../i18n.js';
import { logger } from '../../logger.js';
import { HEART_ON, heartBtnHtml } from '../../favorites.js';
import { dlBadgeHtml, dlEnsureHistoryLoaded, dlStatusFor } from '../../dlStatus.js';
import { filterPlaylistSongs } from '../../playlistFilter.js';
import { filterByDlMode, plDlModeLabel } from '../../plDlFilter.js';
import { sortPlaylistPairs, PL_SORT_MODES, sortPlaylists, filterPlaylists } from '../../playlistSort.js';
import { plSongKey } from '../../plBulkRemove.js';
import { plState } from './state.js';
import { _plInvalidateRender, _plDeferRender } from './render.js';
// ── 渲染歌单列表 ──────────────────────────────────────
function renderPlaylistList(playlists) {
  const container = document.getElementById('userPlaylistGrid');
  if (!container) return;

  const shown = sortPlaylists(filterPlaylists(playlists, plState._plCardKw), plState._plCardSortMode);
  if (!shown.length) {
    const kw = plState._plCardKw.trim();
    container.innerHTML = kw
      ? `<div class="empty-hint" style="grid-column:1/-1;text-align:center;padding:40px 0;">
        <div style="font-size:40px;margin-bottom:12px">🔍</div>
        <div>${t('pl.card.emptyFiltered', { kw: esc(kw) })}</div>
        <div style="font-size:12px;margin-top:6px;color:var(--neon-dim);">${t('pl.card.searchHint')}</div>
      </div>`
      : `<div class="empty-hint" style="grid-column:1/-1;text-align:center;padding:40px 0;">
        <div style="font-size:40px;margin-bottom:12px">🎼</div>
        <div>${t('pl.card.empty')}</div>
        <div style="font-size:12px;margin-top:6px;color:var(--neon-dim);">${t('pl.card.emptyHint')}</div>
      </div>`;
    return;
  }

  container.innerHTML = shown.map(pl => `
    <div class="playlist-card" data-id="${escAttr(pl.id)}" tabindex="0" role="button" onclick="openPlaylistDetail('${escQ(pl.id)}')">
      <div class="playlist-card-cover">
        ${pl.cover ? `<img src="${escAttr(pl.cover)}" alt="${esc(pl.name)}" onerror="this.style.display='none'">` : `<div class="playlist-card-placeholder">${pl.system ? HEART_ON : '📋'}</div>`}
        <div class="playlist-card-overlay">
          <span class="playlist-card-count">${t('pl.count', { n: pl.songs?.length || 0 })}</span>
        </div>
      </div>
      <div class="playlist-card-info">
        <div class="playlist-card-name" title="${esc(pl.name)}">${esc(pl.name)}</div>
        ${pl.desc ? `<div class="playlist-card-desc">${esc(pl.desc)}</div>` : ''}
      </div>
      <div class="playlist-card-actions" onclick="event.stopPropagation()">
        ${pl.system
          ? ''
          : `<button class="action-btn" onclick="editPlaylist('${escQ(pl.id)}')" title="${t('pl.card.edit')}">✏️</button>
        <button class="action-btn" onclick="deletePlaylist('${escQ(pl.id)}')" title="${t('pl.card.delete')}">🗑️</button>`}
      </div>
    </div>
  `).join('');
}

// ── 打开歌单详情 ──────────────────────────────────────
async function openPlaylistDetail(playlistId) {
  try {
    plState._currentPlaylistId = playlistId;
    plState._plSongKw = '';
    plState._plSortMode = '';
    plState._plDlMode = 'all';
    _syncPlSortBtn();
    _syncPlDlBtn();
    _resetPlSel();
    const filterInput = document.getElementById('playlistSongFilter');
    if (filterInput) filterInput.value = '';
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    plState._currentDetailSongs = pl.songs || [];

    document.getElementById('playlistDetailTitle').textContent = pl.name;
    document.getElementById('playlistDetailDesc').textContent = pl.desc || t('pl.detail.noDesc');
    // 语义运维面板（候选方向 3）通过它拿当前歌单 id：模块变量 HTML onclick 拿不到
    window._plDetailId = pl.id;
    renderPlaylistDetailSongs(pl.songs || []);

    document.getElementById('playlistDetailModal').classList.remove('hidden');
  } catch (e) {
    logger.error('[openPlaylistDetail] error:', e);
  }
}

function closePlaylistDetail() {
  document.getElementById('playlistDetailModal').classList.add('hidden');
  plState._currentPlaylistId = null;
  plState._currentDetailSongs = [];
  window._plDetailId = null;
  _resetPlSel();
}

// ── 渲染歌单歌曲列表 ──────────────────────────────────
// 视图管线唯一入口：关键词过滤 → 下载状态过滤 → 排序（渲染/全选/任何读视图序的地方都走它，
// 三处管线各自为政迟早漂出「全选选到隐形歌」这类 bug）
function _plVisiblePairs(songs) {
  const queue = getState('queueSnapshot') || [];
  const kwFiltered = filterPlaylistSongs(songs || [], plState._plSongKw);
  const dlFiltered = filterByDlMode(kwFiltered, plState._plDlMode, (s) => dlStatusFor(s, queue));
  return sortPlaylistPairs(dlFiltered, plState._plSortMode);
}

// 大库分片渲染引擎（作废 / 登记 / 排空 / 是否在跑）见 ./playlist/render.js。

function renderPlaylistDetailSongs(songs) {
  const list = document.getElementById('playlistDetailSongs');
  if (!list) return Promise.resolve();
  plState._currentDetailSongs = songs || [];
  _syncPlSelBtns(); // 计数/显隐跟渲染走，早退分支也不留脏按钮
  dlEnsureHistoryLoaded(); // 跨会话"已下载"懒回填，完成后经监听器重渲染徽标

  if (!songs || songs.length === 0) {
    _plInvalidateRender(); // 作废进行中的分片追加
    list.innerHTML = `<div class="empty-hint" style="text-align:center;padding:30px 0;">${t('pl.detail.empty')}</div>`;
    return Promise.resolve();
  }

  const pairs = _plVisiblePairs(songs);
  const reorderable = songs.length > 1 && !plState._plSortMode; // 排序时展示序≠存储序，禁用拖把手防误持久化
  if (!pairs.length) {
    _plInvalidateRender();
    const kwPart = plState._plSongKw.trim() ? t('pl.detail.kwWrap', { kw: esc(plState._plSongKw.trim()) }) : '';
    const dlPart = plState._plDlMode !== 'all' ? (kwPart ? t('pl.detail.filterDlWithKw') : t('pl.detail.filterDl')) : '';
    list.innerHTML = `<div class="empty-hint" style="text-align:center;padding:30px 0;">${t('pl.detail.emptyFiltered', { kw: kwPart, dl: dlPart })}</div>`;
    return Promise.resolve();
  }
  const rows = pairs.map(({ song, i: idx }) => `
    <div class="song-row" data-pidx="${idx}" ondblclick="playPlaylistSong(${idx})">
      ${plState._plSelMode ? `<input type="checkbox" class="pl-sel-chk" ${plState._plSelKeys.has(plSongKey(song)) ? 'checked' : ''} onclick="event.stopPropagation();togglePlSongSel(${idx}, event)" title="${t('pl.sel.hint')}" style="width:15px;height:15px;flex-shrink:0;cursor:pointer;margin-right:6px;">` : ''}
      ${reorderable ? `<span class="pl-drag-handle" draggable="true" title="${t('pl.drag.hint')}">⠿</span>` : ''}
      <span class="song-num" style="color:var(--neon-dim);font-size:12px;width:22px;text-align:right;flex-shrink:0;">${idx + 1}</span>
      <div class="song-info">
        <div class="song-title" title="${esc(song.title)}">${esc(song.title) || t('pl.row.unknownTitle')}</div>
        <div class="song-meta">${esc(song.artist) || t('pl.row.unknownArtist')}${song.album ? ' · ' + esc(song.album) : ''}</div>
      </div>
      ${dlBadgeHtml(song, getState('queueSnapshot') || [])}
      <span class="song-duration">${song.duration ? fmtDuration(song.duration) : '--:--'}</span>
      <div class="song-actions">
        ${heartBtnHtml(song, 'action-btn')}
        <button class="action-btn" onclick="playPlaylistSong(${idx})" title="${t('pl.row.play')}">▶</button>
        <button class="action-btn" onclick="downloadPlaylistSong(${idx})" title="${t('pl.row.download')}">⬇</button>
        <button class="action-btn" onclick="addPlaylistSongToQueue(${idx})" title="${t('pl.row.enqueue')}">➕</button>
        <button class="action-btn" onclick="removeSongFromPlaylist('${escQ(String(song.id))}','${escQ(String(song.source || ''))}')" title="${t('pl.row.remove')}">✕</button>
      </div>
    </div>
  `);
  _plInvalidateRender();
  const d = _plDeferRender();
  const token = plState._plRenderToken;
  let cursor = 0;
  const appendSlice = () => {
    // 被作废（新一轮渲染，或外部 ++plState._plRenderToken）时先结算 await 方再走人：
    // 不结算就是永久 pending，比误报更难排查。
    if (token !== plState._plRenderToken) return d.settle();
    const end = Math.min(cursor + plState.PL_RENDER_CHUNK, rows.length);
    let html = '';
    for (let i = cursor; i < end; i++) html += rows[i];
    if (cursor === 0) list.innerHTML = html;
    else list.insertAdjacentHTML('beforeend', html);
    cursor = end;
    if (cursor < rows.length) requestAnimationFrame(appendSlice);
    else d.settle();
  };
  appendSlice();
  return d.promise;
}
function _syncPlSortBtn() {
  const btn = document.getElementById('playlistSortBtn');
  if (!btn) return;
  const m = PL_SORT_MODES.find((x) => x.key === plState._plSortMode);
  btn.textContent = m ? m.label : '↕ 默认序';
}
function _syncPlDlBtn() {
  const btn = document.getElementById('plDlFilterBtn');
  if (btn) btn.textContent = plDlModeLabel(plState._plDlMode);
}
function _resetPlSel() {
  plState._plSelMode = false;
  plState._plSelKeys = new Set();
  plState._plSelAnchor = null; // 换歌单/关弹层后锚点属于上一张单，留着会连出跨单的区间
  _syncPlSelBtns();
}

function _syncPlSelBtns() {
  const modeBtn = document.getElementById('plSelModeBtn');
  const allBtn = document.getElementById('plSelAllBtn');
  const rmBtn = document.getElementById('plSelRemoveBtn');
  const dlBtn = document.getElementById('plSelDlBtn');
  const playBtn = document.getElementById('plSelPlayBtn');
  if (modeBtn) modeBtn.textContent = plState._plSelMode ? '⬚ 退出多选' : '☑ 多选';
  if (allBtn) allBtn.classList.toggle('hidden', !plState._plSelMode);
  if (rmBtn) {
    rmBtn.classList.toggle('hidden', !plState._plSelMode);
    rmBtn.textContent = `🗑 移除 ${plState._plSelKeys.size}`;
  }
  if (dlBtn) {
    dlBtn.classList.toggle('hidden', !plState._plSelMode);
    dlBtn.textContent = `⬇ 下载 ${plState._plSelKeys.size}`;
  }
  if (playBtn) {
    playBtn.classList.toggle('hidden', !plState._plSelMode);
    playBtn.textContent = `▶ 播放 ${plState._plSelKeys.size}`;
  }
}

export {
  renderPlaylistList,
  openPlaylistDetail,
  closePlaylistDetail,
  _plVisiblePairs,
  renderPlaylistDetailSongs,
  _syncPlSortBtn,
  _syncPlDlBtn,
  _resetPlSel,
  _syncPlSelBtns,
};
