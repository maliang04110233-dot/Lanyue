/**
 * playback/crossfade.js — 交叉淡入淡出编排层（零 DOM 依赖）
 *
 * 它解决什么
 * ----------
 * Lanyue 已有 player/fade.js 的**单实例**淡入淡出：新曲淡入 → 淡出到 0
 * → 真 pause → 下一首淡入。问题在于淡出与淡入之间有一段**静默间隙**
 * （约等于 fadeOutMs），听感上是「歌断了」。
 *
 * 交叉淡入淡出用**两个**实例重叠：旧曲淡出的同时新曲淡入，间隙被填掉。
 *
 * 与既有 fade.js 的关系
 * --------------------
 * fade.js 管「单实例的音量斜坡」（含缓停、暂停恢复淡入），本模块管
 * 「两个实例怎么协同、何时切换主实例、元数据何时换」。
 *
 * 两者不重叠：fade.js 继续负责单实例斜坡，crossfade 只在**切歌**这一
 * 个时刻接管，其余场景（暂停恢复、缓冲恢复）仍走 fade.js。
 *
 * 零 DOM 依赖
 * ----------
 * 与 engine.js 同一铁律：模块内不出现 document / window / <audio>。
 * 时间源、实例操作、状态回调全部注入。这样它能在 node:test 里被
 * 直接单测 —— 本文件的所有导出都是纯函数或可注入的编排器。
 *
 * 与 engine.js 的铁律如何共存
 * --------------------------
 * engine.js:23-24 铁律 3：「音量与倍速只有引擎一个主人」。
 * 本模块**不写** audio.volume，也**不写** audio.playbackRate。
 * 它只做两件事：
 *   1. 编排「什么时候把哪个实例设为主实例」
 *   2. 通过注入的 setGain 回调请求引擎设置某实例的**交叉增益**
 * 实际音量 = 用户音量 × 交叉增益（由引擎合成），引擎仍是唯一写手。
 */

/** 交叉淡入淡出的编排状态。 */
export const CROSSFADE_STATES = Object.freeze([
  'idle',        // 未开始
  'preloading',  // 正在预载下一首（静默）
  'fading',      // 淡出与淡入重叠进行中
  'settled',     // 已完成，新实例成为主实例
  'aborted',     // 被中断（用户切歌/暂停）
]);

/** 降级模式：crossfade 没能优雅执行时的退路。 */
export const FALLBACK_MODES = Object.freeze([
  'none',     // 正常交叉
  'hardCut',  // 直接切（预载失败 / 时长为 0）
  'abort',    // 中断并归位
]);

/**
 * 交叉增益曲线：线性 0→1。
 *
 * 为什么不做成对数：交叉淡入淡出里的两个实例**同时存在**，听感上需要
 * 「总能量恒定」的错觉，线性互补（一个降一个升，曲线交叉点在 0.5）
 * 在听感上最稳。对数曲线（人耳感知更接近）适合单实例的淡出淡入，
 * 那是 fade.js 的场景。
 *
 * @param {number} startTs 起始时间戳
 * @param {number} now     当前时间戳
 * @param {number} durMs   持续时长
 * @returns {number} 0..1
 */
export function crossfadeCurveAt(startTs, now, durMs) {
  const dur = Number(durMs);
  if (!(dur > 0)) return 1;
  const t0 = Number(startTs) || 0;
  const p = (Number(now) - t0) / dur;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return +(p).toFixed(6);
}

/**
 * 淡入曲线：1→0（与 crossfadeCurveAt 互为补数）。
 * 单独导出是为了让「补数关系」可被单测钉住。
 */
export function crossfadeFadeInAt(startTs, now, durMs) {
  return 1 - crossfadeCurveAt(startTs, now, durMs);
}

/**
 * 交叉点（两边增益相等）时刻。
 *
 * 取 min(fadeOutMs, fadeInMs) / 2 —— 两段斜坡**同时开始**，
 * 短的那段先走完，长的那段还在走，此时两者增益之和为 1，
 * 听感上以「已完成的那首」为主但另一首还在。
 *
 * 为什么用 min/2 而不是各自一半：若 fadeOut=1000 / fadeIn=2000，
 * 淡出在 1000ms 就结束了，此后 1000ms 只有新曲在响 —— 那不是交叉，
 * 是「淡出 + 延时淡入」。交叉点必须落在**两段都还在进行**的窗口内，
 * 即 min(fadeOut, fadeIn) 之内，取其中点最稳。
 *
 * @param {number} fadeOutMs
 * @param {number} fadeInMs
 * @returns {number} 毫秒；0 表示无有效交叉点
 */
export function crossfadeMidpoint(fadeOutMs, fadeInMs) {
  const out = Number(fadeOutMs);
  const inn = Number(fadeInMs);
  const shortest = Math.min(
    Number.isFinite(out) && out > 0 ? out : 0,
    Number.isFinite(inn) && inn > 0 ? inn : 0,
  );
  if (shortest <= 0) return 0;
  return shortest / 2;
}

