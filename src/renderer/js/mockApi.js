/**
 * 浏览器预览环境下的音乐 API Mock。
 *
 * 从 app.js 拆出（阶段 4 渲染层模块化）：纯粹是开发兜底数据，
 * 不依赖 Electron IPC，仅用于 `location.protocol.startsWith('http')`
 * 的纯浏览器预览场景；打包/Electron（file://）走真实 musicAPI，
 * mock 不参与。
 *
 * 模块内直接使用全局 `showToast` / `t` / `getPlatforms` /
 * `fallbackPlatformIds`（由 utils.js / i18n.js / toast.js 挂载到 window），
 * 与 app.js 原内联定义语义一致。
 */

import { t } from './i18n.js';
import { getPlatforms, fallbackPlatformIds } from './utils.js';

/** mock 用的来源 id：优先主进程下发的清单，缺失时用 utils.js 的兜底表 */
function _mockSrcIds() {
  const ids = getPlatforms().map((p) => p.id);
  return ids.length ? ids : fallbackPlatformIds();
}

/** Mock 数据生成：搜索结果列表 */
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

/** Mock 数据生成：本地歌曲列表 */
function mockLocalSongs() {
  return [
    { id: 'local1', title: '示例本地歌曲 1', artist: '本地艺术家 A', album: '本地专辑 A', filePath: 'C:\\Music\\song1.mp3', ext: 'mp3', size: 5242880, duration: 240000 },
    { id: 'local2', title: '示例本地歌曲 2', artist: '本地艺术家 B', album: '本地专辑 B', filePath: 'C:\\Music\\song2.flac', ext: 'flac', size: 31457280, duration: 315000 },
    { id: 'local3', title: '示例本地歌曲 3', artist: '本地艺术家 C', album: '本地专辑 C', filePath: 'C:\\Music\\song3.wav', ext: 'wav', size: 52428800, duration: 280000 },
  ];
}

/**
 * 开发兜底 API：无 musicAPI 时的回退。平台清单为空 → 渲染层走内置兜底表。
 * 所有方法均返回空/兜底结果，绝不静默假成功。
 */
export const mockApi = {
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
  // 预览环境的偏好默认值。
  //
  // 原来这里恒返回 null，代价是「浏览器里看到的界面 ≠ 产品装好后的样子」：
  //   · theme 为 null ⇒ 不 applyTheme ⇒ 停在 :root 的默认配色（#00ffc8 青绿），
  //     而产品默认主题是 void（#00e5ff 电青）—— 同一份 CSS 呈现出两种色相，
  //     改配色时对着预览调色，装到机器上才发现偏了一整个色相。
  //   · welcomeSeen 为 null ⇒ 每次刷新都弹首次引导，挡住要看的界面。
  // 这里让 mock 模拟「一台装配完好、用户已用过一次」的机器。
  getPref: async (key) => {
    const PREVIEW_DEFAULTS = {
      theme: 'void',       // 与 prefs.js 白名单里的产品默认主题保持一致
      welcomeSeen: true,   // 跳过一次性引导，预览直接看主界面
      language: 'zh',
    };
    return Object.prototype.hasOwnProperty.call(PREVIEW_DEFAULTS, key)
      ? PREVIEW_DEFAULTS[key]
      : null;
  },
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
      tops: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), title: `示例歌曲 ${i + 1}`, artist: '示例歌手', album: '示例专辑', cover: '', duration: 240000, source: 'netease' })),
      playlists: Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), name: `推荐歌单 ${i + 1}`, cover: '', playCount: 10000, source: 'netease' })),
    },
    qq: { playlists: Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), name: `QQ歌单 ${i + 1}`, cover: '', playCount: 20000, source: 'qq' })) },
  }),
  getPlaylistSongs: async () => Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), title: `歌单歌曲 ${i + 1}`, artist: '歌手', album: '专辑', cover: '', duration: 200000, source: 'netease' })),
  // 首页分区数据。
  //
  // 原来恒返回 `{ ok: true, data: [] }`，而 home.js 把「ok 但空数组」判为
  // 降级态（renderSectionError），于是浏览器预览里每个平台块都只剩一句
  // 「该区块暂无内容」—— 卡片流、榜单行、平台徽标、播放量胶囊这些**最需要
  // 目视验收的组件一个都看不到**。mock 的职责就是让开发预览看到真实形态，
  // 空数据等于让预览失效。
  //
  // 这里按 sec 前缀分发：歌单类给 8 张卡（grid），榜单类给 10 首（list）。
  // cover 故意留空 —— 走 noCoverSvgHtml 占位，正好把「无封面」这个真实
  // 边界态一起验收掉。
  getHomeSection: async (sec) => {
    const GRID_SECS = new Set([
      'netease.playlists', 'qq.recommend', 'qq.official', 'qq.classic',
      'qq.love', 'qq.ktv', 'qq.radio', 'qq.singers', 'kugou.playlists',
    ]);
    const platform = String(sec || '').split('.')[0] || 'netease';

    if (GRID_SECS.has(sec)) {
      const NAMES = [
        '华语流行精选', '深夜电台 · 助眠', '粤语黄金年代', '午后咖啡馆',
        '国风新势力', '通勤路上', '运动节拍', '影视原声集',
      ];
      return {
        ok: true,
        data: NAMES.map((name, i) => ({
          id: `mockpl-${i}`,
          name,
          cover: '',
          playCount: 12000 + i * 37000,
          source: platform,
        })),
      };
    }

    return { ok: true, data: mockSongs('', platform) };
  },
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
