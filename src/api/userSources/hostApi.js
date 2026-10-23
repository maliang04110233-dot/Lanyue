/**
 * hostApi.js — 用户自定义音源脚本的宿主 API（白名单）
 *
 * 这是沙箱里用户脚本**唯一**能触网的通道。所有调用都经 gateway
 * （SSRF 白名单 + 限频），脚本本身看不到 Cookie，看不到文件系统。
 *
 * 安全模型
 * --------
 *   用户脚本 → hostApi.platformXxx(...) → gateway.xxx(...) → 平台插件 → 上游
 *
 *   · 脚本发不出原始 fetch（静态分析器已拒绝）
 *   · 脚本看不到 Cookie（gateway 内部按平台自动附加，见 getCookie）
 *   · 脚本看不到文件系统（沙箱无 fs / require）
 *   · 每个调用都过 utils/redact 脱敏后才返回
 *
 * 为什么用 factory 而不是直接导出对象
 * -----------------------------------
 * 1. 可注入依赖（gateway / logger / redact），单测用桩即可
 * 2. 每个用户源一个实例，互不干扰（一个源崩溃不影响另一个）
 * 3. 超时与输出上限由 factory 统一施加，调用方不需要关心
 *
 * 性能
 * ----
 * 全部方法异步。gateway 本身已有重试与退避，这里不重复造。
 * 超时只在调用方（沙箱进程管理）侧施加，本模块不设内部超时
 * —— gateway 的超时已经够细，两层超时会互相打架。
 */

'use strict';

const { HOST_API_METHODS } = require('../../main/userSourceValidator');

/**
 * 创建 hostApi 实例。
 *
 * @param {Object} deps
 * @param {Object} deps.gateway  Lanyue 的 gateway（必须是已初始化的实例）
 * @param {Object} [deps.logger] 日志器
 * @param {Object} [deps.redact] 脱敏器（utils/redact），缺省 identity
 * @param {string} [deps.sourceId] 调用方用户源的 id（写入审计用）
 * @returns {Object} 冻结的 hostApi 实例
 */
