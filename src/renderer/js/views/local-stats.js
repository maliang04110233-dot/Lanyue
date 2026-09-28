/**
 * MusicDL 本地音乐库 — 音乐库统计 / 重复歌曲检测
 *
 * 自 views/local.js 拆出：只读 state.localSongs，不改选择状态。
 * 依赖全局：api、getState、setState、showToast、esc、confirm、document
 */

import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';

// 库变更回调由 local.js 注入（删重后需要重刷列表，避免循环 import）。
// 注入的是**过滤管线入口** filterLocalSongs（不是裸渲染器）：
// 它既会重套全部过滤轴与排序，也会按当前视图重绘网格或列表。
let _onLibraryChanged = () => {};

/** 由 local.js 在模块加载时注册 filterLocalSongs */
export function setLibraryChangeHandler(fn) {
  if (typeof fn === 'function') _onLibraryChanged = fn;
}

// ══════════════════════════════════════════════════════════
// 功能 2：音乐库统计
// ══════════════════════════════════════════════════════════

export function showLibraryStats() {
  const localSongs = getState('localSongs');
  if (!localSongs || !localSongs.length) {
    showToast('请先扫描本地曲库', 'warn');
    return;
  }

  // 计算统计数据
  const stats = {
    total: localSongs.length,
    totalSize: 0,
    totalDuration: 0,
    formatCount: {},
    artistCount: {},
    albumCount: {},
    hasCover: 0,
    hasLyrics: 0,
  };

  for (const s of localSongs) {
    // 文件大小
    stats.totalSize += s.fileSize || 0;
    // 时长
    stats.totalDuration += s.durationMs || 0;
    // 格式统计
    const ext = (s.ext || '').toLowerCase();
    stats.formatCount[ext] = (stats.formatCount[ext] || 0) + 1;
    // 艺术家统计
    if (s.artist) {
      stats.artistCount[s.artist] = (stats.artistCount[s.artist] || 0) + 1;
    }
    // 专辑统计
    if (s.album) {
      stats.albumCount[s.album] = (stats.albumCount[s.album] || 0) + 1;
    }
    // 封面/歌词
    if (s.cover) stats.hasCover++;
    if (s.embeddedLyrics) stats.hasLyrics++;
  }

  // 格式分布
  const formatList = Object.entries(stats.formatCount)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `<span class="stat-tag">${ext.toUpperCase()}: ${count}</span>`)
    .join('');

  // Top 艺术家
  const topArtists = Object.entries(stats.artistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `<span class="stat-item">${esc(name)} (${count})</span>`)
    .join('');

  // Top 专辑
  const topAlbums = Object.entries(stats.albumCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `<span class="stat-item">${esc(name)} (${count})</span>`)
    .join('');

  // 格式化时长
  const totalHours = Math.floor(stats.totalDuration / 3600000);
  const totalMinutes = Math.floor((stats.totalDuration % 3600000) / 60000);
  const durationStr = totalHours > 0 ? `${totalHours}小时${totalMinutes}分钟` : `${totalMinutes}分钟`;

  // 构建 HTML
  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">歌曲总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatBytes(stats.totalSize)}</div>
        <div class="stat-label">总大小</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${durationStr}</div>
        <div class="stat-label">总时长</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Object.keys(stats.artistCount).length}</div>
        <div class="stat-label">艺术家数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Object.keys(stats.albumCount).length}</div>
        <div class="stat-label">专辑数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.hasCover}/${stats.total}</div>
        <div class="stat-label">封面覆盖率</div>
      </div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">格式分布</div>
      <div class="stats-tags">${formatList}</div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Top 艺术家</div>
      <div class="stats-list">${topArtists || '<span class="stat-empty">暂无数据</span>'}</div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Top 专辑</div>
      <div class="stats-list">${topAlbums || '<span class="stat-empty">暂无数据</span>'}</div>
    </div>
  `;

  // 显示统计弹窗
  showStatsModal(html);
}

function showStatsModal(html) {
  let overlay = document.getElementById('statsModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'statsModal';
  overlay.className = 'stats-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel">
      <div class="stats-header">
        <span>📊 曲库统计</span>
        <button onclick="document.getElementById('statsModal').remove()">✕</button>
      </div>
      <div class="stats-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════════════
// 功能 3：重复歌曲检测 + 删除
// ══════════════════════════════════════════════════════════

// 重复歌曲状态
const _dupState = {
  groups: [],      // 重复组数据
  selected: new Set(), // 选中的文件路径
};

export function detectDuplicateSongs() {
  const localSongs = getState('localSongs');
  if (!localSongs || !localSongs.length) {
    showToast('请先扫描本地曲库', 'warn');
    return;
  }

  // 按 标题+艺术家 分组
  const groups = {};
  for (const s of localSongs) {
    const title = (s.title || '').toLowerCase().trim();
    const artist = (s.artist || '').toLowerCase().trim();
    if (!title) continue;
    const key = `${title}|||${artist}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  // 找出重复组
  const duplicates = Object.values(groups).filter(arr => arr.length > 1);
  _dupState.groups = duplicates;
  _dupState.selected.clear();

  if (!duplicates.length) {
    showToast('🎉 没有发现重复歌曲', 'success');
    return;
  }

  // 自动选中每组中"较差"的版本（优先保留无损 > 高品质 > 标准）
  const QUALITY_ORDER = { flac: 0, ape: 0, wav: 0, aac: 1, m4a: 1, mp3: 2, ogg: 2, wma: 3 };
  for (const group of duplicates) {
    // 按音质排序（好的在前）
    group.sort((a, b) => {
      const qa = QUALITY_ORDER[(a.ext || '').toLowerCase()] ?? 2;
      const qb = QUALITY_ORDER[(b.ext || '').toLowerCase()] ?? 2;
      if (qa !== qb) return qa - qb;
      // 音质相同，保留文件大的（通常码率更高）
      return (b.fileSize || 0) - (a.fileSize || 0);
    });
    // 选中除第一个以外的所有（保留最好的）
    for (let i = 1; i < group.length; i++) {
      _dupState.selected.add(group[i].filePath);
    }
  }

  renderDuplicateModal();
}

