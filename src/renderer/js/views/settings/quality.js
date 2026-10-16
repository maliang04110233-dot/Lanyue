/**
 * 设置视图 - 质量策略模块
 *
 * 负责：分平台音质、换源排除、质量策略规则
 */

import { getPlatforms, platformIcon, platformName } from '../../utils.js';
import { QUALITY_OPTIONS, QUALITY_FIXED, getQualityBySource } from '../../quality.js';
import { setState } from '../../state.js';
import { t } from '../../i18n.js';

// ── 分平台音质 ─────────────────────────────────────────

let _qualityBySourceTimer = null;

export function qualityPlatformIds() {
  const ids = getPlatforms().map(x => x && x.id).filter(Boolean);
  return ids.length ? ids : fallbackPlatformIds();
}

function _qualitySelectOptions(selected) {
  let opts = '<option value="">' + esc('跟随默认') + '</option>';
  for (const o of QUALITY_OPTIONS) {
    opts += '<option value="' + escAttr(o.value) + '"' +
      (selected === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }
  return opts;
}

export async function loadQualityBySource() {
  let map = null;
  try { map = await api.getPref('qualityBySource'); }
  catch (e) { logger.warn('读取分平台音质失败:', e.message); }
  setState('qualityBySource', (map && typeof map === 'object' && !Array.isArray(map)) ? map : {});
  renderQualityBySource();
}

export function renderQualityBySource() {
  const el = document.getElementById('qualityBySourceList');
  if (!el) return;
  const map = getQualityBySource();
  el.innerHTML = qualityPlatformIds().map(id => {
    const fixed = QUALITY_FIXED.has(id);
    const cur = map[id] || '';
    const icon = platformIcon(id);
    return '<div class="quality-map-row' + (fixed ? ' quality-map-row--fixed' : '') + '">' +
      '<div class="quality-map-name" title="' + escAttr(platformName(id)) + '">' +
        (icon ? esc(icon) + ' ' : '') + esc(platformName(id)) + '</div>' +
      '<select class="setting-select quality-map-select"' +
        (fixed ? ' disabled' : '') +
        ' data-qs-id="' + escAttr(id) + '"' +
        (fixed ? '' : ' onchange="onQualityBySourceChange(this)"') + '>' +
        _qualitySelectOptions(cur) +
      '</select>' +
    '</div>';
  }).join('');
}

export function onQualityBySourceChange(sel) {
  const map = getQualityBySource();
  const id = sel.dataset.qsId;
  if (!id) return;
  if (sel.value) map[id] = sel.value; else delete map[id];
  setState('qualityBySource', map);
  clearTimeout(_qualityBySourceTimer);
  _qualityBySourceTimer = setTimeout(() => saveQualityBySource(map), 250);
}

async function saveQualityBySource(map) {
  try { await api.setPref('qualityBySource', map); }
  catch (e) { logger.warn('保存分平台音质失败:', e.message); }
}

export async function resetQualityBySource() {
  clearTimeout(_qualityBySourceTimer);
  setState('qualityBySource', {});
  await saveQualityBySource({});
  renderQualityBySource();
  showToast(t('toast.qualityFollowReset'), 'info');
}

// ── 换源排除平台 ─────────────────────────────────────────

let _fallbackDisabledTimer = null;
let _fallbackDisabledIds = [];

export async function loadFallbackDisabled() {
  let arr = [];
  try {
    const v = await api.getPref('fallbackDisabledPlatforms');
    if (Array.isArray(v)) arr = v.filter((x) => typeof x === 'string' && x);
  } catch (e) { logger.warn('读取换源排除平台失败:', e.message); }
  _fallbackDisabledIds = arr;
  renderFallbackDisabled();
}

export function renderFallbackDisabled() {
  const el = document.getElementById('fallbackDisabledList');
  if (!el) return;
  el.innerHTML = qualityPlatformIds().map(id => {
    const on = _fallbackDisabledIds.includes(id);
    const icon = platformIcon(id);
    return '<div class="quality-map-row">' +
      '<label class="quality-map-name" style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
        '<input type="checkbox"' + (on ? ' checked' : '') +
          ' data-fd-id="' + escAttr(id) + '" onchange="onFallbackDisabledToggle(this)">' +
        (icon ? esc(icon) + ' ' : '') + esc(platformName(id)) +
      '</label>' +
    '</div>';
  }).join('');
}

export function onFallbackDisabledToggle(cb) {
  const id = cb.dataset.fdId;
  if (!id) return;
  const i = _fallbackDisabledIds.indexOf(id);
  if (cb.checked && i < 0) _fallbackDisabledIds.push(id);
  else if (!cb.checked && i >= 0) _fallbackDisabledIds.splice(i, 1);
  clearTimeout(_fallbackDisabledTimer);
  _fallbackDisabledTimer = setTimeout(() => {
    api.setPref('fallbackDisabledPlatforms', _fallbackDisabledIds.slice());
  }, 250);
}

export async function resetFallbackDisabled() {
  clearTimeout(_fallbackDisabledTimer);
  _fallbackDisabledIds = [];
  renderFallbackDisabled();
  await api.setPref('fallbackDisabledPlatforms', []);
  showToast(t('toast.sourceSwitchReset'), 'info');
}

// ── 下载质量策略规则 ─────────────────────────────────────

let _qualityPolicyRules = [];
let _qualityPolicyTimer = null;

const QUALITY_POLICY_IDS = ['min_quality', 'max_size', 'already_have', 'exclude_names'];

const QUALITY_POLICY_DEFAULTS = {
  min_quality: { min: 'hq' },
  max_size: { maxMb: 50, to: 'hq' },
  already_have: { scope: 'artist' },
  exclude_names: { names: [] },
};

export async function loadQualityPolicy() {
  let raw = null;
  try { raw = await api.getPref('qualityPolicyRules'); }
  catch (e) { logger.warn('读取质量策略规则失败:', e.message); }
  _qualityPolicyRules = normalizeQualityPolicyRules(raw);
  renderQualityPolicy();
}

function normalizeQualityPolicyRules(raw) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (list && !Array.isArray(list)) list = Array.isArray(list.rules) ? list.rules : [list];
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r === 'object' && QUALITY_POLICY_IDS.includes(r.id))
    .map(r => ({
      id: r.id,
      enabled: r.enabled !== false,
      params: (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) ? r.params : {},
    }));
}

