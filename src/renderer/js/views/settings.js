/**
 * MusicDL 设置 / Cookie 管理视图
 */

/* @module */
import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';
import {
  accountPlatforms,
  hasLoginWindow,
  cookiePlaceholder,
  cookieHint,
} from '../accountPlatforms.js';
import { planSettingsSearch } from '../settingsSearch.js';
import { t } from '../i18n.js';

// ── 平台账号清单 ─────────────────────────────────────
// 账号页不再持有平台字面量：清单从主进程插件能力派生（插件实现 verifyCookie
// ⇒ capabilities.cookie，见 api/pluginRegistry.js）。加平台后这里自动跟着长，
// 不用再改这份文件。见 accountPlatforms.js。
let _accountPlatforms = { cookie: [], anonymous: [] };

/** 手动粘贴 Cookie 的分平台提示；未定制的平台走通用文案 */
const ACCOUNT_COOKIE_HINTS = {
  netease: '在浏览器登录后 → F12 → Network → 复制请求头 <code>Cookie:</code> 字段',
  qq: '需含 <code>uin=</code> 字段，否则无法识别',
  bilibili: '需含 <code>SESSDATA=</code> 字段',
};

// ── Cookie 字段分析配置 ──────────────────────────────
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

// ── DOM 缓存 ──────────────────────────────────────────
const _settingsDom = {
  overlay: null,
  cacheSize: null,
  // 平台 DOM 缓存：{ platformId: { statusEl, dotEl, loginBtn, textarea, card, verifyEl } }
  platforms: {},
};

function _cacheSettingsDom() {
  _settingsDom.overlay = document.getElementById('settingsOverlay');
  _settingsDom.cacheSize = document.getElementById('cacheSize');
}

/**
 * 缓存账号卡片 DOM
 * 卡片是 loadAccountPlatforms() 动态生成的，必须在那之后缓存；
 * 模块加载时 accountsGrid 还是空的，所以不能合并进 _cacheSettingsDom()。
 */
