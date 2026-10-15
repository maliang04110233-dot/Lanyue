/**
 * 大模型厂商配置面板（AI 创作页与助手页共用）
 *
 * 为什么是共用一个模块而不是两页各画一套：这两处都要「选厂商 + 填 Key」，而 Key
 * 存的是 {厂商: Key} 的一把映射。两套控件就要两处各写一遍合并语义，而覆盖式写法
 * （直接把新串写进 pref）会抹掉别家已配好的凭据 —— 那是用户数据丢失，不是显示问题。
 * 名单、校验、合并全在主进程侧那一份登记表（src/api/aiProviders.js），本文件只画、只交。
 *
 * 面板里出现不了厂商名：下拉的每个 option 都来自 ai-provider-config 通道。
 * 于是"界面镜像了一份名单"这件事不是靠测试盯着，是根本没有可镜像的地方。
 *
 * Key 也不跨界：配置包里只有「这家配过没有」的布尔，输入框永远从空白开始，
 * 留空 = 不动它（清空输入框不该等于删凭据）。
 */

import { t } from './i18n.js';
import { escHtml } from './escapeFallback.js';
import { errBrief } from './errBrief.js';
import { showToast } from './toast.js';

// 主进程只发 ASCII 令牌，中文措辞留在词典（本仓 toast-i18n 的规矩）
const ERR_KEYS = {
  UNKNOWN_PROVIDER: 'ai.errUnknownProvider',
  PREF_WRITE_FAILED: 'ai.errWriteFailed',
  ENDPOINT_BLOCKED: 'ai.errEndpointBlocked',
  NO_KEY: 'ai.errNoKey',
};

/**
 * 配置类令牌 → 一句话；认不出来的回调用方自己给的 fallback。
 * 助手页与智能歌单页也用它：三处打的是同一个出网闸，同一个失败该说同一句话，
 * 不该各攒一张表再各自漏几行。而「这不是配置类令牌」之后该说什么，各页不同
 * （歌单页不许把大写码印给用户），所以兜底那句由调用方递进来，这儿不替别人做主。
 */
export function providerErrText(error, fallback) {
  const s = String(error == null ? '' : error);
  const colon = s.indexOf(':');
  const head = colon < 0 ? s : s.slice(0, colon);
  const sub = colon < 0 ? '' : s.slice(colon + 1);
  if (head === 'BAD_BASE_URL') return t('ai.errBaseUrl', { code: sub || 'INVALID' });
  if (head === 'BAD_MODEL') return t('ai.errBadModel');
  if (head === 'LLM_HTTP') return t('ai.errLlmHttp', { status: sub || '?' });
  if (ERR_KEYS[head]) return t(ERR_KEYS[head]);
  return typeof fallback === 'string' ? fallback : t('ai.errGeneric', { msg: errBrief(s || 'unknown') });
}

let _cfg = null;          // 最近一次 ai-provider-config 的返回（全应用一份）
let _loading = null;      // 并发挂载时共用同一个请求
const _hosts = new Map(); // 容器 → { onChange }（两页同时活着，谁都得跟着配置刷新）

function _provider(id) {
  const list = (_cfg && _cfg.providers) || [];
  return list.find((p) => p.id === id) || list[0] || null;
}

