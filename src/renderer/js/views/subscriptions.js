/**
 * 订阅更新视图
 *
 * 「我的歌单」右侧新 tab：展示已订阅的歌单/歌手、各自未读新歌，
 * 支持立即检查、自动下载开关、批量入队。
 *
 * 数据来源：api.subscribeList（主进程 subscriptions 引擎），
 * 主进程检查完成后经 'subscriptions-updated' 事件推送最新列表。
 *
 * 与 playlist.js 同风格：挂在 window 上供 HTML onclick / app.js 调用。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener } from '../dlStatus.js';
import { subDlPayload, subDlPayloadList, subNewSongById, subActiveQueueDup } from '../subNewDl.js';

let _subsLoaded = false;
let _subList = [];

async function loadSubscriptions() {
  try {
    _subList = await api.subscribeList() || [];
    _subsLoaded = true;
    dlEnsureHistoryLoaded(); // 徽标的「已下载」来自跨会话历史，懒加载一次
    renderSubscriptionPage(_subList);
    updateSubBadge(_subList);
  } catch (e) {
    logger.warn('[subscriptions] 加载失败:', e.message);
  }
}

function initSubscriptionView() {
  loadSubscriptions();
}

// ── 渲染 ───────────────────────────────────────────────

function _subTypeLabel(e) {
  return e.type === 'playlist' ? '歌单' : '歌手';
}

function _fmtTime(ts) {
  if (!ts) return '从未检查';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSubscriptionPage(entries) {
  const wrap = document.getElementById('subList');
  if (!wrap) return;
  if (!entries.length) {
    wrap.innerHTML = `
      <div style="text-align:center;padding:48px 16px;color:var(--neon-dim);">
        <div style="font-size:36px;margin-bottom:12px;">📡</div>
        <div style="font-size:14px;margin-bottom:6px;">还没有订阅</div>
        <div style="font-size:12px;">打开任意歌单详情或歌手主页，点「订阅」即可在新歌发布时收到提醒</div>
      </div>`;
    return;
  }
  wrap.innerHTML = entries.map(e => {
    const unread = e.newCount || 0;
    const queue = getState('queueSnapshot') || [];
    return `
    <div class="sub-card ${unread ? 'sub-card-unread' : ''}">
      <div class="sub-card-head">
        <div class="sub-card-title">
          <span class="sub-kind">${_subTypeLabel(e)}</span>
          <span class="sub-name" title="${escAttr(e.name || e.targetId)}">${esc(e.name || e.targetId)}</span>
        </div>
        <div class="sub-card-actions">
          <button class="btn-sm" onclick="subscriptionRemove('${escQ(e.key)}')">退订</button>
        </div>
      </div>
      <div class="sub-card-meta">
        <span>${esc(e.platform)}</span>
        <span>上次检查: ${_fmtTime(e.lastCheckedAt)}</span>
        ${e.lastCheckError ? `<span class="sub-error">⚠ ${esc(e.lastCheckError)}</span>` : ''}
        ${!e.hasSeeded ? '<span class="sub-seeded">待首次检查</span>' : ''}
      </div>
      <label class="sub-auto">
        <input type="checkbox" ${e.autoDownload ? 'checked' : ''} onchange="subscriptionToggleAuto('${escQ(e.key)}', this.checked)">
        新歌自动下载
      </label>
      ${unread > 0 ? `
      <div class="sub-new">
        <div class="sub-new-head">
          <span>🆕 ${unread} 首新歌</span>
          <div class="sub-new-actions">
            <button class="btn-sm" onclick="subscriptionQueueNew('${escQ(e.key)}')">全部入队</button>
            <button class="btn-sm" onclick="subscriptionMarkSeen('${escQ(e.key)}')">已看完</button>
          </div>
        </div>
        <div class="sub-new-list">${(e.newSongs || []).slice(0, 10).map(s =>
          `<div class="sub-new-row"><span class="sub-new-title">${esc(s.title)}</span><span class="sub-new-artist">${esc(s.artist)}</span>${dlBadgeHtml(s, queue)}<button class="btn-sm sub-new-dl" title="加入下载队列" onclick="subscriptionDownloadNew('${escQ(e.key)}', '${escQ(String(s.id))}')">⬇</button></div>`
        ).join('')}${unread > 10 ? '<div class="sub-new-more">…另有 ' + (unread - 10) + ' 首</div>' : ''}</div>
      </div>` : ''}
    </div>`;
  }).join('');
}

function updateSubBadge(entries) {
  const badge = document.getElementById('subBadge');
  if (!badge) return;
  const n = (entries || []).reduce((sum, e) => sum + (e.newCount || 0), 0);
  badge.textContent = n > 99 ? '99+' : (n || '');
  badge.style.display = n > 0 ? '' : 'none';
}

// 下载队列状态变化 → 新歌行徽标（⬇下载中/✔已下载）实时刷新；300ms 防抖合并队列推送风暴
let _subRenderTimer = null;
addDlChangeListener(() => {
  if (!_subsLoaded) return;
  clearTimeout(_subRenderTimer);
  _subRenderTimer = setTimeout(() => renderSubscriptionPage(_subList), 300);
});

// ── 操作 ───────────────────────────────────────────────

/** 供歌单弹层 / 歌手主页的「订阅」按钮调用 */
async function subscriptionAdd(type, platform, targetId, name) {
  try {
    const r = await api.subscribeAdd(type, platform, String(targetId), name || '');
    if (r && r.success) {
      showToast(r.duplicated ? t('toast.subAlready') : t('toast.subDone', { name: name || targetId }), 'success');
      if (_subsLoaded) loadSubscriptions();
      return true;
    }
    showToast((r && r.error) || t('toast.subFailed'), 'error');
  } catch (e) {
    showToast(t('toast.subFailedDetail', { msg: errBrief(e) }), 'error');
  }
  return false;
}

