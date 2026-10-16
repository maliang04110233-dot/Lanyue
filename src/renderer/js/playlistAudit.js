/**
 * 歌单语义运维界面（候选方向 3）
 *
 * 从歌单详情弹窗的「🧬 修」进入。给一个**已经存在**的歌单做体检：
 * 主进程一次性出网 → AI 逐首给契合度(fit)与建议动作(suggest) + 歌单级建议
 * （新名字/新描述/总评）。
 *
 * 三条纪律（与智能歌单同一批，这里是"修"不是"挑"）：
 *   ① 应用按钮里只调用 api.removeFromUserPlaylist 与 saveUserPlaylist(改名/描述)，
 *      都是既有通道，不新增写接口；"挪走"不自动执行（目标歌单得用户自己选），
 *      只显示成一行提示。
 *   ② 模型给的名字/描述/理由都含自由文本，一律 textContent 上屏（不进 innerHTML）。
 *   ③ 主进程只发 ASCII 令牌，文案在渲染层词典 —— ERR_KEYS 覆盖每个会发的令牌。
 *
 * 为什么建议动作只做「移除 + 改名」这两个按钮，而"挪走"不落按钮：
 * 挪到哪个歌单是用户意图，AI 只该建议不该决定；真要挪，用现有按钮
 * （复制到别单 + 从本单移除）两步就能办，不值得再开一条写通道。
 */

import { t } from './i18n.js';
import { errBrief } from './errBrief.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirmDialog.js';
import { providerErrText } from './aiProviderPanel.js';
import { logger } from './logger.js';
import { getState } from './state.js';

const FIT_META = {
  high: { cls: 'plA-fitHigh', label: 'plAudit.fitHigh' },
  mid: { cls: 'plA-fitMid', label: 'plAudit.fitMid' },
  low: { cls: 'plA-fitLow', label: 'plAudit.fitLow' },
};
const SUGGEST_META = {
  keep: { cls: 'plA-sugKeep', label: 'plAudit.sugKeep' },
  move: { cls: 'plA-sugMove', label: 'plAudit.sugMove' },
  remove: { cls: 'plA-sugRemove', label: 'plAudit.sugRemove' },
};

// 主进程会发的令牌，每个都要在这里有文案（漏一个用户看到的就是大写字母）
const ERR_KEYS = {
  EMPTY: 'plAudit.errEmpty',
  PLAYLIST_NOT_FOUND: 'plAudit.errNoPlaylist',
  NO_KEY: 'plAudit.errNoKey',
  NO_CANDIDATES: 'plAudit.errNoCandidates',
  NO_AUDIT: 'plAudit.errNoAudit',
  LLM_FAILED: 'plAudit.errLlmFailed',
};

let _auditEl = null;    // 面板根节点
let _playlistId = null;
let _candidates = [];   // 歌单原样候选（n → {title,artist}），模型回复不含标题
let _rows = [];         // [{n, title, artist, fit, reason, suggest, checked}]
let _busy = false;

function _el(id) { return document.getElementById(id); }

/** 序号 → 候选（歌单原样的标题/歌手，不来自模型回复） */
function _candidateByN(n) {
  return _candidates.find((c) => c.n === n) || null;
}

function _errText(code) {
  const k = ERR_KEYS[code];
  if (k) return t(k);
  return providerErrText(code, t('plAudit.errLlmFailed'));
}

