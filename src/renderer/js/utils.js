/**
 * MusicDL 通用工具函数
 *
 * ES Module 导出供其他模块 import，同时保留 window 全局供 HTML onclick
 *
 * errBrief 走动态 import 而非静态：本模块被大量 view 与 node 测试直接 import，
 * 静态 import 会把 errBrief 拉进模块图（i18n.js 头注记着同一条纪律的由来）。
 * 失败反馈是异步路径上偶发的，动态 import 的那点开销不在热路径上。
 */

/** 取人话错误文案；拿不到就退回一个不撒谎的定值（绝不让 undefined 上屏） */
let _errBrief;
async function _brief(e) {
  try {
    if (!_errBrief) {
      ({ errBrief: _errBrief } = await import('./errBrief.js'));
    }
    return _errBrief(e) || '未知错误';
  } catch (_e) {
    return '未知错误';
  }
}

// ── HTML 转义 ────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * 转义用于「双引号包裹的 inline 事件属性内的 JS 字符串字面量」的值。
 * 两层都要防：先反斜杠再单引号（JS 字面量层），再双引号/尖括号
 * （HTML 属性层 —— 值里的 " 会直接闭合 onclick="..." 并注入新属性）。
 * 注意顺序：必须先转义 \，否则 foo\ 会把后面的 \' 变义。
 */
function escQ(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 转义用于 HTML 属性和 onclick 上下文的值（防 DOM XSS） */
function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;');
}

/**
 * 取流播放所需 Referer 的唯一判定入口（审计：此前 5 个文件各复制一份三元链）。
 * 优先主进程取流结果自带的 referer（如 B 站），其余按播放源查表；
 * kugou/kuwo/migu/soda/5sing 的 CDN 实测无 Referer 也可播，返回空串。
 */
const PLAY_REFERERS = {
  bilibili: 'https://www.bilibili.com/',
  qq: 'https://y.qq.com/',
  netease: 'https://music.163.com/',
};
function playReferer(source, result) {
  return (result && result.referer) || PLAY_REFERERS[source] || '';
}

// ── 时间格式化 ────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  if (!ms) return '--:--';
  return fmtTime(ms / 1000);
}

// ── 文件大小 ──────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB'];
  let size = bytes, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return size.toFixed(1) + ' ' + units[unit];
}

// ── 平台名 / 徽标配色（v3：单一事实来源）────────────────
// 平台清单由主进程 IPC `get-platforms` 下发，而它来自平台 manifest —— 平台事实
// 只有一处定义。渲染层不再持有平台 id 清单：新增平台只改主进程一侧。
//
// ⚠️ 降级路径（必须有）：无头验证台会桩掉 app.js（不跑 init），IPC 也可能未就绪。
//    绝不允许清单缺失把界面炸掉 —— 故内置兜底**名称**表（配色缺失时回落默认灰）。
const FALLBACK_PLATFORM_NAMES = {
  netease: '网易云', qq: 'QQ音乐', bilibili: 'B站', kugou: '酷狗',
  kuwo: '酷我', migu: '咪咕', fivesing: '5sing', soda: '汽水',
};

/** 当前语言。不 import i18n.js —— 那会新增一条模块依赖边且 utils 被广泛引用。 */
function _lang() {
  try { return (window.i18n && window.i18n.getLang && window.i18n.getLang()) || 'zh'; }
  catch (_e) { return 'zh'; }
}

/** 兜底平台 id 清单（开发 mock 等自包含场景用，避免再写第二份字面量数组） */
function fallbackPlatformIds() {
  return Object.keys(FALLBACK_PLATFORM_NAMES);
}

/** 主进程下发的平台清单；未就绪时返回空数组（调用方必须能容忍） */
function getPlatforms() {
  return Array.isArray(window.__PLATFORMS) ? window.__PLATFORMS : [];
}

/**
 * 灌入平台清单并注入徽标配色（app.js init 调用一次）
 * @param {Array<{id:string,name:string,nameEn?:string,icon?:string,badge?:{bg:string,fg:string,border:string}}>} list
 * @returns {Array} 规范化后的清单
 */
function setPlatforms(list) {
  window.__PLATFORMS = Array.isArray(list) ? list : [];
  applyPlatformBadgeTheme(window.__PLATFORMS);
  return window.__PLATFORMS;
}

/**
 * 取平台显示名（唯一来源）。英文界面取 nameEn，缺失回落 name。
 * 清单缺失时回落内置表，未知 id 原样返回 —— 永不抛错。
 * @param {string} id
 * @returns {string}
 */
function platformName(id) {
  if (!id) return '';
  const p = getPlatforms().find(x => x && x.id === id);
  if (p) return (_lang() === 'en' && p.nameEn) ? p.nameEn : (p.name || p.nameEn || id);
  return FALLBACK_PLATFORM_NAMES[id] || id;
}

