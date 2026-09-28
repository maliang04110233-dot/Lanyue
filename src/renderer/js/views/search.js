/**
 * MusicDL 搜索视图 - 单曲/专辑/歌手搜索 + 批量操作
 */

import { errBrief } from '../errBrief.js';
import { logger } from '../logger.js';
import { heartBtnHtml, registerFavSong, toggleFavoriteByKey } from '../favorites.js';
import { planBatchFav, favSkipSuffix } from '../favBatch.js';
import { favKey } from '../state.js';
import { dlBadgeHtml, dlStatusFor, dlEnsureHistoryLoaded, addDlChangeListener } from '../dlStatus.js';
import { openSongRowMenu } from '../songMenu.js';
import { nextSortMode, sortLabel, sortPairs } from '../searchSort.js';
import { markTerm } from '../highlight.js';
import { buildFallbackNotice } from '../fallbackNotice.js';
import { dismissedKeySet, filterDismissedPairs, onDismissChanged } from '../dismissed.js';
import { skeletonHtml, SKEL_ROWS } from '../skeleton.js';
import { t } from '../i18n.js';

// ── DOM 缓存（避免重复查询）──────────────────────────
const _dom = {
  searchInput: null,
  songList: null,
  batchToolbar: null,
  pagination: null,
  searchHistory: null,
};

function _cacheDom() {
  _dom.searchInput = document.getElementById('searchInput');
  _dom.songList = document.getElementById('songList');
  _dom.batchToolbar = document.getElementById('batchToolbar');
  _dom.pagination = document.getElementById('pagination');
  _dom.searchHistory = document.getElementById('searchHistory');
}

// 检查 API 是否可用
function checkAPI() {
  if (!window.musicAPI || typeof window.musicAPI.searchMusic !== 'function') {
    logger.warn('[checkAPI] API不可用:', typeof window.musicAPI);
    return false;
  }
  return true;
}

// 清除加载状态
function clearLoading() {
  if (_dom.songList) _dom.songList.innerHTML = '';
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';
}

