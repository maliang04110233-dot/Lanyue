/**
 * 设置视图 - MCP 服务模块
 */

import { t } from '../../i18n.js';

let _mcpRunning = false;

export async function loadMcpConfig() {
  try {
    const st = await window.ipcRenderer.invoke('mcp-status');
    const portEl = document.getElementById('mcpPort');
    if (!portEl) return;
    _mcpRunning = !!st.running;
    portEl.value = st.port || '';
    const tokenEl = document.getElementById('mcpToken');
    tokenEl.value = st.token || t('settings.general.mcpTokenPlaceholder');
    tokenEl.readOnly = !!st.token;
    document.getElementById('mcpToggle').textContent = _mcpRunning
      ? t('settings.general.mcpStop') : t('settings.general.mcpStart');
    document.getElementById('mcpStatusLine').textContent = _mcpRunning
      ? t('settings.general.mcpStatusRunning', { url: st.url })
      : (st.enabled ? t('settings.general.mcpStatusPortBusy') : t('settings.general.mcpStatusOff'));
    await loadMcpSnippet();
    await loadMcpAudit();
  } catch (e) {
    logger.error('读取 MCP 状态失败:', e);
  }
}

export async function loadMcpSnippet() {
  const box = document.getElementById('mcpSnippetBox');
  if (!box) return;
  try {
    const r = await window.ipcRenderer.invoke('mcp-connect-snippet');
    box.value = (r && r.text) || '';
    box.placeholder = (r && r.error) || '';
  } catch (e) {
    box.value = '';
  }
}

export async function loadMcpAudit() {
  const line = document.getElementById('mcpAuditLine');
  const list = document.getElementById('mcpAuditList');
  if (!line || !list) return;
  try {
    const r = await window.ipcRenderer.invoke('mcp-audit', { limit: 20 });
    const items = (r && r.items) || [];
    line.textContent = t('settings.general.mcpAuditHint', {
      count: (r && r.count) || 0, max: (r && r.maxEntries) || 0, rateLimited: (r && r.rateLimited) || 0,
    });
    list.textContent = items.length
      ? items.map(i => `${new Date(i.ts).toLocaleString()}  ${i.tool}  ${i.ok ? 'OK' : 'FAIL'}`
        + `${i.summary ? `  ${i.summary}` : ''}${i.err ? `  ${i.err}` : ''}`).join('\n')
      : t('settings.general.mcpAuditEmpty');
  } catch (e) {
    logger.error('读取 MCP 审计失败:', e);
    line.textContent = t('settings.general.mcpAuditEmpty');
    list.textContent = '';
  }
}

export async function applyMcpPort() {
  await _applyMcpConfig({});
  showToast(t('toast.mcpPortApplied'), 'success', 2000);
}

export async function copyMcpSnippet() {
  const box = document.getElementById('mcpSnippetBox');
  if (!box || !box.value) {
    showToast(t('toast.mcpFailed', { msg: box && box.placeholder ? box.placeholder : t('settings.general.mcpStatusOff') }), 'error', 5000);
    return;
  }
  try {
    await navigator.clipboard.writeText(box.value);
    showToast(t('toast.mcpSnippetCopied'), 'warn', 5000);
  } catch (e) {
    showToast(t('toast.mcpSnippetFailed', { msg: errBrief(e) }), 'error');
  }
}

export async function clearMcpAudit() {
  if (!await askConfirm(t('settings.general.mcpAuditClearConfirm'))) return;
  try {
    const r = await window.ipcRenderer.invoke('mcp-audit-clear');
    if (r && r.success) {
      showToast(t('toast.mcpAuditCleared'), 'success', 2500);
      await loadMcpAudit();
    } else {
      showToast(t('toast.mcpFailed', { msg: (r && r.error) || '' }), 'error');
    }
  } catch (e) {
    showToast(t('toast.mcpFailed', { msg: errBrief(e) }), 'error');
  }
}

async function _applyMcpConfig(patch) {
  const payload = { ...patch };
  const port = Number(document.getElementById('mcpPort').value);
  if (Number.isFinite(port) && port >= 1 && port <= 65535) payload.port = port;
  try {
    const r = await window.ipcRenderer.invoke('mcp-set-config', payload);
    if (!r.success) { showToast('MCP: ' + r.error, 'error', 5000); loadMcpConfig(); return; }
    loadMcpConfig();
  } catch (e) {
    showToast(t('toast.mcpFailed', { msg: errBrief(e) }), 'error');
  }
}

export function toggleMcpService() {
  _applyMcpConfig({ enabled: !_mcpRunning });
}

export function rotateMcpToken() {
  _applyMcpConfig({ rotateToken: true });
  showToast(t('toast.mcpTokenRotated'), 'warn', 5000);
}

export function openMcpAuditLog() {
  if (typeof api.openMcpAuditLog === 'function') {
    api.openMcpAuditLog();
  }
}
