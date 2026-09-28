/**
 * 本地曲库「🗂 文件夹分组」
 *
 * 歌手/专辑分组把名称写进关键词过滤框，但过滤框只匹配 title/artist/album，
 * 路径永远进不去——文件夹视图需要独立的「当前文件夹」状态，在 filterLocalSongs
 * 管线最前端做路径级过滤。groupFolders/folderLabel 为纯函数（node 直测）；
 * 弹层沿用 artistGroups 的 edit-overlay + createElement 模式（无 innerHTML）。
 */

import { errBrief } from './errBrief.js';
import { groupBarPct, sanitizeFileBase } from './artistGroups.js';

export const UNKNOWN_FOLDER = '(未知位置)';
export const ROOT_FOLDER_LABEL = '(根目录)';

function _sep(p) { return String(p || '').replace(/\\/g, '/'); }

/** 所在目录（去掉尾部分隔符）；无分隔符或空路径返回 '' */
export function parentDirOf(filePath) {
  const p = _sep(filePath);
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  const d = p.slice(0, i);
  return d;
}

/** 展示名：优先相对曲库根目录；根内为空取 (根目录)；否则取 basename */
export function folderLabel(dir, rootDir) {
  const d = _sep(dir).replace(/\/+$/, '');
  if (!d) return UNKNOWN_FOLDER;
  const root = _sep(rootDir).replace(/\/+$/, '');
  if (root && d === root) return ROOT_FOLDER_LABEL;
  if (root && d.startsWith(root + '/')) return d.slice(root.length + 1);
  const i = d.lastIndexOf('/');
  return i < 0 ? d : d.slice(i + 1);
}

/**
 * @param {Array} songs 本地曲库歌曲（{filePath, fileSize} 宽松取数）
 * @param {string} [rootDir] 曲库根目录（仅影响展示名，不影响分组键）
 * @returns {Array<{dir:string,label:string,count:number,size:number}>} 数量降序、同数按 label zh 序
 */
export function groupFolders(songs, rootDir) {
  if (!Array.isArray(songs)) return [];
  const map = new Map();
  for (const s of songs) {
    if (!s) continue;
    const dir = parentDirOf(s.filePath);
    let g = map.get(dir);
    if (!g) { g = { dir, label: folderLabel(dir, rootDir), count: 0, size: 0 }; map.set(dir, g); }
    g.count++;
    g.size += +s.fileSize || 0;
  }
  const out = Array.from(map.values());
  out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));
  return out;
}

/** dir 为空/falsy = 不过滤（返回新数组）；否则父目录精确匹配 */
export function filterByFolder(songs, dir) {
  const arr = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!dir) return arr.slice();
  return arr.filter((s) => parentDirOf(s.filePath) === dir);
}

// 当前过滤中的文件夹（null=全部）；由弹层行点击设置
let _activeFolder = null;

export function setActiveFolder(dir) { _activeFolder = dir || null; }
export function getActiveFolder() { return _activeFolder; }

/** 过滤链统一入口：local.js 每轮 filterLocalSongs 都会调 */
export function applyFolderToSongs(songs) {
  if (!_activeFolder) return Array.isArray(songs) ? songs.slice() : [];
  return filterByFolder(songs, _activeFolder);
}

function _fmtBytes(n) {
  if (typeof formatBytes === 'function') return formatBytes(n);
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const PANEL_ID = 'folderOverlay';

function _closePanel() {
  const el = document.getElementById(PANEL_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _apply(dir) {
  setActiveFolder(dir);
  if (typeof window !== 'undefined' && typeof window.filterLocalSongs === 'function') {
    window.filterLocalSongs();
  }
  if (typeof window !== 'undefined' && typeof window.switchTab === 'function') {
    window.switchTab('local');
  }
  _closePanel();
}

async function _exportFolder(songs, label) {
  if (!songs || !songs.length) { showToast('该文件夹没有可导出的歌曲', 'warn'); return; }
  try {
    const r = await api.exportPlaylist({
      songs, format: 'm3u',
      name: 'MusicDL-' + sanitizeFileBase(label),
    });
    if (r && r.canceled) return;
    if (r && r.error) throw new Error(r.error);
    showToast(`已导出 ${songs.length} 首：${label}`, 'success', 2500);
  } catch (e) {
    showToast('导出失败：' + errBrief(e), 'error');
  }
}

function _renderPanel(groups, songs) {
  _closePanel();
  const overlay = document.createElement('div');
  overlay.id = PANEL_ID;
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closePanel(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  const totalSongs = groups.reduce((a, g) => a + g.count, 0);
  title.textContent = `🗂 文件夹分组 · ${groups.length} 组 / ${totalSongs} 首`;
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', () => _closePanel());
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;opacity:.6;margin-bottom:8px;';
  hint.textContent = '点击文件夹 = 只看该文件夹里的歌';
  body.appendChild(hint);

  if (_activeFolder) {
    const clear = document.createElement('div');
    clear.style.cssText = 'padding:6px 4px;margin-bottom:4px;cursor:pointer;border:1px dashed rgba(255,255,255,.25);border-radius:6px;font-size:12px;';
    clear.textContent = '🗂 全部文件夹（清除当前过滤）';
    clear.addEventListener('click', () => _apply(null));
    body.appendChild(clear);
  }

  const max = groups.reduce((a, g) => Math.max(a, g.count), 0);
  for (const g of groups) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);';
    row.title = `${g.dir || '(未知位置)'}\n只看此文件夹`;
    const name = document.createElement('span');
    name.style.cssText = 'flex:0 0 30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    name.textContent = g.label;
    if (_activeFolder === g.dir) name.textContent = '● ' + g.label;
    const barWrap = document.createElement('span');
    barWrap.style.cssText = 'flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden;';
    const bar = document.createElement('span');
    bar.style.cssText = `display:block;height:100%;width:${groupBarPct(g.count, max)}%;background:var(--accent, #4f8cff);border-radius:4px;`;
    barWrap.appendChild(bar);
    const meta = document.createElement('span');
    meta.style.cssText = 'flex:0 0 auto;font-size:11px;opacity:.75;white-space:nowrap;';
    meta.textContent = `${g.count} 首 · ${_fmtBytes(g.size)}`;
    const exp = document.createElement('button');
    exp.style.cssText = 'flex:0 0 auto;background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;opacity:.7;';
    exp.textContent = '⤴';
    exp.title = `导出「${g.label}」为 m3u 歌单文件`;
    exp.addEventListener('click', (e) => {
      e.stopPropagation();
      _exportFolder(songs.filter((s) => s && parentDirOf(s.filePath) === g.dir), g.label);
    });
    row.appendChild(name);
    row.appendChild(barWrap);
    row.appendChild(meta);
    row.appendChild(exp);
    row.addEventListener('click', () => _apply(g.dir));
    body.appendChild(row);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function showFolderGroups() {
  try {
    const songs = (typeof getState === 'function' && getState('localSongs')) || [];
    if (!songs.length) {
      showToast('本地曲库为空，先扫描曲库目录', 'warn', 2500);
      return;
    }
    const rootDir = (typeof getState === 'function' && getState('localDirPath')) || '';
    const groups = groupFolders(songs, rootDir);
    if (!groups.length) { showToast('暂无可分组的歌曲', 'info'); return; }
    _renderPanel(groups, songs);
  } catch (e) {
    showToast('文件夹分组失败：' + errBrief(e), 'error');
  }
}

if (typeof document !== 'undefined') {
  window.showFolderGroups = showFolderGroups;
  window.closeFolderGroups = () => _closePanel();
}
