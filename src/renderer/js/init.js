/**
 * MusicDL 播放队列持久化接线
 *
 * 持久化接线的家（自 app.js init() 内闭包提出，等价迁移）：
 *   - playQueueRestored 事件监听（主进程启动时推送）
 *   - playQueue / playIdx / loopMode / isShuffled 四个订阅自动保存
 *   - 启动时从主进程加载已持久化队列（兜底）
 *
 * 纯函数 persistPlayQueue 保留原样（快捷键/托盘的直接兜底入口）。
 * api 由调用方（app.js init 开头 buildApi() 之后）显式传入。
 */

import { getState } from './state.js';
import { restorePlayQueueFromSaved } from './player-sync.js';
import { sanitizeSavedQueue } from './dropPlay.js';
import { logger } from './logger.js';

// ── 持久化播放队列 ─────────────────────────────────────
function persistPlayQueue() {
  const queue = getState('playQueue');
  const playIdx = getState('playIdx');
  const loopMode = getState('loopMode');
  const isShuffled = getState('isShuffled');
  api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(() => {});
}

export function wirePlayQueuePersistence(api) {
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
  return loadPersistedPlayQueue(api);
}

async function loadPersistedPlayQueue(api) {
  try {
    const saved = await api.loadPlayQueue();
    restorePlayQueueFromSaved(sanitizeSavedQueue(saved));
  } catch (e) {
    logger.warn('[init] 加载播放队列失败:', e.message);
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  persistPlayQueue,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.persistPlayQueue = persistPlayQueue;
