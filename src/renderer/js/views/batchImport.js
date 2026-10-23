/**
 * 批量链接导入 —— 「粘一整列分享文案，一次全部入队」
 *
 * 弹层接受多行文本（每行一条分享链接/文案），逐行走剪贴板识别同款
 * getSongByLink 链路：
 *   单曲 → 直接解析出歌曲；
 *   网易云歌单 / 任意平台专辑链接 → 展开全部曲目；
 *   其余（短链、不支持的平台歌单）计为跳过，不猜不重试。
 * 汇总去重（批内 id|source + 队列在途任务）后逐条 addToQueue，
 * 全部本地编排、无新增 IPC —— 复用既有契约方法。
 */

import { logger } from '../logger.js';

const MAX_LINES = 50;     // 单次上限：逐条走网络解析，防止无界排队
const LIST_LIMIT = 300;   // 单个歌单/专辑展开上限

let _running = false;

function _ensureOverlay() {
  let el = document.getElementById('batchImportOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'batchImportOverlay';
  el.className = 'edit-overlay hidden';
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'closeBatchImport');
  el.innerHTML = `
    <div class="edit-panel" style="width:520px;">
      <div class="edit-header">
        <span class="edit-title">📥 批量链接导入</span>
        <button class="edit-close" onclick="closeBatchImport()" data-ico="x" data-ico-only aria-label="关闭"></button>
      </div>
      <div class="edit-body">
        <textarea id="batchImportText" class="edit-input batch-import-text" rows="8"
          placeholder="每行一条分享链接或带链接的分享文案（最多 ${MAX_LINES} 行）&#10;单曲直接入队；网易云歌单 / 专辑链接展开全部曲目"></textarea>
        <div class="batch-import-status" id="batchImportStatus"></div>
      </div>
      <div class="edit-footer">
        <button class="edit-btn-cancel" onclick="closeBatchImport()">取消</button>
        <button class="edit-btn-save" id="batchImportGoBtn" onclick="runBatchImport()">⬇ 解析并全部入队</button>
      </div>
    </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeBatchImport(); });
  document.body.appendChild(el);
  return el;
}

function openBatchImport() {
  const el = _ensureOverlay();
  el.classList.remove('hidden');
  _setStatus('');
  const ta = document.getElementById('batchImportText');
  if (ta) setTimeout(() => ta.focus(), 50);
}

function closeBatchImport() {
  if (_running) return; // 解析进行中不允许背景关闭
  const el = document.getElementById('batchImportOverlay');
  if (el) el.classList.add('hidden');
}

function _setStatus(text) {
  const el = document.getElementById('batchImportStatus');
  if (el) el.textContent = text || '';
}

/** 每行提取首个链接式片段：分享文案前后缀中文噪声按 URL 切出 */
function _extractUrl(line) {
  const m = line.match(/https?:\/\/\S+/);
  return m ? m[0] : line;
}

/** 一行链接 → 歌曲数组（可能为空数组=解析失败；抛异常=网络失败） */
async function _resolveLine(line) {
  const r = await api.getSongByLink(line);
  if (r && r.song) return [r.song];
  const link = r && r.link;
  if (!link) return [];
  if (link.type === 'album') {
    const songs = await api.getAlbumSongs(link.platform, link.id, LIST_LIMIT);
    return songs || [];
  }
  if (link.type === 'playlist' && link.platform === 'netease') {
    const songs = await api.getPlaylistSongs(link.platform, link.id, LIST_LIMIT);
    return songs || [];
  }
  return []; // 不支持的平台歌单/短链：计跳过
}

async function runBatchImport() {
  if (_running) return;
  const ta = document.getElementById('batchImportText');
  const lines = (ta ? ta.value : '').split(/\r?\n/)
    .map(l => l.trim()).filter(Boolean).slice(0, MAX_LINES);
  if (!lines.length) { showToast('请先粘贴至少一行链接', 'warn', 2500); return; }

  _running = true;
  const goBtn = document.getElementById('batchImportGoBtn');
  if (goBtn) goBtn.disabled = true;

  // ── 阶段 1：逐行解析 ──────────────────────────────
  const resolved = [];
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    _setStatus(`识别中 ${i + 1}/${lines.length}…`);
    try {
      const songs = await _resolveLine(_extractUrl(lines[i]));
      if (songs.length) resolved.push(...songs);
      else failed++;
    } catch (e) {
      logger.warn('[batchImport] 行解析失败:', e && e.message);
      failed++;
    }
  }

  // ── 阶段 2：去重 ─────────────────────────────────
  const seen = new Set();
  const inFlight = new Set((getState('queueSnapshot') || [])
    .filter(q => q.status !== 'done')
    .map(q => `${q.id}|${q.source}`));
  const toAdd = [];
  let dup = 0;
  for (const s of resolved) {
    const key = `${s.id}|${s.source}`;
    if (!s.id || !s.source || seen.has(key) || inFlight.has(key)) { dup++; continue; }
    seen.add(key);
    toAdd.push(s);
  }

  if (!toAdd.length) {
    showToast(`没有可入队的歌曲${failed ? `（${failed} 行无法识别）` : ''}${dup ? `（${dup} 首重复/已在队列）` : ''}`, 'warn', 4000);
    _running = false;
    if (goBtn) goBtn.disabled = false;
    _setStatus('');
    return;
  }

  // ── 阶段 3：逐条入队 ─────────────────────────────
  const saveDir = getState('saveDir');
  let queued = 0, already = 0, errored = 0;
  for (let i = 0; i < toAdd.length; i++) {
    const s = toAdd[i];
    _setStatus(`入队中 ${i + 1}/${toAdd.length}：${s.title || ''}`);
    try {
      const r = await api.addToQueue({ ...s, saveDir, quality: resolveQuality(s.source) });
      if (r && r.queued) queued++;
      else if (r && (r.alreadyDownloaded || r.duplicated)) already++;
      else errored++;
    } catch (e) {
      logger.warn('[batchImport] 入队失败:', s.title, e && e.message);
      errored++;
    }
  }

  _running = false;
  if (goBtn) goBtn.disabled = false;
  _setStatus('');
  const parts = [`✅ 已加入 ${queued} 首`];
  if (dup) parts.push(`重复 ${dup}`);
  if (already) parts.push(`已下载过 ${already}`);
  if (failed) parts.push(`无法识别 ${failed} 行`);
  if (errored) parts.push(`失败 ${errored}`);
  showToast(parts.join(' · '), queued ? 'success' : 'warn', 5000);
  if (queued) closeBatchImport();
}

// ── window 桥接 ───────────────────────────────────────
window.openBatchImport = openBatchImport;
window.closeBatchImport = closeBatchImport;
window.runBatchImport = runBatchImport;

// 定时下载（scheduledDownload.js）复用同一识别链路
export { _extractUrl as extractShareUrl, _resolveLine as resolveShareLine };
