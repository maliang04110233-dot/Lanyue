/**
 * playback/audioPool.js — 音频实例池（交叉淡入淡出的基础设施）
 *
 * 目标
 * ----
 * 交叉淡入淡出需要**两个** <audio> 实例同时存在：一个在放、一个在预载下一首。
 * 本模块负责提供这两个实例，并保证：
 *
 *   1. 每个元素的音频图（MediaElementSource → EQ → Gain → destination）
 *      **只建一次**。createMediaElementSource 对同一元素第二次调用会抛
 *      InvalidStateError；旧 eq.js 用 try/catch 吞掉，表现为「EQ 明明开了
 *      却没效果，控制台一行报错都没有」（见 engine.js:502-506 的事故记录）。
 *      所以这里用**显式**幂等标志，绝不靠 try/catch 兜。
 *
 *   2. 两个实例**共享同一个 AudioContext**。两个 context 会让 EQ 开关、
 *      频谱、Media Session 的状态分裂成两份，且主进程关窗时需要释放两个。
 *
 *   3. 图按**元素**缓存，不按实例 id 缓存 —— 实例可能被回收重建，
 *      而元素一旦建过图就不能再建。
 *
 * 零 DOM 依赖
 * ----------
 * 与 engine.js 同一条铁律：模块内不出现 document / window，
 * 音频元素与 AudioContext 全部由构造参数注入。这样它能在 node:test 里
 * 被直接单测（见 test/playback-crossfade.test.js）。
 *
 * 与 engine.js 的分工
 * ------------------
 * engine.js 是「<audio> 的唯一所有者」，本模块是「<audio> 的持有者」。
 * engine.js 通过 pool 拿实例，pool 不知道 engine 的存在。
 */

import { EQ_BANDS } from './eqBands.js';

/** 池内实例的固定身份。primary 是常驻实例，secondary 是交叉淡入淡出的预载位。 */
export const INSTANCE_IDS = Object.freeze(['primary', 'secondary']);

/**
 * 图装配失败时抛出的错误，带上足够定位的信息。
 * 刻意不吞：调用方（engine.js）负责决定「返回 null 并 warn」还是「降级」。
 */
export class AudioGraphError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AudioGraphError';
    this.cause = cause;
  }
}

/**
 * 创建单实例池（兼容既有 createPlaybackEngine({ audio }) 调用方）。
 *
 * @param {HTMLAudioElement} audio
 * @returns {object} 池实例
 */
export function createSingleInstancePool(audio) {
  if (!audio) throw new Error('[audioPool] 缺少 audio 元素');
  return createAudioPool({
    elements: { primary: audio },
  });
}

/**
 * 创建音频实例池。
 *
 * @param {object} deps
 * @param {Record<string, HTMLAudioElement>} deps.elements  实例 id → 元素
 * @param {Function|null} [deps.audioContextFactory]  AudioContext 工厂（测试注入假工厂）
 * @param {object|null} [deps.logger]                  日志器
 * @returns {object} 池实例
 */