// 显示错误状态
function showLoadError(msg) {
  if (_dom.songList) {
    _dom.songList.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-text">加载失败</div>
      <div class="empty-hint">${esc(msg || '')}</div>
    </div>`;
  }
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';
}

const MAX_HISTORY = 20;

// ── 搜索防抖 ──────────────────────────────────────────
let _searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

function debounceSearch() {
  _kbdIdx = -1; // 用户重新输入，键盘建议循环归零
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    _searchDebounceTimer = null;
    const keyword = _dom.searchInput?.value?.trim();
    if (keyword && keyword.length >= 2) {
      doSearch(1);
    }
    hideSearchSuggestions();
  }, SEARCH_DEBOUNCE_MS);
  // 显示搜索建议
  showSearchSuggestions();
}

// ── 搜索建议（基于最近播放 + 搜索历史）──────────────
function showSearchSuggestions() {
  const input = _dom.searchInput;
  if (!input) return;
  const kw = input.value.trim().toLowerCase();
  if (!kw || kw.length < 1) {
    hideSearchSuggestions();
    return;
  }

  // 从最近播放和搜索历史中筛选匹配项
  const recentlyPlayed = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
  const suggestions = [];

  // 最近播放匹配
  for (const song of recentlyPlayed) {
    if (suggestions.length >= 5) break;
    const title = (song.title || '').toLowerCase();
    const artist = (song.artist || '').toLowerCase();
    if (title.includes(kw) || artist.includes(kw)) {
      suggestions.push({
        type: 'recent',
        title: song.title,
        artist: song.artist,
        icon: '🎵',
      });
    }
  }

  // 搜索历史匹配
  getSearchHistory().then(history => {
    for (const h of history) {
      if (suggestions.length >= 8) break;
      if (h.keyword && h.keyword.toLowerCase().includes(kw)) {
        const exists = suggestions.some(s => s.title === h.keyword);
        if (!exists) {
          suggestions.push({
            type: 'history',
            title: h.keyword,
            icon: '🕐',
          });
        }
      }
    }

    if (!suggestions.length) {
      hideSearchSuggestions();
      return;
    }

    // 渲染建议列表
    let container = document.getElementById('searchSuggestions');
    if (!container) {
      container = document.createElement('div');
      container.id = 'searchSuggestions';
      container.className = 'search-suggestions';
      input.parentElement.appendChild(container);
    }

    container.innerHTML = suggestions.map(s => `
      <div class="suggestion-item" onmousedown="selectSuggestion('${escQ(s.title)}')">
        <span class="suggestion-icon">${s.icon}</span>
        <span class="suggestion-title">${esc(s.title)}</span>
        ${s.artist ? `<span class="suggestion-artist">${esc(s.artist)}</span>` : ''}
      </div>
    `).join('');
    container.style.display = 'block';
  });
}

function hideSearchSuggestions() {
  const container = document.getElementById('searchSuggestions');
  if (container) container.style.display = 'none';
}

// ── 键盘导航 ─────────────────────────────────────────
// 输入框内：↑/↓ 循环当前可见的搜索建议/历史并回填输入框，Enter 搜索，Esc 收起并失焦
// 输入框外（搜索页激活）：↑/↓ 高亮结果行，Enter 将高亮曲加入下载队列
let _kbdIdx = -1;
let _rowIdx = -1;
let _visibleIdxMap = [];        // 当前可见行 → 原始 songs 索引（「隐藏已下载」过滤后不回移）
let _hideDownloaded = false;    // 搜索页过滤开关
let _searchSortMode = 'default'; // 搜索结果排序（会话级，与过滤同层）

/** 「隐藏已下载」切换：会话级开关，仅影响渲染，不动数据 */
function toggleHideDownloaded() {
  _hideDownloaded = !_hideDownloaded;
  const btn = document.getElementById('hideDlToggle');
  if (btn) btn.classList.toggle('active', _hideDownloaded);
  if (_dlLastList) renderSongList(_dlLastList);
}

/** 排序循环：默认 → 时长↓ → 时长↑ → 按来源 → 默认 */
function cycleSearchSort() {
  _searchSortMode = nextSortMode(_searchSortMode);
  const btn = document.getElementById('searchSortBtn');
  if (btn) btn.textContent = sortLabel(_searchSortMode);
  if (_dlLastList) renderSongList(_dlLastList);
}
let _lastRenderedSongList = null;

function searchInputKey(e) {
  if (e.key === 'Enter') {
    hideSearchSuggestions();
    hideSearchHistory();
    doSearch();
    return;
  }
  if (e.key === 'Escape') {
    hideSearchSuggestions();
    hideSearchHistory();
    e.target.blur();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const kws = _visibleSuggestKeywords();
    if (!kws.length) return;
    e.preventDefault();
    const n = kws.length;
    _kbdIdx = e.key === 'ArrowDown' ? (_kbdIdx + 1) % n : (_kbdIdx - 1 + n) % n;
    _dom.searchInput.value = kws[_kbdIdx];
    _markSuggestActive(kws[_kbdIdx]);
  }
}

function _visibleSuggestKeywords() {
  const out = [];
  const sug = document.getElementById('searchSuggestions');
  if (sug && sug.style.display !== 'none') {
    sug.querySelectorAll('.suggestion-item').forEach(el => {
      const t = el.querySelector('.suggestion-title')?.textContent?.trim();
      if (t && !out.includes(t)) out.push(t);
    });
  }
  const hist = document.getElementById('searchHistory');
  if (hist && hist.style.display !== 'none') {
    hist.querySelectorAll('.history-kw').forEach(el => {
      const t = el.textContent.trim();
      if (t && !out.includes(t)) out.push(t);
    });
  }
  return out;
}

function _markSuggestActive(kw) {
  document.querySelectorAll('#searchSuggestions .kbd-active, #searchHistory .kbd-active')
    .forEach(el => el.classList.remove('kbd-active'));
  document.querySelectorAll('#searchSuggestions .suggestion-title, #searchHistory .history-kw').forEach(el => {
    if (el.textContent.trim() === kw) {
      const row = el.closest('.suggestion-item, .search-history-item');
      if (row) row.classList.add('kbd-active');
    }
  });
}

function _songRows() {
  const list = document.getElementById('songList');
  return list ? Array.from(list.querySelectorAll('.song-row')) : [];
}

/** 全局 keydown 委托入口；消费了按键返回 true */
function searchListKey(e) {
  const rows = _songRows();
  if (!rows.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    _rowIdx = e.key === 'ArrowDown'
      ? Math.min(rows.length - 1, _rowIdx + 1)
      : Math.max(0, _rowIdx - 1);
    _markRowActive(rows);
    return true;
  }
  if (e.key === 'Enter' && _rowIdx >= 0 && _rowIdx < rows.length) {
    e.preventDefault();
    addDownload(_visibleIdxMap[_rowIdx] ?? _rowIdx);
    return true;
  }
  return false;
}

function _markRowActive(rows) {
  rows.forEach((r, i) => r.classList.toggle('kbd-focus', i === _rowIdx));
  if (rows[_rowIdx]) rows[_rowIdx].scrollIntoView({ block: 'nearest' });
}

function selectSuggestion(keyword) {
  const input = _dom.searchInput;
  if (input) {
    input.value = keyword;
    doSearch(1);
  }
  hideSearchSuggestions();
}

// ── 搜索视图清理（切换页面时调用）─────────────────────
function searchCleanup() {
  if (_searchDebounceTimer) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = null;
  }
  hideSearchSuggestions();
  hideSearchHistory();
}

// ── 搜索类型状态 ─────────────────────────────────────
let _searchType = 'song'; // 'song' | 'album' | 'singer'

// ── 批量选择模式 ─────────────────────────────────────
let _searchBatchMode = false;

function enterSearchBatchMode() {
  _searchBatchMode = true;
  const btn = document.getElementById('searchSelectBtn');
  if (btn) btn.classList.add('active');
  const songList = document.getElementById('songList');
  if (songList) songList.classList.add('batch-mode');
  setState('selectedSongs', new Set());
  updateBatchInfo();
  // 显示批量工具栏（如果有搜索结果）
  const songs = getState('songs');
  if (songs && songs.length > 0 && _dom.batchToolbar) {
    _dom.batchToolbar.style.display = 'flex';
  }
}

function exitSearchBatchMode() {
  _searchBatchMode = false;
  const btn = document.getElementById('searchSelectBtn');
  if (btn) btn.classList.remove('active');
  const songList = document.getElementById('songList');
  if (songList) songList.classList.remove('batch-mode');
  setState('selectedSongs', new Set());
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  // 隐藏进度条
  const progressWrap = document.getElementById('batchProgressWrap');
  if (progressWrap) progressWrap.style.display = 'none';
  // 重新渲染以清除 checkbox 选中状态
  const songs = getState('songs');
  if (songs && songs.length > 0) renderSongList(songs);
}

// ── 搜索历史（持久化到主进程 prefs.json，修复 B8）─────────────────────
let _searchHistoryCache = null;  // 内存缓存，首次 await 加载

async function getSearchHistory() {
  if (_searchHistoryCache !== null) return _searchHistoryCache;
  try {
    const result = await api.getSearchHistory();
    _searchHistoryCache = Array.isArray(result) ? result : [];
  } catch {
    _searchHistoryCache = [];
  }
  return _searchHistoryCache;
}

function addSearchHistory(keyword) {
  getSearchHistory().then(history => {
    const filtered = history.filter(h => h.keyword !== keyword);
    filtered.unshift({ keyword, time: Date.now() });
    if (filtered.length > MAX_HISTORY) filtered.length = MAX_HISTORY;
    _searchHistoryCache = filtered;
    api.setSearchHistory(filtered).catch(() => {});
  });
}

function removeSearchHistory(keyword) {
  getSearchHistory().then(history => {
    const filtered = history.filter(h => h.keyword !== keyword);
    _searchHistoryCache = filtered;
    api.setSearchHistory(filtered).catch(() => {});
    showSearchHistory();
  });
}

function clearSearchHistory() {
  _searchHistoryCache = [];
  api.setSearchHistory([]).catch(() => {});
  if (_dom.searchHistory) _dom.searchHistory.style.display = 'none';
  showToast('搜索历史已清除', 'info');
}

function showSearchHistory() {
  getSearchHistory().then(history => {
    const el = _dom.searchHistory;
    if (!el) return;
    if (!history.length) { el.style.display = 'none'; return; }

    const kw = _dom.searchInput?.value?.trim()?.toLowerCase() || '';
    const filtered = kw
      ? history.filter(h => h.keyword.toLowerCase().includes(kw))
      : history;
    if (!filtered.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div class="search-history-header">
        <span>搜索历史</span>
        <button class="history-clear-btn" onclick="event.stopPropagation();clearSearchHistory()">清空</button>
      </div>
      ${filtered.map(h => `
      <div class="search-history-item">
        <span class="history-icon">🕐</span>
        <span class="history-kw" onmousedown="event.preventDefault();searchInput.value='${escQ(h.keyword)}';doSearch(1);hideSearchHistory()">${esc(h.keyword)}</span>
        <span class="history-meta">
          <span class="history-time">${fmtHistoryTime(h.time)}</span>
          <button class="history-del-btn" onclick="event.stopPropagation();removeSearchHistory('${escQ(h.keyword)}')" title="删除">✕</button>
        </span>
      </div>
    `).join('')}`;
    el.style.display = 'block';
  }).catch(e => logger.warn('[showSearchHistory] 加载搜索历史失败:', e.message));
}

function hideSearchHistory() {
  setTimeout(() => {
    if (_dom.searchHistory) _dom.searchHistory.style.display = 'none';
  }, 200);
}

// fmtHistoryTime 已由 utils.js 全局导出

// ── 搜索类型切换 ─────────────────────────────────────
/**
 * 页签高亮单源（对应 index.html:188-190 的 data-type）。
 * 传 btn 时以「被点按钮」为准，否则按 _searchType 派生 ——
 * 非点击路径（searchArtistSongs / doNaturalSearch）改完 _searchType 必须调它，
 * 否则列表已是单曲、页签却停在「专辑」，用户会以为结果错了。
 */
