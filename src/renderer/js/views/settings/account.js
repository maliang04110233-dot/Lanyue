/**
 * 设置视图 - 账户平台管理模块
 *
 * 负责：平台账号卡片渲染、Cookie 管理、源健康度展示
 */

import { accountPlatforms, hasLoginWindow, cookiePlaceholder, cookieHint } from '../../accountPlatforms.js';
import { platformName } from '../../utils.js';
import { t } from '../../i18n.js';

/** 手动粘贴 Cookie 的分平台提示 */
const ACCOUNT_COOKIE_HINTS = {
  netease: '在浏览器登录后 → F12 → Network → 复制请求头 <code>Cookie:</code> 字段',
  qq: '需含 <code>uin=</code> 字段，否则无法识别',
  bilibili: '需含 <code>SESSDATA=</code> 字段',
};

const COOKIE_FIELDS = {
  netease: [
    { key: 'MUSIC_U', label: '登录凭证', required: true, tip: '请用 Network（网络）方式获取完整 Cookie' },
    { key: '__csrf', label: '防跨站', required: false },
  ],
  qq: [
    { key: 'uin', label: 'QQ号', required: true, tip: '缺少 uin 字段' },
    { key: 'qm_keyst', label: '登录密钥', required: false },
  ],
  bilibili: [
    { key: 'SESSDATA', label: '登录凭证', required: true, tip: '这是 HttpOnly Cookie' },
    { key: 'bili_jct', label: 'CSRF令牌', required: false },
    { key: 'buvid3', label: '设备ID', required: false },
  ],
};

export let _accountPlatforms = { cookie: [], anonymous: [] };

/** 平台 DOM 缓存 */
export const _platformDom = {};

export function _cacheAccountDom() {
  _platformDom.platforms = {};
  _accountPlatforms.cookie.forEach(p => {
    _platformDom.platforms[p.id] = {
      statusEl: document.getElementById(p.id + 'StatusText'),
      dotEl: document.getElementById(p.id + 'Dot'),
      loginBtn: document.getElementById(p.id + 'LoginBtn'),
      textarea: document.getElementById(p.id + 'Cookie'),
      card: document.querySelector(`.account-card[data-platform="${p.id}"]`),
      verifyEl: document.getElementById(p.id + 'VerifyResult'),
      analyzeEl: document.getElementById(p.id + 'Analyze'),
    };
  });
}

export function loadAccountPlatforms() {
  const split = accountPlatforms();
  _accountPlatforms = split;
  renderAccountSummary(split);
  renderAccountCards(split.cookie);
  renderAnonymousPlatforms(split.anonymous);
  _cacheAccountDom();
}

function renderAccountSummary(split) {
  const el = document.getElementById('accountsSummary');
  if (!el) return;
  el.innerHTML = '共 ' + esc(split.cookie.length + split.anonymous.length) + ' 个平台：' +
    '<b>' + esc(split.cookie.length) + '</b> 个支持登录（VIP / 高品质下载），' +
    '<b>' + esc(split.anonymous.length) + '</b> 个免登录可用';
}

