'use strict';
/**
 * IPC 单一契约（主进程 与 preload 共用的唯一事实来源）
 *
 * 背景（2026-09 架构改造）：原先通道清单散在三处 ——
 *   preload.js 的 SAFE_CHANNELS_SEND/RECEIVE/INVOKE + METHOD_MAP 手工对账、
 *   preload-secondary.js 的第二套清单、主进程各 ipc/*.js 里的裸 ipcMain.handle，
 * 任何一处漂移都静默坏掉（send-only 通道被 invoke → Promise 永远 pending），
 * 且每个 handler 各自手写参数校验/双形态 shim。
 *
 * 现在：
 *   - 本文件声明全部通道（方向 invoke/send/receive + 可见窗口 + 参数规格）
 *   - 两个 preload 由它派生白名单与方法表（Vite 在构建期内联，sandbox 下可用）
 *   - 主进程经 src/main/ipc/register.js 的 handle/on 注册，进 handler 前按规格校验
 *   - test/ipc-contract.test.js 静态比对源码，保证契约 ↔ 实现不漂移
 *
 * 约定：
 *   - invoke/send 通道的 args 为 [ [参数名, 规格], ... ]，null = 原样透传
 *   - 校验只做「形状」：类型钳制/截断/默认值，不改变合法值语义
 *   - 新增 receive 通道时必须同时想清楚暴露给哪个窗口（win 最小化原则）
 */

// ── 参数规格原语（纯数据，可被打包器安全内联） ─────────────────
const t = {
  str:   (max) => ({ k: 'str', max }),
  int:   (def, max) => ({ k: 'int', def, max }),
  bool:  () => ({ k: 'bool' }),
  enum:  (values, def) => ({ k: 'enum', values, def }),
  obj:   () => ({ k: 'obj' }),
  arr:   (max) => ({ k: 'arr', max }),
  any:   () => ({ k: 'any' }),
};

// 便捷构造：dir 键（invoke/send/receive）的值为可见该方向的窗口清单
const MAIN = ['main'];
const BOTH = ['main', 'secondary'];

// 传输层信封标记键：register.js 把 handler 返回值包成
// { [ENVELOPE_KEY]: 1, ok, data | error }，preload 解包还原后再交给渲染层。
// 渲染层永远见不到信封；sandbox preload 不能 require 应用文件，
// 故实际键值经 buildContractArg 的 envKey 字段注入，这里是唯一声明处。
const ENVELOPE_KEY = '__ipcEnv';

