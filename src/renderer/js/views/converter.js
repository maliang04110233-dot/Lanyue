/**
 * MusicDL 音频格式转换页面 - 搜索本地歌曲 + 一键批量转换
 *
 * 弹窗 / 格式常量 / 批量 runner 都在 ../converter-core.js，本文件只负责
 * 页面自己的搜索、选择、队列状态和进度展示。
 */

import { logger } from '../logger.js';
import {
  CONVERT_FORMATS, CONVERT_BITRATES, DEFAULT_FORMAT, DEFAULT_BITRATE,
  OUTPUT_DIR_PREF, isLossless, debounce,
  initConvertOutputDir, pickConvertOutputDir,
  runConvertBatch, cancelConvert,
} from '../converter-core.js';
import { filterConverterSongsByKw } from '../converterFilter.js';

// ── 状态 ────────────────────────────────────────────────
let _convQueue = [];
let _convInit = false;
let _convLocalSongs = [];  // 本地歌曲缓存
let _convOutputDir = null; // 输出目录
const _convSelected = new Set();   // 选中歌曲的 filePath（旧版直接改 song._selected，
let _convRunning = false;          // 会污染 state.localSongs 里被多个视图共享的对象）

// 转换页早期的 EQ 预设/批量重命名预览块已删除：相关容器
// converterEqControls/converterRenamePattern 从未加入 index.html，
// EQ 活实现在 player.js + 设置页 eqPanel

// ── 初始化 ──────────────────────────────────────────────
function initConverter() {
  if (_convInit) return;
  _convInit = true;

  initConvertOutputDir().then(dir => {
    _convOutputDir = dir;
    updateOutputDirDisplay();
  });

  loadLocalSongsForConvert();

  const searchInput = document.getElementById('converterSearch');
  if (searchInput) searchInput.addEventListener('input', debounce(filterConverterSongs, 300));

  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) selectAll.addEventListener('change', toggleSelectAll);

  // 格式/比特率下拉：按共享常量生成，保证与弹窗一致
  _convPopulateOptions('converterBatchFormat', CONVERT_FORMATS);
  _convPopulateOptions('converterBatchBitrate', CONVERT_BITRATES);
  const batchFormat = document.getElementById('converterBatchFormat');
  if (batchFormat) batchFormat.value = DEFAULT_FORMAT;
  const batchBitrate = document.getElementById('converterBatchBitrate');
  if (batchBitrate) batchBitrate.value = DEFAULT_BITRATE;

  // 进度事件：主进程按 inputPath 上报 0-100%
  if (typeof api.onConvertAudioProgress === 'function') {
    api.onConvertAudioProgress(({ path, pct }) => _onConvertProgress(path, pct));
  }

  // 暴露全局方法
  window._converterAddQueue = addSelectedToQueue;
  window._converterStart = startConvert;
  window._converterCancel = cancelConvertPage;
  window._converterApplyBatch = applyBatchFormat;
  window._converterScan = scanLocalForConvert;
  window._converterSearch = () => filterConverterSongs();
  window._converterSelectOutputDir = selectOutputDir;
  // 队列行的 ✕ 按钮（renderQueue 模板 onclick）走全局名，需挂 window
  window._converterRemoveFromQueue = removeFromQueue;

  renderConverterSongs();
}

function _convPopulateOptions(selectId, options) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const cur = el.value;
  el.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  el.value = cur;
}

// ── 选择输出目录 ────────────────────────────────────────
async function selectOutputDir() {
  if (await pickConvertOutputDir()) updateOutputDirDisplay();
}

function updateOutputDirDisplay() {
  const el = document.getElementById('converterOutputDir');
  if (el) {
    el.textContent = _convOutputDir ? `输出: ${_convOutputDir}` : '未设置输出目录';
    el.title = _convOutputDir || '';
  }
}

// ── 扫描本地文件夹 ──────────────────────────────────────
async function scanLocalForConvert() {
  const dir = await api.selectDir();
  if (!dir) return;

  setState('localDirPath', dir);
  await api.setPref('localDirPath', dir);

  const info = document.getElementById('converterInfo');
  if (info) info.textContent = '正在扫描...';

  const result = await api.scanLocalLibrary(dir);
  if (result.error) {
    showConverterEmpty('扫描失败: ' + result.error);
    return;
  }

  const localSongs = result.songs || [];
  setState('localSongs', localSongs);
  _convLocalSongs = localSongs;
  _convSelected.clear();

  showToast(`扫描完成，发现 ${localSongs.length} 首歌曲`, 'success');
  // 必须重过关键词：只调 renderConverterSongs 会拿上一轮的 convFiltered 渲染
  // （换了文件夹后列表/计数/全选全是旧库的）；info 由渲染函数按过滤后数量写
  filterConverterSongs();
}

