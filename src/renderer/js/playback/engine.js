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

/**
 * EQ 五段频段定义 —— **必须与 player/eq.js:36-42 逐字一致**。
 * 这里复制而不是 import，是因为 eq.js 依赖 DOM（document.getElementById），
 * 而引擎的硬约束是零 DOM 依赖（否则无法在 node:test 里跑）。
 * 两侧一致性由 t3 的 eq.js 改造守卫：eq.js 改为消费引擎的图之后，
 * 频段只有引擎这一份，不会漂移。
 */
const EQ_BANDS = Object.freeze([
  { freq: 60, type: 'lowshelf' },
  { freq: 230, type: 'peaking' },
  { freq: 910, type: 'peaking' },
  { freq: 3600, type: 'peaking' },
  { freq: 14000, type: 'highshelf' },
]);

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
 */
export function createPlaybackEngine({
  audio,
  resolveTrack,
  proxyPlay,
  saveProgress,
  loadProgress,
  logger = null,
  audioContextFactory = null,
} = {}) {
  // 早失败优于静默失效：缺哪一项就说清哪一项
  const missing = [];
  if (!audio) missing.push('audio');
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

  /** 音频图（EQ / 频谱）。audioGraphAttempted 是「已尝试过」的显式标志。 */
  let audioGraph = null;
  let audioGraphAttempted = false;

  /** 取一个 AudioContext：优先注入的工厂，其次浏览器全局。 */
  function resolveAudioContext() {
    if (typeof audioContextFactory === 'function') {
      try {
        return audioContextFactory();
      } catch (e) {
        warn('注入的 audioContextFactory 抛错:', e && e.message);
        return null;
      }
    }
    if (typeof window !== 'undefined') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (typeof AC === 'function') {
        try {
          return new AC();
        } catch (e) {
          warn('创建 AudioContext 失败:', e && e.message);
          return null;
        }
      }
    }
    return null;
  }

  /** 订阅者集合。广播时遍历副本，允许回调里退订。 */
  const subscribers = new Set();

  /**
   * 换 src 期间抑制音频事件。
   * 浏览器在给 audio.src 赋新值时**必然**先触发一次 pause，
   * 若不抑制，换歌会被误判成「用户暂停」——这正是 player.js:103-108 记录的旧事故。
   */
  let suppressAudioEvents = false;

  function snapshot() {
    return {
      state,
      song: currentSong,
      error: lastError,
      position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
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

  function onError() {
    if (suppressAudioEvents) return;
    const mediaError = audio.error || null;
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

  audio.addEventListener('playing', onPlaying);
  audio.addEventListener('play', onPlaying);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onError);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('loadedmetadata', onLoadedMetadata);

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
        audio.src = url;
        if (typeof audio.load === 'function') audio.load();
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
      await audio.play();
    } catch (e) {
      setError({ code: 'ABORTED', message: (e && e.message) ? String(e.message) : '播放被中断' });
      setState('error');
    }
  }

  function pause() {
    try {
      audio.pause();
    } catch (e) {
      warn('pause 失败:', e && e.message);
    }
    if (currentSong && state === 'playing') setState('paused');
  }

  function toggle() {
    if (state === 'playing') return pause();
    return play();
  }

  function stop() {
    const prevSuppress = suppressAudioEvents;
    suppressAudioEvents = true;
    try {
      audio.pause();
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
    const duration = Number(audio.duration);
    let next = target;
    if (Number.isFinite(duration) && duration > 0) {
      next = Math.min(Math.max(target, 0), duration);
    } else {
      next = Math.max(target, 0);
    }
    try {
      audio.currentTime = next;
    } catch (e) {
      warn('seek 失败:', e && e.message);
      return;
    }
    broadcast();
  }

  function seekBy(delta) {
    const d = Number(delta);
    if (!Number.isFinite(d)) return;
    const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    seek(cur + d);
  }

  function setVolume(v) {
    volume = clampVolume(v);
    try {
      audio.volume = volume;
    } catch (e) {
      warn('设置音量失败:', e && e.message);
    }
    broadcast();
  }

  function getVolume() {
    return volume;
  }

  function toggleMute() {
    muted = !muted;
    try {
      audio.muted = muted;
    } catch (e) {
      warn('设置静音失败:', e && e.message);
    }
    broadcast();
  }

  function setRate(r) {
    rate = clampRate(r);
    try {
      audio.playbackRate = rate;
    } catch (e) {
      warn('设置倍速失败:', e && e.message);
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
   * 音频图访问器（S2b 实现幂等装配）。
   *
   * 为什么幂等标志比 try/catch 重要
   * --------------------------------
   * `createMediaElementSource(audio)` 对同一个元素**只能调用一次**，
   * 第二次抛 InvalidStateError。旧 eq.js:177-183 把这段包在 try/catch 里，
   * 捕获后静默 return false —— 表现为「EQ 明明开了却没效果，控制台一行报错都没有」。
   * 所以这里用 audioGraph / audioGraphAttempted 两个标志做**显式**幂等，
   * try/catch 只负责把真实失败变成「可观察的 null + 日志」，不承担幂等职责。
   *
   * 链序与 eq.js:141-184 逐字一致：
   *   source → preamp(Gain) → 5×Biquad → analyser → destination
   * preamp 必须放链首：trim 与滤波串联才等效于输出衰减；插在 filters 之后
   * 会让 analyser 读到被自己抵消后的信号（eq.js:46-50 的取舍说明）。
   */
  function getAudioGraph() {
    if (audioGraph) return audioGraph;
    if (audioGraphAttempted) return null;

    const ctx = resolveAudioContext();
    if (!ctx) {
      audioGraphAttempted = true;
      warn('无 AudioContext 可用，音频图不装配（EQ / 频谱将不可用）');
      return null;
    }

    try {
      const source = ctx.createMediaElementSource(audio);
      const preamp = ctx.createGain();
      preamp.gain.value = 1;
      source.connect(preamp);

      const filters = [];
      let node = preamp;
      for (const band of EQ_BANDS) {
        const f = ctx.createBiquadFilter();
        f.type = band.type;
        f.frequency.value = band.freq;
        // Q 固定 1：与 eq.js:162 一致，改它等于改 EQ 曲线手感
        f.Q.value = 1;
        node.connect(f);
        node = f;
        filters.push(f);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      node.connect(analyser);
      analyser.connect(ctx.destination);

      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume().catch(() => {});
      }

      audioGraph = {
        ctx,
        source,
        preamp,
        filters,
        analyser,
        destination: ctx.destination,
      };
      return audioGraph;
    } catch (e) {
      audioGraphAttempted = true;
      warn(
        '音频图装配失败:',
        e && e.message,
        '（若为 InvalidStateError，说明该 audio 元素已被其它模块建过图 ——',
        'createMediaElementSource 只能调用一次）',
      );
      return null;
    }
  }

  return {
    // 驱动
    loadTrack, play, pause, toggle, stop,
    seek, seekBy,
    setVolume, getVolume, toggleMute,
    setRate, getRate,
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
