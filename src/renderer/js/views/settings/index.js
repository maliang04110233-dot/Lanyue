/**
 * 设置视图 - 聚合入口
 *
 * 按功能域拆分为 6 个子模块，本文件负责统一导出与全局桥接。
 * 子模块：
 *   - account.js    账户平台管理（账号卡片、Cookie、源健康度）
 *   - quality.js    质量策略（分平台音质、换源排除、质量规则）
 *   - general.js    通用设置（主题、快捷键、文件名模板）
 *   - templates.js  下载路径模板管理
 *   - mcp.js        MCP 本地服务
 *   - webdav.js     WebDAV 云同步
 */

import { t } from '../../i18n.js';
import { errBrief } from '../../errBrief.js';
import { askConfirm } from '../../confirmDialog.js';
import { planSettingsSearch } from '../../settingsSearch.js';

// ── 子模块导入 ─────────────────────────────────────────
import {
  _accountPlatforms,
  loadAccountPlatforms,
  loadAccountCardStatus,
  loadCookieStatus,
  loadSourceHealth,
  probeSourcesUI,
  saveCookie,
  clearCookie,
  verifyCookieUI,
  analyzeCookieUI,
  openLoginWindowUI,
} from './account.js';

import {
  loadQualityBySource,
  onQualityBySourceChange,
  resetQualityBySource,
  loadFallbackDisabled,
  onFallbackDisabledToggle,
  resetFallbackDisabled,
  loadCrossSourceFallback,
  onCrossSourceFallbackToggle,
  loadQualityPolicy,
  renderQualityPolicy,
  onPolicyParam,
  toggleQualityPolicy,
  moveQualityPolicy,
  removeQualityPolicy,
  addQualityPolicy,
  resetQualityPolicy,
} from './quality.js';

import {
  GENERAL_PREFS,
  loadGeneralSettings,
  applyTheme,
  selectTheme,
  setupGeneralSettingListeners,
} from './general.js';

import {
  loadDownloadTemplates,
  setActiveTemplate,
  openDlTemplateEditor,
  closeDlTemplateEditor,
  saveDlTemplate,
  deleteDlTemplate,
} from './templates.js';

import {
  loadMcpConfig,
  toggleMcpService,
  rotateMcpToken,
  applyMcpPort,
  copyMcpSnippet,
  clearMcpAudit,
  loadMcpAudit,
} from './mcp.js';

import {
  loadWebdavConfig,
  saveWebdavConfig,
  runWebdavSync,
} from './webdav.js';

// ── 本模块私有 ─────────────────────────────────────────
const _settingsDom = {
  overlay: null,
  cacheSize: null,
};

function _cacheSettingsDom() {
  _settingsDom.overlay = document.getElementById('settingsOverlay');
  _settingsDom.cacheSize = document.getElementById('cacheSize');
}

// ── 设置面板切换 ──────────────────────────────────────
function switchSettingsTab(tab, btn) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.settings-page').forEach(el => el.classList.add('hidden'));
  const page = document.getElementById('settingsPage' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (page) page.classList.remove('hidden');
}

function openSettings() {
  if (_settingsDom.overlay) _settingsDom.overlay.classList.remove('hidden');
  const firstNav = document.querySelector('.settings-nav-item');
  if (firstNav) switchSettingsTab('accounts', firstNav);
  const searchInput = document.getElementById('settingsSearchInput');
  if (searchInput) searchInput.value = '';
  clearSettingsSearch();
  loadAccountPlatforms();
  Promise.all([
    ..._accountPlatforms.cookie.map(p => loadAccountCardStatus(p.id)),
    loadGeneralSettings(),
    loadQualityBySource(),
    loadFallbackDisabled(),
    loadCrossSourceFallback(),
    loadQualityPolicy(),
    updateCacheSize(),
    loadDownloadTemplates(),
    loadSourceHealth(),
    loadWebdavConfig(),
    loadMcpConfig(),
  ]);
}

function closeSettings() {
  if (_settingsDom.overlay) _settingsDom.overlay.classList.add('hidden');
}

function closeSettingsOnBg(e) {
  if (e.target === _settingsDom.overlay) closeSettings();
}

// ── 缓存管理 ──────────────────────────────────────────
async function updateCacheSize() {
  try {
    const size = await api.getCacheSize();
    const el = document.getElementById('cacheSizeLabel');
    if (el) el.textContent = size ? `当前缓存 ${size}` : '暂无缓存';
  } catch (e) {
    // 静默
  }
}