function _accountCardHtml(p) {
  const arg = "'" + escQ(p.id) + "'";
  const hint = esc(cookieHint(p.id, ACCOUNT_COOKIE_HINTS));
  const placeholder = escAttr(cookiePlaceholder(COOKIE_FIELDS[p.id]));
  const btn = (handler) =>
    '<button class="' + handler.cls + '" onclick="' + handler.fn + '(' + arg + ')">' +
    esc(handler.text) + '</button>';
  return '<div class="account-card" data-platform="' + escAttr(p.id) + '">' +
    '<div class="account-head">' +
      '<span class="account-icon" aria-hidden="true">' + esc(p.icon || '') + '</span>' +
      '<div class="account-info">' +
        '<div class="account-name">' + esc(p.name || p.id) + '</div>' +
        '<div class="account-status" id="' + escAttr(p.id) + 'StatusText">未登录</div>' +
      '</div>' +
      '<span class="account-dot" id="' + escAttr(p.id) + 'Dot"></span>' +
    '</div>' +
    '<button class="account-primary-btn" id="' + escAttr(p.id) + 'LoginBtn"' +
      ' onclick="openLoginWindowUI(' + arg + ', this)">🔑 一键登录</button>' +
    '<details class="account-advanced">' +
      '<summary>高级（手动粘贴 Cookie）</summary>' +
      '<div class="settings-hint-box">' + hint + '</div>' +
      '<textarea class="cookie-textarea" id="' + escAttr(p.id) + 'Cookie"' +
        ' placeholder="' + placeholder + '"></textarea>' +
      '<div class="cookie-actions">' +
        btn({ cls: 'cookie-btn-save',    fn: 'saveCookie',      text: '保存' }) +
        btn({ cls: 'cookie-btn-verify',  fn: 'verifyCookieUI',  text: '验证' }) +
        btn({ cls: 'cookie-btn-verify',  fn: 'analyzeCookieUI', text: '分析' }) +
        btn({ cls: 'cookie-btn-clear',   fn: 'clearCookie',     text: '清除' }) +
      '</div>' +
      '<div class="cookie-verify-result" id="' + escAttr(p.id) + 'VerifyResult"></div>' +
      '<div class="cookie-analyze" id="' + escAttr(p.id) + 'Analyze"></div>' +
    '</details>' +
  '</div>';
}

function renderAccountCards(list) {
  const grid = document.getElementById('accountsGrid');
  if (!grid) return;
  grid.innerHTML = list.map(_accountCardHtml).join('');
}

