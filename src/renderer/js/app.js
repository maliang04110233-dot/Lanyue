/**
 * MusicDL 渲染进程入口
 * 初始化、页面切换、事件监听
 * 
 * ES Module 入口 — import 所有子模块确保 Vite 打包完整
 */

// ══════════════════════════════════════════════════════════
// ES Module 导入 — 确保所有模块被 Vite 包含
// ══════════════════════════════════════════════════════════
import { errBrief } from './errBrief.js';
import { askConfirm } from './confirmDialog.js';
import { logger } from './logger.js';
// 基础工具模块
import './state.js';
import './toast.js';
import './utils.js';
import { buildFallbackNotice } from './fallbackNotice.js';
import { describePlayError, playFailureRetry, playFailureRetryText } from './playError.js';
import { retryAfterPlayFailure } from './playRetry.js';
import { pickQueueCopyRows, queueCopyToastText } from './queueCopy.js';
import { toTrackLines } from './songListText.js';
import { listAccessHint, term } from './listAccess.js';
import { copyText } from './songShare.js';
import { isRangeClick, rangeKeys } from './selectionRange.js';
import { registerDeleteScope } from './deleteScope.js';
import { skeletonHtml, SKEL_ROWS } from './skeleton.js';
import './router.js';

// 播放器和快捷键
import { updateProgress, onAudioEnded, parseLrc, showNoLyrics, loadAndPlay, playQueueIdx } from './player.js';
import { initMediaSession } from './player/mediaSession.js';
import { heartBtnHtml, queueFavSong } from './favorites.js';
import './shortcuts.js';

// 播放状态外发同步 + 队列恢复（自 init() 内闭包提出，等价迁移）
import {
  syncToTray, syncToMiniPlayer, resetMiniPlayerSong, syncToDesktopLyric, resetDesktopLyricSong,
  restorePlayQueueFromSaved,
} from './player-sync.js';

// 视图模块
import './views/home.js';
import './views/search.js';
import './views/download.js';
import './views/history.js';
import './views/local.js';
import './views/settings.js';
import './views/ai-music.js';
// 转码公共层要在三个视图之前引入：它们 import 其中的弹窗与 runner
import './converter-core.js';
import './views/converter.js';
import './views/playlist.js';
import './views/aggregate.js';
import './views/subscriptions.js';
import './views/clipboard.js';
import './views/batchImport.js';
import './views/nameBatch.js';
import './views/welcome.js';
import './views/dragdrop.js';
import { dlObserveQueue, dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener } from './dlStatus.js';
import { openSongRowMenu } from './songMenu.js';
import './favorites.js';
import './player-controls.js';
import './sleepTimer.js';
import './playQueueSort.js';
import { removeQueueItem, removeQueueItemsByIdentity, dedupeQueue } from './playQueueEdit.js';
import { defaultQueuePlaylistName, pickPlSavableRows } from './queuePlaylist.js';
import './afterQueueDone.js';
import './autoLyricOnDone.js';
import './autoCoverOnDone.js';
import './firstDownloadCelebration.js';
import './m3uToPlaylist.js';
import { sanitizeSavedQueue } from './dropPlay.js';
import { pickCheckedSongs, toPlaylistRows, buildSavedPlaylist } from './plModalSave.js';
import './scheduledDownload.js';
import './commandPalette.js';
import './historyTrend.js';
import './artistGroups.js';
import './dismissed.js';
import './diagnose.js';
import './queueSummary.js';
import './lyricNudge.js';
import './abLoop.js';
import './abClip.js';
import './player/fade.js';
import './player/visualizer.js';
import { resolvePlayingIndex, flashRow } from './locatePlaying.js';
import './songGroups.js';

// 初始化模块（副作用引入：init.js 内部自挂 window.persistPlayQueue）
import './init.js';
// t 要在本文件里直接取 toast.* 词条：动态文案的家是语言包，不是调用点
import { t } from './i18n.js';
import './logger.js';
import './updater.js';
import { applyFeatureFlags, tabAllowed } from './features.js';

// 入口摘除要早于 init()：init 里有 await，等它跑完 AI 入口已经画到屏幕上了。
// 放在这里（所有视图模块之后）= DOM 已解析、首帧未画，且不会被任何模块重新挂回来。
applyFeatureFlags();

// ── API 代理 / Mock ───────────────────────────────────
// 使用 Object.assign 让 api 动态指向真实 window.musicAPI（如果 preload 已暴露）
// 先声明 mock，然后在 init() 前根据 window.musicAPI 动态覆盖
const mockApi = {
  getVersion: async () => (window.__APP_VERSION__ || '1.0.0') + (window.__APP_COMMIT__ ? ' (' + window.__APP_COMMIT__.slice(0, 7) + ')' : ''),
  searchMusic: async (k, s) => ({ songs: mockSongs(k, s), source: s }),
  searchAlbum: async () => ({ albums: [], total: 0 }),
  searchSinger: async () => ({ singers: [], total: 0 }),
  getSingerSongs: async () => [],
  getSingerAlbums: async () => ({ albums: [], total: 0 }),
  getAlbumSongs: async () => [],
  getSongByLink: async () => ({ song: null, link: null }),
  // 无 musicAPI 时的开发兜底：平台清单为空 → 渲染层走内置兜底表（utils.js）
  getPlatforms: async () => [],
  getDownloadUrl: async () => ({ url: '' }),
  getDownloadUrlSmart: async () => ({ url: '' }),
  getLyrics: async () => ({ lrc: '' }),
  addToQueue: async (s) => { showToast(t('toast.queueAdded', { title: s.title }), 'info'); return { queued: true, taskId: 'mock-' + Date.now() }; },
  cancelDownload: () => {},
  retryDownload: async () => ({ ok: true }),
  removeQueueItem: async () => ({ removed: true }),
  reorderQueueItem: async () => ({ ok: true }),
  clearFinishedQueue: async () => ({ removed: 0 }),
  clearAllQueue: async () => ({ removed: 0 }),
  selectDir: async () => null,
  getDefaultDir: async () => 'C:\\Music',
  getPref: async () => null,
  setPref: async () => {},
  openFolder: () => {},
  openExternal: () => {},
  windowMinimize: () => {},
  windowMaximize: () => {},
  windowClose: () => window.close(),
  onQueueUpdated: () => {},
  onQueuePausedChanged: () => {},
  onLocalLibraryChanged: () => {},
  setQueuePaused: async () => ({ ok: true, paused: false }),
  systemPower: async () => ({ ok: true }),
  probeAudio: async () => ({ error: '开发模式不支持实测' }),
  onDownloadProgress: () => {},
  onDownloadError: () => {},
  onLocalLrcFetched: () => {},
  removeAllListeners: () => {},
  getCookies: async () => ({}),
  saveCookie: async () => ({ saved: true }),
  clearCookie: async () => ({ cleared: true }),
  verifyCookie: async () => ({ valid: false }),
  openLoginWindow: async () => ({ success: false, error: '开发模式不支持一键登录' }),
  scanLocalLibrary: async () => ({ songs: mockLocalSongs(), count: 3 }),
  loadLibraryIndex: async () => ({ songs: mockLocalSongs(), dirPath: '', lastScan: 0 }),
  readLocalMetadata: async () => ({}),
  readLocalLrc: async () => ({ lrc: '' }),
  updateId3Tags: async () => ({ success: true }),
  updateId3Cover: async () => ({ success: true }),
  fetchOnlineCover: async () => ({ success: false, error: '开发模式不支持在线封面' }),
  getHomeRecommendations: async () => ({
    netease: {
      tops: Array.from({length: 8}, (_, i) => ({ id: String(i+1), title: `示例歌曲 ${i+1}`, artist: '示例歌手', album: '示例专辑', cover: '', duration: 240000, source: 'netease' })),
      playlists: Array.from({length: 4}, (_, i) => ({ id: String(i+1), name: `推荐歌单 ${i+1}`, cover: '', playCount: 10000, source: 'netease' })),
    },
    qq: { playlists: Array.from({length: 4}, (_, i) => ({ id: String(i+1), name: `QQ歌单 ${i+1}`, cover: '', playCount: 20000, source: 'qq' })) },
  }),
  getPlaylistSongs: async () => Array.from({length: 5}, (_, i) => ({ id: String(i+1), title: `歌单歌曲 ${i+1}`, artist: '歌手', album: '专辑', cover: '', duration: 200000, source: 'netease' })),
  getHomeSection: async () => ({ ok: true, data: [] }),
  addPlaylistToQueue: async () => ({ queued: 0, skipped: 0 }),
  // 订阅更新
  subscribeList: async () => [],
  subscribeAdd: async (t, p, id, name) => ({ success: true, entry: { key: `${t}:${p}:${id}`, type: t, platform: p, targetId: String(id), name: name || '' } }),
  subscribeRemove: async () => ({ success: true }),
  subscribeUpdate: async () => ({ success: true }),
  subscribeCheck: async () => ({ checked: 0, newTotal: 0 }),
  subscribeMarkSeen: async () => ({ success: true }),
  onSubscriptionsUpdated: () => {},
  onClipboardLink: () => {},
  proxyPlay: async () => ({ fileUrl: '' }),
  queryHistory: async () => ({ items: [], total: 0 }),
  getHistoryStats: async () => ({ total: 0, done: 0, error: 0 }),
  clearHistory: async () => true,
  getCacheSize: async () => '0 B',
  clearPlayCache: async () => ({ cleared: true }),
  batchFetchLyrics: async () => [],
  writeLocalLrc: async () => ({ success: true }),
  checkLocalExists: async () => [],
  savePlayQueue: async () => ({ ok: true }),
  loadPlayQueue: async () => ({ queue: [] }),
  convertAudio: async (opts) => ({ success: false, error: '开发模式不支持转码（需要 ffmpeg）', format: opts && opts.outputFormat }),
  cancelConvertAudio: async () => ({ success: true }),
  onConvertAudioProgress: () => {},
  onPlayQueueRestored: () => {},
  checkForUpdate: async () => ({ success: true }),
  restartAndInstall: () => {},
};

