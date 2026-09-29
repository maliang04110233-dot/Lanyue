/**
 * MusicDL 下载管理视图
 */

import { errBrief } from '../errBrief.js';
import { t } from '../i18n.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';
import { loadAndPlay } from '../player.js';
import { showContextMenu } from '../contextMenu.js';
import { applyQueueFilter } from '../queueFilter.js';
import {
  UNKNOWN_KEY, groupTasksByPlatform, groupHeaderLabel,
  toggleGroupCollapsed, nextPlatformFilter,
} from '../queueGroup.js';
import { failureTagHtml, isAuthFailure } from '../diagnose.js';
import { isRangeClick, rangeKeys } from '../selectionRange.js';
import { registerDeleteScope } from '../deleteScope.js';
import { netFailedTasks } from '../netRecovery.js';

// ── 行内 SVG 图标（与 home.js ROW_ICONS 同范式：16px、stroke 1.7、currentColor）──
// chevronDown / chevronRight 是**折叠/展开**专用的一对，刻意不复用 up/down：
// 展开/折叠与队列重排住在同一行工具条上，up/down 画的是「带竖杆 + 箭头 + 底横线」的
// 上下移箭头，语义是「挪动」；折叠三角没有竖杆也没有底横线，只有一个角，语义是
// 「显隐」。两者混用时用户看到的是「第 3 个箭头」，而按钮点下去干的是完全另一件事
// （修的就是这个：展开态曾错用 up，折叠态曾错用 down，与「点它会做什么」
// 正好相反，撞车的是同行的上移/下移/置顶三枚按钮）。test/dl-fold-chevron.test.js 钉住。
const DL_ICONS = {
  play:    '<path d="M6 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  down:    '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  up:      '<path d="M12 21V9m0 0l-4.5 4.5M12 9l4.5 4.5M4 4h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  top:     '<path d="M12 5l-5 5m5-5l5 5M12 13l-5 5m5-5l5 5M5 21h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown:  '<path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  close:   '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  folder:  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  sos:     '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 8v5m0 3.5v.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  search:  '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  history: '<path d="M5 5h10l4 4v11H5V5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15 5v4h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  note:    '<path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="18" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="16" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  inbox:   '<path d="M4 13h4l2 3h4l2-3h4M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  pause:   '<path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  eye:     '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  check:   '<path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
};

function svgIcon(name) {
  return `<svg class="row-icon queue-ico" viewBox="0 0 24 24" aria-hidden="true">${DL_ICONS[name] || ''}</svg>`;
}

/** 菜单项 iconHtml：contextMenu 里 label 仍走 textContent，只有图标走 innerHTML */
function menuIcon(name) {
  return svgIcon(name);
}

// ── DOM 缓存 ──────────────────────────────────────────
const _dlDom = {
  queueList: null,
  queueBadge: null,
  dlSelectionBar: null,
  dlSelectionCount: null,
};

function _cacheDlDom() {
  _dlDom.queueList = document.getElementById('queueList');
  _dlDom.queueBadge = document.getElementById('queueBadge');
  _dlDom.dlSelectionBar = document.getElementById('dlSelectionBar');
  _dlDom.dlSelectionCount = document.getElementById('dlSelectionCount');
}

let _dlFilter = 'all';         // 'all' | 'active' | 'done' | 'error'
let _dlKeyword = '';           // 队列关键词过滤（与状态筛选 AND 叠加）
let _dlGroupMode = false;      // 按平台分组显示
let _dlPlatform = '';          // 只看单个平台（空=全部，与状态/关键词 AND 叠加）
let _dlCollapsed = new Set();  // 分组模式下已折叠的平台键
let _dlSelectionMode = false;
const _selectedDl = new Set(); // 存 taskId
let _dlSelAnchor = null;       // Shift 连选锚点（存 taskId，与选态同身份）
const _expandedDlDetails = new Set(); // 存已展开详情的 taskId

// ── 筛选 ──────────────────────────────────────────────
function setDownloadFilter(f) {
  _dlFilter = f;
  document.querySelectorAll('#downloadFilterTabs .filter-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.includes(
      f === 'all' ? '全部' : f === 'active' ? '下载中' : f === 'done' ? '已完成' : '失败'
    ));
  });
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
}