async function subscriptionRemove(key) {
  const r = await api.subscribeRemove(key);
  if (r && r.success) {
    showToast(t('toast.unsubscribed'), 'info');
    loadSubscriptions();
  } else {
    showToast((r && r.error) || t('toast.unsubscribeFailed'), 'error');
  }
}

async function subscriptionToggleAuto(key, on) {
  await api.subscribeUpdate(key, { autoDownload: !!on });
  if (on) showToast(t('toast.autoDownloadOn'), 'info');
  loadSubscriptions();
}

async function subscriptionCheckNow() {
  const btn = document.getElementById('subCheckBtn');
  if (btn) { btn.disabled = true; btn.textContent = '检查中...'; }
  try {
    const r = await api.subscribeCheck();
    await loadSubscriptions();
    showToast(r && r.newTotal
      ? t('toast.subCheckFound', { count: r.newTotal })
      : t('toast.subCheckNone'), 'success');
  } catch (e) {
    showToast(t('toast.subCheckFailed', { msg: errBrief(e) }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即检查'; }
  }
}

async function subscriptionMarkSeen(key) {
  await api.subscribeMarkSeen(key);
  loadSubscriptions();
}

async function subscriptionQueueNew(key) {
  const entry = _subList.find(e => e.key === key);
  const songs = entry && entry.newSongs;
  if (!songs || !songs.length) return;
  const payload = { songs: subDlPayloadList(songs, getState('saveDir'), resolveQuality) };
  try {
    const r = await api.addPlaylistToQueue(payload);
    // 汇总串与 app.js 的批量入队出口同形：句子全在词典里，段间用语言中立的间隔号
    showToast(t('toast.batchQueued', {
      count: r.queued,
      extra: r.skippedDownloaded ? ' · ' + t('toast.skippedDownloaded', { count: r.skippedDownloaded }) : '',
    }), 'success');
  } catch (e) {
    showToast(t('toast.batchAddFailed', { msg: errBrief(e) }), 'error');
  }
}

/** 新歌行「⬇」逐首入队（语义与 downloadPlaylistSong 对齐，走既有 addToQueue 通道）。
 *  用 id 而非下标定位：主进程推送会整体替换 _subList，点击时列表可能已变 */
async function subscriptionDownloadNew(key, songId) {
  const entry = _subList.find(e => e.key === key);
  const song = subNewSongById(entry && entry.newSongs, songId);
  if (!song) { showToast(t('toast.subSongGone'), 'warn'); return; }
  const dup = subActiveQueueDup(getState('queueSnapshot'), song);
  if (dup) { showToast(t('toast.queueDup', { title: song.title }), 'warn', 2500); return; }
  const payload = subDlPayload(song, getState('saveDir'), resolveQuality);
  try {
    const r = await api.addToQueue(payload);
    if (r && r.duplicated) { showToast(t('toast.queueDup', { title: song.title }), 'warn', 2500); return; }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(song.title, r.finishedAt, () => {
        api.addToQueue({ ...payload, forceRedownload: true })
          .then(() => showToast(t('toast.queueAdded', { title: song.title }), 'success'))
          .catch(e => showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error'));
      });
      return;
    }
    if (r && r.queued) showToast(t('toast.queueAdded', { title: song.title }), 'success');
    else showToast((r && r.error) || t('toast.enqueueFailed'), 'error');
  } catch (e) {
    showToast(t('toast.enqueueFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

// ── 订阅按钮状态（歌单弹层 / 歌手主页）────────────────

function _isSubscribed(type, platform, targetId) {
  const key = `${type}:${platform}:${targetId}`;
  return _subList.some(e => e.key === key);
}

/** 弹层工具栏按钮：订阅当前打开的歌单（meta 由 openPlaylistModal 写入） */
async function subscribeCurrentPlaylist() {
  const meta = state.getPlaylistMeta && state.getPlaylistMeta();
  if (!meta || !meta.id) { showToast(t('toast.playlistMissing'), 'error'); return; }
  if (_subsLoaded && _isSubscribed('playlist', meta.platform, meta.id)) {
    showToast(t('toast.subPlaylistAlready'), 'info');
    return;
  }
  const ok = await subscriptionAdd('playlist', meta.platform, meta.id, meta.name);
  if (ok) {
    const btn = document.getElementById('plSubscribeBtn');
    if (btn) btn.classList.add('sub-on');
  }
}

/** 歌手主页头部按钮：订阅当前歌手 */
async function subscribeCurrentSinger() {
  const singer = state.get('currentSinger');
  if (!singer || !singer.mid) { showToast(t('toast.singerMissing'), 'error'); return; }
  const name = document.querySelector('.singer-detail-name');
  if (_subsLoaded && _isSubscribed('singer', singer.source, singer.mid)) {
    showToast(t('toast.subSingerAlready'), 'info');
    return;
  }
  await subscriptionAdd('singer', singer.source, singer.mid, name ? name.textContent.trim() : '');
}

// ── 事件接线（主进程检查完成 → 静默刷新）────────────────
// 必须等 app.js init() 里 buildApi 之后再调：模块 import 期 window.api 还不存在

let _eventsWired = false;
function wireSubscriptionEvents() {
  if (_eventsWired) return;
  const a = window.api;
  if (!a || typeof a.onSubscriptionsUpdated !== 'function') return;
  _eventsWired = true;
  a.onSubscriptionsUpdated(() => {
    // 任意窗口打开时都刷徽章；页面打开时顺带重渲染
    loadSubscriptions();
  });
}

// ── window 桥接 ────────────────────────────────────────
window.initSubscriptionView = initSubscriptionView;
window.loadSubscriptions = loadSubscriptions;
window.renderSubscriptionPage = renderSubscriptionPage;
window.updateSubBadge = updateSubBadge;
window.subscriptionAdd = subscriptionAdd;
window.subscriptionRemove = subscriptionRemove;
window.subscriptionToggleAuto = subscriptionToggleAuto;
window.subscriptionCheckNow = subscriptionCheckNow;
window.subscriptionMarkSeen = subscriptionMarkSeen;
window.subscriptionQueueNew = subscriptionQueueNew;
window.subscriptionDownloadNew = subscriptionDownloadNew;
window.subscribeCurrentPlaylist = subscribeCurrentPlaylist;
window.subscribeCurrentSinger = subscribeCurrentSinger;
window.wireSubscriptionEvents = wireSubscriptionEvents;