// 优先使用 preload 暴露的真实 musicAPI，否则回退 mock
// 注意：const api 在模块加载时 window.musicAPI 可能还未就绪（ESM 加载顺序问题）
// 所以用 let，在 init() 开头再确认一次
// 用 Object.assign 合并：真实 musicAPI 的方法优先；仅浏览器预览环境缺失的方法回退 mock
function buildApi() {
  const real = (typeof window.musicAPI !== 'undefined' && window.musicAPI) ? window.musicAPI : null;
  // mock 只服务于纯浏览器预览（vite http）场景；打包/Electron 是 file://，
  // 桥接缺失时必须明确失败（checkAPI 会提示"音乐API未加载"），
  // 绝不允许静默假成功（审计发现：mock 兜底让 preload 故障整体隐身）
  const allowMock = location.protocol.startsWith('http');
  const merged = allowMock ? Object.assign({}, mockApi, real || {}) : Object.assign({}, real || {});
  if (real) {
    logger.warn('[app.js] buildApi: 使用 REAL musicAPI, 方法数 =', Object.keys(merged).length);
  } else if (allowMock) {
    logger.warn('[app.js] buildApi: musicAPI undefined（浏览器预览，使用 mockApi）');
  } else {
    logger.error('[app.js] buildApi: musicAPI undefined 且非预览环境，桥接加载失败');
  }
  return merged;
}
let api = buildApi();

/** mock 用的来源 id：优先主进程下发的清单，缺失时用 utils.js 的兜底表 */
function _mockSrcIds() {
  const ids = getPlatforms().map(p => p.id);
  return ids.length ? ids : fallbackPlatformIds();
}

// Mock 数据生成
function mockSongs(k, s) {
  return Array.from({ length: 10 }, (_, i) => ({
    id: String(i + 1),
    title: `${k || '示例歌曲'} ${i + 1}`,
    artist: ['周杰伦', '林俊杰', '薛之谦', '邓紫棋', '张杰'][i % 5],
    album: ['专辑A', '专辑B', '专辑C'][i % 3],
    cover: '',
    duration: (3 + i * 0.5) * 60000,
    // 「全部」聚合搜索时给结果轮流打上来源标记。
    // 不再写死 ['netease','qq','bilibili']：优先用主进程清单，缺失时用 utils.js
    // 的兜底表 —— 平台 id 的字面量清单全仓只允许存在于 utils.js 一处。
    source: s === 'all' ? _mockSrcIds()[i % _mockSrcIds().length] : s,
  }));
}

function mockLocalSongs() {
  return [
    { id: 'local1', title: '示例本地歌曲 1', artist: '本地艺术家 A', album: '本地专辑 A', filePath: 'C:\\Music\\song1.mp3', ext: 'mp3', size: 5242880, duration: 240000 },
    { id: 'local2', title: '示例本地歌曲 2', artist: '本地艺术家 B', album: '本地专辑 B', filePath: 'C:\\Music\\song2.flac', ext: 'flac', size: 31457280, duration: 315000 },
    { id: 'local3', title: '示例本地歌曲 3', artist: '本地艺术家 C', album: '本地专辑 C', filePath: 'C:\\Music\\song3.wav', ext: 'wav', size: 52428800, duration: 280000 },
  ];
}

// ── 音频元素（模块级，init 绑定事件后以实参传给 player-sync.js）──
let _audio = null;
// 25s 加载超时守卫状态（事件绑定区使用）
let _loadWatchSince = 0;
let _loadWatchTimer = null;