function _renderHost(host) {
  if (!host || !_cfg) return;
  const cur = _cfg.current;
  const p = _provider(cur.providerId);
  if (!p) return;
  const hasKey = !!_cfg.keys[p.id];
  // 不用 id：两页可能同时在 DOM 里活着，同名 id 会撞车（label 的 for 只能绑到第一份）。
  // 用 class + 容器内作用域查询，label 直接包住控件（原生关联，不需要 for）。
  // 输入框/按钮/链接复用既有的 .ai-input / .ai-btn-action / .ai-link —— 面板只是
  // 把它们排成一行，样式不该在第二个文件里再攒一份长相。
  host.innerHTML = `
    <label class="aip-row">
      <span class="aip-label">${escHtml(t('ai.provider'))}</span>
      <select class="ai-input aip-select">
        ${_cfg.providers.map((x) => `<option value="${escHtml(x.id)}"${x.id === cur.providerId ? ' selected' : ''}>${escHtml(x.label)}</option>`).join('')}
      </select>
    </label>
    <label class="aip-row">
      <span class="aip-label">${escHtml(t('ai.model'))}</span>
      <input class="ai-input aip-model" autocomplete="off" spellcheck="false"
             value="${escHtml(cur.model)}" placeholder="${escHtml(p.defaultModel || t('ai.modelPhAny'))}">
    </label>
    <label class="aip-row">
      <span class="aip-label">${escHtml(t('ai.baseUrl'))}</span>
      <input class="ai-input aip-baseurl" autocomplete="off" spellcheck="false"
             value="${escHtml(cur.baseUrl)}" placeholder="${escHtml(t('ai.baseUrlPh'))}">
    </label>
    <label class="aip-row">
      <span class="aip-label">${escHtml(t('ai.key'))}</span>
      <input class="ai-input aip-key" type="password" autocomplete="off" spellcheck="false"
             placeholder="${escHtml(hasKey ? t('ai.keyPhHas') : t('ai.keyPhNone'))}">
    </label>
    <div class="aip-actions">
      <button class="ai-btn-action aip-save" type="button">${escHtml(t('ai.save'))}</button>
      ${p.keyUrl ? `<a class="ai-link aip-link" href="${escHtml(p.keyUrl)}" target="_blank" rel="noreferrer">${escHtml(t('ai.getKey'))}</a>` : ''}
    </div>
    ${p.music ? '' : `<div class="aip-note">${escHtml(t('ai.textOnly'))}</div>`}
  `;
  const sel = host.querySelector('.aip-select');
  if (sel) sel.addEventListener('change', () => _saveProvider(sel.value));
  const btn = host.querySelector('.aip-save');
  if (btn) btn.addEventListener('click', () => _saveForm(host));
}

function _renderAll() {
  for (const host of _hosts.keys()) _renderHost(host);
}

function _notifyAll() {
  for (const cb of _hosts.values()) {
    if (typeof cb.onChange === 'function') {
      try { cb.onChange(_cfg); } catch (_e) { /* 一页的联动失败不该带走另一页 */ }
    }
  }
}

function _apply(result) {
  if (!result || result.ok !== true) {
    showToast(t('ai.saveFailed', { msg: providerErrText(result && result.error) }), 'error', 6000);
    return false;
  }
  _cfg = result.config;
  _renderAll();
  _notifyAll();
  return true;
}

async function _saveProvider(providerId) {
  const r = await api.aiProviderSave({ providerId });
  if (_apply(r)) showToast(t('ai.providerSwitched', { name: _provider(providerId).label }), 'success');
}

async function _saveForm(host) {
  if (!_cfg) return;
  const val = (sel) => {
    const el = host.querySelector(sel);
    return el ? String(el.value == null ? '' : el.value).trim() : '';
  };
  const patch = { model: val('.aip-model'), baseUrl: val('.aip-baseurl') };
  const key = val('.aip-key');
  if (key) patch.key = { vendorId: _cfg.current.providerId, value: key };
  const r = await api.aiProviderSave(patch);
  if (_apply(r)) showToast(t('ai.saved'), 'success');
}

/**
 * 把面板挂进一个容器。幂等：同一个容器重复挂（切页会重画）只是重画一次，
 * 不叠第二份控件；配置只拉一次，之后两页共用同一份。
 */
export async function mountProviderPanel(host, opts = {}) {
  if (!host) return null;
  if (!_hosts.has(host)) _hosts.set(host, { onChange: typeof opts.onChange === 'function' ? opts.onChange : null });
  else _hosts.get(host).onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  if (_cfg) { _renderHost(host); return _cfg; }
  if (!_loading) {
    _loading = api.aiProviderConfig().then((cfg) => {
      _cfg = cfg && Array.isArray(cfg.providers) ? cfg : null;
      _loading = null;
      return _cfg;
    }).catch(() => { _loading = null; return null; });
  }
  const cfg = await _loading;
  if (!cfg) {
    host.innerHTML = `<div class="aip-note">${escHtml(t('ai.loadFailed'))}</div>`;
    return null;
  }
  _renderHost(host);
  _notifyAll();
  return cfg;
}

/** 当前配置（页面想按厂商能力自己关住某些按钮时读它，不必再打一次 IPC） */
export function providerState() {
  return _cfg;
}
