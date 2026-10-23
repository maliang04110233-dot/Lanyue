/**
 * playback/engine.js — 播放引擎核心（Sprint 1 · S2）
 *
 * 目标（docs/architecture/PLAYBACK-ENGINE.md 第 3 节 D1/D2）
 * ------------------------------------------------------------
 * · `<audio>` 元素的**唯一所有者**：全仓只允许本模块持有并操作它；
 *   其余模块要么调引擎方法，要么订阅引擎广播。
 * · **显式播放状态机**：idle → loading ⇄ playing ⇄ paused → error。
 *   每一次状态转移都广播一份快照，UI 只读不写。
 * · **零 DOM 依赖**：audio 元素由构造参数注入，模块内不出现
 *   document / window —— 这是它能在 node:test 里被单测的前提。
 *
 * 本文件是「旁路建好的缝」：S2 阶段尚未接入生产链路，
 * 因此现有 player.js / audio-events.js 的行为一行未动。
 *
 * 设计约束（来自现状取证，违反会重演历史事故）
 * ----------------------------------------------
 * 1. timeupdate 只能在这里挂**一份**，再分发给订阅者。
 *    旧代码 audio-events.js 与 player.js 各挂一个，导致 updateProgress 每帧跑两遍。
 * 2. `pause` 事件每次换歌都会触发（player.js:103-108 的注释）。
 *    因此「进入 paused」只在**当前确实在 playing** 时发生，
 *    换歌期间的中断不得被误报成用户暂停。
 * 3. 音量与倍速只有引擎一个主人：对外只暴露 setVolume/setRate，
 *    内部才写 audio.volume / audio.playbackRate。
 * 4. 音频图（EQ）的 createMediaElementSource 对同一元素只能调用一次，
 *    第二次抛 InvalidStateError；而旧 eq.js 的 try/catch 会把它静默吞掉，
 *    表现为「EQ 无声失效且控制台无报错」。故本模块用模块内幂等标志防重入，
 *    绝不靠 try/catch 兜（S2b 实现 getAudioGraph）。
 */

/** 蓝图第 4 节的错误码：从既有 fallbackCodes / playError 收敛，不新造 */
const ERROR_CODES = Object.freeze([
  'ABORTED', 'NETWORK', 'NO_AUDIO', 'VIP_REQUIRED',
  'LOGIN_REQUIRED', 'SOURCE_UNAVAILABLE', 'DECODE_ERROR',
]);

/** 蓝图第 4 节的四个播放模式 */
const MODES = Object.freeze(['order', 'shuffle', 'single', 'list-loop']);

/** 蓝图第 4 节的状态全集 */
const STATES = Object.freeze(['idle', 'loading', 'playing', 'paused', 'error']);

import { createAudioPool } from './audioPool.js';
import { EQ_BANDS } from './eqBands.js';

/**
 * EQ 五段频段定义 —— **唯一事实来源是 playback/eqBands.js**。
 *
 * 此前这里内联复制了一份（原注释：「必须与 player/eq.js:36-42 逐字一致。
 * 这里复制而不是 import，是因为 eq.js 依赖 DOM」）。绕开 DOM 依赖的正解
 * 不是复制数据，而是把纯数据抽到零依赖模块里 —— 现在 engine、audioPool
 * 与（改造后的）eq.js 三方都从 eqBands.js 引入，漂移从「靠测试盯」
 * 变成「结构上不可能」。
 *
 * 频段数值一字未改：改它等于改 EQ 曲线手感。
 */
export { EQ_BANDS };

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function clampRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // Chromium 的 playbackRate 实用上限；超出会被浏览器自行钳制并改变音调行为
  return Math.min(4, Math.max(0.25, n));
}