function _syncSearchTypeTabs(btn) {
  document.querySelectorAll('.search-type-tabs .tab').forEach(t => {
    t.classList.toggle('active', btn ? t === btn : t.getAttribute('data-type') === _searchType);
  });
}

function switchSearchType(type, btn) {
  _searchType = type;
  _syncSearchTypeTabs(btn);
  if (_dom.searchInput?.value?.trim()) doSearch(1);
}

/** 「搜索该歌手」：歌曲右键入口 → 切到歌手页签并直接出结果（多歌手取第一位） */
async function searchArtistSongs(artistName) {
  const raw = String(artistName || '').trim();
  if (!raw) { showToast('该歌曲没有歌手信息', 'warn'); return; }
  const name = raw.split(/[/&、,，]|feat\.?/i)[0].trim() || raw;
  if (typeof window.switchTab === 'function') window.switchTab('search');
  _searchType = 'singer';
  _syncSearchTypeTabs();
  const input = document.getElementById('searchInput') || _dom.searchInput;
  if (input) input.value = name;
  await doSearch(1);
}

// ── 统一搜索入口 ─────────────────────────────────────
// ── 搜索结果 LRU 缓存 ─────────────────────────────────
const _searchCache = new Map();
const SEARCH_CACHE_MAX = 20;
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function _searchCacheKey(type, page, keyword, source) {
  return `${type}:${source || ''}:${keyword}:${page}`;
}