// ── 加载本地歌曲 ────────────────────────────────────────
async function loadLocalSongsForConvert() {
  let localSongs = getState('localSongs');
  if (localSongs && localSongs.length > 0) {
    _convLocalSongs = localSongs;
    // 首屏扫描未回来时用户可能已敲过关键词 → convFiltered 已存在且基于空库，
    // 这里若不重过筛就会渲染成空列表（明明扫到了歌却显示 0 首）
    filterConverterSongs();
    return;
  }

  let localDirPath = getState('localDirPath');
  if (!localDirPath) {
    const saved = await api.getPref('localDirPath');
    if (saved) localDirPath = saved;
  }

  // 扫描目录（即使没有 localDirPath，mock 也会返回数据）
  const result = await api.scanLocalLibrary(localDirPath || null);
  if (result.error) {
    logger.warn('[converter] 扫描失败:', result.error);
    showConverterEmpty('扫描失败: ' + result.error);
    return;
  }
  localSongs = result.songs || [];
  setState('localSongs', localSongs);
  _convLocalSongs = localSongs;
  filterConverterSongs();
}

// ── 过滤歌曲 ────────────────────────────────────────────
// 视图管线唯一入口：读搜索框 → 过纯函数 → setState → 渲染。
// 凡改动 _convLocalSongs 的地方都必须调它（而不是 renderConverterSongs），
// 否则新库会配上一轮的 convFiltered，列表/计数/全选三处一起陈旧。
function filterConverterSongs() {
  const kw = document.getElementById('converterSearch')?.value || '';
  setState('convFiltered', filterConverterSongsByKw(_convLocalSongs, kw));
  renderConverterSongs();
}

// ── 渲染歌曲列表 ────────────────────────────────────────
// 大库分片渲染：首屏同步出结果，其余按片 rAF 追加；token 防快速重筛竞态。
//
// 为什么渲染函数返回 Promise（与 views/playlist.js、views/local.js 同一约定）：
// 分片期间列表里只有前 CONV_RENDER_CHUNK 行，依赖"全部行已在 DOM"的路径
// （滚动定位、按下标取行）会读到半个列表。返回 Promise 让调用方能 await
// 一次"分片已落地"，而不用自己猜还剩几片。
// 在跑的分片各挂一个结算句柄：被作废时**必须**结算，否则 await 的调用方会永久挂起。
//
// ⚠️ updateSelectAllState() 刻意留在分片循环**外面**：它读的是 _convSelected 这个
//   Set，不扫 DOM，选中态与分片进度无关。别顺手把它挪进循环里。
const CONV_RENDER_CHUNK = 100;
let _convRenderToken = 0;
let _convPending = [];

/** 作废在跑的分片并立即结算它们（showConverterEmpty 与新一轮渲染都走这里） */
function _convInvalidateRender() {
  _convRenderToken++;
  // 先换新名单再结算旧的：settle() 会把自己从名单里摘掉，顺序反了就会去 splice 新分片
  const old = _convPending;
  _convPending = [];
  for (const d of old) d.settle();
}

/**
 * 登记一次分片渲染。settle 幂等 ——「跑完」与「被作废」两条路径都会调它。
 *
 * ⚠️ settle() 必须把自己从 _convPending 里摘掉（playlist.js 的 _plDeferRender 那里
 * 记了为什么：只结算不摘，"在跑"名单就变成"跑过"名单，等排空的 while 永不停）。
 */
function _convDeferRender() {
  let done = false;
  let settle;
  const promise = new Promise((res) => { settle = res; });
  const d = {
    promise,
    settle() {
      if (done) return;
      done = true;
      const i = _convPending.indexOf(d);
      if (i >= 0) _convPending.splice(i, 1);
      settle();
    },
  };
  _convPending.push(d);
  return d;
}