const CHANNELS = {
  // ── 搜索 / 歌词 / 推荐（invoke） ──────────────────
  'search-music':   { invoke: MAIN, args: [['keyword', t.str(200)], ['source', t.str(32)], ['page', t.int(1, 1000)]] },
  'search-singer':  { invoke: MAIN, args: [['keyword', t.str(200)], ['source', t.str(32)], ['page', t.int(1, 1000)]] },
  'search-album':   { invoke: MAIN, args: [['keyword', t.str(200)], ['source', t.str(32)], ['page', t.int(1, 1000)]] },
  'get-singer-songs':  { invoke: MAIN, args: [['singerMid', t.str(64)], ['limit', t.int(30, 200)]] },
  'get-singer-albums': { invoke: MAIN, args: [['singerMid', t.str(64)], ['source', t.str(32)], ['pageNo', t.int(1, 1000)], ['pageSize', t.int(20, 100)]] },
  'get-album-songs':   { invoke: MAIN, args: [['platform', t.str(32)], ['albumMid', t.str(64)], ['limit', t.int(999, 1000)]] },
  'get-playlist-songs':{ invoke: MAIN, args: [['platform', t.str(32)], ['id', t.str(128)], ['limit', t.int(200, 2000)]] },
  'get-song-by-link':  { invoke: MAIN, args: [['text', t.str(2000)]] },
  'get-lyrics':     { invoke: MAIN, args: [['id', t.any()], ['source', t.str(32)], ['title', t.str(200)], ['artist', t.str(200)]] },
  'get-home-section':         { invoke: MAIN, args: [['section', t.str(64)]] },
  'get-home-recommendations': { invoke: MAIN },
  'get-platforms':  { invoke: MAIN },
  'get-source-health': { invoke: MAIN },
  'probe-sources':  { invoke: MAIN },
  'nl-search-music': { invoke: MAIN, args: [['phrase', t.str(200)]] },

  // ── 下载（invoke） ────────────────────────────────
  // id/source 的最终合法性判定仍留在 handler（safeId/safeToken，错误文案是产品约定）
  'get-download-url':       { invoke: MAIN, args: [['id', t.any()], ['source', t.any()], ['quality', t.enum(['lossless', 'hq', 'standard'], 'standard')]] },
  'get-download-url-smart': { invoke: MAIN, args: [['song', t.any()], ['quality', t.str(16)]] },
  'add-to-queue':           { invoke: MAIN, args: [['song', t.obj()]] },
  'cancel-download':        { invoke: MAIN, args: [['taskId', t.any()]] },
  'retry-download':         { invoke: MAIN, args: [['taskId', t.any()]] },
  'remove-queue-item':      { invoke: MAIN, args: [['taskId', t.any()]] },
  'reorder-queue-item':     { invoke: MAIN, args: [['taskId', t.str(64)], ['action', t.enum(['up', 'down', 'top'])]] },
  'set-queue-paused':       { invoke: MAIN, args: [['paused', t.bool()]] },
  'clear-finished-queue':   { invoke: MAIN },
  'clear-all-queue':        { invoke: MAIN },
  'add-playlist-to-queue':  { invoke: MAIN, args: [['payload', t.obj()]] },
  'export-playlist':        { invoke: MAIN, args: [['params', t.obj()]] },
  'system-power':           { invoke: MAIN, args: [['action', t.enum(['shutdown', 'sleep', 'quit'], 'quit')]] },
  'probe-audio':            { invoke: MAIN, args: [['filePath', t.str(1000)]] },
  // D-35：refresh 是同源重取标识（可选）。主进程据此在 403 时重新取流；
  // 这里的 source 必须是**实际出流的源**，不由渲染层决定重取走哪个源。
  'proxy-play':             { invoke: MAIN, args: [['url', t.str(4000)], ['referer', t.str(4000)], ['refresh', t.obj()]] },
  'get-download-templates': { invoke: MAIN },
  'save-download-template': { invoke: MAIN, args: [['template', t.obj()]] },
  'delete-download-template': { invoke: MAIN, args: [['templateId', t.str(64)]] },
  'set-active-template':    { invoke: MAIN, args: [['templateId', t.str(64)]] },
  'preview-naming-template':{ invoke: MAIN, args: [['template', t.any()]] },

  // ── 订阅更新（invoke） ──────────────────────────────
  // key 格式为 `${type}:${platform}:${targetId}`，合法性由主进程引擎判定
  'subscribe-list':      { invoke: MAIN },
  'subscribe-add':       { invoke: MAIN, args: [['type', t.str(16)], ['platform', t.str(32)], ['targetId', t.str(128)], ['name', t.str(200)]] },
  'subscribe-remove':    { invoke: MAIN, args: [['key', t.str(200)]] },
  'subscribe-update':    { invoke: MAIN, args: [['key', t.str(200)], ['patch', t.obj()]] },
  'subscribe-check':     { invoke: MAIN },
  'subscribe-mark-seen': { invoke: MAIN, args: [['key', t.str(200)]] },

  // ── Cookie / 登录（invoke） ───────────────────────
  'get-cookies':        { invoke: MAIN },
  'save-cookie':        { invoke: MAIN, args: [['platform', t.str(32)], ['cookie', t.str(65536)]] },
  'clear-cookie':       { invoke: MAIN, args: [['platform', t.str(32)]] },
  'verify-cookie':      { invoke: MAIN, args: [['platform', t.str(32)], ['cookie', t.any()]] },
  'open-login-window':  { invoke: MAIN, args: [['platform', t.str(32)]] },

  // ── 本地音乐库（invoke） ──────────────────────────
  // 路径参数的目录沙箱（approvedDirs）留在 handler，这里只钳形状
  'scan-local-library':   { invoke: MAIN, args: [['dirPath', t.str(1024)]] },
  'load-library-index':   { invoke: MAIN },
  'read-local-metadata':  { invoke: MAIN, args: [['filePath', t.str(1024)]] },
  'read-local-lrc':       { invoke: MAIN, args: [['filePath', t.str(1024)]] },
  'write-local-lrc':      { invoke: MAIN, args: [['filePath', t.str(1024)], ['lrc', t.str(2000000)]] },
  'update-id3-tags':      { invoke: MAIN, args: [['filePath', t.str(1024)], ['tags', t.any()]] },
  'update-id3-cover':     { invoke: MAIN, args: [['filePath', t.str(1024)], ['imageBase64', t.str(25000000)]] },
  'fetch-online-cover':   { invoke: MAIN, args: [['title', t.str(200)], ['artist', t.str(200)]] },
  'batch-fetch-lyrics':   { invoke: MAIN, args: [['songs', t.arr(5000)]] },
  'check-local-exists':   { invoke: MAIN, args: [['payload', t.obj()]] },
  'convert-audio':        { invoke: MAIN, args: [['params', t.obj()]] },
  'cancel-convert-audio': { invoke: MAIN },
  'delete-file':          { invoke: MAIN, args: [['filePath', t.str(1024)]] },
  'rename-file':          { invoke: MAIN, args: [['oldPath', t.str(1024)], ['newPath', t.str(1024)]] },
  'find-content-duplicates': { invoke: MAIN, args: [['dirPath', t.str(1024)]] },

  // ── 文件 / 目录 / 系统（invoke） ──────────────────
  'select-dir':       { invoke: MAIN },
  'get-default-dir':  { invoke: MAIN },
  'open-folder':      { invoke: MAIN, args: [['folder', t.str(1024)]] },
  'open-external':    { invoke: MAIN, args: [['url', t.str(4000)]] },
  'get-cache-size':   { invoke: MAIN },
  'clear-play-cache': { invoke: MAIN },

  // ── 设置 / 偏好（invoke） ─────────────────────────
  'get-pref':            { invoke: MAIN, args: [['key', t.str(64)]] },
  'set-pref':            { invoke: MAIN, args: [['key', t.str(64)], ['value', t.any()]] },
  'get-search-history':  { invoke: MAIN },
  'set-search-history':  { invoke: MAIN, args: [['history', t.arr(1000)]] },
  'get-version':         { invoke: MAIN },

  // ── 播放队列持久化（invoke，注册在 main/index.js） ─
  'save-play-queue': { invoke: MAIN, args: [['data', t.any()]] },
  'load-play-queue': { invoke: MAIN },
  'generate-heartbeat': { invoke: MAIN, args: [['currentSongId', t.any()], ['currentSource', t.any()]] },

  // ── 历史（invoke） ────────────────────────────────
  'query-history': { invoke: MAIN, args: [['opts', t.obj()]] },
  'history-stats': { invoke: MAIN },
  'clear-history': { invoke: MAIN },
  'remove-history': { invoke: MAIN, args: [['entries', t.arr(1000)]] },

  // ── AI（invoke） ──────────────────────────────────
  'ai-generate-music':   { invoke: MAIN, args: [['params', t.obj()]] },
  'ai-cancel-generation': { invoke: MAIN, args: [['requestId', t.str(64)]] },
  'ai-generate-lyrics':  { invoke: MAIN, args: [['params', t.obj()]] },
  'ai-translate-lyrics': { invoke: MAIN, args: [['params', t.obj()]] },
  'ai-history':          { invoke: MAIN },
  'ai-add-history':      { invoke: MAIN, args: [['item', t.obj()]] },
  'ai-clear-history':    { invoke: MAIN },

  // ── 用户歌单（invoke） ────────────────────────────
  'get-user-playlists':        { invoke: MAIN },
  'save-user-playlist':        { invoke: MAIN, args: [['playlist', t.obj()]] },
  'delete-user-playlist':      { invoke: MAIN, args: [['playlistId', t.str(64)]] },
  'add-to-user-playlist':      { invoke: MAIN, args: [['playlistId', t.str(64)], ['song', t.any()]] },
  'remove-from-user-playlist': { invoke: MAIN, args: [['playlistId', t.str(64)], ['songId', t.any()], ['source', t.str(32)]] },
  'toggle-favorite':           { invoke: MAIN, args: [['source', t.str(32)], ['songId', t.any()], ['song', t.any()]] },

  // 3-B 跨源聚合：合并多份来源的曲目并标记跨源同曲（只读聚合层，不新增/修改数据）
  'aggregate-cross-source':   { invoke: MAIN, args: [['opts', t.obj()]] },

  // 3-A 电台：取刚播完那首的同歌手候选曲目（只读，无副作用）

  // ── 云同步 / 更新（invoke） ───────────────────────
  'export-all-data':    { invoke: MAIN },
  'import-all-data':    { invoke: MAIN },
  'cloud-sync-config-get': { invoke: MAIN },
  'cloud-sync-config-set': { invoke: MAIN, args: [['cfg', t.any()]] },
  'cloud-sync-now':     { invoke: MAIN },

  // ── MCP 本地服务（invoke）─────────────────────────
  'mcp-status':     { invoke: MAIN },
  'mcp-set-config': { invoke: MAIN, args: [['cfg', t.any()]] },
  'check-for-update':   { invoke: MAIN },
  'download-update':    { invoke: MAIN },
  'restart-and-install':{ invoke: MAIN },

  // ── 渲染层 → 主进程（send 单向） ──────────────────
  'window-minimize': { send: MAIN },
  'window-maximize': { send: MAIN },
  'window-close':    { send: MAIN },
  'open-mini-player':      { send: MAIN },
  'mini-player-update':    { send: MAIN, receive: BOTH, args: [['data', t.any()]] },
  'open-desktop-lyric':    { send: MAIN },
  'desktop-lyric-update':  { send: MAIN, args: [['data', t.any()]] },
  'desktop-lyric-close':   { send: BOTH },
  'desktop-lyric-lock':    { send: BOTH, args: [['locked', t.bool()]] },
  'desktop-lyric-set-ignore-mouse': { send: BOTH, args: [['ignore', t.bool()]] },
  'tray-update-play-state': { send: MAIN, args: [['state', t.any()]] },
  'set-global-shortcuts':   { send: MAIN, args: [['enabled', t.bool()]] },
  'mini-next':       { send: BOTH, receive: MAIN },
  'mini-prev':       { send: BOTH, receive: MAIN },
  'mini-toggle-play':{ send: BOTH, receive: MAIN },
  'mini-close':      { send: BOTH },

  // ── 主进程 → 渲染层（receive 事件） ───────────────
  'queue-updated':         { receive: MAIN },
  'queue-paused-changed':  { receive: MAIN },
  'subscriptions-updated': { receive: MAIN },
  'clipboard-link':        { receive: MAIN },
  'download-progress':     { receive: MAIN },
  'download-error':        { receive: MAIN },
  'play-queue-restored':   { receive: MAIN },
  'local-lrc-fetched':     { receive: MAIN },
  'local-library-changed': { receive: MAIN },
  'convert-audio-progress':{ receive: MAIN },
  'sync-mini-player':      { receive: MAIN },
  'sync-desktop-lyric':    { receive: MAIN },
  'desktop-lyric-data':    { receive: ['secondary'] },
  'focus-search':          { receive: MAIN },
  'sleep-timer':           { receive: MAIN },
  'tray-toggle-play':      { receive: MAIN },
  'tray-next':             { receive: MAIN },
  'tray-prev':             { receive: MAIN },
  'update-available':          { receive: MAIN },
  'update-not-available':      { receive: MAIN },
  'update-download-progress':  { receive: MAIN },
  'update-downloaded':         { receive: MAIN },
  'update-error':              { receive: MAIN },
};

