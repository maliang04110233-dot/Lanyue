/**
 * 歌词编辑器 —— 弹层 UI + 覆写存储（浏览器侧模块）
 *
 * 「播放条-更多-✏️ 编辑歌词」打开弹层，改完即生效：
 * 本地歌曲写同目录 .lrc sidecar（write-local-lrc），在线歌曲存本机
 * 覆写映射（prefs.lyricOverrides，下次加载歌词时优先于平台歌词）；
 * 清空保存 = 删除对应 sidecar 内容/覆写项。决策内核在 lyricEdit.js（纯函数）。
 */

'use strict';

import { errBrief } from './errBrief.js';
import { askConfirm } from './confirmDialog.js';
import { normalizeLrcText, overridePatch, parseOverrideMap } from './lyricEdit.js';
import { parseLrc, showNoLyrics } from './player/lyrics.js';
import { favKey } from './state.js';

let _overrides = null; // 惰性加载缓存

async function _ensureOverrides() {
  if (_overrides) return _overrides;
  try {
    _overrides = parseOverrideMap(await api.getPref('lyricOverrides'));
  } catch (_e) { _overrides = {}; }
  return _overrides;
}

/** 该在线曲目的本机歌词覆写文本（无则 ''）；本地曲不走覆写通道 */
async function getLyricOverride(song) {
  if (!song || song.id == null || song.id === '' || !song.source) return '';
  const map = await _ensureOverrides();
  return map[favKey(song.source, song.id)] || '';
}

async function saveLyricText(text) {
  const t = normalizeLrcText(text);
  const localPath = getState('_currentLocalFilePath');
  if (localPath) {
    const r = await api.writeLocalLrc(localPath, t);
    if (!r || r.success === false) throw new Error((r && r.error) || '写入失败');
  } else {
    const song = getState('currentPlaying');
    if (!song || song.id == null || song.id === '' || !song.source) {
      throw new Error('未知歌曲无法保存歌词');
    }
    const map = await _ensureOverrides();
    _overrides = overridePatch(map, favKey(song.source, song.id), t);
    await api.setPref('lyricOverrides', JSON.stringify(_overrides));
  }
  setState('_currentLyricRaw', t);
  if (t.trim()) parseLrc(t); else showNoLyrics();
}

function _modalEl() {
  let el = document.getElementById('lyricEditorModal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'lyricEditorModal';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);align-items:center;justify-content:center';
  el.innerHTML = '<div style="width:min(680px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--bg-secondary,#1e1e28);border:1px solid var(--border,#333);border-radius:12px;padding:16px 18px;gap:10px">'
    + '<div style="font-weight:600">✏️ 编辑歌词 <span id="lyricEditorTarget" style="font-weight:400;opacity:.65;font-size:12px"></span></div>'
    + '<textarea id="lyricEditorText" spellcheck="false" style="flex:1;min-height:320px;resize:vertical;background:var(--bg-primary,#141419);color:var(--text-primary,#eee);border:1px solid var(--border,#333);border-radius:8px;padding:10px;font:13px/1.7 Consolas,monospace" placeholder="[00:12.30]歌词行格式，直接粘贴纯文本也可以（将静态显示）"></textarea>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end">'
    + '<button class="btn-sm" id="lyricEditorClear">🗑 清除</button>'
    + '<button class="btn-sm" id="lyricEditorCancel">取消</button>'
    + '<button class="btn-sm" id="lyricEditorSave" style="font-weight:600">💾 保存</button>'
    + '</div></div>';
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) _close(); });
  document.getElementById('lyricEditorCancel').addEventListener('click', _close);
  document.getElementById('lyricEditorSave').addEventListener('click', () => _save());
  document.getElementById('lyricEditorClear').addEventListener('click', async () => {
    if (await askConfirm('清除后该歌曲将不再显示歌词（本地曲会清空 .lrc 文件），确认？')) {
      document.getElementById('lyricEditorText').value = '';
      _save();
    }
  });
  return el;
}

function _close() {
  const el = document.getElementById('lyricEditorModal');
  // 常驻 display 切换单例：身份与契约随开合挂摘——收起后若留 data-modal-close，
  // 注册表选择器只过滤 .hidden 类不认识 style.display，幽灵浮层会永远吞掉每次 Esc
  if (el) {
    el.style.display = 'none';
    el.removeAttribute('data-modal');
    el.removeAttribute('data-modal-close');
  }
}

async function _save() {
  const ta = document.getElementById('lyricEditorText');
  try {
    await saveLyricText(ta.value);
    _close();
    showToast(ta.value.trim() ? '歌词已保存并生效' : '歌词已清除', 'success');
  } catch (e) {
    showToast('保存失败：' + errBrief(e), 'error');
  }
}

function openLyricEditor() {
  const localPath = getState('_currentLocalFilePath');
  const song = getState('currentPlaying');
  if (!song && !localPath) { showToast('当前没有播放歌曲', 'warn'); return; }
  const el = _modalEl();
  document.getElementById('lyricEditorTarget').textContent = localPath
    ? '· 保存到同目录 .lrc' : '· 保存到本机覆写（在线曲）';
  const ta = document.getElementById('lyricEditorText');
  ta.value = getState('_currentLyricRaw') || '';
  el.style.display = 'flex';
  // 常驻 DOM 的 display 切换单例：身份随开合挂摘，收起状态不得留在守卫面里
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'closeLyricEditor');
  ta.focus();
  ta.setSelectionRange(0, 0);
}

window.openLyricEditor = openLyricEditor;
// 浮层注册表具名出口：收起=隐藏+摘身份，非摘除本体，故不走 '-' 哨兵
window.closeLyricEditor = _close;

export { getLyricOverride, saveLyricText, openLyricEditor };