/**
 * 等列表分片全部落地（被作废的那轮早已结算，不会永久挂起）。
 *
 * 循环而不是一次 Promise.all，与 playlist.js 的 _plRenderIdle 同一理由（那里记了
 * 实测过程）：等待期间又来一次渲染时，那一轮会结算掉本轮句柄并登记自己，
 * "只等一次"就会在**新那一轮才画完第一片**的时刻返回 —— 那一刻"按下标取行"仍会取空。
 */
async function converterRenderIdle() {
  while (_convPending.length) {
    await Promise.all(_convPending.map((d) => d.promise));
  }
}

function renderConverterSongs() {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  const filtered = getState('convFiltered') || _convLocalSongs;

  if (!_convLocalSongs.length) {
    showConverterEmpty('暂无本地歌曲，请先扫描本地音乐文件夹');
    return Promise.resolve();
  }

  if (info) {
    info.textContent = `共 ${filtered.length} 首歌曲` +
      (_convQueue.length ? `，已选择 ${_convQueue.length} 首待转换` : '');
  }

  if (!container) {
    updateSelectAllState();
    return Promise.resolve();
  }

  // M14: 每行 some() 线性扫队列 → 一次建 Set
  const queuePaths = new Set(_convQueue.map(q => q.path));
  const rows = filtered.map(song => {
    const fp = song.filePath;
    const inQueue = queuePaths.has(fp);
    return `
        <div class="converter-song-item ${inQueue ? 'in-queue' : ''}">
          <input type="checkbox" class="converter-song-check" ${_convSelected.has(fp) ? 'checked' : ''}
                 onchange="_convSongToggle('${escQ(fp)}')">
          <div class="converter-song-info">
            <div class="converter-song-title">${esc(song.title || '未知标题')}</div>
            <div class="converter-song-sub">${esc(song.artist || '未知艺术家')} · ${esc(song.album || '未知专辑')} · ${(song.ext || '').toUpperCase()}</div>
          </div>
          <div class="converter-song-actions">
            ${inQueue
              ? `<button class="btn-sm converter-btn-disabled" disabled>已添加</button>`
              : `<button class="btn-sm converter-btn-add" onclick="_convSongAdd('${escQ(fp)}')">+ 添加</button>`
            }
          </div>
        </div>
      `;
  });

  _convInvalidateRender();
  const d = _convDeferRender();
  const token = _convRenderToken;
  let cursor = 0;
  const appendSlice = () => {
    // 被作废时先结算再走人：不结算就是永久 pending。
    if (token !== _convRenderToken) return d.settle();
    const end = Math.min(cursor + CONV_RENDER_CHUNK, rows.length);
    let html = '';
    for (let i = cursor; i < end; i++) html += rows[i];
    if (cursor === 0) container.innerHTML = html;
    else container.insertAdjacentHTML('beforeend', html);
    cursor = end;
    if (cursor < rows.length) requestAnimationFrame(appendSlice);
    else d.settle();
  };
  appendSlice();

  updateSelectAllState();
  return d.promise;
}

// ── 单个歌曲选择（按路径，不按列表索引）──────────────────
function _convSongToggle(filePath) {
  if (_convSelected.has(filePath)) _convSelected.delete(filePath);
  else _convSelected.add(filePath);
}

// ── 添加到队列 ──────────────────────────────────────────
function _convQueueAdd(song) {
  if (_convQueue.some(q => q.path === song.filePath)) {
    showToast('这首歌曲已在转换队列中', 'warn');
    return false;
  }

  // 扫描器给的 ext 可能带点号（.mp3），统一成不带点的格式名
  const ext = (song.ext || song.filePath.split('.').pop() || 'mp3')
    .replace(/^\./, '').toLowerCase() || 'mp3';
  _convQueue.push({
    id: _convNextId(),
    name: song.title || song.filePath,
    path: song.filePath,
    size: song.size || 0,
    ext,
    // 无损输入默认压成 mp3，有损输入默认升成 flac
    format: ['flac', 'wav'].includes(ext) ? 'mp3' : 'flac',
    bitrate: DEFAULT_BITRATE,
    status: 'pending',
    selected: true,
    pct: 0,
    error: '',
  });
  return true;
}

let _convIdSeq = 0;
function _convNextId() { return ++_convIdSeq; }