// ── 渲染层方法名（camelCase）→ 通道：主窗口 musicAPI 的生成清单 ──
const METHODS = {
  // 窗口（send-only：主进程只有 ipcMain.on，走 invoke 会无人应答）
  windowClose: 'window-close',
  windowMinimize: 'window-minimize',
  windowMaximize: 'window-maximize',
  systemPower: 'system-power',
  // 搜索
  searchMusic: 'search-music',
  nlSearchMusic: 'nl-search-music',
  searchAlbum: 'search-album',
  searchSinger: 'search-singer',
  getSingerSongs: 'get-singer-songs',
  getSingerAlbums: 'get-singer-albums',
  getAlbumSongs: 'get-album-songs',
  getSongByLink: 'get-song-by-link',
  // 推荐
  getHomeSection: 'get-home-section',
  getHomeRecommendations: 'get-home-recommendations',
  getPlaylistSongs: 'get-playlist-songs',
  // 下载
  getDownloadUrl: 'get-download-url',
  getDownloadUrlSmart: 'get-download-url-smart',
  addToQueue: 'add-to-queue',
  proxyPlay: 'proxy-play',
  cancelDownload: 'cancel-download',
  retryDownload: 'retry-download',
  removeQueueItem: 'remove-queue-item',
  reorderQueueItem: 'reorder-queue-item',
  setQueuePaused: 'set-queue-paused',
  clearFinishedQueue: 'clear-finished-queue',
  clearAllQueue: 'clear-all-queue',
  addPlaylistToQueue: 'add-playlist-to-queue',
  exportPlaylist: 'export-playlist',
  getDownloadTemplates: 'get-download-templates',
  saveDownloadTemplate: 'save-download-template',
  deleteDownloadTemplate: 'delete-download-template',
  setActiveDownloadTemplate: 'set-active-template',
  previewNamingTemplate: 'preview-naming-template',
  // 订阅更新
  subscribeList: 'subscribe-list',
  subscribeAdd: 'subscribe-add',
  subscribeRemove: 'subscribe-remove',
  subscribeUpdate: 'subscribe-update',
  subscribeCheck: 'subscribe-check',
  subscribeMarkSeen: 'subscribe-mark-seen',
  // 歌词
  getLyrics: 'get-lyrics',
  // Cookie
  getCookies: 'get-cookies',
  saveCookie: 'save-cookie',
  clearCookie: 'clear-cookie',
  verifyCookie: 'verify-cookie',
  openLoginWindow: 'open-login-window',
  // 本地
  scanLocalLibrary: 'scan-local-library',
  loadLibraryIndex: 'load-library-index',
  readLocalMetadata: 'read-local-metadata',
  readLocalLrc: 'read-local-lrc',
  writeLocalLrc: 'write-local-lrc',
  checkLocalExists: 'check-local-exists',
  updateId3Tags: 'update-id3-tags',
  updateId3Cover: 'update-id3-cover',
  fetchOnlineCover: 'fetch-online-cover',
  batchFetchLyrics: 'batch-fetch-lyrics',
  convertAudio: 'convert-audio',
  cancelConvertAudio: 'cancel-convert-audio',
  probeAudio: 'probe-audio',
  deleteFile: 'delete-file',
  renameFile: 'rename-file',
  findContentDuplicates: 'find-content-duplicates',
  // 文件
  selectDir: 'select-dir',
  getDefaultDir: 'get-default-dir',
  openFolder: 'open-folder',
  openExternal: 'open-external',
  // 设置
  getPref: 'get-pref',
  setPref: 'set-pref',
  getSearchHistory: 'get-search-history',
  setSearchHistory: 'set-search-history',
  // 播放队列
  savePlayQueue: 'save-play-queue',
  loadPlayQueue: 'load-play-queue',
  generateHeartbeat: 'generate-heartbeat',
  // 历史
  queryHistory: 'query-history',
  getHistoryStats: 'history-stats',
  clearHistory: 'clear-history',
  removeHistory: 'remove-history',
  // 缓存
  getCacheSize: 'get-cache-size',
  clearPlayCache: 'clear-play-cache',
  // 播放
  getVersion: 'get-version',
  // AI
  aiGenerateMusic: 'ai-generate-music',
  aiCancelGeneration: 'ai-cancel-generation',
  aiGenerateLyrics: 'ai-generate-lyrics',
  aiTranslateLyrics: 'ai-translate-lyrics',
  aiGetHistory: 'ai-history',
  aiAddHistory: 'ai-add-history',
  aiClearHistory: 'ai-clear-history',
  // 用户歌单
  getUserPlaylists: 'get-user-playlists',
  saveUserPlaylist: 'save-user-playlist',
  deleteUserPlaylist: 'delete-user-playlist',
  addToUserPlaylist: 'add-to-user-playlist',
  removeFromUserPlaylist: 'remove-from-user-playlist',
  toggleFavorite: 'toggle-favorite',
  aggregateCrossSource: 'aggregate-cross-source',
  // 云
  exportAllData: 'export-all-data',
  importAllData: 'import-all-data',
  // 更新
  checkForUpdate: 'check-for-update',
  downloadUpdate: 'download-update',
  restartAndInstall: 'restart-and-install',
  // mini / 歌词 / 托盘
  openMiniPlayer: 'open-mini-player',
  syncMiniPlayer: 'mini-player-update',
  openDesktopLyric: 'open-desktop-lyric',
  syncDesktopLyric: 'desktop-lyric-update',
  trayUpdatePlayState: 'tray-update-play-state',
  setGlobalShortcuts: 'set-global-shortcuts',
  getSourceHealth: 'get-source-health',
  probeSources: 'probe-sources',
  getPlatforms: 'get-platforms',
};

