/**
 * 下载队列引擎（Download Queue Engine）
 *
 * 从 src/main/index.js 抽出（Sprint C）。抽出的理由：
 *   这段代码是**下载链路的完整状态机** —— 队列状态、持久化（防抖+原子写+淘汰）、
 *   并发调度、单曲处理（换源取流→落盘→ID3→歌词→历史→通知）、失败重试。
 *   它原先与「窗口创建 / 托盘 / 快捷键 / 应用生命周期」挤在同一文件，
 *   既难阅读，也让「下载」这个核心能力无法被独立测试与审视。
 *
 * 依赖注入：所有外部能力（prefs / history / 下载器 / 歌词 / API / 通知）
 * 通过 `createDownloadQueueEngine({...})` 传入，原因有二：
 *   1. main 进程模块在 Node 单测环境下无法 require electron —— 注入使
 *      「调度逻辑」与「Electron 运行时」解耦，可测；
 *   2. 避免本模块再 require 一堆单例，让依赖关系显式可读。
 *
 * ⚠️ 行为契约（改这里等于改下载行为，务必对照既有测试与实测）：
 *   - 并发数动态读 prefs.concurrency（1..10，越界回落 3）；
 *     单平台并发另受 prefs.perSourceConcurrency 钳制（默认 2，越界回落 2，
 *     且不超过全局 concurrency）—— 同源齐发最易触发平台风控/封 IP；
 *   - done 任务保留上限 200，超出按入队顺序淘汰最旧；
 *   - 持久化防抖 500ms + 原子写；done/error 终态绕开防抖立即落盘；
 *   - 仅 HTTP 403/404/410（CDN 签名过期）重试，其余错误直接放弃；
 *   - urlInfo.fatal=true（VIP/登录/无流）直接短路，不消耗重试配额；
 *   - 重启时 downloading → error；pending 超 24h → error。
 */

const path = require('path');
const fs = require('fs');

const logger = require('../utils/logger');
const prefs = require('../utils/prefs');
const historyDefault = require('../utils/history');
const fsaDefault = require('../utils/fsAsync');
const downloaderDefault = require('../utils/downloader');
const { renderFileName, DEFAULT_TEMPLATE } = require('../utils/naming');
const { planDownloadDir, activePathTemplate } = require('../utils/downloadPath');
const { MUSIC_DIR_NAME } = require('../shared/downloadDefaults');
const speedMeter = require('./speedMeter');
const diskSpace = require('./diskSpace');
const { atomicWriteJson, safeReadJson } = require('../utils/atomicFile');
const { sidecarPathFor } = require('../utils/relinkRefs');
// 传输失败的判据与码表家在 src/shared/netClass.js：这里只是消费方，
// 本地不再抄一份"什么算网络问题"——那份在更新器和传输层各有一份，三份必然漂。
const { transportCode } = require('../shared/netClass');

/** done 任务保留上限：超出的最旧记录淘汰，防止 queue.json 长期使用无限增长 */
const MAX_DONE_RETAINED = 200;
/** 重启时 pending 超过该时长未启动则标记失败，避免永久阻塞「加入新歌单」 */
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
/** 单曲最大尝试次数默认值（含首次）——用户可用 prefs.maxAttempts（1..5）覆盖 */
const MAX_RETRY = 2;
/** 重试前的退避等待（毫秒） */
const RETRY_BACKOFF_MS = 500;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/** 队列条目合法状态（与调度器/UI 共用同一词汇表） */
const QUEUE_STATUSES = new Set(['pending', 'downloading', 'done', 'error']);
/**
 * 恢复时的条目数上限。纯粹防「被写坏/被伪造的 queue.json 撑爆内存」——
 * 正常用户量级远低于此值，触顶只会在日志里留一条 warn。
 */
const MAX_RESTORED_TASKS = 20000;