function _ensurePanel() {
  if (_auditEl) return _auditEl;
  const div = document.createElement('div');
  div.id = 'plAuditModal';
  div.className = 'playlist-modal-overlay hidden';
  // ⑪ 动态浮层自报钉：造 overlay/modal 挂 body 必须自报守卫身份，
  // 否则这个面板开着时 Space 全局播放/暂停等背景键会漏过
  div.setAttribute('data-modal', '');
  div.setAttribute('data-modal-close', 'closePlAudit');
  div.onclick = (e) => { if (e.target === div) closePlAudit(); };
  div.innerHTML = `
    <div class="playlist-modal" style="min-width:520px;max-width:680px;max-height:82vh;display:flex;flex-direction:column;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">🧬 歌单体检</span>
        <button class="playlist-modal-close" onclick="closePlAudit()">✕</button>
      </div>
      <div class="playlist-modal-body" style="display:flex;flex-direction:column;gap:10px;padding:14px 16px;">
        <div id="plAuditGoalRow" style="display:flex;gap:8px;align-items:center;">
          <input type="text" class="setting-input" id="plAuditPrompt" maxlength="200"
            placeholder="选填：这次想解决什么（如：中段有几首跑题）" style="flex:1;min-width:0;">
          <button class="btn-primary" id="plAuditRunBtn" onclick="runPlAudit()">🔎 体检</button>
        </div>
        <div id="plAuditStatus" class="setting-hint" style="font-size:12px;color:var(--neon-dim);"></div>
        <div id="plAuditResult" style="display:none;flex-direction:column;gap:10px;">
          <div id="plAuditSuggest" style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;"></div>
          <div id="plAuditList" style="max-height:46vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div);
  _auditEl = div;
  return div;
}

function _setStatus(text) {
  const el = _el('plAuditStatus');
  if (el) el.textContent = text || '';
}

function openPlAudit(playlistId) {
  _playlistId = String(playlistId || '');
  _candidates = [];
  _rows = [];
  const m = _ensurePanel();
  m.classList.remove('hidden');
  _setStatus('');
  const box = _el('plAuditResult');
  if (box) { box.style.display = 'none'; box.textContent = ''; }
  const prompt = _el('plAuditPrompt');
  if (prompt) { prompt.value = ''; prompt.focus(); }
}

function closePlAudit() {
  if (_auditEl) _auditEl.classList.add('hidden');
}

function _renderSuggest(r, truncated) {
  const box = _el('plAuditResult');
  if (!box) return;
  box.style.display = 'flex';

  const sug = _el('plAuditSuggest');
  if (sug) {
    sug.textContent = '';
    if (r.summary) {
      const s = document.createElement('div');
      s.className = 'setting-hint';
      s.style.cssText = 'font-size:12px;color:var(--neon-dim);width:100%;line-height:1.5;';
      s.textContent = r.summary;
      sug.appendChild(s);
    }
    const acts = document.createElement('div');
    acts.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    let nameBtn = null;
    if (r.name) {
      nameBtn = document.createElement('button');
      nameBtn.className = 'btn-sm';
      nameBtn.textContent = t('plAudit.sugName', { name: r.name });
      nameBtn.addEventListener('click', () => applyPlAuditSuggest(r, 0));
      acts.appendChild(nameBtn);
    }
    if (r.desc) {
      const dbtn = document.createElement('button');
      dbtn.className = 'btn-sm';
      dbtn.textContent = t('plAudit.sugDesc', { desc: r.desc });
      dbtn.addEventListener('click', () => applyPlAuditSuggest(r, 1));
      acts.appendChild(dbtn);
    }
    const rmBtn = document.createElement('button');
    rmBtn.className = 'btn-sm';
    rmBtn.style.cssText = 'color:var(--c-danger);';
    rmBtn.textContent = t('plAudit.removeChecked');
    rmBtn.addEventListener('click', () => applyPlAuditRemove());
    acts.appendChild(rmBtn);
    sug.appendChild(acts);
  }

  const list = _el('plAuditList');
  if (list) {
    list.textContent = '';
    r.audit.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'plA-row';
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--neon-dim);border-radius:8px;';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'margin-top:3px;flex-shrink:0;';

      const body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0;';

      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:13px;font-weight:600;';
      const title = _candidateByN(a.n);
      nameEl.textContent = `${a.n}. ${title ? title.title : ''}`;

      const badges = document.createElement('div');
      badges.style.cssText = 'display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;';
      const fit = FIT_META[a.fit] || {};
      const sug = SUGGEST_META[a.suggest] || {};
      const fitBadge = document.createElement('span');
      fitBadge.className = 'plA-badge ' + (fit.cls || '');
      fitBadge.textContent = fit.label ? t(fit.label) : '';
      const sugBadge = document.createElement('span');
      sugBadge.className = 'plA-badge ' + (sug.cls || '');
      sugBadge.textContent = sug.label ? t(sug.label) : '';
      badges.appendChild(fitBadge);
      badges.appendChild(sugBadge);

      const reasonEl = document.createElement('div');
      reasonEl.className = 'setting-hint';
      reasonEl.style.cssText = 'font-size:12px;margin-top:4px;color:var(--neon-dim);';
      reasonEl.textContent = a.reason || '';

      body.appendChild(nameEl);
      body.appendChild(badges);
      body.appendChild(reasonEl);
      row.appendChild(cb);
      row.appendChild(body);

      const apply = a.suggest === 'remove' || a.suggest === 'move';
      cb.checked = !!apply;
      cb.title = apply ? t('plAudit.removeThis') : '';
      const entry = { n: a.n, title: title ? title.title : '', artist: title ? title.artist : '', fit: a.fit, suggest: a.suggest, reason: a.reason, checked: !!apply, cb };
      cb.addEventListener('change', () => { entry.checked = cb.checked; });

      list.appendChild(row);
      _rows.push(entry);
    });
  }

  if (truncated > 0) _setStatus(t('plAudit.truncated', { n: truncated }));
}

async function runPlAudit() {
  if (_busy) return;
  if (!_playlistId) { showToast(t('plAudit.errNoPlaylist'), 'warn'); return; }
  const prompt = ((_el('plAuditPrompt') && _el('plAuditPrompt').value) || '').trim();
  _busy = true;
  const btn = _el('plAuditRunBtn');
  if (btn) btn.disabled = true;
  _setStatus(t('plAudit.thinking'));
  _rows = [];
  _candidates = [];
  try {
    const res = await api.playlistAudit(_playlistId, prompt);
    if (!res || res.ok !== true) {
      _setStatus(_errText(res && res.error));
      return;
    }
    _rows = [];
    _candidates = Array.isArray(res.candidates) ? res.candidates : [];
    _renderSuggest({
      name: res.name, desc: res.desc, summary: res.summary, audit: res.audit || [],
    }, res.truncated || 0);
    _setStatus(t('plAudit.done', { count: (res.audit || []).length }));
  } catch (e) {
    _setStatus(t('plAudit.errInvoke', { msg: errBrief(e) }));
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
  }
}

async function applyPlAuditRemove() {
  if (!_playlistId) return;
  const targets = _rows.filter((r) => r.checked && r.suggest === 'remove');
  const moved = _rows.filter((r) => r.checked && r.suggest === 'move');
  if (!targets.length && !moved.length) {
    showToast(t('plAudit.nothingChecked'), 'info');
    return;
  }
  const msg = t('plAudit.confirmRemove', { n: targets.length });
  const ok = await askConfirm(msg);
  if (!ok) return;

  let okCount = 0;
  for (const r of targets) {
    // 序号对应的真歌曲对象来自 candidates（歌单原样序），
    // 不按详情页当前排序猜：详情页可排序/过滤，序号 ≠ 存储序。
    const cand = _candidates.find((c) => c.n === r.n);
    const song = cand && cand.song;
    if (!song) continue;
    try {
      const res = await api.removeFromUserPlaylist(_playlistId, String(song.id), String(song.source || ''));
      if (res && res.success) okCount++;
    } catch (e) {
      logger.warn('[plAudit] 移除失败:', r.n, e && e.message ? e.message : e);
    }
  }
  if (okCount) {
    showToast(t('plAudit.removed', { n: okCount }), 'success');
    if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
    if (typeof window.renderPlaylistDetailSongs === 'function') {
      const pl = (getState('userPlaylists') || []).find((p) => p.id === _playlistId);
      if (pl) window.renderPlaylistDetailSongs(pl.songs || []);
    }
    if (moved.length) showToast(t('plAudit.movedHint', { n: moved.length }), 'info');
  } else {
    showToast(t('plAudit.removeFailed'), 'error');
  }
}

async function applyPlAuditSuggest(r, idx) {
  if (!_playlistId || !r) return;
  const pl = (getState('userPlaylists') || []).find((p) => p.id === _playlistId);
  if (!pl) { showToast(t('plAudit.errNoPlaylist'), 'warn'); return; }
  // 改名 / 改描述是两个独立按钮，各自只动自己那一项，另一个保持原样
  const name = (idx === 0 ? r.name : pl.name);
  const desc = (idx === 1 ? r.desc : (pl.desc || ''));
  const ok = await askConfirm(t('plAudit.confirmApply', { name: name || pl.name }));
  if (!ok) return;
  try {
    const res = await api.saveUserPlaylist({
      id: _playlistId,
      name: name || pl.name,
      desc: desc || '',
      songs: pl.songs || [],
    });
    if (!res || !res.success) { showToast(t('plAudit.applyFailed'), 'error'); return; }
    showToast(t('plAudit.applied'), 'success');
    if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
  } catch (e) {
    showToast(t('plAudit.applyFailed'), 'error');
  }
}

window.openPlAudit = openPlAudit;
window.closePlAudit = closePlAudit;
window.runPlAudit = runPlAudit;
window.applyPlAuditRemove = applyPlAuditRemove;
window.applyPlAuditSuggest = applyPlAuditSuggest;