// ── 主窗口订阅事件：方法名 → receive 通道 ────────────────────
const EVENTS = {
  onQueueUpdated: 'queue-updated',
  onQueuePausedChanged: 'queue-paused-changed',
  onSubscriptionsUpdated: 'subscriptions-updated',
  onClipboardLink: 'clipboard-link',
  onDownloadProgress: 'download-progress',
  onDownloadError: 'download-error',
  onPlayQueueRestored: 'play-queue-restored',
  onLocalLrcFetched: 'local-lrc-fetched',
  onLocalLibraryChanged: 'local-library-changed',
  onConvertAudioProgress: 'convert-audio-progress',
  onSyncMiniPlayer: 'sync-mini-player',
  onSyncDesktopLyric: 'sync-desktop-lyric',
  onMiniNext: 'mini-next',
  onMiniPrev: 'mini-prev',
  onMiniTogglePlay: 'mini-toggle-play',
  onTrayNext: 'tray-next',
  onTrayPrev: 'tray-prev',
  onTrayTogglePlay: 'tray-toggle-play',
};

// ── 校验 ─────────────────────────────────────────────────────
function coerceVal(spec, v) {
  switch (spec.k) {
    case 'any':  return v;
    case 'str': {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'object' || typeof v === 'function') return { __err: '应为字符串' };
      return String(v).slice(0, spec.max);
    }
    case 'int': {
      if (v === undefined || v === null || v === '') return spec.def;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, spec.max) : spec.def;
    }
    case 'bool': return v === true;
    case 'enum': {
      if (v === undefined || v === null) return spec.def;
      return spec.values.includes(v) ? v : spec.def;
    }
    case 'obj': {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'object' || Array.isArray(v)) return { __err: '应为对象' };
      return v;
    }
    case 'arr': {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v)) return { __err: '应为数组' };
      return v.length > spec.max ? v.slice(0, spec.max) : v;
    }
    default: return { __err: '未知参数规格' };
  }
}

