/**
 * MusicDL 设置 / Cookie 管理视图 — 兼容层
 *
 * 原始 1600 行巨型文件已拆分为 settings/ 目录下的 6 个子模块：
 *   - account.js    账户平台管理
 *   - quality.js    质量策略
 *   - general.js    通用设置
 *   - templates.js  下载路径模板
 *   - mcp.js        MCP 本地服务
 *   - webdav.js     WebDAV 云同步
 *
 * 本文件保留为兼容层，从新模块重新导出所有公开 API，
 * 确保既有 import 语句无需修改。
 */

/* @module */
import * as _account from './settings/account.js';
import * as _quality from './settings/quality.js';
import * as _general from './settings/general.js';
import * as _templates from './settings/templates.js';
import * as _mcp from './settings/mcp.js';
import * as _webdav from './settings/webdav.js';

// ── 重新导出（保持既有 import 兼容） ────────────────────
export const openSettings = _general.openSettings;
export const closeSettings = _general.closeSettings;
export const closeSettingsOnBg = _general.closeSettingsOnBg;
export const switchSettingsTab = _general.switchSettingsTab;
export const loadCookieStatus = _account.loadCookieStatus;
export const loadAccountPlatforms = _account.loadAccountPlatforms;
export const saveCookie = _account.saveCookie;
export const clearCookie = _account.clearCookie;
export const verifyCookieUI = _account.verifyCookieUI;
export const openLoginWindowUI = _account.openLoginWindowUI;
export const analyzeCookieUI = _account.analyzeCookieUI;
export const clearPlayCache = _general.clearPlayCache;
export const resetAllSettings = _general.resetAllSettings;
export const exportConfig = _general.exportConfig;
export const importConfig = _general.importConfig;
export const loadWebdavConfig = _webdav.loadWebdavConfig;
export const saveWebdavConfig = _webdav.saveWebdavConfig;
export const runWebdavSync = _webdav.runWebdavSync;
export const loadGeneralSettings = _general.loadGeneralSettings;
export const loadQualityBySource = _quality.loadQualityBySource;
export const loadFallbackDisabled = _quality.loadFallbackDisabled;
export const loadSourceHealth = _account.loadSourceHealth;
export const probeSourcesUI = _account.probeSourcesUI;
export const applyTheme = _general.applyTheme;
export const runSettingsSearch = _general.runSettingsSearch;
export const clearSettingsSearch = _general.clearSettingsSearch;
export const focusSettingsSearch = _general.focusSettingsSearch;

// 额外导出（供子模块间共享）
export const loadQualityPolicy = _quality.loadQualityPolicy;
export const renderQualityPolicy = _quality.renderQualityPolicy;
export const onPolicyParam = _quality.onPolicyParam;
export const toggleQualityPolicy = _quality.toggleQualityPolicy;
export const moveQualityPolicy = _quality.moveQualityPolicy;
export const removeQualityPolicy = _quality.removeQualityPolicy;
export const addQualityPolicy = _quality.addQualityPolicy;
export const resetQualityPolicy = _quality.resetQualityPolicy;
export const onQualityBySourceChange = _quality.onQualityBySourceChange;
export const resetQualityBySource = _quality.resetQualityBySource;
export const onFallbackDisabledToggle = _quality.onFallbackDisabledToggle;
export const resetFallbackDisabled = _quality.resetFallbackDisabled;
export const selectTheme = _general.selectTheme;
export const loadDownloadTemplates = _templates.loadDownloadTemplates;
export const openDlTemplateEditor = _templates.openDlTemplateEditor;
export const closeDlTemplateEditor = _templates.closeDlTemplateEditor;
export const setActiveTemplate = _templates.setActiveTemplate;
export const deleteDlTemplate = _templates.deleteDlTemplate;
export const toggleMcpService = _mcp.toggleMcpService;
export const rotateMcpToken = _mcp.rotateMcpToken;
export const applyMcpPort = _mcp.applyMcpPort;
export const copyMcpSnippet = _mcp.copyMcpSnippet;
export const clearMcpAudit = _mcp.clearMcpAudit;
export const loadMcpAudit = _mcp.loadMcpAudit;
export const updateCacheSize = _general.updateCacheSize;
export const loadMcpConfig = _mcp.loadMcpConfig;

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.openSettings = _general.openSettings;
window.closeSettings = _general.closeSettings;
window.closeSettingsOnBg = _general.closeSettingsOnBg;
window.switchSettingsTab = _general.switchSettingsTab;
window.loadQualityBySource = _quality.loadQualityBySource;
window.onQualityBySourceChange = _quality.onQualityBySourceChange;
window.resetQualityBySource = _quality.resetQualityBySource;
window.loadFallbackDisabled = _quality.loadFallbackDisabled;
window.onFallbackDisabledToggle = _quality.onFallbackDisabledToggle;
window.resetFallbackDisabled = _quality.resetFallbackDisabled;
window.loadQualityPolicy = _quality.loadQualityPolicy;
window.renderQualityPolicy = _quality.renderQualityPolicy;
window.onPolicyParam = _quality.onPolicyParam;
window.toggleQualityPolicy = _quality.toggleQualityPolicy;
window.moveQualityPolicy = _quality.moveQualityPolicy;
window.removeQualityPolicy = _quality.removeQualityPolicy;
window.addQualityPolicy = _quality.addQualityPolicy;
window.resetQualityPolicy = _quality.resetQualityPolicy;
window.selectTheme = _general.selectTheme;
window.loadCookieStatus = _account.loadCookieStatus;
window.loadAccountPlatforms = _account.loadAccountPlatforms;
window.saveCookie = _account.saveCookie;
window.clearCookie = _account.clearCookie;
window.verifyCookieUI = _account.verifyCookieUI;
window.openLoginWindowUI = _account.openLoginWindowUI;
window.analyzeCookieUI = _account.analyzeCookieUI;
window.clearPlayCache = _general.clearPlayCache;
window.resetAllSettings = _general.resetAllSettings;
window.exportConfig = _general.exportConfig;
window.importConfig = _general.importConfig;
window.saveWebdavConfig = _webdav.saveWebdavConfig;
window.runWebdavSync = _webdav.runWebdavSync;
window.toggleMcpService = _mcp.toggleMcpService;
window.rotateMcpToken = _mcp.rotateMcpToken;
window.applyMcpPort = _mcp.applyMcpPort;
window.copyMcpSnippet = _mcp.copyMcpSnippet;
window.clearMcpAudit = _mcp.clearMcpAudit;
window.loadMcpAudit = _mcp.loadMcpAudit;
window.loadGeneralSettings = _general.loadGeneralSettings;
window.loadSourceHealth = _account.loadSourceHealth;
window.probeSourcesUI = _account.probeSourcesUI;
window.loadDownloadTemplates = _templates.loadDownloadTemplates;
window.openDlTemplateEditor = _templates.openDlTemplateEditor;
window.closeDlTemplateEditor = _templates.closeDlTemplateEditor;
window.saveDlTemplate = _templates.saveDlTemplate;
window.setActiveTemplate = _templates.setActiveTemplate;
window.deleteDlTemplate = _templates.deleteDlTemplate;
window.applyTheme = _general.applyTheme;
window.runSettingsSearch = _general.runSettingsSearch;
window.focusSettingsSearch = _general.focusSettingsSearch;
