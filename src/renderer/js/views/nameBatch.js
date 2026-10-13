/**
 * 按歌名批量智能导入 —— 「粘一列『歌手 - 歌名』，逐行搜歌、预览勾选、一键入队」
 *
 * 批量链接导入（batchImport.js）要求每行都是链接；但用户手里常常只有一列
 * 歌单文本（笔记/聊天记录里的清单）。这里对每行按「歌手 - 歌名」解析，
 * 走既有 searchMusic('all') 聚合搜索取前几个候选，弹层预览：默认按纯函数
 * 评分选最佳命中，可勾选/换一换（🔄 在候选间循环），确认后逐条 addToQueue。
 * 全部本地编排、无新增 IPC —— 复用 searchMusic / addToQueue / resolveQuality。
 */

import { errBrief } from '../errBrief.js';
import { normKey } from '../songGroups.js';
import { parseM3u } from '../m3uImport.js';
// 转义取用：零依赖兜底模块，避免「全局 esc 尚未挂上」时退化成恒等函数
import { escSafe } from '../escapeFallback.js';
// resolveQuality 走 quality.js 挂载的 window 全局（同 batchImport.js 约定），
// 避免 node 测试环境经 logger.js 顶层 window 炸链

const MAX_NAMES = 30;   // 逐行走网络搜索，防无界排队
const CAND_POOL = 5;    // 每行保留的候选数（换一换循环）

/** 一行「01. 歌手 - 歌名 [flac]」→ {artist, title, raw}；无分隔符时整行按歌名 */
export function parseTrackLine(line) {
  const s = String(line == null ? '' : line).trim()
    .replace(/^\d{1,3}\s*[.、)．]\s*/, '')
    .replace(/\.(flac|mp3|m4a|wav|ogg)$/i, '');
  const parts = s.split(/\s[-–—－]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), raw: s };
  }
  return { artist: '', title: s, raw: s };
}

/**
 * 候选评分选最佳：3=标题且歌手精确一致，1=标题精确但歌手不同（或模糊包含），
 * 0=其他。并列取搜索排序靠前（先出现）的。返回 {idx, score}，idx 恒 ≥0。
 */
export function pickBestMatch(cands, title, artist) {
  const wantTitle = normKey(title, '');
  // 注意：normKey('','') 返回 '|' 而非空串，须先判原始 artist 是否给出
  const wantArtist = String(artist == null ? '' : artist).trim() ? normKey(artist, '') : '';
  let best = { idx: -1, score: -1 };
  (cands || []).forEach((c, i) => {
    if (!c || c.id == null) return;
    const ct = normKey(c.title, '');
    const ca = normKey(c.artist, '');
    let sc = 0;
    if (wantTitle && ct === wantTitle) sc = (!wantArtist || ca === wantArtist) ? 3 : 1;
    else if (wantTitle && ct && (ct.includes(wantTitle) || wantTitle.includes(ct))) sc = 1;
    if (sc > best.score) best = { idx: i, score: sc };
  });
  if (best.idx < 0) best = { idx: 0, score: 0 };
  return best;
}

// ── 弹层 ──────────────────────────────────────────────
let _rows = [];      // [{artist, title, raw, cands, sel, score}]
let _searching = false;

