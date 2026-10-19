/**
 * 播放器辅助功能
 * - 前进/后退 10 秒
 * - 定时停止播放
 */

/** 取播放引擎（阶段 3 · P4：seek 归引擎管，它负责越界钳制与快照广播） */
function _engine() {
  return typeof window !== 'undefined' ? window.__playbackEngine : null;
}

/** 前进 10 秒 */
function seekForward10() {
  const engine = _engine();
  if (!engine) return;
  const snap = engine.getSnapshot();
  // duration 为 0/NaN 时不 seek（与旧实现 `isNaN(audio.duration)` 守卫等价）
  if (!snap || !(snap.duration > 0)) return;
  engine.seekBy(10);
}

/** 后退 10 秒 */
function seekBack10() {
  const engine = _engine();
  if (!engine) return;
  const snap = engine.getSnapshot();
  if (!snap || !(snap.duration > 0)) return;
  engine.seekBy(-10);
}

// ── 定时停止 ──────────────────────────────────────────
let _sleepTimer = null;
let _sleepEnd = null;

const SLEEP_OPTIONS = [
  { label: '🛑 取消定时', minutes: null },
  { label: '⏰ 15 分钟后', minutes: 15 },
  { label: '⏰ 30 分钟后', minutes: 30 },
  { label: '⏰ 60 分钟后', minutes: 60 },
  { label: '⏰ 90 分钟后', minutes: 90 },
];

/** 设置定时停止 */
function setSleepTimer(minutes) {
  const audio = document.getElementById('audioPlayer');
  if (!audio) return;

  // 清除已有计时
  clearSleepTimer();

  if (!minutes) {
    window.showToast?.('⏰ 定时已取消', 'info', 2000);
    updateSleepCountdown();
    return;
  }

  _sleepEnd = Date.now() + minutes * 60 * 1000;

  window.showToast?.(`⏰ 将在 ${minutes} 分钟后停止播放`, 'info', 2500);

  _sleepTimer = setInterval(() => {
    const remain = _sleepEnd - Date.now();
    if (remain <= 0) {
      // 淡出档位开着则缓停收尾（音量降到 0 时由 fade.js 真 pause），否则立即停
      if (typeof window.fadeOutPause !== 'function' || !window.fadeOutPause(audio)) audio.pause();
      // 此刻 audio 已处于暂停态，若再走通用播放/暂停切换函数会把播放又续上
      window.showToast?.('⏰ 定时到，播放已停止', 'info', 3000);
      clearSleepTimer();
      return;
    }
    updateSleepCountdown();
  }, 1000);
}

function clearSleepTimer() {
  if (_sleepTimer) {
    clearInterval(_sleepTimer);
    _sleepTimer = null;
  }
  _sleepEnd = null;
}

function updateSleepCountdown() {
  const el = document.getElementById('sleepCountdown');
  if (!el) return;
  if (!_sleepEnd) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  const remain = Math.max(0, Math.ceil((_sleepEnd - Date.now()) / 1000));
  const min = Math.floor(remain / 60);
  const sec = remain % 60;
  el.textContent = `⏰ ${min}:${sec.toString().padStart(2, '0')}`;
  el.style.display = 'inline';
}

// ── 全局导出 ──────────────────────────────────────────
window.seekForward10 = seekForward10;
window.seekBack10 = seekBack10;
window.setSleepTimer = setSleepTimer;
window.SLEEP_OPTIONS = SLEEP_OPTIONS;
