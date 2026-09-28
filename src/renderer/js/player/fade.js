/**
 * MusicDL 播放器 — 播放淡入 / 淡出（音量斜坡）
 *
 * 淡入只在「新曲起播 / 暂停后恢复」；缓冲恢复不淡（缓冲只发 waiting，
 * 不发 pause，故用 pause 标记区分）。目标音量取淡入瞬间的 audio.volume
 * （= 用户滑条值），不与音量控制争抢持久状态。
 * 淡出是「缓停」：暂停动作交给斜坡收尾——音量降到 0 才真 pause()，且收尾
 * 前把 volume 还原成滑条值（否则下次起播的淡入会取到 0 目标，永久静音）。
 * 纯函数导出供 node 直测；本文件不得 import 任何带顶层 window 的模块。
 */

// 档位（ms）：关 → 0.5s → 1s → 2s 循环
export const FADE_STEPS = [0, 500, 1000, 2000];

export function fadeStageLabel(ms) {
  return +ms ? (+ms / 1000) + 's' : '关';
}

/** 循环切档：未知值按「关」起 */
export function nextFadeMs(cur) {
  let idx = FADE_STEPS.indexOf(+cur);
  if (idx < 0) idx = 0;
  return FADE_STEPS[(idx + 1) % FADE_STEPS.length];
}

/** 线性斜坡 0→target；越界钳制，dur<=0 直接到位 */
export function fadeVolumeAt(target, startTs, now, durMs) {
  const t = +target || 0;
  if (!(durMs > 0)) return t;
  const p = (now - startTs) / durMs;
  if (p <= 0) return 0;
  if (p >= 1) return t;
  return +(t * p).toFixed(4);
}

/** 是否该淡入：pause 后恢复、或新曲刚起播（currentTime 极小） */
export function shouldFadeIn(wasPaused, currentTime) {
  return !!wasPaused || (!currentTime) || currentTime < 1;
}

/**
 * 淡出（缓停）斜坡：start→0 线性下降，越界钳制。
 * dur<=0 直接回 0（等价于「关」档不该进到这里，留一手防调用方漏判）。
 */
export function fadeOutVolumeAt(startVol, startTs, now, durMs) {
  const s = +startVol || 0;
  if (!(durMs > 0)) return 0;
  const p = (now - startTs) / durMs;
  if (p <= 0) return s;
  if (p >= 1) return 0;
  return +(s * (1 - p)).toFixed(4);
}

// ── DOM 接线（浏览器环境才挂）──────────────────────────
let _fadeMs = 0;
let _raf = 0;
let _fadeOutMs = 0;
let _outRaf = 0;
let _outAudio = null;
let _outResumeVol = 0;

function _setBadge() {
  const el = document.getElementById('fadeInVal');
  if (el) el.textContent = fadeStageLabel(_fadeMs);
}

function _setOutBadge() {
  const el = document.getElementById('fadeOutVal');
  if (el) el.textContent = fadeStageLabel(_fadeOutMs);
}

function _cancelRaf() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
}

/** 取消缓停：把音量交还滑条值，别让「正播着」或下次起播停在静音上 */
function _cancelFadeOut() {
  if (_outRaf) { cancelAnimationFrame(_outRaf); _outRaf = 0; }
  if (_outAudio && _outResumeVol > 0) _outAudio.volume = _outResumeVol;
  _outAudio = null;
  _outResumeVol = 0;
}

/**
 * 缓停入口：该淡出则接管本次暂停，音量降到 0 才真 pause()。
 * @returns {boolean} true = 暂停交给淡出收尾了，调用方不要再 pause()
 */