function renderAnonymousPlatforms(list) {
  const wrap = document.getElementById('accountsAnonymous');
  if (!wrap) return;
  if (!list.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML =
    '<div class="accounts-anon-title">' +
      esc(list.length + ' 个平台免登录直接下载') +
    '</div>' +
    '<div class="accounts-anon-chips">' +
      list.map(p =>
        '<span class="accounts-anon-chip" title="' + escAttr(p.name || p.id) + '">' +
          esc(p.icon || '') + ' ' + esc(p.name || p.id) +
        '</span>').join('') +
    '</div>';
}

export async function loadAccountCardStatus(platform) {
  const dom = _platformDom.platforms[platform];
  if (!dom || !dom.card) return;

  let cookie = '';
  try {
    const all = await api.getCookies();
    cookie = all[platform] || '';
  } catch (e) {
    logger.warn('[loadAccountCardStatus] 读 cookies 失败:', e.message);
  }
  const isLoggedIn = !!cookie;
  if (dom.textarea) {
    dom.textarea.value = cookie || '';
    dom.textarea.placeholder = isLoggedIn
      ? '已保存（粘贴新值覆盖）'
      : cookiePlaceholder(COOKIE_FIELDS[platform]);
  }
  if (dom.statusEl) {
    dom.statusEl.textContent = isLoggedIn ? '已登录' : '未登录';
    dom.statusEl.className = 'account-status' + (isLoggedIn ? ' ok' : '');
  }
  if (dom.dotEl) {
    dom.dotEl.className = 'account-dot' + (isLoggedIn ? ' ok' : '');
  }
  dom.card.classList.toggle('is-login', isLoggedIn);
  dom.card.classList.remove('is-error');
  if (dom.loginBtn) {
    dom.loginBtn.textContent = isLoggedIn ? '🔄 重新登录' : '🔑 一键登录';
  }
}

export async function loadCookieStatus() {
  try {
    await Promise.all(_accountPlatforms.cookie.map(p => loadAccountCardStatus(p.id)));
  } catch (e) {
    logger.error('加载 Cookie 状态失败:', e);
  }
}

// ── 源可用性探针 ─────────────────────────────────────────

export function renderSourceHealth(health, probes) {
  const list = document.getElementById('sourceHealthList');
  if (!list) return;
  const sources = Object.keys(health || {});
  if (!sources.length) { list.innerHTML = ''; return; }
  const probeMap = {};
  for (const p of probes || []) probeMap[p.source] = p;

  list.innerHTML = sources.map(s => {
    const h = health[s];
    const probe = probeMap[s];
    const name = platformName(s);

    if (probe) {
      const ok = !!probe.ok;
      const text = ok ? '可用' : (probe.stage === 'getUrl' ? '取流失败' : '搜索不可达');
      const tone = ok ? 'is-ok' : 'is-bad';
      return `<div class="source-health-row">
        <span class="source-health-name">${esc(name)}</span>
        <span class="source-health-bar"><i class="${tone}" style="width:100%"></i></span>
        <span class="source-health-val ${tone}">${text}</span>
      </div>`;
    }

    if (h && h.score != null && h.samples > 0) {
      const pct = Math.round(h.score * 100);
      const tone = pct >= 60 ? 'is-ok' : (pct >= 30 ? 'is-warn' : 'is-bad');
      return `<div class="source-health-row">
        <span class="source-health-name">${esc(name)}</span>
        <span class="source-health-bar"><i class="${tone}" style="width:${pct}%"></i></span>
        <span class="source-health-val ${tone}">${pct}%<em>${h.samples} 次</em></span>
      </div>`;
    }

    return `<div class="source-health-row is-empty">
      <span class="source-health-name">${esc(name)}</span>
      <span class="source-health-bar"><i></i></span>
      <span class="source-health-val">暂无数据</span>
    </div>`;
  }).join('');
}

export async function loadSourceHealth() {
  try {
    if (typeof api.getSourceHealth !== 'function') return;
    const health = await api.getSourceHealth();
    renderSourceHealth(health, null);
  } catch (e) {
    logger.error('加载源健康度失败:', e);
  }
}

export async function probeSourcesUI(btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 探测中…'; }
  try {
    if (typeof api.probeSources !== 'function') { showToast(t('toast.probeUnsupported'), 'error'); return; }
    const r = await api.probeSources();
    renderSourceHealth(r.health, r.probes);
    const okCount = (r.probes || []).filter(p => p.ok).length;
    showToast(t('toast.probeDone', { ok: okCount, total: r.probes.length }), okCount > 0 ? 'success' : 'warn');
  } catch (e) {
    showToast(t('toast.probeFailed', { msg: errBrief(e) }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ── Cookie 操作 ───────────────────────────────────────────

export async function saveCookie(platform) {
  const dom = _platformDom.platforms[platform];
  if (!dom?.textarea) return;
  const val = dom.textarea.value.trim();
  if (!val) { showToast(t('toast.cookieMissing'), 'error'); return; }
  try {
    const result = await api.saveCookie(platform, val);
    if (result.saved) {
      showToast(t('toast.cookieSaved'), 'success');
      await loadCookieStatus();
      if (result.verify) showVerifyResult(platform, result.verify);
      dom.textarea.value = '';
    } else {
      showToast(t('toast.saveFailedDetail', { msg: credentialErrorText(result.error) }), 'error', 8000);
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

export async function clearCookie(platform) {
  try {
    await api.clearCookie(platform);
  } catch (e) {
    showToast(t('toast.clearFailed', { msg: errBrief(e) }), 'error');
    return;
  }
  clearVerifyResult(platform);
  await loadAccountCardStatus(platform);
  showToast(t('toast.cookieCleared'), 'info');
}

export async function verifyCookieUI(platform) {
  const dom = _platformDom.platforms[platform];
  if (!dom?.textarea) return;
  const val = dom.textarea.value.trim();
  if (!val) { showToast(t('toast.cookieMissing'), 'error'); return; }
  if (!dom.verifyEl) return;
  dom.verifyEl.textContent = '验证中...';
  dom.verifyEl.className = 'cookie-verify-result ok';
  try {
    const result = await api.verifyCookie(platform, val);
    showVerifyResult(platform, result);
  } catch (e) {
    dom.verifyEl.textContent = '验证出错: ' + errBrief(e);
    dom.verifyEl.className = 'cookie-verify-result err';
  }
}

export function showVerifyResult(platform, result) {
  const dom = _platformDom.platforms[platform];
  if (!dom?.verifyEl) return;
  const el = dom.verifyEl;
  el.className = 'cookie-verify-result';
  el.style.whiteSpace = 'pre-wrap';
  el.style.textAlign = 'left';
  el.style.lineHeight = '1.6';

  if (result.valid) {
    let line = `✅ 验证成功！用户：${result.nickname || '未知'}`;
    if (result.type === 'wechat-with-qq') line += '\n⚠️ 检测到微信登录，VIP 歌曲可能仍无法下载（VIP 绑定在微信侧）';
    if (result.message) line += '\n' + result.message;
    el.textContent = line;
    el.className = 'cookie-verify-result ok';
    if (dom.statusEl) {
      dom.statusEl.textContent = '已登录 ✓';
      dom.statusEl.className = 'account-status ok';
    }
  } else {
    let line = `❌ 验证失败：${result.reason || 'Cookie 无效或已过期'}`;
    if (result.missing && result.missing.length) line += '\n\n🔍 缺失字段：' + result.missing.join(', ');
    if (result.suggestions && result.suggestions.length) line += '\n\n💡 建议：\n' + result.suggestions.map(s => '  ' + s).join('\n');
    el.textContent = line;
    el.className = 'cookie-verify-result err';
  }
}

export function clearVerifyResult(platform) {
  const dom = _platformDom.platforms[platform];
  if (!dom?.verifyEl) return;
  dom.verifyEl.textContent = '';
  dom.verifyEl.className = 'cookie-verify-result';
}

export function analyzeCookieUI(platform) {
  const dom = _platformDom.platforms[platform];
  if (!dom?.textarea || !dom?.analyzeEl) return;
  const cookie = dom.textarea.value.trim();
  const el = dom.analyzeEl;

  if (!cookie) {
    el.innerHTML = '<span class="analyze-miss">❌ Cookie 为空</span>';
    el.className = 'cookie-analyze show';
    return;
  }

  const fields = parseCookieFields(cookie);
  const config = COOKIE_FIELDS[platform] || [];
  let html = '';

  config.forEach(c => {
    const found = fields.some(f => f.key === c.key);
    const cls = found ? 'analyze-ok' : 'analyze-miss';
    const icon = found ? '✓' : '✗';
    const status = found ? '已找到' : (c.required ? '缺失（必须）' : '缺失');
    html += `<div class="analyze-row"><span class="${cls}">${icon} ${c.key}</span><span>${c.label} ${status}</span></div>`;
  });

  const missingRequired = config.filter(c => c.required && !fields.some(f => f.key === c.key));
  if (missingRequired.length) {
    missingRequired.forEach(c => {
      if (c.tip) html += `<div class="analyze-tip">⚠️ ${c.tip}</div>`;
    });
  }

  html += `<div class="analyze-tip" style="margin-top:6px">共解析 ${fields.length} 个字段：${esc(fields.map(f => f.key).join(', '))}</div>`;
  el.innerHTML = html;
  el.className = 'cookie-analyze show';
}

export async function openLoginWindowUI(platformId, btn) {
  if (!btn) btn = event.target;
  if (!hasLoginWindow(platformId)) {
    showToast(t('toast.noLoginNeeded', { platform: platformName(platformId) }), 'info');
    return;
  }
  const platform = _accountPlatforms.cookie.find(p => p.id === platformId);
  const name = platform?.shortName || platform?.name || platformName(platformId) || platformId;
  const originalText = btn ? btn.textContent : '🔑 一键登录';

  if (btn) { btn.disabled = true; btn.textContent = '🔄 打开登录窗口...'; }
  showToast(t('toast.loginOpening', { name }), 'info');

  try {
    const result = await api.openLoginWindow(platformId);
    if (result.success) {
      showToast(t('toast.loginSuccess', { name }), 'success');
      const dom = _platformDom.platforms[platformId];
      if (dom?.textarea) dom.textarea.value = result.cookie;
      if (result.verify) showVerifyResult(platformId, result.verify);
      await loadCookieStatus();
    } else if (result.cancelled) {
      showToast(t('toast.loginCanceled'), 'info');
    } else {
      showToast(t('toast.loginFailed', { msg: result.error || t('toast.unknownError') }), 'error');
    }
  } catch (e) {
    showToast(t('toast.loginFailed', { msg: errBrief(e) }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}
