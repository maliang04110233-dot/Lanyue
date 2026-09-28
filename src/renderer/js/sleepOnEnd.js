/**
 * 睡眠「播完当前歌曲再停」——一次性闩
 *
 * 与分钟级睡眠定时互补：分钟定时管"到点"，本闩管"这首放完"。
 * 之所以做成消耗型一次性闩而不是开关：自然停止（播完）即完成使命，
 * 若留着不消，下次手点播放又会莫名停掉，比不响更糟。
 *
 * 纯工厂，DOM / 播放器全部由调用方注入，node 可直测。
 */

import { logger } from './logger.js';

/**
 * @param {Object} deps
 * @param {() => void} [deps.onFire] 闩命中时的副作用（弹层/停播由调用方决定）
 */
function createEndStop({ onFire } = {}) {
  let armed = false;

  return {
    arm() { armed = true; },
    cancel() { armed = false; },
    active() { return armed; },

    /**
     * 歌曲自然结束入口。
     * @returns {boolean} true = 本次结束归本闩收口（调用方不要再切下一首/单曲循环）
     */
    consume() {
      if (!armed) return false;
      armed = false; // 先落闩再回调：onFire 里若再触发 ended 也不会重复收口
      try {
        if (onFire) onFire();
      } catch (e) {
        logger.warn('[sleepOnEnd] onFire 失败:', e && e.message);
      }
      return true;
    },
  };
}

export { createEndStop };