export function fadeOutPause(audio) {
  if (!_fadeOutMs || _outRaf || !audio || audio.paused) return false;
  const start = audio.muted ? 0 : audio.volume;
  if (start <= 0.02) return false; // 本来就没什么声，淡了也听不出
  _cancelRaf(); // 淡入还在跑的话先接管音量，免得两条斜坡互相写
  _outAudio = audio;
  _outResumeVol = start;
  const t0 = performance.now();
  const step = (now) => {
    const v = fadeOutVolumeAt(start, t0, now, _fadeOutMs);
    if (v > 0) {
      audio.volume = v;
      _outRaf = requestAnimationFrame(step);
      return;
    }
    _outRaf = 0;
    _cancelFadeOut(); // 还原滑条音量后再停：淡入取的是起播瞬间的 volume
    audio.pause();
  };
  _outRaf = requestAnimationFrame(step);
  return true;
}

function _startFadeIn(audio) {
  if (!_fadeMs) return;
  _cancelRaf();
  const target = audio.muted ? 0 : audio.volume;
  if (target <= 0.02) return; // 已很小：多半是淡入中途误触，跳过防抖到错误目标
  const t0 = performance.now();
  audio.volume = 0;
  const step = (now) => {
    const v = fadeVolumeAt(target, t0, now, _fadeMs);
    audio.volume = v;
    _raf = v < target ? requestAnimationFrame(step) : 0;
  };
  _raf = requestAnimationFrame(step);
}

function _wire() {
  const audio = document.getElementById('audioPlayer');
  if (!audio) return;
  let wasPaused = true; // 首播前视作暂停态 → 起播淡入
  audio.addEventListener('pause', () => { wasPaused = true; _cancelRaf(); _cancelFadeOut(); });
  audio.addEventListener('play', () => { _cancelFadeOut(); }); // 缓停中途又开播：音量交还，歌没停过就不淡
  audio.addEventListener('playing', () => {
    if (shouldFadeIn(wasPaused, audio.currentTime)) _startFadeIn(audio);
    wasPaused = false;
  });
  api.getPref('fadeInMs').then(v => { _fadeMs = +v || 0; _setBadge(); }).catch(() => {});
  api.getPref('fadeOutMs').then(v => { _fadeOutMs = +v || 0; _setOutBadge(); }).catch(() => {});
}

/** 更多菜单/命令面板入口：循环档位并持久化 */
export function cycleFadeIn() {
  _fadeMs = nextFadeMs(_fadeMs);
  _setBadge();
  try { api.setPref('fadeInMs', _fadeMs); } catch (_e) { /* 持久化失败不挡本次 */ }
  showToast('淡入：' + fadeStageLabel(_fadeMs), 'info', 1800);
}

/** 淡出档位入口：与淡入共用档位表 */
export function cycleFadeOut() {
  _fadeOutMs = nextFadeMs(_fadeOutMs);
  _setOutBadge();
  try { api.setPref('fadeOutMs', _fadeOutMs); } catch (_e) { /* 持久化失败不挡本次 */ }
  showToast('淡出：' + fadeStageLabel(_fadeOutMs), 'info', 1800);
}

/**
 * 淡入/淡出的「默认态」：设置页「恢复所有设置」叫这一家，
 * 而不是把 fadeInMs/fadeOutMs 抄进重置清单（158 的规矩：替别人写默认值必然漏项或漂移）。
 * 档位表第一档就是「关」，默认值取 FADE_STEPS[0] —— 不再抄一份 0。
 */
export function resetFadeSettings() {
  _fadeMs = FADE_STEPS[0];
  _fadeOutMs = FADE_STEPS[0];
  _setBadge();
  _setOutBadge();
  try { api.setPref('fadeInMs', _fadeMs); } catch (_e) { /* 持久化失败不挡本次 */ }
  try { api.setPref('fadeOutMs', _fadeOutMs); } catch (_e) { /* 同上 */ }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire, { once: true });
  } else {
    setTimeout(_wire, 0);
  }
  window.cycleFadeIn = cycleFadeIn;
  window.cycleFadeOut = cycleFadeOut;
  window.fadeOutPause = fadeOutPause;
  window.resetFadeSettings = resetFadeSettings;
}
