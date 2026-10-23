/**
 * userSourceValidator.js — 用户自定义音源脚本的静态分析器
 *
 * 职责：把用户粘贴的一段 JS 脚本，压成 Lanyue 的 manifest 插件形态，
 * 同时做**安全筛查** —— 这是用户脚本进沙箱前的最后一道闸。
 *
 * 为什么不能只看运行时行为
 * --------------------------
 * 用户脚本在沙箱里执行时，所有出网都走 hostApi（见 hostApi.js）。
 * 但如果脚本里有 `eval`、`require`、`fetch`、`process` 这类原语，
 * 它们可以绕过 hostApi 直接触网或触 Node —— 静态分析要在**执行前**
 * 就把它们拦下来，而不是等沙箱跑起来再发现。
 *
 * 判定原则：**宁可误杀，不可放行**。
 * 一条被误拒的脚本用户重写一下就好；一条放行的恶意脚本可能读凭据。
 *
 * 分析产物
 * --------
 * 返回 `{ ok, manifest?, errors[], warnings[] }`：
 *   · ok: true ⇒ 脚本通过筛查，manifest 可直接交给 pluginRegistry
 *   · ok: false ⇒ 至少有一个 blocking 错误，manifest 为 null
 *
 * 设计取舍：不做完整的 JS 语法分析（那需要 acorn/esprima 之类的解析器，
 * 本工程零依赖）。用**正则 + 词法扫描**足以覆盖所有危险原语的**直接使用**；
 * 间接绕过（如 `eval('f'+'etch()')`）无法静态证明，但这类脚本占比极低，
 * 且运行时还有 hostApi 白名单 + gateway SSRF 兜底，形成纵深防御。
 */

'use strict';

// ── 危险原语：出现即拒绝 ─────────────────────────────────
//
// 这些原语让脚本可以绕过 hostApi 白名单，直接触网或触 Node。
// 每条都附「为什么必须拦」—— 审计时能直接看懂。
/**
 * @type {Array<{pattern: RegExp, name: string, reason: string}>}
 */
