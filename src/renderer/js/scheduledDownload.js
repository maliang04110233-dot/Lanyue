/**
 * 定时下载 —— 「白天挂链接，夜里错峰自动入队」
 *
 * 任务 = 时间 + 多行分享链接，存 prefs 键 scheduledDownloads（跨重启存活，
 * 错过的时区点在下次心跳立即补跑）。到点执行 = 批量导入同款链路：
 * extractShareUrl → getSongByLink 解析（单曲/歌单/专辑展开）→ 逐条 addToQueue。
 * 纯渲染层编排，零新增 IPC；心跳 30s 一次，解析串行防止网络风暴。
 */

import { logger } from './logger.js';
import { extractShareUrl, resolveShareLine } from './views/batchImport.js';

const MAX_JOBS = 20;        // 同时挂起的定时任务上限
const MAX_LINES = 50;       // 与批量导入同口径
const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000; // 最远只接受 30 天内

// ── 纯函数（node 可单测） ─────────────────────────────
/** datetime-local 值 → 毫秒时点；必须落在 (now, now+30天]，非法返回 null */
function parseScheduleAt(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = new Date(value.trim()).getTime();
  if (!Number.isFinite(at)) return null;
  if (at <= now || at > now + MAX_AHEAD_MS) return null;
  return at;
}

function dueItems(items, now) {
  if (!Array.isArray(items)) return [];
  return items.filter(x => x && typeof x.at === 'number' && x.at <= now);
}

function sortJobs(items) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => a.at - b.at);
}