// ── 初始化 ─────────────────────────────────────────────
async function init() {
  // 如果 init 时 window.musicAPI 还没就绪（理论上 preload 已先执行），动态覆盖
  api = buildApi();
  // 订阅事件接线：视图模块 import 期拿不到 api，只能在 buildApi 之后
  if (typeof wireSubscriptionEvents === 'function') wireSubscriptionEvents();
  if (typeof wireClipboardEvents === 'function') wireClipboardEvents();
  // 启动即拉一次订阅列表：导航红点不依赖用户先访问订阅页
  if (typeof loadSubscriptions === 'function') loadSubscriptions();
  // 首启动新手引导（prefs.welcomeSeen 已设则静默跳过）
  if (typeof maybeShowWelcome === 'function') maybeShowWelcome();

  // 用 setTimeout(0) 确保不阻塞渲染管线
  await new Promise(r => setTimeout(r, 0));

  // 调试：定位 init 哪一步抛错
  try {
    // 无相互依赖的启动 IPC 并发拉取：弱机上首屏不再被十几次
    // 串行 round-trip 拖慢。下面的消费顺序保持不变。
    const [savedSaveDir, savedQuality, savedTheme, savedTemplate, savedLocalDir] =
      await Promise.all([
        api.getPref('saveDir'),
        api.getPref('quality').catch(() => null),
        api.getPref('theme').catch(() => null),
        api.getPref('namingTemplate'),
        api.getPref('localDirPath'),
      ]);

    if (savedSaveDir) setState('saveDir', savedSaveDir);
    // 未设置过下载目录时显示主进程默认目录（音乐\MusicDownloader），
    // 避免首页路径栏空白让用户误以为必须手动选目录
    document.getElementById('saveDirText').textContent = getState('saveDir') || (await api.getDefaultDir()) || '';

    // 恢复音质选择（此前仅设置页变更时同步，启动时从未恢复）
    if (savedQuality) {
      const qs = document.getElementById('qualitySelect');
      if (qs) qs.value = savedQuality;
    }

    // 恢复主题（尽早应用，避免闪烁）
    if (savedTheme && typeof applyTheme === 'function') applyTheme(savedTheme);

    // 平台清单（v3）：源下拉 / 平台名 / 徽标配色的唯一来源，来自主进程 registry。
    // ⚠️ 必须在 applyTranslations() **之前** —— 本步会重建源下拉 DOM，
    //    若放在之后，新插入的「全部」选项拿不到翻译（设计稿 §4.4 的顺序陷阱）。
    try {
      const platforms = await api.getPlatforms();
      setPlatforms(platforms);
      renderSourceSelect(platforms);
    } catch (_e) {
      logger.warn('[init] 获取平台清单失败，降级到内置兜底表:', _e && _e.message);
      renderSourceSelect(getPlatforms());
    }

    // 加载语言包并应用翻译（applyTranslations 内部自会读一次 language pref）
    try {
      if (window.i18n) await window.i18n.applyTranslations();
    } catch (_e) { /* 忽略 */ }

    // 显示版本号 + commit（与上面 prefs 已并发，此处只消费结果）
    try {
      const versionEl = document.getElementById('appVersion');
      const commitEl = document.getElementById('appCommit');
      const ver = await api.getVersion();
      if (versionEl) versionEl.textContent = ver;
      if (window.__APP_COMMIT__ && commitEl) {
        commitEl.textContent = 'commit ' + window.__APP_COMMIT__.slice(0, 7);
      }
    } catch (_e) { /* 忽略 */ }

    // 恢复命名模板（编辑入口在设置页，这里只同步 state）
    if (savedTemplate) {
      setState('namingTemplate', savedTemplate);
    }

    if (savedLocalDir) setState('localDirPath', savedLocalDir);

    api.onQueueUpdated((queue) => {
      state.set('queueSnapshot', queue);
      renderQueue(queue);
      dlObserveQueue(queue); // 下载状态徽标：吸收 done + 通知列表刷新
      if (typeof window.afterQueueObserve === 'function') window.afterQueueObserve(queue); // 完成后动作检测
      if (typeof window.autoLyricObserve === 'function') window.autoLyricObserve(queue); // 自动补歌词存 .lrc（autoLyric 开关）
      if (typeof window.autoCoverObserve === 'function') window.autoCoverObserve(queue); // 自动嵌封面（autoCover 开关，探测不覆写）
      if (typeof window.firstDownloadCelebrateObserve === 'function') window.firstDownloadCelebrateObserve(queue); // 首次下载成功一次性庆祝引导
    });

    // 托盘切换暂停 → 同步下载页按钮（views/download.js 提供 UI 钩子）
    if (typeof api.onQueuePausedChanged === 'function') {
      api.onQueuePausedChanged((payload) => {
        if (typeof window.applyQueuePausedUi === 'function') {
          window.applyQueuePausedUi(!!(payload && payload.paused));
        }
      });
    }

    // 本地曲库目录变动（主进程 fs.watch 防抖推送）→ 静默增量重扫
    if (typeof api.onLocalLibraryChanged === 'function') {
      api.onLocalLibraryChanged(() => {
        if (typeof window.refreshLocalLibrary === 'function') {
          window.refreshLocalLibrary();
        }
      });
    }

    api.onDownloadProgress((info) => {
      const { id, progress } = info || {};
      const el = document.getElementById('prog-' + id);
      if (el) el.style.width = progress + '%';
      const meta = document.getElementById('progmeta-' + id);
      if (meta && typeof dlProgressText === 'function') meta.textContent = dlProgressText(info);
      if (typeof window.recordDlProgress === 'function') window.recordDlProgress(info);
    });

    api.onDownloadError(({ title, error, fatal }) => {
      showDownloadError(title, error, fatal, t);
    });

  api.onLocalLrcFetched(({ filePath, lrc, source }) => {
    if (filePath !== getState('_currentLocalFilePath')) return;
    if (lrc && lrc.trim()) {
      parseLrc(lrc);
      showToast(t('toast.lyricFetched'), 'success', 2200);
    } else {
      showNoLyrics();
      if (source === 'error') showToast(t('toast.lyricFetchError'), 'error', 2500);
      else showToast(t('toast.lyricNotFound'), 'info', 2000);
    }
  });

  // 音频事件（独立 try-catch，不被前面的 getPref 失败影响）
  try {
    _audio = document.getElementById('audioPlayer');
    if (_audio) {
      // timeupdate 只注册一次：同时驱动进度条和迷你播放器同步
      // （此前注册了两个 timeupdate，updateProgress 每帧跑两遍）
      _audio.addEventListener('timeupdate', () => {
        updateProgress();
        syncToMiniPlayer(_audio);
        syncToDesktopLyric(_audio);
      });
      _audio.addEventListener('ended', onAudioEnded);
      // 音源加载/解码出错（URL 失效、代理文件损坏）：toast + 跳下一曲，避免静默卡死。
      // 文案按行来源分流：本地文件被移走时不能说"音源出错"，那会把人支去查网络。
      _audio.addEventListener('error', () => {
        const cur = getState('currentPlaying');
        if (!cur || !_audio.error) return;
        const e = describePlayError(cur, _audio.error.code);
        // 本地文件行播不出来 = 盘和记录的引用断了，就地给一口「⬇ 重新下载」，
        // 不必让人翻到下载历史页去找那一行。判据（哪些行真有源可下）在 playError.js。
        const retry = playFailureRetry(cur, _audio.error.code);
        if (retry) {
          showActionToast({
            text: playFailureRetryText(cur), btnLabel: t('toast.redownloadBtn'), ttl: 9000, onConfirm: () => retryAfterPlayFailure(retry),
          });
        } else {
          showToast(e.text, e.kind, e.local ? 5500 : 3000);
        }
        if (typeof window.nextSong === 'function') window.nextSong();
      });
      // 25s 加载超时守卫（借鉴 lx usePlayEvent）：一直没等到可播数据则跳下一曲，
      // 避免 CDN 半开连接导致播放器永久卡死
      _loadWatchTimer = setInterval(() => {
        const cur = getState('currentPlaying');
        const isStuck = cur && _audio.readyState < 2 && !_audio.paused;
        if (isStuck) {
          const now = Date.now();
          if (!_loadWatchSince) _loadWatchSince = now;
          if (now - _loadWatchSince > 25000) {
            _loadWatchSince = 0;
            showToast(t('toast.streamTimeout'), 'warn', 3000);
            if (typeof window.nextSong === 'function') window.nextSong();
          }
        } else {
          _loadWatchSince = 0;
        }
      }, 1000);
      // 页面卸载时停掉守卫定时器，避免遗留 interval
      window.addEventListener('beforeunload', () => {
        if (_loadWatchTimer) clearInterval(_loadWatchTimer);
      });
      _audio.addEventListener('playing', () => { _loadWatchSince = 0; });
      _audio.addEventListener('pause', () => { _loadWatchSince = 0; });
      _audio.addEventListener('pause', () => {
        const icon = document.getElementById('btnPlayIcon');
        if (icon) icon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
        document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'false');
        document.getElementById('btnPlay')?.classList.remove('buffering');
        document.getElementById('playerCard')?.classList.remove('playing');
        // 暂停姿态：明确表达"是暂停不是卡死"（封面降饱和 + ⏸ 角标）
        if (getState('currentPlaying')) document.getElementById('playerCard')?.classList.add('paused');
        // 状态文案统一按 audio 真实状态推导（不再用 currentPlaying 当判据，
        // 换歌时它可能仍指向旧歌 → 误显示「已暂停」）
        if (typeof refreshPlayerState === 'function') refreshPlayerState();
        if (typeof stopSpectrum === 'function') stopSpectrum();
        syncToMiniPlayer(_audio);
        syncToTray(_audio);
      });
      _audio.addEventListener('play', () => {
        const icon = document.getElementById('btnPlayIcon');
        if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';
        document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'true');
        document.getElementById('playerCard')?.classList.remove('paused');
        document.getElementById('playerCard')?.classList.add('playing');
        if (typeof refreshPlayerState === 'function') refreshPlayerState();
        if (typeof startSpectrum === 'function') startSpectrum();
        syncToMiniPlayer(_audio);
        syncToTray(_audio);
      });
      // 缓冲反馈：waiting/stalled → 播放按钮转圈呼吸；playing/canplay → 恢复
      // （此前缓冲与暂停视觉上无法区分，用户分不清"正在缓冲"还是"出错"）
      _audio.addEventListener('waiting', () => {
        if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
      });
      _audio.addEventListener('stalled', () => {
        if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
      });
      _audio.addEventListener('playing', () => {
        document.getElementById('btnPlay')?.classList.remove('buffering');
      });
      _audio.addEventListener('canplay', () => {
        document.getElementById('btnPlay')?.classList.remove('buffering');
      });
      _audio.addEventListener('loadedmetadata', () => {
        document.getElementById('timeTotal').textContent = fmtTime(_audio.duration);
      });
    } else {
      // audio 元素不存在，跳过
    }
  } catch (e) {
    logger.warn('[init] 音频事件绑定失败:', e.message);
  }

  // ── 迷你播放器 IPC 监听 ──────────────────────────────
  if (typeof api.openMiniPlayer === 'function') {
    api.onMiniTogglePlay(() => { if (typeof togglePlay === 'function') togglePlay(); });
    api.onMiniNext(() => { if (typeof nextSong === 'function') nextSong(); });
    api.onMiniPrev(() => { if (typeof prevSong === 'function') prevSong(); });
    if (typeof api.onSyncMiniPlayer === 'function') {
      // 歌词窗口/迷你窗口刚打开时要全量状态：清换曲标记强制重推元信息。
      // （原实现直接传 syncToMiniPlayer，回调收不到 audio 参数被 !audio 短路，
      //  迷你窗口首帧永远空白，直到下一次 timeupdate）
      api.onSyncMiniPlayer(() => { resetMiniPlayerSong(); syncToMiniPlayer(_audio); });
    }
  }

  // ── 桌面歌词 IPC 监听（歌词窗口启动时来要一次全量状态）──
  if (typeof api.onSyncDesktopLyric === 'function') {
    api.onSyncDesktopLyric(() => {
      // 强制重推整份歌词（换歌标记重置）
      resetDesktopLyricSong();
      syncToDesktopLyric(_audio);
    });
  }

  // ── 系统托盘 IPC 监听 ──────────────────────────────
  if (typeof api.onTrayTogglePlay === 'function') {
    api.onTrayTogglePlay(() => { if (typeof togglePlay === 'function') togglePlay(); });
    api.onTrayPrev(() => { if (typeof prevSong === 'function') prevSong(); });
    api.onTrayNext(() => { if (typeof nextSong === 'function') nextSong(); });
  }

  // ── 系统级「正在播放」（Media Session：音量浮窗/锁屏曲目 + 媒体键 actionHandler）──
  try { initMediaSession(); } catch (e) { logger.warn('[init] mediaSession 初始化失败:', e.message); }

  // ── 应用菜单 IPC 监听（主进程菜单项经 webContents.send 下发）──
  // 此前渲染层从未注册这两个监听：菜单的「聚焦搜索」「定时停止」是断链的。
  if (window.ipcRenderer && typeof window.ipcRenderer.on === 'function') {
    window.ipcRenderer.on('focus-search', () => {
      const el = document.getElementById('searchInput');
      if (el) { el.focus(); el.select?.(); }
    });
    window.ipcRenderer.on('sleep-timer', (minutes) => {
      if (typeof window.setSleepTimer === 'function') window.setSleepTimer(minutes);
    });
  }

  // ── 播放状态外发同步 / 队列恢复 ──────────────────────
  // 这四个函数已外提到 player-sync.js（等价迁移）：它们原先定义在此处，
  // 仅被 init 调用、彼此互调，故可整体外提；_audio 改为显式传参。
  // 见 src/renderer/js/player-sync.js 与 test/player-sync.test.js。

  // 监听 playQueueRestored 事件（主进程启动时推送）
  api.onPlayQueueRestored((saved) => {
    restorePlayQueueFromSaved(sanitizeSavedQueue(saved));
  });

  // 订阅 playQueue 变化自动持久化
  state.subscribe('playQueue', (queue) => {
    if (Array.isArray(queue)) {
      const playIdx = getState('playIdx');
      const loopMode = getState('loopMode');
      const isShuffled = getState('isShuffled');
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[playQueue] 保存失败:', e));
    }
  });

  // 订阅 playIdx 变化自动持久化
  state.subscribe('playIdx', (playIdx) => {
    const queue = getState('playQueue');
    const loopMode = getState('loopMode');
    const isShuffled = getState('isShuffled');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[playIdx] 保存失败:', e));
    }
  });

  // 订阅 loopMode 变化自动持久化
  state.subscribe('loopMode', (loopMode) => {
    const queue = getState('playQueue');
    const playIdx = getState('playIdx');
    const isShuffled = getState('isShuffled');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[loopMode] 保存失败:', e));
    }
  });

  // 订阅 isShuffled 变化自动持久化
  state.subscribe('isShuffled', (isShuffled) => {
    const queue = getState('playQueue');
    const playIdx = getState('playIdx');
    const loopMode = getState('loopMode');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[isShuffled] 保存失败:', e));
    }
  });

  // 加载已持久化的播放队列（兜底）
  try {
    const saved = await api.loadPlayQueue();
    restorePlayQueueFromSaved(sanitizeSavedQueue(saved));
  } catch (e) {
    logger.warn('[init] 加载播放队列失败:', e.message);
  }

  // 加载首页推荐（失败不阻断主流程）
  loadHomeRecommendations().catch(e => logger.warn('首页推荐加载失败:', e.message));

  // 首页统计概览（本地曲库/已下载/累计收听/最常播放）
  if (typeof window.loadHomeStats === 'function') {
    window.loadHomeStats();
  }

  // 启动时从 prefs 恢复最近播放记录（此前无人调用，刷新后清零）
  if (typeof window.loadRecentlyPlayed === 'function') {
    window.loadRecentlyPlayed()
      .then(() => { if (typeof window.renderRecentlyPlayed === 'function') window.renderRecentlyPlayed(); })
      .catch(e => logger.warn('[init] 最近播放恢复失败:', e.message));
  }

  // 焦点到搜索框
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.focus();

  showToast(t('toast.initComplete'), 'success', 1500);
  } catch (e) {
    logger.error('[init] FATAL:', e);
    if (typeof showToast === 'function') {
      showToast(t('toast.initFailed', { msg: errBrief(e) }), 'error', 8000);
    }
    throw e;
  }
}

