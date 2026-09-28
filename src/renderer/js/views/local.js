/**
 * MusicDL 本地音乐库视图 + ID3 编辑器 + 批量操作
 *
 * v2: 集成虚拟滚动 + 响应式状态
 */

import { errBrief } from '../errBrief.js';
import { logger } from '../logger.js';

// 批量重命名的 extname/dirname/join 用。渲染层不能 import node:path
//（插件不 polyfill，进 bundle 是裸 require，contextIsolation 下加载即崩），
// 用纯 JS 的 pathLite —— 见 pathLite.js 头注。
import * as path from '../pathLite.js';

import { VirtualScroller } from '../virtualList.js';

// 转码共用弹窗 + 批量 runner（下载页/转换页/本地库三处共用）
import { openConvertModal, runConvertBatch } from '../converter-core.js';
import { showContextMenu } from '../contextMenu.js';
import { skeletonHtml, SKEL_ROWS } from '../skeleton.js';
import {
  collectProbeTargets, runSequentialScan, summarizeProbe,
  probeReportLine, showProbeReportModal,
} from '../batchProbe.js';
import { nextLocalSortMode, localSortLabel, sortLocalSongs } from '../localSort.js';
import { getPlayStats } from '../player/stats.js';
import { buildExportSongs } from '../localExport.js';
import { buildLocalRowMenuItems } from '../localRowMenu.js';
import { isLocalFavorite, toggleLocalFavorite, localFavSong, heartBtnHtml } from '../favorites.js';
import { favOnlyFilter } from '../localFavFilter.js';
import { listFormats, nextFmtMode, fmtModeLabel, filterByFmt } from '../localFormatFilter.js';
import { qualityBadge } from '../localQualityBadge.js';
import { qualModeLabel, nextQualMode, filterByQuality } from '../localQualityFilter.js';
import { metaModeLabel, nextMetaMode, filterByMeta } from '../localMetaFilter.js';
import { applyFolderToSongs } from '../folderGroups.js';
import { toTrackLines } from '../songListText.js';
import { copyText } from '../songShare.js';
import { indexOfPlaying, flashRow } from '../locatePlaying.js';
import { groupSongsForAlbumWall, normalizeGroupKey, UNKNOWN_ALBUM } from '../artistGroups.js';
import { t } from '../i18n.js';

// 统计/查重已拆到 local-stats.js（回调在文件末尾注入）
import {
  showLibraryStats, detectDuplicateSongs, toggleDupSelect, selectAllDups,
  deselectAllDups, deleteSelectedDups, setLibraryChangeHandler,
  detectContentDuplicates,
} from './local-stats.js';

// ── 状态 ─────────────────────────────────────────────
let _localSelectionMode = false;
const _selectedLocal = new Set(); // 存 filePath
let _localVirtualScroller = null; // 虚拟滚动实例

// ── 批量补封面 ────────────────────────────────────────
let _batchCancelled = false;

