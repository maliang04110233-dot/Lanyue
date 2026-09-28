/**
 * 拖拽音乐链接进窗口 → 即识别（「复制即识别」的鼠标版）
 *
 * 从浏览器/IM 里选中分享链接拖到本窗口任意位置，出现投放提示层，
 * 松手后把文本喂给搜索页既有 doSearch —— 链接走 handleLinkInput
 * 完整识别（单曲渲染/歌单专辑弹窗），普通文本走关键词搜索；
 * 例外一：拖入 .lrc（或内容像歌词的 .txt）且当前播的是本地歌曲时，
 * 写 sidecar 歌词（write-local-lrc）并即时生效——下载党批量补歌词的快捷通道。
 * 例外二：拖入音频文件（可多选）→ URL.createObjectURL 造
 * blob: 临时行加入播放队列，闲置时立即开播；不取流、不进收藏、
 * 重启由 sanitizeSavedQueue 滤除（详见 dropPlay.js）。
 *
 * 全局 dragover/drop 一律 preventDefault：顺带堵住 Electron
 * 默认「拖文件进窗口直接导航」的坑。
 */

'use strict';

import { pickDroppedText, isLrcFilename, looksLikeLrc, MAX_LRC_BYTES } from '../dragText.js';
import { planDropSongs, isDropAudioName } from '../dropPlay.js';
import { playQueueIdx } from '../player.js';
import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';

let _depth = 0; // dragenter/dragleave 计数：子元素间穿梭不误隐藏

function _hasDragText(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  const arr = Array.from(types);
  return !arr.includes('Files') && (arr.includes('text/plain') || arr.includes('text') || arr.includes('URL'));
}

/** 拖拽悬停时试探投的是歌词还是音频（Chromium 在 dragenter 允许 items 取文件名） */
function _dragFileHint(e) {
  try {
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types || []).includes('Files')) return null;
    let audio = false;
    const items = dt.items || [];
    for (const it of items) {
      if (it && it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isLrcFilename(f.name)) return 'lrc'; // 歌词优先：维持既有语义
        if (f && isDropAudioName(f.name)) audio = true;
      }
    }
    return audio ? 'audio' : null;
  } catch (_e) { /* 试探失败按普通拖拽处理 */ }
  return null;
}

function _overlayEl() {
  let el = document.getElementById('dropZone');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dropZone';
    el.className = 'drop-zone';
    el.style.display = 'none';
    el.innerHTML = '<div class="drop-zone-inner">🔗 松手即识别音乐链接</div>';
    document.body.appendChild(el);
  }
  return el;
}

const _DROP_LABELS = {
  lrc: '🎼 松手导入歌词到当前本地歌曲',
  audio: '🎧 松手拖入音频立即播放',
  text: '🔗 松手即识别音乐链接',
};

function _show(hint) {
  const el = _overlayEl();
  const inner = el.querySelector('.drop-zone-inner');
  if (inner) inner.textContent = _DROP_LABELS[hint] || _DROP_LABELS.text;
  el.style.display = 'flex';
}
function _hide() {
  const el = document.getElementById('dropZone');
  if (el) el.style.display = 'none';
}

document.addEventListener('dragover', (e) => {
  e.preventDefault(); // 所有拖放都拦下：禁止默认导航；文本拖放额外标记可 drop
  if (_hasDragText(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  const hint = _hasDragText(e) ? 'text' : _dragFileHint(e);
  if (!hint) return;
  _depth++;
  _show(hint);
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (_depth > 0) {
    _depth--;
    if (_depth === 0) _hide();
  }
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  _depth = 0;
  _hide();
  const text = pickDroppedText(e.dataTransfer);
  if (text) {
    if (typeof focusTab === 'function') focusTab('search', 'searchInput');
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.value = text;
    if (typeof doSearch === 'function') doSearch();
    return;
  }
  if (await _handleLrcDrop(e.dataTransfer)) return;
  await _handleAudioDrop(e.dataTransfer);
});

/** 接管拖入的音频文件：blob: 临时行进播放队列，闲置即从第一首开播 */
async function _handleAudioDrop(dt) {
  const files = dt && dt.files;
  if (!files || !files.length) return;
  const { files: picked, rows, truncated } = planDropSongs(files);
  if (!rows.length) return; // 非音频文件：维持原「不接管」语义
  const queue = (typeof getState === 'function' && getState('playQueue')) || [];
  const baseIdx = queue.length;
  for (const row of rows) {
    row._blobUrl = URL.createObjectURL(picked[row._dropIdx]);
  }
  setState('playQueue', queue.concat(rows));
  const cur = typeof getState === 'function' ? getState('currentPlaying') : null;
  if (!cur) await playQueueIdx(baseIdx);
  const tail = truncated ? `，超出 ${truncated} 首未取` : '';
  showToast(`🎧 拖入 ${rows.length} 首${tail}${cur ? '已加入队列' : '，开始播放'}`, 'success', 2600);
}

/** @returns {Promise<boolean>} 是否接管了这次投放（true 时不再走后续音频分支） */
async function _handleLrcDrop(dt) {
  const files = dt && dt.files;
  if (!files || !files.length) return false;
  const f = files[0];
  if (!f || !isLrcFilename(f.name)) return false; // 非歌词候选：维持原「文件不接管」语义
  if (f.size > MAX_LRC_BYTES) { showToast(`歌词文件过大（${Math.round(f.size / 1024)} KB）`, 'warn'); return true; }
  let lrc;
  try { lrc = await f.text(); } catch (e2) { showToast('读取歌词文件失败：' + errBrief(e2), 'error'); return true; }
  if (!lrc || !lrc.trim()) { showToast('歌词文件是空的', 'warn'); return true; }
  // .txt 名称无信息量，必须内容像 LRC（≥3 行时间戳）才敢覆盖 sidecar
  if (/\.txt$/i.test(f.name) && !looksLikeLrc(lrc)) { showToast(`「${f.name}」看起来不是歌词文本`, 'warn'); return true; }
  const songPath = getState('_currentLocalFilePath');
  if (!songPath) { showToast('当前播放的不是本地歌曲，无法写入歌词', 'warn'); return true; }
  if (!await askConfirm(`把「${f.name}」写入当前歌曲旁的 .lrc？（覆盖同名旧歌词文件）`)) return true;
  try {
    const r = await api.writeLocalLrc(songPath, lrc);
    if (!r || !r.success) { showToast('写入失败：' + ((r && r.error) || '未知错误'), 'error'); return true; }
    if (typeof window.parseLrc === 'function') window.parseLrc(lrc);
    showToast('🎼 歌词已写入并生效', 'success');
  } catch (e2) {
    showToast('写入失败：' + errBrief(e2), 'error');
  }
  return true;
}
