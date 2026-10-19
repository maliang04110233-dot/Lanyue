/**
 * MusicDL 渲染层 — 播放状态外发同步 + 播放队列恢复
 *
 * 自 app.js 的 init() 内闭包提出：原先这四个函数定义在 init() 内部，
 * 彼此闭包引用同批 init 局部变量。它们**只被 init 调用、彼此互调**，
 * 对外无其他调用方，故可整体外提；唯一共享状态 `_audio` 改为显式传入，
 * 不再依赖模块级可变变量（消除「谁先赋值」的隐式时序）。
 *
 * 依赖全局：api、getState、setState、fmtTime、showToast、
 *          updatePlayerCard、updatePlayModeButton（均由 preload / 兄弟模块挂 window）
 *
 * 拆分性质：**等价迁移，行为零改动**。守卫见 test/player-sync.test.js
 * 与 test/renderer-contract.test.js。
 */

// ── 播放状态同步到系统托盘 ──────────────────────────
export function syncToTray(audio) {
  if (typeof api.trayUpdatePlayState !== 'function') return;
  const song = _currentSong();
  const isPlaying = audio && !audio.paused;
  api.trayUpdatePlayState({
    isPlaying,
    title: song?.title || '',
    artist: song?.artist || '',
  });
}

// ── 换曲判定：两处同步共用的唯一实现 ──────────────────
// 阶段 3 · P3：syncToMiniPlayer 与 syncToDesktopLyric 原先各写一份
// `String(song.id) + ':' + String(song.source || '')` 并各养一个模块级
// `let _lastSongKey`。同一概念两份实现正是 CONTRIBUTING 铁律 2 要消灭的模式，
// 只是它长在渲染层、铁律清单没覆盖到。这里收敛为纯函数 + 两个独立游标。
//
// 为什么仍保留两个游标而不是合成一个：两个窗口的「重推时机」不同 ——
// 迷你播放器在窗口打开时要重推元信息，桌面歌词要重推整份歌词；
// 若共用一个游标，重置其中一个会误让另一个以为「歌没变」而跳过推送。
export function songKeyOf(song) {
  return song ? String(song.id) + ':' + String(song.source || '') : '';
}

/** 当前正在播放的歌（含播放队列兜底），三处同步共用同一取法 */
function _currentSong() {
  return getState('currentPlaying') || (getState('playQueue') || [])[getState('playIdx')] || null;
}

// ── 播放状态同步到迷你播放器 ──────────────────────────
// M13: cover 可能是 base64 大图，原先每帧（timeupdate ~4Hz）整份 IPC 序列化
// 一遍。现在曲名/艺术家/封面只在换曲时推一次，每帧只推播放态/进度/歌词行。
let _mpLastSongKey = null;

export function resetMiniPlayerSong() {
  _mpLastSongKey = null;
}

export function syncToMiniPlayer(audio) {
  if (typeof api.syncMiniPlayer !== 'function' || !audio) return;
  const song = _currentSong();
  const progress = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;

  // 获取当前歌词行
  let currentLyric = '';
  const parsedLyrics = getState('parsedLyrics');
  if (parsedLyrics && parsedLyrics.length) {
    const idx = parsedLyrics.findIndex(l => l.t > audio.currentTime) - 1;
    if (idx >= 0 && idx < parsedLyrics.length) {
      currentLyric = parsedLyrics[idx].text || '';
    }
  }

  const timeNow = fmtTime(audio.currentTime);
  const timeTotal = fmtTime(audio.duration);
  const timeStr = `${timeNow} / ${timeTotal}`;

  const payload = {
    playing: !audio.paused,
    progress,
    lyric: currentLyric,
    time: timeStr,
  };
  const songKey = songKeyOf(song);
  if (songKey !== _mpLastSongKey) {
    _mpLastSongKey = songKey;
    payload.title = song ? song.title : '未在播放';
    payload.artist = song ? (song.artist || '未知艺术家') : '—';
    payload.cover = song ? (song.cover || '') : '';
    payload.quality = song ? (song._playedQuality || '') : '';
  }
  api.syncMiniPlayer(payload);
}

// ── 播放状态同步到桌面歌词窗口 ────────────────────────
// 歌词整份只在换歌时推一次（避免每帧序列化整份 parsedLyrics），
// currentTime 每帧推；桌面窗口自行定位当前行+逐字高亮
let _dlLastLyricSongId = null;

export function syncToDesktopLyric(audio) {
  if (typeof api.syncDesktopLyric !== 'function' || !audio) return;
  const song = _currentSong();
  const payload = { currentTime: audio.currentTime };
  const songKey = songKeyOf(song);
  if (songKey !== _dlLastLyricSongId) {
    _dlLastLyricSongId = songKey;
    const parsed = getState('parsedLyrics') || [];
    // 只送渲染所需字段（wordTimes 用于逐字高亮）
    payload.lyrics = parsed.map(l => ({
      t: l.t, text: l.text, subText: l.subText || '',
      words: l.words || [], wordTimes: l.wordTimes || [],
    }));
    payload.title = song ? song.title : '';
  }
  api.syncDesktopLyric(payload);
}

/** 桌面歌词窗口要全量状态时清掉「上次推送的歌」，强制重推整份歌词 */
export function resetDesktopLyricSong() {
  _dlLastLyricSongId = null;
}

// ── 播放队列持久化 ─────────────────────────────────
let _queueRestored = false; // 防双重恢复

// 辅助函数：恢复 loopMode/isShuffled 后更新按钮视觉
export function applyRestoredPlayMode(loopMode, isShuffled) {
  if (typeof loopMode === 'number') {
    setState('loopMode', loopMode);
  }
  if (typeof isShuffled === 'boolean') {
    setState('isShuffled', isShuffled);
  }
  // 更新合并按钮的视觉
  if (typeof updatePlayModeButton === 'function') updatePlayModeButton();
}

export function restorePlayQueueFromSaved(saved) {
  if (_queueRestored || !saved || !saved.queue || !saved.queue.length) return;
  _queueRestored = true;
  setState('playQueue', saved.queue);
  if (typeof saved.playIdx === 'number' && saved.playIdx >= 0 && saved.playIdx < saved.queue.length) {
    setState('playIdx', saved.playIdx);
  }
  applyRestoredPlayMode(saved.loopMode, saved.isShuffled);
  // 在播放器卡片上显示第一首歌（不自动播放）
  const idx = (typeof saved.playIdx === 'number' && saved.playIdx >= 0 && saved.playIdx < saved.queue.length) ? saved.playIdx : 0;
  if (saved.queue[idx]) {
    if (typeof updatePlayerCard === 'function') updatePlayerCard(saved.queue[idx]);
  }
  // 取词走 i18n.js 挂的 window.t：本文件被守卫测试钉死零 import，
  // 而带变量的整句模板串在英文界面下永远撞不到值匹配（191 实测）。
  showToast(window.t('toast.queueRestored', { count: saved.queue.length }), 'info', 2000);
}