function _searchCacheGet(key) {
  const entry = _searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL) {
    _searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function _searchCacheSet(key, data) {
  if (_searchCache.size >= SEARCH_CACHE_MAX) {
    // 删除最旧的
    const oldest = _searchCache.keys().next().value;
    _searchCache.delete(oldest);
  }
  _searchCache.set(key, { data, ts: Date.now() });
}

let _typeSearchReqId = 0;
/**
 * @param {number} [reqId] 请求序号。doSearch 会把「发起时占的号」传进来，
 *   使整次搜索（链接识别 + 类型搜索）共用一个序号；独立调用则自动占新号。
 *   这样并发的两次搜索由「谁后发起」决定谁赢，而不是「谁的响应先回来」。
 */
async function doSearchByType(type, page, keyword, source, reqId = ++_typeSearchReqId) {
  const cacheKey = _searchCacheKey(type, page, keyword, source);
  const cached = _searchCacheGet(cacheKey);
  if (cached) {
    const stateKey = { song: 'songs', album: 'albums', singer: 'singers' };
    const renderMap = { song: renderSongList, album: renderAlbumList, singer: renderSingerList };
    const paginationMap = { song: renderPagination, album: renderAlbumPagination, singer: renderSingerPagination };
    setState(stateKey[type], cached.items);
    renderMap[type](cached.items);
    if (paginationMap[type]) paginationMap[type](page, cached.items.length, cached.total);
    if (type === 'song' && cached.items.length > 0 && _searchBatchMode) {
      if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'flex';
      updateBatchInfo();
    }
    return cached.items;
  }

  const apiMap = {
    song: () => api.searchMusic(keyword, source, page),
    album: () => api.searchAlbum(keyword, source || 'qq', page),
    singer: () => api.searchSinger(keyword, source || 'qq', page),
  };
  const stateKey = { song: 'songs', album: 'albums', singer: 'singers' };
  const renderMap = { song: renderSongList, album: renderAlbumList, singer: renderSingerList };
  const paginationMap = { song: renderPagination, album: renderAlbumPagination, singer: renderSingerPagination };

  try {
    const result = await apiMap[type]();
    const items = (result && result[type === 'song' ? 'songs' : type + 's']) || [];
    // 存入缓存
    if (!result?.error) {
      _searchCacheSet(cacheKey, { items, total: result?.total || 0 });
    }
    // 迟到的旧请求结果只进缓存，不再覆盖界面（新搜索已在途时序号已变）
    if (reqId !== _typeSearchReqId) return [];
    setState(stateKey[type], items);
    if (result && result.error) showToast('搜索出错：' + result.error, 'warn', 3500);
    renderMap[type](items);
    if (paginationMap[type]) {
      paginationMap[type](page, items.length, result.total);
    }
    if (type === 'song' && items.length > 0 && _searchBatchMode) {
      if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'flex';
      updateBatchInfo();
    }
    return items;
  } catch (e) {
    clearLoading();
    showLoadError(errBrief(e));
    return [];
  }
}

// ── 主搜索入口 ───────────────────────────────────────
// ── 粘贴链接智能识别 ─────────────────────────────────
// doSearch 先走这里：输入是平台链接时直接拉歌/开歌单弹窗。
// 返回 true = 已接管本次输入（已渲染或已开弹窗），调用方不必再做关键词搜索；
// 返回 false = 未接管，按普通关键词继续。
// 早前用模块级 _linkHandled 传递这个结果，但剪贴板识别条（clipboard.js:69）会
// 绕开 doSearch 直接调本函数，把标志留在 true —— 用户下一次搜索会被 doSearch 里
// 那句 `if (_linkHandled) return` 静默吞掉（点搜索没反应，再点一次才行）。
// 改成返回值即无悬挂状态。
/**
 * @param {string} text 输入原文（可能是分享文案，链接夹在其中）
 * @param {number} [reqId] 本次识别所属的请求序号：doSearch 传入自己发起时占的号
 *   （同一次搜索共用一个号），独立调用（剪贴板识别条）则自动占新号。
 */
async function handleLinkInput(text, reqId = ++_typeSearchReqId) {
  let r;
  try {
    r = await api.getSongByLink(text);
  } catch (e) {
    logger.warn('[linkInput] 识别请求失败:', e);
    return false; // 网络失败按普通关键词继续搜索
  }
  // 迟到的识别结果：期间已发起更新的搜索，本次既不渲染也不接管输入
  if (reqId !== _typeSearchReqId) return false;
  if (!r || !r.matched) {
    // 平台短链无法本地解析：给出明确指引，同样回退普通搜索
    if (r && r.shortLink) {
      showToast(t('toast.linkShort'), 'info', 4000);
    }
    return false;
  }

  // 单曲：直接渲染进搜索结果列表（复用现有单曲卡片，播放/下载/加队列全可用）
  if (r.song) {
    addSearchHistory(r.song.title + ' - ' + r.song.artist);
    setState('currentKeyword', r.song.title);
    setState('songs', [r.song]);
    setState('selectedSongs', new Set());
    if (_dom.songList) _dom.songList.innerHTML = '';
    if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
    if (_dom.pagination) _dom.pagination.style.display = 'none';
    renderSongList([r.song]);
    showToast(t('toast.linkRecognized', { source: srcLabel(r.song.source), title: r.song.title }), 'success', 3000);
    return true;
  }

  // 专辑/歌单链接：解析出 { type, id }，复用歌单弹窗展示曲目
  const link = r.link || {};
  if (link.type === 'album' || link.type === 'playlist') {
    // 歌单链接 → openPlaylistModal 内部走 getPlaylistSongs（歌单接口）
    // 专辑链接 → 同弹窗但走 getAlbumSongs（专辑接口；两者的后端 API 不同）
    if (link.type === 'playlist' && link.platform === 'netease') {
      openPlaylistModal('netease', link.id, '网易云歌单');
      return true;
    }
    if (link.type === 'album') {
      openAlbumSongsModal(link.platform, link.id);
      return true;
    }
    showToast(t('toast.linkUnsupported'), 'warn', 3000);
    return false; // 回退普通搜索
  }

  // matched 但既无 song 又非专辑/歌单（拉详情失败）
  if (r.error) {
    showToast(t('toast.linkFailed', { msg: r.error }), 'error', 4000);
  }
  return false; // 回退普通搜索，用户至少还能搜歌名
}

/**
 * 专辑链接 → 歌单弹窗（走 getAlbumSongs；与 openPlaylistModal 的区别只在拉曲目的接口）
 */
async function openAlbumSongsModal(platform, albumId) {
  const nameMap = { netease: '网易云专辑', qq: 'QQ音乐专辑', kugou: '酷狗专辑', bilibili: 'B站合集' };
  document.getElementById('playlistModalTitle').textContent = '📀 ' + (nameMap[platform] || '专辑');
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  const hint = listAccessFor(platform, 'albumSongs', 'modal.subjectAlbum', '专辑');
  if (!hint.fetch) {
    showListEmpty(body, hint.text);
    return;
  }
  body.innerHTML = skeletonHtml('song', SKEL_ROWS, '加载中...');
  state.setPlaylistSongs([]);
  state.setPlaylistChecked(new Set());
  try {
    const songs = await api.getAlbumSongs(platform, albumId, 200);
    if (!songs.length) {
      showListEmpty(body, hint.text);
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:16px;text-align:center;">加载失败: ' + esc(errBrief(e)) + '</div>';
  }
}

async function doSearch(page = 1) {
  const keyword = _dom.searchInput?.value?.trim();
  if (!keyword) { showToast('请输入搜索关键词', 'error'); return; }

  if (!checkAPI()) {
    clearLoading();
    showLoadError('音乐API未加载，请刷新重试');
    showToast('音乐API未加载，请刷新重试', 'error', 3000);
    return;
  }

  // 发起即占号，并把同一个号交给链接识别与类型搜索（同一次搜索共用一个序号）。
  // 若等 handleLinkInput 返回后再占号，并发的两次搜索就会由「谁先返回」决定谁赢：
  // 先发起的那次若后返回，会用陈旧结果覆盖新视图（输入框是新词、列表是旧词）。
  const reqId = ++_typeSearchReqId;
  // 发起即出骨架：链接识别本身也是一次网络往返（getSongByLink），
  // 占位若写在 await 之后，粘贴链接搜索的整个等待期间界面毫无反应。
  // 先记下旧内容：骨架写进去之后，若链接改由弹窗展示（专辑/歌单链接），
  // 列表区不会再有新内容——不撤掉提前写下的骨架，弹窗一关就停在假加载中。
  const prevHtml = _dom.songList ? _dom.songList.innerHTML : '';
  const skelHtml = skeletonHtml(_searchType, SKEL_ROWS, '搜索中...');
  if (_dom.songList) _dom.songList.innerHTML = skelHtml;
  // 粘贴链接智能识别：输入是平台链接（含分享文案）→ 直接拉歌，不走关键词搜索
  // 必须 await：handleLinkInput 首个语句就是网络请求，同步读返回值恒 false
  if (await handleLinkInput(keyword, reqId)) {
    // 只在列表仍是本次骨架时还原——单曲链接分支会自己写列表，不能覆盖
    if (_dom.songList && _dom.songList.innerHTML === skelHtml) _dom.songList.innerHTML = prevHtml;
    return;
  }
  // 识别未接管，但期间已有更新的搜索发起 → 本次整体作废，不做关键词搜索
  if (reqId !== _typeSearchReqId) return;

  addSearchHistory(keyword);
  setState('currentKeyword', keyword);
  setState('currentPage', page);
  setState('selectedSongs', new Set());
  // 新搜索时退出批量选择模式
  if (_searchBatchMode) exitSearchBatchMode();
  hideSearchHistory();

  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';

  doSearchByType(_searchType, page, keyword, getState('currentSource'), reqId);
}

// ── AI 自然语言搜索（P0-A）────────────────────────────
// 输入是口语需求（"适合夜跑的中文摇滚"）时点这个：LLM 改写成 1~3 个
// 关键词并行聚合搜索，结果合并去重后直接渲染歌曲列表（无分页）。
async function doNaturalSearch() {
  const keyword = _dom.searchInput?.value?.trim();
  if (!keyword) { showToast('请输入搜索需求', 'error'); return; }

  if (!checkAPI()) {
    clearLoading();
    showLoadError('音乐API未加载，请刷新重试');
    showToast('音乐API未加载，请刷新重试', 'error', 3000);
    return;
  }

  addSearchHistory(keyword);
  setState('currentKeyword', keyword);
  setState('selectedSongs', new Set());
  if (_searchBatchMode) exitSearchBatchMode();
  hideSearchHistory();

  if (_dom.songList) {
    _dom.songList.innerHTML = skeletonHtml('song', SKEL_ROWS, 'AI 理解中，正在聚合搜索...');
  }
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';

  // AI 搜索同样是一次单曲搜索：必须占请求序号 + 声明视图类型。
  // 不占号 → 在途的普通搜索返回时序号仍相等，会把 AI 结果覆盖掉（:489 是同一守卫）；
  // 不声明 → _hideDownloaded 过滤与「播放全部」的 _searchType === 'song' 判断都不生效。
  const reqId = ++_typeSearchReqId;
  _searchType = 'song';
  _syncSearchTypeTabs();
  try {
    const r = await api.nlSearchMusic(keyword);
    if (reqId !== _typeSearchReqId) return; // 迟到的旧结果直接丢弃，不覆盖更新的视图
    if (r && r.error) {
      clearLoading();
      showLoadError(r.error);
      showToast('AI 搜索：' + r.error, 'warn', 4000);
      return;
    }
    const songs = (r && r.songs) || [];
    setState('songs', songs);
    renderSongList(songs);
    const qs = (r && r.queries) || [];
    if (qs.length > 1 || (qs.length === 1 && qs[0] !== keyword)) {
      showToast('AI 关键词：' + qs.join('、'), 'success', 4000);
    }
  } catch (e) {
    clearLoading();
    showLoadError(errBrief(e));
  }
}

// ── 歌手渲染 ─────────────────────────────────────────
function renderSingerList(list) {
  // 非单曲视图：清空徽标重绘锚点。否则队列/屏蔽变化（:171/:179/:888/:893）会把
  // 本列表盖成上次的单曲搜索结果——四处重绘入口只判 `if (_dlLastList)`，不判视图类型。
  _dlLastList = null;
  const el = document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关歌手</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  el.innerHTML = list.map(s => `
    <div class="singer-row" ondblclick="openSingerDetail('${escQ(s.mid)}', '${escQ(s.name)}', '${escQ(s.source)}')">
      ${s.avatar
        ? `<img class="singer-avatar" src="${escAttr(s.avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="singer-avatar-ph" ${s.avatar ? 'style="display:none"' : ''}>🎤</div>
      <div class="singer-info">
        <div class="singer-name">${esc(s.name)}</div>
        <div class="singer-meta">歌曲 ${s.songCount || 0} · 专辑 ${s.albumCount || 0} · MV ${s.mvCount || 0}</div>
      </div>
      <div class="singer-actions">
        <button class="action-btn" title="查看详情" onclick="openSingerDetail('${escQ(s.mid)}', '${escQ(s.name)}', '${escQ(s.source)}')">📋</button>
      </div>
    </div>
  `).join('');
}

function renderSingerPagination(page, count, total) {
  const pg = document.getElementById('pagination');
  const hasMore = count >= 20 || page * 20 < total;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 专辑渲染 ─────────────────────────────────────────
/**
 * @param {Array} list 专辑数组
 * @param {HTMLElement|null} [targetEl] 渲染目标。默认 #songList；歌手详情内嵌时
 *   传 #singerDetailContent —— 否则会把详情页的头部/页签一起 innerHTML 掉。
 */
function renderAlbumList(list, targetEl = null) {
  _dlLastList = null; // 非单曲视图：同上，防止被陈旧单曲列表覆盖
  const el = targetEl || document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关专辑</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  el.innerHTML = list.map(a => `
    <div class="album-row" ondblclick="openAlbumDetail('${escQ(a.mid)}', '${escQ(a.source)}')">
      ${a.cover
        ? `<img class="album-cover" src="${escAttr(a.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-cover-ph" ${a.cover ? 'style="display:none"' : ''}>💿</div>
      <div class="album-info">
        <div class="album-title">${esc(a.title)}</div>
        <div class="album-meta">${esc(a.artist)}${a.songCount ? ' · ' + a.songCount + ' 首' : ''}${a.publishTime ? ' · ' + a.publishTime : ''}</div>
      </div>
      <div class="album-actions">
        <button class="action-btn" title="查看详情" onclick="openAlbumDetail('${escQ(a.mid)}', '${escQ(a.source)}')">📋</button>
        <button class="action-btn" title="下载整张专辑" onclick="downloadAlbum('${escQ(a.mid)}', '${escQ(a.source)}')">⬇</button>
      </div>
    </div>
  `).join('');
}

function renderAlbumPagination(page, count, total) {
  const pg = document.getElementById('pagination');
  const hasMore = count >= 20 || page * 20 < total;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 专辑翻页（复用 doSearch）──────────────────────────
// pagination onclick 已统一用 doSearch(x)

// ── 打开专辑详情 ─────────────────────────────────────
async function openAlbumDetail(albumMid, source) {
  const el = document.getElementById('songList');
  el.innerHTML = skeletonHtml('song', SKEL_ROWS, '加载专辑中...');
  // 与搜索共享请求序号域：迟到的旧专辑结果不得覆盖更新的视图（连点两张专辑时）
  const reqId = ++_typeSearchReqId;
  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 999);
    if (reqId !== _typeSearchReqId) return;
    setState('songs', songs);
    _searchType = 'song';
    renderSongList(songs);
    document.getElementById('pagination').style.display = 'none';
    document.getElementById('batchToolbar').style.display = (songs.length && _searchBatchMode) ? 'flex' : 'none';
    showToast(`专辑共 ${songs.length} 首`, 'info', 2000);
  } catch (e) {
    clearLoading();
    showLoadError(errBrief(e));
  }
}

async function downloadAlbum(albumMid, source) {
  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 999);
    if (!songs.length) { showToast('专辑无歌曲', 'warn'); return; }
    // 整张专辑同源，取首首的 source 解析
    const quality = resolveQuality((songs[0] && songs[0].source) || source || 'qq');
    const saveDir = getState('saveDir');
    let queued = 0, dlSkipped = 0;
    for (const s of songs) {
      const existing = (state.get('queueSnapshot') || []).find(q =>
        q.id === s.id && q.source === s.source && q.status !== 'done');
      if (existing) continue;
      // 批量场景：历史已下载且文件还在 → 静默跳过（add-to-queue 返回 alreadyDownloaded）
      const r = await api.addToQueue({ ...s, saveDir, quality });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    }
    let msg = `专辑 ${queued} 首已加入下载队列`;
    if (dlSkipped) msg += `，跳过 ${dlSkipped} 首已下载过`;
    showToast(msg, 'success');
  } catch (e) {
    showToast('下载专辑失败: ' + errBrief(e), 'error');
  }
}