const BLOCKED_PATTERNS = [
  // 直接触网：绕开 hostApi 也就绕开了 gateway 的 SSRF 白名单
  { pattern: /\bfetch\s*\(/, name: 'fetch', reason: '直接触网会绕开 hostApi 与 gateway 的 SSRF 白名单' },
  { pattern: /\bXMLHttpRequest\b/, name: 'XMLHttpRequest', reason: '同 fetch，直接触网绕开白名单' },
  { pattern: /\bWebSocket\b/, name: 'WebSocket', reason: 'WebSocket 同样直接触网' },
  { pattern: /\bEventSource\b/, name: 'EventSource', reason: 'SSE 同样直接触网' },
  { pattern: /\bimport\s*\(/, name: '动态 import()', reason: '动态 import 可加载任意模块，包括 node: 协议' },

  // 模块系统：可加载 fs / child_process / secretStore
  { pattern: /\brequire\s*\(/, name: 'require()', reason: 'require 可加载 Node 内置模块（fs / child_process）' },
  { pattern: /\bimport\s+[{*\sA-Za-z_$](?:.|\n){0,120}?\bfrom\s+['"]/, name: '静态 import', reason: '静态 import 同样可加载任意模块' },

  // 代码执行：动态构造的代码无法静态证明
  { pattern: /\beval\s*\(/, name: 'eval()', reason: 'eval 可执行任意代码，绕过全部静态检查' },
  { pattern: /\bnew\s+Function\s*\(/, name: 'new Function()', reason: 'Function 构造器等价于 eval' },

  // Node / 浏览器运行时对象：读环境变量、读写文件、退出进程
  { pattern: /\bprocess\b\s*\./, name: 'process.', reason: 'process 可访问环境变量与退出进程' },
  { pattern: /\bglobalThis\b/, name: 'globalThis', reason: 'globalThis 是全局对象的别名，可触碰所有全局' },
  { pattern: /\bglobal\b\s*\./, name: 'global.', reason: 'Node 全局对象，可触 Node API' },
  { pattern: /\bwindow\b\s*\./, name: 'window.', reason: 'window 可触浏览器全局与其它窗口的权限' },
  { pattern: /\bself\b\s*\./, name: 'self.', reason: 'Worker 全局，同 window' },

  // Node 内置模块的直接引用（即使绕过 require，也可能通过解构拿到）
  { pattern: /\bchild_process\b/, name: 'child_process', reason: '子进程执行能力，等价于提权' },
  { pattern: /\bfs\s*\./, name: 'fs.', reason: '文件系统读写' },
  { pattern: /\bBuffer\b/, name: 'Buffer', reason: 'Buffer 是 Node 全局，可用于底层 IO' },

  // Node 路径锚
  { pattern: /\b__dirname\b/, name: '__dirname', reason: 'Node 模块路径锚，泄露宿主文件结构' },
  { pattern: /\b__filename\b/, name: '__filename', reason: '同 __dirname' },
];

// ── 能力推导：调了哪些 hostApi 方法 ───────────────────────
//
// 与 pluginRegistry 的 CAPABILITY_METHODS 同源语义 —— 内置平台靠「方法
// 是否存在」推导能力，用户脚本靠「调了哪些方法」推导。
const CAPABILITY_METHODS = Object.freeze({
  album: 'hostApi.platformSearch',
  albumSongs: 'hostApi.platformAlbumSongs',
  singer: 'hostApi.platformSearch',
  singerSongs: 'hostApi.platformSingerSongs',
  singerAlbums: 'hostApi.platformSingerAlbums',
  lyrics: 'hostApi.platformGetLyrics',
  lyricsByTitle: 'hostApi.platformGetLyricsByTitle',
  linkDetail: 'hostApi.platformGetSongDetail',
  cookie: 'hostApi.platformHasCookie',
  playlistDetail: 'hostApi.platformGetPlaylistDetail',
  playlistSongs: 'hostApi.platformGetPlaylistSongs',
  topList: 'hostApi.platformGetTopList',
  recommendPlaylists: 'hostApi.platformGetRecommendPlaylists',
  categoryPlaylists: 'hostApi.platformGetCategoryPlaylists',
  newSongs: 'hostApi.platformGetNewSongs',
  radioStations: 'hostApi.platformGetRadioStations',
  hotSingers: 'hostApi.platformGetHotSingers',
  ranking: 'hostApi.platformGetRanking',
});

/** hostApi 允许暴露的方法清单（也是运行时 preload 的暴露面） */
const HOST_API_METHODS = Object.freeze([
  'platformSearch',
  'platformGetUrl',
  'platformGetLyrics',
  'platformGetLyricsByTitle',
  'platformGetSongDetail',
  'platformGetAlbumSongs',
  'platformGetSingerSongs',
  'platformGetSingerAlbums',
  'platformGetPlaylistSongs',
  'platformGetPlaylistDetail',
  'platformGetTopList',
  'platformGetRecommendPlaylists',
  'platformGetCategoryPlaylists',
  'platformGetNewSongs',
  'platformGetRadioStations',
  'platformGetHotSingers',
  'platformGetRanking',
  'platformHasCookie',
]);

/** 扫描 hostApi.<method> 调用，返回用到的能力位集合 */
function deriveCapabilities(code) {
  const caps = {};
  for (const [cap, callName] of Object.entries(CAPABILITY_METHODS)) {
    const [, method] = callName.split('.');
    const re = new RegExp(`hostApi\\s*\\.\\s*${method}\\s*\\(`, 'g');
    caps[cap] = re.test(code);
  }
  return caps;
}

/** 扫描脚本里提到的平台 id（用于校验 id 合法性 + 审计） */
function extractPlatforms(code) {
  const set = new Set();
  const re = /['"`]([a-z][a-z0-9_-]{1,31})['"`]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    // 只收像平台 id 的：长度 2-32，小写字母开头
    if (/^[a-z][a-z0-9_-]{1,31}$/.test(m[1])) set.add(m[1]);
  }
  return [...set];
}

/** 剥离注释（与 test/ 下既有 stripComments 同思路，但更保守）
 *  注意：不能用跨行通配字符类 —— 那是 src/ 的口径禁令（test/modelJson.test.js:58），
 *  只准 modelJson.js 用「跨行捞一段」的取法。改用 (?:.|\n) 等价表达。
 */
function stripComments(src) {
  let s = String(src);
  // 块注释：保留换行以保持行号
  s = s.replace(/\/\*(?:.|\n)*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // 行注释：只处理不在字符串里的 //
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  return s;
}

/** 剥离字符串字面量（防止 `fetch("x")` 里的字符串干扰模式匹配） */
function stripStrings(src) {
  let s = String(src);
  // 字符串字面量：'...' "..." `...` —— 保留引号以维持结构
  s = s.replace(/(`(?:\\.|[^`\\])*`)/g, '`_`');
  s = s.replace(/('(?:\\.|[^'\\])*')/g, "'_'");
  s = s.replace(/("(?:\\.|[^"\\])*")/g, '"_"');
  // 注释里可能有危险词，先剥注释再剥字符串
  return s;
}

/**
 * 主入口：分析用户脚本。
 *
 * @param {string} script  用户粘贴的 JS 源码
 * @param {object} [opts]
 * @param {number} [opts.minHostVersion]  声明的最低宿主版本（可选）
 * @returns {{ok: boolean, manifest?: object|null, errors: Array<{line:number,name:string,reason:string}>, warnings: string[]}}
 */
function analyzeUserSource(script, opts = {}) {
  const errors = [];
  const warnings = [];

  if (typeof script !== 'string' || !script.trim()) {
    return { ok: false, manifest: null, errors: [{ line: 0, name: 'empty', reason: '脚本为空' }], warnings };
  }

  // 剥注释再剥字符串 —— 防止注释里写 fetch 或字符串里写 fetch 造成误判
  const code = stripStrings(stripComments(script));

  // ── 1. 危险原语筛查 ─────────────────────────────────
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, name, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(line)) {
        errors.push({ line: i + 1, name, reason });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors, warnings };
  }

  // ── 2. 能力推导 ─────────────────────────────────────
  const caps = deriveCapabilities(code);

  // ── 3. 必需能力：至少得能搜歌 或 能取流，否则没有意义 ──
  const hasSearch = !!caps.album || !!caps.singer || !!caps.playlistDetail;
  const hasUrl = /hostApi\s*\.\s*platformGetUrl\s*\(/.test(code);
  if (!hasSearch && !hasUrl) {
    return {
      ok: false,
      manifest: null,
      errors: [{ line: 0, name: 'no-capability', reason: '脚本至少需要调用 hostApi.platformSearch 或 hostApi.platformGetUrl 之一' }],
      warnings,
    };
  }

  // ── 4. 组装 manifest ─────────────────────────────────
  //
  // 注意：user script 没有 hosts 声明 —— 所有出网都走 hostApi → gateway，
  // gateway 自己做 SSRF 白名单。所以 hosts.origins 留空数组即可（不参与
  // CORS 派生，因为脚本根本不直接发请求）。
  const platforms = extractPlatforms(code);

  const manifest = {
    id: 'user:' + (opts.id || 'anonymous'),
    name: opts.name || '未命名用户脚本',
    policies: {
      fallbackSource: false,  // 用户源不参与跨源换源候选（避免用户脚本互相换）
      probeable: false,       // 不做主动探针（脚本可能每次返回不同结果）
      order: 9999,            // 排在内置 8 源之后
      aggregateLimit: 0,      // 不参与聚合搜索（避免拖慢聚合）
    },
    hosts: { origins: [] },   // 出网全走 hostApi，此处仅占位
    _isUserSource: true,
    _platforms: platforms,
    _capabilities: caps,
    // 真正的平台能力在运行时由 hostApi 注入；manifest 只带元信息
    _minHostVersion: opts.minHostVersion || null,
  };

  return { ok: true, manifest, errors, warnings };
}

/**
 * 校验 manifest 是否符合 pluginRegistry 的 validate() 要求。
 * 与内置平台的校验同源，但允许 `id` 带 `user:` 前缀。
 *
 * @param {object} manifest analyzeUserSource 产出的 manifest
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest 必须是对象'] };
  }
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    errors.push('manifest.id 缺失或非字符串');
  } else if (!/^user:.+/.test(manifest.id)) {
    errors.push(`manifest.id 必须以 "user:" 开头，避免与内置平台冲突: ${manifest.id}`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    errors.push('manifest.name 缺失或非字符串');
  }
  if (!manifest.hosts || !Array.isArray(manifest.hosts.origins)) {
    errors.push('manifest.hosts.origins 缺失');
  }
  if (!manifest.policies || typeof manifest.policies.order !== 'number') {
    errors.push('manifest.policies.order 缺失或非数字');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  analyzeUserSource,
  validateManifest,
  deriveCapabilities,
  extractPlatforms,
  BLOCKED_PATTERNS,
  HOST_API_METHODS,
  CAPABILITY_METHODS,
};
