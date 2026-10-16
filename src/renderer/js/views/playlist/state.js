/**
 * playlist.js 的模块级状态汇总（阶段 4 第 A 步）。
 *
 * 把 views/playlist.js 里约 23 个模块级状态汇总到单一可变对象
 * `plState` 中，供 playlist.js 及其后续子模块共享。playlist.js
 * 导入 plState 后，所有函数内部通过 `plState._xxx` 读写状态，
 * 与原模块级变量语义完全相同（单例、进程内、会话级）。
 *
 * 为什么用对象而不是把每个变量单独 export let：
 * ESM 的 named import 绑定在导入端是只读的，即使导出端是
 * `export let`，导入模块也不能对它重新赋值。把状态挂在对象
 * 属性上，就可以在导入端自由读写属性值。
 */

export const plState = {
  // ── 歌单详情状态 ──
  _currentPlaylistId: null,
  _currentDetailSongs: [],
  _plSongKw: '', // 详情弹层会话级过滤词（切歌单/关闭即清）
  _plSortMode: '', // 详情弹层会话级视图排序（''=默认序，排序中禁拖把手）
  _plDlMode: 'all', // 详情弹层下载状态过滤（all/undone/done，切歌单即复位）
  _plCardSortMode: '', // 歌单页卡片排序（会话级，收藏系统单恒置顶）
  _plCardKw: '', // 歌单页卡片过滤词（会话级，先过滤后排序）

  // ── 播放竞态 ──
  _playlistPlayRequestId: 0,

  // ── 多选状态 ──
  _plSelMode: false,
  _plSelKeys: new Set(),
  _plSelAnchor: null,

  // ── 分片渲染 ──
  PL_RENDER_CHUNK: 100,
  _plRenderToken: 0,
  _plRenderPending: [],

  // ── 拖拽排序 ──
  _plDragFrom: -1,

  // ── 下载历史懒回填防抖 ──
  _plDlTimer: null,

  // ── 回收站 ──
  _plTrash: [],

  // ── 添加歌曲弹层 ──
  _plAddEl: null,
  _plAddSongs: [],
  _plAddReqId: 0,

  // ── 导出/合并忙碌 ──
  _plExportBusy: false,
  _plMergeEl: null,
  _plMerging: false,

  // ── 跨歌单去重/副本 ──
  _plDedupeBusy: false,
  _plDupBusy: false,
  _dedupeGroups: [],

  // ── 收藏同步 ──
  _plFavSyncBound: false,
};