function renderDuplicateModal() {
  const { groups, selected } = _dupState;

  const groupsHtml = groups.map((group, _i) => {
    const songsHtml = group.map((s, j) => {
      const isSelected = selected.has(s.filePath);
      const isBest = j === 0;
      return `
        <div class="dup-song ${isSelected ? 'dup-selected' : ''} ${isBest ? 'dup-best' : ''}">
          <label class="dup-checkbox">
            <input type="checkbox" ${isSelected ? 'checked' : ''}
              onchange="toggleDupSelect('${escQ(s.filePath)}')">
          </label>
          <span class="dup-title">${esc(s.title || '未知')}</span>
          <span class="dup-artist">${esc(s.artist || '未知')}</span>
          <span class="dup-format">${(s.ext || '').toUpperCase()}</span>
          <span class="dup-size">${formatBytes(s.fileSize)}</span>
          ${isBest ? '<span class="dup-best-tag">保留</span>' : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="dup-group">
        <div class="dup-group-header">
          <span class="dup-group-title">${esc(group[0].title || '未知')}</span>
          <span class="dup-group-count">${group.length} 个版本</span>
        </div>
        <div class="dup-songs">${songsHtml}</div>
      </div>
    `;
  }).join('');

  const html = `
    <div class="stats-summary">
      发现 <strong>${groups.length}</strong> 组重复歌曲，已选中 <strong>${selected.size}</strong> 个待删除
    </div>
    <div class="dup-actions">
      <button class="dup-action-btn" onclick="selectAllDups()">全选</button>
      <button class="dup-action-btn" onclick="deselectAllDups()">取消全选</button>
      <div style="flex:1"></div>
      <button class="dup-action-btn dup-delete-btn" onclick="deleteSelectedDups()" ${selected.size === 0 ? 'disabled' : ''}>
        🗑 删除选中 (${selected.size})
      </button>
    </div>
    <div class="dup-list">${groupsHtml}</div>
  `;

  showDuplicateModal(html);
}

function showDuplicateModal(html) {
  let overlay = document.getElementById('dupModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'dupModal';
  overlay.className = 'stats-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel dup-panel">
      <div class="stats-header">
        <span>🔍 重复歌曲检测</span>
        <button onclick="document.getElementById('dupModal').remove()">✕</button>
      </div>
      <div class="stats-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

export function toggleDupSelect(filePath) {
  if (_dupState.selected.has(filePath)) {
    _dupState.selected.delete(filePath);
  } else {
    _dupState.selected.add(filePath);
  }
  renderDuplicateModal();
}

export function selectAllDups() {
  const { groups } = _dupState;
  for (const group of groups) {
    for (let i = 1; i < group.length; i++) {
      _dupState.selected.add(group[i].filePath);
    }
  }
  renderDuplicateModal();
}

export function deselectAllDups() {
  _dupState.selected.clear();
  renderDuplicateModal();
}

export async function deleteSelectedDups() {
  const { selected } = _dupState;
  if (!selected.size) return;

  const count = selected.size;
  // （审计 F2 收尾）：旧文案「此操作不可撤销！」是谎话 —— delete-file 走的是
  // shell.trashItem（test/libraryIpc 钉死"移入回收站后原路径消失"），文件一直在系统回收站里。
  // 吓阻不是诚实；诚实的写法是点名影响（个数 + 总大小）并告知真实退路（回收站可还原）。
  const selSongs = _dupState.groups.flat().filter(s => selected.has(s.filePath));
  const totalSize = selSongs.reduce((sum, s) => sum + (s.fileSize || 0), 0);
  const sizeTxt = totalSize > 0 ? formatBytes(totalSize) : '大小未知';
  if (!await askConfirm(`确认删除 ${count} 个重复文件（共 ${sizeTxt}）？\n\n• 每组都会保留音质最好的一个版本，只有勾上的会动\n• 文件移入系统回收站，反悔了随时可还原`)) return;

  let deleted = 0;
  let failed = 0;
  const localSongs = getState('localSongs');
  // 只收集「删成功」的路径，最后一次性从源数据里剔除。
  // 不在这里碰 localFiltered：它是派生状态（filterLocalSongs 由五个过滤轴 + 排序算出），
  // 就地 splice 等于绕过全部过滤轴，且网格视图下界面根本不会重绘 —— 交给回调重算。
  const removed = new Set();

  for (const filePath of selected) {
    try {
      // 调用主进程删除文件
      const result = await api.deleteFile(filePath);
      if (result && result.success) {
        removed.add(filePath);
        deleted++;
      } else {
        failed++;
        logger.warn('删除失败:', filePath, result?.error);
      }
    } catch (e) {
      failed++;
      logger.warn('删除异常:', filePath, e.message);
    }
  }

  // 更新状态：只写「源数据」localSongs，然后走库变更回调重跑过滤管线
  if (removed.size) {
    setState('localSongs', localSongs.filter(s => !removed.has(s.filePath)));
    _onLibraryChanged();
  }

  // 关闭弹窗并刷新检测
  const overlay = document.getElementById('dupModal');
  if (overlay) overlay.remove();

  // 成功语点名去处（回收站可还原），失败语保留原样逐数播报
  showToast(failed > 0
    ? `删除完成：✅ ${deleted} 成功  ❌ ${failed} 失败`
    : `已删除 ${deleted} 个重复文件，它们在系统回收站里，随时可还原`,
  deleted > 0 ? 'success' : 'warn', 4000);

  // 重新检测
  if (deleted > 0) {
    setTimeout(() => detectDuplicateSongs(), 500);
  }
}

// ══════════════════════════════════════════════════════════
// 功能 4：内容级查重（字节哈希，主进程 dupScan）
// 与功能 3 的元数据分组互补：改名/换目录/标签被编辑过的同内容副本也能抓到
// ══════════════════════════════════════════════════════════

export async function detectContentDuplicates() {
  let dir = getState('localDirPath');
  if (!dir) {
    try { dir = await api.getPref('localDirPath'); } catch { /* 下方统一提示 */ }
  }
  if (!dir) { showToast('请先在本地库「扫描目录」选择一个音乐目录', 'warn'); return; }

  showToast('🧬 正在按文件内容查重…', 'info', 2500);
  try {
    const r = await api.findContentDuplicates(dir);
    if (r.error) { showToast('内容查重失败: ' + r.error, 'error'); return; }
    const groups = r.groups || [];
    _dupState.groups = groups;
    _dupState.selected.clear();
    if (!groups.length) {
      showToast(`🎉 内容级没有重复（扫描 ${r.scanned || 0} 个文件）`, 'success');
      return;
    }
    // 每组保留路径序第一份，其余预选待删（行内仍可反选）
    for (const group of groups) {
      for (let i = 1; i < group.length; i++) _dupState.selected.add(group[i].filePath);
    }
    renderDuplicateModal();
    showToast(`🧬 发现 ${groups.length} 组内容完全相同，最多可释放 ${formatBytes(r.wasted || 0)}`, 'info', 4500);
  } catch (e) {
    showToast('内容查重失败: ' + errBrief(e), 'error');
  }
}