// ── 页面切换 ───────────────────────────────────────────
// 导航条目合并后（160 分组 → 164 合一），部分"页面路由"没有自己的侧栏按钮：
// search 是「搜歌」入口的第二个视图、history 是「下载」页的历史子 tab。
// 高亮归属集中在 NAV_ALIAS 一处映射（默认值只许有一个家），
// 调用方一律 switchTab(tab) 即可，不再各自摸 .nav-item[data-tab=...] 是否存在。
const NAV_ALIAS = { search: 'home', history: 'download' };
// 3-B：聚合视图首次进入才拉数据，避免反复切页反复打 IPC
let _aggLoaded = false;

// 「用户当前看着哪个视图」的唯一真相源：switchTab 用行内 display 控制显隐，
// 隐藏页 style 已写上 none，未访问过的初始态由 index.html 行内样式给出。
// 键盘在场探针（搜索列表导航 / 首页方向键切平台）必须问它，
// 不再问 .nav-item.active —— 164 合并入口后高亮归属只有「搜歌」一个。
function isTabPageVisible(id) {
  const el = document.getElementById(id);
  return !!(el && el.style.display !== 'none');
}

function switchTab(tab, btn) {
  // 总开关守卫必须在下面任何 display/classList 之前：写在末尾等于先把页面渲染完再拦。
  // 四条通路（侧栏 onclick、命令面板 _goto、快捷键、程序化调用）都汇到这个漏斗，只拦这一处就够。
  if (!tabAllowed(tab)) {
    if (tab !== 'home') { switchTab('home'); return; }
    return;
  }
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // btn 缺省时按 data-tab 兜底（程序化/CDP 调用不传事件按钮），找不到不阻断切换
  const navBtn = btn || document.querySelector(`.nav-item[data-tab="${NAV_ALIAS[tab] || tab}"]`);
  if (navBtn) navBtn.classList.add('active');

  const homePage = document.getElementById('homePage');
  const searchPage = document.getElementById('searchPage');
  const downloadPage = document.getElementById('downloadPage');
  const localPage = document.getElementById('localPage');
  const historyPage = document.getElementById('historyPage');
  const aiMusicPage = document.getElementById('aiMusicPage');
  const converterPage = document.getElementById('converterPage');
  const playlistPage = document.getElementById('playlistPage');
  const subscriptionPage = document.getElementById('subscriptionPage');
  const aggregatePage = document.getElementById('aggregatePage');

  homePage.style.display = 'none';
  searchPage.style.display = 'none';
  downloadPage.style.display = 'none';
  localPage.classList.remove('active');
  // historyPage 已并入 downloadPage 作为子页，路由上 'history' 视为 'download' 的历史子 tab
  if (historyPage) historyPage.style.display = 'none';
  if (aiMusicPage) aiMusicPage.style.display = 'none';
  if (converterPage) converterPage.style.display = 'none';
  if (playlistPage) playlistPage.style.display = 'none';
  if (subscriptionPage) subscriptionPage.style.display = 'none';
  if (aggregatePage) aggregatePage.style.display = 'none';

  if (tab === 'home') {
    homePage.style.display = 'flex';
    if (!getState('homeRecommendations')) loadHomeRecommendations();
  } else if (tab === 'search') {
    searchPage.style.display = 'flex';
  } else if (tab === 'download' || tab === 'history') {
    downloadPage.style.display = 'flex';
    // 合并页：download → 队列子页；history → 历史子页（Ctrl+H 等旧入口兼容）
    switchDlSubTab(tab === 'history' ? 'history' : 'queue');
  } else if (tab === 'local') {
    localPage.classList.add('active');
    const localSongs = getState('localSongs');
    if (!localSongs || !localSongs.length) scanLocalDir();
  } else if (tab === 'playlist') {
    if (playlistPage) {
      playlistPage.style.display = 'flex';
      if (typeof initPlaylistView === 'function') initPlaylistView();
    }
  } else if (tab === 'subscription') {
    if (subscriptionPage) {
      subscriptionPage.style.display = 'flex';
  } else if (tab === 'aggregate' && aggregatePage) {
    aggregatePage.style.display = 'flex';
    // 首次进入才拉数据：反复切页不该反复打 IPC
    if (!_aggLoaded) { _aggLoaded = true; loadAggregated(); }
      if (typeof initSubscriptionView === 'function') initSubscriptionView();
    }
  } else if (tab === 'ai-music') {
    if (aiMusicPage) {
      aiMusicPage.style.display = 'flex';
      if (typeof initAiMusic === 'function') initAiMusic();
    }
  } else if (tab === 'converter') {
    if (converterPage) {
      converterPage.style.display = 'flex';
      if (typeof initConverter === 'function') initConverter();
    }
  }
}

// ── 下载页子 tab（下载队列 / 下载历史 合并页）────────
function switchDlSubTab(sub) {
  const queuePane = document.getElementById('dlQueuePane');
  const historyPane = document.getElementById('historyPage');
  const tabQueue = document.getElementById('dlSubTabQueue');
  const tabHistory = document.getElementById('dlSubTabHistory');
  if (!queuePane || !historyPane) return;
  const showHistory = sub === 'history';
  queuePane.style.display = showHistory ? 'none' : 'flex';
  historyPane.style.display = showHistory ? 'flex' : 'none';
  if (tabQueue) tabQueue.classList.toggle('active', !showHistory);
  if (tabHistory) tabHistory.classList.toggle('active', showHistory);
  // 历史子页首开时拉数据；回队列子页无需刷新（renderQueue 由事件驱动）
  if (showHistory && typeof loadHistory === 'function') loadHistory();
}

