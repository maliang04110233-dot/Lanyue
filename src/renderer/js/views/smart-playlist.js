/**
 * AI 智能歌单界面（轨道三）
 *
 * 一句话主题 → 主进程从用户已有的歌里挑 → 这里画预览、让用户逐条勾 →
 * 只有点「存为歌单」那一下才落库（走既有 save-user-playlist，零新写通道）。
 *
 * 三条纪律：
 *   ① 生成函数里不许出现 api.saveUserPlaylist —— 「AI 替用户改了曲库」是本应用
 *      最不该出现的事，而这条通道不在 MCP 工具白名单里，轨道二的逐条确认闸门管不到它，
 *      所以判据只能长在界面上（test/smart-playlist-ui.test.js 钉着）；
 *   ② 模型给的 name/reason 与歌名都可能含尖括号，一律 textContent 上屏；
 *   ③ 主进程只发 ASCII 令牌，文案在渲染层词典 —— ERR_KEYS 必须覆盖主进程会发的每一个，
 *      漏一个用户看到的就是大写字母。
 *
 * 范围下拉每次展开都重拉一次歌单：用户刚建的单该立刻能选，缓存换来的是"界面骗人"。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { showToast } from '../toast.js';

const SCOPE_LIBRARY = 'library';

let _songs = [];    // 生成回来的真歌曲对象（顺序就是模型给的顺序）
let _keep = [];     // 与 _songs 同长：用户勾掉的不进最后的歌单
let _busy = false;

const ERR_KEYS = {
  NO_KEY: 'smartPl.errNoKey',
  EMPTY_PROMPT: 'smartPl.errEmptyPrompt',
  NO_CANDIDATES: 'smartPl.errNoCandidates',
  PLAYLIST_NOT_FOUND: 'smartPl.errNoPlaylist',
  LLM_FAILED: 'smartPl.errLlmFailed',
  NO_PICKS: 'smartPl.errNoPicks',
};

function _el(id) { return document.getElementById(id); }

function _errText(code) {
  const k = ERR_KEYS[code];
  return k ? t(k) : t('smartPl.errLlmFailed');
}

function _setStatus(text) {
  const el = _el('smartPlStatus');
  if (el) el.textContent = text || '';
}

/** 每次展开重拉：新建的歌单要立刻能选 */
async function _fillScopes() {
  const sel = _el('smartPlScope');
  if (!sel) return;
  sel.textContent = '';
  const mk = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  mk(SCOPE_LIBRARY, t('smartPl.scopeLibrary'));
  mk('favorites', t('smartPl.scopeFavorites'));
  let lists = [];
  try {
    lists = (await api.getUserPlaylists()) || [];
  } catch (_e) {
    // 拉不到歌单只少了几个可选项，不该把整个面板废掉
    return;
  }
  for (const pl of lists) {
    if (!pl || pl.id === 'favorites' || !pl.name) continue;
    mk(`playlist:${pl.id}`, `${pl.name} · ${(pl.songs || []).length}`);
  }
}

async function toggleSmartPanel() {
  const panel = _el('smartPlPanel');
  if (!panel) return;
  const closed = !panel.style.display || panel.style.display === 'none';
  if (!closed) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'flex';
  await _fillScopes();
  const input = _el('smartPlPrompt');
  if (input) input.focus();
}

function _hideResult() {
  _songs = [];
  _keep = [];
  const box = _el('smartPlResult');
  if (box) box.style.display = 'none';
}

/** 「挑了几首 / 还有多少没被看过」——后者必须说，否则用户以为 AI 读完了整个曲库 */
function _summary(truncated) {
  const parts = [t('smartPl.picked', { count: _keep.filter(Boolean).length, total: _songs.length })];
  if (truncated > 0) parts.push(t('smartPl.truncated', { n: truncated }));
  return parts.join(' · ');
}

function _renderResult(reason, truncated) {
  const box = _el('smartPlResult');
  if (!box) return;
  box.style.display = 'flex';
  const reasonEl = _el('smartPlReason');
  if (reasonEl) reasonEl.textContent = reason || '';
  const list = _el('smartPlList');
  if (list) {
    list.textContent = '';
    _songs.forEach((s, i) => {
      const row = document.createElement('label');
      row.className = 'spl-song' + (_keep[i] ? '' : ' spl-off');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!_keep[i];
      cb.addEventListener('change', () => {
        _keep[i] = !_keep[i];
        row.className = 'spl-song' + (_keep[i] ? '' : ' spl-off');
        _setStatus(_summary(truncated));
      });

      const text = document.createElement('span');
      text.textContent = `${i + 1}. ${s && s.title ? s.title : ''}${s && s.artist ? ' — ' + s.artist : ''}`;

      row.appendChild(cb);
      row.appendChild(text);
      list.appendChild(row);
    });
  }
  _setStatus(_summary(truncated));
}

async function runSmartPlaylist() {
  if (_busy) return;
  const promptEl = _el('smartPlPrompt');
  const scopeEl = _el('smartPlScope');
  const prompt = ((promptEl && promptEl.value) || '').trim();
  if (!prompt) {
    _setStatus(t('smartPl.needPrompt'));
    return;
  }
  _busy = true;
  const btn = _el('smartPlGenBtn');
  if (btn) btn.disabled = true;
  _setStatus(t('smartPl.thinking'));
  _hideResult();
  try {
    const res = await window.ipcRenderer.invoke(
      'smart-playlist-generate', prompt, (scopeEl && scopeEl.value) || SCOPE_LIBRARY);
    if (!res || res.ok !== true) {
      _setStatus(_errText(res && res.error));
      return;
    }
    _songs = Array.isArray(res.songs) ? res.songs : [];
    _keep = _songs.map(() => true);
    const nameEl = _el('smartPlName');
    if (nameEl) nameEl.value = res.name || '';
    _renderResult(res.reason, res.truncated || 0);
  } catch (e) {
    _setStatus(t('smartPl.errInvoke', { msg: errBrief(e) }));
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
  }
}

async function saveSmartPlaylist() {
  if (!_songs.length) return;
  const nameEl = _el('smartPlName');
  const name = ((nameEl && nameEl.value) || '').trim();
  if (!name) {
    showToast(t('toast.smartPlNeedName'), 'error');
    if (nameEl) nameEl.focus();
    return;
  }
  const now = Date.now();
  const songs = [];
  _songs.forEach((s, i) => { if (_keep[i]) songs.push({ ...s, addedAt: now }); });
  if (!songs.length) {
    showToast(t('toast.smartPlNothing'), 'error');
    return;
  }
  try {
    const r = await api.saveUserPlaylist({ name, desc: t('smartPl.descTag', { count: songs.length }), songs });
    if (!r || !r.success) {
      showToast(t('toast.smartPlSaveFailed'), 'error');
      return;
    }
    showToast(t('toast.smartPlSaved', { name, count: songs.length }), 'success');
    _hideResult();
    const panel = _el('smartPlPanel');
    if (panel) panel.style.display = 'none';
    if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
  } catch (e) {
    showToast(t('toast.smartPlSaveFailed'), 'error');
  }
}

window.toggleSmartPanel = toggleSmartPanel;
window.runSmartPlaylist = runSmartPlaylist;
window.saveSmartPlaylist = saveSmartPlaylist;
