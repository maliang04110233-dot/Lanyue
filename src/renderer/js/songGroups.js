/**
 * MusicDL 渲染层 — 搜索结果跨平台同名分组
 *
 * 聚合搜索（音源=全部）时同一首歌会以多行重复出现，各平台时长/音质不同，
 * 用户要逐行比对。这里在列表顶部挂一条横幅：「n 首歌命中多平台同名」，
 * 点开分组弹层逐组对照，每行支持 试听/下载（按原始索引复用 playSong /
 * addDownload）与 🎯定位（滚动到原行并描边闪一下）。
 * 只读 state.songs，不改动列表渲染与索引对齐。纯函数导出供 node:test。
 */

// 转义取用：见 escapeFallback.js 的说明（旧的 `typeof esc === 'function' ? esc
// : (s => String(s))` 恒等降级会让远端歌名以原文进 innerHTML）。
import { escSafe, escQSafe } from './escapeFallback.js';

/** 归一化匹配 key：去括号附注（Live/翻唱等视为另一版本的粗过滤）、去标点空白、小写 */
export function normKey(title, artist) {
  const norm = (str) => String(str == null ? '' : str)
    .toLowerCase()
    .replace(/[（(【[][^）)】\x5D]*[）)】\x5D]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  return norm(title) + '|' + norm(artist);
}

/**
 * 跨平台同名分组：只保留覆盖了 ≥2 个不同平台的组。
 * items 存 {idx, source, id, title, artist, duration}，idx 为原始列表索引。
 * 排序：平台数降序，其次首次出现位置。
 */
export function groupSameSongs(songs) {
  const map = new Map();
  (songs || []).forEach((s, i) => {
    if (!s || s.id == null) return;
    const key = normKey(s.title, s.artist);
    if (key === '|') return;
    let g = map.get(key);
    if (!g) {
      g = { title: s.title, artist: s.artist, items: [], sources: new Set() };
      map.set(key, g);
    }
    const src = String(s.source || '');
    if (!g.sources.has(src)) {
      g.sources.add(src);
      g.items.push({ idx: i, source: src, id: s.id, title: s.title, artist: s.artist, duration: s.duration });
    }
  });
  return Array.from(map.values())
    .filter(g => g.sources.size >= 2)
    .sort((a, b) => (b.sources.size - a.sources.size) || (a.items[0].idx - b.items[0].idx));
}

let _groups = [];

function _srcName(src) {
  return typeof srcLabel === 'function' ? srcLabel(src) : src;
}
function _dur(sec) {
  return typeof fmtDuration === 'function' ? fmtDuration(sec) : (sec ? Math.round(sec) + 's' : '—');
}

function _bannerHtml(groups) {
  const n = groups.length;
  return `<div class="song-groups-bar" style="display:flex;align-items:center;gap:10px;padding:6px 10px;margin-bottom:6px;font-size:12px;color:var(--neon-cyan);background:color-mix(in srgb, var(--accent-ui) 6%, transparent);border:1px solid color-mix(in srgb, var(--accent-ui) 18%, transparent);border-radius:6px;">
    🔗 ${n} 首歌命中跨平台同名，多源可比价
    <button class="btn-sm" onclick="showSongGroupsModal()">查看分组</button>
  </div>`;
}

/**
 * 渲染弹层时按当前 state.songs 重解析下标：items 里的 idx 是构建期快照，
 * 搜索结果被替换/重排后旧下标会点 A 播 B。按 source+id 在当前结果里重找，
 * 找不到（如已过滤隐藏）才退回旧下标。
 */
function _resolveVariantIdx(it) {
  if (typeof getState !== 'function') return it.idx;
  const songs = getState('songs') || [];
  const i = songs.findIndex(s => s && s.source === it.source && String(s.id) === String(it.id));
  return i >= 0 ? i : it.idx;
}

function _rowHtml(g) {
  const variants = g.items.map(it => `
    <div class="sched-job" style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span class="source-badge" style="flex-shrink:0;">${escSafe(_srcName(it.source))}</span>
      <span style="flex:1;color:var(--text-dim,#8b93a7);">${_dur(it.duration)}</span>
      <button class="btn-sm" title="试听" onclick="playSong(${_resolveVariantIdx(it)})">▶</button>
      <button class="btn-sm" title="下载" onclick="addDownload(${_resolveVariantIdx(it)})">⬇</button>
      <button class="btn-sm" title="滚动到结果列表中的这一行" onclick="locateSongRow('${escQSafe(it.source)}','${escQSafe(it.id)}')">🎯</button>
    </div>`).join('');
  return `
    <div class="sched-job-lines" style="margin-bottom:10px;">
      <div class="sched-job" style="font-weight:600;">${esc_(g.title)} <span style="color:var(--text-dim,#8b93a7);font-weight:400;">${esc_(g.artist)} · ${g.sources.size} 源</span></div>
      ${variants}
    </div>`;
}

function _renderGroupsModal() {
  document.getElementById('songGroupsOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'edit-overlay';
  overlay.id = 'songGroupsOverlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', 'closeSongGroupsModal');
  overlay.innerHTML = `
    <div class="edit-panel">
      <div class="edit-header">
        <span class="edit-title">🔗 跨平台同名分组（${_groups.length} 组）</span>
        <span class="edit-close" onclick="closeSongGroupsModal()" data-ico="x" data-ico-only></span>
      </div>
      <div class="edit-body">${_groups.map(_rowHtml).join('') || '<div style="color:var(--text-dim,#8b93a7);">暂无分组</div>'}</div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSongGroupsModal(); });
  document.body.appendChild(overlay);
}

export function showModal() {
  if (!_groups.length) {
    if (typeof showToast === 'function') showToast('当前结果没有跨平台同名歌曲', 'info', 2000);
    return;
  }
  _renderGroupsModal();
}

/** 滚动到原行并描边闪 1.2s（行可能已被「隐藏已下载」过滤掉，静默即可） */
export function locateRow(source, id) {
  if (typeof document === 'undefined') return false;
  const row = document.querySelector(`.song-row[data-skey="${CSS.escape(String(source) + ':' + String(id))}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.style.outline = '2px solid var(--neon-cyan)';
  setTimeout(() => { row.style.outline = ''; }, 1200);
  return true;
}

/** renderSongList 尾部钩子：重算分组并在列表顶部挂/摘横幅 */
export function updateBar(list) {
  if (typeof document === 'undefined') return;
  const src = typeof getState === 'function' ? getState('currentSource') : 'all';
  const el = document.getElementById('songList');
  if (!el) return;
  _groups = (src === 'all' && Array.isArray(list)) ? groupSameSongs(list) : [];
  el.querySelector('.song-groups-bar')?.remove();
  if (_groups.length && el.firstElementChild) {
    el.insertAdjacentHTML('afterbegin', _bannerHtml(_groups));
  }
}

if (typeof document !== 'undefined') {
  window.updateSongGroupsBar = updateBar;
  window.showSongGroupsModal = showModal;
  window.closeSongGroupsModal = () => document.getElementById('songGroupsOverlay')?.remove();
  window.locateSongRow = locateRow;
}
