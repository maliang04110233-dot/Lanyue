/**
 * 播放队列持久化（从 index.js 拆出）
 *
 * 职责：防抖落盘 + 启动恢复 + 退出冲刷
 *
 * 依赖注入：
 *   getUserDataDir() —— 主进程 userData 路径 getter（app.getPath('userData')）
 *   atomicWriteJson  —— 原子写文件（从 utils/atomicFile.js 导入）
 *   safeReadJson     —— 安全读文件（带损坏备份，从 utils/atomicFile.js 导入）
 */

const path = require('path');
const logger = require('../utils/logger');
const { atomicWriteJson, safeReadJson } = require('../utils/atomicFile');

module.exports = function createPlayQueueStore({ getUserDataDir }) {
  let persistTimer = null;
  let pendingData = null;

  function queueFile() {
    return path.join(getUserDataDir(), 'play-queue.json');
  }

  /** 防抖落盘：500ms 内多次调用只落盘最后一次 */
  function persist(data) {
    pendingData = data;
    if (persistTimer) return;
    persistTimer = setTimeout(flush, 500);
  }

  /** 立即落盘（退出时冲刷防抖窗口内的最后一次变更） */
  function flush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    const latest = pendingData;
    pendingData = null;
    if (!latest) return;
    try {
      const queue = Array.isArray(latest?.queue) ? latest.queue : [];
      const clean = queue.map(song => {
        if (!song) return song;
        const s = { ...song };
        if (typeof s.cover === 'string' && s.cover.startsWith('data:')) {
          delete s.cover; // data: 协议的 cover base64 极大，恢复后 player loadAndPlay 会重新获取
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
      atomicWriteJson(queueFile(), payload);
    } catch (e) {
      logger.warn('播放队列持久化失败:', e.message);
    }
  }

  /** 启动时恢复播放队列（损坏文件备份 .bak 后放弃） */
  async function load() {
    try {
      const fp = queueFile();
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

  /** 退出清理：冲刷挂起变更 + 清定时器 */
  function dispose() {
    flush();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  }

  return { persist, flush, load, dispose };
};