async function changeSaveDir() {
  const d = await api.selectDir();
  if (d) {
    setState('saveDir', d);
    document.getElementById('saveDirText').textContent = d;
    await api.setPref('saveDir', d);
  }
}

// ── 命名模板 ──────────────────────────────────────────
// 编辑入口在设置页（settingFilenameTmpl）；此函数保留供设置页保存路径使用
async function saveNamingTemplate(template) {
  await api.setPref('namingTemplate', template);
  setState('namingTemplate', template);
}

// ── 歌单弹层 ──────────────────────────────────────────
/**
 * 「取不到曲目」的统一口径：取数前判一次档（确定不支持的平台连请求都不发），
 * 取回空数组后复用同一次判档的文案。判据的家在 listAccess.js，这里只接线。
 */
function listAccessFor(platformId, capability, subjectKey, subjectFallback) {
  const subject = term(t, subjectKey, subjectFallback);
  return listAccessHint(getPlatforms().find(x => x && x.id === platformId), {
    capability, subject, name: platformName(platformId), tr: t,
  });
}

function showListEmpty(body, text) {
  body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">'
    + esc(text) + '</div>';
}

async function openPlaylistModal(platform, id, name) {
  document.getElementById('playlistModalTitle').textContent = '📀 ' + name;
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  const hint = listAccessFor(platform, 'playlistSongs', 'modal.subjectPlaylist', '歌单');
  if (!hint.fetch) {
    showListEmpty(body, hint.text);
    return;
  }
  body.innerHTML = skeletonHtml('song', SKEL_ROWS, '加载中...');

  state.setPlaylistMeta({ platform, id, name });
  state.setPlaylistSongs([]);

  try {
    const songs = await api.getPlaylistSongs(platform, id, 200);
    if (!songs.length) {
      showListEmpty(body, hint.text);
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);

    // 后台检测本地已下载
    const saveDir = getState('saveDir');
    if (saveDir) {
      api.checkLocalExists({
        saveDir,
        items: songs.map(s => ({ title: s.title, artist: s.artist })),
      }).then(results => {
        if (!Array.isArray(results)) return;
        const existsMap = state.getPlaylistLocalExists();
        for (const r of results) {
          const idx = songs.findIndex(s =>
            (s.title || '').trim() === (r.title || '').trim() &&
            (s.artist || '').trim() === (r.artist || '').trim()
          );
          if (idx >= 0) existsMap.set(idx, r.exists);
        }
        const info = document.getElementById('plToolbarInfo');
        if (info) updatePlToolbarInfo();
      }).catch(e => logger.warn('检测本地已下载失败:', e.message));
    }
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:16px;text-align:center;">加载失败: ' + esc(errBrief(e)) + '</div>';
  }
}

function closePlaylistModal() {
  document.getElementById('playlistModal').classList.add('hidden');
  state.setPlaylistChecked(new Set());
  state.setPlaylistLocalExists(new Map());
}

function closePlaylistModalOnBg(e) {
  if (e.target === document.getElementById('playlistModal')) closePlaylistModal();
}

// ── 歌单弹层渲染 ──────────────────────────────────────
function renderPlaylistModal(songs) {
  const body = document.getElementById('playlistModalBody');
  const checkedCount = state.getPlaylistChecked().size;
  const localCount = Array.from(state.getPlaylistLocalExists().values()).filter(Boolean).length;
  const dlQueue = getState('queueSnapshot') || [];
  dlEnsureHistoryLoaded(); // 跨会话"已下载"懒回填，加载完成后经监听器重渲染

  const toolbar = `
    <div class="pl-toolbar">
      <label class="pl-toolbar-item">
        <input type="checkbox" id="plSelectAll" ${checkedCount === songs.length && songs.length > 0 ? 'checked' : ''} onchange="toggleSelectAll(this.checked)">
        <span>全选</span>
      </label>
      <span class="pl-toolbar-info" id="plToolbarInfo">已选 ${checkedCount} / ${songs.length}，本地已存在 ${localCount}</span>
      <div class="pl-toolbar-actions">
        <button class="btn-sm" onclick="playPlaylistModalAll()">▶ 播放全部</button>
        <button class="btn-sm" onclick="invertSelection()">反选</button>
        <button class="btn-sm" id="plSubscribeBtn" title="新歌发布时提醒我" onclick="subscribeCurrentPlaylist()">📡 订阅</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(false)">加入队列</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(true)">仅未下载</button>
        <button class="btn-sm" title="把勾选的歌新建为「我的歌单」（在线引用，不下载）" onclick="savePlModalAsPlaylist()">📥 存为歌单</button>
        <button class="btn-sm" title="把勾选的歌加入某个已有歌单（引擎端自动去重）" onclick="addPlModalToPlaylist()">➕ 加进歌单</button>
      </div>
    </div>
  `;

  const list = songs.map((s, i) => {
    const localExists = state.getPlaylistLocalExists().get(i) === true;
    const isChecked = state.getPlaylistChecked().has(i);
    return `
    <div class="top-song-row pl-row ${localExists ? 'pl-row-exists' : ''}" data-idx="${i}">
      <input type="checkbox" class="pl-checkbox" data-idx="${i}" ${isChecked ? 'checked' : ''} onchange="toggleSongCheck(${i}, this.checked)">
      <span class="top-song-rank">${i + 1}</span>
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)} ${localExists ? '<span class="pl-tag-local">本地</span>' : ''}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      <span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>
      ${dlBadgeHtml(s, dlQueue)}
      <button class="top-song-action" title="播放" onclick="event.stopPropagation();playPlaylistModalSong(${i})">▶</button>
      ${heartBtnHtml(s, 'top-song-action')}
      <button class="top-song-action" title="下载" onclick="event.stopPropagation();addSingleToQueue(${i})">⬇</button>
    </div>
  `;
  }).join('');

  body.innerHTML = toolbar + list;
  updatePlToolbarInfo();
}

// ── 弹层整单连播 ──────────────────────────────────────
// 语义对齐 playlist.js 的 playPlaylistSong：智能取流换源回写 _altSource、
// proxyPlay 本地化流量、整单进 playQueue 从点击曲连播（而非孤播一首）。
// 请求序号做竞态守卫，快速连点只认最后一次。
let _plModalPlayRequestId = 0;
async function playPlaylistModalSong(idx) {
  const songs = state.getPlaylistSongs();
  const song = songs[idx];
  if (!song) { showToast(t('toast.songNotFound'), 'warn'); return; }
  const quality = resolveQuality(song.source);
  showToast(t('toast.preparingSource', { title: song.title }), 'info');
  const reqId = ++_plModalPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== _plModalPlayRequestId) return;
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast(t('toast.vipRequired'), 'warn', 5000);
      } else {
        showToast(t('toast.noSource'), 'warn', 5000);
      }
      return;
    }
    const notice = buildFallbackNotice(result, song.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    song._playedQuality = quality;
    const playSource = result.source || song.source;
    const referer = playReferer(playSource, result);
    const proxied = await api.proxyPlay(result.url, referer, {
      id: String(result.id ?? song.id),
      source: playSource,
      quality,
    });
    if (reqId !== _plModalPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast(t('toast.sourceFailed'), 'error', 5000);
      return;
    }
    setState('playQueue', songs.slice());
    setState('playIdx', idx);
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
    showToast(t('toast.nowPlaying', { title: song.title }), 'success', 2500);
  } catch (e) {
    if (reqId === _plModalPlayRequestId) {
      logger.warn('弹层播放失败:', e);
      showToast(t('toast.playFailed', { msg: errBrief(e) }), 'error', 4000);
    }
  }
}

/** 「▶ 播放全部」：整单进队列从第一首连播 */
async function playPlaylistModalAll() {
  const songs = state.getPlaylistSongs();
  if (!songs.length) { showToast(t('toast.playlistEmpty'), 'warn'); return; }
  await playPlaylistModalSong(0);
}

// ── 弹层行右键菜单（业务项在 ./songMenu.js 共享）──────
document.addEventListener('contextmenu', (e) => {
  const body = document.getElementById('playlistModalBody');
  const row = e.target && e.target.closest ? e.target.closest('.pl-row') : null;
  if (!body || !row || !body.contains(row)) return;
  const idx = Number(row.getAttribute('data-idx'));
  const song = state.getPlaylistSongs()[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => playPlaylistModalSong(idx),
    download: () => addSingleToQueue(idx),
  });
});

// 弹层打开期间队列/历史变化 → 防抖重渲染徽标（勾选与本地检测结果均从 state 还原，不丢失）
let _plDlTimer = null;
addDlChangeListener(() => {
  const modal = document.getElementById('playlistModal');
  if (!modal || modal.classList.contains('hidden') || _plDlTimer) return;
  _plDlTimer = setTimeout(() => {
    _plDlTimer = null;
    const songs = state.getPlaylistSongs();
    if (songs.length) renderPlaylistModal(songs);
  }, 300);
});

