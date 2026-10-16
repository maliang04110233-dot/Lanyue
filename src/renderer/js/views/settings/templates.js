/**
 * 设置视图 - 下载路径模板模块
 *
 * 负责：模板列表渲染、启用/编辑/删除、路径模板实时预览。
 */

import { t } from '../../i18n.js';
import { askConfirm } from '../../confirmDialog.js';
import { errBrief } from '../../errBrief.js';

let _dlTemplates = [];
let _dlActiveTemplate = null;

export async function loadDownloadTemplates() {
  try {
    const result = await api.getDownloadTemplates();
    _dlTemplates = result.templates || [];
    _dlActiveTemplate = result.active || null;
    renderDownloadTemplates();
  } catch (e) {
    logger.error('加载下载模板失败:', e);
  }
}

function renderDownloadTemplates() {
  const container = document.getElementById('dlTemplateList');
  if (!container) return;

  if (_dlTemplates.length === 0) {
    container.innerHTML = '<div class="empty-tip" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">暂无模板，点击「新建」添加</div>';
    return;
  }

  container.innerHTML = _dlTemplates.map(tpl => {
    const isActive = tpl.id === _dlActiveTemplate;
    // id 可能是云同步/导入的外部数据 —— 与账号卡片同一约定：实参走 escQ、属性走 escAttr
    const idArg = "'" + escQ(tpl.id) + "'";
    // 落盘真正用的是 subpath（相对下载目录的片段，f5f5a08 起才存在）；
    // 老模板、以及从别的下载目录同步来的模板没这个字段，只能显示绝对路径
    const hasSub = typeof tpl.subpath === 'string' && !!tpl.subpath;
    const shown = hasSub ? tpl.subpath : tpl.path;
    return `
      <div class="dl-template-item ${isActive ? 'active' : ''}" data-id="${escAttr(tpl.id)}">
        <div class="dl-template-info" tabindex="0" role="button" onclick="setActiveTemplate(${idArg})">
          <div class="dl-template-name">
            ${isActive ? '✅ ' : ''}${escHtml(tpl.name)}
            ${isActive ? '<span class="dl-template-badge">使用中</span>' : ''}
          </div>
          <div class="dl-template-path">${escHtml(shown)}${hasSub ? '（相对下载目录）' : '（绝对路径）'}</div>
        </div>
        <div class="dl-template-actions">
          <button class="btn-icon" onclick="openDlTemplateEditor(${idArg})" title="编辑">✏️</button>
          <button class="btn-icon" onclick="deleteDlTemplate(${idArg})" title="删除">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

export async function setActiveTemplate(templateId) {
  try {
    await api.setActiveDownloadTemplate(templateId);
    _dlActiveTemplate = templateId;
    renderDownloadTemplates();
    const tpl = _dlTemplates.find((x) => x.id === templateId);
    showToast(t('toast.templateSwitched', { name: tpl?.name || t('toast.templateDefaultName') }), 'info');
  } catch (e) {
    logger.error(`[setActiveTemplate] error:`, e);
  }
}

export function openDlTemplateEditor(templateId) {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');
  const titleEl = document.getElementById('dlTemplateEditorTitle');

  if (templateId) {
    const tpl = _dlTemplates.find((x) => x.id === templateId);
    if (tpl) {
      titleEl.textContent = '✏️ 编辑路径模板';
      nameInput.value = tpl.name;
      // 预填真正生效的那份（相对片段），否则用户看到绝对路径、照着改完存回去，
      // 换下载目录时又变成一份绑死在旧目录上的模板
      pathInput.value = tpl.subpath || tpl.path;
      modal.dataset.editId = templateId;
    }
  } else {
    titleEl.textContent = '➕ 新建路径模板';
    nameInput.value = '';
    pathInput.value = '';
    delete modal.dataset.editId;
  }

  updateTemplateVarHints();
  ensureDlTemplatePreview();
  updateDlPathPreview();
  modal.classList.remove('hidden');
  nameInput.focus();
}

export function closeDlTemplateEditor() {
  document.getElementById('dlTemplateEditorModal').classList.add('hidden');
}

function updateTemplateVarHints() {
  const el = document.getElementById('dlTemplateVarHints');
  if (el) {
    el.innerHTML = '可用变量: {artist} {album} {title} {source} {year} {track}，'
      + '路径按「相对下载目录」写，如: <code>{artist}/{album}</code>（绝对路径也可，但必须落在下载目录内）';
  }
}

// ── 路径模板实时预览 ─────────────────────────────────
// 文件名模板早就有实时预览（filenameTmplPreview），路径模板是这条线上唯一的例外：
// 用户写完 {artist}/{album} 只能存下、下载一首、再去目录里核对。本段补上落点预览。
// 两条纪律：① 段渲染跑在主进程（renderer 是打包的 ESM，拿不到 src/utils 下的模块），
// 复用既有 'preview-naming-template' 通道取数，不为预览再开一条通道；
// ② 预览节点由这里自己造、不写进 index.html —— 模态框是编辑器专属外壳，
// 少一处和并发改动抢同一份 HTML。文案一律 textContent（路径段可能含用户输入）。

let _dlPathPreviewTimer = null;

export function ensureDlTemplatePreview() {
  const input = document.getElementById('dlTemplatePath');
  if (!input) return null;
  let box = document.getElementById('dlTemplatePathPreview');
  if (!box) {
    box = document.createElement('p');
    box.id = 'dlTemplatePathPreview';
    // 与命名模板预览同一副长相（setting-hint + 等宽青字），两处预览该像一件事
    box.className = 'setting-hint';
    box.style.color = 'var(--neon-cyan)';
    box.style.fontFamily = 'monospace';
    input.insertAdjacentElement('afterend', box);
    // 模态框元素常驻，监听器只在造壳时绑一次
    input.addEventListener('input', updateDlPathPreview);
  }
  return box;
}

export function updateDlPathPreview() {
  const input = document.getElementById('dlTemplatePath');
  const box = ensureDlTemplatePreview();
  if (!input || !box) return;
  const raw = input.value.trim();
  if (!raw) {
    box.textContent = '示例落点：（未填路径 —— 歌曲直接落在下载目录根下）';
    return;
  }
  clearTimeout(_dlPathPreviewTimer);
  _dlPathPreviewTimer = setTimeout(async () => {
    try {
      const r = await api.previewNamingTemplate({ pathTpl: raw });
      if (input.value.trim() !== raw) return; // 键入已变，丢掉这次跨进程结果
      if (!r) return;
      const segs = r.pathSegments || [];
      box.textContent = '示例落点：'
        + (segs.length ? segs.join(' \\ ') : '（这一串取不到值 —— 歌曲会落在下载目录根下）');
      const dropped = r.pathDropped || [];
      if (dropped.length) {
        box.textContent += ' | 不会建目录的段: ' + dropped.join('、')
          + '（变量名不认识，或该歌曲没有这一项）';
      }
    } catch (_e) {
      // 预览失败不许打断编辑器：留空即可，保存路径本身有主进程校验兜底
      box.textContent = '';
    }
  }, 250);
}

export async function saveDlTemplate() {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');

  const name = nameInput.value.trim();
  const path = pathInput.value.trim();
  if (!name || !path) {
    showToast(t('toast.templateNameRequired'), 'warn');
    return;
  }

  const editId = modal.dataset.editId;
  try {
    const result = await api.saveDownloadTemplate({
      ...(editId ? { id: editId } : {}),
      name, path,
    });
    if (result.success) {
      await loadDownloadTemplates();
      closeDlTemplateEditor();
      showToast(editId ? t('toast.templateUpdated') : t('toast.templateCreated'), 'success');
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

export async function deleteDlTemplate(templateId) {
  if (!await askConfirm(t('toast.templateConfirmDelete'))) return;
  try {
    const result = await api.deleteDownloadTemplate(templateId);
    if (result.success) {
      await loadDownloadTemplates();
      showToast(t('toast.templateDeleted'), 'success');
    }
  } catch (e) {
    showToast(t('toast.deleteFailedMsg', { msg: errBrief(e) }), 'error');
  }
}