function fmtJobTime(at) {
  const d = new Date(at);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 任务状态（惰性从 prefs 读，变更即写回） ──────────
let _jobs = null; // null = 尚未加载
let _loading = false;
let _ticking = false;

function _ensureLoaded() {
  if (_jobs !== null || _loading) return;
  _loading = true;
  Promise.resolve()
    .then(() => window.api.getPref('scheduledDownloads'))
    .then(v => {
      _jobs = Array.isArray(v)
        ? v.filter(x => x && typeof x.at === 'number' && Array.isArray(x.lines)).slice(0, MAX_JOBS)
        : [];
      _render();
    })
    .catch(e => { logger.warn('[scheduled] 读取定时任务失败:', e && e.message); _jobs = []; })
    .finally(() => { _loading = false; });
}

function _persist() {
  if (_jobs === null) return;
  window.api.setPref('scheduledDownloads', _jobs)
    .catch(e => logger.warn('[scheduled] 保存定时任务失败:', e && e.message));
}

// ── 到点执行 ─────────────────────────────────────────
async function _fireJob(job) {
  let queued = 0, skipped = 0, failed = 0;
  const seen = new Set();
  for (const line of (job.lines || []).slice(0, MAX_LINES)) {
    try {
      const songs = await resolveShareLine(extractShareUrl(line));
      for (const s of (songs || [])) {
        const key = `${s.id}|${s.source}`;
        if (!s.id || !s.source || seen.has(key)) { skipped++; continue; }
        seen.add(key);
        try {
          const r = await window.api.addToQueue({
            ...s,
            saveDir: typeof getState === 'function' ? getState('saveDir') : undefined,
            quality: typeof resolveQuality === 'function' ? resolveQuality(s.source) : undefined,
          });
          if (r && r.queued) queued++;
          else skipped++;
        } catch (e) {
          logger.warn('[scheduled] 入队失败:', s.title, e && e.message);
          failed++;
        }
      }
      if (!songs || !songs.length) failed++;
    } catch (e) {
      logger.warn('[scheduled] 行解析失败:', e && e.message);
      failed++;
    }
  }
  const parts = [`✅ 已入队 ${queued}`];
  if (skipped) parts.push(`跳过 ${skipped}`);
  if (failed) parts.push(`失败 ${failed}`);
  try { showToast(`⏰ 定时任务（${fmtJobTime(job.at)}）完成：${parts.join(' · ')}`, queued ? 'success' : 'warn', 5000); } catch (_e) { /* 窗口已关 */ }
}

async function _tick() {
  if (_jobs === null) { _ensureLoaded(); return; }
  if (_ticking) return;
  const due = dueItems(_jobs, Date.now());
  if (!due.length) return;
  _ticking = true;
  try {
    const dueSet = new Set(due);
    _jobs = _jobs.filter(x => !dueSet.has(x));
    _persist();
    _render();
    for (const job of sortJobs(due)) await _fireJob(job);
  } catch (e) {
    logger.warn('[scheduled] 定时执行异常:', e && e.message);
  } finally {
    _ticking = false;
  }
}

// ── 弹层 UI ──────────────────────────────────────────
function _ensureOverlay() {
  let el = document.getElementById('scheduledOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'scheduledOverlay';
  el.className = 'edit-overlay hidden';
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'closeScheduledPanel');
  el.innerHTML = `
    <div class="edit-panel" style="width:560px;">
      <div class="edit-header">
        <span class="edit-title">⏰ 定时下载</span>
        <button class="edit-close" onclick="closeScheduledPanel()" data-ico="x" data-ico-only aria-label="关闭"></button>
      </div>
      <div class="edit-body">
        <div class="sched-row">
          <span class="sched-label">执行时间</span>
          <input type="datetime-local" id="schedWhen" class="edit-input sched-when">
        </div>
        <textarea id="schedLinks" class="edit-input batch-import-text" rows="5"
          placeholder="每行一条分享链接或带链接的分享文案（最多 ${MAX_LINES} 行）&#10;到点自动解析入队：单曲直接加；歌单 / 专辑展开全部曲目"></textarea>
        <div class="batch-import-status" id="schedStatus"></div>
        <div class="sched-list-title">已挂起的定时任务（按时间排序）</div>
        <div class="sched-list" id="schedList"></div>
      </div>
      <div class="edit-footer">
        <button class="edit-btn-cancel" onclick="closeScheduledPanel()">关闭</button>
        <button class="edit-btn-save" onclick="addScheduledJob()">⏰ 定时执行</button>
      </div>
    </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeScheduledPanel(); });
  document.body.appendChild(el);
  return el;
}

function _setStatus(text) {
  const el = document.getElementById('schedStatus');
  if (el) el.textContent = text || '';
}

function _renderList() {
  const box = document.getElementById('schedList');
  if (!box) return;
  box.textContent = '';
  for (const job of sortJobs(_jobs || [])) {
    const row = document.createElement('div');
    row.className = 'sched-job';
    const time = document.createElement('span');
    time.className = 'sched-job-time';
    time.textContent = fmtJobTime(job.at);
    const info = document.createElement('span');
    info.className = 'sched-job-lines';
    info.textContent = `${(job.lines || []).length} 条链接 · ${(job.lines || [])[0] || ''}`;
    const del = document.createElement('button');
    del.className = 'sched-job-del';
    del.textContent = '✕ 移除';
    del.addEventListener('click', () => removeScheduledJob(job.id));
    row.appendChild(time);
    row.appendChild(info);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function _render() {
  _renderList();
  const badge = document.getElementById('scheduledBadge');
  if (badge) badge.textContent = _jobs && _jobs.length ? ` (${_jobs.length})` : '';
}

function openScheduledPanel() {
  _ensureLoaded();
  const el = _ensureOverlay();
  el.classList.remove('hidden');
  _render();
}

function closeScheduledPanel() {
  const el = document.getElementById('scheduledOverlay');
  if (el) el.classList.add('hidden');
  _setStatus('');
}

function addScheduledJob() {
  _ensureLoaded();
  const whenEl = document.getElementById('schedWhen');
  const linksEl = document.getElementById('schedLinks');
  const at = parseScheduleAt(whenEl ? whenEl.value : '');
  const lines = (linksEl ? linksEl.value : '')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_LINES);
  if (!at) { _setStatus('请选择未来 30 天内的执行时间'); return; }
  if (!lines.length) { _setStatus('至少填一条链接'); return; }
  if (_jobs && _jobs.length >= MAX_JOBS) { _setStatus(`最多同时挂起 ${MAX_JOBS} 个定时任务`); return; }
  _jobs = (_jobs || []).concat([{ id: 'sj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at, lines }]);
  _persist();
  _render();
  _setStatus('');
  if (whenEl) whenEl.value = '';
  if (linksEl) linksEl.value = '';
  showToast(`⏰ 已挂起：${fmtJobTime(at)} 自动入队 ${lines.length} 条链接`, 'info', 3000);
}

function removeScheduledJob(id) {
  if (!_jobs) return;
  _jobs = _jobs.filter(x => x.id !== id);
  _persist();
  _render();
}

// ── 心跳与桥接（api 在 app.js 里后于本模块定义，故只挂定时器，加载留给首次 tick） ──
if (typeof document !== 'undefined') setInterval(_tick, 30000);

window.openScheduledPanel = openScheduledPanel;
window.closeScheduledPanel = closeScheduledPanel;
window.addScheduledJob = addScheduledJob;
window.removeScheduledJob = removeScheduledJob;

export { parseScheduleAt, dueItems, sortJobs, fmtJobTime, MAX_JOBS, MAX_LINES, MAX_AHEAD_MS };
