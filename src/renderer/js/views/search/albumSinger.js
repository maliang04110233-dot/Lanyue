/**
 * 搜索视图 —— 歌手 / 专辑渲染与详情页
 *
 * 自 views/search.js 提出（等价迁移）：
 *   renderSingerList/renderSingerPagination（歌手列表）
 *   renderAlbumList/renderAlbumPagination（专辑列表）
 *   openAlbumDetail/downloadAlbum（专辑详情/整张下载）
 *   openSingerDetail/switchSingerDetail/loadSingerDetail/backToSearch（歌手详情）
 *
 * 与搜索主流程共享的可变状态由 search.js 在 setupAlbumSinger 注入：
 *   doSearch/renderSongList/updateBatchInfo/clearLoading/showLoadError —— 函数引用；
 *   setType(type)（_searchType 赋值）、resetDlList()（_dlLastList 置空）、
 *   isBatchMode()（_searchBatchMode 读）、nextReqId()（++_typeSearchReqId 取号）。
 * 请求序号必须是**同一个**自增变量：迟到的旧结果不得覆盖新视图的判据才成立。
 */

import { errBrief } from '../../errBrief.js';
import { logger } from '../../logger.js';
import { skeletonHtml, SKEL_ROWS } from '../../skeleton.js';

// 注入的交叉引用（setupAlbumSinger 赋值；体内保持 search.js 原文的裸名形态）
let doSearch, renderSongList, updateBatchInfo, clearLoading, showLoadError;
let setType, resetDlList, isBatchMode, nextReqId, peekReqId;

export function setupAlbumSinger(deps) {
  ({ doSearch, renderSongList, updateBatchInfo, clearLoading, showLoadError,
     setType, resetDlList, isBatchMode, nextReqId, peekReqId } = deps);
}

// ── 歌手渲染 ─────────────────────────────────────────
function renderSingerList(list) {
  // 非单曲视图：清空徽标重绘锚点。否则队列/屏蔽变化（:171/:179/:888/:893）会把
  // 本列表盖成上次的单曲搜索结果——四处重绘入口只判 `if (_dlLastList)`，不判视图类型。
  resetDlList();
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
  resetDlList(); // 非单曲视图：同上，防止被陈旧单曲列表覆盖
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
  const reqId = nextReqId();
  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 999);
    if (reqId !== peekReqId()) return;
    setState('songs', songs);
    setType('song');
    renderSongList(songs);
    document.getElementById('pagination').style.display = 'none';
    document.getElementById('batchToolbar').style.display = (songs.length && isBatchMode()) ? 'flex' : 'none';
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
  resetDlList(); // 歌手详情外壳（头部+页签）也是非单曲视图
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
  const reqId = nextReqId();
  try {
    if (tab === 'songs') {
      const songs = await api.getSingerSongs(singerMid, 50);
      if (reqId !== peekReqId()) return;
      setState('songs', songs);
      setType('song');
      renderSongList(songs, el);
      document.getElementById('batchToolbar').style.display = (songs.length && isBatchMode()) ? 'flex' : 'none';
      updateBatchInfo();
    } else {
      const result = await api.getSingerAlbums(singerMid, source, 1, 99);
      if (reqId !== peekReqId()) return;
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
  resetDlList(); // 退出歌手/专辑视图：锚点失效（有 kw 时 doSearch→renderSingerList 会再清一次）
  const kw = getState('currentKeyword');
  if (kw) {
    setType('singer');
    doSearch(1);
  } else {
    document.getElementById('songList').innerHTML = '';
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  renderSingerList,
  renderSingerPagination,
  renderAlbumList,
  renderAlbumPagination,
  openAlbumDetail,
  downloadAlbum,
  openSingerDetail,
  switchSingerTab,
  backToSearch,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.renderSingerList = renderSingerList;
window.renderSingerPagination = renderSingerPagination;
window.renderAlbumList = renderAlbumList;
window.renderAlbumPagination = renderAlbumPagination;
window.openAlbumDetail = openAlbumDetail;
window.downloadAlbum = downloadAlbum;
window.openSingerDetail = openSingerDetail;
window.switchSingerTab = switchSingerTab;
window.backToSearch = backToSearch;