function _convSongAdd(filePath) {
  const song = (_convLocalSongs || []).find(s => s.filePath === filePath);
  if (!song) return;
  if (_convQueueAdd(song)) {
    showToast(`已添加: ${song.title || '未知'}`, 'success');
    renderConverterSongs();
    renderQueue();
  }
}

// ── 批量添加选中 ────────────────────────────────────────
function addSelectedToQueue() {
  if (!_convSelected.size) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
  }

  let added = 0;
  for (const song of _convLocalSongs) {
    if (_convSelected.has(song.filePath) && _convQueueAdd(song)) added++;
  }

  showToast(`已添加 ${added} 首歌曲到转换队列`, added > 0 ? 'success' : 'warn');
  _convSelected.clear();
  renderConverterSongs();
  renderQueue();
}

// ── 全选/取消全选 ───────────────────────────────────────
function toggleSelectAll() {
  const checked = document.getElementById('converterSelectAll')?.checked;
  const filtered = getState('convFiltered') || _convLocalSongs;
  if (checked) filtered.forEach(s => _convSelected.add(s.filePath));
  else filtered.forEach(s => _convSelected.delete(s.filePath));
  renderConverterSongs();
}

function updateSelectAllState() {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) {
    const allSelected = filtered.length > 0 && filtered.every(s => _convSelected.has(s.filePath));
    const someSelected = filtered.some(s => _convSelected.has(s.filePath));
    selectAll.checked = allSelected;
    selectAll.indeterminate = someSelected && !allSelected;
  }
}

// ── 渲染转换队列 ────────────────────────────────────────
function renderQueue() {
  const container = document.getElementById('converterQueue');
  const actions = document.getElementById('converterActions');
  if (!container) return;

  if (!_convQueue.length) {
    container.innerHTML = `
      <div class="conv-queue-empty">
        <div class="conv-queue-empty-icon">📋</div>
        <div>转换队列为空</div>
        <div class="conv-queue-empty-hint">从上方列表添加歌曲</div>
      </div>`;
    if (actions) actions.style.display = 'none';
    return;
  }

  if (actions) actions.style.display = 'flex';

  // 行内下拉的选中项必须跟随 item.format（批量改格式后重渲染不能跳回默认值）
  const formatOptsFor = (item) => CONVERT_FORMATS.map(f =>
    `<option value="${f.value}"${f.value === item.format ? ' selected' : ''}>${f.label}</option>`).join('');

  container.innerHTML = `
    <div class="conv-queue-list">
      ${_convQueue.map((item, idx) => {
        // 只有正在转的不能动：已完成/失败的行允许移除和改格式
        const busy = item.status === 'converting';
        return `
        <div class="conv-queue-item conv-status-${item.status}">
          <input type="checkbox" class="conv-queue-check" ${item.selected ? 'checked' : ''}
                 ${busy ? 'disabled' : ''} onchange="_convQueue[${idx}].selected=this.checked">
          <div class="conv-queue-info">
            <div class="conv-queue-name">${esc(item.name)}</div>
            <div class="conv-queue-meta">
              ${item.ext.toUpperCase()} → ${item.format.toUpperCase()}${isLossless(item.format) ? '' : ' ' + item.bitrate}
              ${item.status === 'done' ? ' ✅' : ''}
              ${item.status === 'error' ? ' ❌' : ''}
              ${item.status === 'converting' ? ` 🔄 ${item.pct | 0}%` : ''}
            </div>
            ${item.status === 'converting' ? `<div class="conv-progress"><div class="conv-progress-bar" style="width:${item.pct | 0}%;"></div></div>` : ''}
            ${item.status === 'error' ? `<div class="conv-error">${esc(item.error || '转换失败')}</div>` : ''}
          </div>
          <select class="conv-queue-format" onchange="_convQueue[${idx}].format=this.value" ${busy ? 'disabled' : ''}>
            ${formatOptsFor(item.format)}
          </select>
          <button class="conv-queue-remove" onclick="_converterRemoveFromQueue(${idx})" ${busy ? 'disabled' : ''} title="移除">✕</button>
        </div>`;
      }).join('')}
    </div>`;
}

// ── 从队列移除 ──────────────────────────────────────────
function removeFromQueue(idx) {
  _convQueue.splice(idx, 1);
  renderQueue();
  renderConverterSongs();
}

// ── 清空已完成 ──────────────────────────────────────────
function clearDone() {
  _convQueue = _convQueue.filter(q => q.status !== 'done');
  renderQueue();
}

