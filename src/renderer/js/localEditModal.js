/**
 * 本地曲库的 ID3 编辑弹窗（单曲编辑 + 批量编辑 + 封面拖拽上传）
 *
 * 为什么独立成模块：这一块是一个自洽的 UI 子系统（一个 #editOverlay 弹窗，
 * 单曲/批量两种模式共用同一批输入框 + 一个封面预览区 + 一套保存逻辑），
 * 之前整块内联在 views/local.js（1600+ 行）里，与扫描/过滤/渲染/批量工具
 * 混在一起。它只依赖少量外部能力（见下方 deps 注入），没有别的隐式耦合。
 *
 * 依赖注入（为什么不用直接 import）：
 *   · renderLocalSongs / exitLocalSelectionMode 是 views/local.js 的内部实现，
 *     本模块保存完要把列表重画、退回非选择态——由 local.js 在装配时注入，
 *     免得本模块反过来 import 视图、绕成环（也与本仓"可测文件不拖 DOM 进图"
 *     的约定一致：本模块不 import 任何渲染层兄弟，只在 deps 里收回调）。
 *   · getState / setState / api / showToast / errBrief 由调用方一并传入，
 *     便于 node 直接单测（只需给一组假 deps）。
 *
 * 行为保持：文案、字段、校验、保存语义、封面白名单校验全部逐字沿用原实现。
 * 拖拽上传的 handler 引用照样存起来供 teardown 清理（H7/H8 修复，防重复绑定）。
 *
 * 依赖接线见 views/local.js 的 initEditModal({ ... }) 调用处。
 */

import { errBrief } from './errBrief.js';

// 依赖口径（刻意与本仓渲染层一致）：
//   · getState/setState/api/showToast 是 window 全局（state.js / app.js / toast.js 挂上），
//     本模块**直接用全局**而非注入——全仓渲染层没有一处 import showToast；改成注入会让
//     toast-i18n 的欠账判据（按裸 showToast( 扫）看不见这里的硬编码中文，等于把债藏了。
//   · errBrief 是纯函数（无 DOM），直接 import，可测。
//   · t（取词）**按参数注入**而非 import i18n.js：i18n.js 静态 import 语言包 JSON，
//     node 要求那种写法带 import attribute 而本仓 eslint 解析不了（两条路都堵，
//     见 toast.js:52 头注）。本模块能被 node 直测，就不能把语言包拖进它的依赖图。
//   · 只有真正属于 views/local.js 内部的三个（重画列表 / 退出选择态 / 取选中集）
//     由调用方注入，避免本模块反向 import 视图绕成环。
let D = null;
function setDeps(d) { D = d; }

const el = (id) => document.getElementById(id);
const COVER_PLACEHOLDER = '<span style="font-size:28px">🎵</span>';

/**
 * 封面 base64 白名单校验：只有 data:image/*;base64, 形态才允许插进 innerHTML，
 * 防止把外部输入直接塞进 src 属性。非白名单一律当无封面。
 */
function isSafeDataImage(cover) {
  return typeof cover === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(cover);
}

// ── 编辑弹窗 document 级 click 监听管理 ──────────────────────────
let _editDocClickHandler = null;

function _addEditDocClickListener() {
  _removeEditDocClickListener();
  _editDocClickHandler = (e) => {
    const overlay = el('editOverlay');
    if (overlay && e.target === overlay) closeEdit();
  };
  document.addEventListener('click', _editDocClickHandler);
}

function _removeEditDocClickListener() {
  if (_editDocClickHandler) {
    document.removeEventListener('click', _editDocClickHandler);
    _editDocClickHandler = null;
  }
}

function openEdit(idx) {
  const localFiltered = getState('localFiltered');
  const s = localFiltered[idx];
  if (!s) return;
  setState('editingSong', s);
  setState('editingCoverBase64', s.cover || null);

  el('editTitle').value = s.title || '';
  el('editArtist').value = s.artist || '';
  el('editAlbum').value = s.album || '';
  el('editYear').value = s.year || '';
  el('editGenre').value = s.genre || '';

  const preview = el('editCoverPreview');
  preview.innerHTML = s.cover && isSafeDataImage(s.cover)
    ? `<img src="${s.cover}" style="width:100%;height:100%;object-fit:cover">`
    : COVER_PLACEHOLDER;

  el('editBatchHint').style.display = 'none';
  el('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEditOnBg(e) {
  if (e.target === el('editOverlay')) closeEdit();
}

function onEditCoverSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    setState('editingCoverBase64', e.target.result);
    el('editCoverPreview').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
  };
  reader.readAsDataURL(file);
}

function clearEditCover() {
  setState('editingCoverBase64', null);
  el('editCoverPreview').innerHTML = COVER_PLACEHOLDER;
}

async function saveEdit() {
  const editingSong = getState('editingSong');
  if (!editingSong) return;

  const tags = {
    title: el('editTitle').value.trim(),
    artist: el('editArtist').value.trim(),
    album: el('editAlbum').value.trim(),
    year: el('editYear').value.trim(),
    genre: el('editGenre').value.trim(),
  };

  try {
    const result = await api.updateId3Tags(editingSong.filePath, tags);
    if (result.success) {
      const editingCoverBase64 = getState('editingCoverBase64');
      if (editingCoverBase64 !== editingSong.cover) {
        if (editingCoverBase64) {
          await api.updateId3Cover(editingSong.filePath, editingCoverBase64);
        }
      }
      Object.assign(editingSong, tags);
      editingSong.cover = editingCoverBase64;
      D.renderLocalSongs();
      closeEdit();
      showToast(D.t('toast.localEditSaved'), 'success');
    } else {
      showToast(D.t('toast.localEditSaveFailed', { msg: result.error || '未知错误' }), 'error');
    }
  } catch (e) {
    showToast(D.t('toast.localEditSaveError', { msg: errBrief(e) }), 'error');
  }
}