/**
 * 清洗文件名（去掉路径分隔符与非法字符，限长 200）
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 200);
}

/**
 * 校验并归一化一条从磁盘恢复的任务。
 *
 * 2026-09 审计 P1：旧实现只判了「顶层是数组」就逐条 `delete item._processing`，
 * 一旦数组里混进 null / 字符串 / 缺 status 的脏对象，delete 就会抛
 * TypeError，整批恢复随之中止 —— 一条坏记录等于整个队列丢失。
 *
 * 判据刻意只认「下游真的会用到」的三件事：普通对象、有 id、status 在词汇表内。
 * 其余字段（saveDir/quality/url/…）原样保留：它们各自有消费侧的兜底，
 * 这里收紧反而会把老队列里合法的历史字段清掉。
 *
 * @returns {Object|null} 合法返回原条目（已剔除瞬态标记），非法返回 null
 */
function sanitizeRestoredTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, status } = raw;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof status !== 'string' || !QUEUE_STATUSES.has(status)) return null;
  // 瞬态调度标记不应跨重启存活（持久化文件可能携带）
  delete raw._processing;
  delete raw._cancelRequested;
  return raw;
}

/**
 * 创建下载队列引擎。
 *
 * @param {Object} deps
 * @param {() => (string|null)} deps.userDataDir  用户数据目录（惰性，app ready 后才有值）
 * @param {(channel:string, payload:any) => void} deps.safeSend 推送渲染层
 * @param {(song:Object, quality:string) => Promise<Object>} deps.getDownloadUrlSmart 智能取流（含换源）
 * @param {(id:string, source:string, title:string, artist:string) => Promise<{lrc:string}>} deps.getLyrics
 * @param {() => (void|Promise<void>)} [deps.onQueueChanged] 队列变更后的额外回调（如托盘更新）
 * @param {Object} [deps.notifier] 桌面通知能力 { notifyDownloadDone(song, savePath) }
 * @param {Object} [deps.history] 下载历史模块（默认 utils/history；注入便于单测）
 * @param {Object} [deps.fsa] 异步文件工具（默认 utils/fsAsync）
 * @param {Object} [deps.downloader] 下载器（默认 utils/downloader），需含 downloadFileWithRetry / embedId3Tags
 * @param {(dir:string) => boolean} [deps.isSaveDirAllowed] C1: 渲染层传入 saveDir 的沙箱校验（默认不限制，单测用）
 * @param {() => string} [deps.getDefaultDownloadDir] 未设 prefs.saveDir 时的默认下载目录
 *   （必须与 get-default-dir 展示给 UI 的值同源；缺省回落 userData，仅单测路径）
 * @returns {Object} 引擎实例
 */