/**
 * 创建播放引擎。
 *
 * @param {object} deps
 * @param {HTMLAudioElement|object} deps.audio       注入的音频元素（唯一所有者）
 * @param {Function} deps.resolveTrack               (song, quality) => Promise<{url,...}>
 * @param {Function} deps.proxyPlay                  (url, referer, refresh) => Promise<{fileUrl,...}>
 * @param {Function} deps.saveProgress               (song, seconds) => void
 * @param {Function} deps.loadProgress               (song) => Promise<number>
 * @param {object|null} [deps.logger]                可选日志器
 * @param {Function|null} [deps.audioContextFactory] 可选 AudioContext 工厂。
 *        默认取 window.AudioContext；测试注入假工厂即可在 node:test 里
 *        断言「图只建一次」——幂等性因此是可执行的，而不是靠肉眼读代码。
 * @param {object|null} [deps.audioPool]             可选实例池（交叉淡入淡出用）。
 *        不传时把单个 audio 包成单实例池，**旧调用方无需改动**。
 */
export function createPlaybackEngine({
  audio,
  audioPool = null,
  resolveTrack,
  proxyPlay,
  saveProgress,
  loadProgress,
  logger = null,
  audioContextFactory = null,
} = {}) {
  // 早失败优于静默失效：缺哪一项就说清哪一项
  const missing = [];
  if (!audio && !audioPool) missing.push('audio');
  if (typeof resolveTrack !== 'function') missing.push('resolveTrack');
  if (typeof proxyPlay !== 'function') missing.push('proxyPlay');
  if (typeof saveProgress !== 'function') missing.push('saveProgress');
  if (typeof loadProgress !== 'function') missing.push('loadProgress');
  if (missing.length) {
    throw new Error(`[playback-engine] 缺少必需依赖: ${missing.join(', ')}`);
  }

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn('[playback-engine]', ...args);
  }

  /**
   * 实例池。旧调用方传单个 audio，这里把它包成单实例池 ——
   * 这样「多实例」这条新能力不需要改动任何既有调用点。
   *
   * audioContextFactory 转给池：AudioContext 的所有权在**池**（全池共享一个），
   * 引擎不再自己解析它 —— 否则同一份工厂逻辑会有两处实现。
   */
  const pool = audioPool || createAudioPool({
    elements: { primary: audio },
    audioContextFactory,
    logger,
  });

  /** 当前主实例 id（交叉淡入淡出会在 primary / secondary 之间迁移） */
  let primaryId = 'primary';

  /** 取当前主实例的元素。既有代码里所有 `audio.xxx` 都经它拿。 */
  function activeAudio() {
    return pool.getElement(primaryId) || audio;
  }

  // ── 内部状态：唯一事实来源 ──────────────────────────────
  let state = 'idle';
  let currentSong = null;
  let lastError = null;
  let queue = [];
  let queueIdx = -1;
  let mode = 'order';
  let volume = 1;
  let muted = false;
  let rate = 1;

  /**
   * 每个实例的**交叉增益**（0..1），缺省 1（即不参与交叉）。
   *
   * 实际音量 = 用户音量 × 该实例的交叉增益。交叉层只改这个值，
   * 由引擎统一落到元素上 —— 音量写手仍然只有引擎一个。
   */
  const instanceGains = new Map();

  /** 订阅者集合。广播时遍历副本，允许回调里退订。 */
  const subscribers = new Set();

  /**
   * 换 src 期间抑制音频事件。
   * 浏览器在给 audio.src 赋新值时**必然**先触发一次 pause，
   * 若不抑制，换歌会被误判成「用户暂停」——这正是 player.js:103-108 记录的旧事故。
   */
  let suppressAudioEvents = false;

  function snapshot() {
    const el = activeAudio();
    return {
      state,
      song: currentSong,
      error: lastError,
      position: Number.isFinite(el.currentTime) ? el.currentTime : 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      volume,
      muted,
      rate,
      mode,
      queueIdx,
      queueLength: queue.length,
    };
  }

  function broadcast() {
    const snap = snapshot();
    for (const fn of [...subscribers]) {
      try {
        fn(snap);
      } catch (e) {
        // 单个订阅者抛错不得阻断其它订阅者（UI 卡死比日志缺失更糟）
        warn('订阅者回调抛错:', e && e.message);
      }
    }
  }

  /** 状态转移；同态重复调用不重复广播（避免事件风暴） */
  function setState(next) {
    if (!STATES.includes(next)) {
      warn('忽略非法状态:', next);
      return;
    }
    if (next === state) return;
    state = next;
    broadcast();
  }

  function setError(error) {
    lastError = error || null;
  }

  // ── 音频事件：只在这里挂一份，再分发给订阅者 ─────────────
  function onPlaying() {
    if (suppressAudioEvents || !currentSong) return;
    setError(null);
    setState('playing');
  }

  function onPause() {
    if (suppressAudioEvents || !currentSong) return;
    // 只在「确实在播」时才算暂停；换歌导致的 pause 已被 suppress 拦住
    if (state === 'playing') setState('paused');
  }

  function onEnded() {
    if (suppressAudioEvents || !currentSong) return;
    broadcast(); // 让 UI 先拿到 ended 时的位置
    // 单曲循环：重载同一首；其余模式交给下一首（S2b 补自动加载）
    if (mode === 'single') {
      playAt(queueIdx);
    } else {
      next();
    }
  }

  function onError(event) {
    if (suppressAudioEvents) return;
    // 事件来自哪个实例就用哪个实例的 error —— 多实例下不能用主实例的
    const el = (event && event.target) || activeAudio();
    const mediaError = el.error || null;
    setError({
      code: 'DECODE_ERROR',
      message: mediaError && mediaError.message
        ? String(mediaError.message)
        : '音频元素报告解码/加载错误',
    });
    setState('error');
  }

  function onTimeUpdate() {
    if (suppressAudioEvents) return;
    // 进度只影响快照里的 position，不产生状态转移
    broadcast();
  }

  function onLoadedMetadata() {
    if (suppressAudioEvents) return;
    broadcast();
  }

  /**
   * 把音频事件挂到**每一个**实例上。
   *
   * 为什么不能只挂主实例：交叉淡入淡出时，副实例会先 `playing`、
   * 主实例后 `ended`。只挂主实例的话，副实例的 playing 收不到 ——
   * 而那正是「新歌真的开始响了」的信号。
   *
   * 为什么不在 attach 时才挂：attach 是后加的入口，挂载逻辑分散两处
   * 容易漏。这里统一在池的实例列表变化时重挂（幂等：先解绑再绑）。
   */
  const boundElements = new Set();
  function bindInstanceEvents() {
    for (const id of pool.listIds()) {
      const el = pool.getElement(id);
      if (!el || boundElements.has(el)) continue;
      el.addEventListener('playing', onPlaying);
      el.addEventListener('play', onPlaying);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);
      el.addEventListener('error', onError);
      el.addEventListener('timeupdate', onTimeUpdate);
      el.addEventListener('loadedmetadata', onLoadedMetadata);
      boundElements.add(el);
    }
  }
  function unbindInstanceEvents() {
    for (const el of boundElements) {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('play', onPlaying);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
    }
    boundElements.clear();
  }
  bindInstanceEvents();

  // ── 驱动面 ────────────────────────────────────────────
  async function loadTrack(song, options = {}) {
    if (!song) return;
    currentSong = song;
    setError(null);
    setState('loading');

    try {
      let url = options && options.url;
      let resolved = null;
      if (!url) {
        resolved = await resolveTrack(song, (options && options.quality) || song.quality || 'standard');
        url = resolved && resolved.url;
      }
      if (!url) {
        const err = new Error('取流失败：没有可用地址');
        err.code = 'NO_AUDIO';
        throw err;
      }

      // 换 src 必然触发一次 pause，必须抑制，否则会被误判为用户暂停
      const prevSuppress = suppressAudioEvents;
      suppressAudioEvents = true;
      try {
        const el = activeAudio();
        el.src = url;
        if (typeof el.load === 'function') el.load();
      } finally {
        suppressAudioEvents = prevSuppress;
      }

      if (options && options.autoplay) await play();
      return resolved;
    } catch (e) {
      const code = e && ERROR_CODES.includes(e.code) ? e.code : 'NETWORK';
      setError({ code, message: (e && e.message) ? String(e.message) : String(e) });
      setState('error');
      return null;
    }
  }

  async function play() {
    if (!currentSong) return;
    try {
      // 假元素/真实元素的 play() 都会在返回前同步派发 'play'，
      // 所以状态会在本函数返回前就落到 playing（测试据此断言）
      await activeAudio().play();
    } catch (e) {
      setError({ code: 'ABORTED', message: (e && e.message) ? String(e.message) : '播放被中断' });
      setState('error');
    }
  }

  function pause() {
    try {
      activeAudio().pause();
    } catch (e) {
      warn('pause 失败:', e && e.message);
    }
    if (currentSong && state === 'playing') setState('paused');
  }

  /**
   * 交叉淡入淡出到另一首歌。
   *
   * ⚠️ 未实现 —— 有意留白，不要当成可用能力
   * ----------------------------------------
   * 需要它成立，前置条件是**引擎成为生产播放路径**：`player.js` 目前用模块级
   * `audio` 元素直连（`loadAndPlay` 写 `audio.src` / `audio.play()`），
   * 根本不走引擎 —— `docs/architecture/PLAYBACK-ENGINE.md` 明确记载引擎是
   * 「旁路建好的缝」，阶段 3 才迁移 11 个调用方。
   *
   * 为什么不做半成品
   * --------------
   * crossfade 需要「预载到第二个实例」。但 `loadTrack()` 只认 `activeAudio()`
   * （主实例），不接受实例 id；而创建第二个 `<audio>` 需要 DOM，会破坏本文件
   * 「零 DOM 依赖、可在 node:test 单测」的硬约束。硬塞进来只有两种结果：
   * 要么预载静默失效（歌仍载进主实例），要么引擎背上 DOM 依赖。
   *
   * 正确顺序：阶段 3 把播放路径迁到引擎 → 引擎获得 DOM 装配职责 →
   * 再实现本方法。届时 `playback/crossfade.js`（编排层）与 `audioPool.js`
   * （实例池）已就位，这里只是接线。
   *
   * @param {object} song
   * @returns {Promise<null>} 恒为 null —— 调用方需自行降级到硬切
   */
  async function crossfadeTo(song) {
    warn('crossfadeTo 未实现：引擎尚未接入生产播放路径，降级为硬切');
    return null;
  }

  function toggle() {
    if (state === 'playing') return pause();
    return play();
  }

  function stop() {
    const prevSuppress = suppressAudioEvents;
    suppressAudioEvents = true;
    try {
      activeAudio().pause();
    } catch (e) {
      warn('stop 时 pause 失败:', e && e.message);
    } finally {
      suppressAudioEvents = prevSuppress;
    }
    currentSong = null;
    setError(null);
    setState('idle');
  }

  function seek(sec) {
    const target = Number(sec);
    if (!Number.isFinite(target)) return;
    const el = activeAudio();
    const duration = Number(el.duration);
    let next = target;
    if (Number.isFinite(duration) && duration > 0) {
      next = Math.min(Math.max(target, 0), duration);
    } else {
      next = Math.max(target, 0);
    }
    try {
      el.currentTime = next;
    } catch (e) {
      warn('seek 失败:', e && e.message);
      return;
    }
    broadcast();
  }

  function seekBy(delta) {
    const d = Number(delta);
    if (!Number.isFinite(d)) return;
    const cur = Number.isFinite(activeAudio().currentTime) ? activeAudio().currentTime : 0;
    seek(cur + d);
  }

  function setVolume(v) {
    volume = clampVolume(v);
    // 用户音量对**所有**实例生效：交叉淡入淡出时两个实例都要跟着用户的
    // 滑条走，否则交叉期间滑条拖动只影响一半的声音。
    for (const id of pool.listIds()) applyVolumeTo(id);
    broadcast();
  }

  /**
   * 把「用户音量 × 该实例的交叉增益」落到元素上。
   *
   * 这是引擎作为**唯一音量写手**的落点（铁律 3）。交叉层只请求
   * setInstanceGain 改交叉增益，绝不自己写 audio.volume。
   */
  function applyVolumeTo(instanceId) {
    const el = pool.getElement(instanceId);
    if (!el) return;
    const g = instanceGains.get(instanceId);
    const factor = g === undefined ? 1 : g;
    try {
      el.volume = clampVolume(volume * factor);
      el.muted = muted;
    } catch (e) {
      warn('设置音量失败:', e && e.message);
    }
  }

  /**
   * 设置某实例的**交叉增益**（0..1）。
   *
   * 交叉淡入淡出期间，旧实例增益 1→0、新实例 0→1。实际音量 =
   * 用户音量 × 交叉增益。这样「音量只有引擎一个主人」的铁律仍然成立，
   * 而交叉层获得了它需要的第二个维度。
   */
  function setInstanceGain(instanceId, value) {
    const g = Number(value);
    const clamped = Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1;
    instanceGains.set(instanceId, clamped);
    applyVolumeTo(instanceId);
  }

  function getInstanceGain(instanceId) {
    const g = instanceGains.get(instanceId);
    return g === undefined ? 1 : g;
  }

  function getVolume() {
    return volume;
  }

  function toggleMute() {
    muted = !muted;
    for (const id of pool.listIds()) applyVolumeTo(id);
    broadcast();
  }

  function setRate(r) {
    rate = clampRate(r);
    // 倍速对所有实例生效：交叉期间新实例起来时必须已经是用户选的倍速，
    // 否则会出现「前 3 秒 1x、之后 2x」的突兀。
    for (const id of pool.listIds()) {
      const el = pool.getElement(id);
      if (!el) continue;
      try {
        el.playbackRate = rate;
      } catch (e) {
        warn('设置倍速失败:', e && e.message);
      }
    }
    broadcast();
  }

  function getRate() {
    return rate;
  }

  // ── 队列面 ────────────────────────────────────────────
  function clampIdx(idx, len) {
    if (!len) return -1;
    const n = Number(idx);
    if (!Number.isFinite(n)) return 0;
    return Math.min(len - 1, Math.max(0, Math.trunc(n)));
  }

  function setQueue(songs, startIdx = 0) {
    queue = Array.isArray(songs) ? songs.slice() : [];
    queueIdx = clampIdx(startIdx, queue.length);
    broadcast();
  }

  function randomOtherIndex() {
    if (queue.length <= 1) return queueIdx < 0 ? 0 : queueIdx;
    let i = queueIdx;
    // 至多尝试若干次，避免极端情况下死循环
    for (let guard = 0; guard < queue.length * 2 && i === queueIdx; guard++) {
      i = Math.floor(Math.random() * queue.length);
    }
    return i === queueIdx ? (queueIdx + 1) % queue.length : i;
  }

  function nextIndex() {
    if (!queue.length) return -1;
    if (mode === 'single') return queueIdx < 0 ? 0 : queueIdx;
    if (mode === 'shuffle') return randomOtherIndex();
    // order 与 list-loop 都回绕：既有 nextPrefetchIdx 的语义也是到尾回头
    return queueIdx < 0 ? 0 : (queueIdx + 1) % queue.length;
  }

  function prevIndex() {
    if (!queue.length) return -1;
    if (mode === 'single') return queueIdx < 0 ? 0 : queueIdx;
    if (mode === 'shuffle') return randomOtherIndex();
    return queueIdx < 0 ? queue.length - 1 : (queueIdx - 1 + queue.length) % queue.length;
  }

  function next() {
    const idx = nextIndex();
    if (idx < 0) return null;
    queueIdx = idx;
    broadcast();
    return queue[queueIdx] || null;
  }

  function prev() {
    const idx = prevIndex();
    if (idx < 0) return null;
    queueIdx = idx;
    broadcast();
    return queue[queueIdx] || null;
  }

  function playAt(idx) {
    const target = clampIdx(idx, queue.length);
    if (target < 0) return Promise.resolve(null);
    queueIdx = target;
    broadcast();
    const song = queue[queueIdx];
    if (!song) return Promise.resolve(null);
    return loadTrack(song, { autoplay: true });
  }

  function setMode(nextMode) {
    if (!MODES.includes(nextMode)) {
      warn('忽略非法播放模式:', nextMode);
      return;
    }
    mode = nextMode;
    broadcast();
  }

  // ── 观察面 ────────────────────────────────────────────
  function subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[playback-engine] subscribe 需要一个函数');
    }
    subscribers.add(fn);
    // 立即补发当前快照：订阅者不该为了拿初始状态再多写一条 getSnapshot 调用，
    // 否则每个 UI 模块都会各自维护一份「初始态」影子副本。
    try {
      fn(snapshot());
    } catch (e) {
      warn('订阅者初始回调抛错:', e && e.message);
    }
    return function unsubscribe() {
      subscribers.delete(fn);
    };
  }

  function getSnapshot() {
    return snapshot();
  }

  /**
   * 音频图访问器 —— 委托给实例池。
   *
   * 装配逻辑搬到了 playback/audioPool.js，原因是**多实例**：
   * 图必须按**元素**缓存（createMediaElementSource 对同一元素只能调用一次，
   * 第二次抛 InvalidStateError），而实例可能被回收重建。
   * audioPool 用 WeakMap 做「元素 → 图」的映射，并保留显式幂等标志
   * （graphFailed），try/catch 只负责把真实失败变成「可观察的 null + 日志」。
   *
   * 链序与 eq.js:141-184 逐字一致：
   *   source → preamp(Gain) → 5×Biquad → analyser → destination
   * preamp 必须放链首：trim 与滤波串联才等效于输出衰减；插在 filters 之后
   * 会让 analyser 读到被自己抵消后的信号（eq.js:46-50 的取舍说明）。
   *
   * @param {string} [instanceId] 不传则取当前主实例
   */
  function getAudioGraph(instanceId = primaryId) {
    return pool.getGraph(instanceId);
  }

  /**
   * 切换主实例（交叉淡入淡出完成时由编排层调用）。
   *
   * @param {string} instanceId
   */
  function setPrimaryInstance(instanceId) {
    if (!instanceId || instanceId === primaryId) return;
    const el = pool.getElement(instanceId);
    if (!el) {
      warn('切换主实例失败：池里没有该实例', instanceId);
      return;
    }
    primaryId = instanceId;
    // 新主实例要立刻继承当前的音量/静音/倍速，否则会有一瞬间用默认值
    applyVolumeTo(primaryId);
    try {
      el.playbackRate = rate;
    } catch (e) {
      warn('切换主实例时设置倍速失败:', e && e.message);
    }
    bindInstanceEvents();
    broadcast();
  }

  /** 取当前主实例 id */
  function getPrimaryInstance() {
    return primaryId;
  }

  /** 挂载一个新实例并把音频事件绑上（交叉淡入淡出启用时才调用） */
  function attachInstance(instanceId, element) {
    const ok = pool.attach(instanceId, element);
    if (!ok) return false;
    // 新实例立刻对齐当前音量/静音/倍速，避免交叉起点音量突变
    applyVolumeTo(instanceId);
    try {
      element.playbackRate = rate;
    } catch (e) {
      warn('挂载实例时设置倍速失败:', e && e.message);
    }
    bindInstanceEvents();
    return true;
  }

  /** 卸载实例并解绑其事件 */
  function detachInstance(instanceId) {
    const el = pool.getElement(instanceId);
    if (el) {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('play', onPlaying);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      boundElements.delete(el);
    }
    instanceGains.delete(instanceId);
    if (primaryId === instanceId) primaryId = 'primary';
    return pool.detach(instanceId);
  }

  return {
    // 驱动
    loadTrack, play, pause, toggle, stop,
    crossfadeTo,
    seek, seekBy,
    setVolume, getVolume, toggleMute,
    setRate, getRate,
    // 交叉淡入淡出（按实例操作，音量仍由引擎单方面落地）
    setInstanceGain, getInstanceGain,
    setPrimaryInstance, getPrimaryInstance,
    attachInstance, detachInstance,
    // 队列
    setQueue, playAt, next, prev, setMode,
    // 观察
    subscribe, getSnapshot, getAudioGraph,
    // 常量（UI 与测试据此对账，避免各写一份错误码）
    ERROR_CODES,
    MODES,
    STATES,
  };
}

export { ERROR_CODES, MODES, STATES };
