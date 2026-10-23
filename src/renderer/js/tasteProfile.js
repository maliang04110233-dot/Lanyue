/**
 * 品味解读（候选方向 2：口味画像）
 *
 * 设置页「品味画像」按钮 → get-taste-profile（主进程出网 + 统计摘要缓存）→ 弹层上屏。
 * 纪律：
 *   ① 文本一律 textContent（模型回复可能含尖括号）；文案全部走词典；
 *   ② 统计为空时主进程回 NO_PLAYDATA，界面提示先多听几首；
 *   ③ 没配 Key → NO_KEY，给出去配置页的方向；
 *   ④ 同一份统计重复点直接吃缓存（不重复计费）。
 */

import { t, getLang } from './i18n.js';
import { showToast } from './toast.js';

let _busy = false;

function _lang() {
  return (getLang() || 'zh');
}

function _openProfileModal(profile, meta) {
  let overlay = document.getElementById('tasteProfileModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'tasteProfileModal';
  overlay.className = 'stats-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const cachedTag = (meta && meta.cached)
    ? `<span class="report-last" style="font-size:11px;opacity:0.6;margin-left:8px;">${t('settings.stats.cached')}</span>`
    : '';

  overlay.innerHTML = `
    <div class="stats-panel report-panel report-panel--wide">
      <div class="stats-header">
        <span>🎯 ${t('settings.stats.profileTitle')}</span>
        <span style="display:flex;gap:6px;align-items:center;">
          ${cachedTag}
          <button onclick="document.getElementById('tasteProfileModal').remove()" data-ico="x" data-ico-only aria-label="关闭"></button>
        </span>
      </div>
      <div class="stats-body">
        <div class="report-section">
          <div class="report-last" style="white-space:pre-wrap;line-height:1.7;"></div>
        </div>
      </div>
    </div>
  `;
  const body = overlay.querySelector('.report-last');
  if (body) body.textContent = profile;
  document.body.appendChild(overlay);
}

/** 打开品味画像弹层：先出提示，等待主进程出网；失败走词典文案 */
export async function openTasteProfile() {
  if (_busy) return;
  _busy = true;
  try {
    const r = await api.getTasteProfile(_lang());
    if (r && r.ok) {
      _openProfileModal(r.profile, { cached: !!r.cached });
    } else if (r && r.error === 'NO_PLAYDATA') {
      showToast(t('settings.stats.profileEmpty'), 'info', 2800);
    } else if (r && r.error === 'NO_KEY') {
      showToast(t('settings.stats.profileNoKey'), 'warn', 3500);
    } else if (r && r.error) {
      // 配置类令牌原样透出（去改配置而不是重试），其余归为生成失败
      const msg = isConfigToken(r.error)
        ? `${t('settings.stats.profileFailed')}（${r.error}）`
        : t('settings.stats.profileFailed');
      showToast(msg, 'error', 3200);
    } else {
      showToast(t('settings.stats.profileFailed'), 'error', 2800);
    }
  } catch (_e) {
    showToast(t('settings.stats.profileFailed'), 'error', 2800);
  } finally {
    _busy = false;
  }
}

/** 配置类令牌判定：与主进程 aiProviders.isConfigToken 同一套清单（ASCII 码，纯值比对） */
const _CONFIG_TOKEN_RE = /^(?:NO_KEY|MUSIC_UNSUPPORTED|ENDPOINT_BLOCKED|UNKNOWN_PROVIDER|BAD_BASE_URL(?::[A-Z0-9_]+)?|BAD_MODEL(?::[A-Z0-9_]+)?|LLM_HTTP:\d{3})$/;

function isConfigToken(v) {
  return _CONFIG_TOKEN_RE.test(String(v || ''));
}

window.openTasteProfile = openTasteProfile;