function updatePlToolbarInfo() {
  const el = document.getElementById('plToolbarInfo');
  if (!el) return;
  const total = state.getPlaylistSongs().length;
  const checked = state.getPlaylistChecked().size;
  const localCount = Array.from(state.getPlaylistLocalExists().values()).filter(Boolean).length;
  el.textContent = `已选 ${checked} / ${total}，本地已存在 ${localCount}`;
}

function toggleSelectAll(checked) {
  const checkedSet = state.getPlaylistChecked();
  checkedSet.clear();
  if (checked) {
    for (let i = 0; i < state.getPlaylistSongs().length; i++) checkedSet.add(i);
  }
  document.querySelectorAll('#playlistModalBody .pl-checkbox').forEach(cb => { cb.checked = checked; });
  updatePlToolbarInfo();
}

function toggleSongCheck(idx, checked) {
  const checkedSet = state.getPlaylistChecked();
  if (checked) checkedSet.add(idx);
  else checkedSet.delete(idx);
  const all = document.getElementById('plSelectAll');
  if (all) all.checked = checkedSet.size === state.getPlaylistSongs().length;
  updatePlToolbarInfo();
}

function invertSelection() {
  const checkedSet = state.getPlaylistChecked();
  const songs = state.getPlaylistSongs();
  for (let i = 0; i < songs.length; i++) {
    if (checkedSet.has(i)) checkedSet.delete(i);
    else checkedSet.add(i);
  }
  document.querySelectorAll('#playlistModalBody .pl-checkbox').forEach((cb, idx) => {
    cb.checked = checkedSet.has(idx);
  });
  const all = document.getElementById('plSelectAll');
  if (all) all.checked = checkedSet.size === songs.length;
  updatePlToolbarInfo();
}

// 歌单来源歌曲的额外命名元数据，供 {trackNo}/{trackTotal}/{playlist} 模板变量取值
function playlistTaskMeta(idx) {
  const meta = state.getPlaylistMeta();
  const songs = state.getPlaylistSongs();
  return {
    playlistName: (meta && meta.name) || '',
    trackNo: idx + 1,
    trackTotal: songs.length,
  };
}

async function addSingleToQueue(idx) {
  const s = state.getPlaylistSongs()[idx];
  if (!s) return;
  try {
    const saveDir = getState('saveDir');
    const task = { ...s, ...playlistTaskMeta(idx), saveDir, quality: resolveQuality(s.source) };
    const r = await api.addToQueue(task);
    if (r && r.duplicated) {
      showToast(t('toast.queueDup', { title: s.title }), 'warn', 2500);
      return;
    }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(s.title, r.finishedAt, () => {
        api.addToQueue({ ...task, forceRedownload: true })
          .then(() => showToast(t('toast.queueAdded', { title: s.title }), 'success'))
          .catch(e => showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error'));
      });
      return;
    }
    showToast(t('toast.queueAdded', { title: s.title }), 'success');
  } catch (e) {
    showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error');
  }
}

async function addPlaylistToQueueClick(skipExisting) {
  const checkedSet = state.getPlaylistChecked();
  if (checkedSet.size === 0) {
    showToast(t('toast.pickDownloadFirst'), 'warn');
    return;
  }
  let toAdd = Array.from(checkedSet).sort((a, b) => a - b)
    .map(idx => ({ s: state.getPlaylistSongs()[idx], idx }))
    .filter(x => x.s);
  let skipped = 0;
  if (skipExisting) {
    const filtered = [];
    const existsMap = state.getPlaylistLocalExists();
    for (const { s, idx } of toAdd) {
      if (existsMap.get(idx) === true) skipped++;
      else filtered.push({ s, idx });
    }
    toAdd = filtered;
  }
  if (!toAdd.length) {
    showToast(t('toast.nothingToAdd'), 'info');
    return;
  }
  try {
    const saveDir = getState('saveDir');
    // 每首歌按自身平台解析：分平台模板优先，未定制的平台沿用搜索栏选择
    const payload = { songs: toAdd.map(({ s, idx }) => ({ ...s, ...playlistTaskMeta(idx), saveDir, quality: resolveQuality(s.source) })) };
    const r = await api.addPlaylistToQueue(payload);
    const dlSkipped = r && r.skippedDownloaded ? r.skippedDownloaded : 0;
    // 汇总串各段都是词条，段间分隔用语言中立的间隔号（括号与全角逗号是中文专属形状）
    const skippedParts = [];
    if (skipped) skippedParts.push(t('toast.skippedQueueDup', { count: skipped }));
    if (dlSkipped) skippedParts.push(t('toast.skippedDownloaded', { count: dlSkipped }));
    showToast(t('toast.batchQueued', {
      count: r.queued, extra: skippedParts.length ? ' · ' + skippedParts.join(' · ') : '',
    }), 'success');
    checkedSet.clear();
    renderPlaylistModal(state.getPlaylistSongs());
  } catch (e) {
    logger.error('[addPlaylistToQueue] 失败:', e);
    showToast(t('toast.batchAddFailed', { msg: errBrief(e) }), 'error');
  }
}

// ── 弹层勾选 → 我的歌单（plModalSave 纯函数的接线层）──────
async function savePlModalAsPlaylist() {
  const modal = document.getElementById('playlistModal');
  if (!modal || modal.classList.contains('hidden')) {
    showToast(t('toast.openModalFirst'), 'info');
    return;
  }
  const picked = pickCheckedSongs(state.getPlaylistSongs(), state.getPlaylistChecked());
  if (!picked.length) { showToast(t('toast.pickSaveFirst'), 'warn'); return; }
  const m = state.getPlaylistMeta() || {};
  const rows = toPlaylistRows(picked);
  const payload = buildSavedPlaylist(
    { name: m.name, src: typeof srcLabel === 'function' ? srcLabel(m.platform) : (m.platform || '平台') },
    rows
  );
  try {
    const r = await api.saveUserPlaylist(payload);
    if (r && r.success) {
      if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
      showToast(t('toast.playlistSaved', { name: payload.name, count: rows.length }), 'success', 3000);
    } else {
      showToast((r && r.error) || t('toast.saveFailed'), 'error');
    }
  } catch (e) {
    logger.error('[savePlModalAsPlaylist] 失败:', e);
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
}

function addPlModalToPlaylist() {
  const picked = pickCheckedSongs(state.getPlaylistSongs(), state.getPlaylistChecked());
  if (!picked.length) { showToast(t('toast.pickAddFirst'), 'warn'); return; }
  if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(toPlaylistRows(picked));
}

async function downloadSongFromList(s) {
  showToast(t('toast.fetchingLink', { title: s.title }), 'info', 2000);
  try {
    const result = await api.getDownloadUrl(s.id, s.source, 'standard');
    if (result && result.url) {
      showToast(t('toast.linkReady'), 'success', 4000);
      document.getElementById('searchInput').value = `${s.title} ${s.artist}`;
      switchTab('search');
    } else {
      showToast(t('toast.linkUnavailable'), 'warn', 3000);
    }
  } catch (e) {
    logger.warn('获取下载链接失败:', e);
    showToast(t('toast.linkFetchFailed'), 'warn', 3000);
  }
}

// ── 事件委托架设 ──────────────────────────────────────
(function setupPlaylistModalDelegate() {
  const body = document.getElementById('playlistModalBody');
  if (!body) return;
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="play-recommend"], [data-action="download-recommend"]');
    if (!btn) return;
    e.stopPropagation();
    const songs = state.getPlaylistSongs();
    const s = songs[Number(btn.dataset.idx)];
    if (!s) return;
    if (btn.dataset.action === 'play-recommend') playRecommendSong(s);
    else downloadSongFromList(s);
  });
})();