/**
 * 计划一次交叉淡入淡出。
 *
 * @param {object} opts
 * @param {number} opts.fadeOutMs   淡出时长
 * @param {number} opts.fadeInMs    淡入时长
 * @param {boolean} [opts.preloadOk] 预载是否成功
 * @param {boolean} [opts.enabled]   功能是否启用
 * @returns {object} 计划对象
 *   mode: 'none' | 'hardCut' | 'abort'
 *   durationMs: 交叉总时长（硬切时为 0）
 *   midpointMs: 交叉点偏移
 */
export function planCrossfade({ fadeOutMs, fadeInMs, preloadOk = true, enabled = true } = {}) {
  const out = Number(fadeOutMs);
  const inn = Number(fadeInMs);
  const fadeOut = Number.isFinite(out) && out > 0 ? out : 0;
  const fadeIn = Number.isFinite(inn) && inn > 0 ? inn : 0;

  if (!enabled) {
    return { mode: 'hardCut', durationMs: 0, midpointMs: 0, fadeOutMs: 0, fadeInMs: 0 };
  }
  if (!preloadOk) {
    // 预载失败：没有第二个实例可淡入，硬切是唯一选择
    return { mode: 'hardCut', durationMs: 0, midpointMs: 0, fadeOutMs: fadeOut, fadeInMs: fadeIn };
  }
  if (fadeOut <= 0 && fadeIn <= 0) {
    return { mode: 'hardCut', durationMs: 0, midpointMs: 0, fadeOutMs: 0, fadeInMs: 0 };
  }
  if (fadeOut <= 0 || fadeIn <= 0) {
    // 只有一端有斜坡：退化成「单实例淡入」或「单实例淡出」，
    // 仍然不是硬切（有音量渐变），但没有重叠窗口。
    const durationMs = Math.max(fadeOut, fadeIn);
    return { mode: 'none', durationMs, midpointMs: durationMs / 2, fadeOutMs: fadeOut, fadeInMs: fadeIn };
  }

  // 两段都有：重叠窗口取较短者 —— 超过这个时长就只剩一首在响，不是交叉了
  const durationMs = Math.min(fadeOut, fadeIn);
  return {
    mode: 'none',
    durationMs,
    midpointMs: crossfadeMidpoint(fadeOut, fadeIn),
    fadeOutMs: fadeOut,
    fadeInMs: fadeIn,
  };
}

/**
 * 创建交叉淡入淡出编排器。
 *
 * 所有副作用都经注入的依赖完成，本模块不碰 DOM。
 *
 * @param {object} deps
 * @param {() => number} deps.now                 时间源（默认 Date.now）
 * @param {(id: string, gain: number) => void} deps.setGain
 *        请求引擎设置某实例的交叉增益（0..1）。引擎会与用户音量相乘。
 * @param {(id: string) => void} [deps.onPrimaryChange]
 *        主实例切换时回调（用于同步 Media Session / 歌词归属）
 * @param {(id: string) => void} [deps.onMetadataSwap]
 *        到达交叉点、该换元数据时回调
 * @param {(id: string) => void} [deps.onRelease]
 *        某实例不再需要时回调（释放资源）
 * @param {object|null} [deps.logger]
 * @returns {object} 编排器
 */
