/**
 * 播放队列持久化。
 *
 * 从 main/index.js 拆出（阶段 3 主进程模块化）：把「渲染层播放队列 →
 * 防抖落盘 / 启动恢复」这条链路独立成模块。依赖面很窄（app / path /
 * atomicWriteJson / safeReadJson / logger），不碰窗口、托盘与 IPC 注册，
 * 因此可脱离 Electron 主入口单独阅读。
 *
 * 落盘走 500ms 防抖；退出路径必须调 flushPlayQueueNow() 立即冲刷，
 * 否则防抖窗口内的最后一次变更会丢（见 index.js 的 window-all-closed）。
 */
const { app } = require('electron');
const path = require('path');
const { atomicWriteJson, safeReadJson } = require('../utils/atomicFile');
const logger = require('../utils/logger');

let playQueuePersistTimer = null;
const PLAY_QUEUE_FILE = () => path.join(app.getPath('userData'), 'play-queue.json');

let _pendingPlayQueueData = null;

function persistPlayQueue(data) {
  _pendingPlayQueueData = data;
  if (playQueuePersistTimer) return;
  playQueuePersistTimer = setTimeout(flushPlayQueueNow, 500);
}

/** 立即落盘挂起的播放队列（退出时防抖窗口内的变更不能丢）。函数内会清掉防抖定时器。 */
function flushPlayQueueNow() {
  if (playQueuePersistTimer) { clearTimeout(playQueuePersistTimer); playQueuePersistTimer = null; }
  const latest = _pendingPlayQueueData;
  _pendingPlayQueueData = null;
  if (!latest) return;
  try {
    // latest = { queue: [...], playIdx: number }
    const queue = Array.isArray(latest?.queue) ? latest.queue : [];
    // 剔除 data: 协议的 cover（base64 数据极大，恢复后 player loadAndPlay 会重新获取）
    const clean = queue.map(song => {
      if (!song) return song;
      const s = { ...song };
      if (typeof s.cover === 'string' && s.cover.startsWith('data:')) {
        delete s.cover;
      }
      return s;
    });
    const payload = {
      queue: clean,
      playIdx: typeof latest?.playIdx === 'number' ? latest.playIdx : -1,
      loopMode: typeof latest?.loopMode === 'number' ? latest.loopMode : 0,
      isShuffled: !!latest?.isShuffled,
      updatedAt: Date.now(),
    };
    atomicWriteJson(PLAY_QUEUE_FILE(), payload);
  } catch (e) {
    logger.warn('播放队列持久化失败:', e.message);
  }
}

async function loadPersistedPlayQueue() {
  try {
    const fp = PLAY_QUEUE_FILE();
    const res = safeReadJson(fp);
    if (!res.ok) {
      logger.warn('播放队列文件损坏，已备份为 play-queue.json.bak，忽略恢复');
      return null;
    }
    if (res.empty) return null;
    const obj = res.data;
    if (!obj || !Array.isArray(obj.queue)) return null;
    logger.log(`[PlayQueue] 从磁盘恢复 ${obj.queue.length} 首歌曲`);
    return { queue: obj.queue, playIdx: obj.playIdx, loopMode: obj.loopMode, isShuffled: obj.isShuffled, updatedAt: obj.updatedAt };
  } catch (e) {
    logger.warn('播放队列加载失败:', e.message);
    return null;
  }
}

module.exports = { persistPlayQueue, flushPlayQueueNow, loadPersistedPlayQueue };