function _ensureOverlay() {
  let el = document.getElementById('nameBatchOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'nameBatchOverlay';
  el.className = 'edit-overlay hidden';
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'closeNameBatch');
  el.innerHTML = `
    <div class="edit-panel" style="width:560px;">
      <div class="edit-header">
        <span class="edit-title">🎤 按歌名批量导入</span>
        <button class="edit-close" onclick="closeNameBatch()">✕</button>
      </div>
      <div class="edit-body">
        <textarea id="nameBatchText" class="edit-input batch-import-text" rows="6"
          placeholder="每行一首「歌手 - 歌名」（也支持纯歌名 / 带序号 / 带格式后缀），最多 ${MAX_NAMES} 行&#10;逐行搜索匹配后预览，可勾选、🔄 换一换候选"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="edit-btn-cancel" id="nameBatchSearchBtn" onclick="runNameBatchSearch()">🔍 搜索匹配</button>
          <button class="edit-btn-cancel" id="m3uImportBtn" title="选择 .m3u/.m3u8 文件，解析出歌单行后自动开始匹配">📁 导入 m3u 文件</button>
          <input type="file" id="m3uFileInput" accept=".m3u,.m3u8,.txt" style="display:none;">
        </div>
        <div class="batch-import-status" id="nameBatchStatus"></div>
        <div id="nameBatchRows" style="max-height:320px;overflow:auto;margin-top:6px;"></div>
      </div>
      <div class="edit-footer">
        <button class="edit-btn-cancel" onclick="closeNameBatch()">取消</button>
        <button class="edit-btn-save" id="nameBatchGoBtn" onclick="enqueueNameBatch()" disabled>⬇ 入队选中歌曲</button>
      </div>
    </div>`;
  el.addEventListener('click', (e) => { if (e.target === el && !_searching) closeNameBatch(); });
  // m3u 导入走渲染层原生 <input type=file>+FileReader 即可读用户选中的文本文件，
  // 不必新增主进程文件选择/读取 IPC
  el.querySelector('#m3uImportBtn').addEventListener('click', () => {
    el.querySelector('#m3uFileInput').click();
  });
  el.querySelector('#m3uFileInput').addEventListener('change', (e) => _onM3uFilePicked(e.target));
  document.body.appendChild(el);
  return el;
}

async function _onM3uFilePicked(input) {
  const file = input.files && input.files[0];
  input.value = ''; // 复位以便重选同一文件
  if (!file || _searching) return;
  try {
    const text = await file.text();
    const names = parseM3u(text, MAX_NAMES);
    if (!names.length) { showToast('没从歌单里解析出可识别的歌曲行', 'warn', 2500); return; }
    const ta = document.getElementById('nameBatchText');
    if (ta) ta.value = names.join('\n');
    showToast(`📁 「${file.name}」解析出 ${names.length} 首，开始匹配`, 'info', 2200);
    runNameBatchSearch();
  } catch (e) {
    showToast('读取歌单文件失败: ' + errBrief(e), 'error');
  }
}

function _setStatus(text) {
  const el = document.getElementById('nameBatchStatus');
  if (el) el.textContent = text || '';
}

function _esc(s) { return escSafe(s); }
function _srcName(src) { return typeof srcLabel === 'function' ? srcLabel(src) : String(src || ''); }
function _dur(sec) { return typeof fmtDuration === 'function' ? fmtDuration(sec) : (sec ? Math.round(sec) + 's' : '—'); }

function _scoreTag(sc) {
  return sc === 3 ? '✓ 完全一致' : sc === 1 ? '≈ 近似' : '· 按搜索顺序';
}

function _renderRows() {
  const box = document.getElementById('nameBatchRows');
  if (!box) return;
  box.innerHTML = _rows.map((r, i) => {
    const c = r.cands[r.sel] || r.cands[0];
    const hit = c ? `<b>${_esc(c.title)}</b> - ${_esc(c.artist)}（${_esc(_srcName(c.source))} · ${_dur(c.duration)} · ${_scoreTag(r.score)}）` : '未命中';
    const cyc = r.cands.length > 1 ? `<button class="btn-sm" title="换一个候选（共 ${r.cands.length} 个）" onclick="cycleNameBatchCand(${i})">🔄</button>` : '';
    return `
    <div class="sched-job" style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid var(--stroke-1);">
      <input type="checkbox" id="nbChk_${i}" ${c && r.checked !== false ? 'checked' : ''} ${c ? '' : 'disabled'} style="margin-top:4px;" onchange="_nbSetCheck(${i}, this.checked)">
      <div class="sched-job-lines" style="flex:1;min-width:0;">
        <div style="font-size:12px;">${hit}</div>
        <div style="font-size:11px;color:var(--text-dim,#8b93a7);">原始行：${_esc(r.raw)}</div>
      </div>
      ${cyc}
    </div>`;
  }).join('');
  const go = document.getElementById('nameBatchGoBtn');
  if (go) go.disabled = !_rows.some(r => r.cands.length);
}

/** 勾选态回写行对象：换一换会全量重绘，DOM 态不落数据就会被复位 */
function _nbSetCheck(i, checked) {
  if (_rows[i]) _rows[i].checked = checked;
}

function openNameBatch() {
  const el = _ensureOverlay();
  el.classList.remove('hidden');
  _rows = [];
  _setStatus('');
  const box = document.getElementById('nameBatchRows');
  if (box) box.innerHTML = '';
  const go = document.getElementById('nameBatchGoBtn');
  if (go) go.disabled = true;
  const ta = document.getElementById('nameBatchText');
  if (ta) setTimeout(() => ta.focus(), 50);
}

