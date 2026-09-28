/**
 * MusicDL 下载历史页面
 */

const PAGE_SIZE = 50;
import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';
import { showContextMenu } from '../contextMenu.js';
import { registerFavSong, isFavorite, toggleFavoriteByKey } from '../favorites.js';
import { favKey } from '../state.js';
import { HISTORY_STATUS_TABS, buildHistoryQuery, sourceOptions, retrySummary, deadSummary, deadConfirmText, deadRetrySummary } from '../historyFilters.js';
import { enqueuePayloadFor, classifyRetryResult } from '../enqueuePayload.js';
import { DEFAULT_SORT, nextSortMode, sortLabel } from '../historySort.js';
import { dlForgetKeys, songDlKey } from '../dlStatus.js';
import { showDiagnosis, failureTagHtml } from '../diagnose.js';
let historyPage = 0;
let _historyTotalPages = 1; // 最近一次查询的总页数（翻页钳制用）
let historyFilter = '';
let _historyStatus = '';
let _historySource = '';
let _historySort = DEFAULT_SORT; // 服务端排序档位（ORDER BY 白名单键）

// ── DOM 缓存 ──────────────────────────────────────────
const _historyDom = {
  list: null,
  info: null,
};

let _historyItems = []; // 当前页数据缓存：▶ 按钮按行号回查记录对象

function _cacheHistoryDom() {
  _historyDom.list = document.getElementById('historyList');
  _historyDom.info = document.getElementById('historyInfo');
}

async function loadHistory() {
  try {
    const opts = {
      // markMissing：让主进程顺手 stat 一遍本页的已完成记录，行上才能如实说"文件已不在"。
      // 判活规则（什么算死账）全在主进程 deadRefs.js，这里只消费结果。
      ...buildHistoryQuery(
        { keyword: historyFilter, status: _historyStatus, source: _historySource, sort: _historySort },
        historyPage, PAGE_SIZE,
      ),
      markMissing: true,
    };
    
    const [result, stats] = await Promise.all([
      api.queryHistory(opts),
      api.getHistoryStats(),
    ]);
    // queryHistory 返回 { items, total }，解包后再渲染
    _historyTotalPages = Math.max(1, Math.ceil(((result && result.total) || 0) / PAGE_SIZE));
    // 筛选变更后当前页可能越界：钳到最后有效页并按新页重查一次
    // （重查后 historyPage < _historyTotalPages，不会递归）
    if (historyPage >= _historyTotalPages) {
      historyPage = _historyTotalPages - 1;
      if (historyPage > 0) { loadHistory(); return; }
      if (historyPage < 0) historyPage = 0;
    }
    renderHistory((result && result.items) || [], stats);
  } catch (e) {
    logger.warn('加载历史失败:', e);
    if (_historyDom.list) {
      _historyDom.list.innerHTML = '<div class="empty-state">加载失败: ' + esc(errBrief(e)) + '</div>';
    }
  }
}

