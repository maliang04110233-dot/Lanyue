/**
 * 设置视图 - 通用设置模块
 *
 * 负责：通用偏好加载/保存、主题切换、全局快捷键、文件名模板预览
 */

export const GENERAL_PREFS = {
  quality:       { key: 'quality',       default: 'standard',   el: 'settingQuality' },
  concurrency:   { key: 'concurrency',   default: 3,             el: 'settingConcurrency' },
  perSourceConcurrency: { key: 'perSourceConcurrency', default: 2, el: 'settingPerSourceConcurrency' },
  maxAttempts:   { key: 'maxAttempts',   default: 2,             el: 'settingMaxAttempts' },
  speedLimit:    { key: 'speedLimit',    default: 0,             el: 'settingSpeedLimit' },
  filenameTmpl:  { key: 'namingTemplate',  default: '{artist} - {title}', el: 'settingFilenameTmpl' },
  autoLyric:     { key: 'autoLyric',     default: true,          el: 'settingAutoLyric' },
  autoCover:     { key: 'autoCover',     default: true,          el: 'settingAutoCover' },
  notifications: { key: 'notifications',  default: true,          el: 'settingNotifications' },
  clipboardWatch: { key: 'clipboardWatch', default: true,         el: 'settingClipboardWatch' },
  subscriptionCheckIntervalHours: { key: 'subscriptionCheckIntervalHours', default: 6, el: 'settingSubCheckInterval' },
  playProgressMemory: { key: 'playProgressMemory', default: true, el: 'settingPlayProgressMemory' },
  globalShortcuts: { key: 'globalShortcuts', default: true, el: 'settingGlobalShortcuts' },
  shortcutPlayPause: { key: 'shortcutPlayPause', default: 'MediaPlayPause', el: 'settingShortcutPlayPause' },
  shortcutPrev: { key: 'shortcutPrev', default: 'MediaPreviousTrack', el: 'settingShortcutPrev' },
  shortcutNext: { key: 'shortcutNext', default: 'MediaNextTrack', el: 'settingShortcutNext' },
  shortcutShowHide: { key: 'shortcutShowHide', default: '', el: 'settingShortcutShowHide' },
  theme:         { key: 'theme',         default: 'default',     el: 'settingTheme' },
  language:      { key: 'language',      default: 'zh',          el: 'settingLanguage' },
  lyricFontSize: { key: 'lyricFontSize', default: 18,            el: 'settingLyricFontSize' },
  lyricOffset:   { key: 'lyricOffset',   default: 0,             el: 'settingLyricOffset' },
};

let filenameTmplPreviewTimer = null;

export function updateFilenameTmplPreview() {
  const input = document.getElementById('settingFilenameTmpl');
  const out = document.getElementById('filenameTmplPreview');
  const warn = document.getElementById('filenameTmplWarn');
  if (!input || !out) return;
  clearTimeout(filenameTmplPreviewTimer);
  filenameTmplPreviewTimer = setTimeout(async () => {
    try {
      const r = await api.previewNamingTemplate(input.value);
      if (!r) return;
      out.textContent = r.preview || '—';
      if (warn) {
        warn.textContent = (r.unknown && r.unknown.length)
          ? ('未知变量: ' + r.unknown.map(v => '{' + v + '}').join(' '))
          : '';
      }
    } catch (_e) {
      if (warn) warn.textContent = '';
    }
  }, 250);
}

export async function loadGeneralSettings() {
  try {
    const prefs = Object.values(GENERAL_PREFS);
    const values = await Promise.all(prefs.map(cfg => api.getPref(cfg.key)));
    prefs.forEach((cfg, i) => {
      const el = document.getElementById(cfg.el);
      if (!el) return;
      const v = values[i] !== undefined && values[i] !== null ? values[i] : cfg.default;
      if (el.type === 'checkbox') {
        el.checked = !!v;
      } else {
        el.value = String(v);
      }
    });
    syncThemeCards();
    updateFilenameTmplPreview();
  } catch (e) {
    logger.error(`[loadGeneralSettings] error:`, e);
  }
}

// ── 主题切换 ──────────────────────────────────────────

let _themeMediaQuery = null;

export function applyTheme(theme) {
  const themeId = theme || 'default';
  if (_themeMediaQuery) { _themeMediaQuery.onchange = null; _themeMediaQuery = null; }

  if (themeId === 'auto') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    _themeMediaQuery = mq;
    const applySystem = (isDark) => {
      document.documentElement.setAttribute('data-theme', isDark ? 'default' : 'light');
    };
    applySystem(mq.matches);
    mq.onchange = (e) => applySystem(e.matches);
  } else if (themeId === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', themeId);
  }
}

const THEME_CARDS = ['auto', 'default', 'light', 'cyber', 'aurora', 'sunset', 'forest'];

export function syncThemeCards(value) {
  const sel = document.getElementById('settingTheme');
  const cur = value != null ? String(value) : (sel ? sel.value : 'default');
  document.querySelectorAll('.theme-card').forEach(card => {
    const on = card.dataset.themeValue === cur;
    card.classList.toggle('active', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

export function selectTheme(value) {
  if (!THEME_CARDS.includes(value)) return;
  const sel = document.getElementById('settingTheme');
  if (sel) {
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
  }
  syncThemeCards(value);
}

// ── 全局快捷键 ──────────────────────────────────────────

const SHORTCUT_PREF_KEYS = new Set([
  'globalShortcuts', 'shortcutPlayPause', 'shortcutPrev', 'shortcutNext', 'shortcutShowHide',
]);

function isShortcutPref(key) {
  return SHORTCUT_PREF_KEYS.has(key);
}

function reapplyGlobalShortcuts() {
  const master = document.getElementById('settingGlobalShortcuts');
  const enabled = master ? !!master.checked : true;
  try {
    api.setGlobalShortcuts(enabled);
  } catch (e) {
    logger.error('全局快捷键更新失败:', e);
  }
}

export function setupGeneralSettingListeners() {
  for (const cfg of Object.values(GENERAL_PREFS)) {
    const el = document.getElementById(cfg.el);
    if (!el) continue;
    el.addEventListener('change', () => {
      const val = el.type === 'checkbox' ? el.checked : el.value;
      if (cfg.key === 'language') {
        window.i18n.setLanguage(val);
      } else {
        api.setPref(cfg.key, val);
      }
      if (cfg.key === 'quality') {
        const qs = document.getElementById('qualitySelect');
        if (qs) qs.value = val;
      }
      if (cfg.key === 'theme') {
        applyTheme(val);
      }
      if (isShortcutPref(cfg.key)) {
        reapplyGlobalShortcuts();
      }
    });
    if (cfg.key === 'namingTemplate') {
      el.addEventListener('input', updateFilenameTmplPreview);
    }
  }
}