export function createCrossfadeController({
  now = () => Date.now(),
  setGain,
  onPrimaryChange = null,
  onMetadataSwap = null,
  onRelease = null,
  logger = null,
} = {}) {
  if (typeof setGain !== 'function') {
    throw new Error('[crossfade] 缺少 setGain 依赖');
  }

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn('[crossfade]', ...args);
  }

  let state = 'idle';
  let plan = null;
  let startTs = 0;
  let fromId = null;
  let toId = null;
  let metadataSwapped = false;
  let raf = 0;
  /** 外部驱动（测试或真实 rAF）回调；缺省用 setTimeout 兜底 */
  let tick = null;

  function getState() {
    return state;
  }

  function getPlan() {
    return plan;
  }

  /** 当前主实例 id */
  function getPrimary() {
    return fromId;
  }

  /**
   * 启动一次交叉。
   *
   * @param {object} opts
   * @param {string} opts.fromId   当前正在响的实例 id
   * @param {string} opts.toId     预载好的下一首实例 id
   * @param {number} opts.fadeOutMs
   * @param {number} opts.fadeInMs
   * @param {boolean} [opts.preloadOk]
   * @returns {object} 实际执行的计划
   */
  function start({ fromId: from, toId: to, fadeOutMs, fadeInMs, preloadOk = true } = {}) {
    // 先中止上一次未完成的交叉，避免两条斜坡互相写增益
    if (state === 'fading' || state === 'preloading') {
      abort('restart');
    }

    fromId = from;
    toId = to;
    plan = planCrossfade({ fadeOutMs, fadeInMs, preloadOk });
    metadataSwapped = false;

    if (plan.mode !== 'none') {
      // 硬切：不做任何渐变，由调用方直接换主实例
      state = 'settled';
      if (typeof onPrimaryChange === 'function') {
        try { onPrimaryChange(toId); } catch (e) { warn('onPrimaryChange 抛错:', e && e.message); }
      }
      if (typeof onMetadataSwap === 'function') {
        try { onMetadataSwap(toId); } catch (e) { warn('onMetadataSwap 抛错:', e && e.message); }
      }
      if (typeof onRelease === 'function') {
        try { onRelease(fromId); } catch (e) { warn('onRelease 抛错:', e && e.message); }
      }
      return plan;
    }

    state = 'fading';
    startTs = now();

    // 起点：旧曲满音量、新曲静音
    setGain(fromId, 1);
    setGain(toId, 0);

    scheduleTick();
    return plan;
  }

  function scheduleTick() {
    if (typeof tick === 'function') {
      raf = tick(step);
      return;
    }
    // 没有注入时钟驱动时用 setTimeout 兜底（浏览器环境）。
    // 16ms ≈ 一帧，与 requestAnimationFrame 的节奏接近。
    raf = setTimeout(() => step(now()), 16);
    if (raf && typeof raf.unref === 'function') raf.unref();
  }

  /** 推进一帧。暴露出来是为了让测试用假时钟精确驱动。 */
  function step(currentTs) {
    if (state !== 'fading') return;
    const t = Number.isFinite(currentTs) ? currentTs : now();
    const elapsed = t - startTs;

    if (elapsed >= plan.durationMs) {
      finish();
      return;
    }

    // 旧曲增益 1→0，新曲增益 0→1，两者互补
    const outGain = 1 - crossfadeCurveAt(startTs, t, plan.fadeOutMs);
    const inGain = crossfadeCurveAt(startTs, t, plan.fadeInMs);
    setGain(fromId, outGain);
    setGain(toId, inGain);

    // 到达交叉点才换元数据：过早换会让系统媒体键显示错的歌
    if (!metadataSwapped && elapsed >= plan.midpointMs) {
      metadataSwapped = true;
      if (typeof onMetadataSwap === 'function') {
        try { onMetadataSwap(toId); } catch (e) { warn('onMetadataSwap 抛错:', e && e.message); }
      }
    }

    scheduleTick();
  }

  /** 交叉完成：新实例成为主实例，旧实例释放 */
  function finish() {
    state = 'settled';
    setGain(fromId, 0);
    setGain(toId, 1);
    if (!metadataSwapped) {
      metadataSwapped = true;
      if (typeof onMetadataSwap === 'function') {
        try { onMetadataSwap(toId); } catch (e) { warn('onMetadataSwap 抛错:', e && e.message); }
      }
    }
    if (typeof onPrimaryChange === 'function') {
      try { onPrimaryChange(toId); } catch (e) { warn('onPrimaryChange 抛错:', e && e.message); }
    }
    const released = fromId;
    fromId = toId;
    if (typeof onRelease === 'function') {
      try { onRelease(released); } catch (e) { warn('onRelease 抛错:', e && e.message); }
    }
  }

  /**
   * 中断交叉并归位。
   *
   * 中断场景：用户在交叉途中点了别的歌、按了暂停、或关掉了应用。
   * 此时必须立刻让增益回到「一个实例满音量、另一个静音」，
   * 否则会留下「两个实例都在半音量」或「两个都静音」的死状态。
   */
  function abort(reason = 'abort') {
    if (state !== 'fading' && state !== 'preloading') {
      return false;
    }
    if (raf) {
      if (typeof tick === 'function') {
        try { if (typeof raf.cancel === 'function') raf.cancel(); } catch (e) { /* 忽略 */ }
      } else {
        clearTimeout(raf);
      }
      raf = 0;
    }
    // 归位：让**当前主实例**恢复满音量（from 仍是主实例）
    setGain(fromId, 1);
    setGain(toId, 0);
    state = 'aborted';
    warn('交叉被中断:', reason);
    return true;
  }

  /** 注入时钟驱动（测试用假 rAF；生产传 requestAnimationFrame 包装） */
  function setTick(fn) {
    tick = typeof fn === 'function' ? fn : null;
  }

  /** 重置到初始态（应用退出 / 换队列时用） */
  function reset() {
    abort('reset');
    state = 'idle';
    plan = null;
    fromId = null;
    toId = null;
    metadataSwapped = false;
  }

  return {
    start,
    step,
    abort,
    reset,
    setTick,
    getState,
    getPlan,
    getPrimary,
    CROSSFADE_STATES,
    FALLBACK_MODES,
  };
}

export { CROSSFADE_STATES as STATES, FALLBACK_MODES as MODES };