// ── 批量编辑 ────────────────────────────────────────────────────
function openBatchEdit() {
  const count = D.getSelectedPaths().length;
  if (!count) { showToast(D.t('toast.localEditNeedSelect'), 'warn'); return; }

  el('editTitle').value = '';
  el('editArtist').value = '';
  el('editAlbum').value = '';
  el('editYear').value = '';
  el('editGenre').value = '';
  el('editCoverPreview').innerHTML = COVER_PLACEHOLDER;
  setState('editingCoverBase64', null);
  setState('editingSong', null);

  el('editTitleLabel').textContent = `✏️ 批量编辑 ${count} 首`;
  el('editBatchHint').style.display = 'block';
  el('editBatchHint').textContent = `已选 ${count} 首歌曲。只填写的字段会批量写入，留空则跳过该字段。`;
  el('editSaveBtn').textContent = '批量保存';
  el('editSaveBtn').setAttribute('onclick', 'saveBatchEdit()');
  el('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEdit() {
  _removeEditDocClickListener();
  el('editOverlay').classList.add('hidden');
  setState('editingSong', null);
  setState('editingCoverBase64', null);
  el('editTitleLabel').textContent = '✏️ 编辑歌曲信息';
  el('editBatchHint').style.display = 'none';
  el('editSaveBtn').textContent = '保存更改';
  el('editSaveBtn').setAttribute('onclick', 'saveEdit()');
}

async function saveBatchEdit() {
  const selected = D.getSelectedPaths();
  if (!selected.length) return;

  const tags = {
    title: el('editTitle').value.trim(),
    artist: el('editArtist').value.trim(),
    album: el('editAlbum').value.trim(),
    year: el('editYear').value.trim(),
    genre: el('editGenre').value.trim(),
  };
  // 过滤掉空字段
  const filledTags = Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== ''));
  if (!Object.keys(filledTags).length) {
    showToast(D.t('toast.localEditNeedField'), 'warn');
    return;
  }

  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');
  let ok = 0, fail = 0;
  const editingCoverBase64 = getState('editingCoverBase64');

  for (const fp of selected) {
    try {
      const result = await api.updateId3Tags(fp, filledTags);
      if (result && result.success) {
        if (editingCoverBase64) {
          await api.updateId3Cover(fp, editingCoverBase64);
        }
        // 回填状态
        const s = localSongs.find((x) => x.filePath === fp);
        if (s) { Object.assign(s, filledTags); if (editingCoverBase64) s.cover = editingCoverBase64; }
        const fi = localFiltered.findIndex((x) => x.filePath === fp);
        if (fi >= 0) { Object.assign(localFiltered[fi], filledTags); if (editingCoverBase64) localFiltered[fi].cover = editingCoverBase64; }
        ok++;
      } else { fail++; }
    } catch (e) { fail++; }
  }

  D.renderLocalSongs();
  closeEdit();
  D.exitSelection();
  showToast(D.t('toast.localBatchEditDone', { ok, fail }), ok > 0 ? 'success' : 'warn', 4000);
}

// ── 拖拽上传封面（编辑器） ───────────────────────────────────────
// H7/H8 修复：存储 handler 引用，支持清理
const _dragCoverHandlers = { dragover: null, dragleave: null, drop: null };

function setupDragCover() {
  const preview = el('editCoverPreview');
  if (!preview) return;
  // 先清理旧监听器，避免重复绑定
  teardownDragCover();
  _dragCoverHandlers.dragover = (e) => { e.preventDefault(); preview.style.borderColor = 'var(--neon-cyan-dim)'; };
  _dragCoverHandlers.dragleave = () => { preview.style.borderColor = 'var(--neon-blue-dim)'; };
  _dragCoverHandlers.drop = (e) => {
    e.preventDefault();
    preview.style.borderColor = 'var(--neon-blue-dim)';
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setState('editingCoverBase64', ev.target.result);
      preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
  };
  preview.addEventListener('dragover', _dragCoverHandlers.dragover);
  preview.addEventListener('dragleave', _dragCoverHandlers.dragleave);
  preview.addEventListener('drop', _dragCoverHandlers.drop);
}

function teardownDragCover() {
  const preview = el('editCoverPreview');
  if (!preview) return;
  if (_dragCoverHandlers.dragover) preview.removeEventListener('dragover', _dragCoverHandlers.dragover);
  if (_dragCoverHandlers.dragleave) preview.removeEventListener('dragleave', _dragCoverHandlers.dragleave);
  if (_dragCoverHandlers.drop) preview.removeEventListener('drop', _dragCoverHandlers.drop);
  _dragCoverHandlers.dragover = null;
  _dragCoverHandlers.dragleave = null;
  _dragCoverHandlers.drop = null;
}

export {
  setDeps, openEdit, closeEditOnBg, onEditCoverSelect, clearEditCover, saveEdit,
  openBatchEdit, closeEdit, saveBatchEdit, setupDragCover, teardownDragCover,
};