// ── 选择模式 ─────────────────────────────────────────
function enterDlSelectionMode() {
  _dlSelectionMode = true;
  _selectedDl.clear();
  _dlSelAnchor = null;
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function exitDlSelectionMode() {
  _dlSelectionMode = false;
  _selectedDl.clear();
  _dlSelAnchor = null;
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

/**
 * 视图序的**唯一**计算处：状态 × 关键词 × 平台过滤 → 最新在上、封顶 50。
 *
 * renderQueue 与 Shift 连选都读它。分两处各写一遍筛选是 playlist.js 头注点名过的病
 * （「渲染/全选/任何读视图序的地方都走它」），漂出去的第一个症状就是
 * Shift 连到了一行根本没显示的任务。
 */
function _dlShownTasks(queue) {
  return applyQueueFilter(queue, _dlFilter, _dlKeyword, _dlPlatform)
    .slice(-50).reverse();
}

/**
 * 连选用的「当前视图序」（taskId 序列，与屏幕上看到的行序逐字一致）。
 * 分组模式还要跟上折叠：折叠起来的组不在 DOM 里，区间不该跨过它。
 */
function _dlViewOrder() {
  const shown = _dlShownTasks(getState('queueSnapshot') || []);
  if (!_dlGroupMode) return shown.map((s) => s.taskId);
  return groupTasksByPlatform(shown, platformLabel)
    .filter((g) => !_dlCollapsed.has(g.key))
    .reduce((acc, g) => acc.concat(g.tasks.map((s) => s.taskId)), []);
}

function toggleDlSelect(taskId, e) {
  if (isRangeClick(e)) {
    const order = _dlViewOrder();
    const at = order.indexOf(taskId);
    if (at >= 0) {
      for (const id of rangeKeys(order, _dlSelAnchor, at)) _selectedDl.add(id);
      const queue = getState('queueSnapshot') || [];
      renderQueue(queue);
      updateDlSelectionBar();
      return;
    }
  }
  if (_selectedDl.has(taskId)) _selectedDl.delete(taskId);
  else _selectedDl.add(taskId);
  _dlSelAnchor = taskId;
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function selectAllDl() {
  const queue = getState('queueSnapshot') || [];
  queue.forEach(s => _selectedDl.add(s.taskId));
  renderQueue(queue);
  updateDlSelectionBar();
}

function deselectAllDl() {
  _selectedDl.clear();
  _dlSelAnchor = null; // 整批清空后锚点已不在选态里，留着会连出用户没要的区间
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function updateDlSelectionBar() {
  if (!_dlDom.dlSelectionBar) return;
  const n = _selectedDl.size;
  if (!_dlSelectionMode) { _dlDom.dlSelectionBar.style.display = 'none'; return; }
  if (_dlDom.dlSelectionCount) _dlDom.dlSelectionCount.textContent = n;
  _dlDom.dlSelectionBar.style.display = 'flex';
}

// ── 批量操作 ─────────────────────────────────────────
async function batchRetryDl() {
  const queue = getState('queueSnapshot') || [];
  let ok = 0;
  for (const taskId of _selectedDl) {
    try {
      const s = queue.find(x => x.taskId === taskId);
      if (s && s.status === 'error') {
        const r = await api.retryDownload(taskId);
        if (r && r.ok) ok++;
      }
    } catch (e) {
      logger.warn('[batchRetry] 重试失败:', taskId, e.message);
    }
  }
  showToast(t('toast.dlBatchRetried', { count: ok }), ok > 0 ? 'success' : 'warn', 3000);
  exitDlSelectionMode();
}

async function batchRemoveDl() {
  if (!_selectedDl.size) return;
  let removed = 0;
  for (const taskId of _selectedDl) {
    try {
      const r = await api.removeQueueItem(taskId);
      if (r && (r.removed !== undefined || r.ok !== undefined)) removed++;
    } catch (e) {
      logger.warn('[batchRemove] 删除失败:', taskId, e.message);
    }
  }
  showToast(t('toast.dlBatchRemoved', { count: removed }), 'success', 2500);
  exitDlSelectionMode();
}

// ── 渲染 ──────────────────────────────────────────────
/**
 * 队列渲染。**只读** state.queueSnapshot，绝不回写。
 *
 * 曾经这里有一句 `state.set('queueSnapshot', queue)`：渲染函数持有源状态的写权限。
 * 它在当时是多余的（唯一写入点 app.js:309 的队列事件已先写过，此处只是回声），
 * 但把数据流方向搞反了 —— 切筛选/分组/展开详情这些**纯 UI 重绘**都调本函数，
 * 一旦有人传进来的是子集（例如为了只渲染可见行），全局快照就被静默改掉，
 * 而 search.js 的徽标、app.js:740 的下载状态、本文件十几处 getState 全读它。
 * 渲染只读、事件写状态：方向定死后这类事故不可能发生。
 */
function renderQueue(queue) {
  if (!_dlDom.queueList || !_dlDom.queueBadge) return;
  // 断网横幅的等待条数跟着队列快照走（复网续跑后红条变排队，数字得跟着降下去）
  refreshNetBanner();
  const el = _dlDom.queueList;
  const badge = _dlDom.queueBadge;
  const active = queue.filter(s => s.status !== 'done');
  badge.textContent = active.length;
  if (typeof window.refreshQueueSummary === 'function') window.refreshQueueSummary();

  // 按筛选过滤（状态 × 关键词 × 平台，组合逻辑在 queueFilter.js 纯函数）。
  // 封顶 50 与反转都在 _dlShownTasks 里 —— 连选读的是同一个函数，见它的注释。
  const shown = _dlShownTasks(queue);

  if (!shown.length) {
    if (_dlKeyword) {
      const modeLabel = { active: '下载中', done: '已完成', error: '失败' }[_dlFilter] || '';
      el.innerHTML = `<div class="queue-empty">没有匹配「${esc(_dlKeyword)}」的${modeLabel ? '「' + modeLabel + '」' : ''}任务</div>`;
      return;
    }
    const emptyMsg = _dlFilter === 'all' ? '暂无下载任务' : _dlFilter === 'active' ? '暂无正在下载的任务' : _dlFilter === 'done' ? '暂无已完成的任务' : '暂无失败的任务';
    // 全部 tab 空态给引导（去搜索/看历史）；筛选 tab 空态保持一句话
    el.innerHTML = _dlFilter === 'all' && !queue.length
      ? `<div class="queue-empty queue-empty-guide">
          <div class="queue-empty-icon">${svgIcon('inbox')}</div>
          <div class="queue-empty-text">${emptyMsg}</div>
          <div class="queue-empty-hint">搜索喜欢的歌，点 ${svgIcon('down')} 加入下载队列</div>
          <div class="queue-empty-actions">
            <button class="setting-btn" onclick="switchTab('search')">${svgIcon('search')} 去搜索</button>
            <button class="setting-btn" onclick="switchDlSubTab('history')">${svgIcon('history')} 下载历史</button>
          </div>
        </div>`
      : `<div class="queue-empty">${emptyMsg}</div>`;
    return;
  }

  // 最新在上（可见 50 行的封顶在 _dlShownTasks 里，分组只是换种摆法）
  if (_dlGroupMode) {
    el.innerHTML = groupTasksByPlatform(shown, platformLabel).map(g => _queueGroupHeaderHtml(g)
      + (_dlCollapsed.has(g.key) ? '' : g.tasks.map(s => _queueRowHtml(s)).join(''))).join('');
    return;
  }
  el.innerHTML = shown.map(s => _queueRowHtml(s)).join('');
}

/** 单行 HTML：分组与非分组两条渲染路径共用，动作全走行内既有函数 */
function _queueRowHtml(s) {
    const selected = _selectedDl.has(s.taskId) && _dlSelectionMode;
    const isExpanded = _expandedDlDetails.has(s.taskId);
    // 遮罩下载链接（只显示域名和文件名）
    const maskedUrl = s.downloadUrl ? maskUrl(s.downloadUrl) : '';
    // 格式化文件大小
    const fileSize = s.fileSize ? formatFileSize(s.fileSize) : '';
    // 格式化下载耗时
    const downloadTime = s.downloadTime ? formatDuration(s.downloadTime) : '';
    return `
    <div class="queue-item queue-status-${s.status}${selected && _dlSelectionMode ? ' selected' : ''}" data-taskid="${escAttr(s.taskId)}">
      ${_dlSelectionMode ? `
      <div class="queue-item-cb" onclick="event.stopPropagation();toggleDlSelect('${escQ(s.taskId)}', event)">
        <input type="checkbox" id="dlcb_${escAttr(s.taskId)}" ${selected ? 'checked' : ''} >
      </div>` : ''}
      ${s.cover
        ? `<img class="queue-cover" src="${escAttr(s.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="queue-cover-ph" ${s.cover ? 'style="display:none"' : ''}>${svgIcon('note')}</div>
      <div class="queue-info" tabindex="0" role="button" onclick="event.stopPropagation();toggleQueueDetail('${escQ(s.taskId)}')" style="cursor:pointer;">
        <div class="queue-title">${esc(s.title || '未知')}</div>
        <div class="queue-status status-${s.status}">${statusLabel(s.status)}${s.error ? ': ' + esc(s.error) : ''}${failureTagHtml(s.errorCode, { fn: 'diagnoseFailure', arg: s.taskId })}</div>
        ${s.status === 'downloading' ? `
        <div class="progress-bar-wrap"><div class="progress-bar" id="prog-${escAttr(s.taskId)}" style="width:${s.progress||0}%"></div></div>
        <div class="queue-dl-meta" id="progmeta-${escAttr(s.taskId)}"></div>` : ''}
      </div>
      <button class="queue-detail-toggle" onclick="event.stopPropagation();toggleQueueDetail('${escQ(s.taskId)}')" title="${isExpanded ? '收起详情' : '展开详情'}">${svgIcon(isExpanded ? 'chevronDown' : 'chevronRight')}</button>
      ${(!_dlSelectionMode && s.status === 'pending') ? `<button class="queue-cancel" title="置顶" onclick="event.stopPropagation();reorderQueueItem('${escQ(s.taskId)}','top')">${svgIcon('top')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'pending') ? `<button class="queue-cancel" title="上移" onclick="event.stopPropagation();reorderQueueItem('${escQ(s.taskId)}','up')">${svgIcon('up')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'pending') ? `<button class="queue-cancel" title="下移" onclick="event.stopPropagation();reorderQueueItem('${escQ(s.taskId)}','down')">${svgIcon('down')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'pending') ? `<button class="queue-cancel" onclick="event.stopPropagation();api.cancelDownload('${escQ(s.taskId)}')" title="取消">${svgIcon('close')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'downloading') ? `<button class="queue-cancel" onclick="event.stopPropagation();api.cancelDownload('${escQ(s.taskId)}')" title="取消下载（中断传输并清理临时文件）">${svgIcon('close')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'done' && s.savePath) ? `<button class="queue-cancel" style="color:var(--neon-cyan)" title="本地播放（下载完直接听）" onclick="event.stopPropagation();playQueueItem('${escQ(s.taskId)}')">${svgIcon('play')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'done' && s.savePath) ? `<button class="queue-cancel" style="color:var(--neon-green)" title="打开文件夹" onclick="event.stopPropagation();openFolderSafe('${escQ(s.savePath)}')">${svgIcon('folder')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'done') ? `<button class="queue-cancel" style="color:var(--neon-cyan)" title="转换格式" onclick="event.stopPropagation();showConvertModal('${escQ(s.savePath || '')}', '${escQ(s.title || '')}')">${svgIcon('refresh')}</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'error') ? `
        <button class="queue-cancel" style="color:var(--neon-yellow)" title="诊断失败原因" onclick="event.stopPropagation();window.diagnoseFailure('${escQ(s.taskId)}')">${svgIcon('sos')}</button>
        <button class="queue-cancel" style="color:var(--neon-orange)" title="重试下载" onclick="event.stopPropagation();retryQueueItem('${escQ(s.taskId)}')">${svgIcon('refresh')}</button>
        <button class="queue-cancel" title="移除" onclick="event.stopPropagation();removeQueueItem('${escQ(s.taskId)}')">${svgIcon('close')}</button>
      ` : ''}
    </div>
    ${isExpanded ? `
    <div class="queue-detail-panel">
      <div class="queue-detail-grid">
        ${fileSize ? `<div class="queue-detail-row"><span class="queue-detail-label">文件大小</span><span class="queue-detail-value">${fileSize}</span></div>` : ''}
        ${downloadTime ? `<div class="queue-detail-row"><span class="queue-detail-label">下载耗时</span><span class="queue-detail-value">${downloadTime}</span></div>` : ''}
        ${s.retries != null && s.retries > 0 ? `<div class="queue-detail-row"><span class="queue-detail-label">重试次数</span><span class="queue-detail-value">${s.retries}</span></div>` : ''}
        ${s.savePath ? `<div class="queue-detail-row"><span class="queue-detail-label">文件路径</span><span class="queue-detail-value queue-detail-path" title="${escAttr(s.savePath)}">${esc(s.savePath)}</span></div>` : ''}
        ${s.source ? `<div class="queue-detail-row"><span class="queue-detail-label">来源</span><span class="queue-detail-value">${esc(s.source)}${s.quality ? ' · ' + esc(s.quality) : ''}</span></div>` : ''}
        ${maskedUrl ? `<div class="queue-detail-row"><span class="queue-detail-label">下载链接</span><span class="queue-detail-value queue-detail-url" title="${escAttr(s.downloadUrl)}">${esc(maskedUrl)}</span></div>` : ''}
        ${s.error ? `<div class="queue-detail-row queue-detail-error"><span class="queue-detail-label">错误信息</span><span class="queue-detail-value">${esc(s.error)}</span></div>` : ''}
      </div>
    </div>` : ''}`;
}

/** 平台显示名：统一走 utils.js 的 platformName（单一来源），无来源归「其他」 */
function platformLabel(key) {
  if (key === UNKNOWN_KEY) return '其他';
  return (typeof platformName === 'function' && platformName(key)) || key;
}

/** 组头：折叠三角 + 聚合计数 + 「只看该平台」 */
function _queueGroupHeaderHtml(g) {
  const collapsed = _dlCollapsed.has(g.key);
  const only = _dlPlatform === g.key;
  return `
    <div class="queue-group-header${collapsed ? ' collapsed' : ''}">
      <button class="queue-group-fold" title="${collapsed ? '展开该平台' : '收起该平台'}" onclick="toggleDlGroupCollapsed('${escQ(g.key)}')">${svgIcon(collapsed ? 'chevronRight' : 'chevronDown')}</button>
      <span class="queue-group-title">${esc(groupHeaderLabel(g))}</span>
      <button class="queue-group-only" title="${only ? '取消只看该平台' : '只看该平台的任务'}" onclick="setDlPlatformFilter('${escQ(g.key)}')">${svgIcon(only ? 'check' : 'eye')} 只看</button>
    </div>`;
}

/** 工具栏两处状态：分组开关字样 + 「只看某平台」徽标 */
function _renderDlGroupToolbar() {
  const lbl = document.getElementById('dlGroupLabel');
  if (lbl) lbl.textContent = _dlGroupMode ? '开' : '关';
  const chip = document.getElementById('dlPlatformChip');
  if (!chip) return;
  if (_dlPlatform) {
    chip.style.display = '';
    chip.innerHTML = `${svgIcon('eye')} 只看：${esc(platformLabel(_dlPlatform))} ${svgIcon('close')}`;
  } else {
    chip.style.display = 'none';
    chip.innerHTML = '';
  }
}

/** 分组显示开关（组内可见上限与平铺一致，折叠状态在关闭后仍保留） */
function toggleDlGroupMode() {
  _dlGroupMode = !_dlGroupMode;
  _renderDlGroupToolbar();
  renderQueue(getState('queueSnapshot') || []);
  showToast(_dlGroupMode ? t('toast.dlGroupOn') : t('toast.dlGroupOff'), 'info', 1800);
}

function toggleDlGroupCollapsed(key) {
  if (!_dlGroupMode) return;
  _dlCollapsed = toggleGroupCollapsed(_dlCollapsed, key);
  renderQueue(getState('queueSnapshot') || []);
}

/** 组头「只看」：点同一个平台即取消（与状态/关键词 AND 叠加） */
function setDlPlatformFilter(key) {
  const next = nextPlatformFilter(_dlPlatform, key);
  _dlPlatform = next;
  _renderDlGroupToolbar();
  renderQueue(getState('queueSnapshot') || []);
  showToast(next ? t('toast.dlOnlyPlatform', { platform: platformLabel(next) }) : t('toast.dlOnlyOff'), 'info', 1800);
}

function clearDlPlatformFilter() {
  if (!_dlPlatform) return;
  setDlPlatformFilter(_dlPlatform);
}

// esc() 和 statusLabel() 已由 utils.js 全局导出，此处不再重复定义

// ── 队列行右键菜单（按状态组装，动作全部复用行内既有函数）────
function queueRowContext(e) {
  if (_dlSelectionMode) return; // 批量选择模式：行点击=勾选，不弹菜单
  const row = e.target && e.target.closest ? e.target.closest('.queue-item') : null;
  if (!row || !_dlDom.queueList || !_dlDom.queueList.contains(row)) return;
  const taskId = row.getAttribute('data-taskid');
  if (!taskId) return;
  const s = (getState('queueSnapshot') || []).find(x => x && x.taskId === taskId);
  if (!s) return;
  e.preventDefault();
  const items = [];
  if (s.status === 'pending') {
    items.push(
      { iconHtml: menuIcon('top'), label: '置顶', onClick: () => reorderQueueItem(taskId, 'top') },
      { iconHtml: menuIcon('up'), label: '上移', onClick: () => reorderQueueItem(taskId, 'up') },
      { iconHtml: menuIcon('close'), label: '取消任务', danger: true, onClick: () => api.cancelDownload(taskId) },
    );
  } else if (s.status === 'downloading') {
    items.push({ iconHtml: menuIcon('close'), label: '取消下载', danger: true, onClick: () => api.cancelDownload(taskId) });
  } else if (s.status === 'done') {
    if (s.savePath) items.push({ iconHtml: menuIcon('play'), label: '本地播放', onClick: () => playQueueItem(taskId) });
    if (s.savePath) items.push({ iconHtml: menuIcon('folder'), label: '打开文件夹', onClick: () => openFolderSafe(s.savePath) });
    if (s.savePath && typeof window.showConvertModal === 'function') {
      items.push({ iconHtml: menuIcon('refresh'), label: '转换格式', onClick: () => window.showConvertModal(s.savePath, s.title || '') });
    }
  } else if (s.status === 'error') {
    items.push(
      { iconHtml: menuIcon('sos'), label: '诊断失败原因', onClick: () => window.diagnoseFailure(taskId) },
      { iconHtml: menuIcon('refresh'), label: '重试下载', onClick: () => retryQueueItem(taskId) },
      { iconHtml: menuIcon('close'), label: '移除', danger: true, onClick: () => removeQueueItem(taskId) },
    );
  }
  if (!items.length) return;
  showContextMenu(e.clientX, e.clientY, items);
}

document.addEventListener('contextmenu', queueRowContext);

// ── 单项操作 ─────────────────────────────────────────
async function toggleQueueDetail(taskId) {
  try {
    if (_expandedDlDetails.has(taskId)) {
      _expandedDlDetails.delete(taskId);
    } else {
      _expandedDlDetails.add(taskId);
    }
    const queue = getState('queueSnapshot') || [];
    renderQueue(queue);
  } catch (e) {
    logger.warn(`[toggleQueueDetail] error:`, e);
  }
}

// ── 辅助格式化 ─────────────────────────────────────────
function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDuration(ms) {
  if (ms == null || ms === 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return min + ' 分 ' + (remain > 0 ? remain + ' 秒' : '');
}

function maskUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname;
    // 提取文件名部分
    const parts = u.pathname.split('/');
    const filename = parts[parts.length - 1];
    if (filename.length > 20) {
      return host + '/…' + filename.slice(-18);
    }
    return host + '/' + filename;
  } catch (_e) {
    // 非法 URL，截断显示
    if (url.length > 40) return url.slice(0, 20) + '…' + url.slice(-16);
    return url;
  }
}

async function retryQueueItem(taskId) {
  try {
    const r = await api.retryDownload(taskId);
    if (r && r.ok) { showToast(t('toast.dlRetryQueued'), 'info', 2000); }
    else { showToast(t('toast.dlRetryFailed', { msg: r?.error || t('toast.unknownError') }), 'error', 3000); }
  } catch (e) {
    showToast(t('toast.dlRetryFailed', { msg: errBrief(e) }), 'error', 3000);
  }
}

// ── 重试所有失败任务 ─────────────────────────────────
async function retryAllFailed() {
  const queue = getState('queueSnapshot') || [];
  const failed = queue.filter(s => s.status === 'error');
  if (!failed.length) { showToast(t('toast.dlNoFailed'), 'info', 1500); return; }

  // 按错误类型分类统计
  const errors = {};
  failed.forEach(s => {
    const code = s.errorCode || 'UNKNOWN';
    errors[code] = (errors[code] || 0) + 1;
  });
  const summary = Object.entries(errors).map(([k, v]) => `${k}:${v}`).join(' ');
  showToast(t('toast.dlRetryingAll', { count: failed.length, summary }), 'info', 2000);

  let ok = 0;
  for (const s of failed) {
    try {
      // 鉴权/VIP 这类致命错误不自动重试：哪几个码算这类，唯一的家在 diagnose.js，这里只问结论
      if (isAuthFailure(s.errorCode)) continue;
      const r = await api.retryDownload(s.taskId);
      if (r && r.ok) ok++;
    } catch (_e) { /* 单个失败不影响整体 */ }
  }

  const skipped = failed.length - ok;
  if (ok > 0) {
    showToast(skipped > 0
      ? t('toast.dlRetriedSkipped', { count: ok, skipped })
      : t('toast.dlRetried', { count: ok }), 'success', 3000);
  } else {
    showToast(t('toast.dlAllNeedManual'), 'warn', 3000);
  }
}

async function removeQueueItem(taskId) {
  try {
    await api.removeQueueItem(taskId);
  } catch (e) {
    showToast(t('toast.deleteFailedMsg', { msg: errBrief(e) }), 'error', 3000);
  }
}

// 下载中条目的速度/剩余/大小文案（download-progress 事件驱动，app.js 调用）
function formatEta(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function dlProgressText(info) {
  if (!info) return '';
  const parts = [];
  if (typeof info.progress === 'number') parts.push(info.progress + '%');
  if (info.speedBps > 0) parts.push(formatBytes(info.speedBps) + '/s');
  if (info.etaSec != null) parts.push('剩余 ' + formatEta(info.etaSec));
  if (info.totalBytes > 0) parts.push(`${formatBytes(info.receivedBytes)} / ${formatBytes(info.totalBytes)}`);
  return parts.join(' · ');
}

async function reorderQueueItem(taskId, action) {
  try {
    const r = await api.reorderQueueItem(taskId, action);
    if (r && !r.ok) showToast(r.error || t('toast.dlMoveBlocked'), 'info', 1800);
  } catch (e) {
    showToast(t('toast.dlMoveFailed', { msg: errBrief(e) }), 'error', 3000);
  }
}

// ── 队列暂停/继续（只挡新任务启动，在途任务自然完成）────
let _queuePaused = false;

/** 统一按钮呈现；托盘切换经 queue-paused-changed 事件也走这里 */
function applyQueuePausedUi(paused) {
  _queuePaused = !!paused;
  const btn = document.getElementById('queuePauseBtn');
  if (btn) {
    btn.innerHTML = svgIcon(_queuePaused ? 'play' : 'pause') + (_queuePaused ? ' 继续' : ' 暂停');
    btn.classList.toggle('active', _queuePaused);
    btn.classList.toggle('tab-neon', _queuePaused);
    btn.title = _queuePaused
      ? '已暂停：新任务不会启动，点击继续'
      : '暂停后不再启动新任务，在途任务继续完成';
  }
}

async function toggleQueuePause() {
  try {
    const r = await api.setQueuePaused(!_queuePaused);
    if (!r || !r.ok) { showToast(t('toast.dlPauseToggleFailed', { msg: (r && r.error) || t('toast.unknownError') }), 'error'); return; }
    applyQueuePausedUi(r.paused);
    showToast(r.paused ? t('toast.dlPaused') : t('toast.dlResumed'), 'info', 2200);
  } catch (e) {
    showToast(t('toast.dlPauseToggleFailed', { msg: errBrief(e) }), 'error', 3000);
  }
}

// ── 网络状态：断网横幅 + 复网自动续跑────────────
// 引擎给断网/超时的失败回了码（NETWORK_ERROR / NETWORK_TIMEOUT），这一页才第一次问得出
// 「哪些红条是在等网络的」。断网时说出来，复网时替用户把它们重新排队 —— 那几行不必
// 再一条条手点。非网络类失败（需 VIP / 版权受限 / 磁盘满）一条都不碰：再跑一遍还是同样失败。
function refreshNetBanner() {
  const el = document.getElementById('netBanner');
  if (!el) return;
  const offline = navigator.onLine === false;
  const waiting = offline ? netFailedTasks(getState('queueSnapshot') || []).length : 0;
  if (!offline) { el.hidden = true; return; }
  el.textContent = waiting > 0 ? t('download.netWaiting', { count: waiting }) : t('download.netOffline');
  el.hidden = false;
}

async function _requeueNetFailures() {
  const rows = netFailedTasks(getState('queueSnapshot') || []);
  let ok = 0;
  for (const s of rows) {
    try {
      const r = await api.retryDownload(s.taskId);
      if (r && r.ok) ok++;
    } catch (e) {
      logger.warn('[netRequeue] 重试失败:', s.taskId, errBrief(e));
    }
  }
  if (ok > 0) showToast(t('toast.netRequeued', { count: ok }), 'info', 3500);
}

window.addEventListener('offline', () => refreshNetBanner());
window.addEventListener('online', () => {
  refreshNetBanner();
  // 用户按着暂停时别替他决定：复网自动续跑让位给手工「继续」
  if (!_queuePaused) _requeueNetFailures();
});
refreshNetBanner();

async function clearFinishedDownloads() {
  try {
    const r = await api.clearFinishedQueue();
    showToast(t('toast.dlClearedFinished', { count: r.removed }), 'success');
  } catch (e) {
    showToast(t('toast.dlClearFailed', { msg: errBrief(e) }), 'error', 3000);
  }
}

async function clearAllDownloads() {
  if (!await askConfirm(t('toast.dlConfirmClearAll'))) return;
  try {
    const r = await api.clearAllQueue();
    showToast(t('toast.dlClearedAll', { count: r.removed }), 'success');
  } catch (e) {
    showToast(t('toast.dlClearFailed', { msg: errBrief(e) }), 'error', 3000);
  }
}

function openSaveDir() {
  const saveDir = getState('saveDir');
  if (saveDir) openFolderSafe(saveDir);
  else showToast(t('toast.dlNoSaveDir'), 'warn');
}

// ── 下载完成即播（本地 file:// 直放，复用 player 本地分支）───
async function playDownloadedFile(s) {
  const path = s.filePath || s.savePath;
  if (!path) { showToast(t('toast.dlNoFilePath'), 'error'); return; }
  const song = { ...s, filePath: path };
  setState('playQueue', [song]);
  setState('playIdx', 0);
  setState('currentPlaying', song);
  try {
    await loadAndPlay(song, 'file://' + String(path).replace(/\\/g, '/'));
  } catch (e) {
    logger.error('[playDownloadedFile]', e);
    showToast(t('toast.playFailed', { msg: errBrief(e) }), 'error');
  }
}

async function playQueueItem(taskId) {
  const queue = getState('queueSnapshot') || [];
  const s = queue.find(x => x.taskId === taskId);
  if (!s || s.status !== 'done') return; // 队列已变动（重渲染时序），静默忽略
  await playDownloadedFile(s);
}

async function exportCurrentPlaylist() {
  const queue = getState('queueSnapshot') || [];
  if (!queue.length) {
    showToast(t('toast.dlNoTasks'), 'warn');
    return;
  }

  // 只导出已完成的歌曲
  // 主进程终态写的是 savePath（filePath 仅个别旧快照有），只按 filePath 筛永远导出为空
  const completedSongs = queue.filter(s => s.status === 'done' && (s.filePath || s.savePath));
  if (!completedSongs.length) {
    showToast(t('toast.dlNoCompleted'), 'warn');
    return;
  }

  try {
    const result = await api.exportPlaylist({
      songs: completedSongs.map(s => ({
        title: s.title,
        artist: s.artist,
        filePath: s.filePath || s.savePath,
        duration: s.duration || 0,
      })),
      format: 'm3u',
      name: 'Lanyue Playlist',
    });

    if (result.canceled) return;
    if (result.error) {
      showToast(t('toast.exportFailed', { msg: result.error }), 'error');
      return;
    }

    showToast(t('toast.dlExported', { count: completedSongs.length }), 'success');
  } catch (e) {
    showToast(t('toast.exportFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 导出 ──────────────────────────────────────────────
// ── ES Module 导出 ──────────────────────────────────────
export {
  renderQueue,
  setDownloadFilter,
  toggleQueueDetail,
  enterDlSelectionMode,
  exitDlSelectionMode,
  toggleDlSelect,
  selectAllDl,
  deselectAllDl,
  batchRetryDl,
  batchRemoveDl,
  retryQueueItem,
  removeQueueItem,
  clearFinishedDownloads,
  clearAllDownloads,
  openSaveDir,
  exportCurrentPlaylist,
  toggleQueuePause,
  applyQueuePausedUi,
  toggleDlGroupMode,
  toggleDlGroupCollapsed,
  setDlPlatformFilter,
  clearDlPlatformFilter,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.renderQueue = renderQueue;
function setQueueKeyword() {
  const input = document.getElementById('queueFilterInput');
  _dlKeyword = input?.value?.trim() || '';
  renderQueue(getState('queueSnapshot') || []);
}

window.setDownloadFilter = setDownloadFilter;
window.setQueueKeyword = setQueueKeyword;
window.toggleQueueDetail = toggleQueueDetail;
window.enterDlSelectionMode = enterDlSelectionMode;
window.exitDlSelectionMode = exitDlSelectionMode;
window.toggleDlSelect = toggleDlSelect;
window.selectAllDl = selectAllDl;
window.deselectAllDl = deselectAllDl;
window.toggleDlGroupMode = toggleDlGroupMode;
window.toggleDlGroupCollapsed = toggleDlGroupCollapsed;
window.setDlPlatformFilter = setDlPlatformFilter;
window.clearDlPlatformFilter = clearDlPlatformFilter;
// 音频格式转换入口已收敛到 ../converter-core.js
// （showConvertModal / closeConvertModal / doConvertAudio 由该模块挂到 window）


window.batchRetryDl = batchRetryDl;
window.batchRemoveDl = batchRemoveDl;
window.retryQueueItem = retryQueueItem;
window.retryAllFailed = retryAllFailed;
window.removeQueueItem = removeQueueItem;
window.reorderQueueItem = reorderQueueItem;
window.toggleQueuePause = toggleQueuePause;
window.applyQueuePausedUi = applyQueuePausedUi;
window.playDownloadedFile = playDownloadedFile;
window.playQueueItem = playQueueItem;
window.dlProgressText = dlProgressText;
window.clearFinishedDownloads = clearFinishedDownloads;
window.clearAllDownloads = clearAllDownloads;
window.openSaveDir = openSaveDir;
window.exportCurrentPlaylist = exportCurrentPlaylist;

// ── Delete 键作用域：下载队列 ─────────────────────────
// run 走「🗑 移除」按钮同一个函数（它自己清选态、发 toast，这里不另写一份）。
// order=30：歌单详情弹层与播放队列面板都盖在下载页之上，只有它俩都不在场时才轮到本列表。
registerDeleteScope({
  id: 'download-queue',
  order: 30,
  active: () => _dlSelectionMode && !!window.isTabPageVisible?.('downloadPage'),
  count: () => _selectedDl.size,
  run: () => batchRemoveDl(),
  modalId: '',
});

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheDlDom();
