/**
 * playback-engine.test.js — 播放引擎接口契约测试（Sprint 1 · S1，先红）
 *
 * 背景
 * ----
 * 蓝图 docs/architecture/PLAYBACK-ENGINE.md 阶段 1 要新建
 * `src/renderer/js/playback/engine.js`，把 <audio> 元素的唯一所有权、
 * 显式播放状态机与事件总线收进一个可测模块。
 *
 * 本文件按蓝图第 4 节「接口草案」先立契约：**此刻 import 必然失败
 * （模块不存在），测试全红**——这是设计好的「先红」，证明测的是
 * **新引擎接口**，而不是任何既有实现的镜像。
 *
 * 三条纪律
 * --------
 * 1. 引擎零 DOM 依赖（除注入的 audio 元素），所以这里用假 audio 驱动；
 * 2. 中文用例名一律说明「接口契约」与它防住的退化，不写实现细节；
 * 3. 断言只依赖 createPlaybackEngine 的公开形状，不窥探内部变量。
 *
 * 蓝图第 5 节阶段 1 验收要求「引擎接口测试全绿」，本文件即那份验收件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ENGINE_PATH = '../src/renderer/js/playback/engine.js';

/** 蓝图第 4 节声明的状态全集（状态机节点） */
const STATES = ['idle', 'loading', 'playing', 'paused', 'error'];

/** 蓝图第 4 节声明的播放模式全集 */
const MODES = ['order', 'shuffle', 'single', 'list-loop'];

/** 蓝图第 4 节：错误码从既有 fallbackCodes.js / playError.js 收敛，不新造 */
const ERROR_CODES = [
  'ABORTED', 'NETWORK', 'NO_AUDIO', 'VIP_REQUIRED',
  'LOGIN_REQUIRED', 'SOURCE_UNAVAILABLE', 'DECODE_ERROR',
];

/** 蓝图第 4 节声明的快照形状（键序无关，键集合必须一致） */
const SNAPSHOT_KEYS = [
  'state', 'song', 'error', 'position', 'duration',
  'volume', 'muted', 'rate', 'mode', 'queueIdx', 'queueLength',
];

/** 蓝图第 4 节声明的公开面（约 12 个方法） */
const DRIVER_METHODS = ['loadTrack', 'play', 'pause', 'toggle', 'stop', 'seek', 'seekBy',
  'setVolume', 'getVolume', 'toggleMute', 'setRate', 'getRate'];
const QUEUE_METHODS = ['setQueue', 'playAt', 'next', 'prev', 'setMode'];
const OBSERVE_METHODS = ['subscribe', 'getSnapshot', 'getAudioGraph'];

/** 最小假 audio：只实现引擎与测试真正会用到的成员 */
function createFakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    currentTime: 0,
    duration: NaN,
    volume: 1,
    muted: false,
    playbackRate: 1,
    paused: true,
    readyState: 0,
    error: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      for (const fn of listeners.get(type) || []) fn(payload || {});
    },
    async play() { this.paused = false; this.emit('play'); return undefined; },
    pause() { this.paused = true; this.emit('pause'); },
    load() {},
  };
}

/** 引擎尚未实现时的占位：让失败信息说清「接口不存在」而不是 TypeError 噪音 */
async function loadEngine() {
  return import(ENGINE_PATH);
}

// ── A. 模块契约 ───────────────────────────────────────────────
test('接口契约：engine.js 导出 createPlaybackEngine 工厂函数', async () => {
  const mod = await loadEngine();
  assert.equal(typeof mod.createPlaybackEngine, 'function',
    '蓝图第 4 节要求 src/renderer/js/playback/engine.js 导出 createPlaybackEngine');
});