function closeNameBatch() {
  if (_searching) return;
  const el = document.getElementById('nameBatchOverlay');
  if (el) el.classList.add('hidden');
}

async function runNameBatchSearch() {
  if (_searching) return;
  const ta = document.getElementById('nameBatchText');
  const lines = (ta ? ta.value : '').split(/\r?\n/)
    .map(l => l.trim()).filter(Boolean).slice(0, MAX_NAMES);
  if (!lines.length) { showToast('请先粘贴至少一行歌名', 'warn', 2500); return; }
  _searching = true;
  const btn = document.getElementById('nameBatchSearchBtn');
  if (btn) btn.disabled = true;
  _rows = [];
  for (let i = 0; i < lines.length; i++) {
    _setStatus(`搜索中 ${i + 1}/${lines.length}：${lines[i]}`);
    const { artist, title, raw } = parseTrackLine(lines[i]);
    let cands = [];
    try {
      const r = await api.searchMusic(raw, 'all', 1);
      const songs = (r && r.songs) || [];
      cands = songs.slice(0, CAND_POOL);
    } catch (e) {
      cands = []; // 网络失败：本行未命中，不重试不猜
    }
    const pick = pickBestMatch(cands, title, artist);
    _rows.push({
      artist, title, raw,
      cands: cands.length ? cands : [],
      sel: cands.length ? pick.idx : 0,
      score: cands.length ? pick.score : 0,
    });
  }
  _setStatus('');
  if (btn) btn.disabled = false;
  _searching = false;
  _renderRows();
  const miss = _rows.filter(r => !r.cands.length).length;
  showToast(miss ? `匹配完成：${_rows.length - miss} 首有候选，${miss} 首未命中` : `匹配完成：${_rows.length} 首全部有候选`, miss ? 'warn' : 'success', 3000);
}

function cycleNameBatchCand(i) {
  const r = _rows[i];
  if (!r || r.cands.length < 2) return;
  r.sel = (r.sel + 1) % r.cands.length;
  // 换候选后评分按该行目标重算，提示语跟手
  const c = r.cands[r.sel];
  const re = pickBestMatch([c], r.title, r.artist);
  r.score = re.score;
  _renderRows();
}

async function enqueueNameBatch() {
  const saveDir = getState('saveDir');
  const inFlight = new Set((getState('queueSnapshot') || [])
    .filter(q => q.status !== 'done')
    .map(q => `${q.id}|${q.source}`));
  const seen = new Set();
  let queued = 0, dup = 0, skip = 0, errored = 0;
  for (let i = 0; i < _rows.length; i++) {
    const r = _rows[i];
    const c = r.cands[r.sel];
    if (!c) continue;
    const chk = document.getElementById('nbChk_' + i);
    if (chk && !chk.checked) { skip++; continue; }
    const key = `${c.id}|${c.source}`;
    if (seen.has(key) || inFlight.has(key)) { dup++; continue; }
    seen.add(key);
    try {
      const res = await api.addToQueue({ ...c, saveDir, quality: resolveQuality(c.source) });
      if (res && res.queued) queued++;
      else if (res && (res.alreadyDownloaded || res.duplicated)) dup++;
      else errored++;
    } catch (e) {
      errored++;
    }
  }
  const parts = [`✅ 已加入 ${queued} 首`];
  if (dup) parts.push(`重复/已下载 ${dup}`);
  if (skip) parts.push(`未勾选 ${skip}`);
  if (errored) parts.push(`失败 ${errored}`);
  showToast(parts.join(' · '), queued ? 'success' : 'warn', 4500);
  if (queued) closeNameBatch();
}

// ── window 桥接 ───────────────────────────────────────
if (typeof document !== 'undefined') {
  window.openNameBatch = openNameBatch;
  window.closeNameBatch = closeNameBatch;
  window.runNameBatchSearch = runNameBatchSearch;
  window.cycleNameBatchCand = cycleNameBatchCand;
  window._nbSetCheck = _nbSetCheck;
  window.enqueueNameBatch = enqueueNameBatch;
  window.openM3uImport = function () {
    openNameBatch();
    const fi = document.getElementById('m3uFileInput');
    if (fi) fi.click();
  };
}