// ── 应用批量设置 ────────────────────────────────────────
function applyBatchFormat() {
  const batchFormat = document.getElementById('converterBatchFormat')?.value || DEFAULT_FORMAT;
  const batchBitrate = document.getElementById('converterBatchBitrate')?.value || DEFAULT_BITRATE;
  _convQueue.forEach(q => {
    if (q.status === 'pending') {
      q.format = batchFormat;
      q.bitrate = batchBitrate;
    }
  });
  renderQueue();
  showToast(`已应用: ${batchFormat.toUpperCase()}${isLossless(batchFormat) ? '' : ' / ' + batchBitrate}`, 'info');
}

// ── 进度事件 ────────────────────────────────────────────
function _onConvertProgress(filePath, pct) {
  const item = _convQueue.find(q => q.path === filePath);
  if (!item || item.status !== 'converting') return;
  item.pct = pct;
  const bar = document.querySelector(`#converterQueue .conv-status-converting .conv-progress-bar`);
  // 逐条串行，一次只有一个在转——直接改 DOM 避免整表重绘
  if (bar) bar.style.width = `${pct | 0}%`;
}

// ── 开始转换 ────────────────────────────────────────────
async function startConvert() {
  if (_convRunning) return;
  const pending = _convQueue.filter(q => q.status === 'pending' && q.selected);
  if (!pending.length) {
    showToast('请先添加要转换的歌曲', 'warn');
    return;
  }
  if (!_convOutputDir) {
    showToast('请先设置输出目录', 'warn');
    return;
  }

  _convRunning = true;
  _setRunningUI(true);

  const byPath = new Map(pending.map(q => [q.path, q]));
  const { ok, fail, canceled } = await runConvertBatch({
    items: pending,
    outputDir: _convOutputDir,
    onItem: (item, phase, _pct, msg) => {
      const q = byPath.get(item.path);
      if (!q) return;
      if (phase === 'start') {
        q.status = 'converting';
        q.pct = 0;
        q.error = '';
        renderQueue();
      } else if (phase === 'done') {
        q.status = 'done';
        q.pct = 100;
        renderQueue();
      } else {
        q.status = 'error';
        q.pct = 0;
        q.error = msg || '转换失败';
        renderQueue();
      }
    },
  });

  _convRunning = false;
  _setRunningUI(false);

  if (ok > 0 || fail > 0 || canceled > 0) {
    showToast(
      `转码结束：✅ ${ok} 成功${fail > 0 ? ` ❌ ${fail} 失败` : ''}${canceled > 0 ? ' ⏹ 已取消' : ''}`,
      ok > 0 ? 'success' : 'warn',
      4000,
    );
  }
}

function cancelConvertPage() {
  _convRunning = false;
  _setRunningUI(false);
  cancelConvert();
  // 把还挂在 converting 上的行标成取消
  _convQueue.forEach(q => {
    if (q.status === 'converting') {
      q.status = 'error';
      q.error = '已取消';
      q.pct = 0;
    }
  });
  renderQueue();
  showToast('正在取消转码…', 'info', 2000);
}

function _setRunningUI(running) {
  const startBtn = document.getElementById('converterStartBtn');
  const cancelBtn = document.getElementById('converterCancelBtn');
  if (startBtn) {
    startBtn.textContent = running ? '转换中...' : '开始转换';
    startBtn.disabled = running;
  }
  if (cancelBtn) cancelBtn.hidden = !running;
}

// ── 显示空状态 ──────────────────────────────────────────
function showConverterEmpty(msg) {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  if (info) info.textContent = msg || '暂无数据';
  _convInvalidateRender(); // 作废进行中的分片追加，避免空态被后续片覆盖
  if (container) {
    container.innerHTML = `
      <div class="empty-state" style="flex:1;padding:40px;">
        <div class="empty-icon">📂</div>
        <div class="empty-text">${esc(msg || '暂无歌曲')}</div>
      </div>`;
  }
}

// ── 暴露 init ───────────────────────────────────────────
export { initConverter, OUTPUT_DIR_PREF, converterRenderIdle };

// ── 全局桥接 ────────────────────────────────────────────
Object.assign(window, {
  initConverter,
  _convSongToggle,
  _convSongAdd,
  clearDone,
  converterRenderIdle,
});