// ── 歌手详情 ─────────────────────────────────────────
let _singerDetailTab = 'songs'; // 'songs' | 'albums'

async function openSingerDetail(singerMid, singerName, source) {
  _dlLastList = null; // 歌手详情外壳（头部+页签）也是非单曲视图
  const el = document.getElementById('songList');
  el.innerHTML = `
    <div class="singer-detail-header">
      <button class="back-btn" onclick="backToSearch()">← 返回</button>
      <span class="singer-detail-name">${esc(singerName)}</span>
      <button class="btn-sm" style="margin-left:auto;" title="新歌发布时提醒我" onclick="subscribeCurrentSinger()">📡 订阅</button>
    </div>
    <div class="singer-detail-tabs">
      <button class="tab ${_singerDetailTab === 'songs' ? 'active' : ''}" onclick="switchSingerTab('songs', this)">热门歌曲</button>
      <button class="tab ${_singerDetailTab === 'albums' ? 'active' : ''}" onclick="switchSingerTab('albums', this)">全部专辑</button>
    </div>
    <div id="singerDetailContent">${skeletonHtml('song', SKEL_ROWS, '加载中...')}</div>
  `;
  state.set('currentSinger', { mid: singerMid, source: source || 'qq' });
  try {
    await loadSingerDetail(singerMid, _singerDetailTab);
  } catch (e) {
    clearLoading();
    showLoadError(errBrief(e));
  }
}