async function clearPlayCache() {
  try {
    await api.clearPlayCache();
    showToast(t('toast.cacheCleared'), 'success');
    updateCacheSize();
  } catch (e) {
    showToast(t('toast.cacheClearFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 恢复默认设置 ──────────────────────────────────────
async function resetAllSettings() {
  if (!await askConfirm(t('toast.resetConfirm'))) return;

  const defaults = {};
  for (const meta of Object.values(GENERAL_PREFS)) defaults[meta.key] = meta.default;

  try {
    for (const [key, value] of Object.entries(defaults)) {
      await api.setPref(key, value);
    }
    await loadGeneralSettings();
    const shortcutMaster = document.getElementById('settingGlobalShortcuts');
    if (shortcutMaster) shortcutMaster.dispatchEvent(new Event('change'));
    applyTheme('default');
    if (window.i18n) await window.i18n.setLanguage(GENERAL_PREFS.language.default);
    window.resetEq();
    window.resetPlaybackPrefs();
    window.resetFadeSettings();
    window.resetAfterQueueAction();
    showToast(t('toast.settingsReset'), 'success');
  } catch (e) {
    showToast(t('toast.settingsResetFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 备份与恢复 ───────────────────────────────────────
async function exportConfig() {
  try {
    const result = await window.ipcRenderer.invoke('export-all-data');
    if (result.canceled) return;
    if (result.success) {
      showToast(t('toast.exportSuccess', { path: result.path }), 'success');
    } else {
      showToast(t('toast.exportFailed', { msg: result.error }), 'error');
    }
  } catch (e) {
    showToast(t('toast.exportFailed', { msg: errBrief(e) }), 'error');
  }
}

async function importConfig() {
  if (!await askConfirm(t('toast.importConfirm'))) return;
  try {
    const result = await api.invoke('import-all-data');
    if (result.canceled) return;
    if (result.success) {
      showToast(t('toast.importSuccess'), 'success', 5000);
    } else {
      showToast(t('toast.importFailed', { msg: result.error }), 'error');
    }
  } catch (e) {
    showToast(t('toast.importFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 设置项搜索 ───────────────────────────────────────

function _settingBlockNodes(el) {
  if (el.classList.contains('setting-row')) {
    return [{ kind: 'row', el, text: el.textContent || '' }];
  }
  const rows = Array.from(el.querySelectorAll('.setting-row'));
  if (!rows.length) return [{ kind: 'other', el, text: el.textContent || '' }];
  const nodes = rows.map((r) => ({ kind: 'row', el: r, text: r.textContent || '' }));
  nodes.push({ kind: 'other', el, text: '' });
  return nodes;
}

function _parseSettingsPages() {
  const parsed = [];
  document.querySelectorAll('.settings-page').forEach((page) => {
    const sections = [];
    let cur = null;
    const ensure = () => {
      if (!cur) { cur = { title: null, titleEl: null, blocks: [] }; sections.push(cur); }
      return cur;
    };
    Array.from(page.children).forEach((el) => {
      if (el.classList.contains('settings-section-title')) {
        cur = { title: (el.textContent || '').trim(), titleEl: el, blocks: [] };
        sections.push(cur);
      } else {
        ensure().blocks.push(..._settingBlockNodes(el));
      }
    });
    parsed.push({ page, sections });
  });
  return parsed;
}

function runSettingsSearch(term) {
  const parsed = _parseSettingsPages();
  const navItems = Array.from(document.querySelectorAll('.settings-nav-item'));
  const emptyEl = document.getElementById('settingsSearchEmpty');
  const plan = planSettingsSearch(
    parsed.map((pg) => pg.sections.map((sec) => ({ title: sec.title, blocks: sec.blocks }))),
    term
  );
  if (!plan) { clearSettingsSearch(); return; }
  let switchTo = -1;
  plan.pages.forEach((pp, pi) => {
    const secs = parsed[pi].sections;
    secs.forEach((sec, si) => {
      const sp = pp.sections[si];
      if (sec.titleEl) sec.titleEl.classList.toggle('srch-hide', !sp.keep);
      sec.blocks.forEach((b, bi) => b.el.classList.toggle('srch-hide', !sp.visible[bi]));
    });
    const nav = navItems[pi];
    if (nav) {
      let badge = nav.querySelector('.settings-nav-hit');
      if (pp.hits > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'settings-nav-hit';
          nav.appendChild(badge);
        }
        badge.textContent = String(pp.hits);
      } else if (badge) {
        badge.remove();
      }
    }
    if (pp.hits > 0 && switchTo < 0) switchTo = pi;
  });
  if (emptyEl) emptyEl.classList.toggle('hidden', plan.total > 0);
  const active = document.querySelector('.settings-page:not(.hidden)');
  const activeIdx = parsed.findIndex((pg) => pg.page === active);
  if (switchTo >= 0 && activeIdx !== switchTo) {
    const btn = navItems[switchTo];
    if (btn) switchSettingsTab(btn.dataset.tab, btn);
  }
}

function clearSettingsSearch() {
  document.querySelectorAll('.settings-page .srch-hide').forEach((el) => el.classList.remove('srch-hide'));
  document.querySelectorAll('.settings-nav-hit').forEach((el) => el.remove());
  const emptyEl = document.getElementById('settingsSearchEmpty');
  if (emptyEl) emptyEl.classList.add('hidden');
}

function focusSettingsSearch() {
  openSettings();
  const input = document.getElementById('settingsSearchInput');
  if (input) { input.focus(); input.select(); }
}

// ── DOM 就绪后绑定事件 ─────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupGeneralSettingListeners);
} else {
  setupGeneralSettingListeners();
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  openSettings,
  closeSettings,
  closeSettingsOnBg,
  switchSettingsTab,
  loadCookieStatus,
  loadAccountPlatforms,
  saveCookie,
  clearCookie,
  verifyCookieUI,
  openLoginWindowUI,
  analyzeCookieUI,
  clearPlayCache,
  resetAllSettings,
  exportConfig,
  importConfig,
  loadWebdavConfig,
  saveWebdavConfig,
  runWebdavSync,
  loadGeneralSettings,
  loadQualityBySource,
  loadFallbackDisabled,
  loadSourceHealth,
  probeSourcesUI,
  applyTheme,
  runSettingsSearch,
  clearSettingsSearch,
  focusSettingsSearch,
  // 额外导出（供子模块间共享）
  loadQualityPolicy,
  renderQualityPolicy,
  onPolicyParam,
  toggleQualityPolicy,
  moveQualityPolicy,
  removeQualityPolicy,
  addQualityPolicy,
  resetQualityPolicy,
  onQualityBySourceChange,
  resetQualityBySource,
  onFallbackDisabledToggle,
  resetFallbackDisabled,
  selectTheme,
  loadDownloadTemplates,
  openDlTemplateEditor,
  closeDlTemplateEditor,
  setActiveTemplate,
  deleteDlTemplate,
  toggleMcpService,
  rotateMcpToken,
  applyMcpPort,
  copyMcpSnippet,
  clearMcpAudit,
  loadMcpAudit,
  updateCacheSize,
  loadMcpConfig,
};

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.closeSettingsOnBg = closeSettingsOnBg;
window.switchSettingsTab = switchSettingsTab;
window.loadQualityBySource = loadQualityBySource;
window.onQualityBySourceChange = onQualityBySourceChange;
window.resetQualityBySource = resetQualityBySource;
window.loadFallbackDisabled = loadFallbackDisabled;
window.onFallbackDisabledToggle = onFallbackDisabledToggle;
window.resetFallbackDisabled = resetFallbackDisabled;
window.loadCrossSourceFallback = loadCrossSourceFallback;
window.onCrossSourceFallbackToggle = onCrossSourceFallbackToggle;
window.loadQualityPolicy = loadQualityPolicy;
window.renderQualityPolicy = renderQualityPolicy;
window.onPolicyParam = onPolicyParam;
window.toggleQualityPolicy = toggleQualityPolicy;
window.moveQualityPolicy = moveQualityPolicy;
window.removeQualityPolicy = removeQualityPolicy;
window.addQualityPolicy = addQualityPolicy;
window.resetQualityPolicy = resetQualityPolicy;
window.selectTheme = selectTheme;
window.loadCookieStatus = loadCookieStatus;
window.loadAccountPlatforms = loadAccountPlatforms;
window.saveCookie = saveCookie;
window.clearCookie = clearCookie;
window.verifyCookieUI = verifyCookieUI;
window.openLoginWindowUI = openLoginWindowUI;
window.analyzeCookieUI = analyzeCookieUI;
window.clearPlayCache = clearPlayCache;
window.resetAllSettings = resetAllSettings;
window.exportConfig = exportConfig;
window.importConfig = importConfig;
window.saveWebdavConfig = saveWebdavConfig;
window.runWebdavSync = runWebdavSync;
window.toggleMcpService = toggleMcpService;
window.rotateMcpToken = rotateMcpToken;
window.applyMcpPort = applyMcpPort;
window.copyMcpSnippet = copyMcpSnippet;
window.clearMcpAudit = clearMcpAudit;
window.loadMcpAudit = loadMcpAudit;
window.loadGeneralSettings = loadGeneralSettings;
window.loadSourceHealth = loadSourceHealth;
window.probeSourcesUI = probeSourcesUI;
window.loadDownloadTemplates = loadDownloadTemplates;
window.openDlTemplateEditor = openDlTemplateEditor;
window.closeDlTemplateEditor = closeDlTemplateEditor;
window.saveDlTemplate = saveDlTemplate;
window.setActiveTemplate = setActiveTemplate;
window.deleteDlTemplate = deleteDlTemplate;
window.applyTheme = applyTheme;
window.runSettingsSearch = runSettingsSearch;
window.focusSettingsSearch = focusSettingsSearch;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheSettingsDom();
