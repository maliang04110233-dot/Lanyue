/**
 * 转码公共层 —— 三条入口共用
 *
 * 重构前转码有三套互不相通的实现：
 *   views/converter.js  转换页（整页批量）
 *   views/local.js      本地库（自己 createElement 造一个弹窗）
 *   views/download.js   下载页（用 index.html 里静态的 #convertModal）
 * 格式/比特率常量、默认值、批量循环、弹窗 UI 各写一遍，默认比特率还
 * 不一致（converter 320k、local 192k、后端 192k）。
 *
 * 本地库那次动态弹窗有个真 bug：它先 `getElementById('convertModal').remove()`
 * 把 index.html 里静态的弹窗删掉再建一个同 id 的，之后下载页的
 * showConvertModal 在 null 上调 classList 直接抛错。
 * 现在三条入口都渲染同一个静态 #convertModal。
 */

import { errBrief } from './errBrief.js';
import { logger } from './logger.js';

// ── 常量 ─────────────────────────────────────────────────
export const CONVERT_FORMATS = [
  { value: 'mp3',  label: 'MP3',  hint: '320kbps，通用性最好' },
  { value: 'flac', label: 'FLAC', hint: '无损压缩' },
  { value: 'aac',  label: 'AAC',  hint: 'M4A 容器，高压缩比' },
  { value: 'ogg',  label: 'OGG',  hint: 'Vorbis 编码' },
  { value: 'wav',  label: 'WAV',  hint: '无压缩，体积最大' },
];

export const CONVERT_BITRATES = [
  { value: '128k', label: '128 kbps' },
  { value: '192k', label: '192 kbps' },
  { value: '256k', label: '256 kbps' },
  { value: '320k', label: '320 kbps' },
];

export const DEFAULT_FORMAT = 'mp3';
export const DEFAULT_BITRATE = '320k';
export const OUTPUT_DIR_PREF = 'convertOutputDir';
export const LOUDNORM_PREF = 'convertLoudnorm';

/** 无损格式不吃比特率，UI 上隐藏比特率行 */
export function isLossless(format) {
  return ['flac', 'wav'].includes(String(format || '').toLowerCase());
}

// ── 共用弹窗 ──────────────────────────────────────────────
// 弹窗打开期间记住的歌单 / 是否显示输出目录行 / 确认回调
let _modalItems = [];
let _modalAllowDir = false;
let _modalConfirm = null;

/**
 * 打开转码弹窗。
 *
 * @param {object} opts
 * @param {{path:string,title?:string,artist?:string,ext?:string}[]} opts.items
 * @param {string} [opts.title]
 * @param {string} [opts.defaultFormat]
 * @param {string} [opts.defaultBitrate]
 * @param {boolean} [opts.allowOutputDirPick]  显示输出目录行（批量场景需要）
 * @param {(format:string, bitrate:string, items:object[], outputDir:string|null)=>void} opts.onConfirm
 */
export function openConvertModal({
  items,
  title = '🔄 转换格式',
  defaultFormat = DEFAULT_FORMAT,
  defaultBitrate = DEFAULT_BITRATE,
  allowOutputDirPick = false,
  onConfirm,
}) {
  if (!Array.isArray(items) || !items.length) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
  }

  _modalItems = items;
  _modalAllowDir = allowOutputDirPick;
  _modalConfirm = onConfirm || null;

  document.getElementById('convertModalTitle').textContent = title;
  document.getElementById('convertModalInfo').textContent = items.length > 1
    ? `${items.length} 首歌曲`
    : `${items.length} 首歌曲 · ${items[0].title || pathBase(items[0].path)}`;

  // 回传歌曲对象本身而不是索引——旧实现按 data-convert-idx 回查 localFiltered，
  // 弹窗开着期间列表被过滤/重排就会转错歌
  const list = document.getElementById('convertItemsList');
  list.style.display = items.length > 1 ? 'block' : 'none';
  list.innerHTML = items.map(s => `
    <label class="convert-item">
      <input type="checkbox" class="convert-checkbox" checked data-cpath="${escQ(s.path)}">
      <span class="convert-item-name">${esc(s.title || s.path || '未知')}</span>
      <span class="convert-item-ext">${normExt(s)}</span>
    </label>`).join('');

  document.getElementById('convertFormat').value = defaultFormat;
  document.getElementById('convertBitrate').value = defaultBitrate;
  syncBitrateVisibility();
  _ensureLoudnormLoaded();              // 响度归一是全局偏好，异步回填勾选

  document.getElementById('convertOutputDirRow').style.display =
    allowOutputDirPick ? 'flex' : 'none';
  if (allowOutputDirPick) {
    refreshOutputDirLabel();
    _ensureOutputDirLoaded();          // pref 异步加载完再刷一次标签
  }

  document.getElementById('convertModal').classList.remove('hidden');
}