/** 平台 emoji 图标（manifest 未提供时返回空串） */
function platformIcon(id) {
  const p = getPlatforms().find(x => x && x.id === id);
  return (p && p.icon) || '';
}

const BADGE_STYLE_ID = 'platformBadgeTheme';

/**
 * Minor(XSS): source/平台 id 会拼进 class 名与 CSS 选择器，
 * 白名单钳制为标识符字符集，异常值归为 unknown。
 */
function badgeCls(id) {
  const s = String(id || '');
  return /^[a-zA-Z0-9_-]{1,32}$/.test(s) ? s : 'unknown';
}

/**
 * 把 manifest.badge 注入为 `.badge-<id>` 的 CSS 变量，**并**为每个平台补一个
 * `--plat-c`（该平台的代表色，供 `.plat-dot` 平台圆点用）。
 *
 * 原来 content.css 手写 8 条 `.badge-<id>` 规则：新增平台忘了补 CSS **不报错**，
 * 只静默掉回默认色。改为变量注入后，这一漏洞从"不可见"变成"契约测试可断言"。
 *
 * `--plat-c` 直接复用 `badge.fg`（manifest 里本就是"该平台的语义色令牌"，
 * 如 netease→var(--c-danger)、qq→var(--c-warn)、bilibili→var(--accent-ui)）。
 * 这样平台圆点不再需要 content.css 手写 `#31c27c` / `#fb7299` 这类写死色值
 * ——那是本仓明确禁止的（主题共 7 套，写死 hex 在浅色主题下对比度不达标），
 * 且原先只覆盖 3 个平台，另外 5 个平台的圆点会静默变透明。
 *
 * ⚠️ 这里**不**校验 badge.fg 是否是合法 CSS 颜色。manifest 是唯一来源，
 *    写错色值属于 manifest 的契约问题（test/platform-contract.test.js 覆盖），
 *    在渲染层做二次校验只会把问题藏起来。
 *
 * 幂等：重复调用只覆盖同一个 <style> 的内容。
 * @param {Array} list
 */
function applyPlatformBadgeTheme(list) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(BADGE_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = BADGE_STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  // ⚠️ 选择器必须**同时**命中圆点 `.plat-dot[data-plat=id]`。
  //    只写 `.badge-<id>` 时，--plat-c 挂在徽标元素上，而圆点是徽标的
  //    **兄弟节点**（见 views/home.js 的 .plat-block-head），CSS 变量
  //    只向下继承，兄弟拿不到 —— 表现是 8 个平台圆点**全部**回落灰色，
  //    且不报任何错。这个 bug 实际发生过一次（删掉 content.css 的
  //    逐平台色值规则时没验证变量能否到达）。
  el.textContent = (list || [])
    .filter(p => p && p.id && p.badge && /^[a-zA-Z0-9_-]{1,32}$/.test(String(p.id)))
    .map(p => `.badge-${p.id},.plat-dot[data-plat="${p.id}"]{`
            + `--badge-bg:${p.badge.bg};--badge-fg:${p.badge.fg};--badge-border:${p.badge.border};`
            + `--plat-c:${p.badge.fg};}`)
    .join('');
}

/**
 * 平台标签（旧名，等价 platformName）—— 保留以免打断既有调用方与 window 桥接
 * @deprecated 新代码请用 platformName
 */
const srcLabel = platformName;

function statusLabel(s) {
  return { pending: '⏳ 等待', downloading: '⬇ 下载中', done: '✅ 完成', error: '❌ 失败' }[s] || s;
}

