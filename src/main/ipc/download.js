/**
 * 下载 / 队列 IPC
 *
 * 注册：get-download-url / proxy-play / add-to-queue / cancel-download /
 *      retry-download / remove-queue-item / clear-finished-queue / clear-all-queue
 *
 * 队列管理 + processQueue/processOneSong 留在 main/index.js（共享状态多）
 */

const api = require('../../api');
const { handle } = require('./register');
const { getDownloadQueue, safeSend } = require('../context');
const { queueMove } = require('../queueOrder');
// 根因 1 起 proxy-play 走 streamProtocol 的流式路径，playCache 的整首落盘
// 仅保留给诊断/设置页的缓存统计，不再是播放链路的一环。
const history = require('../../utils/history');
const { fetchRadioPool } = require('../radioPool');
const logger = require('../../utils/logger');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');

/**
 * 3-A 电台：取同歌手候选曲目
 *
 * 只读且无副作用：把 seed 交给 radioPool，由它决定搜什么、怎么降级。
 * 拿不到歌手名 / 搜索失败 / 返回垃圾都在 radioPool 内降级为
 * { songs: [], reason }，这里只做透传 + 最后一道参数守卫。
 */
handle('radio-pool', async (_, seed, opts) => {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    return { songs: [], artist: '', reason: 'no-artist' };
  }
  return fetchRadioPool(seed, opts);
});

