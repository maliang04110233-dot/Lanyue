/**
 * 设置视图 - WebDAV 云同步模块
 */

import { t } from '../i18n.js';

export async function loadWebdavConfig() {
  try {
    const cfg = await window.ipcRenderer.invoke('cloud-sync-config-get');
    const urlEl = document.getElementById('webdavUrl');
    if (!urlEl) return;
    urlEl.value = cfg.url || '';
    document.getElementById('webdavUser').value = cfg.user || '';
    document.getElementById('webdavPass').value = '';
    document.getElementById('webdavPass').placeholder = cfg.hasPass ? '已保存（留空则不修改）' : 'WebDAV 密码';
    const insecureEl = document.getElementById('webdavAllowInsecure');
    if (insecureEl) insecureEl.checked = cfg.allowInsecure === true;
    const last = document.getElementById('webdavLastSync');
    if (last) {
      last.textContent = cfg.lastSyncAt
        ? '上次同步: ' + new Date(cfg.lastSyncAt).toLocaleString()
        : '尚未同步过';
    }
  } catch (e) {
    logger.error('读取 WebDAV 配置失败:', e);
  }
}

export function credentialErrorText(code) {
  if (code === 'SECRET_STORAGE_UNAVAILABLE') return t('toast.secretStorageUnavailable');
  return code;
}

export async function saveWebdavConfig() {
  try {
    const pass = document.getElementById('webdavPass').value;
    const url = document.getElementById('webdavUrl').value.trim();
    const allowInsecure = document.getElementById('webdavAllowInsecure')?.checked === true;
    const isLocalHost = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
    if (url && url.startsWith('http://') && !isLocalHost) {
      showToast(t('toast.webdavInsecure'), 'warn', 6000);
    }
    const r = await window.ipcRenderer.invoke('cloud-sync-config-set', {
      url,
      user: document.getElementById('webdavUser').value.trim(),
      allowInsecure,
      ...(pass ? { pass } : {}),
    });
    if (r.success) {
      showToast(t('toast.webdavSaved'), 'success');
      loadWebdavConfig();
    } else {
      showToast(t('toast.saveFailedDetail', { msg: credentialErrorText(r.error) }), 'error', 8000);
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

export async function runWebdavSync() {
  showToast(t('toast.webdavSyncing'));
  try {
    const r = await window.ipcRenderer.invoke('cloud-sync-now');
    if (r.success) {
      showToast(
        t('toast.webdavSyncDone', {
          playlists: r.summary.playlists, templates: r.summary.templates, history: r.summary.historyTotal,
        }),
        'success', 5000,
      );
    } else {
      showToast(t('toast.webdavSyncFailed', { msg: r.error }), 'error');
    }
    loadWebdavConfig();
  } catch (e) {
    showToast(t('toast.webdavSyncFailed', { msg: errBrief(e) }), 'error');
  }
}
