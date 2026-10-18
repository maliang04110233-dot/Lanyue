/**
 * 下载 IPC —— 队列域
 *
 * 注册：add-to-queue / cancel-download / retry-download / remove-queue-item /
 *      reorder-queue-item / set-queue-paused / clear-finished-queue /
 *      clear-all-queue / add-playlist-to-queue
 *
 * 队列管理 + processQueue/processOneSong 留在 main/index.js（共享状态多）。
 * 拆分说明（等价迁移）：自 ipc/download.js 的 register 提出。
 */

const { handle } = require('../register');
const { getDownloadQueue, safeSend } = require('../../context');
const { queueMove } = require('../../queueOrder');
const history = require('../../../utils/history');
const logger = require('../../../utils/logger');

function register() {
  // 关键：downloadQueue / persistQueue / processQueue 都通过 getter 拿，
  // 避免 register 时（createWindow 之前）解构到 undefined

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

  // 添加到下载队列
  handle('add-to-queue', async (_, song) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, processQueue } = require('../../context').getCtx();
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
      // P2-9：异步判活。网络盘上单次同步 stat 就够窗口卡一下，这里没有理由例外。
      const done = await history.findDownloadedAsync(song.id, song.source);
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
    const { persistQueue, requestCancelDownload } = require('../../context').getCtx();
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
    const { persistQueue, processQueue } = require('../../context').getCtx();
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
    const { persistQueue, requestCancelDownload } = require('../../context').getCtx();
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
    const { persistQueue } = require('../../context').getCtx();
    const changed = queueMove(downloadQueue, taskId, action);
    if (changed) {
      safeSend('queue-updated', downloadQueue);
      persistQueue();
    }
    return { ok: changed, error: changed ? null : '无法移动该任务' };
  });

  // 暂停/继续下载调度（在途任务不打断）
  handle('set-queue-paused', (_, paused) => {
    const { setQueuePaused, queueIsPaused } = require('../../context').getCtx();
    if (typeof setQueuePaused !== 'function') return { ok: false, error: '引擎未就绪' };
    setQueuePaused(!!paused);
    return { ok: true, paused: !!queueIsPaused() };
  });

  // 清空已完成
  handle('clear-finished-queue', () => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../../context').getCtx();
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
    const { persistQueue, requestCancelDownload } = require('../../context').getCtx();
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
      const { persistQueue, processQueue } = require('../../context').getCtx();

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
        // P2-9：批量路径改用异步判活。同步版在网络盘上单次 stat 可达数十毫秒，
        // 几百首逐条同步判活会把主进程（= UI 线程）卡住一整轮。
        if (!s.forceRedownload && await history.findDownloadedAsync(s.id, s.source)) {
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
}

function makeTaskId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = { register, makeTaskId };
