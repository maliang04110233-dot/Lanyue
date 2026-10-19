/**
 * playback/wire.js — 播放引擎的生产接线（阶段 3 · P0）
 *
 * 职责边界
 * --------
 * 本文件是**唯一**把 playback/engine.js 接进生产链路的地方。
 * 引擎本身（engine.js）保持零依赖、零 DOM、可单测；它不知道自己被谁创建。
 * 这里负责把「渲染层已有的能力」注入给引擎：
 *
 *   resolveTrack  ← api.getDownloadUrlSmart（下载/播放共用的取流 + 换源）
 *   proxyPlay     ← api.proxyPlay（stream:// 流式代理注册）
 *   saveProgress  ← player/progressStore 的串行写入器（复用，不重造）
 *   loadProgress  ← prefs 的 playProgressMap（与 player.js:180 同一口径）
 *
 * 为什么进度记忆要复用 progressStore 而不是直接调 api.setPref
 * -------------------------------------------------------------
 * playProgressMap 是「读 → 改 → 整体写回」的结构，三个写者（30s 自动保存 /
 * 暂停 / 播完写 0）不排队就会用陈旧快照互相覆盖。player/progressStore.js 的
 * createProgressWriter 已经用串行队列解决了这件事，并有单测。重造一份必然漂移。
 *
 * 阶段 3 的推进方式
 * ----------------
 * P0 只创建实例、**不接管任何调用方**。此时引擎收到的事件全部来自 audio 元素，
 * 但没有任何模块订阅它、也没有模块调它的方法 —— 对用户可见行为零影响。
 * 后续 P1-P5 逐个把调用方接过来，每一步都单独可回滚。
 */

import { createPlaybackEngine } from './engine.js';
import { createProgressWriter } from '../player/progressStore.js';

/** 进度记忆的 key 口径，必须与 player.js:166 逐字一致，否则会读到两份互不相认的记录 */
function playProgressKey(song) {
  return song.filePath || `${song.source}:${song.id}`;
}

/**
 * 创建并接线一个生产用播放引擎实例。
 *
 * @param {object} deps
 * @param {HTMLAudioElement} deps.audio   #audioPlayer 元素（由 app.js 从 DOM 取一次）
 * @param {object} deps.api               渲染层 preload 桥（window.musicAPI）
 * @param {object|null} [deps.logger]
 * @returns {object} 引擎实例
 */
export function createWiredPlaybackEngine({ audio, api, logger = null }) {
  if (!audio) throw new Error('[playback/wire] 缺少 audio 元素');
  if (!api || typeof api !== 'object') throw new Error('[playback/wire] 缺少 api 桥');

  // 与 player.js:171-174 同一份实现：串行队列 + 容量上限 + 开关判断
  const progressWriter = createProgressWriter({
    getPref: (k) => api.getPref(k),
    setPref: (k, v) => api.setPref(k, v),
  });

  const engine = createPlaybackEngine({
    audio,

    // 取流：复用既有智能取流（本源失败自动换源）。
    // 引擎只关心「拿到一个能播的 url」，换源策略留在 api 层，不在这里复刻。
    resolveTrack: (song, quality) => api.getDownloadUrlSmart(song, quality),

    // 流式代理：把上游直链注册成 stream:// 地址，让 <audio> 支持 Range/seek
    proxyPlay: (url, referer, refresh) => api.proxyPlay(url, referer, refresh),

    saveProgress: (song, seconds) => progressWriter.save(playProgressKey(song), seconds),

    // 读回口径与 player.js:180-190 一致：开关关闭则 0；前 3 秒视为没听过
    loadProgress: async (song) => {
      try {
        const enabled = await api.getPref('playProgressMemory');
        if (!enabled) return 0;
        const map = (await api.getPref('playProgressMap')) || {};
        const entry = map[playProgressKey(song)];
        return entry && entry.time > 3 ? entry.time : 0;
      } catch (_e) {
        return 0;
      }
    },

    logger,
  });

  return engine;
}