function renderHistory(items, stats) {
  _historyItems = items || [];
  // 「⬇ 重下失效」只在当前页确实有死账时出现：常态不占头部按钮位（头部空间是有限资源）
  const redlBtn = document.getElementById('historyRedlBtn');
  if (redlBtn) redlBtn.hidden = !_historyItems.some(s => s && s.missing);
  if (_historyDom.info && stats) {
    _historyDom.info.textContent = `总计 ${stats.total} 首 · 成功 ${stats.done || 0} · 失败 ${stats.error || 0}`;
  }

  if (!_historyDom.list) return;

  if (!items || !items.length) {
    const filtered = !!(historyFilter || _historyStatus || _historySource);
    _historyDom.list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${filtered ? '🔍' : '📜'}</div>
      <div class="empty-text">${filtered ? '没有符合筛选条件的历史记录' : '暂无下载历史'}</div>
      <div class="empty-hint">${filtered ? '换个关键词，或把状态/来源切回「全部」' : '下载完成的音乐会在这里显示'}</div>
    </div>`;
    return;
  }

  _historyDom.list.innerHTML = _historyItems.map((s, idx) => {
    // 文件已被用户删/挪走的成功记录：✅ 是骗人的，▶ 点了只会报错 —— 换成 🚫 并把路
    // 径指回「重新下载」。判活结论由主进程给出（见 loadHistory 的 markMissing）。
    const dead = s.status === 'done' && s.missing;
    const retryBtn = `<button class="action-btn" title="重新下载" onclick="retryFromHistory('${escQ(s.id)}', '${escQ(s.source)}', '${escQ(s.title)}', '${escQ(s.artist)}', '${escQ(s.album || '')}', '${escQ(s.quality || 'standard')}')">🔄</button>`;
    // 失败行给一个就地诊断：队列早清空了（taskId 已随重启消失），历史是唯一还留着错误原文的地方
    const diagBtn = `<button class="action-btn" title="诊断失败原因（原因 + 建议 + 下一步）" onclick="diagnoseHistoryItem(${idx})">🆘</button>`;
    // 徽标只给 error 行：history.add 是 {...existing, ...entry} 合并写，成功的 entry 不带
    // errorCode，先失败后成功的记录仍留着上一次的失败码 —— 不看 status 就是给 ✅ 戴 ❌ 的帽子。
    return `
    <div class="history-row ${s.status === 'error' ? 'history-row-error' : ''}" data-hidx="${idx}">
      <div class="history-icon">${s.status === 'done' ? (dead ? '🚫' : '✅') : '❌'}</div>
      <div class="history-info">
        <div class="history-title">${esc(s.title)}</div>
        <div class="history-meta">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}${dead ? ' · <span style="color:var(--neon-yellow)">文件已不在磁盘上</span>' : ''}${s.status === 'error' ? failureTagHtml(s.errorCode, { fn: 'diagnoseHistoryItem', arg: idx }) : ''}</div>
      </div>
      <span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>
      <span class="history-quality">${esc(s.quality || 'standard')}</span>
      <span class="history-size">${formatBytes(s.size)}</span>
      <span class="history-time">${fmtDate(s.finishedAt)}</span>
      <div class="history-actions">
        ${s.status === 'done' && s.savePath && !dead
          ? `<button class="action-btn" title="本地播放（下载完直接听）" onclick="playHistoryItem(${idx})">▶</button>`
          : ''}
        ${s.status === 'done' && s.savePath && !dead
          ? `<button class="action-btn" title="打开文件夹" onclick="openFolderSafe('${escQ(s.savePath)}')">📂</button>`
          : ''}
        ${s.status === 'error' || dead ? retryBtn : ''}${s.status === 'error' ? diagBtn : ''}
      </div>
    </div>`;
  }).join('');
}

async function exportHistoryM3u() {
  // missing 的行不写进 m3u：那一行路径指向的文件已经不在，导出的是放不出来的列表
  const done = _historyItems.filter(s => s.status === 'done' && s.savePath && !s.missing);
  if (!done.length) {
    showToast('本页没有可导出的已完成下载', 'warn');
    return;
  }
  try {
    const result = await api.exportPlaylist({
      songs: done.map(s => ({
        title: s.title,
        artist: s.artist,
        filePath: s.savePath,
        // 主进程写 EXTINF 前 ÷1000，历史里 duration 是秒 → 必须乘回毫秒
        duration: (s.duration || 0) * 1000,
      })),
      format: 'm3u',
      name: 'MusicDL History',
    });
    if (result.canceled) return;
    if (result.error) {
      showToast('导出失败: ' + result.error, 'error');
      return;
    }
    const pageNote = _historyItems.length >= PAGE_SIZE ? '（仅当前页）' : '';
    const skipped = _historyItems.filter(s => s.status === 'done' && s.savePath && s.missing).length;
    showToast(`✅ 已导出 ${done.length} 首歌曲${pageNote}${skipped ? `，跳过 ${skipped} 首文件已不在的` : ''}`, 'success');
  } catch (e) {
    showToast('导出失败: ' + errBrief(e), 'error');
  }
}

async function retryFromHistory(id, source, title, artist, album, quality) {
  const saveDir = getState('saveDir');
  try {
    // 历史页的重试按钮只出现在 error 记录上，但同曲可能在其他源下过：
    // 仍查一次历史去重，命中弹「仍要下载」；forceRedownload 时跳过确认
    const r = await api.addToQueue({
      id, source, title, artist, album: album || '',
      saveDir, quality: quality || 'standard',
      cover: '', duration: 0,
    });
    if (r && r.duplicated) {
      showToast(`「${title}」已在下载队列中`, 'warn', 2500);
    } else if (r && r.alreadyDownloaded) {
      showRedownloadToast(title, r.finishedAt, () => {
        api.addToQueue({
          id, source, title, artist, album: album || '',
          saveDir, quality: quality || 'standard',
          cover: '', duration: 0, forceRedownload: true,
        }).then(() => showToast(`「${title}」已重新加入下载队列`, 'success'))
          .catch(e => showToast('重试失败: ' + errBrief(e), 'error'));
      });
    } else {
      showToast(`「${title}」已重新加入下载队列`, 'success');
    }
    // 已在合并页内：直接切到队列子 tab（不再跨页跳转）
    if (typeof switchDlSubTab === 'function') switchDlSubTab('queue');
    else {
      const dlNav = document.querySelector('.nav-item[data-tab="download"]');
      if (dlNav) switchTab('download', dlNav);
    }
  } catch (e) {
    showToast('重试失败: ' + errBrief(e), 'error');
  }
}

/**
 * 就地诊断一条失败历史：弹层与规则全在 diagnose.js 一家，本页只交出
 * 「这一行的记录」和「这一页的重试动作」——没有队列 taskId 也能诊断。
 */
function diagnoseHistoryItem(idx) {
  const s = _historyItems[idx];
  if (!s) {
    showToast('这条记录已不在本页（翻页或筛选会换行号），请刷新历史再诊断', 'warn', 2500);
    return;
  }
  showDiagnosis(
    { title: s.title, artist: s.artist, source: s.source, error: s.error, errorCode: s.errorCode },
    {
      retry: () => retryFromHistory(String(s.id), String(s.source || ''),
        s.title || '', s.artist || '', s.album || '', s.quality || 'standard'),
    },
  );
}

// 一键重试全部失败项：无视当前状态页签（恒查 error），但尊重关键词/来源筛选；
// 逐条串行 addToQueue（下载引擎自带去重），计数在 enqueuePayload.classifyRetryResult
let _retryAllBusy = false;
async function retryFailedFromHistory() {
  if (_retryAllBusy) return;
  _retryAllBusy = true;
  const btn = document.getElementById('historyRetryBtn');
  if (btn) btn.disabled = true;
  try {
    const q = buildHistoryQuery({ keyword: historyFilter, status: 'error', source: _historySource }, 0, 200);
    const { items } = await api.queryHistory(q);
    const list = (items || []).filter(s => s && s.id != null);
    if (!list.length) { showToast('没有符合条件的失败记录', 'warn'); return; }
    const saveDir = getState('saveDir');
    const tally = { added: 0, dup: 0, had: 0, fail: 0 };
    for (const s of list) {
      try {
        const r = await api.addToQueue({
          id: s.id, source: s.source, title: s.title, artist: s.artist,
          album: s.album || '', saveDir, quality: s.quality || 'standard',
          cover: '', duration: 0,
        });
        tally[classifyRetryResult(r)] += 1;
      } catch (_e) {
        tally.fail += 1;
      }
    }
    showToast(retrySummary(tally), tally.added ? 'success' : 'warn', 5000);
    if (tally.added && typeof switchDlSubTab === 'function') switchDlSubTab('queue');
  } catch (e) {
    logger.warn('[history] 批量重试失败:', e.message);
    showToast('批量重试失败：' + errBrief(e), 'error');
  } finally {
    _retryAllBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ── 一键清理失效记录 ───────────────────────────────────
// 「记录还在、文件早没了」的成功记录是死账：✅ 是假的、▶ 点了报错、搜索页还顶着
// 「✔ 已下载」。判活和"什么算可删的死账"两条规则都在主进程 deadRefs.js（渲染层没有
// fs，且规则抄第二份必然漂移），这里只负责：问一声 → 送进既有 remove-history →
// 摘掉那些记录喂给徽标集合的键 → 重查。绝不碰磁盘上一个文件。
let _cleanDeadBusy = false;
const CLEAN_SCAN_LIMIT = 2000;

async function cleanDeadHistory() {
  if (_cleanDeadBusy) return;
  _cleanDeadBusy = true;
  const btn = document.getElementById('historyCleanBtn');
  if (btn) btn.disabled = true;
  try {
    // 无视当前状态页签（恒查 done，与「重试失败项」对称），但尊重关键词/来源筛选
    const q = buildHistoryQuery({ keyword: historyFilter, status: 'done', source: _historySource }, 0, CLEAN_SCAN_LIMIT);
    const r = await api.queryHistory({ ...q, markMissing: true });
    const dead = (r && r.deadEntries) || [];
    const checked = ((r && r.items) || []).length;
    if (!dead.length) {
      showToast(deadSummary(0, checked), 'info');
      return;
    }
    if (!await askConfirm(deadConfirmText(dead, checked))) return;
    const res = await api.removeHistory(dead);
    if (!res || typeof res.removed !== 'number') {
      showToast('清理失败', 'error');
      return;
    }
    // 徽标集合是启动时从历史表灌进来的，历史行删了它不会自己瘦
    dlForgetKeys(dead.map(d => songDlKey({ source: d.source, id: d.id })).filter(Boolean));
    historyPage = 0;
    loadHistory();
    showToast(deadSummary(res.removed, checked), res.removed ? 'success' : 'info', 5000);
  } catch (e) {
    logger.warn('[history] 清理失效记录失败:', e.message);
    showToast('清理失败：' + errBrief(e), 'error');
  } finally {
    _cleanDeadBusy = false;
    if (btn) btn.disabled = false;
  }
}

/**
 * 失效项批量重新下载（增量154）：「🧹 清理失效」的另一半意图 ——
 * 文件被我删了但歌还想听 ⇒ 一次扔回下载队列，而不是逐条点 🔄。
 * 与清理的两处刻意不同：① 不删记录（重下成功后 history.add 原地更新成新路径，
 * 中途失败也还留着线索）；② 不动徽标集合（这首歌本来就在被重新下载）。
 * 载荷不带 forceRedownload：确认到入队之间文件可能被同步盘放回来，
 * 那时主进程查重会跳过它（计成 had），覆盖式重下才是错的。
 */
let _redlDeadBusy = false;
async function redownloadDeadHistory() {
  if (_redlDeadBusy) return;
  _redlDeadBusy = true;
  try {
    const q = buildHistoryQuery({ keyword: historyFilter, status: 'done', source: _historySource }, 0, CLEAN_SCAN_LIMIT);
    const r = await api.queryHistory({ ...q, markMissing: true });
    const checked = ((r && r.items) || []).length;
    const dead = (r && r.deadEntries) || [];
    if (!dead.length) { showToast(deadSummary(0, checked), 'info'); return; }
    if (!await askConfirm(deadConfirmText(dead, checked, 'redownload'))) return;
    const saveDir = getState('saveDir');
    const tally = { added: 0, dup: 0, had: 0, fail: 0 };
    for (const d of dead) {
      const payload = enqueuePayloadFor(d, saveDir);
      if (!payload) { tally.fail += 1; continue; }
      try {
        const res = await api.addToQueue(payload);
        tally[classifyRetryResult(res)] += 1;
      } catch (_e) {
        tally.fail += 1;
      }
    }
    showToast(deadRetrySummary(tally), tally.added ? 'success' : 'info', 5000);
    if (tally.added) loadHistory(); // 页面上的 🚫 之外还多了「下载中」，列表得跟上
    if (tally.added && typeof switchDlSubTab === 'function') switchDlSubTab('queue');
  } catch (e) {
    logger.warn('[history] 失效项重新下载失败:', e.message);
    showToast('失效项重新下载失败：' + errBrief(e), 'error');
  } finally {
    _redlDeadBusy = false;
  }
}

function filterHistory() {
  const input = document.getElementById('historyFilter');
  historyFilter = input?.value?.trim() || '';
  historyPage = 0;
  loadHistory();
}

// 状态/来源筛选变更：回第 0 页重查（组合逻辑在 historyFilters.buildHistoryQuery）
function setHistoryStatusFilter(v) {
  _historyStatus = String(v || '');
  const tabsEl = document.getElementById('historyStatusTabs');
  if (tabsEl) {
    for (const b of tabsEl.querySelectorAll('button[data-hst]')) {
      b.classList.toggle('active', (b.dataset.hst || '') === _historyStatus);
    }
  }
  historyPage = 0;
  loadHistory();
}

function setHistorySourceFilter(v) {
  _historySource = String(v || '');
  historyPage = 0;
  loadHistory();
}

/** 排序档位是服务端 ORDER BY 白名单键，换档等于换查询 ⇒ 必回第 0 页重查 */
function cycleHistorySort() {
  _historySort = nextSortMode(_historySort);
  const btn = document.getElementById('historySortBtn');
  if (btn) btn.textContent = sortLabel(_historySort);
  historyPage = 0;
  loadHistory();
}

function _initHistoryFilterBar() {
  const tabsEl = document.getElementById('historyStatusTabs');
  if (tabsEl && !tabsEl.childElementCount) {
    tabsEl.innerHTML = HISTORY_STATUS_TABS.map(t =>
      `<button class="filter-tab ${t.v === '' ? 'active' : ''}" data-hst="${escAttr(t.v)}" onclick="setHistoryStatusFilter('${escQ(t.v)}')">${esc(t.label)}</button>`,
    ).join('')
      + `<button class="filter-tab" id="historySortBtn" onclick="cycleHistorySort()">${esc(sortLabel(_historySort))}</button>`;
  }
  const sel = document.getElementById('historySourceSel');
  if (sel && !sel.childElementCount) {
    const platforms = typeof getPlatforms === 'function' ? getPlatforms() : [];
    sel.innerHTML = sourceOptions(platforms).map(o =>
      `<option value="${esc(o.v)}">${esc(o.label)}</option>`,
    ).join('');
    sel.addEventListener('change', (e) => setHistorySourceFilter(e.target.value));
  }
}
_initHistoryFilterBar();

function historyPrevPage() {
  if (historyPage > 0) { historyPage--; loadHistory(); }
}

function historyNextPage() {
  // 受已知总页数钳制：翻到最后一页后再点不越界（否则可无限翻到空页）
  const lastPage = Math.max(0, (_historyTotalPages || 1) - 1);
  if (historyPage >= lastPage) return;
  historyPage = Math.min(historyPage + 1, lastPage);
  loadHistory();
}

async function clearAllHistory() {
  if (!await askConfirm('确认清空所有下载历史？')) return;
  try {
    await api.clearHistory();
  } catch (e) {
    showToast('清空失败：' + errBrief(e), 'error');
    return;
  }
  historyPage = 0;
  loadHistory();
  showToast('下载历史已清空', 'info');
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (_e) { return ''; }
}

// ▶ 本地播放：复用 download.js 桥接的 playDownloadedFile（两视图同属下载合并页，必同加载）
async function playHistoryItem(idx) {
  const s = _historyItems[idx];
  if (!s || !s.savePath) { showToast('未找到文件路径', 'error'); return; }
  if (typeof window.playDownloadedFile !== 'function') { showToast('播放模块未加载，请刷新重试', 'error'); return; }
  await window.playDownloadedFile(s);
}

// ── 行右键菜单 ────────────────────────────────────────
// 历史记录字段是下载任务子集，拼个歌曲形对象供收藏/加歌单复用
function _historySongLike(s) {
  return {
    id: s.id, source: s.source, title: s.title, artist: s.artist,
    album: s.album || '', cover: s.cover || '', duration: s.duration || 0,
  };
}

// 删除单条记录：只清历史行，磁盘文件与「已下载」徽标（assets 索引按文件存在性自愈）不受影响
async function deleteHistoryItem(idx) {
  const s = _historyItems[idx];
  if (!s || s.id == null) { showToast('无法删除：记录缺少标识', 'warn'); return; }
  try {
    const r = await api.removeHistory([{ id: s.id, source: s.source }]);
    if (!r || typeof r.removed !== 'number') { showToast('删除失败', 'error'); return; }
    // 删的是本页最后一条时回退一页，避免停在空页
    if (_historyItems.length <= 1 && historyPage > 0) historyPage--;
    loadHistory();
    showToast('记录已删除（不影响已下载的文件）', 'success');
  } catch (e) {
    logger.warn('[history] 删除失败:', e.message);
    showToast('删除失败：' + errBrief(e), 'error');
  }
}

function historyRowContext(e) {
  const row = e.target && e.target.closest ? e.target.closest('.history-row') : null;
  if (!row || !_historyDom.list || !_historyDom.list.contains(row)) return;
  const idx = Number(row.getAttribute('data-hidx'));
  const s = _historyItems[idx];
  if (!s) return;
  e.preventDefault();
  const items = [];
  if (s.status === 'done' && s.savePath && !s.missing) {
    items.push(
      { icon: '▶', label: '本地播放', onClick: () => playHistoryItem(idx) },
      { icon: '📂', label: '打开文件夹', onClick: () => openFolderSafe(s.savePath) },
    );
  }
  items.push({
    icon: s.status === 'error' ? '🔄' : '⬇', label: '重新下载',
    onClick: () => retryFromHistory(String(s.id), String(s.source || ''),
      s.title || '', s.artist || '', s.album || '', s.quality || 'standard'),
  });
  // 失败行紧跟一个诊断项（与队列侧右键同形）：重下解决不了 Cookie 过期这类根因
  if (s.status === 'error') {
    items.push({ icon: '🆘', label: '诊断失败原因', onClick: () => diagnoseHistoryItem(idx) });
  }
  if (s.id != null && s.source) {
    const songLike = _historySongLike(s);
    registerFavSong(songLike); // 让「收藏」切换能带回元数据（历史行没有红心按钮可登记）
    const on = isFavorite(songLike);
    items.push(
      { sep: true },
      { icon: on ? '💔' : '♥', label: on ? '取消收藏' : '收藏',
        onClick: () => toggleFavoriteByKey(favKey(s.source, s.id)) },
      { icon: '📋', label: '添加到歌单', onClick: () => {
        if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(songLike);
      } },
    );
  }
  items.push(
    { sep: true },
    { icon: '🗑', label: '删除记录', onClick: () => deleteHistoryItem(idx) },
  );
  showContextMenu(e.clientX, e.clientY, items);
}
document.addEventListener('contextmenu', historyRowContext);

// 导出到全局
// ── ES Module 导出 ──────────────────────────────────────
export {
  loadHistory,
  filterHistory,
  setHistoryStatusFilter,
  setHistorySourceFilter,
  cycleHistorySort,
  historyPrevPage,
  historyNextPage,
  clearAllHistory,
  retryFromHistory,
  diagnoseHistoryItem,
  playHistoryItem,
  exportHistoryM3u,
  deleteHistoryItem,
  retryFailedFromHistory,
  cleanDeadHistory,
  redownloadDeadHistory,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.loadHistory = loadHistory;
window.filterHistory = filterHistory;
window.setHistoryStatusFilter = setHistoryStatusFilter;
window.setHistorySourceFilter = setHistorySourceFilter;
window.cycleHistorySort = cycleHistorySort;
window.historyPrevPage = historyPrevPage;
window.historyNextPage = historyNextPage;
window.clearAllHistory = clearAllHistory;
window.retryFromHistory = retryFromHistory;
window.diagnoseHistoryItem = diagnoseHistoryItem;
window.playHistoryItem = playHistoryItem;
window.exportHistoryM3u = exportHistoryM3u;
window.retryFailedFromHistory = retryFailedFromHistory;
window.cleanDeadHistory = cleanDeadHistory;
window.redownloadDeadHistory = redownloadDeadHistory;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheHistoryDom();