function createDownloadQueueEngine({
  userDataDir,
  safeSend,
  getDownloadUrlSmart,
  getLyrics,
  onQueueChanged,
  isSaveDirAllowed,
  getDefaultDownloadDir,
  notifier,
  history = historyDefault,
  fsa = fsaDefault,
  downloader = downloaderDefault,
} = {}) {
  if (typeof userDataDir !== 'function') throw new Error('[DownloadQueue] 必须注入 userDataDir');
  if (typeof safeSend !== 'function') throw new Error('[DownloadQueue] 必须注入 safeSend');
  if (typeof getDownloadUrlSmart !== 'function') throw new Error('[DownloadQueue] 必须注入 getDownloadUrlSmart');
  if (typeof getLyrics !== 'function') throw new Error('[DownloadQueue] 必须注入 getLyrics');
  const { downloadFileWithRetry, embedId3Tags } = downloader;
  if (typeof downloadFileWithRetry !== 'function') throw new Error('[DownloadQueue] downloader 缺少 downloadFileWithRetry');

  // ── 状态（引擎私有，通过 getter 暴露）────────────────────
  const downloadQueue = [];
  const speedStates = {}; // taskId → 速度采样状态（瞬态，任务终态即删）
  let activeDownloads = 0;
  let processTimer = null;
  let _processQueueRunning = false;
  let _paused = false;
  let queuePersistTimer = null;

  const QUEUE_FILE = () => path.join(userDataDir(), 'queue.json');

  /** 读取并发数（1..10，越界回落 3；设置变更实时生效） */
  function getConcurrency() {
    try {
      const v = prefs.get('concurrency');
      return (v >= 1 && v <= 10) ? v : 3;
    } catch (_e) {
      return 3;
    }
  }

  /**
   * 单平台并发上限（perSourceConcurrency，默认 2，越界回落 2）。
   * 钳制到全局 concurrency 之内 —— 只会比全局更紧，不会更松。
   * 动机：批量下载同源歌单时全部 worker 打同一 CDN 是最易触发风控/封 IP 的形态。
   */
  function getPerSourceCap() {
    let cap;
    try {
      const v = prefs.get('perSourceConcurrency');
      cap = (v >= 1 && v <= 10) ? v : 2;
    } catch (_e) {
      cap = 2;
    }
    return Math.min(cap, getConcurrency());
  }

  /**
   * 单曲最大尝试次数（含首次；prefs.maxAttempts，1..5，越界回落 MAX_RETRY）。
   * 每首歌协程启动时快照一次——下载中途改设置不回溯影响在途任务。
   */
  function getMaxAttempts() {
    try {
      const n = Number(prefs.get('maxAttempts'));
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : MAX_RETRY;
    } catch (_e) {
      return MAX_RETRY;
    }
  }

  /** 某请求源当前在途任务数（从队列状态派生，不另立计数器避免漂移） */
  function activeCountBySource(source) {
    let n = 0;
    for (const s of downloadQueue) {
      if (s && s.status === 'downloading' && s.source === source) n++;
    }
    return n;
  }

  /** 取下一个可调度任务：pending 且协程不在途、其平台未到并发上限（按队列顺序即展示顺序） */
  function pickSchedulable(cap) {
    for (const s of downloadQueue) {
      if (!s || s.status !== 'pending' || s._processing) continue;
      if (activeCountBySource(s.source) < cap) return s;
    }
    return null;
  }

  /** 淘汰超出保留上限的最旧 done 任务（队列顺序即展示顺序） */
  function trimDoneTasks() {
    const doneCount = downloadQueue.filter(s => s && s.status === 'done').length;
    if (doneCount <= MAX_DONE_RETAINED) return;
    let toDrop = doneCount - MAX_DONE_RETAINED;
    for (let i = 0; i < downloadQueue.length && toDrop > 0;) {
      if (downloadQueue[i] && downloadQueue[i].status === 'done') {
        downloadQueue.splice(i, 1);
        toDrop--;
      } else {
        i++;
      }
    }
  }

  /** 队列变更统一出口：推送 + 持久化 + 额外回调；immediate=true 跳过防抖（终态用） */
  function notifyQueueChanged(immediate) {
    safeSend('queue-updated', downloadQueue);
    persistQueue({ immediate: !!immediate });
    if (typeof onQueueChanged === 'function') {
      try {
        onQueueChanged();
      } catch (e) {
        logger.warn('[DownloadQueue] onQueueChanged 回调失败:', e.message);
      }
    }
  }

  /** 立即整写队列文件（trim + 原子写）；异常吞掉并记日志 */
  function writeQueueNow() {
    try {
      trimDoneTasks();
      atomicWriteJson(QUEUE_FILE(), downloadQueue);
    } catch (e) {
      logger.warn('队列持久化失败:', e.message);
    }
  }

  /**
   * 持久化：默认 500ms 防抖合并（进度/入队等高频变更）；
   * { immediate: true } 用于 done/error **终态** —— 终态丢在防抖窗口里
   * 意味着崩溃后「已完成的任务消失 / 回到下载中」，必须绕开防抖立即落盘。
   */
  function persistQueue(opts) {
    if (opts && opts.immediate) {
      if (queuePersistTimer) {
        clearTimeout(queuePersistTimer);
        queuePersistTimer = null;
      }
      writeQueueNow();
      return;
    }
    if (queuePersistTimer) return;
    queuePersistTimer = setTimeout(() => {
      queuePersistTimer = null;
      writeQueueNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 启动时加载队列（异常关闭后恢复；损坏文件备份 .bak 后放弃） */
  async function loadPersistedQueue() {
    try {
      const res = safeReadJson(QUEUE_FILE());
      if (!res.ok) {
        logger.warn('队列文件损坏，已备份为 queue.json.bak，从空队列恢复');
        return;
      }
      if (res.empty) return;
      const list = res.data;
      if (!Array.isArray(list)) return;
      // 重启时：downloading 视为异常关闭 -> error
      //         pending 超过 1 天没动 -> error（避免阻塞"加入新歌单"）
      //         pending 不到 1 天 / error / done -> 保留
      const now = Date.now();
      let dropped = 0;
      for (const raw of list) {
        if (downloadQueue.length >= MAX_RESTORED_TASKS) { dropped++; continue; }
        // 逐条校验：一条脏记录只丢它自己，绝不中止整批恢复
        const item = sanitizeRestoredTask(raw);
        if (!item) { dropped++; continue; }
        if (item.status === 'downloading') {
          item.status = 'error';
          item.error = '应用异常关闭，请重试';
        } else if (item.status === 'pending' && item.addedAt && (now - item.addedAt > STALE_PENDING_MS)) {
          item.status = 'error';
          item.error = '排队超过 24 小时未启动，已标记失败（可重试）';
        }
        downloadQueue.push(item);
      }
      if (dropped) {
        logger.warn(`[Queue] 丢弃 ${dropped} 条非法/超限队列条目（其余 ${downloadQueue.length} 条照常恢复）`);
      }
      if (downloadQueue.length) {
        logger.log(`[Queue] 从磁盘恢复 ${downloadQueue.length} 个任务`);
      }
    } catch (e) {
      logger.warn('队列加载失败:', e.message);
    }
  }

  /**
   * 处理单个下载任务（含重试循环 + 致命错误短路）。
   * _processing 标记协程全程在途（含 403 重试退避窗口，此时 status 是 pending），
   * 调度器据此跳过，杜绝同一首歌两个协程并发写同一目标文件（审计 H1）。
   */
  async function processOneSong(song) {
    song._processing = true;
    try {
      return await _processOneSongInner(song);
    } finally {
      song._processing = false;
    }
  }

  async function _processOneSongInner(song) {
    let lastError = null;
    let isFatal = false;
    const cancelToken = String(song.taskId || song.id);
    const maxAttempts = getMaxAttempts(); // 逐曲快照，中途改设置不影响在途任务

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 取消 / 任务已被移出队列（如重试等待期被 splice）→ 终止协程，不再取流落盘
      if (song._cancelRequested || !downloadQueue.includes(song)) {
        lastError = Object.assign(new Error('下载已取消'), { cancelled: true });
        break;
      }
      try {
        logger.log(`[processOneSong] ▶ ${song.source} "${song.title}" - "${song.artist}" id=${song.id} quality=${song.quality || 'standard'}`);
        const urlInfo = await getDownloadUrlSmart(song, song.quality || 'standard');
        logger.log('[processOneSong]   urlInfo keys =', urlInfo ? Object.keys(urlInfo).join(',') : 'null', 'hasUrl =', !!(urlInfo && urlInfo.url));
        if (!urlInfo || !urlInfo.url) {
          // 修复 B7：fatal 错误（VIP/Auth/Audio 流缺失）直接退出，不进重试循环
          if (urlInfo?.fatal) {
            isFatal = true;
            lastError = new Error(urlInfo.error || '无法获取下载链接');
            song.errorCode = urlInfo.code || 'UNKNOWN';
            logger.warn(`[processOneSong] ✗ ${song.source} ${song.title} - ${song.artist} 失败: ${lastError.message} (code=${urlInfo.code})`);
            break;
          }
          throw new Error(urlInfo?.error || '无法获取下载链接');
        }
        // 换源成功：记回歌曲供下次直试 + 队列可见（文件名仍用原歌信息）
        if (urlInfo.matchedSong) {
          song._altSource = { source: urlInfo.matchedSong.source, id: String(urlInfo.matchedSong.id) };
          logger.log(`[processOneSong] ↻ 已换源: ${urlInfo.matchedFrom} → ${urlInfo.matchedSong.source}`);
          notifyQueueChanged();
        }

        const ext = (urlInfo.ext || 'mp3').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10) || 'mp3';
        // 命名模板：从 preferences 读取，支持 {title} {artist} {album} {source} {id}
        const namingTemplate = prefs.get('namingTemplate') || DEFAULT_TEMPLATE;
        // saveDir 兜底：用户从未选过下载目录时渲染层传 null，path.join(null) 直接
        // 崩溃（必现 "The path argument must be of type string. Received null"）。
        // C1: 渲染层可整包传入 song.saveDir —— 未经用户批准的目录（XSS 场景）
        // 一律回落到 prefs/默认目录，防任意路径写文件（queue.json 也会持久化它）
        let songSaveDir = song.saveDir || null;
        if (songSaveDir && typeof isSaveDirAllowed === 'function' && !isSaveDirAllowed(songSaveDir)) {
          logger.warn('[processOneSong] 拒绝未批准 saveDir，回落默认目录:', songSaveDir);
          songSaveDir = null;
        }
        const saveDir = songSaveDir || prefs.get('saveDir')
          || (typeof getDefaultDownloadDir === 'function' ? getDefaultDownloadDir()
            : path.join(userDataDirSafe(), MUSIC_DIR_NAME));
        // 路径模板：设置页那个「使用中」的下载模板决定这首歌落在根目录的哪一层。
        // 它曾经只写不读（死开关），现在由 planDownloadDir 规划 —— 规划不出来时
        // 一律落回根目录，绝不让「目录没算好」变成「下载失败」。
        const dirPlan = planDownloadDir(
          activePathTemplate(prefs.get('downloadTemplates'), prefs.get('activeDownloadTemplate')),
          saveDir, song);
        if (!dirPlan.applied && dirPlan.reason && dirPlan.reason !== 'no-template') {
          logger.warn('[processOneSong] 路径模板未生效，落回根目录:', dirPlan.reason);
        }
        // 落盘前的最后一道沙箱复核（审计 P1-7）。上面 359 行只判了**根目录**，
        // 模板渲染出来的子目录此前一次都没判过就 mkdir recursive —— 根目录里的
        // 一个链接就能把写入甩到沙箱外。判据与根目录同源（isSaveDirAllowed 就是
        // approvedDirs.isApprovedDir，内含词法快筛 + realpath 复核）。
        // 复核不过就退回根目录：根目录已经过了 359 行，下载照常进行 ——
        // 「目录不安全」不能变成「下载失败」。
        // 在同一个对象上改写而不是另起 finalDir：savePath / mkdir / statfs
        // 三处都读 dirPlan.dir，同一个名字才保证「三处同源」，改名会让人漏改一处。
        if (typeof isSaveDirAllowed === 'function' && !isSaveDirAllowed(dirPlan.dir)) {
          logger.warn('[processOneSong] 落盘目录未过沙箱复核，退回根目录:', dirPlan.dir);
          dirPlan.dir = saveDir;
          dirPlan.applied = false;
          dirPlan.reason = 'outside-save-dir';
        }
        const savePath = path.join(dirPlan.dir, sanitizeFilename(renderFileName(namingTemplate, song, ext)));

        await fs.promises.mkdir(dirPlan.dir, { recursive: true }).catch(e => {
          logger.warn('[processOneSong] 创建下载目录失败:', dirPlan.dir, e.message);
        });

        // 容量预检：磁盘快满时提前给出人话错误（否则写出半截文件才 ENOSPC）。
        // statfs 不可用/出错一律放行，绝不因预检本身挡下载。
        if (typeof fs.promises.statfs === 'function') {
          try {
            const verdict = diskSpace.diskVerdict(
              diskSpace.availFromStatfs(await fs.promises.statfs(dirPlan.dir)), song.quality);
            if (!verdict.ok) {
              throw Object.assign(
                new Error(diskSpace.diskShortageMessage(
                  { availBytes: verdict.availBytes, neededBytes: diskSpace.estimateSongBytes(song.quality) }, song.quality)),
                { diskShortage: true });
            }
          } catch (e) {
            if (e.diskShortage) throw e;
            logger.warn('[processOneSong] statfs 失败，跳过容量预检:', e.message);
          }
        }

        // 修复 B8：携带 extraHeaders（Referer 等），downloadFile 内部重定向会递归传递
        // B 站 DASH CDN 要求 Referer: https://www.bilibili.com/，否则可能 403
        const extraHeaders = urlInfo.referer ? { 'Referer': urlInfo.referer } : {};
        // 读取限速设置（KB/s → bytes/s）
        const speedLimitKB = prefs.get('speedLimit') || 0;
        const speedLimit = speedLimitKB > 0 ? speedLimitKB * 1024 : 0;
        await downloadFileWithRetry(urlInfo.url, savePath, (progress, bytes) => {
          // 取消后底层回调可能迟到一拍：不得再写进度/推送事件（UI 闪烁来源）
          if (song._cancelRequested) return;
          song.progress = progress;
          const payload = { id: song.taskId, progress };
          if (bytes) {
            const r = speedMeter.nextSpeed(speedStates[song.taskId], Date.now(), bytes.receivedBytes, bytes.totalBytes);
            speedStates[song.taskId] = r.state;
            payload.receivedBytes = bytes.receivedBytes;
            payload.totalBytes = bytes.totalBytes || null;
            payload.speedBps = r.speedBps;
            payload.etaSec = r.etaSec;
          }
          safeSend('download-progress', payload);
        }, extraHeaders, { speedLimit, token: cancelToken });

        // 歌词（换源成功时优先用匹配源的 id 同源拿，更准）
        let lrc = '';
        try {
          const lyricId = urlInfo.matchedSong ? urlInfo.matchedSong.id : song.id;
          const lyricSource = urlInfo.matchedSong ? urlInfo.matchedSong.source : song.source;
          const lyricsResult = await getLyrics(lyricId, lyricSource, song.title, song.artist);
          lrc = lyricsResult.lrc || '';
        } catch (_e) { /* 歌词获取失败不影响下载 */ }

        // ID3 标签（修复 B6：embedId3Tags 内部只对 mp3 生效，跳过 m4a/flac）
        await embedId3Tags(savePath, {
          title: song.title,
          artist: song.artist,
          album: song.album || '',
          coverUrl: song.cover,
          lrc,
        });

        // LRC 歌词文件（独立 try-catch：写歌词失败不应覆盖已成功的下载）
        if (lrc) {
          const lrcPath = sidecarPathFor(savePath);
          fs.promises.writeFile(lrcPath, lrc, 'utf8').catch(lrcErr => {
            logger.warn('[processOneSong] LRC 写入失败（不影响下载结果）:', lrcErr.message);
          });
        }

        song.status = 'done';
        song.progress = 100;
        song.savePath = savePath;
        song.error = null;
        lastError = null;
        delete speedStates[song.taskId];

        // 下载完成通知（默认开启）
        if (prefs.get('notifications') !== false) {
          try {
            if (notifier && typeof notifier.notifyDownloadDone === 'function') {
              notifier.notifyDownloadDone(song, savePath);
            }
          } catch (e) {
            logger.warn('[Notification] 显示失败:', e.message);
          }
        }

        // 写入下载历史（换源成功时记实际取流源，便于排查与统计）
        try {
          const stat = await fsa.statOrNull(savePath);
          history.add({
            id: String(song.id),
            source: urlInfo.matchedSong ? urlInfo.matchedSong.source : song.source,
            matchedFrom: urlInfo.matchedSong ? song.source : undefined,
            title: song.title,
            artist: song.artist || '',
            album: song.album || '',
            savePath,
            ext,
            quality: song.quality || 'standard',
            size: stat ? stat.size : 0,
            duration: song.duration || 0,
            status: 'done',
            finishedAt: Date.now(),
          });
        } catch (e) {
          logger.warn('[history.add] 写历史失败:', e.message);
        }
        return; // 成功，退出函数
      } catch (e) {
        lastError = e;
        const msg = e.message || String(e);
        const isRetriable = /HTTP\s*(403|404|410)/i.test(msg);
        logger.warn(`下载失败 (尝试 ${attempt}/${maxAttempts}):`, msg);

        // 只对 403/404/410 重试（CDN URL 签名过期，重拿 URL 再下），其他错误直接放弃
        if (attempt < maxAttempts && isRetriable) {
          song.status = 'pending';
          song.progress = 0;
          notifyQueueChanged();
          await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        break; // 不可重试或重试用尽
      }
    }

    if (lastError) {
      song.status = 'error';
      song.error = lastError.message;
      song._cancelRequested = false;
      delete speedStates[song.taskId];
      if (lastError.cancelled) {
        // 用户主动取消：不写失败历史、不发 download-error toast
        // 终态立即落盘（不能依赖调度器 .finally —— 微任务时序下 waitFor
        // 观察到终态时可能尚未落盘；且防抖窗口内崩溃会丢取消终态）
        notifyQueueChanged(true);
        return;
      }
      // 传输层失败（断网/超时）在这里补上码。改造前 errorCode 只有
      // 「取流返回 fatal」那一条路会写，于是断网跑完的任务是个无码红条 —— 队列与
      // 历史都不戴徽标（徽标只认码）、诊断只会说「未分类的失败」、渲染层也无从知道
      // 「这些红条是在等网络恢复」。码补齐后这三件事同时成立。
      // 取流层已写好的码更准（VIP/登录/无流），不被传输层的判断覆盖。
      if (!song.errorCode) {
        const netCode = transportCode(lastError);
        if (netCode) song.errorCode = netCode;
      }
      // 写历史：失败
      try {
        history.add({
          id: String(song.id),
          source: song.source,
          title: song.title,
          artist: song.artist || '',
          album: song.album || '',
          savePath: '',
          ext: '',
          quality: song.quality || 'standard',
          size: 0,
          duration: song.duration || 0,
          status: 'error',
          error: lastError.message,
          // 取流侧的分类码一起落盘，历史行的 🆘 才不必退回关键词去猜。
          // 无码留 undefined（JSON 直接丢键，不写空串伪码）；history.add 是
          // {...existing, ...entry} 合并写，所以"这次没码"会覆盖"上次的码"，不留陈旧值。
          errorCode: song.errorCode || undefined,
          finishedAt: Date.now(),
        });
      } catch (e) {
        logger.warn('[history.add] 写历史失败:', e.message);
      }
      // 修复 B7：通知前端标记 fatal，前端可弹更友好的 toast（如"该歌曲需要 VIP"）
      safeSend('download-error', {
        id: song.taskId || song.id,
        title: song.title,
        artist: song.artist,
        error: lastError.message,
        fatal: isFatal,
      });
      // error 终态立即落盘（同 cancelled —— 不能依赖调度器 .finally 的微任务时序）
      notifyQueueChanged(true);
    }
  }

  /** userDataDir 的安全访问（未 ready 时回落临时目录，避免 path.join(null) 崩溃） */
  function userDataDirSafe() {
    try {
      return userDataDir() || require('os').tmpdir();
    } catch (_e) {
      return require('os').tmpdir();
    }
  }

  /**
   * 调度下载队列（最多并发 N 首，N 动态读 prefs）
   * _processQueueRunning 防止重入，避免并发调度导致 activeDownloads 计数混乱。
   */
  async function processQueue() {
    if (_paused) return; // 暂停：不调度新任务（在途任务不打断，与取消语义一致）
    if (_processQueueRunning) return;
    _processQueueRunning = true;
    const concurrency = getConcurrency();
    const perSourceCap = getPerSourceCap();
    try {
      while (activeDownloads < concurrency) {
        const song = pickSchedulable(perSourceCap);
        if (!song) break;
        song.status = 'downloading';
        song.error = null;
        song.progress = 0;
        activeDownloads++;
        notifyQueueChanged();
        // 异步处理（不阻塞调度）
        processOneSong(song).finally(() => {
          activeDownloads--;
          // 任务到达终态（done/error/cancelled）：立即落盘，不等防抖 ——
          // 崩溃窗口里丢终态 = 用户看到已完成的任务消失
          notifyQueueChanged(true);
          // 还有 pending 时调度下一批（统一使用 processTimer，避免重复 setTimeout）
          if (downloadQueue.some(s => s.status === 'pending')) {
            if (processTimer) clearTimeout(processTimer);
            processTimer = setTimeout(() => {
              processTimer = null;
              _processQueueRunning = false;
              processQueue();
            }, 100);
          } else {
            _processQueueRunning = false;
          }
        });
      }
    } finally {
      // 如果循环正常结束（没有 pending 歌曲），重置标志
      if (activeDownloads < concurrency) {
        _processQueueRunning = false;
      }
    }
  }

  /**
   * 取消任务（协作式）：下载中置标记 + 打断在途请求；重试等待期（status=pending
   * 但 _processing=true，协程在退避 await 中）只置标记，协程在下一轮循环顶退出。
   * @returns {boolean} 是否命中一个在途任务
   */
  function requestCancel(taskId) {
    const song = downloadQueue.find(s => s.taskId === taskId &&
      (s.status === 'downloading' || (s.status === 'pending' && s._processing)));
    if (!song) return false;
    song._cancelRequested = true;
    if (typeof downloader.cancelDownload === 'function') {
      try { downloader.cancelDownload(String(taskId)); } catch (e) { logger.warn('[requestCancel]', e.message); }
    }
    return true;
  }

  /** 暂停/继续调度：暂停只挡新任务启动；恢复时立即重新调度 */
  function setPaused(v) {
    _paused = !!v;
    if (!_paused) {
      if (processTimer) { clearTimeout(processTimer); processTimer = null; }
      _processQueueRunning = false;
      processQueue();
    }
  }

  return {
    // 状态访问
    getQueue: () => downloadQueue,
    getActiveCount: () => activeDownloads,
    // 持久化
    persistQueue,
    loadPersistedQueue,
    // 调度
    processQueue,
    requestCancel,
    setPaused,
    isPaused: () => _paused,
    // 工具（队列 IPC 需要）
    sanitizeFilename,
    sanitizeRestoredTask,
    /**
     * 退出清理：把待写的队列**立即**落盘，并停掉所有定时器。
     *
     * 为什么需要：persistQueue 是 500ms 防抖 —— 若退出时刚好在防抖窗口内，
     * 最后一次队列变更会丢（用户看到「下完的任务重启后不见了」）。
     * 在 window-all-closed 调用本方法可保证不丢。
     */
    dispose() {
      if (queuePersistTimer) {
        clearTimeout(queuePersistTimer);
        queuePersistTimer = null;
        try {
          trimDoneTasks();
          atomicWriteJson(QUEUE_FILE(), downloadQueue);
        } catch (e) {
          logger.warn('[DownloadQueue] 退出落盘失败:', e.message);
        }
      }
      if (processTimer) {
        clearTimeout(processTimer);
        processTimer = null;
      }
    },
    // 常量（测试与文档引用）
    MAX_DONE_RETAINED,
    MAX_RETRY,
    MAX_RESTORED_TASKS,
    getMaxAttempts,
  };
}

module.exports = {
  createDownloadQueueEngine,
  sanitizeFilename,
  sanitizeRestoredTask,
  MAX_RESTORED_TASKS,
  QUEUE_STATUSES,
};
