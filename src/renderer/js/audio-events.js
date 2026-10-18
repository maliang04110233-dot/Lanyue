/**
 * 音频元素事件绑定 —— 自 app.js init() 内闭包提出，等价迁移
 *
 * 迁移约定与 player-sync.js 一致（等价迁移、显式传参）：
 *   - `_audio` 由调用方（app.js init）从 DOM 取得后传入，本模块不碰 DOM 查询；
 *   - 25s 加载超时守卫（_loadWatchSince/_loadWatchTimer）与连续播放失败
 *     熔断器（_playFailGuard）挂钩在事件回调里，故随本模块一起迁入 ——
 *     三处（error / 超时 / playing）共用同一份计数，不允许分裂成两个实例。
 * 相关钉：test/play-error.test.js、test/play-failure-retry.test.js、
 *        test/player-sync.test.js（syncTo* 调用实参扫描覆盖本文件）。
 */

import { describePlayError, playFailureRetry, playFailureRetryText } from './playError.js';
import { retryAfterPlayFailure } from './playRetry.js';
import { createPlayFailGuard } from './playFailGuard.js';
import { updateProgress, onAudioEnded } from './player.js';
import { syncToMiniPlayer, syncToDesktopLyric, syncToTray } from './player-sync.js';
// t 要在本文件里直接取 toast.* 词条：动态文案的家是语言包，不是调用点
import { t } from './i18n.js';

// 25s 加载超时守卫状态
let _loadWatchSince = 0;
let _loadWatchTimer = null;
// 连续播放失败熔断器（模块级单例：跨 error / playing / 超时守卫三处共用一份计数）
const _playFailGuard = createPlayFailGuard();

export function setupAudioEvents(_audio) {
  if (!_audio) return; // audio 元素不存在，跳过

  // timeupdate 只注册一次：同时驱动进度条和迷你播放器同步
  // （此前注册了两个 timeupdate，updateProgress 每帧跑两遍）
  _audio.addEventListener('timeupdate', () => {
    updateProgress();
    syncToMiniPlayer(_audio);
    syncToDesktopLyric(_audio);
  });
  _audio.addEventListener('ended', onAudioEnded);
  // 音源加载/解码出错（URL 失效、代理文件损坏）：toast + 跳下一曲，避免静默卡死。
  // 文案按行来源分流：本地文件被移走时不能说"音源出错"，那会把人支去查网络。
  _audio.addEventListener('error', () => {
    const cur = getState('currentPlaying');
    if (!cur || !_audio.error) return;
    // 连续失败熔断：循环模式下 nextSong 是无限循环，一次失败会被放大成
    // toast 糊满整屏（截图实证）。到线就停在这里，并把计数让给用户的手动操作。
    const guard = _playFailGuard.fail();
    if (guard.tripped) {
      _playFailGuard.reset();
      _audio.pause();
      showToast(t('toast.playFailStreak', { n: guard.threshold }), 'warn', 6000);
      return;
    }
    const e = describePlayError(cur, _audio.error.code);
    // 本地文件行播不出来 = 盘和记录的引用断了，就地给一口「⬇ 重新下载」，
    // 不必让人翻到下载历史页去找那一行。判据（哪些行真有源可下）在 playError.js。
    const retry = playFailureRetry(cur, _audio.error.code);
    if (retry) {
      showActionToast({
        text: playFailureRetryText(cur), btnLabel: t('toast.redownloadBtn'), ttl: 9000, onConfirm: () => retryAfterPlayFailure(retry),
      });
    } else {
      showToast(e.text, e.kind, e.local ? 5500 : 3000);
    }
    if (typeof window.nextSong === 'function') window.nextSong();
  });
  // 25s 加载超时守卫（借鉴 lx usePlayEvent）：一直没等到可播数据则跳下一曲，
  // 避免 CDN 半开连接导致播放器永久卡死
  _loadWatchTimer = setInterval(() => {
    const cur = getState('currentPlaying');
    const isStuck = cur && _audio.readyState < 2 && !_audio.paused;
    if (isStuck) {
      const now = Date.now();
      if (!_loadWatchSince) _loadWatchSince = now;
      if (now - _loadWatchSince > 25000) {
        _loadWatchSince = 0;
        // 超时也是"起不来"，走同一条熔断：不接进来，超时这条侧门会继续刷屏
        const g2 = _playFailGuard.fail();
        if (g2.tripped) {
          _playFailGuard.reset();
          _audio.pause();
          showToast(t('toast.playFailStreak', { n: g2.threshold }), 'warn', 6000);
          return;
        }
        showToast(t('toast.streamTimeout'), 'warn', 3000);
        if (typeof window.nextSong === 'function') window.nextSong();
      }
    } else {
      _loadWatchSince = 0;
    }
  }, 1000);
  // 页面卸载时停掉守卫定时器，避免遗留 interval
  window.addEventListener('beforeunload', () => {
    if (_loadWatchTimer) clearInterval(_loadWatchTimer);
  });
  _audio.addEventListener('playing', () => {
    _loadWatchSince = 0;
    _playFailGuard.succeed(); // 真响过一次：熔断计数归零，偶发失败别拖垮整轮
  });
  _audio.addEventListener('pause', () => { _loadWatchSince = 0; });
  _audio.addEventListener('pause', () => {
    const icon = document.getElementById('btnPlayIcon');
    if (icon) icon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'false');
    document.getElementById('btnPlay')?.classList.remove('buffering');
    document.getElementById('playerCard')?.classList.remove('playing');
    // 暂停姿态：明确表达"是暂停不是卡死"（封面降饱和 + ⏸ 角标）
    if (getState('currentPlaying')) document.getElementById('playerCard')?.classList.add('paused');
    // 状态文案统一按 audio 真实状态推导（不再用 currentPlaying 当判据，
    // 换歌时它可能仍指向旧歌 → 误显示「已暂停」）
    if (typeof refreshPlayerState === 'function') refreshPlayerState();
    if (typeof stopSpectrum === 'function') stopSpectrum();
    syncToMiniPlayer(_audio);
    syncToTray(_audio);
  });
  _audio.addEventListener('play', () => {
    const icon = document.getElementById('btnPlayIcon');
    if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';
    document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'true');
    document.getElementById('playerCard')?.classList.remove('paused');
    document.getElementById('playerCard')?.classList.add('playing');
    if (typeof refreshPlayerState === 'function') refreshPlayerState();
    if (typeof startSpectrum === 'function') startSpectrum();
    syncToMiniPlayer(_audio);
    syncToTray(_audio);
  });
  // 缓冲反馈：waiting/stalled → 播放按钮转圈呼吸；playing/canplay → 恢复
  // （此前缓冲与暂停视觉上无法区分，用户分不清"正在缓冲"还是"出错"）
  _audio.addEventListener('waiting', () => {
    if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
  });
  _audio.addEventListener('stalled', () => {
    if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
  });
  _audio.addEventListener('playing', () => {
    document.getElementById('btnPlay')?.classList.remove('buffering');
  });
  _audio.addEventListener('canplay', () => {
    document.getElementById('btnPlay')?.classList.remove('buffering');
  });
  _audio.addEventListener('loadedmetadata', () => {
    document.getElementById('timeTotal').textContent = fmtTime(_audio.duration);
  });
}