// ── 专辑详情（复用歌单弹窗）───────────────────────────
async function openAlbumView(albumMid, source, albumName) {
  document.getElementById('playlistModalTitle').textContent = '💿 ' + (albumName || '专辑');
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  const hint = listAccessFor(source || 'qq', 'albumSongs', 'modal.subjectAlbum', '专辑');
  if (!hint.fetch) {
    showListEmpty(body, hint.text);
    return;
  }
  body.innerHTML = skeletonHtml('song', SKEL_ROWS, '加载专辑中...');

  state.setPlaylistMeta({ platform: source, id: albumMid, name: albumName || '专辑' });
  state.setPlaylistSongs([]);

  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 200);
    if (!songs.length) {
      showListEmpty(body, hint.text);
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);

    const saveDir = getState('saveDir');
    if (saveDir) {
      api.checkLocalExists({
        saveDir,
        items: songs.map(s => ({ title: s.title, artist: s.artist })),
      }).then(results => {
        if (!Array.isArray(results)) return;
        const existsMap = state.getPlaylistLocalExists();
        for (const r of results) {
          const idx = songs.findIndex(s =>
            (s.title || '').trim() === (r.title || '').trim() &&
            (s.artist || '').trim() === (r.artist || '').trim()
          );
          if (idx >= 0) existsMap.set(idx, r.exists);
        }
        const info = document.getElementById('plToolbarInfo');
        if (info) updatePlToolbarInfo();
      }).catch(e => logger.warn('检测本地已下载失败:', e.message));
    }
  } catch (e) {
    body.innerHTML = `<div style="color:var(--accent);font-size:12px;padding:16px;text-align:center;">⚠️ 加载失败: ${esc(errBrief(e))}</div>`;
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  init,
  switchTab,
  switchDlSubTab,
  changeSaveDir,
  openPlaylistModal,
  closePlaylistModal,
  closePlaylistModalOnBg,
  renderPlaylistModal,
  updatePlToolbarInfo,
  toggleSelectAll,
  toggleSongCheck,
  invertSelection,
  addSingleToQueue,
  playPlaylistModalSong,
  playPlaylistModalAll,
  addPlaylistToQueueClick,
  downloadSongFromList,
  openAlbumView,
  api,
}

// ── 全局桥接（HTML onclick 兼容）─────────────────────
// 使用 getter 让 window.api 始终指向当前 api（可能已被真实 musicAPI 替换）
Object.defineProperty(window, 'api', {
  get() { return api; },
  configurable: true,
});
window.init = init;
window.loadAggregated = loadAggregated;
window.renderAggregated = renderAggregated;
window.onAggFilter = onAggFilter;
window.onAggKeyword = onAggKeyword;
window.getAggregatedState = getAggregatedState;
window.switchTab = switchTab;
window.isTabPageVisible = isTabPageVisible;
window.switchDlSubTab = switchDlSubTab;
window.changeSaveDir = changeSaveDir;
window.openPlaylistModal = openPlaylistModal;
window.closePlaylistModal = closePlaylistModal;
window.closePlaylistModalOnBg = closePlaylistModalOnBg;
window.renderPlaylistModal = renderPlaylistModal;
// 搜索页的专辑弹层与本页两个弹层共用同一个 playlistModal：判档与空态必须同一句口径
window.listAccessFor = listAccessFor;
window.showListEmpty = showListEmpty;
window.updatePlToolbarInfo = updatePlToolbarInfo;
window.toggleSelectAll = toggleSelectAll;
window.toggleSongCheck = toggleSongCheck;
window.invertSelection = invertSelection;
window.addSingleToQueue = addSingleToQueue;
window.playPlaylistModalSong = playPlaylistModalSong;
window.playPlaylistModalAll = playPlaylistModalAll;
window.addPlaylistToQueueClick = addPlaylistToQueueClick;
window.savePlModalAsPlaylist = savePlModalAsPlaylist;
window.addPlModalToPlaylist = addPlModalToPlaylist;
window.downloadSongFromList = downloadSongFromList;
window.openAlbumView = openAlbumView;
window.saveNamingTemplate = saveNamingTemplate;

// ── 播放队列面板 ────────────────────────────────────
let _pqVisible = false;
window.togglePlayQueue = () => {
  const panel = document.getElementById('pqPanel');
  const btn = document.getElementById('btnQueueToggle');
  const bar = document.getElementById('pcQueueBar');
  const chev = document.getElementById('pcQueueChev');
  if (!panel) return;
  _pqVisible = !_pqVisible;
  // 用 .open 类而非内联 display：过渡动画与 :has(.open) 的卡片让位都依赖它
  panel.classList.toggle('open', _pqVisible);
  panel.style.display = '';
  if (btn) btn.classList.toggle('active', _pqVisible);
  if (bar) bar.setAttribute('aria-expanded', String(_pqVisible));
  if (chev) chev.textContent = _pqVisible ? '收起' : '展开';
  renderPlayQueueUI();
};

// 🎯 队列面板定位正在播放：面板未开先展开；playIdx 漂移时退回全量匹配
function locatePlayingInQueue() {
  const queue = getState('playQueue') || [];
  const cur = getState('currentPlaying');
  const idx = resolvePlayingIndex(queue, cur, getState('playIdx') || 0);
  if (idx < 0) { showToast(t('toast.notInQueue'), 'info', 2500); return; }
  if (!_pqVisible) window.togglePlayQueue();
  const row = document.querySelector(`#pqList .pq-item[data-pqidx="${idx}"]`);
  if (row) flashRow(row);
}
window.locatePlayingInQueue = locatePlayingInQueue;

function renderPlayQueueUI() {
  const list = document.getElementById('pqList');
  const count = document.getElementById('pqCount');
  const badge = document.getElementById('pqBadge');
  const thumbs = document.getElementById('pcQueueThumbs');
  if (!list) return;
  const queue = getState('playQueue') || [];
  const playIdx = getState('playIdx') || 0;
  _syncPqSelBtns(); // 多选按钮计数/显隐跟着每次重绘走
  const NOTE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">'
    + '<path d="M9 19a3 3 0 1 1-2-2.83V7l10-2v7.17A3 3 0 1 0 19 15V3L7 5v12.17Z"/></svg>';
  if (queue.length === 0) {
    list.innerHTML = '<div class="pq-empty">'
      + '<div class="pq-empty-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">'
      + '<path d="M9 19a3 3 0 1 1-2-2.83V7l10-2v7.17A3 3 0 1 0 19 15V3L7 5v12.17Z"/></svg></div>'
      + '暂无播放歌曲<br><span class="pq-empty-hint">点击歌曲播放以添加</span></div>';
  } else {
    list.innerHTML = queue.map((s, i) => {
      const isCur = i === playIdx;
      const favS = queueFavSong(s);
      const cover = s.cover
        ? '<img class="pq-thumb" src="' + escAttr(s.cover) + '" alt="" loading="lazy" draggable="false">'
        : '<span class="pq-thumb-ph">' + NOTE_SVG + '</span>';
      const cb = _pqSelMode
        ? '<input type="checkbox" class="pq-sel-chk" ' + (_pqSel.has(s) ? 'checked ' : '')
          + 'onclick="event.stopPropagation();togglePqSel(' + i + ', event)" title="勾选后批量移出队列（Shift 连选）" style="width:14px;height:14px;flex-shrink:0;cursor:pointer;margin:0 4px 0 2px;">'
        : '';
      return '<div class="pq-item' + (isCur ? ' playing' : '') + '" tabindex="0" role="button" draggable="' + (_pqSelMode ? 'false' : 'true') + '" data-pqidx="' + i + '" onclick="' + (_pqSelMode ? 'togglePqSel(' + i + ', event)' : 'window._playQueueIdx(' + i + ')') + '">'
        + cb
        + '<span class="pq-idx">' + (i + 1) + '</span>'
        + cover
        + '<span class="pq-item-main">'
        + '<span class="pq-item-title">' + esc(s.title || '') + '</span>'
        + '<span class="pq-item-artist">' + esc(s.artist || '') + '</span>'
        + '</span>'
        + '<span class="pq-dur">' + fmtDuration(s.duration) + '</span>'
        + (favS ? heartBtnHtml(favS, 'pq-fav') : '')
        + '</div>';
    }).join('');
  }
  if (count) count.textContent = queue.length;
  if (badge) badge.textContent = queue.length > 0 ? String(queue.length) : '';
  // 常驻条缩略图：队列前 3 首里有封面的（叠放展示）
  if (thumbs) {
    thumbs.innerHTML = queue.filter((s) => s.cover).slice(0, 3).map((s) =>
      '<img class="pc-queue-thumb" src="' + escAttr(s.cover) + '" alt="">').join('');
  }
}

window._playQueueIdx = (idx) => {
  // 队列行对象不携带已解析的播放地址，点击即走 playSongByIdx 取流链路
  //（旧实现直接读行上的 url 字段——该字段恒不存在，点击只挪高亮不发声）
  playQueueIdx(idx);
};

window.clearPlayQueue = () => {
  // setState 订阅会自动刷新 UI（playQueue + playIdx 各触发一次），
  // 原先这里再显式 renderPlayQueueUI() 是第三次重绘，删除
  setState('playQueue', []);
  setState('playIdx', 0);
  setState('currentPlaying', null);
  showToast(t('toast.queueCleared'), 'info');
};

// ── 队列单行移除 / 一键去重（playQueueEdit 纯函数的接线层）──────
window.removePqItem = (idx) => {
  const r = removeQueueItem(getState('playQueue') || [], getState('playIdx') || 0, idx);
  if (!r) return;
  setState('playQueue', r.queue);
  if (r.removedCurrent) {
    if (!r.queue.length) {
      const audio = document.getElementById('audioPlayer');
      if (audio) audio.pause();
      setState('playIdx', 0);
      setState('currentPlaying', null);
    } else {
      // 删的是当前播放曲 → 让补位曲接着播，连播语义不断
      setState('playIdx', r.playIdx);
      window._playQueueIdx(r.playIdx);
    }
  } else {
    setState('playIdx', r.playIdx);
  }
  showToast(t('toast.queueRemovedOne'), 'info');
};