async function batchFetchCovers() {
  const localSongs = getState('localSongs');
  const needCover = localSongs.filter(s => !s.cover && s.title && s.artist);
  if (!needCover.length) {
    showToast('✅ 所有歌曲都已有封面，无需补全', 'info');
    return;
  }
  _batchCancelled = false;
  const total = needCover.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('localBatchProgressWrap');
  const progressBar = document.getElementById('localBatchProgressBar');
  const progressLabel = document.getElementById('localBatchProgressLabel');
  if (progressWrap) progressWrap.style.display = 'flex';
  if (progressLabel) progressLabel.textContent = `正在补全封面 (0/${total})`;

  for (const s of needCover) {
    if (_batchCancelled) break;
    try {
      const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
      if (result && result.coverBase64) {
        const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
        if (wr && wr.success) {
          s.cover = result.coverBase64;
          const localFiltered = getState('localFiltered');
          const fi = localFiltered.findIndex(x => x.filePath === s.filePath);
          if (fi >= 0) localFiltered[fi].cover = result.coverBase64;
          ok++;
        } else { fail++; }
      } else { fail++; }
    } catch (e) { fail++; }
    done++;
    const pct = Math.round((done / total) * 100);
    progressBar.style.width = pct + '%';
    progressLabel.textContent = `正在补全封面 (${done}/${total})`;
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`批量补封面完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

function cancelBatchFetch() { _batchCancelled = true; }

// ── 扫描 ──────────────────────────────────────────────
// 重入锁：按钮连点 / fs.watch 推送并发时只允许一次扫描在途
//（扫描体长且多早期 return，包一层比逐出口复位可靠）
let _scanRunning = false;
async function scanLocalDir() {
  if (_scanRunning) return;
  _scanRunning = true;
  try {
    await _doScanLocalDir();
  } finally {
    _scanRunning = false;
  }
}

/**
 * 主进程扫描后顺手做了"外部改名对账"，这里做两件必做的事：
 *   1. 把接回了几个说出口 —— 徽标/歌单悄悄变了而不告知，用户下次看到「✔ 已下载」会以为是巧合；
 *   2. 重拉一次歌单：回写改的是盘上的 prefs，渲染层还攥着旧路径那份的话，
 * 下一次收藏/建歌单就会把刚接回来的路径又覆盖回去（0d07b92 踩过同一个坑）。
 * @returns {Promise<string>} 直接拼进扫描提示的话尾；没接回任何东西时是空串（也不重拉）
 */
async function _relinkNote(result) {
  const n = (result && result.relinked && result.relinked.fixed) || 0;
  if (!n) return '';
  if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
  return `  🔁 已自动接回 ${n} 个被外部改名的下载文件（徽标/歌单已同步）`;
}

async function _doScanLocalDir() {
  let localDirPath = getState('localDirPath');
  if (!localDirPath) {
    const saved = await api.getPref('localDirPath');
    if (saved) localDirPath = saved;
  }
  if (!localDirPath) {
    const dir = await api.selectDir();
    if (!dir) return;
    localDirPath = dir;
    setState('localDirPath', dir);
    await api.setPref('localDirPath', dir);
  }

  const list = document.getElementById('localList');
  list.innerHTML = skeletonHtml('local', SKEL_ROWS, '扫描中...');

  try {
    const result = await api.scanLocalLibrary(localDirPath);
    if (result.error === '目录不存在') {
      setState('localDirPath', null);
      await api.setPref('localDirPath', null);
      list.innerHTML = `<div class="empty-state" style="flex:1">
        <div class="empty-icon">📂</div>
        <div class="empty-text">目录不存在</div>
        <div class="empty-hint">请重新选择音乐文件夹</div>
      </div>`;
      document.getElementById('localInfo').textContent = '目录不存在，请重新扫描';
      const dir = await api.selectDir();
      if (!dir) return;
      localDirPath = dir;
      setState('localDirPath', dir);
      await api.setPref('localDirPath', dir);
      const retry = await api.scanLocalLibrary(localDirPath);
      if (retry.error) { showToast('扫描失败: ' + retry.error, 'error'); return; }
      setState('localSongs', retry.songs || []);
      document.getElementById('localInfo').textContent = `共 ${(retry.songs || []).length} 首 · ${localDirPath}`;
      filterLocalSongs(); // 重扫后必须重套当前筛选（与 refreshLocalLibrary 同一约定）
      const note = await _relinkNote(retry);
      showToast(`扫描完成，发现 ${(retry.songs || []).length} 首歌曲${note}`, 'success');
      return;
    }
    const localSongs = result.songs || [];
    setState('localSongs', localSongs);
    document.getElementById('localInfo').textContent = `共 ${localSongs.length} 首 · ${localDirPath}`;
    filterLocalSongs(); // 重扫后必须重套当前筛选：直接 setState('localFiltered') 会丢掉收藏/格式/音质/完整度/关键词全部轴
    const note = await _relinkNote(result);
    showToast(`扫描完成，发现 ${localSongs.length} 首歌曲${note}`, 'success');
  } catch (e) {
    showToast('扫描失败: ' + errBrief(e), 'error');
  }
}

// ── 过滤 ──────────────────────────────────────────────
let _localSortMode = 'default'; // 本地曲库排序（会话级，扫描/过滤后都保持生效）
let _localFavOnly = false;      // 仅看收藏开关（会话级）
let _localFmtMode = 'all';      // 格式过滤循环态（会话级）
let _localQualMode = 'all';    // 音质视图过滤循环态（会话级）
let _localMetaMode = 'all';    // 元数据完整度过滤循环态（会话级）

/** 统一排序入口：plays-desc 需要注入 stats 的播放计数表 */
function _sortL(songs) {
  return sortLocalSongs(songs, _localSortMode,
    _localSortMode === 'plays-desc' ? (getPlayStats().playCount || null) : null);
}

function filterLocalSongs() {
  const kw = document.getElementById('localFilter').value.trim().toLowerCase();
  let songs = getState('localSongs') || [];
  songs = applyFolderToSongs(songs); // 文件夹过滤在链首：fav→fmt→kw 都在其结果上再筛
  if (_localFavOnly) songs = favOnlyFilter(songs, getState('favoriteKeys'));
  if (_localFmtMode !== 'all') songs = filterByFmt(songs, _localFmtMode);
  if (_localQualMode !== 'all') songs = filterByQuality(songs, (fp) => _probeCache.get(fp), _localQualMode);
  if (_localMetaMode !== 'all') songs = filterByMeta(songs, _localMetaMode);
  if (_localAlbumFilter) {
    const target = normalizeGroupKey(_localAlbumFilter, UNKNOWN_ALBUM);
    songs = songs.filter(s => normalizeGroupKey(s && s.album, UNKNOWN_ALBUM) === target);
  }
  if (kw) {
    songs = songs.filter(s =>
      (s.title || '').toLowerCase().includes(kw) ||
      (s.artist || '').toLowerCase().includes(kw) ||
      (s.album || '').toLowerCase().includes(kw)
    );
  }
  setState('localFiltered', _sortL([...songs]));
  if (_localViewMode === 'album') renderLocalAlbumWall();
  else if (_localViewMode === 'grid') renderLocalGrid();
  else renderLocalSongs();
}

/** ♥ 仅看收藏开关：只留进了收藏歌单的本地曲，按钮文案同步 */
function toggleLocalFavOnly() {
  _localFavOnly = !_localFavOnly;
  const btn = document.getElementById('localFavBtn');
  if (btn) {
    btn.textContent = _localFavOnly ? '♥ 仅收藏' : '♥ 全部';
    btn.classList.toggle('active', _localFavOnly);
  }
  filterLocalSongs();
}

// 收藏钩子（favorites.js 在本地歌收藏切换成功后回调）：仅收藏视图即时重过滤
window.onLocalFavToggle = () => { if (_localFavOnly) filterLocalSongs(); };

/**
 * 音质过滤循环：五态走一格，按钮文案同步。
 * 必须走 filterLocalSongs()（而非 renderLocalSongs()）——后者只重画
 * 已算好的 localFiltered，换态不会重新过筛，等于按钮点了没用（修复）。
 */
function cycleLocalQual() {
  _localQualMode = nextQualMode(_localQualMode);
  const btn = document.getElementById('localQualBtn');
  if (btn) btn.textContent = qualModeLabel(_localQualMode);
  filterLocalSongs();
}

/** 元数据完整度过滤循环：五态走一格，按钮文案同步 */
function cycleLocalMeta() {
  _localMetaMode = nextMetaMode(_localMetaMode);
  const btn = document.getElementById('localMetaBtn');
  if (btn) btn.textContent = metaModeLabel(_localMetaMode);
  filterLocalSongs();
}

function cycleLocalFmt() {
  _localFmtMode = nextFmtMode(_localFmtMode, listFormats(getState('localSongs') || []));
  const btn = document.getElementById('localFmtBtn');
  if (btn) btn.textContent = fmtModeLabel(_localFmtMode);
  filterLocalSongs();
}

// 📋 复制曲单：当前过滤视图一行一首纯文本（歌名 - 歌手）进剪贴板，零新通道
async function copyLocalListText() {
  const lines = toTrackLines(getState('localFiltered') || []);
  if (!lines.length) { showToast('当前视图没有可复制的歌曲', 'info'); return; }
  const ok = await copyText(lines.join('\n'));
  showToast(ok ? `📋 已复制 ${lines.length} 首歌名清单` : '复制失败：剪贴板被占用或无权限', ok ? 'success' : 'error', 2500);
}

/** 排序循环：默认 → 标题 → 歌手 → 时长↓ → 大小↓ → 播放🔥 → 最近添加↓ → 默认 */
function cycleLocalSort() {
  _localSortMode = nextLocalSortMode(_localSortMode);
  const btn = document.getElementById('localSortBtn');
  if (btn) btn.textContent = localSortLabel(_localSortMode);
  filterLocalSongs();
}

// ── 曲库目录监听自动刷新（主进程 fs.watch → local-library-changed 推送）──
let _autoRefreshing = false;
async function refreshLocalLibrary() {
  const dir = getState('localDirPath');
  if (!dir || _autoRefreshing) return; // 未选过目录不打扰
  const overlay = document.getElementById('editOverlay');
  if ((overlay && !overlay.classList.contains('hidden')) || _localSelectionMode) return; // 编辑/选择中不打断
  _autoRefreshing = true;
  try {
    const result = await api.scanLocalLibrary(dir);
    if (result && !result.error) {
      const prevCount = (getState('localSongs') || []).length;
      const songs = result.songs || [];
      setState('localSongs', songs);
      document.getElementById('localInfo').textContent = `共 ${songs.length} 首 · ${dir}`;
      filterLocalSongs(); // 重新套用当前筛选并重渲染（列表/网格都兼顾）
      const note = await _relinkNote(result);
      if (songs.length !== prevCount || note) showToast(`📂 本地曲库已自动刷新${note}`, 'info', note ? 4500 : 1800);
    }
  } catch (e) {
    logger.warn('[refreshLocalLibrary] 自动刷新失败:', e && e.message);
  } finally {
    _autoRefreshing = false;
  }
}

// ── 选择模式 ─────────────────────────────────────────
function enterLocalSelectionMode() {
  _localSelectionMode = true;
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function exitLocalSelectionMode() {
  _localSelectionMode = false;
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function toggleLocalSelect(filePathOrEncoded, idx) {
  // 兼容处理：新版传入 base64 编码路径，旧版传入明文路径
  const filePath = filePathOrEncoded.length > 200
    ? decodeFilePath(filePathOrEncoded) // 新版：base64 编码的路径
    : filePathOrEncoded; // 旧版：明文路径（向后兼容）
  if (_selectedLocal.has(filePath)) {
    _selectedLocal.delete(filePath);
  } else {
    _selectedLocal.add(filePath);
  }
  // 更新 checkbox 状态
  const cb = document.getElementById('localcb_' + idx);
  if (cb) cb.checked = _selectedLocal.has(filePath);
  updateLocalSelectionBar();
  renderLocalSongs(); // 重新高亮
}

function selectAllLocal() {
  const localFiltered = getState('localFiltered');
  localFiltered.forEach(s => _selectedLocal.add(s.filePath));
  renderLocalSongs();
  updateLocalSelectionBar();
}

function deselectAllLocal() {
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function updateLocalSelectionBar() {
  const bar = document.getElementById('localSelectionBar');
  const count = document.getElementById('localSelectionCount');
  if (!bar) return;
  const n = _selectedLocal.size;
  if (!_localSelectionMode) {
    bar.style.display = 'none';
    return;
  }
  count.textContent = n;
  bar.style.display = 'flex';
}

// 导出 m3u：选择模式下勾了歌就导勾选，否则导当前过滤/排序视图（所见即所得）
async function exportLocalM3u() {
  const localFiltered = getState('localFiltered') || [];
  const songs = buildExportSongs(localFiltered, _localSelectionMode ? _selectedLocal : null);
  if (!songs.length) {
    showToast('没有可导出的本地歌曲（需已有文件路径）', 'warn');
    return;
  }
  try {
    const r = await api.exportPlaylist({ songs, format: 'm3u', name: 'MusicDL-本地库' });
    if (r && r.canceled) return;
    if (!r || r.error) { showToast('导出失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    const scope = _localSelectionMode && _selectedLocal.size ? '已选' : '当前';
    showToast(`✅ 已导出${scope}视图 ${songs.length} 首`, 'success');
  } catch (e) {
    logger.warn('[local] 导出 m3u 失败:', e.message);
    showToast('导出失败：' + errBrief(e), 'error');
  }
}

// ── 渲染列表（虚拟滚动版）─────────────────────────────
function _renderLocalRow(s, i) {
  const selected = _selectedLocal.has(s.filePath);
  const rowClass = selected && _localSelectionMode ? 'local-row selected' : 'local-row';
  const encodedPath = btoa(encodeURIComponent(s.filePath));
  return `
  <div class="${rowClass}" data-idx="${i}" tabindex="0" role="button" onclick="playLocalSong(${i})" oncontextmenu="event.preventDefault();event.stopPropagation();showLocalRowMenu(event,${i})" style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer;">
    ${_localSelectionMode ? `
    <div class="local-row-cb" onclick="event.stopPropagation();toggleLocalSelect('${encodedPath}',${i})">
      <input type="checkbox" id="localcb_${i}" ${selected ? 'checked' : ''} onchange="event.stopPropagation();toggleLocalSelect('${encodedPath}',${i})">
    </div>` : ''}
    ${s.cover
      ? `<img class="local-row-cover" src="${escAttr(s.cover)}" alt="" style="width:40px;height:40px;border-radius:4px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ''}
    <div class="local-row-cover-ph" style="width:40px;height:40px;border-radius:4px;display:flex;align-items:center;justify-content:center;background:var(--bg-tertiary);font-size:18px;${s.cover ? 'display:none' : ''}">🎵</div>
    <div class="local-row-info" style="flex:1;min-width:0;">
      <div class="local-row-title" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.title)}</div>
      <div class="local-row-artist" style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.artist || '未知艺术家')}${s.album ? ' · ' + esc(s.album) : ''}</div>
    </div>
    ${(() => { const q = qualityBadge(s, _probeCache.get(s.filePath)); return q ? `<span class="local-row-quality" title="${escAttr(q.title)}" style="font-size:11px;color:${q.color};white-space:nowrap;">${esc(q.text)}</span>` : ''; })()}
    <span class="local-row-duration" style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${fmtDuration(s.durationMs)}</span>
    <span class="local-row-size" style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${formatBytes(s.fileSize)}</span>
    <div class="local-row-actions" style="display:flex;gap:4px;">
      ${(() => { const favs = localFavSong(s); return favs ? heartBtnHtml(favs, 'action-btn') : ''; })()}
      <button class="action-btn" title="播放" onclick="event.stopPropagation();playLocalSong(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">▶</button>
      <button class="action-btn" title="编辑" onclick="event.stopPropagation();openEdit(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">✏️</button>
      <button class="action-btn" title="拉取在线封面" onclick="event.stopPropagation();refetchCover(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">🖼️</button>
      <button class="action-btn download-btn" title="打开文件夹" data-action="open-folder" data-path="${encodedPath}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">📂</button>
    </div>
  </div>`;
}

function renderLocalSongs() {
  const list = document.getElementById('localList');
  const localFiltered = getState('localFiltered');

  if (!localFiltered || !localFiltered.length) {
    list.innerHTML = `<div class="empty-state" style="flex:1">
      <div class="empty-icon">📂</div>
      <div class="empty-text">暂无本地歌曲</div>
      <div class="empty-hint">点击"扫描目录"选择音乐文件夹</div>
    </div>`;
    if (_localVirtualScroller) { _localVirtualScroller.destroy(); _localVirtualScroller = null; }
    return;
  }

  // 少于 50 首用普通渲染，超过用虚拟滚动
  if (localFiltered.length < 50) {
    if (_localVirtualScroller) { _localVirtualScroller.destroy(); _localVirtualScroller = null; }
    list.innerHTML = localFiltered.map((s, i) => _renderLocalRow(s, i)).join('');
    return;
  }

  // 虚拟滚动
  if (!_localVirtualScroller) {
    list.innerHTML = '';
    _localVirtualScroller = new VirtualScroller(list, {
      itemHeight: 52,
      buffer: 10,
      renderItem: (item, idx) => _renderLocalRow(item, idx),
      onItemClick: (item, idx, e) => {
        // 点击行播放（按钮的 onclick 已单独处理）
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        playLocalSong(idx);
      },
    });
  }
  _localVirtualScroller.setData(localFiltered);
}

// ── 播放 ──────────────────────────────────────────────
async function playLocalSong(idx) {
  try {
    const localFiltered = getState('localFiltered');
    const s = localFiltered[idx];
    if (!s) return;
    setState('playQueue', localFiltered.slice());
    setState('playIdx', idx);
    setState('_currentLocalFilePath', s.filePath);
    // audio error / 25s 加载超时守卫依赖 currentPlaying 真值，缺失会静默卡死
    setState('currentPlaying', s);
    await loadAndPlay(s, 'file://' + s.filePath);
    renderLocalSongs();
  } catch (e) {
    logger.error(`[playLocalSong] error:`, e);
  }
}

// ── 单曲编辑 ─────────────────────────────────────────
// ── 编辑弹窗 document 级 click 监听管理 ──────────────
let _editDocClickHandler = null;

function _addEditDocClickListener() {
  _removeEditDocClickListener();
  _editDocClickHandler = (e) => {
    const overlay = document.getElementById('editOverlay');
    if (overlay && e.target === overlay) closeEdit();
  };
  document.addEventListener('click', _editDocClickHandler);
}

function _removeEditDocClickListener() {
  if (_editDocClickHandler) {
    document.removeEventListener('click', _editDocClickHandler);
    _editDocClickHandler = null;
  }
}

function openEdit(idx) {
  const localFiltered = getState('localFiltered');
  const s = localFiltered[idx];
  if (!s) return;
  setState('editingSong', s);
  setState('editingCoverBase64', s.cover || null);

  document.getElementById('editTitle').value = s.title || '';
  document.getElementById('editArtist').value = s.artist || '';
  document.getElementById('editAlbum').value = s.album || '';
  document.getElementById('editYear').value = s.year || '';
  document.getElementById('editGenre').value = s.genre || '';

  const preview = document.getElementById('editCoverPreview');
  if (s.cover) {
    // s.cover 应为 data:image 前缀的 base64 形态（来自内嵌标签或在线封面）。
    // 白名单校验后再插值：非 data:image 前缀的一律当无封面处理，
    // 防止把外部输入直接塞进 innerHTML 的 src 属性。
    const isDataImage = typeof s.cover === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(s.cover);
    preview.innerHTML = isDataImage
      ? `<img src="${s.cover}" style="width:100%;height:100%;object-fit:cover">`
      : '<span style="font-size:28px">🎵</span>';
  } else {
    preview.innerHTML = '<span style="font-size:28px">🎵</span>';
  }

  document.getElementById('editBatchHint').style.display = 'none';
  document.getElementById('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEditOnBg(e) {
  if (e.target === document.getElementById('editOverlay')) closeEdit();
}

function onEditCoverSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    setState('editingCoverBase64', e.target.result);
    document.getElementById('editCoverPreview').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
  };
  reader.readAsDataURL(file);
}

function clearEditCover() {
  setState('editingCoverBase64', null);
  document.getElementById('editCoverPreview').innerHTML = '<span style="font-size:28px">🎵</span>';
}

async function saveEdit() {
  const editingSong = getState('editingSong');
  if (!editingSong) return;

  const tags = {
    title: document.getElementById('editTitle').value.trim(),
    artist: document.getElementById('editArtist').value.trim(),
    album: document.getElementById('editAlbum').value.trim(),
    year: document.getElementById('editYear').value.trim(),
    genre: document.getElementById('editGenre').value.trim(),
  };

  try {
    const result = await api.updateId3Tags(editingSong.filePath, tags);
    if (result.success) {
      const editingCoverBase64 = getState('editingCoverBase64');
      if (editingCoverBase64 !== editingSong.cover) {
        if (editingCoverBase64) {
          await api.updateId3Cover(editingSong.filePath, editingCoverBase64);
        }
      }
      Object.assign(editingSong, tags);
      editingSong.cover = editingCoverBase64;
      renderLocalSongs();
      closeEdit();
      showToast('歌曲信息已保存', 'success');
    } else {
      showToast('保存失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('保存出错: ' + errBrief(e), 'error');
  }
}

// ── 批量编辑 ─────────────────────────────────────────
function openBatchEdit() {
  const count = _selectedLocal.size;
  if (!count) { showToast('请先选择要编辑的歌曲', 'warn'); return; }

  document.getElementById('editTitle').value = '';
  document.getElementById('editArtist').value = '';
  document.getElementById('editAlbum').value = '';
  document.getElementById('editYear').value = '';
  document.getElementById('editGenre').value = '';
  document.getElementById('editCoverPreview').innerHTML = '<span style="font-size:28px">🎵</span>';
  setState('editingCoverBase64', null);
  setState('editingSong', null);

  document.getElementById('editTitleLabel').textContent = `✏️ 批量编辑 ${count} 首`;
  document.getElementById('editBatchHint').style.display = 'block';
  document.getElementById('editBatchHint').textContent = `已选 ${count} 首歌曲。只填写的字段会批量写入，留空则跳过该字段。`;
  document.getElementById('editSaveBtn').textContent = '批量保存';
  document.getElementById('editSaveBtn').setAttribute('onclick', 'saveBatchEdit()');
  document.getElementById('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEdit() {
  _removeEditDocClickListener();
  document.getElementById('editOverlay').classList.add('hidden');
  setState('editingSong', null);
  setState('editingCoverBase64', null);
  document.getElementById('editTitleLabel').textContent = '✏️ 编辑歌曲信息';
  document.getElementById('editBatchHint').style.display = 'none';
  document.getElementById('editSaveBtn').textContent = '保存更改';
  document.getElementById('editSaveBtn').setAttribute('onclick', 'saveEdit()');
}

async function saveBatchEdit() {
  const count = _selectedLocal.size;
  if (!count) return;

  const tags = {
    title: document.getElementById('editTitle').value.trim(),
    artist: document.getElementById('editArtist').value.trim(),
    album: document.getElementById('editAlbum').value.trim(),
    year: document.getElementById('editYear').value.trim(),
    genre: document.getElementById('editGenre').value.trim(),
  };
  // 过滤掉空字段
  const filledTags = Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== ''));
  if (!Object.keys(filledTags).length) {
    showToast('请至少填写一个字段', 'warn');
    return;
  }

  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');
  let ok = 0, fail = 0;
  const editingCoverBase64 = getState('editingCoverBase64');

  for (const fp of _selectedLocal) {
    try {
      const result = await api.updateId3Tags(fp, filledTags);
      if (result && result.success) {
        if (editingCoverBase64) {
          await api.updateId3Cover(fp, editingCoverBase64);
        }
        // 回填状态
        const s = localSongs.find(x => x.filePath === fp);
        if (s) { Object.assign(s, filledTags); if (editingCoverBase64) s.cover = editingCoverBase64; }
        const fi = localFiltered.findIndex(x => x.filePath === fp);
        if (fi >= 0) { Object.assign(localFiltered[fi], filledTags); if (editingCoverBase64) localFiltered[fi].cover = editingCoverBase64; }
        ok++;
      } else { fail++; }
    } catch (e) { fail++; }
  }

  renderLocalSongs();
  closeEdit();
  exitLocalSelectionMode();
  showToast(`批量编辑完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 拖拽上传封面（编辑器） ───────────────────────────
// H7/H8 修复：存储 handler 引用，支持清理
const _dragCoverHandlers = {
  dragover: null,
  dragleave: null,
  drop: null,
};

function setupDragCover() {
  const preview = document.getElementById('editCoverPreview');
  if (!preview) return;
  // 先清理旧监听器，避免重复绑定
  teardownDragCover();
  _dragCoverHandlers.dragover = (e) => { e.preventDefault(); preview.style.borderColor = 'var(--neon-cyan-dim)'; };
  _dragCoverHandlers.dragleave = () => { preview.style.borderColor = 'var(--neon-blue-dim)'; };
  _dragCoverHandlers.drop = (e) => {
    e.preventDefault();
    preview.style.borderColor = 'var(--neon-blue-dim)';
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setState('editingCoverBase64', ev.target.result);
      preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
  };
  preview.addEventListener('dragover', _dragCoverHandlers.dragover);
  preview.addEventListener('dragleave', _dragCoverHandlers.dragleave);
  preview.addEventListener('drop', _dragCoverHandlers.drop);
}

function teardownDragCover() {
  const preview = document.getElementById('editCoverPreview');
  if (!preview) return;
  if (_dragCoverHandlers.dragover) preview.removeEventListener('dragover', _dragCoverHandlers.dragover);
  if (_dragCoverHandlers.dragleave) preview.removeEventListener('dragleave', _dragCoverHandlers.dragleave);
  if (_dragCoverHandlers.drop) preview.removeEventListener('drop', _dragCoverHandlers.drop);
  _dragCoverHandlers.dragover = null;
  _dragCoverHandlers.dragleave = null;
  _dragCoverHandlers.drop = null;
}

// 初始化拖拽监听
setupDragCover();

// ── 打开文件夹事件代理（修复 XSS，使用 data 属性传递路径）─────────
(function setupOpenFolderDelegate() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="open-folder"]');
    if (!btn) return;
    e.stopPropagation();
    const encoded = btn.dataset.path;
    if (!encoded) return;
    try {
      const filePath = decodeURIComponent(atob(encoded));
      openFolderSafe(filePath);
    } catch (err) {
      logger.warn('[openFolder] 解码路径失败:', err.message);
    }
  });
})();

// ── 辅助：解码 base64 编码的文件路径 ───────────────────────────
function decodeFilePath(encoded) {
  try {
    return decodeURIComponent(atob(encoded));
  } catch (e) {
    return encoded; // 降级：如果是旧版明文路径，直接返回
  }
}

// ── 行右键菜单 + 伪无损检测 ────────────────────────────────────
// 下载站常拿 MP3 改扩成 .flac 挂「无损」；扩展名和标称都不可信，
// 唯一可信的是容器里实际音频流 —— ffprobe 实测编码/码率给出判定。
const _probeCache = new Map(); // filePath → 成功的实测结果，避免重复起进程

function _toastProbeResult(r, s) {
  if (!r || !r.ok) { showToast('检测失败：' + ((r && r.error) || '未知错误'), 'warn', 3500); return; }
  const codec = r.codec ? r.codec.toUpperCase() : '未知';
  const kb = r.bitrateKbps ? r.bitrateKbps + 'kbps' : '码率未知';
  const sr = r.sampleRate ? ' · ' + (r.sampleRate / 1000) + 'kHz' : '';
  if (r.verdict === 'lossless') showToast(`✅ 《${s.title || ''}》真无损：${codec} · ${kb}${sr}`, 'success', 4500);
  else if (r.verdict === 'suspicious') showToast(`⚠️ 《${s.title || ''}》存疑：无损编码 ${codec} 但码率仅 ${kb}，疑低码率转制`, 'warn', 5500);
  else showToast(`❌ 《${s.title || ''}》伪无损！实际是有损编码 ${codec} · ${kb}${sr}`, 'error', 6000);
}

async function probeLocalQuality(s) {
  if (_probeCache.has(s.filePath)) { _toastProbeResult(_probeCache.get(s.filePath), s); return; }
  showToast(`🔬 正在实测《${s.title || ''}》…`, 'info', 1500);
  let r;
  try { r = await api.probeAudio(s.filePath); }
  catch (e) { r = { error: e.message }; }
  if (r && r.ok) { _probeCache.set(s.filePath, r); renderLocalSongs(); }
  _toastProbeResult(r, s);
}

function showLocalRowMenu(e, idx) {
  const s = (getState('localFiltered') || [])[idx];
  if (!s) return;
  showContextMenu(e.clientX, e.clientY, buildLocalRowMenuItems(s, {
    play: () => playLocalSong(idx),
    edit: () => openEdit(idx),
    fav: (song) => toggleLocalFavorite(song),
    favOn: isLocalFavorite(s),
    probe: () => probeLocalQuality(s),
    reveal: () => revealLocalFile(s),
    copyPath: (fp) => copyLocalPath(fp),
    probeDone: _probeCache.has(s.filePath),
  }));
}

// 📂 定位文件：复用 open-folder 通道（主进程对文件路径走 showItemInFolder 高亮）
// 失败反馈统一由 openFolderSafe 出（它区分「被沙箱拒」与「通道异常」两种原因），
// 这里不再自己判 r.ok —— 那是改接线之前的写法，留着会双弹一次 toast。
async function revealLocalFile(s) {
  await openFolderSafe(s.filePath);
}

// 📋 复制文件本地路径（排障/搬运常用）
async function copyLocalPath(fp) {
  const ok = await copyText(fp);
  showToast(ok ? '📋 文件路径已复制' : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
}

// 🎯 定位正在播放的歌：虚拟滚动先跳过去，重绘前后各闪一次（后一次兜底）
function locatePlayingLocal() {
  const cur = typeof getState === 'function' ? getState('currentPlaying') : null;
  const list = (typeof getState === 'function' && getState('localFiltered')) || [];
  const idx = indexOfPlaying(list, cur);
  if (idx < 0) { showToast('正在播放的歌不在当前曲库视图（未在播放或已被过滤）', 'info', 2500); return; }
  if (_localVirtualScroller) _localVirtualScroller.scrollToIndex(idx);
  const flash = () => {
    const row = document.querySelector(`.local-row[data-idx="${idx}"]`);
    if (row) flashRow(row);
  };
  flash();
  setTimeout(flash, 200);
}

// ── 全库音质扫描 ─────────────────────────────────────
let _probeScanCancelled = false;
function cancelProbeScan() { _probeScanCancelled = true; }

async function batchProbeQuality() {
  const localSongs = (typeof getState === 'function' && getState('localSongs')) || [];
  const { targets, cached } = collectProbeTargets(localSongs, _probeCache);
  if (!targets.length) {
    if (!cached) { showToast('本地库还没有歌曲可扫描，请先「扫描目录」', 'warn', 3500); return; }
    showToast(probeReportLine(summarizeProbe(Array.from(_probeCache.values())), false) + '（全部命中缓存）', 'info', 5500);
    return;
  }
  _probeScanCancelled = false;
  const wrap = document.getElementById('probeProgressWrap');
  const bar = document.getElementById('probeProgressBar');
  const label = document.getElementById('probeProgressLabel');
  if (wrap) wrap.style.display = 'flex';
  if (bar) bar.style.width = '0%';
  const flagged = []; // 本轮发现的存疑/有损曲目
  try {
    const { cancelled } = await runSequentialScan({
      items: targets,
      worker: (s) => api.probeAudio(s.filePath),
      isCancelled: () => _probeScanCancelled,
      onProgress: (done, total, r, s) => {
        if (r && r.ok) {
          _probeCache.set(s.filePath, r);
          if (r.verdict === 'suspicious' || r.verdict === 'lossy') flagged.push({ s, r });
        }
        if (bar) bar.style.width = Math.round((done / total) * 100) + '%';
        if (label) label.textContent = `正在扫描音质 (${done}/${total})` + (flagged.length ? ` · 已发现 ${flagged.length} 首非真无损` : '');
      },
    });
    // 汇总口径 = 全库缓存（含本轮新结果 + 此前逐曲实测）
    const full = summarizeProbe(Array.from(_probeCache.values()));
    const bad = full.suspicious + full.lossy;
    showToast(probeReportLine(full, cancelled), cancelled ? 'warn' : (bad ? 'warn' : 'success'), 6000);
    if (flagged.length) {
      showProbeReportModal(flagged.map(({ s, r }) => ({
        icon: r.verdict === 'suspicious' ? '⚠️' : '❌',
        text: `${s.title || '未知曲目'} - ${s.artist || '未知艺人'}（${(r.codec || '?').toUpperCase()}${r.bitrateKbps ? ' · ' + r.bitrateKbps + 'kbps' : ''}）`,
      })));
    }
  } finally {
    _probeScanCancelled = false;
    if (wrap) wrap.style.display = 'none';
    if (bar) bar.style.width = '0%';
  }
}

// ── 批量歌词 ─────────────────────────────────────────
async function batchFetchLyrics() {
  const localSongs = getState('localSongs');
  // 只选有 title + artist 的歌
  const candidates = localSongs.filter(s => s.title && s.artist);
  if (!candidates.length) {
    showToast('本地库中没有带标题和艺术家的歌曲', 'warn');
    return;
  }

  _batchCancelled = false;
  const total = candidates.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('localBatchProgressWrap');
  const progressBar = document.getElementById('localBatchProgressBar');
  const progressLabel = document.getElementById('localBatchProgressLabel');
  if (progressWrap) progressWrap.style.display = 'flex';
  if (progressBar) progressBar.style.width = '0%';
  if (progressLabel) progressLabel.textContent = `正在补全歌词 (0/${total})`;

  try {
    const results = await api.batchFetchLyrics(
      candidates.map(s => ({ filePath: s.filePath, title: s.title, artist: s.artist }))
    );

    // results 是 { filePath, ok, error } 数组
    for (const r of results) {
      if (_batchCancelled) break;
      done++;
      if (r.ok) ok++; else fail++;
      const pct = Math.round((done / total) * 100);
      progressBar.style.width = pct + '%';
      progressLabel.textContent = `正在补全歌词 (${done}/${total})`;
    }
  } catch (e) {
    showToast('批量歌词获取失败: ' + errBrief(e), 'error');
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  showToast(`批量补歌词完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 拉取单曲封面 ─────────────────────────────────────
async function refetchCover(idx) {
  const localFiltered = getState('localFiltered');
  const s = localFiltered[idx];
  if (!s) return;
  if (!s.title || !s.artist) {
    showToast('需要歌曲名和歌手才能在线拉取封面', 'warn');
    return;
  }
  showToast(`🔍 正在搜索《${s.title}》的封面...`, 'info', 1500);
  try {
    const result = await api.fetchOnlineCover(s.title, s.artist);
    if (result && result.success && result.coverBase64) {
      const ok = await api.updateId3Cover(s.filePath, result.coverBase64);
      s.cover = ok && ok.success ? result.coverBase64 : null;
      const localSongs = getState('localSongs');
      const idx2 = localSongs.findIndex(x => x.filePath === s.filePath);
      if (idx2 >= 0) localSongs[idx2].cover = s.cover;
      renderLocalSongs();
      if (s.cover) {
        showToast(`✅ 封面已拉取并写入文件（${result.source}）`, 'success');
      } else {
        showToast('❌ 封面写入文件失败，请重试', 'warn', 3000);
      }
    } else {
      showToast('❌ 未找到匹配的封面：' + (result?.error || '请检查歌名/歌手'), 'warn', 3500);
    }
  } catch (e) {
    showToast('拉取失败: ' + errBrief(e), 'error');
  }
}

// ── 工具 ──────────────────────────────────────────────
// esc()、fmtDuration()、formatBytes() 已由 utils.js 全局导出，此处不再重复定义

// ── 视图切换：list → grid → album → list ────────────
let _localViewMode = 'list';
let _localAlbumFilter = '';

// 大库分片渲染：首屏同步出结果，其余按片 rAF 追加；token 防快速重筛竞态。
//
// 为什么渲染函数返回 Promise（与 views/playlist.js、views/converter.js 同一约定）：
// 分片期间网格里只有前 LOCAL_GRID_CHUNK 格，依赖"全部格子已在 DOM"的路径
// （滚动定位、批量按序号取格子）在那个窗口里会读到半个列表。返回 Promise 让调用方
// 能 await 一次"分片已落地"，而不用自己猜还剩几片。
// 在跑的分片各挂一个结算句柄：被作废时**必须**结算，否则 await 的调用方会永久挂起。
const LOCAL_GRID_CHUNK = 100;
let _localGridRenderToken = 0;
let _localGridPending = [];

/**
 * 作废在跑的分片并立即结算它们。
 * token 由外部 ++（toggleLocalView / openAlbumFromWall 切视图）也能作废：那条路径
 * 不经过本函数，但**已经排进 rAF 队列的那一帧**照样会来，届时 appendSlice 发现
 * token 变了会自己结算 —— 所以这里不必、也不该去改那两个函数。
 *
 * 顺序：先换新名单再结算旧的。settle() 会把自己从名单里摘掉，顺序反了就会去
 * splice 刚登记进来的新分片。
 */
function _localGridInvalidate() {
  _localGridRenderToken++;
  const old = _localGridPending;
  _localGridPending = [];
  for (const d of old) d.settle();
}

/**
 * 登记一次分片渲染。settle 幂等 ——「跑完」与「被作废」两条路径都会调它。
 *
 * ⚠️ settle() 必须把自己从 _localGridPending 里摘掉（playlist.js 的 _plDeferRender
 * 那里记了为什么：只结算不摘会让"在跑"名单变成"跑过"名单，等排空的 while 永不停）。
 * 这里的直接后果是 await localGridRenderIdle() 永不返回。
 */
function _localGridDefer() {
  let done = false;
  let settle;
  const promise = new Promise((res) => { settle = res; });
  const d = {
    promise,
    settle() {
      if (done) return;
      done = true;
      const i = _localGridPending.indexOf(d);
      if (i >= 0) _localGridPending.splice(i, 1);
      settle();
    },
  };
  _localGridPending.push(d);
  return d;
}

/**
 * 等网格分片全部落地（被作废的那轮早已结算，不会永久挂起）。
 *
 * 循环而不是一次 Promise.all，与 playlist.js 的 _plRenderIdle 同一理由（那里记了
 * 实测过程）：等待期间又来一次渲染时，那一轮会结算掉本轮句柄并登记自己，
 * "只等一次"就会在**新那一轮才画完第一片**的时刻返回 —— 而 100 格的分片下，
 * 那一刻网格里恰好缺着调用方要按序号取的那一格。
 */
async function localGridRenderIdle() {
  while (_localGridPending.length) {
    await Promise.all(_localGridPending.map((d) => d.promise));
  }
}

/** 按钮文案 = 下一次点击的目标视图；同步 data-i18n 供语言切换重刷 */
function _updateViewToggleBtn(btn) {
  if (!btn) return;
  const next = _localViewMode === 'list' ? 'local.grid'
    : _localViewMode === 'grid' ? 'local.viewAlbum'
    : 'local.viewList';
  btn.dataset.i18n = next;
  btn.textContent = t(next);
}

function _setViewChrome() {
  const list = document.getElementById('localList');
  const grid = document.getElementById('localGrid');
  const wall = document.getElementById('localAlbumWall');
  const chip = document.getElementById('localAlbumFilterChip');
  if (list) list.style.display = _localViewMode === 'list' ? 'flex' : 'none';
  if (grid) grid.style.display = _localViewMode === 'grid' ? 'grid' : 'none';
  if (wall) wall.style.display = _localViewMode === 'album' ? 'grid' : 'none';
  if (chip) chip.style.display = _localAlbumFilter ? '' : 'none';
}

function toggleLocalView() {
  _localViewMode = _localViewMode === 'list' ? 'grid'
    : _localViewMode === 'grid' ? 'album' : 'list';
  if (_localViewMode !== 'album') {
    // 离开封面墙时清掉专辑过滤。必须接着**重算** localFiltered：
    // renderLocalSongs/renderLocalGrid 都只读 getState('localFiltered')，
    // 不会自己过滤。曾经在清完 _localAlbumFilter 之后直接调渲染函数，
    // 于是列表/网格继续显示「只有那一张专辑」的上一轮结果，而代表该过滤的
    // chip 已被 _setViewChrome() 藏掉 —— 用户看到的是「曲库丢歌了」，
    // 而且没有任何入口能把过滤清回来。
    _localAlbumFilter = '';
  }
  _localGridRenderToken++; // 作废进行中的分片追加
  _setViewChrome();
  _updateViewToggleBtn(document.getElementById('localViewToggleBtn'));
  // 走 filterLocalSongs() 而非直接渲染：它会重算全部筛选轴并按当前视图分发。
  filterLocalSongs();
}

/** 点封面墙卡片：设专辑过滤并切到列表视图 */
function openAlbumFromWall(album) {
  _localAlbumFilter = album || '';
  _localViewMode = 'list';
  _localGridRenderToken++;
  _setViewChrome();
  _updateViewToggleBtn(document.getElementById('localViewToggleBtn'));
  const label = document.getElementById('localAlbumFilterLabel');
  if (label) label.textContent = _localAlbumFilter;
  filterLocalSongs();
}

/** 清除专辑过滤 chip（回到全量列表） */
function clearAlbumFilter() {
  if (!_localAlbumFilter) return;
  _localAlbumFilter = '';
  const chip = document.getElementById('localAlbumFilterChip');
  if (chip) chip.style.display = 'none';
  filterLocalSongs();
}

function renderLocalGrid() {
  const grid = document.getElementById('localGrid');
  const localFiltered = getState('localFiltered');
  if (!localFiltered || !localFiltered.length) {
    _localGridInvalidate(); // 空态时作废进行中的分片，避免被后续片覆盖
    grid.innerHTML = `<div class="empty-state" style="flex:1;width:100%">
      <div class="empty-icon">📂</div>
      <div class="empty-text">暂无本地歌曲</div>
      <div class="empty-hint">点击"扫描目录"选择音乐文件夹</div>
    </div>`;
    return Promise.resolve();
  }
  const rows = localFiltered.map((s, i) => `
    <div class="grid-cell" tabindex="0" role="button" onclick="playLocalSong(${i})">
      <div class="grid-cover">
        ${s.cover
          ? `<img src="${escAttr(s.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="grid-cover-ph" ${s.cover ? 'style="display:none"' : ''}>🎵</div>
        <div class="grid-play-overlay">▶</div>
      </div>
      <div class="grid-info">
        <div class="grid-title">${esc(s.title || '未知')}</div>
        <div class="grid-artist">${esc(s.artist || '未知艺术家')}</div>
      </div>
    </div>`);
  _localGridInvalidate();
  const d = _localGridDefer();
  const token = _localGridRenderToken;
  let cursor = 0;
  const appendSlice = () => {
    // 被作废（新一轮渲染，或 toggleLocalView/openAlbumFromWall 外部 ++token）时
    // 先结算再走人：不结算就是永久 pending。
    if (token !== _localGridRenderToken) return d.settle();
    const end = Math.min(cursor + LOCAL_GRID_CHUNK, rows.length);
    let html = '';
    for (let i = cursor; i < end; i++) html += rows[i];
    if (cursor === 0) grid.innerHTML = html;
    else grid.insertAdjacentHTML('beforeend', html);
    cursor = end;
    if (cursor < rows.length) requestAnimationFrame(appendSlice);
    else d.settle();
  };
  appendSlice();
  return d.promise;
}

/** 封面墙：按专辑分组渲染，分片 rAF + token 防竞态 */
function renderLocalAlbumWall() {
  const wall = document.getElementById('localAlbumWall');
  if (!wall) return;
  // 必须取 localFiltered 而不是 localSongs：封面墙过去直接从未过滤的全量曲库
  // 起算，于是搜索框、格式/音质/完整度/收藏/文件夹这些筛选轴在专辑视图下
  // **全部无效**（界面毫无反应，看着像控件坏了）。
  // 取 localFiltered 后卡片上的歌数也变成「当前筛选结果里该专辑有几首」，
  // 与点进去之后看到的数量一致 —— 之前两者会对不上。
  const songs = getState('localFiltered') || [];
  const groups = groupSongsForAlbumWall(songs);
  if (!groups.length) {
    _localGridRenderToken++;
    wall.innerHTML = `<div class="empty-state" style="flex:1;width:100%">
      <div class="empty-icon">💿</div>
      <div class="empty-text">暂无本地歌曲</div>
      <div class="empty-hint">点击"扫描目录"选择音乐文件夹</div>
    </div>`;
    return;
  }
  const rows = groups.map(g => `
    <div class="grid-cell" tabindex="0" role="button" data-album="${escAttr(g.album)}" onclick="openAlbumFromWall(this.dataset.album)">
      <div class="grid-cover">
        ${g.cover
          ? `<img src="${escAttr(g.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="grid-cover-ph" ${g.cover ? 'style="display:none"' : ''}>💿</div>
        <div class="grid-play-overlay">▶</div>
      </div>
      <div class="grid-info">
        <div class="grid-title">${esc(g.album)}</div>
        <div class="grid-artist">${esc(g.artists)} · ${esc(t('local.albumSongCount', { count: g.count }))}</div>
      </div>
    </div>`);
  const token = ++_localGridRenderToken;
  let cursor = 0;
  const appendSlice = () => {
    if (token !== _localGridRenderToken) return;
    const end = Math.min(cursor + LOCAL_GRID_CHUNK, rows.length);
    let html = '';
    for (let i = cursor; i < end; i++) html += rows[i];
    if (cursor === 0) wall.innerHTML = html;
    else wall.insertAdjacentHTML('beforeend', html);
    cursor = end;
    if (cursor < rows.length) requestAnimationFrame(appendSlice);
  };
  appendSlice();
}

// ── 一键补全元数据（封面+歌词）────────────────────────
async function batchAutoMeta() {
  const localSongs = getState('localSongs');
  const needMeta = localSongs.filter(s => s.title && s.artist);
  if (!needMeta.length) {
    showToast('没有带标题和艺术家的歌曲可供补全', 'warn');
    return;
  }

  const progressWrap = document.getElementById('localBatchProgressWrap');
  const progressBar = document.getElementById('localBatchProgressBar');
  const progressLabel = document.getElementById('localBatchProgressLabel');
  progressWrap.style.display = 'flex';
  _batchCancelled = false;

  // 第一步：补封面
  const needCover = needMeta.filter(s => !s.cover);
  let coverOk = 0, coverFail = 0;
  if (needCover.length) {
    // M14: 循环内 findIndex 是 O(n×m)，先用 filePath 建索引
    const filteredIndex = new Map(getState('localFiltered').map(x => [x.filePath, x]));
    progressLabel.textContent = `步骤 1/2：补全封面 (0/${needCover.length})`;
    for (let di = 0; di < needCover.length; di++) {
      if (_batchCancelled) break;
      const s = needCover[di];
      try {
        const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
        if (result && result.coverBase64) {
          const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
          if (wr && wr.success) {
            s.cover = result.coverBase64;
            const fe = filteredIndex.get(s.filePath);
            if (fe) fe.cover = result.coverBase64;
            coverOk++;
          } else { coverFail++; }
        } else { coverFail++; }
      } catch { coverFail++; }
      progressBar.style.width = ((di + 1) / needCover.length * 50) + '%';
      progressLabel.textContent = `步骤 1/2：补全封面 (${di + 1}/${needCover.length})`;
    }
  }

  // 第二步：补歌词
  let lyricOk = 0, lyricFail = 0;
  if (!_batchCancelled) {
    progressLabel.textContent = '步骤 2/2：补全歌词...';
    try {
      const results = await api.batchFetchLyrics(
        needMeta.map(s => ({ filePath: s.filePath, title: s.title, artist: s.artist }))
      );
      for (const r of results) {
        if (_batchCancelled) break;
        if (r.ok) lyricOk++; else lyricFail++;
      }
    } catch { lyricFail = needMeta.length; }
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`一键补全完成：封面 ✅${coverOk} ❌${coverFail} | 歌词 ✅${lyricOk} ❌${lyricFail}`, coverOk + lyricOk > 0 ? 'success' : 'warn', 5000);
}


// ══════════════════════════════════════════════════════════
// 批量重命名
// ══════════════════════════════════════════════════════════

function openBatchRename() {
  const count = _selectedLocal.size;
  if (!count) { showToast('请先选择要重命名的歌曲', 'warn'); return; }

  let overlay = document.getElementById('renameModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'renameModal';
  overlay.className = 'stats-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel rename-panel">
      <div class="stats-header">
        <span>📝 批量重命名 ${count} 首</span>
        <button onclick="document.getElementById('renameModal').remove()">✕</button>
      </div>
      <div class="stats-body">
        <div class="rename-section">
          <div class="rename-section-title">命名模板</div>
          <div class="rename-hint">
            可用变量：<code>{title}</code> <code>{artist}</code> <code>{album}</code> <code>{track}</code> <code>{num}</code>
          </div>
          <input class="rename-input" id="renameTemplate" value="{artist} - {title}" placeholder="{artist} - {title}">
          <div class="rename-preview-title">预览</div>
          <div class="rename-preview" id="renamePreview"></div>
        </div>
        <div class="rename-section">
          <div class="rename-section-title">选项</div>
          <label class="rename-option">
            <input type="checkbox" id="renameKeepExt" checked> 保留原文件扩展名
          </label>
          <label class="rename-option">
            <input type="checkbox" id="renameSanitize" checked> 自动清理非法字符
          </label>
        </div>
        <div class="rename-actions">
          <button class="rename-cancel" onclick="document.getElementById('renameModal').remove()">取消</button>
          <button class="rename-confirm" onclick="executeBatchRename()">确认重命名</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // 绑定预览更新（先移除旧监听器，避免重复绑定）
  const templateInput = document.getElementById('renameTemplate');
  templateInput.removeEventListener('input', updateRenamePreview);
  templateInput.addEventListener('input', updateRenamePreview);
  updateRenamePreview();
}

function updateRenamePreview() {
  const template = document.getElementById('renameTemplate')?.value || '{artist} - {title}';
  const previewEl = document.getElementById('renamePreview');
  if (!previewEl) return;

  const localSongs = getState('localSongs');
  const selected = Array.from(_selectedLocal).slice(0, 5);
  const previews = selected.map(fp => {
    const song = localSongs.find(s => s.filePath === fp);
    if (!song) return fp;
    const ext = document.getElementById('renameKeepExt')?.checked
      ? path.extname(fp)
      : '';
    return renderRenameTemplate(template, song, 1) + ext;
  });

  previewEl.innerHTML = previews.map(p => `<div class="rename-preview-item">${esc(p)}</div>`).join('');
  if (selected.length < _selectedLocal.size) {
    previewEl.innerHTML += `<div class="rename-preview-more">...还有 ${_selectedLocal.size - selected.length} 首</div>`;
  }
}

function renderRenameTemplate(template, song, num) {
  return template
    .replace(/\{title\}/g, song.title || '未知')
    .replace(/\{artist\}/g, song.artist || '未知艺术家')
    .replace(/\{album\}/g, song.album || '未知专辑')
    .replace(/\{track\}/g, String(num).padStart(2, '0'))
    .replace(/\{num\}/g, String(num));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200) || '_';
}

async function executeBatchRename() {
  const template = document.getElementById('renameTemplate')?.value;
  if (!template) { showToast('请输入命名模板', 'warn'); return; }

  const keepExt = document.getElementById('renameKeepExt')?.checked;
  const sanitize = document.getElementById('renameSanitize')?.checked;
  const count = _selectedLocal.size;
  if (!count) return;

  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');
  let ok = 0, fail = 0, relinkFailed = 0;

  const progressWrap = document.getElementById('localBatchProgressWrap');
  const progressBar = document.getElementById('localBatchProgressBar');
  const progressLabel = document.getElementById('localBatchProgressLabel');
  progressWrap.style.display = 'flex';
  progressBar.style.width = '0%';
  progressLabel.textContent = `正在重命名 (0/${count})`;

  let idx = 0;
  for (const fp of _selectedLocal) {
    idx++;
    const song = localSongs.find(s => s.filePath === fp);
    if (!song) { fail++; continue; }

    try {
      const ext = keepExt ? path.extname(fp) : '';
      let newName = renderRenameTemplate(template, song, idx);
      if (sanitize) newName = sanitizeFilename(newName);
      newName += ext;

      const dir = path.dirname(fp);
      const newPath = path.join(dir, newName);

      if (fp === newPath) { ok++; continue; }

      const result = await api.renameFile(fp, newPath);
      if (result && result.success) {
        // 更新状态
        const s = localSongs.find(x => x.filePath === fp);
        if (s) s.filePath = newPath;
        const fi = localFiltered.findIndex(x => x.filePath === fp);
        if (fi >= 0) localFiltered[fi].filePath = newPath;
        // relink 为空 = 主进程回写路径引用时出了岔子（它自己已记日志）。
        // 不能让它被"重命名成功"盖过去：文件改名的同时引用没跟上，正是失联的起点
        if (!result.relink) relinkFailed++;
        ok++;
      } else {
        fail++;
        logger.warn('重命名失败:', fp, result?.error);
      }
    } catch (e) {
      fail++;
      logger.warn('重命名异常:', fp, e.message);
    }

    progressBar.style.width = Math.round(idx / count * 100) + '%';
    progressLabel.textContent = `正在重命名 (${idx}/${count})`;
  }

  _selectedLocal.clear();
  renderLocalSongs();
  exitLocalSelectionMode();
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';

  const overlay = document.getElementById('renameModal');
  if (overlay) overlay.remove();

  // 主进程改名时顺带回写了盘上的收藏/最近播放路径，但渲染层内存里还握着旧引用，
  // 不重拉的话用户下次收藏就会把刚修好的路径覆盖回旧值
  if (ok && typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();

  const relinkNote = relinkFailed ? `  ⚠ ${relinkFailed} 个文件的记录路径未同步（歌单/历史可能仍指向旧名）` : '';
  showToast(`重命名完成：✅ ${ok} 成功  ❌ ${fail} 失败${relinkNote}`, ok > 0 ? 'success' : 'warn', 4000);
}

// ══════════════════════════════════════════════════════════
// 批量封面下载（增强：显示进度）
// ══════════════════════════════════════════════════════════

async function batchDownloadCovers() {
  const localSongs = getState('localSongs');
  const needCover = localSongs.filter(s => !s.cover && s.title && s.artist);
  if (!needCover.length) {
    showToast('✅ 所有歌曲都已有封面', 'info');
    return;
  }

  _batchCancelled = false;
  const total = needCover.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('localBatchProgressWrap');
  const progressBar = document.getElementById('localBatchProgressBar');
  const progressLabel = document.getElementById('localBatchProgressLabel');
  progressWrap.style.display = 'flex';
  progressBar.style.width = '0%';
  progressLabel.textContent = `正在下载封面 (0/${total})`;

  for (const s of needCover) {
    if (_batchCancelled) break;
    try {
      const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
      if (result && result.coverBase64) {
        const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
        if (wr && wr.success) {
          s.cover = result.coverBase64;
          const localFiltered = getState('localFiltered');
          const fi = localFiltered.findIndex(x => x.filePath === s.filePath);
          if (fi >= 0) localFiltered[fi].cover = result.coverBase64;
          ok++;
        } else { fail++; }
      } else { fail++; }
    } catch (_e) { fail++; }
    done++;
    progressBar.style.width = Math.round(done / total * 100) + '%';
    progressLabel.textContent = `正在下载封面 (${done}/${total})`;
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`批量封面下载完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 多格式转码（复用 converter-core 的共用弹窗）──────────
// 选中的歌按 Set 里存的路径回查，避免按 localFiltered 索引取——弹窗开着
// 期间列表被过滤/重排会转错歌。
function _selectedSongsToConvert() {
  // 本视图的选中集是 _selectedLocal（selectedSongs 是搜索页的状态，
  // 本地页里恒空 → 「转换格式」永远提示未选中）。按路径回查 localSongs
  //（全集），弹窗开着期间列表被过滤/重排也不会转错歌。
  const localSongs = getState('localSongs') || [];
  const localFiltered = getState('localFiltered') || [];
  const pool = localSongs.length ? localSongs : localFiltered;
  return Array.from(_selectedLocal)
    .map(p => pool.find(s => s.filePath === p || s.path === p))
    .filter(Boolean)
    .map(s => ({
      path: s.filePath || s.path,
      title: s.title,
      artist: s.artist,
      ext: s.ext,
    }));
}

async function convertSelectedAudio() {
  const songsToConvert = _selectedSongsToConvert();
  if (!songsToConvert.length) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
  }

  // allowOutputDirPick：批量场景必须共用一个输出目录。旧实现不给 outputDir，
  // 后端会为每一首歌各弹一次另存对话框——9 首歌就是 9 次弹窗。
  openConvertModal({
    items: songsToConvert,
    title: '🔄 音频转码',
    allowOutputDirPick: true,
    onConfirm: async (format, bitrate, items, outputDir) => {
      // items 是弹窗里实际勾选的，不是打开弹窗时的全选列表
      const { ok, fail, canceled } = await runConvertBatch({
        items,
        format,
        bitrate,
        outputDir,
      });
      if (ok > 0 || fail > 0 || canceled > 0) {
        showToast(
          `转码结束：✅ ${ok} 成功${fail > 0 ? ` ❌ ${fail} 失败` : ''}${canceled > 0 ? ' ⏹ 已取消' : ''}`,
          ok > 0 ? 'success' : 'warn',
          4000,
        );
      }
    },
  });
}

// ── 本地库视图清理（切换页面时调用）─────────────────────
function localCleanup() {
  // 关闭编辑弹窗并清理 document click 监听器
  if (document.getElementById('editOverlay') &&
      !document.getElementById('editOverlay').classList.contains('hidden')) {
    closeEdit();
  }
  // 清理拖拽监听器
  teardownDragCover();
}

// 注入库变更回调：统计/查重模块删歌后需要刷新列表。
// 必须注入**过滤管线入口** filterLocalSongs 而不是裸渲染器 renderLocalSongs：
//   · 网格视图渲染进 #localGrid，而 renderLocalSongs 只写 #localList
//     → 网格视图下删重后界面毫无变化（歌曲删了、格子还在）；
//   · 裸渲染器不重套收藏/格式/音质/完整度/关键词五个过滤轴与排序。
// 与 :151/:158/:270 三条换库路径同一约定。
setLibraryChangeHandler(filterLocalSongs);

// ── ES Module 导出 ──────────────────────────────────────
export {
  scanLocalDir,
  filterLocalSongs,
  refreshLocalLibrary,
  renderLocalSongs,
  renderLocalGrid,
  renderLocalAlbumWall,
  localGridRenderIdle,
  toggleLocalView,
  openAlbumFromWall,
  clearAlbumFilter,
  playLocalSong,
  refetchCover,
  batchFetchCovers,
  batchFetchLyrics,
  batchAutoMeta,
  cancelBatchFetch,
  enterLocalSelectionMode,
  exitLocalSelectionMode,
  toggleLocalSelect,
  selectAllLocal,
  deselectAllLocal,
  openBatchEdit,
  openEdit,
  closeEdit,
  closeEditOnBg,
  onEditCoverSelect,
  clearEditCover,
  saveEdit,
  saveBatchEdit,
  showLibraryStats,
  detectDuplicateSongs,
  convertSelectedAudio,
  toggleDupSelect,
  selectAllDups,
  deselectAllDups,
  deleteSelectedDups,
  openBatchRename,
  executeBatchRename,
  batchDownloadCovers,
  locatePlayingLocal,
  localCleanup,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.scanLocalDir = scanLocalDir;
window.filterLocalSongs = filterLocalSongs;
window.cycleLocalSort = cycleLocalSort;
window.toggleLocalFavOnly = toggleLocalFavOnly;
window.cycleLocalFmt = cycleLocalFmt;
window.cycleLocalQual = cycleLocalQual;
window.cycleLocalMeta = cycleLocalMeta;
window.copyLocalListText = copyLocalListText;
window.refreshLocalLibrary = refreshLocalLibrary;
window.renderLocalSongs = renderLocalSongs;
window.renderLocalGrid = renderLocalGrid;
window.localGridRenderIdle = localGridRenderIdle;
window.renderLocalAlbumWall = renderLocalAlbumWall;
window.toggleLocalView = toggleLocalView;
window.openAlbumFromWall = openAlbumFromWall;
window.clearAlbumFilter = clearAlbumFilter;
window.playLocalSong = playLocalSong;
window.locatePlayingLocal = locatePlayingLocal;
window.refetchCover = refetchCover;
window.batchFetchCovers = batchFetchCovers;
window.batchFetchLyrics = batchFetchLyrics;
window.batchAutoMeta = batchAutoMeta;
window.cancelBatchFetch = cancelBatchFetch;
window.batchProbeQuality = batchProbeQuality;
window.cancelProbeScan = cancelProbeScan;
window.enterLocalSelectionMode = enterLocalSelectionMode;
window.exitLocalSelectionMode = exitLocalSelectionMode;
window.toggleLocalSelect = toggleLocalSelect;
window.selectAllLocal = selectAllLocal;
window.deselectAllLocal = deselectAllLocal;
window.exportLocalM3u = exportLocalM3u;
window.openBatchEdit = openBatchEdit;
window.openEdit = openEdit;
window.closeEdit = closeEdit;
window.closeEditOnBg = closeEditOnBg;
window.onEditCoverSelect = onEditCoverSelect;
window.clearEditCover = clearEditCover;
window.saveEdit = saveEdit;
window.saveBatchEdit = saveBatchEdit;
window.showLibraryStats = showLibraryStats;
window.detectDuplicateSongs = detectDuplicateSongs;
window.detectContentDuplicates = detectContentDuplicates;
window.convertSelectedAudio = convertSelectedAudio;
window.toggleDupSelect = toggleDupSelect;
window.selectAllDups = selectAllDups;
window.deselectAllDups = deselectAllDups;
window.deleteSelectedDups = deleteSelectedDups;
window.openBatchRename = openBatchRename;
window.executeBatchRename = executeBatchRename;
window.batchDownloadCovers = batchDownloadCovers;
window.localCleanup = localCleanup;
window.showLocalRowMenu = showLocalRowMenu;
