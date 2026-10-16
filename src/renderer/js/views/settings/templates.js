/**
 * 设置视图 - 下载路径模板模块
 */

import { t } from '../i18n.js';

let _dlTemplates = [];
let _dlActiveTemplate = null;
let _dlPathPreviewTimer = null;

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

export function renderDownloadTemplates() {
  const container = document.getElementById('dlTemplateList');
  if (!container) return;

  if (_dlTemplates.length === 0) {
    container.innerHTML = '<div class="empty-tip" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">暂无模板，点击「新建」添加</div>';
    return;
  }

  container.innerHTML = _dlTemplates.map(tpl => {
    const isActive = tpl.id === _dlActiveTemplate;
    const idArg = "'" + escQ(tpl.id) + "'";
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
      pathInput.value = tpl.path;
    }
  } else {
    titleEl.textContent = '新建路径模板';
    nameInput.value = '';
    pathInput.value = '';
  }

  modal.dataset.templateId = templateId || '';
  modal.classList.remove('hidden');
  ensureDlTemplatePreview();
}

export function closeDlTemplateEditor() {
  const modal = document.getElementById('dlTemplateEditorModal');
  modal.classList.add('hidden');
  delete modal.dataset.templateId;
}

export function updateTemplateVarHints() {
  const pathInput = document.getElementById('dlTemplatePath');
  const hint = document.getElementById('dlTemplatePathHint');
  if (!pathInput || !hint) return;
  const known = ['{artist}', '{title}', '{album}', '{year}', '{track}', '{source}', '{quality}'];
  const unknown = Object.keys(pathInput.dataset).filter(k => k.startsWith('var'));
  hint.textContent = known.concat(unknown).join('、');
}

export function ensureDlTemplatePreview() {
  clearTimeout(_dlPathPreviewTimer);
  updateDlPathPreview();
}

export function updateDlPathPreview() {
  const pathInput = document.getElementById('dlTemplatePath');
  const preview = document.getElementById('dlTemplatePathPreview');
  if (!pathInput || !preview) return;
  clearTimeout(_dlPathPreviewTimer);
  _dlPathPreviewTimer = setTimeout(async () => {
    try {
      const r = await api.previewDownloadPath(pathInput.value);
      preview.textContent = r?.preview || '—';
    } catch (_e) {
      preview.textContent = '—';
    }
  }, 250);
}

export async function saveDlTemplate() {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');
  const id = modal.dataset.templateId || null;
  const name = nameInput.value.trim();
  const path = pathInput.value.trim();

  if (!name || !path) { showToast(t('toast.templateFieldMissing'), 'error'); return; }

  try {
    if (id) {
      await api.updateDownloadTemplate(id, { name, path });
    } else {
      await api.createDownloadTemplate({ name, path });
    }
    closeDlTemplateEditor();
    await loadDownloadTemplates();
    showToast(t('toast.templateSaved'), 'success');
  } catch (e) {
    showToast(errBrief(e), 'error');
  }
}

export async function deleteDlTemplate(templateId) {
  if (!askConfirm(t('confirm.deleteTemplate'))) return;
  try {
    await api.deleteDownloadTemplate(templateId);
    await loadDownloadTemplates();
    showToast(t('toast.templateDeleted'), 'info');
  } catch (e) {
    logger.error(`[deleteDlTemplate] error:`, e);
  }
}

export async function loadWebdavConfig() {
  // 云同步配置加载（由 webdav.js 提供具体实现）
  if (typeof window.loadWebdavConfigImpl === 'function') {
    await window.loadWebdavConfigImpl();
  }
}
