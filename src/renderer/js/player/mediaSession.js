/**
 * 系统级「正在播放」桥接（navigator.mediaSession）
 *
 * 价值：Windows 音量浮窗 / 锁屏 / Xbox Game Bar 显示曲目信息，
 * 系统媒体键经 actionHandler 直接控制播放 —— 复用既有
 * window.togglePlay/nextSong/prevSong 桥（不 import player.js，避免循环依赖）。
 *
 * 全部调用 try/catch 吞异常：Media Session 各浏览器/Electron 版本支持度不一，
 * 任何一步失败都不允许影响应用内播放。
 */

import { logger } from '../logger.js';

const SEEK_STEP_SEC = 5;

/**
 * 纯映射：歌曲对象 → MediaMetadata 参数（供单测覆盖，无 DOM 依赖）。
 * artist 兼容 'a、b' 字符串与 [{name}] 数组两种上游形态。
 */
export function buildMediaMetadata(song) {
  if (!song) return null;
  let artist = song.artist;
  if (Array.isArray(artist)) {
    artist = artist.map(a => (a && (a.name || a.artist)) || '').filter(Boolean).join('、');
  } else if (artist && typeof artist === 'object') {
    artist = artist.name || '';
  }
  const meta = {
    title: String(song.title || '未知歌曲').slice(0, 200),
    artist: String(artist || '未知歌手').slice(0, 200),
    album: String(song.album || '').slice(0, 200),
  };
  const cover = typeof song.cover === 'string' ? song.cover.trim() : '';
  if (cover && /^(https?:|data:)/.test(cover)) {
    meta.artwork = [{ src: cover, sizes: '512x512', type: '' }];
  }
  return meta;
}

/** 纯映射：音频元素 → positionState（duration 未知时给 Infinity = 流式直播语义） */
export function buildPositionState(audio) {
  if (!audio) return null;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
  const position = Math.max(0, Number(audio.currentTime) || 0);
  return { duration, playbackRate: Number(audio.playbackRate) || 1, position };
}

/**
 * 引擎快照 → buildPositionState 认识的形状。
 *
 * 为什么不直接改 buildPositionState 的签名：它是导出函数且有既有测试按
 * 「audio 元素」口径断言（test/mediaSession*.test.js）。迁移期保持它的契约不变，
 * 在调用点做一次适配，比让一个纯函数同时认两种形状要干净。
 */
function _snapshotAsPositionSource(snap) {
  return {
    duration: snap.duration,
    currentTime: snap.position,
    playbackRate: snap.rate,
  };
}

function _call(name) {
  try {
    if (typeof window[name] === 'function') window[name]();
  } catch (e) {
    logger.warn('[mediaSession]', name, '失败:', e.message);
  }
}

/** 刷新元数据 + 播放态 + 进度（audio 事件驱动，全部来源统一走这里） */
function _syncNow() {
  try {
    // 阶段 3 · P2：播放状态改从引擎快照读，不再自己 getElementById('audioPlayer')。
    // 引擎是 audio 元素的唯一所有者，读它的 snapshot 才不会出现
    // 「UI 显示在播、audio 实际已暂停」这类双源不一致。
    const engine = typeof window !== 'undefined' ? window.__playbackEngine : null;
    const snap = engine && typeof engine.getSnapshot === 'function' ? engine.getSnapshot() : null;
    const song = (snap && snap.song)
      || (typeof getState === 'function' && getState('currentPlaying'))
      || null;
    if (song) {
      const meta = buildMediaMetadata(song);
      if (meta && window.MediaMetadata) {
        navigator.mediaSession.metadata = new window.MediaMetadata(meta);
      }
    }
    if (!snap) return;
    // state 是引擎的显式状态机；playing 之外一律视为暂停（含 loading/error/idle）
    navigator.mediaSession.playbackState = snap.state === 'playing' ? 'playing' : 'paused';
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      navigator.mediaSession.setPositionState(buildPositionState(_snapshotAsPositionSource(snap)));
    }
  } catch (e) {
    logger.warn('[mediaSession] sync 失败:', e.message);
  }
}

/**
 * 初始化：app 启动完成后调用一次。不支持 Media Session 的环境静默退出。
 */
export function initMediaSession() {
  try {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const audio = document.getElementById('audioPlayer');
    if (!audio) return;

    const set = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (_e) { /* 不支持的动作忽略 */ }
    };
    set('play', () => { if (audio.paused) _call('togglePlay'); });
    set('pause', () => { if (!audio.paused) _call('togglePlay'); });
    set('previoustrack', () => _call('prevSong'));
    set('nexttrack', () => _call('nextSong'));
    set('stop', () => {
      if (audio.paused) return;
      // 淡出档位开着时先缓停（pause 动作本就走 togglePlay，stop 动作是直连的）
      if (typeof window.fadeOutPause === 'function' && window.fadeOutPause(audio)) return;
      audio.pause();
    });
    set('seekto', (d) => {
      if (d && typeof d.seekTime === 'number' && Number.isFinite(d.seekTime)) {
        audio.currentTime = Math.max(0, d.seekTime);
        _syncNow();
      }
    });
    set('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - SEEK_STEP_SEC); _syncNow(); });
    set('seekforward', () => { audio.currentTime = audio.currentTime + SEEK_STEP_SEC; _syncNow(); });

    audio.addEventListener('play', _syncNow);
    audio.addEventListener('pause', _syncNow);
    audio.addEventListener('loadedmetadata', _syncNow);
    // 低频进度同步（timeupdate 每秒 4 次会淹没系统 IPC；10s 一次足够锁屏进度条）
    let _lastPosSync = 0;
    audio.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - _lastPosSync > 10000) { _lastPosSync = now; _syncNow(); }
    });

    _syncNow();
  } catch (e) {
    logger.warn('[mediaSession] 初始化失败（不影响应用内播放）:', e.message);
  }
}