async function switchSingerTab(tab, btn) {
  try {
    _singerDetailTab = tab;
    document.querySelectorAll('.singer-detail-tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const singer = state.get('currentSinger');
    if (singer) await loadSingerDetail(singer.mid, tab);
  } catch (e) {
    logger.error(`[switchSingerTab] error:`, e);
  }
}

async function loadSingerDetail(singerMid, tab) {
  // 详情页头部/页签与 #singerDetailContent 同在 #songList 内（见 openSingerDetail）。
  // 列表必须渲染进 #singerDetailContent，**不能**渲染进 #songList ——
  // 后者会把头部（返回/订阅）与页签一起 innerHTML 掉，用户被卡在详情页里出不来，
  // switchSingerTab 也随之不可达。
  const el = document.getElementById('singerDetailContent');
  el.innerHTML = skeletonHtml(tab === 'songs' ? 'song' : 'album', SKEL_ROWS, '加载中...');
  const singer = state.get('currentSinger');
  const source = singer ? singer.source : 'qq';
  // 与搜索共享请求序号域：快速连点歌手/切页签时，迟到的旧结果不得覆盖新视图
  const reqId = ++_typeSearchReqId;
  try {
    if (tab === 'songs') {
      const songs = await api.getSingerSongs(singerMid, 50);
      if (reqId !== _typeSearchReqId) return;
      setState('songs', songs);
      _searchType = 'song';
      renderSongList(songs, el);
      document.getElementById('batchToolbar').style.display = (songs.length && _searchBatchMode) ? 'flex' : 'none';
      updateBatchInfo();
    } else {
      const result = await api.getSingerAlbums(singerMid, source, 1, 99);
      if (reqId !== _typeSearchReqId) return;
      const albums = (result && result.albums) || [];
      setState('albums', albums);
      renderAlbumList(albums, el);
      document.getElementById('batchToolbar').style.display = 'none';
    }
  } catch (e) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-text">加载失败</div>
      <div class="empty-hint">${esc(errBrief(e))}</div>
    </div>`;
  }
}

function backToSearch() {
  _dlLastList = null; // 退出歌手/专辑视图：锚点失效（有 kw 时 doSearch→renderSingerList 会再清一次）
  const kw = getState('currentKeyword');
  if (kw) {
    _searchType = 'singer';
    doSearch(1);
  } else {
    document.getElementById('songList').innerHTML = '';
  }
}

// ── 单曲渲染 ─────────────────────────────────────────
// 下载状态徽标：记住当前列表，队列/历史变化时防抖重渲染（300ms 合并突发）
let _dlLastList = null;
let _dlRerenderTimer = null;
addDlChangeListener(() => {
  if (_dlRerenderTimer || !_dlLastList) return;
  _dlRerenderTimer = setTimeout(() => {
    _dlRerenderTimer = null;
    if (_dlLastList) renderSongList(_dlLastList);
  }, 300);
});

// 屏蔽列表变化（启动预取完成/屏蔽/恢复）→ 当前结果视图即时重渲染
onDismissChanged(() => { if (_dlLastList) renderSongList(_dlLastList); });

/**
 * @param {Array} list 单曲数组
 * @param {HTMLElement|null} [targetEl] 渲染目标。默认 #songList；歌手详情内嵌时
 *   传 #singerDetailContent（见 loadSingerDetail）。
 */
function renderSongList(list, targetEl = null) {
  // 徽标重绘锚点只在「渲染到默认容器」时设置：四处重绘入口（:171/:179/:936/:941）
  // 一律按默认容器重绘，若内嵌列表也设锚点，一次队列变化就会把详情页头部/页签
  // 连壳一起 innerHTML 掉（就是本函数 targetEl 参数要解决的问题）。
  if (targetEl) _dlLastList = null;
  else _dlLastList = list;
  if (list !== _lastRenderedSongList) _rowIdx = -1; // 新结果集：行焦点归零；徽标重绘保持
  _lastRenderedSongList = list;
  dlEnsureHistoryLoaded(); // 首次渲染后拉一次下载历史，到达时自动重打徽标
  const _dlQueue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  const el = targetEl || document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关歌曲</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  // 批量模式下保持 batch-mode class
  if (_searchBatchMode) {
    el.classList.add('batch-mode');
  } else {
    el.classList.remove('batch-mode');
  }
  // 「隐藏已下载」：过滤掉徽标已是 done 的行；行内 onclick 全部用原始索引，
  // 可见行 → 原始索引的映射存 _visibleIdxMap 供键盘导航回查
  let pairs = list.map((s, i) => [s, i]);
  let hiddenCount = 0;
  if (_hideDownloaded && _searchType === 'song') {
    const kept = pairs.filter(([s]) => dlStatusFor(s, _dlQueue) !== 'done');
    hiddenCount = pairs.length - kept.length;
    pairs = kept;
  }
  let dismHidden = 0;
  [pairs, dismHidden] = filterDismissedPairs(pairs, dismissedKeySet()); // 「不感兴趣」屏蔽
  pairs = sortPairs(pairs, _searchSortMode); // 先过滤后排序，stable 排序保留组内原序
  _visibleIdxMap = pairs.map(p => p[1]);
  if (!pairs.length && hiddenCount) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✔</div>
      <div class="empty-text">本页 ${hiddenCount} 首都已下载</div>
      <div class="empty-hint"><button class="btn-sm" onclick="toggleHideDownloaded()">取消隐藏</button></div>
    </div>`;
    return;
  }
  if (!pairs.length && dismHidden) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🚫</div>
      <div class="empty-text">本页 ${dismHidden} 首已被屏蔽（不感兴趣）</div>
      <div class="empty-hint"><button class="btn-sm" onclick="showDismissedManager()">查看屏蔽管理</button></div>
    </div>`;
    return;
  }
  const selected = getState('selectedSongs') || new Set();
  const _kw = getState('currentKeyword') || ''; // 关键词高亮：只按已提交的搜索词
  el.innerHTML = pairs.map(([s, i]) => {
    const checked = selected.has(i) ? 'checked' : '';
    return `
    <div class="song-row" data-skey="${escAttr(s.source + ':' + s.id)}" ondblclick="playSong(${i})">
      <input type="checkbox" class="song-checkbox" data-idx="${i}" ${checked}
        onchange="toggleSongSelect(${i}, this.checked)">
      ${s.cover
        ? `<img class="song-cover" src="${escAttr(s.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="song-cover-ph" ${s.cover ? 'style="display:none"' : ''}>🎵</div>
      <div class="song-info">
        <div class="song-title">${markTerm(s.title, _kw)}</div>
        <div class="song-meta">${markTerm(s.artist, _kw)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      <span class="song-duration">${fmtDuration(s.duration)}</span>
      <span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>
      ${dlBadgeHtml(s, _dlQueue)}
      <div class="song-actions">
        ${heartBtnHtml(s)}
        <button class="action-btn" title="试听" onclick="playSong(${i})">▶</button>
        <button class="action-btn download-btn" title="下载" onclick="addDownload(${i})">⬇</button>
      </div>
    </div>
  `}).join('');
  _markRowActive(_songRows()); // 重绘后恢复行焦点（徽标防抖重渲染不丢高亮）
  _markPlayingRows();
  // 跨平台同名分组横幅（songGroups.js；非聚合模式内部自行短路）
  if (typeof window.updateSongGroupsBar === 'function') window.updateSongGroupsBar(list);
}

// ── 正在播放行高亮（.song-row.playing 现成样式）──────────
function _markPlayingRows() {
  const cp = getState('currentPlaying');
  const key = cp && cp.id != null ? String(cp.source) + ':' + String(cp.id) : null;
  _songRows().forEach(r => r.classList.toggle('playing', !!key && r.getAttribute('data-skey') === key));
}
// audio 的 play 事件不冒泡但可捕获；换曲/续播都会经过它，无需各处埋点
document.addEventListener('play', () => { try { _markPlayingRows(); } catch (_e) { /* 列表不在搜索页时忽略 */ } }, true);

// ── 行右键菜单（业务项在 ../songMenu.js 共享）──────────
function songListContext(e) {
  const list = _dom.songList;
  const row = e.target && e.target.closest ? e.target.closest('.song-row') : null;
  if (!list || !row || !list.contains(row)) return;
  const pos = _songRows().indexOf(row);
  const orig = _visibleIdxMap[pos] != null ? _visibleIdxMap[pos] : pos;
  const s = (getState('songs') || [])[orig];
  if (!s) return;
  openSongRowMenu(e, s, { play: () => playSong(orig), download: () => addDownload(orig), downloadQuality: (q) => addDownload(orig, q) });
}
document.addEventListener('contextmenu', songListContext);