export function createAudioPool({ elements = {}, audioContextFactory = null, logger = null } = {}) {
  const ids = Object.keys(elements).filter((id) => elements[id]);
  if (!ids.length) throw new Error('[audioPool] 至少需要一个音频元素');

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn('[audioPool]', ...args);
  }

  // ── AudioContext：全池共享一个 ────────────────────────────
  let ctx = null;
  let ctxAttempted = false;

  function resolveContext() {
    if (ctx) return ctx;
    if (ctxAttempted) return null;
    ctxAttempted = true;
    if (typeof audioContextFactory === 'function') {
      try {
        ctx = audioContextFactory();
      } catch (e) {
        warn('注入的 audioContextFactory 抛错:', e && e.message);
        return null;
      }
    } else if (typeof window !== 'undefined') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (typeof AC === 'function') {
        try {
          ctx = new AC();
        } catch (e) {
          warn('创建 AudioContext 失败:', e && e.message);
          return null;
        }
      }
    }
    return ctx;
  }

  // ── 图缓存：按**元素**缓存 ────────────────────────────────
  // 为什么要按元素而不是按实例 id：实例可能被回收重建（换歌后销毁元素），
  // 而「这个元素建过图」这件事是元素的属性，不是实例 id 的属性。
  // WeakMap 天然避免内存泄漏 —— 元素被回收，条目随之消失。
  const graphCache = new WeakMap();
  /** 已尝试过建图但失败的元素：第二次直接返回 null，不再重试（幂等） */
  const graphFailed = new WeakSet();

  /**
   * 取（并在必要时建立）某个实例的音频图。
   *
   * 链序与 engine.js / eq.js 逐字一致：
   *   source → preamp(Gain) → 5×Biquad → analyser → destination
   * preamp 必须放链首：trim 与滤波串联才等效于输出衰减。
   *
   * @param {string} instanceId
   * @returns {object|null} 图对象；无 AudioContext 或建图失败时返回 null
   */
  function getGraph(instanceId) {
    const audio = elements[instanceId];
    if (!audio) return null;

    const cached = graphCache.get(audio);
    if (cached) return cached;
    if (graphFailed.has(audio)) return null;

    const context = resolveContext();
    if (!context) {
      graphFailed.add(audio);
      warn('无 AudioContext 可用，音频图不装配（EQ / 频谱将不可用）');
      return null;
    }

    try {
      const source = context.createMediaElementSource(audio);
      const preamp = context.createGain();
      preamp.gain.value = 1;
      source.connect(preamp);

      const filters = [];
      let node = preamp;
      for (const band of EQ_BANDS) {
        const f = context.createBiquadFilter();
        f.type = band.type;
        f.frequency.value = band.freq;
        f.Q.value = 1; // 与 eq.js:162 一致，改它等于改 EQ 曲线手感
        node.connect(f);
        node = f;
        filters.push(f);
      }

      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      node.connect(analyser);
      analyser.connect(context.destination);

      if (context.state === 'suspended' && typeof context.resume === 'function') {
        context.resume().catch(() => {});
      }

      const graph = {
        ctx: context,
        source,
        preamp,
        filters,
        analyser,
        destination: context.destination,
      };
      graphCache.set(audio, graph);
      return graph;
    } catch (e) {
      graphFailed.add(audio);
      warn(
        '音频图装配失败:',
        e && e.message,
        '（若为 InvalidStateError，说明该 audio 元素已被其它模块建过图 ——',
        'createMediaElementSource 只能调用一次）',
      );
      return null;
    }
  }

  /** 取实例的元素 */
  function getElement(instanceId) {
    return elements[instanceId] || null;
  }

  /** 池内有哪些实例 */
  function listIds() {
    return ids.slice();
  }

  /**
   * 挂载一个额外的实例（交叉淡入淡出启用时才建第二个元素）。
   *
   * 为什么要动态挂：未启用交叉淡入淡出时，多一个 <audio> 就是多一份内存占用，
   * 而绝大多数用户不开这个功能。延迟到启用时才建，符合「按需付费」的资源纪律。
   */
  function attach(instanceId, element) {
    if (!instanceId || !element) return false;
    if (elements[instanceId]) return false;
    elements[instanceId] = element;
    if (!ids.includes(instanceId)) ids.push(instanceId);
    return true;
  }

  /**
   * 卸载一个实例并释放它占着的资源。
   *
   * 只断开 src 并 pause —— **不 close AudioContext**：context 是全池共享的，
   * 关掉它会把另一个实例的图一起弄哑。AudioContext 的生命周期归引擎管。
   */
  function detach(instanceId) {
    const audio = elements[instanceId];
    if (!audio) return false;
    try {
      audio.pause();
    } catch (e) {
      warn('detach 时 pause 失败:', e && e.message);
    }
    try {
      audio.removeAttribute('src');
      audio.src = '';
      if (typeof audio.load === 'function') audio.load();
    } catch (e) {
      warn('detach 时清 src 失败:', e && e.message);
    }
    delete elements[instanceId];
    const i = ids.indexOf(instanceId);
    if (i >= 0) ids.splice(i, 1);
    return true;
  }

  return {
    getElement,
    getGraph,
    listIds,
    attach,
    detach,
    /** 取共享的 AudioContext（引擎负责它的生命周期） */
    getContext: resolveContext,
    INSTANCE_IDS,
  };
}

export { EQ_BANDS };