function register() {
  // 关键：downloadQueue / app / persistQueue / processQueue 都通过 getter 拿，
  // 避免 register 时（createWindow 之前）解构到 undefined

  // M9: IPC 边界参数形状校验——id/source/quality 会拼进平台 API URL，
  // 渲染层被 XSS 后可传任意字符串，这里兜底拦截控制字符与超长值
  const safeId = (v) => {
    const s = String(v ?? '').trim();
    // 仅允许可见 ASCII（无空白/控制字符）且长度受限
    return s.length && s.length <= 128 && /^[ -~]+$/.test(s) ? s : null;
  };
  const safeToken = (v) => {
    const s = String(v ?? '');
    return /^[a-z0-9_-]{1,32}$/i.test(s) ? s : null;
  };

  /**
   * 修 R1-3：移除/清空队列前，对在途任务先走一遍与 cancel-download 一致的取消流程。
   *
   * 判据与 cancel-download 相同：downloading，或 pending 且协程在途（重试退避期）。
   * 顺序不能反 —— 置了 _cancelRequested / 打断请求之后才把条目摘出队列，协程才会
   * 走到 cancelled 终态；反过来的话 requestCancel 已找不到这条任务。
   * 终态仍由队列引擎落盘（.tmp 由传输层失败路径清理），这里只管"别让它偷偷下完"。
   *
   * @param {Object} song 队列条目
   * @param {function} requestCancelDownload ctx 注入的引擎取消入口
   */
  const cancelInFlight = (song, requestCancelDownload) => {
    if (!song) return false;
    const inFlight = song.status === 'downloading' || (song.status === 'pending' && song._processing);
    if (!inFlight) return false;
    if (typeof requestCancelDownload !== 'function') {
      // 引擎未就绪：至少置标记，协程在下一轮 attempt 顶部会退出
      song._cancelRequested = true;
      return true;
    }
    try {
      requestCancelDownload(song.taskId);
    } catch (e) {
      logger.warn('[ipc] 取消在途任务失败:', e.message);
      song._cancelRequested = true;
    }
    return true;
  };

  // 获取下载 URL（渲染层位置参数调用：api.getDownloadUrl(id, source, quality)）
  handle('get-download-url', async (_, rawId, rawSource, rawQuality) => {
    
    const id = safeId(rawId);
    const source = safeToken(rawSource);
    const quality = ['lossless', 'hq', 'standard'].includes(rawQuality) ? rawQuality : 'standard';
    if (!id || !source) return { error: '非法参数', fatal: true };
    try {
      return await api.getDownloadUrl(id, source, quality);
    } catch (e) {
      logger.warn('获取下载URL失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 智能取流（换源）：渲染层播放链路用——本源失败自动跨源找同曲
  handle('get-download-url-smart', async (_, song, quality) => {
    
    try {
      return await api.getDownloadUrlSmart(song, quality);
    } catch (e) {
      logger.warn('智能取流失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 在线播放：把跨域音频以流式代理喂给 audio 元素（根因 1）
  const { assertPublicHttpUrl } = require('../../utils/urlGuard');
  const streamRegistry = require('../streamRegistry');
  const { makeStreamRefresh } = require('../streamRefresh');
  handle('proxy-play', async (_, url, referer, refresh) => {

    // C10: SSRF protection — full guard via urlGuard:
    //   scheme/userinfo 校验 + DNS 全记录解析 + 内网 IP 判定（含
    //   2130706433 / 0x7f.0.0.1 / 0177.0.0.1 / [::ffff:127.0.0.1] 等编码绕过）
    //   原正则黑名单已删除（可被 IP 编码与 DNS rebinding 绕过）
    const check = await assertPublicHttpUrl(url);
    if (!check.ok) {
      return { error: `URL 校验失败: ${check.reason}` };
    }
    // 登记后立即返回 scheme URL：不再等整首落盘。渲染层拿到就能播，
    // duration 由首个响应头给出，seek 从此可用。
    // SSRF 校验在 protocol.handle 里会再做一次（见 streamProtocol.js 头注约束 1），
    // 这一次是为了在登记前就拒掉明显非法的入参、少占一条登记位。
    // D-35：登记时一并挂上同源重取回调。签名 URL 过期后上游一律 403，
    // 主进程靠它要一条新 URL 并用原始 Range 重放（见 streamProtocol.js）。
    // 缺省（老调用方 / 本地曲）不给回调，403 时如实失败。
    const refreshFn = refresh ? makeStreamRefresh(refresh, refresh.quality) : null;
    const streamUrl = streamRegistry.registerStream(url, referer, refreshFn);
    if (!streamUrl) return { error: 'no url' };
    return { fileUrl: streamUrl, streaming: true };
  });

  // 添加到下载队列
  handle('add-to-queue', async (_, song) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, processQueue } = require('../context').getCtx();
    // 查重 1：同 id+source 且未完成的任务已在队列 → 拒绝，避免重复下载同一首
    const dup = downloadQueue.find(s =>
      s && s.id === song.id && s.source === song.source && s.status !== 'done');
    if (dup) {
      return { queued: false, duplicated: true, taskId: dup.taskId };
    }
    // 查重 2（跨会话）：历史里已成功下载过、文件还在磁盘上 → 弹确认框，
    // 用户可选择强制重下（参考 streamrip 的下载去重；渲染层批量场景
    // 传 forceRedownload 静默跳过，不走对话框）
    if (!song.forceRedownload) {
      const done = history.findDownloaded(song.id, song.source);
      if (done) {
        return {
          queued: false,
          alreadyDownloaded: true,
          savePath: done.savePath,
          finishedAt: done.finishedAt,
        };
      }
    }
    const taskId = makeTaskId();
    downloadQueue.push({ ...song, taskId, status: 'pending', progress: 0, addedAt: Date.now() });
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    processQueue();
    return { queued: true, taskId };
  });

  // 取消下载：pending 且协程在途（重试等待期）走协作式取消，不能 splice ——
  // splice 会留下孤儿协程照常落盘写历史；真正的 pending 直接移出队列；
  // downloading 置标记 + 打断在途请求（.tmp 由失败路径清理，任务转入 error=已取消）
  handle('cancel-download', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, requestCancelDownload } = require('../context').getCtx();
    const inFlight = downloadQueue.find(s => s.taskId === taskId &&
      (s.status === 'downloading' || (s.status === 'pending' && s._processing)));
    if (inFlight) {
      const ok = typeof requestCancelDownload === 'function' ? requestCancelDownload(taskId) : false;
      return ok ? { canceled: true, cancelling: true } : { canceled: false };
    }
    const idx = downloadQueue.findIndex(s => s.taskId === taskId && s.status === 'pending');
    if (idx === -1) {
      return { canceled: false };
    }
    downloadQueue.splice(idx, 1);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { canceled: true };
  });

  // 重试失败的下载任务
  handle('retry-download', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, processQueue } = require('../context').getCtx();
    const idx = downloadQueue.findIndex(s => s.taskId === taskId);
    if (idx === -1) return { ok: false, error: '任务不存在' };
    const song = downloadQueue[idx];
    if (song.status !== 'error') return { ok: false, error: '该任务不在失败状态' };
    song.status = 'pending';
    song.error = null;
    song.errorCode = null;
    song.progress = 0;
    downloadQueue.splice(idx, 1);
    const insertAt = downloadQueue.findIndex(s => s.status === 'downloading');
    if (insertAt === -1) downloadQueue.unshift(song);
    else downloadQueue.splice(insertAt + 1, 0, song);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    processQueue();
    return { ok: true };
  });

  // 移除队列项
  // 修 R1-3：在途任务不能直接 splice。原实现不看 status 就摘掉条目，而协程只在
  // **下一轮 attempt 顶部**判 includes(song) —— 当前这次传输照常跑完，照样写历史、
  // 嵌 ID3、置 done（cancel-download 的注释早已识别这点，只是没覆盖本条路径）。
  // 与 cancel-download 同一套取消流程：先协作式取消（置标记 + 打断在途请求），
  // 再从数组摘除，让协程落到 cancelled 终态。
  handle('remove-queue-item', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, requestCancelDownload } = require('../context').getCtx();
    const idx = downloadQueue.findIndex(s => s.taskId === taskId);
    if (idx === -1) return { removed: false };
    cancelInFlight(downloadQueue[idx], requestCancelDownload);
    downloadQueue.splice(idx, 1);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: true };
  });

  // 调整队列顺序（置顶/上移/下移，仅 pending 可动）
  handle('reorder-queue-item', (_, taskId, action) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const changed = queueMove(downloadQueue, taskId, action);
    if (changed) {
      safeSend('queue-updated', downloadQueue);
      persistQueue();
    }
    return { ok: changed, error: changed ? null : '无法移动该任务' };
  });

  // 暂停/继续下载调度（在途任务不打断）
  handle('set-queue-paused', (_, paused) => {
    const { setQueuePaused, queueIsPaused } = require('../context').getCtx();
    if (typeof setQueuePaused !== 'function') return { ok: false, error: '引擎未就绪' };
    setQueuePaused(!!paused);
    return { ok: true, paused: !!queueIsPaused() };
  });

  // 清空已完成
  handle('clear-finished-queue', () => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const before = downloadQueue.length;
    for (let i = downloadQueue.length - 1; i >= 0; i--) {
      if (downloadQueue[i].status === 'done') downloadQueue.splice(i, 1);
    }
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: before - downloadQueue.length };
  });

  // 清空全部
  handle('clear-all-queue', () => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, requestCancelDownload } = require('../context').getCtx();
    const before = downloadQueue.length;
    // 修 R1-3：清空前逐个走取消流程（见 remove-queue-item 的同一说明）——
    // 直接 length = 0 会留下孤儿协程把在途歌曲下完、写历史、通知前端"下载完成"。
    for (const s of downloadQueue) cancelInFlight(s, requestCancelDownload);
    downloadQueue.length = 0;
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: before };
  });

  // 批量加入队列（歌单详情页用）
  handle('add-playlist-to-queue', async (_, payload) => {
    try {
      const songs = (payload && payload.songs) || [];
      if (!Array.isArray(songs) || songs.length === 0) {
        return { queued: 0, skipped: 0 };
      }
      const downloadQueue = getDownloadQueue();
      const { persistQueue, processQueue } = require('../context').getCtx();

      // 1. 收集"真正在跑"的任务 key
      //    downloading: 算重复
      //    pending: 算重复（防止用户连点多次按钮重复入队）
      //    error: 不算（让用户能重试失败的歌）
      //    done: 不算（已下完，避免重复入队）
      //    但 ——
      //    用户场景：重启后 queue.json 里 42 个 pending 任务会"挡住"新歌单 20 首歌
      //    所以策略修正：pending 算重复，但用户可以先用 UI 上的"清空"按钮
      const existingIds = new Set();
      for (const s of downloadQueue) {
        if (!s) continue;
        if (s.status === 'done' || s.status === 'error') continue;
        if (s.id == null || s.id === '' || !s.source) continue;
        existingIds.add(`${s.source}:${s.id}`);
      }

      // 2. 逐首入队（批量场景查历史去重：已成功下载过且文件还在的静默跳过）
      let queued = 0, skippedDup = 0, skippedNoId = 0, skippedDownloaded = 0;
      for (const s of songs) {
        if (!s || s.id == null || s.id === '' || !s.source) {
          skippedNoId++;
          continue;
        }
        const key = `${s.source}:${s.id}`;
        if (existingIds.has(key)) {
          skippedDup++;
          continue;
        }
        if (!s.forceRedownload && history.findDownloaded(s.id, s.source)) {
          skippedDownloaded++;
          continue;
        }
        downloadQueue.push({
          ...s,
          taskId: makeTaskId(),
          status: 'pending',
          progress: 0,
          addedAt: Date.now(),
        });
        existingIds.add(key);
        queued++;
      }

      // 修复 B21：DEBUG 模式下才打 stderr，避免污染日志
      if (process.env.DEBUG) {
        process.stderr.write(`[add-playlist-to-queue] queued=${queued} skippedDup=${skippedDup} skippedNoId=${skippedNoId} skippedDownloaded=${skippedDownloaded} queueLen=${downloadQueue.length}\n`);
      }

      if (queued > 0) {
        safeSend('queue-updated', downloadQueue);
        persistQueue();
        processQueue();
      }
      // skipped 字段保持原语义（队内重复）；skippedDownloaded 单独返回供前端展示
    return { queued, skipped: skippedDup, skippedDownloaded };
    } catch (e) {
      logger.warn('[add-playlist-to-queue] 失败:', e);
      return { queued: 0, skipped: 0, error: e.message || String(e) };
    }
  });

  // ── 导出播放列表 ──────────────────────────────────────────
  handle('export-playlist', async (_, params) => {
    const { dialog } = require('electron');

    try {
      const { songs, format = 'm3u', name = 'Lanyue' } = params;
      if (!songs || !songs.length) return { error: '没有可导出的歌曲' };

      const ext = format === 'pls' ? 'pls' : 'm3u';
      const filters = [
        { name: '播放列表', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ];

      const result = await dialog.showSaveDialog({
        defaultPath: `${name}.${ext}`,
        filters,
      });

      if (result.canceled) return { canceled: true };

      let content = '';
      if (ext === 'm3u') {
        content = '#EXTM3U\n';
        for (const song of songs) {
          const duration = Math.round((song.duration || 0) / 1000);
          content += `#EXTINF:${duration},${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `${song.filePath || song.url || ''}\n`;
        }
      } else {
        content = '[playlist]\n';
        songs.forEach((song, i) => {
          content += `File${i + 1}=${song.filePath || song.url || ''}\n`;
          content += `Title${i + 1}=${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `Length${i + 1}=${Math.round((song.duration || 0) / 1000)}\n`;
        });
        content += `NumberOfEntries=${songs.length}\n`;
      }

      await fsa.writeText(result.filePath, content);
      return { success: true, path: result.filePath };
    } catch (e) {
      return { error: e.message };
    }
  });
}

function makeTaskId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = { register, makeTaskId };