function renderPagination(page, count) {
  const pg = document.getElementById('pagination');
  if (count < 10) { pg.style.display = 'none'; return; }
  const hasMore = count >= 20;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 批量选择 ─────────────────────────────────────────
function toggleSongSelect(idx, checked) {
  const selected = getState('selectedSongs') || new Set();
  if (checked) selected.add(idx);
  else selected.delete(idx);
  setState('selectedSongs', selected);
  updateBatchInfo();
}

function toggleSelectAllSongs(checked) {
  const songs = getState('songs');
  const selected = new Set();
  if (checked) { for (let i = 0; i < songs.length; i++) selected.add(i); }
  setState('selectedSongs', selected);
  document.querySelectorAll('.song-checkbox').forEach(cb => { cb.checked = checked; });
  updateBatchInfo();
}

function updateBatchInfo() {
  const selected = getState('selectedSongs') || new Set();
  document.getElementById('batchInfo').textContent = `已选 ${selected.size} 首`;
  const allCheck = document.getElementById('selectAllSongs');
  if (allCheck) {
    const songs = getState('songs');
    allCheck.checked = songs.length > 0 && selected.size === songs.length;
  }
}

// ── 批量操作 ─────────────────────────────────────────
async function batchDownload() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs');
  if (!selected.size) { showToast('请先勾选要下载的歌曲', 'warn'); return; }

  const toAdd = Array.from(selected).map(i => songs[i]).filter(Boolean);
  const saveDir = getState('saveDir');
  let queued = 0, skipped = 0, dlSkipped = 0;
  const total = toAdd.length;

  // 显示进度条
  const progressWrap = document.getElementById('batchProgressWrap');
  const progressFill = document.getElementById('batchProgressFill');
  const progressText = document.getElementById('batchProgressText');
  const progressLabel = document.getElementById('batchProgressLabel');
  if (progressWrap) {
    progressWrap.style.display = 'flex';
    if (progressLabel) progressLabel.textContent = '正在加入下载队列...';
  }

  for (let i = 0; i < toAdd.length; i++) {
    const s = toAdd[i];
    const existing = (state.get('queueSnapshot') || []).find(q =>
      q.id === s.id && q.source === s.source && q.status !== 'done');
    if (existing) { skipped++; } else {
      try {
        // 批量场景：历史已下载且文件还在 → 主进程静默跳过，这里只计数
        const r = await api.addToQueue({ ...s, saveDir, quality: resolveQuality(s.source) });
        if (r && r.queued) queued++;
        else if (r && r.alreadyDownloaded) dlSkipped++;
      } catch (e) { logger.warn('加入队列失败:', s.title, e.message); }
    }
    // 更新进度
    const pct = Math.round(((i + 1) / total) * 100);
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressText) progressText.textContent = `${i + 1}/${total}`;
  }

  // 完成后隐藏进度条
  if (progressWrap) {
    if (progressLabel) progressLabel.textContent = `完成！已加入 ${queued} 首`;
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  }

  showToast(`已加入 ${queued} 首${skipped ? `（跳过 ${skipped} 首已在队列）` : ''}${dlSkipped ? `（跳过 ${dlSkipped} 首已下载过）` : ''}`, 'success');
  // 批量下载后退出选择模式
  exitSearchBatchMode();
}

function batchPlay() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs');
  if (!selected.size) { showToast('请先勾选要播放的歌曲', 'warn'); return; }

  const indices = Array.from(selected).sort((a, b) => a - b);
  const playList = indices.map(i => songs[i]).filter(Boolean);
  if (!playList.length) return;

  setState('playQueue', playList);
  setState('playIdx', 0);
  // 传入勾选列表：不带队列参数时 playSong 会把 playQueue 覆盖成整页结果（M9）
  playSong(0, playList);
  showToast(`▶ 将播放 ${playList.length} 首歌曲`, 'info', 2000);
}

/** 批量：追加到播放队列尾部（不切换当前播放） */
function batchAddToQueue() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs') || [];
  if (!selected.size) { showToast('请先勾选歌曲', 'warn'); return; }
  const picks = Array.from(selected).sort((a, b) => a - b).map(i => songs[i]).filter(Boolean);
  if (!picks.length) return;
  setState('playQueue', (getState('playQueue') || []).concat(picks));
  showToast(`➕ 已加入播放队列 ${picks.length} 首`, 'success');
}

/** 批量：加入用户歌单（复用歌单选择弹层，quickAddToPlaylist 已支持数组） */
function batchAddToPlaylist() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs') || [];
  const picks = Array.from(selected).sort((a, b) => a - b).map(i => songs[i]).filter(Boolean);
  if (!picks.length) { showToast('请先勾选歌曲', 'warn'); return; }
  window.quickAddToPlaylist(picks);
}

/**
 * 批量：♥ 收藏勾选的歌。红心是 toggle 语义，先经 planBatchFav
 * 剔除已收藏的再逐首走单曲切换链（silent 聚合播报，零新通道）。
 */
async function batchFavorite() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs') || [];
  const picks = Array.from(selected).sort((a, b) => a - b).map(i => songs[i]).filter(Boolean);
  if (!picks.length) { showToast('请先勾选要收藏的歌曲', 'warn'); return; }
  const { toFav, already } = planBatchFav(picks, getState('favoriteKeys') || new Set(), s => favKey(s.source, s.id));
  if (!toFav.length) { showToast(`♥ ${already} 首都已在收藏夹`, 'info', 2200); return; }
  let ok = 0, failed = 0;
  for (const s of toFav) {
    registerFavSong(s);
    if (await toggleFavoriteByKey(favKey(s.source, s.id), true)) ok++;
    else failed++;
  }
  const fail = failed ? `，${failed} 首失败` : '';
  showToast(`♥ 已收藏 ${ok} 首${favSkipSuffix(already)}${fail}`, ok ? 'success' : 'error');
}