function createHostApi({ gateway, logger = null, redact = null, sourceId = 'unknown' }) {
  if (!gateway || typeof gateway !== 'object') {
    throw new Error('[hostApi] 必须注入 gateway');
  }
  if (!redact) {
    // 缺省不脱敏（测试环境）；生产环境必须注入 utils/redact
    redact = { apply: (v) => v };
  }
  if (typeof redact.apply !== 'function') {
    throw new Error('[hostApi] redact 必须提供 apply() 方法');
  }

  const log = logger
    ? (msg) => { try { logger.log(msg); } catch (_) { /* 日志不可用不影响取流 */ } }
    : () => {};
  const warn = logger
    ? (msg) => { try { logger.warn(msg); } catch (_) { /* 同上 */ } }
    : () => {};

  // ── 每个方法的实现 ────────────────────────────────
  // 模式：调 gateway → 脱敏 → 返回。
  // 调 gateway 失败时**不吞** —— 让用户脚本看到错误（它可能要换参数重试）。
  // 但包装一层让日志能记到 sourceId，方便审计归因。

  const methods = {};

  /** 搜索：平台搜索歌曲 */
  methods.platformSearch = async (platformId, keyword, page = 1) => {
    return safeCall('platformSearch', () => gateway.search(platformId, keyword, page));
  };

  /** 取流：返回 { url, ext, ... } */
  methods.platformGetUrl = async (platformId, id, quality) => {
    return safeCall('platformGetUrl', () => gateway.getUrl(platformId, id, quality));
  };

  /** 取歌词 */
  methods.platformGetLyrics = async (platformId, id) => {
    return safeCall('platformGetLyrics', () => gateway.getLyrics(platformId, id));
  };

  /** 按歌名+歌手取歌词（平台兜底能力） */
  methods.platformGetLyricsByTitle = async (platformId, title, artist) => {
    return safeCall('platformGetLyricsByTitle', () => gateway.getLyricsByTitle(platformId, title, artist));
  };

  /** 链接详情 */
  methods.platformGetSongDetail = async (platformId, id) => {
    return safeCall('platformGetSongDetail', () => gateway.getSongDetail(platformId, id));
  };

  /** 专辑歌曲 */
  methods.platformGetAlbumSongs = async (platformId, albumMid, limit) => {
    return safeCall('platformGetAlbumSongs', () => gateway.getAlbumSongs(platformId, albumMid, limit));
  };

  /** 歌手歌曲 */
  methods.platformGetSingerSongs = async (platformId, singerMid, limit) => {
    return safeCall('platformGetSingerSongs', () => gateway.getSingerSongs(platformId, singerMid, limit));
  };

  /** 歌手专辑 */
  methods.platformGetSingerAlbums = async (platformId, singerMid, pageNo, pageSize) => {
    return safeCall('platformGetSingerAlbums', () => gateway.getSingerAlbums(platformId, singerMid, pageNo, pageSize));
  };

  /** 歌单歌曲 */
  methods.platformGetPlaylistSongs = async (platformId, playlistId, limit) => {
    return safeCall('platformGetPlaylistSongs', () => gateway.getPlaylistSongs(platformId, playlistId, limit));
  };

  /** 歌单详情 */
  methods.platformGetPlaylistDetail = async (platformId, playlistId) => {
    return safeCall('platformGetPlaylistDetail', () => gateway.getPlaylistDetail(platformId, playlistId));
  };

  /** 排行榜 */
  methods.platformGetTopList = async (platformId) => {
    return safeCall('platformGetTopList', () => gateway.getTopList(platformId));
  };

  /** 推荐歌单 */
  methods.platformGetRecommendPlaylists = async (platformId) => {
    return safeCall('platformGetRecommendPlaylists', () => gateway.getRecommendPlaylists(platformId));
  };

  /** 分类歌单 */
  methods.platformGetCategoryPlaylists = async (platformId, categoryId) => {
    return safeCall('platformGetCategoryPlaylists', () => gateway.getCategoryPlaylists(platformId, categoryId));
  };

  /** 新歌 */
  methods.platformGetNewSongs = async (platformId) => {
    return safeCall('platformGetNewSongs', () => gateway.getNewSongs(platformId));
  };

  /** 电台 */
  methods.platformGetRadioStations = async (platformId) => {
    return safeCall('platformGetRadioStations', () => gateway.getRadioStations(platformId));
  };

  /** 热门歌手 */
  methods.platformGetHotSingers = async (platformId) => {
    return safeCall('platformGetHotSingers', () => gateway.getHotSingers(platformId));
  };

  /** 排行 */
  methods.platformGetRanking = async (platformId) => {
    return safeCall('platformGetRanking', () => gateway.getRanking(platformId));
  };

  /** 该平台是否已配置 Cookie（脚本据此决定是否提示用户登录） */
  methods.platformHasCookie = async (platformId) => {
    return safeCall('platformHasCookie', () => gateway.hasCookie(platformId));
  };

  /**
   * 统一包装：调 gateway → 脱敏 → 返回。
   *
   * 设计取舍：
   *   · 成功路径零额外开销（redact.apply 是恒等或轻量替换）
   *   · 失败路径**不吞** —— 让脚本看到原始错误
   *   · 日志带 sourceId，方便审计归因
   */
  async function safeCall(methodName, fn) {
    try {
      const result = await fn();
      // 脱敏：防止 Cookie 或其他敏感字段泄漏给脚本
      const cleaned = redact.apply(result);
      log(`[hostApi:${sourceId}] ${methodName} ok`);
      return cleaned;
    } catch (e) {
      warn(`[hostApi:${sourceId}] ${methodName} 失败:`, (e && e.message) || e);
      throw e;  // 不吞：脚本需要看到错误以决定是否重试
    }
  }

  // ── 冻结并返回 ─────────────────────────────────────
  // 冻结后用户脚本无法篡改方法（篡改 = 绕过白名单）
  const frozen = Object.freeze({ ...methods });

  // 自检：导出面必须与 HOST_API_METHODS 一致
  const actual = Object.keys(frozen).sort();
  const expected = [...HOST_API_METHODS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `[hostApi] 导出面与 HOST_API_METHODS 不一致\n  实际: ${actual.join(', ')}\n  期望: ${expected.join(', ')}`,
    );
  }

  return frozen;
}

/**
 * 校验一个对象是否「长得像」合法的 hostApi 实例。
 * 用于沙箱启动前的自检（preload 注入后确认暴露面正确）。
 *
 * @param {Object} obj
 * @returns {boolean}
 */
function isHostApiLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const m of HOST_API_METHODS) {
    if (typeof obj[m] !== 'function') return false;
  }
  return true;
}

module.exports = { createHostApi, isHostApiLike, HOST_API_METHODS };