function _policyRuleLabel(id) {
  if (id === 'min_quality') return t('settings.policy.rule.min_quality');
  if (id === 'max_size') return t('settings.policy.rule.max_size');
  if (id === 'already_have') return t('settings.policy.rule.already_have');
  if (id === 'exclude_names') return t('settings.policy.rule.exclude_names');
  return '';
}

function _policyQualityOptions(cur) {
  let out = '';
  for (const q of ['standard', 'hq', 'lossless']) {
    let label = '';
    if (q === 'standard') label = t('settings.policy.q.standard');
    else if (q === 'hq') label = t('settings.policy.q.hq');
    else if (q === 'lossless') label = t('settings.policy.q.lossless');
    out += '<option value="' + q + '"' + (q === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  return out;
}

function _policyParamCtrl(r, i) {
  if (r.id === 'min_quality') {
    return '<select class="setting-select" onchange="onPolicyParam(' + i + ",'min',this.value)\">"
      + _policyQualityOptions(r.params.min || 'standard') + '</select>';
  }
  if (r.id === 'max_size') {
    return '<input class="setting-input setting-input--num" style="width:76px" type="number" min="1" step="1" value="'
      + escAttr(String(r.params.maxMb || 50)) + '" onchange="onPolicyParam(' + i + ",'maxMb',this.value)\">"
      + '<span class="setting-hint" style="margin:0 4px">MB &rarr;</span>'
      + '<select class="setting-select" onchange="onPolicyParam(' + i + ",'to',this.value)\">"
      + _policyQualityOptions(r.params.to || 'hq') + '</select>';
  }
  if (r.id === 'already_have') {
    const scope = r.params.scope || 'artist';
    return '<select class="setting-select" onchange="onPolicyParam(' + i + ",'scope',this.value)\">"
      + '<option value="artist"' + (scope === 'artist' ? ' selected' : '') + '>' + esc(t('settings.policy.scopeArtist')) + '</option>'
      + '<option value="album"' + (scope === 'album' ? ' selected' : '') + '>' + esc(t('settings.policy.scopeAlbum')) + '</option>'
      + '</select>';
  }
  if (r.id === 'exclude_names') {
    const names = Array.isArray(r.params.names) ? r.params.names.join(',') : String(r.params.names || '');
    return '<input class="setting-input setting-input--wide" value="' + escAttr(names)
      + '" onchange="onPolicyParam(' + i + ",'names',this.value)\">";
  }
  return '';
}

export function renderQualityPolicy() {
  const el = document.getElementById('qualityPolicyList');
  if (!el) return;
  if (!_qualityPolicyRules.length) {
    el.innerHTML = '<div class="setting-hint">' + esc(t('settings.policy.empty')) + '</div>';
    return;
  }
  el.innerHTML = _qualityPolicyRules.map((r, i) => {
    const idx = String(i);
    return '<div class="quality-map-row' + (r.enabled ? '' : ' quality-map-row--fixed') + '" data-qp-idx="' + idx + '">'
      + '<div class="quality-map-name" title="' + escAttr(_policyRuleLabel(r.id)) + '">' + esc(_policyRuleLabel(r.id)) + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex:1;justify-content:flex-end;flex-wrap:wrap;">'
      + _policyParamCtrl(r, i) + '</div>'
      + '<button class="action-btn" style="width:auto;height:auto;padding:2px 8px;font-size:11px;" title="'
      + escAttr(t('settings.policy.toggle')) + '" onclick="toggleQualityPolicy(' + idx + ')">'
      + (r.enabled ? '&#10003;' : '&#10007;') + '</button>'
      + '<button class="action-btn" style="width:auto;height:auto;padding:2px 8px;font-size:11px;" title="'
      + escAttr(t('settings.policy.up')) + '" onclick="moveQualityPolicy(' + idx + ',-1)">&uarr;</button>'
      + '<button class="action-btn" style="width:auto;height:auto;padding:2px 8px;font-size:11px;" title="'
      + escAttr(t('settings.policy.down')) + '" onclick="moveQualityPolicy(' + idx + ',1)">&darr;</button>'
      + '<button class="action-btn" style="width:auto;height:auto;padding:2px 8px;font-size:11px;" title="'
      + escAttr(t('settings.policy.remove')) + '" onclick="removeQualityPolicy(' + idx + ')">&times;</button>'
      + '</div>';
  }).join('');
}

function _saveQualityPolicy() {
  clearTimeout(_qualityPolicyTimer);
  _qualityPolicyTimer = setTimeout(async () => {
    try { await api.setPref('qualityPolicyRules', _qualityPolicyRules); }
    catch (e) { showToast(errBrief(e), 'error'); }
  }, 250);
}

export function onPolicyParam(i, key, value) {
  const r = _qualityPolicyRules[i];
  if (!r) return;
  r.params = r.params || {};
  if (key === 'names') {
    r.params.names = String(value).split(/[,，]/).map(s => s.trim()).filter(Boolean);
  } else if (key === 'maxMb') {
    r.params.maxMb = Math.max(1, Number(value) || 50);
  } else {
    r.params[key] = value;
  }
  _saveQualityPolicy();
}

export function toggleQualityPolicy(i) {
  const r = _qualityPolicyRules[i];
  if (!r) return;
  r.enabled = !r.enabled;
  renderQualityPolicy();
  _saveQualityPolicy();
}

export function moveQualityPolicy(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= _qualityPolicyRules.length) return;
  const arr = _qualityPolicyRules;
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
  renderQualityPolicy();
  _saveQualityPolicy();
}

export function removeQualityPolicy(i) {
  _qualityPolicyRules.splice(i, 1);
  renderQualityPolicy();
  _saveQualityPolicy();
}

export function addQualityPolicy(id) {
  if (!QUALITY_POLICY_IDS.includes(id)) return;
  _qualityPolicyRules.push({ id, enabled: true, params: { ...QUALITY_POLICY_DEFAULTS[id] } });
  renderQualityPolicy();
  _saveQualityPolicy();
}

export async function resetQualityPolicy() {
  clearTimeout(_qualityPolicyTimer);
  _qualityPolicyRules = [];
  try { await api.setPref('qualityPolicyRules', []); }
  catch (e) { showToast(errBrief(e), 'error'); }
  renderQualityPolicy();
  showToast(t('settings.policy.resetDone'), 'info');
}