// ── 单曲下载 ─────────────────────────────────────────
async function addDownload(idx, qualityOverride) {
  try {
    const songs = getState('songs');
    const s = songs[idx];
    if (!s) return;
    const existing = (state.get('queueSnapshot') || []).find(q =>
      q.id === s.id && q.source === s.source && q.status !== 'done');
    if (existing) { showToast(`「${s.title}」已在队列中`, 'warn', 2500); return; }
    // 单曲下载：按这首歌自身的平台解析音质；右键「以此音质下载」可显式覆盖
    const quality = qualityOverride || resolveQuality(s.source);
    const saveDir = getState('saveDir');
    const r = await api.addToQueue({ ...s, saveDir, quality });
    if (r && r.duplicated) { showToast(`「${s.title}」已在下载队列中`, 'warn', 2500); return; }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(s.title, r.finishedAt, () => {
        api.addToQueue({ ...s, saveDir, quality, forceRedownload: true })
          .then(() => showToast(`「${s.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入失败: ' + errBrief(e), 'error'));
      });
      return;
    }
    showToast(`「${s.title}」已加入下载队列`, 'success');
  } catch (e) {
    logger.warn(`[addDownload] error:`, e);
  }
}

// ── 播放 ─────────────────────────────────────────────
// 取流用智能接口（本源失败自动换源）；请求序号做竞态守卫，快速连点只认最后一次
let _searchPlayRequestId = 0;

async function playSong(idx, queueOverride = null) {
  const songs = queueOverride || getState('songs');
  const s = songs[idx];
  if (!s) { showToast('未找到歌曲', 'warn'); return; }
  const quality = resolveQuality(s.source);
  showToast(`正在准备音源：${s.title}`, 'info');
  const reqId = ++_searchPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(s, quality);
    if (reqId !== _searchPlayRequestId) return; // 已点别的歌，丢弃过期结果
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast('⚠️ 该歌曲为 VIP 专享，请登录后重试', 'warn', 5000);
      } else {
        showToast('⚠️ 暂无法获取音源，请稍后重试', 'warn', 5000);
      }
      return;
    }
    s._playedQuality = quality;
    const notice = buildFallbackNotice(result, s.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      s._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.source || s.source;
    const referer = playReferer(playSource, result);
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _searchPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 5000);
      return;
    }
    // 设置播放队列：batchPlay 传入勾选列表时用它，否则整个搜索结果入队
    // （不回写 songs：取流期间用户可能已切源重搜，回写会把过期列表污染新结果）
    setState('playQueue', queueOverride || songs);
    setState('playIdx', idx);
    // 与 player.js playSongByIdx 一致：currentPlaying 驱动托盘/迷你播放器/播放器卡片，
    // 也是 audio error 守卫与 25s 加载超时守卫的前置条件，缺失会导致取流失败后静默卡死
    setState('currentPlaying', s);
    await loadAndPlay(s, proxied.fileUrl, true);
    showToast('▶ 正在播放：' + s.title, 'success', 2500);
  } catch (e) {
    if (reqId === _searchPlayRequestId) {
      logger.warn('播放失败:', e);
      showToast('⚠️ 播放失败：' + errBrief(e), 'error', 4000);
    }
  }
}

// ── 播放全部 ─────────────────────────────────────────
/** 整页单曲结果进播放队列，从第一首起连播（复用 playSong 的换源/防串台全语义） */
async function playSearchAll() {
  if (_searchType !== 'song') { showToast('「播放全部」仅支持单曲结果', 'info'); return; }
  const songs = getState('songs') || [];
  if (!songs.length) { showToast('暂无结果可播放，请先搜索', 'warn'); return; }
  await playSong(0); // playSong 内 setState('playQueue', songs)，天然整列表连播
}

// ── 来源切换 ─────────────────────────────────────────
// 平台筛选已改为下拉框：选中态由 <select> 自身反映，这里只同步 state 后重搜
// （仅 HTML 内联 onclick 调用，经下方 window 桥接暴露，无模块导入方）
/**
 * 渲染「音源」下拉（v3）。
 *
 * 清单来自主进程 IPC get-platforms ← registry.toClientPayload()，
 * 而 registry 又由平台 manifest 自动发现 —— 平台事实只有一处定义。
 * 原先 index.html 里写死 8 个 <option>，是本工程最直白的"加平台要改渲染层"。
 *
 * ⚠️ 调用顺序：必须在 applyTranslations() **之前**。
 *    「全部」选项带 data-i18n，本函数重建 DOM 会让既有翻译失效，
 *    故由调用方在之后统一 applyTranslations()。
 *
 * @param {Array<{id:string,name:string,nameEn?:string}>} platforms
 */
function renderSourceSelect(platforms) {
  const sel = document.getElementById('sourceSelect');
  if (!sel) return;
  const list = Array.isArray(platforms) ? platforms : [];
  const keep = sel.value || 'all';

  sel.innerHTML = '<option value="all" data-i18n="search.all">全部</option>'
    + list.map(p => `<option value="${escAttr(p.id)}">${esc(platformName(p.id))}</option>`).join('');
  // 还原选中值；若原选中的源已不存在（平台被移除）则回落「全部」
  sel.value = list.some(p => p && p.id === keep) ? keep : 'all';
}

function switchSource(src) {
  setState('currentSource', src);
  if (getState('currentKeyword')) doSearch(1);
}

// ── 工具 ─────────────────────────────────────────────
// esc(), escQ(), srcLabel(), fmtDuration() 已由 utils.js 全局导出，此处不再重复定义

// ── 导出 ─────────────────────────────────────────────
window.doSearch = doSearch;
window.searchArtistSongs = searchArtistSongs;
window.doNaturalSearch = doNaturalSearch;
window.handleLinkInput = handleLinkInput;
window.openAlbumSongsModal = openAlbumSongsModal;
window.switchSearchType = switchSearchType;
window.renderSourceSelect = renderSourceSelect;
window.renderSongList = renderSongList;
window.renderAlbumList = renderAlbumList;
// ── ES Module 导出 ──────────────────────────────────────
export {
  renderPagination,
  addDownload,
  showSearchHistory,
  hideSearchHistory,
  clearSearchHistory,
  removeSearchHistory,
  toggleSongSelect,
  toggleSelectAllSongs,
  batchDownload,
  batchPlay,
  openAlbumDetail,
  downloadAlbum,
  playSong,
  openSingerDetail,
  switchSingerTab,
  backToSearch,
  debounceSearch,
  selectSuggestion,
  searchCleanup,
  enterSearchBatchMode,
  exitSearchBatchMode,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.renderPagination = renderPagination;
window.switchSource = switchSource;
window.addDownload = addDownload;
window.searchInputKey = searchInputKey;
window.searchListKey = searchListKey;
window.toggleHideDownloaded = toggleHideDownloaded;
window.cycleSearchSort = cycleSearchSort;
window.playSearchAll = playSearchAll;
window.showSearchHistory = showSearchHistory;
window.hideSearchHistory = hideSearchHistory;
window.clearSearchHistory = clearSearchHistory;
window.removeSearchHistory = removeSearchHistory;
window.toggleSongSelect = toggleSongSelect;
window.toggleSelectAllSongs = toggleSelectAllSongs;
window.batchDownload = batchDownload;
window.batchPlay = batchPlay;
window.batchAddToQueue = batchAddToQueue;
window.batchAddToPlaylist = batchAddToPlaylist;
window.batchFavorite = batchFavorite;
window.openAlbumDetail = openAlbumDetail;
window.downloadAlbum = downloadAlbum;
window.playSong = playSong;
window.openSingerDetail = openSingerDetail;
window.switchSingerTab = switchSingerTab;
window.backToSearch = backToSearch;
window.debounceSearch = debounceSearch;
window.selectSuggestion = selectSuggestion;
window.searchCleanup = searchCleanup;
window.handleLinkInput = handleLinkInput; // 剪贴板识别条复用同一链接处理流程
window.enterSearchBatchMode = enterSearchBatchMode;
window.exitSearchBatchMode = exitSearchBatchMode;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheDom();