function _cacheAccountDom() {
  _settingsDom.platforms = {};
  _accountPlatforms.cookie.forEach(p => {
    _settingsDom.platforms[p.id] = {
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
  // 上次留下的搜索过滤会盖住本次要看的条目，开面板先复位
  const searchInput = document.getElementById('settingsSearchInput');
  if (searchInput) searchInput.value = '';
  clearSettingsSearch();
  // 账号卡片按主进程平台清单动态渲染；同步渲染完再读状态，避免读到空卡片
  loadAccountPlatforms();
  // 并行加载所有设置
  Promise.all([
    ..._accountPlatforms.cookie.map(p => loadAccountCardStatus(p.id)),
    loadGeneralSettings(),
    loadQualityBySource(),
    loadFallbackDisabled(),
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

// ── 账号卡片渲染 ──────────────────────────────────────
/**
 * 按主进程平台清单重新渲染账号卡片
 * 每次打开设置页都重跑：平台增删、能力变化即时反映到界面。
 */
function loadAccountPlatforms() {
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

/**
 * 单张账号卡片
 * onclick 的调用参数由 escQ 负责转义并带上引号，其余属性值用 escAttr、
 * 文本节点用 esc。
 */
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

/** 免登录平台只展示可用性，不给登录入口（避免点了无反应的按钮） */
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

// ── 账号状态 ──────────────────────────────────────────
async function loadAccountCardStatus(platform) {
  const dom = _settingsDom.platforms[platform];
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

/**
 * 刷新所有账号卡片的状态
 * 原先这里还更新侧栏的 dotNetease/dotQQ/dotBili 状态点，
 * 但那几个元素早已不在 HTML 里，是死代码，已删。
 */
async function loadCookieStatus() {
  try {
    await Promise.all(_accountPlatforms.cookie.map(p => loadAccountCardStatus(p.id)));
  } catch (e) {
    logger.error('加载 Cookie 状态失败:', e);
  }
}

// ── 源可用性探针（P2）─────────────────────────────────
// 平台名统一走 utils.js 的 platformName()（单一来源）。原先此处第二份 SOURCE_NAMES 拷贝。

function renderSourceHealth(health, probes) {
  const list = document.getElementById('sourceHealthList');
  if (!list) return;
  const sources = Object.keys(health || {});
  if (!sources.length) { list.innerHTML = ''; return; }
  const probeMap = {};
  for (const p of probes || []) probeMap[p.source] = p;

  // 改为「名称 + 进度条 + 数值」三列：原先只有一行文字，中间空 300px，
  // 41% 和 98% 扫视起来毫无差别。三档语义用 class 承载（token 上色，跨主题协调），
  // 不再硬编码 #ff7676 这类色值。
  list.innerHTML = sources.map(s => {
    const h = health[s];
    const probe = probeMap[s];
    const name = platformName(s);

    // 一次性探测结果优先于历史成功率
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
      // ≥60 健康 / ≥30 警告 / 否则不可用
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

async function loadSourceHealth() {
  try {
    if (typeof api.getSourceHealth !== 'function') return;
    const health = await api.getSourceHealth();
    renderSourceHealth(health, null);
  } catch (e) {
    logger.error('加载源健康度失败:', e);
  }
}

async function probeSourcesUI(btn) {
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

// ── Cookie 操作 ───────────────────────────────────────
async function saveCookie(platform) {
  const dom = _settingsDom.platforms[platform];
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
      // 主进程拒绝保存（安全存储不可用 ⇒ 绝不把登录态明文落盘）。
      // 旧代码在这里静默什么都不做，用户看到的是「点了保存没反应」。
      showToast(t('toast.saveFailedDetail', { msg: credentialErrorText(result.error) }), 'error', 8000);
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

async function clearCookie(platform) {
  try {
    await api.clearCookie(platform);
  } catch (e) {
    showToast(t('toast.clearFailed', { msg: errBrief(e) }), 'error');
    return;
  }
  clearVerifyResult(platform);
  // 状态从主进程重新读取，不在本地硬改成「未设置」
  await loadAccountCardStatus(platform);
  showToast(t('toast.cookieCleared'), 'info');
}

async function verifyCookieUI(platform) {
  const dom = _settingsDom.platforms[platform];
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

function showVerifyResult(platform, result) {
  const dom = _settingsDom.platforms[platform];
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

function clearVerifyResult(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.verifyEl) return;
  dom.verifyEl.textContent = '';
  dom.verifyEl.className = 'cookie-verify-result';
}

// ── Cookie 分析（配置驱动）────────────────────────────
function analyzeCookieUI(platform) {
  const dom = _settingsDom.platforms[platform];
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

  // 检查每个配置的字段
  config.forEach(c => {
    const found = fields.some(f => f.key === c.key);
    const cls = found ? 'analyze-ok' : 'analyze-miss';
    const icon = found ? '✓' : '✗';
    const status = found ? '已找到' : (c.required ? '缺失（必须）' : '缺失');
    html += `<div class="analyze-row"><span class="${cls}">${icon} ${c.key}</span><span>${c.label} ${status}</span></div>`;
  });

  // 显示缺失必填字段的提示
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

// ── 辅助工具 ──────────────────────────────────────────
async function openLoginWindowUI(platformId, btn) {
  if (!btn) btn = event.target;
  if (!hasLoginWindow(platformId)) {
    // 免登录平台没有登录入口，卡片也不会渲染这个按钮；这里兜底提示
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
      const dom = _settingsDom.platforms[platformId];
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

// ── 通用设置加载 / 保存 ─────────────────────────────
const GENERAL_PREFS = {
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
  // 订阅新歌的周期检查间隔（主进程 _intervalMs 读，档位与上下限的家在 subscriptions.js）
  subscriptionCheckIntervalHours: { key: 'subscriptionCheckIntervalHours', default: 6, el: 'settingSubCheckInterval' },
  playProgressMemory: { key: 'playProgressMemory', default: true, el: 'settingPlayProgressMemory' },
  globalShortcuts: { key: 'globalShortcuts', default: true, el: 'settingGlobalShortcuts' },
  // 四个动作各自的 accelerator（候选与出厂值的家在 src/shared/accelerators.js，
  // test/global-shortcuts.test.js 逐字钉住这三侧不许漂）
  shortcutPlayPause: { key: 'shortcutPlayPause', default: 'MediaPlayPause', el: 'settingShortcutPlayPause' },
  shortcutPrev: { key: 'shortcutPrev', default: 'MediaPreviousTrack', el: 'settingShortcutPrev' },
  shortcutNext: { key: 'shortcutNext', default: 'MediaNextTrack', el: 'settingShortcutNext' },
  shortcutShowHide: { key: 'shortcutShowHide', default: '', el: 'settingShortcutShowHide' },
  theme:         { key: 'theme',         default: 'default',     el: 'settingTheme' },
  // 语言必须在表里：这张表同时是「打开设置页回填什么」与「恢复默认清什么」的唯一答案，
  // 不在表里就等于它不是个设置（曾经的真实症状：界面已是 English，下拉仍显示中文）
  language:      { key: 'language',      default: 'zh',          el: 'settingLanguage' },
  lyricFontSize: { key: 'lyricFontSize', default: 18,            el: 'settingLyricFontSize' },
  lyricOffset:   { key: 'lyricOffset',   default: 0,             el: 'settingLyricOffset' },
};

// 命名模板实时预览：renderFileName 跑在主进程（renderer 拿不到 src/utils），
// 预览值必须走 IPC 取。250ms 防抖，避免每次击键都跨进程请求。
let filenameTmplPreviewTimer = null;
function updateFilenameTmplPreview() {
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
      // 预览失败不该打断设置页：静默清空告警即可
      if (warn) warn.textContent = '';
    }
  }, 250);
}

// ── 分平台音质 ─────────────────────────────────────────
// 默认音质（settingQuality）是兜底；这里为单个平台指定档位。
// 覆盖表只存有自定义的平台，其余平台走默认值 —— 新增平台自动继承默认，无需迁移。
let _qualityBySourceTimer = null;

/** 平台 id 清单：主进程下发优先，未就绪时回落到内置兜底表 */
function qualityPlatformIds() {
  const ids = getPlatforms().map(x => x && x.id).filter(Boolean);
  return ids.length ? ids : fallbackPlatformIds();
}

function _qualitySelectOptions(selected) {
  let opts = '<option value="">' + esc('跟随默认') + '</option>';
  for (const o of QualityOptions) {
    opts += '<option value="' + escAttr(o.value) + '"' +
      (selected === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }
  return opts;
}

async function loadQualityBySource() {
  let map = null;
  try { map = await api.getPref('qualityBySource'); }
  catch (e) { logger.warn('读取分平台音质失败:', e.message); }
  setState('qualityBySource', (map && typeof map === 'object' && !Array.isArray(map)) ? map : {});
  renderQualityBySource();
}

function renderQualityBySource() {
  const el = document.getElementById('qualityBySourceList');
  if (!el) return;
  const map = getQualityBySource();
  el.innerHTML = qualityPlatformIds().map(id => {
    const fixed = QualityFixed.has(id);
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

function onQualityBySourceChange(sel) {
  const map = getQualityBySource();
  const id = sel.dataset.qsId;
  if (!id) return;
  if (sel.value) map[id] = sel.value; else delete map[id];
  setState('qualityBySource', map);
  // 防抖落盘：逐项切换时避免每次击键都跨进程写 prefs
  clearTimeout(_qualityBySourceTimer);
  _qualityBySourceTimer = setTimeout(() => saveQualityBySource(map), 250);
}

async function resetQualityBySource() {
  clearTimeout(_qualityBySourceTimer);
  setState('qualityBySource', {});
  await saveQualityBySource({});
  renderQualityBySource();
  showToast(t('toast.qualityFollowReset'), 'info');
}

// ── 换源排除平台─────────────────────────────
// 清单由主进程 resolveTrackService 每次解析时读取：勾选的平台不再出现在
// 跨源候选与 _altSource 记忆里；该平台自己的歌曲照常播放/下载（本源不受限）。
let _fallbackDisabledTimer = null;
let _fallbackDisabledIds = [];

async function loadFallbackDisabled() {
  let arr = [];
  try {
    const v = await api.getPref('fallbackDisabledPlatforms');
    if (Array.isArray(v)) arr = v.filter((x) => typeof x === 'string' && x);
  } catch (e) { logger.warn('读取换源排除平台失败:', e.message); }
  _fallbackDisabledIds = arr;
  renderFallbackDisabled();
}

function renderFallbackDisabled() {
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

function onFallbackDisabledToggle(cb) {
  const id = cb.dataset.fdId;
  if (!id) return;
  const i = _fallbackDisabledIds.indexOf(id);
  if (cb.checked && i < 0) _fallbackDisabledIds.push(id);
  else if (!cb.checked && i >= 0) _fallbackDisabledIds.splice(i, 1);
  // 防抖落盘：连续勾选时避免每个勾击都跨进程写 prefs
  clearTimeout(_fallbackDisabledTimer);
  _fallbackDisabledTimer = setTimeout(() => {
    api.setPref('fallbackDisabledPlatforms', _fallbackDisabledIds.slice());
  }, 250);
}

async function resetFallbackDisabled() {
  clearTimeout(_fallbackDisabledTimer);
  _fallbackDisabledIds = [];
  renderFallbackDisabled();
  await api.setPref('fallbackDisabledPlatforms', []);
  showToast(t('toast.sourceSwitchReset'), 'info');
}

async function loadGeneralSettings() {
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
    // 色卡高亮不会随 select 的程序化赋值自动更新（不触发 change），加载完主动刷一次
    syncThemeCards();
    // 预览同理：输入框被程序化赋值不触发 input，主动刷一次
    updateFilenameTmplPreview();
  } catch (e) {
    logger.error(`[loadGeneralSettings] error:`, e);
  }
}

// ── 主题切换 ──────────────────────────────────────────
let _themeMediaQuery = null;

function applyTheme(theme) {
  const themeId = theme || 'default';
  // 清除之前的系统主题监听
  if (_themeMediaQuery) { _themeMediaQuery.onchange = null; _themeMediaQuery = null; }

  if (themeId === 'auto') {
    // 跟随系统主题
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

// ── 主题色卡（外观页）──────────────────────────────────
// 色卡只负责「显示 + 点击」，真正的值仍由隐藏的 <select id="settingTheme"> 承载。
// 这样 GENERAL_PREFS / loadGeneralSettings / setupGeneralSettingListeners
// 这条既有读写链路一行都不用改 —— 点击时写入 select 并派发 change 即可复用。
const THEME_CARDS = ['auto', 'default', 'light', 'cyber', 'aurora', 'sunset', 'forest'];

function syncThemeCards(value) {
  const sel = document.getElementById('settingTheme');
  const cur = value != null ? String(value) : (sel ? sel.value : 'default');
  document.querySelectorAll('.theme-card').forEach(card => {
    const on = card.dataset.themeValue === cur;
    card.classList.toggle('active', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function selectTheme(value) {
  if (!THEME_CARDS.includes(value)) return;
  const sel = document.getElementById('settingTheme');
  if (sel) {
    sel.value = value;
    // 触发 change：写 prefs + applyTheme 都由既有监听器完成
    sel.dispatchEvent(new Event('change'));
  }
  syncThemeCards(value);
}

// 改了这五把键里的任何一把，主进程都要重新注册一遍。判据之家在
// src/shared/accelerators.js，这里只负责「哪些 pref 算快捷键设置」。
const SHORTCUT_PREF_KEYS = new Set([
  'globalShortcuts', 'shortcutPlayPause', 'shortcutPrev', 'shortcutNext', 'shortcutShowHide',
]);

function isShortcutPref(key) {
  return SHORTCUT_PREF_KEYS.has(key);
}

/** 唯一的重注册出口：注销旧的、按当前 prefs 注册新的，总开关一并带上 */
function reapplyGlobalShortcuts() {
  const master = document.getElementById('settingGlobalShortcuts');
  const enabled = master ? !!master.checked : true;
  try {
    api.setGlobalShortcuts(enabled);
  } catch (e) {
    logger.error('全局快捷键更新失败:', e);
  }
}

function setupGeneralSettingListeners() {
  for (const cfg of Object.values(GENERAL_PREFS)) {
    const el = document.getElementById(cfg.el);
    if (!el) continue;
    el.addEventListener('change', () => {
      const val = el.type === 'checkbox' ? el.checked : el.value;
      if (cfg.key === 'language') {
        // 语言由 i18n 一家负责「写 pref + 换字典 + 重新翻译」，这里再补一笔 setPref
        // 就是同一份值先后写两次（且第二笔可能覆盖掉刚生效的那份）
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
      // 全局快捷键：prefs 写入外还要实时通知主进程重注册（总开关关掉即注销，
      // 四个绑法任何一个改动都走同一个出口，不各写一遍 setGlobalShortcuts）
      if (isShortcutPref(cfg.key)) {
        reapplyGlobalShortcuts();
      }
    });
    // 命名模板走 input 事件实时预览：change 只在失焦时触发，敲字时看不出效果
    if (cfg.key === 'namingTemplate') {
      el.addEventListener('input', updateFilenameTmplPreview);
    }
  }
}

// （云同步导出/导入的 UI 入口是 exportConfig/importConfig，见 window 桥接区；
// 早期的 exportAllData/importAllData 重复实现已删除）

// ── 云同步 ───────────────────────────────────────────

// ── 下载路径模板 ──────────────────────────────────────
let _dlTemplates = [];
let _dlActiveTemplate = null;

async function loadDownloadTemplates() {
  try {
    const result = await api.getDownloadTemplates();
    _dlTemplates = result.templates || [];
    _dlActiveTemplate = result.active || null;
    renderDownloadTemplates();
  } catch (e) {
    logger.error('加载下载模板失败:', e);
  }
}

function renderDownloadTemplates() {
  const container = document.getElementById('dlTemplateList');
  if (!container) return;

  if (_dlTemplates.length === 0) {
    container.innerHTML = '<div class="empty-tip" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">暂无模板，点击「新建」添加</div>';
    return;
  }

  container.innerHTML = _dlTemplates.map(tpl => {
    const isActive = tpl.id === _dlActiveTemplate;
    // id 可能是云同步/导入的外部数据 —— 与账号卡片同一约定：实参走 escQ、属性走 escAttr
    const idArg = "'" + escQ(tpl.id) + "'";
    // 落盘真正用的是 subpath（相对下载目录的片段，f5f5a08 起才存在）；
    // 老模板、以及从别的下载目录同步来的模板没这个字段，只能显示绝对路径
    const hasSub = typeof tpl.subpath === 'string' && !!tpl.subpath;
    const shown = hasSub ? tpl.subpath : tpl.path;
    return `
      <div class="dl-template-item ${isActive ? 'active' : ''}" data-id="${escAttr(tpl.id)}">
        <div class="dl-template-info" tabindex="0" role="button" onclick="setActiveTemplate(${idArg})">
          <div class="dl-template-name">
            ${isActive ? '✅ ' : ''}${escHtml(tpl.name)}
            ${isActive ? '<span class="dl-template-badge">使用中</span>' : ''}
          </div>
          <div class="dl-template-path">${escHtml(shown)}${hasSub ? '（相对下载目录）' : '（绝对路径）'}</div>
        </div>
        <div class="dl-template-actions">
          <button class="btn-icon" onclick="openDlTemplateEditor(${idArg})" title="编辑">✏️</button>
          <button class="btn-icon" onclick="deleteDlTemplate(${idArg})" title="删除">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

async function setActiveTemplate(templateId) {
  try {
    await api.setActiveDownloadTemplate(templateId);
    _dlActiveTemplate = templateId;
    renderDownloadTemplates();
    const tpl = _dlTemplates.find((x) => x.id === templateId);
    showToast(t('toast.templateSwitched', { name: tpl?.name || t('toast.templateDefaultName') }), 'info');
  } catch (e) {
    logger.error(`[setActiveTemplate] error:`, e);
  }
}

function openDlTemplateEditor(templateId) {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');
  const titleEl = document.getElementById('dlTemplateEditorTitle');

  if (templateId) {
    const tpl = _dlTemplates.find((x) => x.id === templateId);
    if (tpl) {
      titleEl.textContent = '✏️ 编辑路径模板';
      nameInput.value = tpl.name;
      // 预填真正生效的那份（相对片段），否则用户看到绝对路径、照着改完存回去，
      // 换下载目录时又变成一份绑死在旧目录上的模板
      pathInput.value = tpl.subpath || tpl.path;
      modal.dataset.editId = templateId;
    }
  } else {
    titleEl.textContent = '➕ 新建路径模板';
    nameInput.value = '';
    pathInput.value = '';
    delete modal.dataset.editId;
  }

  updateTemplateVarHints();
  ensureDlTemplatePreview();
  updateDlPathPreview();
  modal.classList.remove('hidden');
  nameInput.focus();
}

function closeDlTemplateEditor() {
  document.getElementById('dlTemplateEditorModal').classList.add('hidden');
}

function updateTemplateVarHints() {
  const el = document.getElementById('dlTemplateVarHints');
  if (el) {
    el.innerHTML = '可用变量: {artist} {album} {title} {source} {year} {track}，'
      + '路径按「相对下载目录」写，如: <code>{artist}/{album}</code>（绝对路径也可，但必须落在下载目录内）';
  }
}

// ── 路径模板实时预览 ─────────────────────────────────
// 文件名模板早就有实时预览（filenameTmplPreview），路径模板是这条线上唯一的例外：
// 用户写完 {artist}/{album} 只能存下、下载一首、再去目录里核对。本段补上落点预览。
// 两条纪律：① 段渲染跑在主进程（renderer 是打包的 ESM，拿不到 src/utils 下的模块），
// 复用既有 'preview-naming-template' 通道取数，不为预览再开一条通道；
// ② 预览节点由这里自己造、不写进 index.html —— 模态框是编辑器专属外壳，
// 少一处和并发改动抢同一份 HTML。文案一律 textContent（路径段可能含用户输入）。

let _dlPathPreviewTimer = null;

function ensureDlTemplatePreview() {
  const input = document.getElementById('dlTemplatePath');
  if (!input) return null;
  let box = document.getElementById('dlTemplatePathPreview');
  if (!box) {
    box = document.createElement('p');
    box.id = 'dlTemplatePathPreview';
    // 与命名模板预览同一副长相（setting-hint + 等宽青字），两处预览该像一件事
    box.className = 'setting-hint';
    box.style.color = 'var(--neon-cyan)';
    box.style.fontFamily = 'monospace';
    input.insertAdjacentElement('afterend', box);
    // 模态框元素常驻，监听器只在造壳时绑一次
    input.addEventListener('input', updateDlPathPreview);
  }
  return box;
}

function updateDlPathPreview() {
  const input = document.getElementById('dlTemplatePath');
  const box = ensureDlTemplatePreview();
  if (!input || !box) return;
  const raw = input.value.trim();
  if (!raw) {
    box.textContent = '示例落点：（未填路径 —— 歌曲直接落在下载目录根下）';
    return;
  }
  clearTimeout(_dlPathPreviewTimer);
  _dlPathPreviewTimer = setTimeout(async () => {
    try {
      const r = await api.previewNamingTemplate({ pathTpl: raw });
      if (input.value.trim() !== raw) return; // 键入已变，丢掉这次跨进程结果
      if (!r) return;
      const segs = r.pathSegments || [];
      box.textContent = '示例落点：'
        + (segs.length ? segs.join(' \\ ') : '（这一串取不到值 —— 歌曲会落在下载目录根下）');
      const dropped = r.pathDropped || [];
      if (dropped.length) {
        box.textContent += ' | 不会建目录的段: ' + dropped.join('、')
          + '（变量名不认识，或该歌曲没有这一项）';
      }
    } catch (_e) {
      // 预览失败不许打断编辑器：留空即可，保存路径本身有主进程校验兜底
      box.textContent = '';
    }
  }, 250);
}

async function saveDlTemplate() {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');

  const name = nameInput.value.trim();
  const path = pathInput.value.trim();
  if (!name || !path) {
    showToast(t('toast.templateNameRequired'), 'warn');
    return;
  }

  const editId = modal.dataset.editId;
  try {
    const result = await api.saveDownloadTemplate({
      ...(editId ? { id: editId } : {}),
      name, path,
    });
    if (result.success) {
      await loadDownloadTemplates();
      closeDlTemplateEditor();
      showToast(editId ? t('toast.templateUpdated') : t('toast.templateCreated'), 'success');
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

async function deleteDlTemplate(templateId) {
  if (!await askConfirm(t('toast.templateConfirmDelete'))) return;
  try {
    const result = await api.deleteDownloadTemplate(templateId);
    if (result.success) {
      await loadDownloadTemplates();
      showToast(t('toast.templateDeleted'), 'success');
    }
  } catch (e) {
    showToast(t('toast.deleteFailedMsg', { msg: errBrief(e) }), 'error');
  }
}

// ── 在 DOM 就绪后绑定事件 ─────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupGeneralSettingListeners);
} else {
  setupGeneralSettingListeners();
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

  // 默认值由 GENERAL_PREFS 表派生 —— 手抄清单必然漏项（审计发现的 6/13 缺漏）
  const defaults = {};
  for (const meta of Object.values(GENERAL_PREFS)) defaults[meta.key] = meta.default;

  try {
    for (const [key, value] of Object.entries(defaults)) {
      await api.setPref(key, value);
    }
    // 刷新 UI
    await loadGeneralSettings();
    // 全局快捷键同样要重注册，否则改完默认值后系统里仍压着旧绑法（直到重启才对上）。
    // 这里借道 change 事件而不是直接调 reapplyGlobalShortcuts()：重注册出口只许一个，
    // 多开一处就等于给了两份注册顺序（同主题卡片 selectTheme 的写法）。
    const shortcutMaster = document.getElementById('settingGlobalShortcuts');
    if (shortcutMaster) shortcutMaster.dispatchEvent(new Event('change'));
    applyTheme('default');
    // 语言与主题同病：清完 pref 不重新换字典，界面还是原来那门语言（恢复默认=半兑现）
    if (window.i18n) await window.i18n.setLanguage(GENERAL_PREFS.language.default);
    // 均衡器面板就长在「播放」tab 上，却不归 GENERAL_PREFS 管（它的家在 eq.js）：
    // 这里调它自己那份"默认态"，而不是把 EQ 的三笔键抄进重置清单
    window.resetEq();
    // 音量/倍速/淡入淡出/完成后动作同理住在表外，而且连设置页控件都没有（它们长在播放器上）——
    // 表管不到 = 「恢复默认」永远够不着，所以同样叫各家的默认态实现（184）
    window.resetPlaybackPrefs();
    window.resetFadeSettings();
    window.resetAfterQueueAction();
    showToast(t('toast.settingsReset'), 'success');
  } catch (e) {
    showToast(t('toast.settingsResetFailed', { msg: errBrief(e) }), 'error');
  }
}

function parseCookieFields(cookieStr) {
  const fields = [];
  cookieStr.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) fields.push({ key: trimmed, value: '' });
    else fields.push({ key: trimmed.substring(0, eq).trim(), value: trimmed.substring(eq + 1).trim() });
  });
  return fields;
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

// ── WebDAV 云同步 ────────────────────────────────────
async function loadWebdavConfig() {
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

/**
 * 主进程拒绝保存凭证时回的是错误码而非句子（见 utils/secretStore.js）。
 * 渲染层负责把它翻成用户能行动的中文；未知码原样透出，不吞信息。
 */
function credentialErrorText(code) {
  if (code === 'SECRET_STORAGE_UNAVAILABLE') return t('toast.secretStorageUnavailable');
  return code;
}

async function saveWebdavConfig() {
  try {
    const pass = document.getElementById('webdavPass').value;
    const url = document.getElementById('webdavUrl').value.trim();
    const allowInsecure = document.getElementById('webdavAllowInsecure')?.checked === true;
    // 明文 http 且非本机 ⇒ 账号密码可被链路窃听。主进程默认拒绝发送凭据
    // （utils/webdav.js），这里的勾选框是用户显式授权；未勾选时提醒一次。
    const isLocalHost = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
    if (url && url.startsWith('http://') && !isLocalHost) {
      showToast(t('toast.webdavInsecure'), 'warn', 6000);
    }
    const r = await window.ipcRenderer.invoke('cloud-sync-config-set', {
      url,
      user: document.getElementById('webdavUser').value.trim(),
      allowInsecure,
      // 留空 = 不修改已存密码（undefined 不上送该字段）
      ...(pass ? { pass } : {}),
    });
    if (r.success) {
      showToast(t('toast.webdavSaved'), 'success');
      loadWebdavConfig();
    } else {
      // 主进程拒绝保存时给更长停留：用户需要读完才知道该勾哪个框 / 换 https
      showToast(t('toast.saveFailedDetail', { msg: credentialErrorText(r.error) }), 'error', 8000);
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

async function runWebdavSync() {
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

// ── MCP 本地服务（AI Agent 接入）────────────────────────
let _mcpRunning = false;

async function loadMcpConfig() {
  try {
    const st = await window.ipcRenderer.invoke('mcp-status');
    const portEl = document.getElementById('mcpPort');
    if (!portEl) return;
    _mcpRunning = !!st.running;
    portEl.value = st.port || '';
    const tokenEl = document.getElementById('mcpToken');
    tokenEl.value = st.token || '（启用后自动生成）';
    tokenEl.readOnly = !!st.token;
    document.getElementById('mcpToggle').textContent = _mcpRunning ? '停止服务' : '启用服务';
    document.getElementById('mcpStatusLine').textContent = _mcpRunning
      ? `运行中: ${st.url}`
      : (st.enabled ? '已设为开机自启，但当前未监听（端口占用？）' : '未启用');
  } catch (e) {
    logger.error('读取 MCP 状态失败:', e);
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

function toggleMcpService() {
  _applyMcpConfig({ enabled: !_mcpRunning });
}

function rotateMcpToken() {
  _applyMcpConfig({ rotateToken: true });
  showToast(t('toast.mcpTokenRotated'), 'warn', 5000);
}

// ── 设置项搜索（settingsSearch.js 纯函数的接线层）────────
// DOM 拍平成 {title, blocks:[{kind,text}]} 喂纯函数，计划用 .srch-hide 类回写：
// 只加减这个类、绝不碰行内 display —— 有些行本就按条件隐藏，清了会把它放出来。
function _settingBlockNodes(el) {
  if (el.classList.contains('setting-row')) {
    return [{ kind: 'row', el, text: el.textContent || '' }];
  }
  const rows = Array.from(el.querySelectorAll('.setting-row'));
  if (!rows.length) return [{ kind: 'other', el, text: el.textContent || '' }];
  // 卡片容器整体随节显隐（text='' 永不命中），卡内行逐条匹配
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
  // 当前页没命中就自动跳到第一个有命中的 tab，省得用户手动翻页找结果
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
}

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
window.loadGeneralSettings = loadGeneralSettings;
window.loadSourceHealth = loadSourceHealth;
window.probeSourcesUI = probeSourcesUI;
window.loadDownloadTemplates = loadDownloadTemplates;
window.openDlTemplateEditor = openDlTemplateEditor;
window.closeDlTemplateEditor = closeDlTemplateEditor;
window.saveDlTemplate = saveDlTemplate;
// 模板列表项（loadDownloadTemplates 渲染的 onclick）走全局名
window.setActiveTemplate = setActiveTemplate;
window.deleteDlTemplate = deleteDlTemplate;
window.applyTheme = applyTheme;
window.runSettingsSearch = runSettingsSearch;
window.focusSettingsSearch = focusSettingsSearch;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheSettingsDom();