/**
 * 把 ipcMain 收到的 rest 参数规整为契约声明的位置参数数组。
 * 兼容三种调用形态：位置参数（现状主流）、单数组、单对象（按声明的参数名取键）。
 * 返回 { ok, args } 或 { ok:false, error }。
 */
function normalizeArgs(channel, raw) {
  const entry = CHANNELS[channel];
  const specs = entry && entry.args;
  if (!specs) return { ok: true, args: raw };

  let list = raw;
  if (raw.length === 1 && Array.isArray(raw[0]) && raw[0].length && specs[0][1].k !== 'arr') {
    list = raw[0]; // 单数组形态：invoke('ch', [a, b])
  } else if (raw.length === 1 && raw[0] && typeof raw[0] === 'object' && !Array.isArray(raw[0])
             && specs.length > 1 && specs.some(([name]) => Object.prototype.hasOwnProperty.call(raw[0], name))) {
    list = specs.map(([name]) => raw[0][name]); // 单对象形态：invoke('ch', { a, b })
  }

  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const [name, spec] = specs[i];
    const v = coerceVal(spec, list[i]);
    if (v && typeof v === 'object' && v.__err) {
      return { ok: false, error: `IPC 参数非法 [${channel}] ${name}: ${v.__err}` };
    }
    out.push(v);
  }
  return { ok: true, args: out };
}

// ── 供 preload 派生白名单 ────────────────────────────────────
function channelsFor(win, dir) {
  const set = new Set();
  for (const [name, e] of Object.entries(CHANNELS)) {
    if (e[dir] && e[dir].includes(win)) set.add(name);
  }
  return set;
}

/**
 * 序列化某个窗口的契约清单，经 webPreferences.additionalArguments 注入，
 * preload 从 process.argv 解析 —— sandbox preload 运行时不能 require 应用
 * 相对路径（Vite 也不内联 CJS require），这是保持单一事实源的传递方式。
 */
function buildContractArg(win) {
  const invoke = [...channelsFor(win, 'invoke')];
  const send = [...channelsFor(win, 'send')];
  const receive = [...channelsFor(win, 'receive')];
  const payload = { v: 1, win, invoke, send, receive, envKey: ENVELOPE_KEY, methods: {}, events: {} };
  if (win === 'main') {
    payload.methods = METHODS;
    payload.events = EVENTS;
  }
  return `--ipc-contract=${JSON.stringify(payload)}`;
}

module.exports = { t, CHANNELS, METHODS, EVENTS, normalizeArgs, coerceVal, channelsFor, buildContractArg, ENVELOPE_KEY };
