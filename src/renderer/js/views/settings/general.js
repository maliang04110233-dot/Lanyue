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
  playProgressMemory: { key: 'playProgressMemory', default: false, el: 'settingPlayProgressMemory' },
  globalShortcuts: { key: 'globalShortcuts', default: true, el: 'settingGlobalShortcuts' },
  shortcutPlayPause: { key: 'shortcutPlayPause', default: 'MediaPlayPause', el: 'settingShortcutPlayPause' },
  shortcutPrev: { key: 'shortcutPrev', default: 'MediaPreviousTrack', el: 'settingShortcutPrev' },
  shortcutNext: { key: 'shortcutNext', default: 'MediaNextTrack', el: 'settingShortcutNext' },
  shortcutShowHide: { key: 'shortcutShowHide', default: '', el: 'settingShortcutShowHide' },
  theme:         { key: 'theme',         default: 'default',     el: 'settingTheme' },
  // 发现页布局（2026-10-24）：a 内容优先 / b 双栏驾驶舱 / c 音乐门户，
  // CSS 侧见 content.css「首页布局变体」；应用逻辑在 applyDiscoverLayout。
  discoverLayout: { key: 'discoverLayout', default: 'a',          el: 'settingDiscoverLayout' },
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
    syncLayoutCards();
    // 打开设置页时把已存布局同步到 #homePage（boot 恢复之外的兜底，幂等）
    const dl = document.getElementById('settingDiscoverLayout');
    if (dl) applyDiscoverLayout(dl.value);
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
      document.documentElement.setAttribute('data-theme', isDark ? 'void' : 'light');
    };
    applySystem(mq.matches);
    mq.onchange = (e) => applySystem(e.matches);
  } else if (themeId === 'default') {
    // S2：产品默认主题从 :root 旧暗色切换为 Void Glass（深黑蓝）。
    // :root 块保留 —— 它仍是未知主题值与 light 混色派生的兜底。
    document.documentElement.setAttribute('data-theme', 'void');
  } else {
    document.documentElement.setAttribute('data-theme', themeId);
  }
}

const THEME_CARDS = ['auto', 'default', 'light', 'cyber', 'aurora', 'sunset', 'forest', 'void'];

export function syncThemeCards(value) {
  const sel = document.getElementById('settingTheme');
  const cur = value != null ? String(value) : (sel ? sel.value : 'default');
  document.querySelectorAll('.theme-card').forEach(card => {
    // 无 data-theme-value 的卡片（布局卡复用 .theme-card 视觉）不归主题同步管，
    // 否则切主题会把布局卡的选中态顺手抹掉
    if (card.dataset.themeValue === undefined) return;
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

// ── 发现页布局（a 内容优先 / b 双栏驾驶舱 / c 音乐门户）──────────────
// 与主题同一条管道：卡片点击 → 隐藏 select 派发 change → GENERAL_PREFS
// 监听写 prefs → applyDiscoverLayout 写 #homePage dataset（CSS 侧生效）。

const LAYOUT_VALUES = ['a', 'b', 'c'];

export function applyDiscoverLayout(val) {
  const layout = LAYOUT_VALUES.includes(val) ? val : 'a';
  const hp = document.getElementById('homePage');
  if (hp) hp.dataset.discoverLayout = layout;
  // 门户布局无 tab，全平台同屏：进该布局即幂等拉齐各平台首分区，
  // 否则被 CSS 强制显形的块停留在「待加载」骨架（loadPlatform 重复调用直接返回）
  if (layout === 'c' && typeof window.loadAllHomePlatforms === 'function') window.loadAllHomePlatforms();
}

export function syncLayoutCards(value) {
  const sel = document.getElementById('settingDiscoverLayout');
  const cur = value != null ? String(value) : (sel ? sel.value : 'a');
  document.querySelectorAll('[data-layout-value]').forEach(card => {
    const on = card.dataset.layoutValue === cur;
    card.classList.toggle('active', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

export function selectDiscoverLayout(value) {
  if (!LAYOUT_VALUES.includes(value)) return;
  const sel = document.getElementById('settingDiscoverLayout');
  if (sel) {
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
  }
  syncLayoutCards(value);
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
      if (cfg.key === 'discoverLayout') {
        applyDiscoverLayout(val);
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
