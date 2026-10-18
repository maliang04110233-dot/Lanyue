/**
 * 搜索视图 —— 建议 / 搜索历史 / 输入框键盘
 *
 * 自 views/search.js 提出（等价迁移）：
 *   - 搜索建议（最近播放 + 搜索历史匹配，输入防抖时弹出）
 *   - 搜索历史（持久化到主进程 prefs.json，修复 B8）
 *   - 输入框键盘导航（↑/↓ 循环建议，Enter/Esc 补搜索/收起）与防抖
 *   - searchCleanup（切换页面时清定时器 + 收起浮层）
 *
 * cross 域依赖由 search.js 在 setupSearchSuggest 注入：_dom（DOM 缓存）与 doSearch。
 * esc/escQ/getRecentlyPlayed/showToast 等仍走 utils.js 的 window 全局（本仓现状）。
 */

import { logger } from '../../logger.js';

const MAX_HISTORY = 20;

// 注入（setupSearchSuggest）：doSearch 与 _dom 均 search.js 所有
const _deps = {
  doSearch: null,
  _dom: null,
};

export function setupSearchSuggest(deps) {
  _deps.doSearch = deps.doSearch;
  _deps._dom = deps._dom;
}

// ── 搜索防抖 ──────────────────────────────────────────
let _searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

function debounceSearch() {
  _kbdIdx = -1; // 用户重新输入，键盘建议循环归零
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    _searchDebounceTimer = null;
    const keyword = _deps._dom.searchInput?.value?.trim();
    if (keyword && keyword.length >= 2) {
      _deps.doSearch(1);
    }
    hideSearchSuggestions();
  }, SEARCH_DEBOUNCE_MS);
  // 显示搜索建议
  showSearchSuggestions();
}

// ── 搜索建议（基于最近播放 + 搜索历史）──────────────
function showSearchSuggestions() {
  const input = _deps._dom.searchInput;
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

// ── 输入框键盘导航 ───────────────────────────────────
// 输入框内：↑/↓ 循环当前可见的搜索建议/历史并回填输入框，Enter 搜索，Esc 收起并失焦
let _kbdIdx = -1;

function searchInputKey(e) {
  if (e.key === 'Enter') {
    hideSearchSuggestions();
    hideSearchHistory();
    _deps.doSearch();
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
    _deps._dom.searchInput.value = kws[_kbdIdx];
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

function selectSuggestion(keyword) {
  const input = _deps._dom.searchInput;
  if (input) {
    input.value = keyword;
    _deps.doSearch(1);
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
  if (_deps._dom.searchHistory) _deps._dom.searchHistory.style.display = 'none';
  showToast('搜索历史已清除', 'info');
}

function showSearchHistory() {
  getSearchHistory().then(history => {
    const el = _deps._dom.searchHistory;
    if (!el) return;
    if (!history.length) { el.style.display = 'none'; return; }

    const kw = _deps._dom.searchInput?.value?.trim()?.toLowerCase() || '';
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
    if (_deps._dom.searchHistory) _deps._dom.searchHistory.style.display = 'none';
  }, 200);
}

// fmtHistoryTime 已由 utils.js 全局导出

export {
  debounceSearch,
  selectSuggestion,
  searchInputKey,
  searchCleanup,
  addSearchHistory,
  showSearchHistory,
  hideSearchHistory,
  clearSearchHistory,
  removeSearchHistory,
  hideSearchSuggestions,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.debounceSearch = debounceSearch;
window.selectSuggestion = selectSuggestion;
window.searchInputKey = searchInputKey;
window.searchCleanup = searchCleanup;
window.showSearchHistory = showSearchHistory;
window.hideSearchHistory = hideSearchHistory;
window.clearSearchHistory = clearSearchHistory;
window.removeSearchHistory = removeSearchHistory;