// ── 播放次数格式化 ────────────────────────────────────
function formatPlayCount(n) {
  if (n == null || n === 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

// ── 历史时间格式化 ────────────────────────────────────
function fmtHistoryTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

// ── 可交互 Toast（带一个动作按钮）────────────────────
/**
 * 唯一一份"带按钮的 toast"实现：正文 + 一个动作 + 到点自己消失。
 *
 * 收口：此前只有「已下载过，仍要下载」用到这套结构（手造 div + 按钮 + 定时消失），
 * 播放失败就地重下是第二个消费方 —— 这套结构不许有第二份实现。
 * @param {object}   opts
 * @param {string}   opts.text       正文
 * @param {string}   opts.btnLabel   按钮文字
 * @param {function} opts.onConfirm  点按钮后的回调（点击即关掉这条 toast）
 * @param {number}   [opts.ttl=6000] 停留时长 ms
 * @param {string}   [opts.tone=warn] 色族：'warn' | 'success'（为首次下载庆祝开的
 *                                   可选项）。只认这两族、类名走 base.css 既有 token 类，
 *                                   不传照旧 warn —— 撤销/仍要下载两处零改动。
 */
function showActionToast({ text, btnLabel, onConfirm, ttl = 6000, tone = 'warn' } = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = tone === 'success' ? 'toast toast-success toast-action' : 'toast toast-warn toast-action';
  const span = document.createElement('span');
  span.className = 'toast-action-text';
  span.textContent = String(text || '');
  const btn = document.createElement('button');
  btn.className = 'toast-action-btn';
  btn.type = 'button';
  btn.textContent = String(btnLabel || '');
  el.appendChild(span);
  el.appendChild(btn);
  container.appendChild(el);
  btn.addEventListener('click', () => { el.remove(); if (onConfirm) onConfirm(); });
  setTimeout(() => {
    el.style.animation = 'toast-out .25s ease forwards';
    setTimeout(() => el.remove(), 250);
  }, ttl);
}

/**
 * 显示"已下载过，是否重下"的可交互 Toast（跨会话下载去重）
 *
 * @param {string} title  歌曲标题（toast 文案里展示）
 * @param {number} finishedAt 上次下载完成时间戳（可空，显示"3天前"）
 * @param {function} onConfirm 用户点击「仍要下载」后的回调（由调用方带 forceRedownload 重发）
 */
function showRedownloadToast(title, finishedAt, onConfirm) {
  const when = finishedAt ? fmtHistoryTime(finishedAt) : '';
  // 取词走 i18n.js 挂上的 window.t —— 本模块被 node 测试直接 ESM import，
  // 静态 import i18n.js 会把 JSON 拖进模块图（i18n.js 顶部记着这两条替代路都堵死）。
  showActionToast({
    text: when
      ? window.t('toast.alreadyDownloadedAt', { title, when })
      : window.t('toast.alreadyDownloaded', { title }),
    btnLabel: window.t('toast.redownload'),
    onConfirm,
  });
}

/**
 * 打开「文件所在文件夹」——全仓唯一入口。
 *
 * 为什么要有这一层：主进程 open-folder 从 2026-09-28 起接了 approvedDirs 沙箱
 * （见 src/main/ipc/window.js 的 P1-9 注释），未批准的路径会返回
 * `{ok:false, error}`。而当时 9 个调用点里有 8 个**完全忽略返回值**：
 * 用户点了「打开文件夹」，资源管理器不弹、也不给任何提示 —— 静默失败，
 * 比报错更难排查，也违反本仓「反馈必须跟着事实走」的纪律。
 *
 * 所以判据只写在这里一处，调用方一律走它。失败时如实说明，并**区分两类原因**
 * （用户能采取的动作不一样）：被沙箱拒 vs 通道异常。
 *
 * @param {string} folder 目标目录或文件路径
 * @returns {Promise<boolean>} 是否真的打开了
 */
async function openFolderSafe(folder) {
  if (!folder) {
    showToast(window.t('toast.folderNoPath'), 'warn');
    return false;
  }
  try {
    const r = await api.openFolder(folder);
    if (r && r.ok === false) {
      showToast(window.t('toast.folderBlocked', { error: r.error || '' }), 'warn');
      return false;
    }
    return true;
  } catch (e) {
    // 通道本身炸了（不是被拒）—— 如实说「打不开」，不假装成路径问题。
    // 文案走 errBrief：全仓规矩是用户可见的弹层不许直拼 .message（栈文本会漏到界面上），
    // test/err-brief.test.js 有全局反向钉盯着。
    showToast(window.t('toast.folderOpenFailed', { error: await _brief(e) }), 'warn');
    return false;
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  esc,
  escQ,
  escAttr,
  fmtTime,
  fmtDuration,
  formatBytes,
  srcLabel,
  platformName,
  platformIcon,
  getPlatforms,
  setPlatforms,
  fallbackPlatformIds,
  applyPlatformBadgeTheme,
  badgeCls,
  statusLabel,
  formatPlayCount,
  fmtHistoryTime,
  showActionToast,
  showRedownloadToast,
  openFolderSafe,
  playReferer,
};

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.esc = esc;
window.escQ = escQ;
window.escAttr = escAttr;
window.playReferer = playReferer;
window.fmtTime = fmtTime;
window.fmtDuration = fmtDuration;
window.formatBytes = formatBytes;
window.srcLabel = srcLabel;
window.platformName = platformName;
window.platformIcon = platformIcon;
window.getPlatforms = getPlatforms;
window.setPlatforms = setPlatforms;
window.fallbackPlatformIds = fallbackPlatformIds;
window.applyPlatformBadgeTheme = applyPlatformBadgeTheme;
window.badgeCls = badgeCls;
window.statusLabel = statusLabel;
window.formatPlayCount = formatPlayCount;
window.fmtHistoryTime = fmtHistoryTime;
window.showActionToast = showActionToast;
window.showRedownloadToast = showRedownloadToast;
window.openFolderSafe = openFolderSafe;