export function closeConvertModal() {
  document.getElementById('convertModal').classList.add('hidden');
  _modalItems = [];
  _modalAllowDir = false;
  _modalConfirm = null;
}

/** 弹窗是否正在展示歌曲列表（即支持逐条勾选） */
function _showingList() {
  const el = document.getElementById('convertItemsList');
  return !!el && el.style.display !== 'none' && _modalItems.length > 1;
}

export function isConvertModalOpen() {
  return !document.getElementById('convertModal').classList.contains('hidden');
}

/** 格式切换后，无损格式隐藏比特率行 */
export function syncBitrateVisibility() {
  const lossless = isLossless(document.getElementById('convertFormat').value);
  document.getElementById('convertBitrateRow').style.display = lossless ? 'none' : 'flex';
}

function refreshOutputDirLabel() {
  const el = document.getElementById('convertOutputDirLabel');
  const pref = window._convertOutputDir || '';
  el.textContent = pref ? `输出: ${pref}` : '未设置输出目录';
  el.title = pref || '';
}

function pathBase(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/** 扩展名显示：扫描器可能带点号（.mp3），统一成大写无点的 MP3 */
function normExt(s) {
  const raw = String(s.ext || s.path || '');
  const base = raw.split(/[\\/]/).pop().replace(/^\./, '');
  return base.split('.').pop().toUpperCase();
}

/** 选择输出目录（三条入口共用，写同一个 pref） */
export async function pickConvertOutputDir() {
  const dir = await api.selectDir();
  if (!dir) return false;
  window._convertOutputDir = dir;
  await api.setPref(OUTPUT_DIR_PREF, dir);
  refreshOutputDirLabel();
  showToast(`输出目录已设置: ${dir}`, 'success');
  return true;
}

/**
 * 从 pref 恢复输出目录。
 *
 * 三条入口都可能在转换页之前打开弹窗（下载页/本地库），所以不能只在
 * initConverter() 里调——这里做成按需加载：第一次真正需要时才读 pref，
 * 之后走 window 上的缓存。
 */
export async function initConvertOutputDir(force = false) {
  if (!force && window._convertOutputDir) return window._convertOutputDir;

  try {
    const saved = await api.getPref(OUTPUT_DIR_PREF);
    if (saved) {
      window._convertOutputDir = saved;
      refreshOutputDirLabel();
    }
  } catch (e) {
    logger.warn('[convert] 读取输出目录失败:', e.message);
  }
  return window._convertOutputDir || null;
}

/** 弹窗打开前确保输出目录已加载（异步，不阻塞弹窗显示） */
async function _ensureOutputDirLoaded() {
  if (!window._convertOutputDir) await initConvertOutputDir();
}

// ── 响度归一偏好（P0-B）───────────────────────────────
// 开关只写 pref：真正生效点在 main/ipc/library.js 的 convert-audio，
// 它每次都现读 prefs.get('convertLoudnorm')，无需渲染层随参数传。

/** 勾选变化即持久化（三条入口共用同一个 pref） */
export async function saveConvertLoudnorm(checked) {
  window._convertLoudnorm = !!checked;
  try {
    await api.setPref(LOUDNORM_PREF, !!checked);
  } catch (e) {
    logger.warn('[convert] 保存响度归一偏好失败:', e.message);
  }
}

/** 首次打开弹窗时从 pref 回填勾选（之后走 window 缓存） */
async function _ensureLoudnormLoaded() {
  const el = document.getElementById('convertLoudnorm');
  if (!el) return;
  if (window._convertLoudnorm === undefined) {
    try {
      window._convertLoudnorm = (await api.getPref(LOUDNORM_PREF)) === true;
    } catch (e) {
      logger.warn('[convert] 读取响度归一偏好失败:', e.message);
      window._convertLoudnorm = false;
    }
  }
  el.checked = window._convertLoudnorm;
}

/** 弹窗「开始转换」按钮 */
export async function confirmConvertModal() {
  const format = document.getElementById('convertFormat').value;
  const bitrate = document.getElementById('convertBitrate').value;

  const items = _showingList()
    ? Array.from(document.querySelectorAll('#convertModal .convert-checkbox:checked'))
        .map(cb => _modalItems.find(s => s.path === cb.dataset.cpath))
        .filter(Boolean)
    : _modalItems;

  if (!items.length) {
    showToast('请至少选择一首歌曲', 'warn');
    return;
  }

  const outputDir = _modalAllowDir ? (await initConvertOutputDir()) : null;
  if (outputDir) refreshOutputDirLabel();
  if (_modalAllowDir && !outputDir) {
    showToast('请先设置输出目录', 'warn');
    return;
  }

  const cb = _modalConfirm;
  closeConvertModal();
  if (cb) await cb(format, bitrate, items, outputDir);
}

// ── 批量转码 runner ───────────────────────────────────────

/**
 * 串行转码一批歌，逐个回报状态；单条失败不中断整批。
 *
 * 格式/比特率可以用 opts 给整批设默认，也可以写在 item.format /
 * item.bitrate 上单独覆盖（转换页的队列支持逐行选格式）。
 *
 * @param {object} opts
 * @param {{path:string,title?:string,format?:string,bitrate?:string}[]} opts.items
 * @param {string} [opts.format]     整批默认格式
 * @param {string} [opts.bitrate]    整批默认比特率
 * @param {string|null} opts.outputDir
 * @param {boolean} [opts.revealFolder]  成功后在资源管理器定位（单文件场景）
 * @param {(item:object, phase:string, pct?:number, msg?:string)=>void} [opts.onItem]
 *   phase: start | done | error
 * @returns {Promise<{ok:number, fail:number, canceled:number, failedPaths:string[]}>}
 */
export async function runConvertBatch({ items, format = DEFAULT_FORMAT, bitrate = DEFAULT_BITRATE, outputDir, revealFolder = false, onItem }) {
  let ok = 0, fail = 0, canceled = 0;
  const failedPaths = [];

  for (const item of items) {
    onItem?.(item, 'start');
    try {
      const result = await api.convertAudio({
        inputPath: item.path,
        outputFormat: item.format || format,
        bitrate: item.bitrate || bitrate,
        outputDir,
        revealFolder,
      });
      if (result && result.canceled) {
        canceled++;
        onItem?.(item, 'error', 0, '已取消');
        break;                     // 用户取消：整批停
      } else if (result && result.success) {
        ok++;
        onItem?.(item, 'done');
      } else {
        fail++;
        failedPaths.push(item.path);
        onItem?.(item, 'error', 0, result?.error);
      }
    } catch (e) {
      fail++;
      failedPaths.push(item.path);
      logger.warn('[convert] 异常:', e);
      onItem?.(item, 'error', 0, e.message);
    }
  }

  return { ok, fail, canceled, failedPaths };
}

/** 通知主进程中止当前转码 */
export async function cancelConvert() {
  try { await api.cancelConvertAudio(); } catch (e) { /* 无 handler 时忽略 */ }
}

// 搜索框防抖（utils.js 是并行会话的编辑区，通用工具先放这里）
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ── 下载页入口（原来散在 views/download.js）────────────────
let _convertTarget = { path: '', title: '' };

export function showConvertModal(filePath, title) {
  _convertTarget = { path: filePath, title: title || '' };
  openConvertModal({
    items: [{ path: filePath, title }],
    title: '🔄 转换格式',
    onConfirm: (format, bitrate) => doConvertAudio(format, bitrate),
  });
}

/** 下载页弹窗确认后的实际执行 */
export async function doConvertAudio(outputFormat, bitrate = DEFAULT_BITRATE) {
  const inputPath = _convertTarget.path;
  if (!inputPath) {
    showToast('文件路径无效', 'error');
    closeConvertModal();
    return;
  }

  try {
    const result = await api.convertAudio({
      inputPath,
      outputFormat,
      bitrate,
      revealFolder: true,
    });
    if (result && result.canceled) return;
    if (result && result.success) {
      showToast(`转换成功：${result.path}`, 'success', 4000);
    } else {
      showToast('转换失败：' + (result?.error || '未知错误'), 'error', 5000);
    }
  } catch (e) {
    showToast('转换异常：' + errBrief(e), 'error', 5000);
  }
}

// ── HTML 桥接 ─────────────────────────────────────────────
window.showConvertModal = showConvertModal;
window.closeConvertModal = closeConvertModal;
window.doConvertAudio = doConvertAudio;
window.confirmConvertModal = confirmConvertModal;
window.syncBitrateVisibility = syncBitrateVisibility;
window.pickConvertOutputDir = pickConvertOutputDir;
window.saveConvertLoudnorm = saveConvertLoudnorm;