test('接口契约：createPlaybackEngine 返回蓝图第 4 节声明的完整公开面', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({
    audio: createFakeAudio(),
    resolveTrack: async () => ({ url: 'file:///x.mp3', referer: '', quality: 'standard' }),
    proxyPlay: async () => ({ fileUrl: 'stream://x' }),
    saveProgress: () => {},
    loadProgress: async () => 0,
    logger: null,
  });
  for (const name of [...DRIVER_METHODS, ...QUEUE_METHODS, ...OBSERVE_METHODS]) {
    assert.equal(typeof engine[name], 'function', `公开面缺方法 ${name}`);
  }
});

// ── B. 观察面契约 ─────────────────────────────────────────────
test('接口契约：subscribe 返回可卸载函数，且 fn 收到的就是 getSnapshot 的形状', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  const off = engine.subscribe(() => {});
  assert.equal(typeof off, 'function', 'subscribe 必须返回 unsubscribe');

  const seen = [];
  const off2 = engine.subscribe((snap) => seen.push(snap));
  assert.equal(engine.getSnapshot().state, 'idle', '未加载任何曲目时应处于 idle');
  assert.deepEqual(Object.keys(engine.getSnapshot()).sort(), [...SNAPSHOT_KEYS].sort(),
    '快照键集合必须与蓝图第 4 节一致');
  off2();
  // 卸载后不得再收到广播（否则订阅者会越积越多，重放旧快照）
  const before = seen.length;
  engine.setVolume(0.5);
  assert.equal(seen.length, before, 'unsubscribe 之后不应再收到广播');
  off();
});

test('接口契约：getSnapshot 初始值为空闲态且歌曲为空', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  const snap = engine.getSnapshot();
  assert.equal(snap.state, 'idle');
  assert.equal(snap.song, null);
  assert.equal(snap.error, null);
  assert.equal(snap.position, 0);
  assert.equal(snap.volume, 1);
  assert.equal(snap.muted, false);
  assert.equal(snap.rate, 1);
  assert.equal(snap.queueIdx, -1);
  assert.equal(snap.queueLength, 0);
});

test('接口契约：每次状态转移都向订阅者广播一次快照', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  const states = [];
  engine.subscribe((snap) => states.push(snap.state));
  await engine.loadTrack({ id: 1, title: 'A', source: 'local', filePath: 'D:/a.mp3' });
  assert.ok(states.includes('loading'), 'loadTrack 之后必须广播 loading');
});

// ── C. 状态机契约 ─────────────────────────────────────────────
test('接口契约：loadTrack 后状态进入 loading（不是直接 playing）', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  await engine.loadTrack({ id: 1, title: 'A', source: 'local', filePath: 'D:/a.mp3' });
  assert.equal(engine.getSnapshot().state, 'loading',
    '蓝图 D2：loadTrack 只允许推进到 loading，playing 由音频元素真的响起来决定');
});

test('接口契约：状态机转移序列 idle→loading→playing→paused→idle 全程广播', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({ audio, resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  const seq = [];
  engine.subscribe((snap) => seq.push(snap.state));
  await engine.loadTrack({ id: 1, title: 'A', source: 'local', filePath: 'D:/a.mp3' });
  audio.emit('playing');
  engine.pause();
  engine.stop();
  assert.ok(STATES.includes(seq[0]), '广播序列里的每个值都应是合法状态');
  assert.equal(seq[0], 'idle', '首次广播应为初始 idle');
  assert.deepEqual(seq, ['idle', 'loading', 'playing', 'paused', 'idle'],
    '蓝图 D2 的状态机：每次转移 broadcast，UI 只读不写');
});

test('接口契约：错误转移到 error 态并带上 code/message', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({
    audio,
    resolveTrack: async () => { throw Object.assign(new Error('取流失败'), { code: 'NETWORK' }); },
    proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null,
  });
  await engine.loadTrack({ id: 2, title: 'B', source: 'Netease', id3: 2 });
  assert.equal(engine.getSnapshot().state, 'error');
  assert.ok(engine.getSnapshot().error, 'error 态必须带错误对象');
  assert.equal(engine.getSnapshot().error.code, 'NETWORK');
  assert.equal(typeof engine.getSnapshot().error.message, 'string');
});

