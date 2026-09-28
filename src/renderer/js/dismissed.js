/**
 * 搜索结果「不感兴趣」屏蔽
 *
 * 纯函数段 node 直测（不导入 state.js/logger.js，保持零依赖）；
 * DOM 段沿用 edit-overlay + createElement 模式管理已屏蔽列表。
 * 持久化走 prefs：api.setPref('dismissedSongs', [{key,title,artist}])。
 * 无 id 的歌用「标题|歌手」归一键，防抖：上限 MAX_DISMISSED 条。
 */

export const MAX_DISMISSED = 500;

/** 屏蔽键：优先 source:id（与收藏同款约定），退化 标题|歌手 归一键 */
export function dismissKey(song) {
  if (!song) return '';
  if (song.id != null && String(song.id) !== '') {
    return String(song.source || '') + ':' + String(song.id);
  }
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return 't:' + norm(song.title) + '|' + norm(song.artist);
}

/** 规整外部数据：非数组→[]，丢无 key 条目，截断上限 */
export function normalizeDismissed(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x.key === 'string' && x.key)
    .slice(0, MAX_DISMISSED)
    .map((x) => ({ key: x.key, title: String(x.title || ''), artist: String(x.artist || '') }));
}

/** 屏蔽一首歌：返回 true=新增成功，false=已存在（no-op） */
export function addDismiss(list, entry) {
  if (!entry || !entry.key) return false;
  if (list.some((x) => x.key === entry.key)) return false;
  return [entry, ...list].slice(0, MAX_DISMISSED);
}

export function removeDismiss(list, key) {
  return list.filter((x) => x.key !== key);
}

/**
 * @param {Array<[song, idx]>} pairs 搜索渲染管线 pairs（idx=原始下标）
 * @param {Set<string>} keySet
 * @returns {[Array, number]} 保留的 pairs + 被屏蔽条数
 */
export function filterDismissedPairs(pairs, keySet) {
  if (!(keySet && keySet.size)) return [Array.isArray(pairs) ? pairs : [], 0];
  const kept = (pairs || []).filter(([s]) => !keySet.has(dismissKey(s)));
  return [kept, (pairs || []).length - kept.length];
}

// ── 会话缓存 + 订阅（DOM/浏览器侧）────────────────────
let _list = [];
const _subs = new Set();

function _notify() { _subs.forEach((fn) => { try { fn(); } catch (_) { /* 单订阅者炸不影响其它 */ } }); }
function _persist() {
  try { if (typeof api !== 'undefined') api.setPref('dismissedSongs', _list); } catch (_) { /* 开发 mock 忽略 */ }
}

function _setKeys() { return new Set(_list.map((x) => x.key)); }

/** 当前屏蔽键集合（search.js 渲染管线用）；未加载完时为空集，加载后订阅重渲染兜底 */
export function dismissedKeySet() { return _setKeys(); }
export function dismissedList() { return _list.slice(); }
export function onDismissChanged(fn) { _subs.add(fn); return () => _subs.delete(fn); }

export function dismissSong(song) {
  const key = dismissKey(song);
  if (!key) { showToast('歌曲信息不足，无法屏蔽', 'warn'); return; }
  const next = addDismiss(_list, { key, title: String(song.title || ''), artist: String(song.artist || '') });
  if (next === false) { showToast('该歌曲已在屏蔽列表中', 'info', 2000); return; }
  _list = next;
  _persist();
  _notify();
  showToast(`已屏蔽「${song.title || '该歌曲'}」，可在「已屏蔽管理」恢复`, 'info', 3500);
}

export function restoreDismissed(key) {
  _list = removeDismiss(_list, key);
  _persist();
  _notify();
}

export function clearDismissed() {
  if (!_list.length) return;
  _list = [];
  _persist();
  _notify();
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _closeManager() {
  const el = document.getElementById('dismissedOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _renderManager() {
  _closeManager();
  const overlay = document.createElement('div');
  overlay.id = 'dismissedOverlay';
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeManager(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';
  panel.innerHTML = `
    <div class="edit-header">
      <span class="edit-title">🚫 已屏蔽管理 · ${_list.length} 首</span>
      <button class="edit-close" id="dismClose">✕</button>
    </div>
    <div class="edit-body" id="dismBody"></div>`;
  const body = panel.querySelector('#dismBody');
  if (!_list.length) {
    body.innerHTML = '<div style="text-align:center;padding:24px 0;opacity:.6;">暂无屏蔽记录——歌曲行右键「不感兴趣」即可屏蔽</div>';
  } else {
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:6px;">
        <button class="btn-sm" id="dismClearAll">🗑 清空全部</button>
      </div>` +
      _list.map((x, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.05);">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(x.title)}${x.artist ? ' - ' + _esc(x.artist) : ''}</span>
          <button class="btn-sm" data-restore="${i}">↩ 恢复</button>
        </div>`).join('');
    body.querySelector('#dismClearAll').addEventListener('click', () => {
      clearDismissed(); _renderManager();
    });
    body.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const x = _list[Number(btn.getAttribute('data-restore'))];
        if (x) restoreDismissed(x.key);
        _renderManager();
      });
    });
  }
  panel.querySelector('#dismClose').addEventListener('click', _closeManager);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

export function showDismissedManager() {
  if (typeof document === 'undefined') return;
  _renderManager();
}

// 启动预取 prefs（早于任何一次搜索渲染；完成即通知订阅者补一次重渲染）
if (typeof document !== 'undefined') {
  window.showDismissedManager = showDismissedManager;
  window.dismissSong = dismissSong;
  if (typeof api !== 'undefined' && api.getPref) {
    api.getPref('dismissedSongs').then((raw) => {
      _list = normalizeDismissed(raw);
      if (_list.length) _notify();
    }).catch(() => { /* 读不到 prefs 就当空列表 */ });
  }
}