window.dedupePlayQueue = () => {
  const r = dedupeQueue(getState('playQueue') || [], getState('playIdx') || 0);
  if (!r.removed) { showToast(t('toast.queueNoDup'), 'info'); return; }
  setState('playQueue', r.queue);
  setState('playIdx', Math.max(0, r.playIdx));
  showToast(t('toast.queueDupRemoved', { count: r.removed }), 'success');
};

// ── 队列多选批量移除：选态装行对象引用，下标漂移不误伤 ──
let _pqSelMode = false;
const _pqSel = new Set();
// Shift 连选的锚点：同样存行对象引用（队列无过滤视图，视图序==存储序）
let _pqSelAnchor = null;

function _syncPqSelBtns() {
  const btn = document.getElementById('pqSelBtn');
  const rm = document.getElementById('pqSelRmBtn');
  if (btn) btn.textContent = _pqSelMode ? '⬚ 退出' : '☑ 多选';
  if (rm) {
    rm.classList.toggle('hidden', !_pqSelMode);
    rm.textContent = `🗑 移除 ${_pqSel.size}`;
  }
  const pl = document.getElementById('pqSelPlBtn');
  if (pl) {
    pl.classList.toggle('hidden', !_pqSelMode);
    pl.textContent = `🎼 歌单 ${_pqSel.size}`;
  }
}

window.togglePqSelMode = () => {
  _pqSelMode = !_pqSelMode;
  if (!_pqSelMode) { _pqSel.clear(); _pqSelAnchor = null; }
  renderPlayQueueUI();
};

/**
 * 勾选/取消一行；按住 Shift 把「锚点 → 本次点击」整段并进来。
 * 队列没有过滤/排序视图，渲染序==getState('playQueue') 序，直接把队列当视图序用。
 */
window.togglePqSel = (idx, e) => {
  const queue = getState('playQueue') || [];
  const item = queue[idx];
  if (!item) return;
  if (isRangeClick(e)) {
    for (const it of rangeKeys(queue, _pqSelAnchor, idx)) _pqSel.add(it);
    renderPlayQueueUI();
    return;
  }
  if (_pqSel.has(item)) _pqSel.delete(item);
  else _pqSel.add(item);
  _pqSelAnchor = item;
  renderPlayQueueUI();
};

window.removeCheckedFromQueue = async () => {
  if (!_pqSel.size) { showToast(t('toast.pickRowsFirst'), 'warn'); return; }
  if (!await askConfirm(t('toast.confirmRemoveRows', { count: _pqSel.size }))) return;
  const r = removeQueueItemsByIdentity(getState('playQueue') || [], getState('playIdx') || 0, _pqSel);
  _pqSel.clear();
  _pqSelAnchor = null;
  if (!r.removed) { renderPlayQueueUI(); return; }
  setState('playQueue', r.queue);
  if (r.removedCurrent) {
    if (!r.queue.length) {
      const audio = document.getElementById('audioPlayer');
      if (audio) audio.pause();
      setState('playIdx', 0);
      setState('currentPlaying', null);
    } else {
      // 删掉了正在播的行 → 补位曲顶上，连播语义不断（与单行移除一致）
      setState('playIdx', r.playIdx);
      window._playQueueIdx(r.playIdx);
    }
  } else if (r.playIdx >= 0) {
    setState('playIdx', r.playIdx);
  }
  showToast(t('toast.rowsRemoved', { count: r.removed }), 'success');
};

// ── Delete 键作用域：播放队列 ─────────────────────────
// 队列面板是浮在页面右侧的抽屉，不是 data-modal 浮层 ⇒ modalId 留空，
// 于是「上层压着任何弹窗」时 shortcuts.js 会拦住 Delete（不给看不见的列表做批量移除）。
// order=20：歌单详情弹层（10）开着时归它，弹层没开才轮到队列。
registerDeleteScope({
  id: 'play-queue',
  order: 20,
  active: () => _pqSelMode && _pqVisible,
  count: () => _pqSel.size,
  run: () => window.removeCheckedFromQueue(),
  modalId: '',
});

// 队列多选「🎼 加歌单」：勾选行按队列原序投影成可持久行，
// 喂 quickAddToPlaylist 既有批量链（引擎端 id+source 去重）。drop 行是
// 临时 blob、本地行缺 filePath 播不动 —— 都被纯函数挡在门外。
window.pqSelAddPlaylist = () => {
  if (!_pqSel.size) { showToast(t('toast.pickRowsForPlaylist'), 'warn'); return; }
  const picked = (getState('playQueue') || []).filter(s => _pqSel.has(s));
  const rows = pickPlSavableRows(picked);
  if (!rows.length) {
    showToast(t('toast.noPersistableRows'), 'warn', 2600);
    return;
  }
  if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(rows);
};

// 播放队列「📋 复制曲单」：多选模式下只复制勾到的行，否则整队，
// 一行一首「歌名 - 歌手」纯文本进剪贴板（同 108 的两个消费方口径）。
// 入口刻意只挂命令面板：pq-header 已 6 个按钮，而 .pq-panel 是不换行的
// flex + overflow:hidden，第 7 个会被静默裁掉。
window.copyQueueListText = async () => {
  const { rows, scope } = pickQueueCopyRows(getState('playQueue') || [], _pqSel);
  const lines = toTrackLines(rows);
  if (!lines.length) {
    showToast(scope === 'checked' ? t('toast.noTitlesChecked') : t('toast.queueEmptyForCopy'), 'info', 2500);
    return;
  }
  const ok = await copyText(lines.join('\n'));
  showToast(ok ? queueCopyToastText(lines.length, scope) : t('toast.copyFailed'), ok ? 'success' : 'error', 2500);
};

// 播放队列一键存为歌单（queuePlaylist 纯函数的接线层）：
// 名称自动生成「播放队列 · MM-DD HH:mm」，建好后可在歌单编辑器改名/换封面。
// 走 pickPlSavableRows —— 整单存为同样不收死行（drop 临时行 / 缺 filePath 的本地行）
window.saveQueueAsPlaylist = async () => {
  const songs = pickPlSavableRows(getState('playQueue') || []);
  if (!songs.length) { showToast(t('toast.queueNotSavable'), 'warn', 2800); return; }
  try {
    const r = await api.saveUserPlaylist({
      name: defaultQueuePlaylistName(new Date()),
      desc: `由播放队列保存 · ${songs.length} 首`,
      cover: songs.find((s) => typeof s.cover === 'string' && s.cover.startsWith('http'))?.cover || '',
      songs,
    });
    if (r && r.success) {
      if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
      showToast(t('toast.queueAsPlaylist', {
        name: r.playlist?.name || defaultQueuePlaylistName(new Date()), count: songs.length,
      }), 'success', 3000);
    } else {
      showToast((r && r.error) || t('toast.savePlaylistFailed'), 'error');
    }
  } catch (e) {
    showToast(t('toast.saveFailedDetail', { msg: errBrief(e) }), 'error');
  }
};

async function downloadPqSong(s) {
  try {
    const task = { ...s, saveDir: getState('saveDir'), quality: resolveQuality(s.source) };
    const r = await api.addToQueue(task);
    if (r && r.duplicated) {
      showToast(t('toast.queueDup', { title: s.title }), 'warn', 2500);
      return;
    }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(s.title, r.finishedAt, () => {
        api.addToQueue({ ...task, forceRedownload: true })
          .then(() => showToast(t('toast.queueAdded', { title: s.title }), 'success'))
          .catch(e => showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error'));
      });
      return;
    }
    showToast(t('toast.queueAdded', { title: s.title }), 'success');
  } catch (e) {
    showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error');
  }
}

document.addEventListener('contextmenu', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('.pq-item') : null;
  if (!row) return;
  const idx = Number(row.getAttribute('data-pqidx'));
  const song = (getState('playQueue') || [])[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => window._playQueueIdx(idx),
    download: () => downloadPqSong(song),
    extra: [{ icon: '✕', label: '从队列移除', onClick: () => window.removePqItem(idx) }],
  });
});

// 监听 playQueue 变化自动刷新 UI
state.subscribe('playQueue', () => renderPlayQueueUI());
state.subscribe('playIdx', () => renderPlayQueueUI());

// ── 启动入口（ES Module 自动 defer，DOM 已就绪）───────
// ESM 脚本默认 defer，DOMContentLoaded 触发时脚本已执行完毕
// 但为确保兼容性依然监听
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => {
    if (typeof init === 'function' && !window._initCalled) {
      window._initCalled = true;
      init().catch(e => logger.error('[init] 异常:', e));
    }
  }, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  if (!window._initCalled) {
    window._initCalled = true;
    init().catch(e => logger.error('[init] 异常:', e));
  }
});