test('接口契约：错误码集合恰为蓝图第 4 节列出的七个', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  assert.deepEqual([...(engine.ERROR_CODES || [])].sort(), [...ERROR_CODES].sort(),
    '错误码从既有 fallbackCodes.js / playError.js 收敛，不新造');
});

// ── D. 队列契约 ───────────────────────────────────────────────
test('接口契约：setQueue 后 queueLength 就位，playAt 指定起始曲目', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setQueue([{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }], 1);
  const snap = engine.getSnapshot();
  assert.equal(snap.queueLength, 3);
  assert.equal(snap.queueIdx, 1, 'playAt/startIdx 必须落到快照上，供所有 UI 读同一处');
});

test('接口契约：顺序模式下 next/prev 索引线性推进并正确回绕', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setMode('order');
  engine.setQueue([{ id: 1 }, { id: 2 }, { id: 3 }], 0);
  engine.next();
  assert.equal(engine.getSnapshot().queueIdx, 1);
  engine.next();
  assert.equal(engine.getSnapshot().queueIdx, 2);
  engine.next();
  assert.equal(engine.getSnapshot().queueIdx, 0, '顺序模式到头应停队首（与既有 nextPrefetchIdx 语义一致）');
  engine.prev();
  assert.equal(engine.getSnapshot().queueIdx, 2, '队首按上一首应绕到队尾');
});

test('接口契约：列表循环模式 next 到尾后回队首', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setMode('list-loop');
  engine.setQueue([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  engine.next();
  assert.equal(engine.getSnapshot().queueIdx, 0, '列表循环：尾后回到队首');
});

test('接口契约：单曲循环模式 next 停在自己', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setMode('single');
  engine.setQueue([{ id: 1 }, { id: 2 }, { id: 3 }], 1);
  engine.next();
  assert.equal(engine.getSnapshot().queueIdx, 1, '单曲循环：下一首仍是自己');
});

test('接口契约：随机模式下 next 不越界且不承诺顺序', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setMode('shuffle');
  engine.setQueue([{ id: 1 }, { id: 2 }, { id: 3 }], 0);
  engine.next();
  const idx = engine.getSnapshot().queueIdx;
  assert.ok(idx >= 0 && idx < 3, '随机模式的索引必须仍落在队列内');
});

test('接口契约：setMode 只接受蓝图第 4 节的四个模式', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  for (const mode of MODES) {
    engine.setMode(mode);
    assert.equal(engine.getSnapshot().mode, mode);
  }
});

// ── E. 驱动面契约 ─────────────────────────────────────────────
test('接口契约：播放驱动四态切换 play/pause/toggle/stop 全部落在状态机上', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({ audio, resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setQueue([{ id: 1, source: 'local', filePath: 'D:/a.mp3' }], 0);
  await engine.loadTrack({ id: 1, source: 'local', filePath: 'D:/a.mp3' });
  engine.play();
  assert.equal(engine.getSnapshot().state, 'playing', '音频真的响应 play 后才算 playing');
  engine.pause();
  assert.equal(engine.getSnapshot().state, 'paused');
  engine.toggle();
  assert.equal(engine.getSnapshot().state, 'playing', 'toggle 在 paused 上应恢复播放');
  engine.stop();
  assert.equal(engine.getSnapshot().state, 'idle', 'stop 回到 idle 并清空当前曲目');
});

test('接口契约：seek/seekBy 只改 position，不触发状态转移', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({ audio, resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setQueue([{ id: 1, source: 'local', filePath: 'D:/a.mp3' }], 0);
  await engine.loadTrack({ id: 1, source: 'local', filePath: 'D:/a.mp3' });
  audio.duration = 200;
  engine.seek(30);
  assert.equal(engine.getSnapshot().position, 30);
  engine.seekBy(10);
  assert.equal(engine.getSnapshot().position, 40);
  engine.seekBy(-100);
  assert.equal(engine.getSnapshot().position, 0, 'seekBy 不得把位置推到 0 以下');
});

test('接口契约：音量与静音由引擎单一持有，读回一致', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({ audio, resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setVolume(0.3);
  assert.equal(engine.getVolume(), 0.3, 'getVolume 必须与 setVolume 一致（音量只有引擎一个主人）');
  assert.equal(audio.volume, 0.3, '引擎应把音量写进注入的 audio 元素');
  engine.toggleMute();
  assert.equal(engine.getSnapshot().muted, true);
  engine.toggleMute();
  assert.equal(engine.getSnapshot().muted, false);
  engine.setVolume(5);
  assert.ok(engine.getVolume() <= 1 && engine.getVolume() >= 0, '音量必须钳在 0..1');
});

test('接口契约：倍速 setRate/getRate 读回一致且写进 audio', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  const engine = mod.createPlaybackEngine({ audio, resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  engine.setRate(1.5);
  assert.equal(engine.getRate(), 1.5);
  assert.equal(audio.playbackRate, 1.5);
});

// ── F. 音频图契约 ─────────────────────────────────────────────
test('接口契约：getAudioGraph 未建图时返回 null，不抛错', async () => {
  const mod = await loadEngine();
  const engine = mod.createPlaybackEngine({ audio: createFakeAudio(), resolveTrack: async () => ({ url: 'file:///a.mp3' }), proxyPlay: async () => ({}), saveProgress: () => {}, loadProgress: async () => 0, logger: null });
  assert.ok(engine.getAudioGraph() === null || typeof engine.getAudioGraph() === 'object',
    '未装配音频图时应给 null（蓝图第 4 节签名）');
});

// ── G. 音频图幂等契约（S2b） ──────────────────────────────────
test('接口契约：getAudioGraph 幂等——重复调用返回同一张图，工厂与 MediaElementSource 各只调用一次', async () => {
  const mod = await loadEngine();
  const audio = createFakeAudio();
  let factoryCalls = 0;
  let sourceCalls = 0;

  function fakeNode(extra = {}) {
    return {
      connect() {},
      gain: { value: 0 },
      frequency: { value: 0 },
      Q: { value: 0 },
      type: '',
      fftSize: 0,
      smoothingTimeConstant: 0,
      ...extra,
    };
  }

  const fakeCtx = {
    state: 'running',
    destination: fakeNode(),
    createMediaElementSource() { sourceCalls++; return fakeNode(); },
    createGain() { return fakeNode(); },
    createBiquadFilter() { return fakeNode(); },
    createAnalyser() { return fakeNode(); },
    resume() { return Promise.resolve(); },
  };

  const engine = mod.createPlaybackEngine({
    audio,
    resolveTrack: async () => ({ url: 'file:///a.mp3' }),
    proxyPlay: async () => ({}),
    saveProgress: () => {},
    loadProgress: async () => 0,
    logger: null,
    audioContextFactory: () => { factoryCalls++; return fakeCtx; },
  });

  const g1 = engine.getAudioGraph();
  const g2 = engine.getAudioGraph();
  assert.ok(g1, '注入音频上下文工厂后应能建图');
  assert.equal(g1, g2, '重复调用必须返回同一张图（引用相等）——这是幂等的正面证据');
  assert.equal(factoryCalls, 1, 'AudioContext 工厂只能被调用一次（第二次不得再建上下文）');
  assert.equal(sourceCalls, 1,
    'createMediaElementSource 只能调用一次：第二次会抛 InvalidStateError，而旧 eq.js 的静默 catch 会让 EQ 无声失效');
  assert.equal(g1.filters.length, 5, 'EQ 五段滤波必须全部装配');
  assert.deepEqual(
    g1.filters.map((f) => f.type),
    ['lowshelf', 'peaking', 'peaking', 'peaking', 'highshelf'],
    '频段类型顺序必须与 eq.js:36-42 一致，否则 EQ 曲线手感会变',
  );
  assert.ok(g1.preamp && g1.analyser && g1.destination, '图必须含 preamp / analyser / destination 三件');
});
