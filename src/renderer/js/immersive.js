/**
 * 沉浸式播放页（S3）—— 全屏封面 + 动态歌词 + 取色背景。
 *
 * 设计规格来源：Void Glass 方案（点底栏封面进入，ESC/返回/点背景退出；
 * 当前歌词行放大高亮，相邻行淡出；背景取封面主色做氛围光）。
 *
 * 数据源纪律（重构审计 R1：双状态机漂移风险）：
 *   · 只读 player.js 一侧的 getState / window 桥 —— playback engine
 *     仍是阶段 3 影子态（无人订阅），这里绝不抢跑接它做状态源；
 *   · 控制按钮全部复用既有 window 函数（togglePlay/nextSong/prevSong/
 *     cyclePlayMode/toggleFavoriteCurrent/togglePlayQueue），零新控制流；
 *   · 跳播走 engine.seek（P4 纪律：seek 归引擎，它负责越界钳制与快照
 *     广播，与 player/lyrics.js 底栏歌词点击同一口径）；
 *   · 进度同步用「打开期 timeupdate 监听」（open 挂 / exit 摘），
 *     不挂钩 player-sync：那边 export 面与函数体被守卫钉着，
 *     且常驻重复监听正是 audio-events 注释点过的老毛病。
 *
 * 取色：封面 <img> 画进小 canvas 采样 5 点求主色（纯渲染层，零 IPC ——
 * 审计 R8：视图级改版不碰 IPC 契约）。CORS 污染时 getImageData 抛错，
 * catch 后退化为无着色兜底，效果仍成立。
 */

import { getState } from './state.js';
import { esc, fmtTime, srcLabel } from './utils.js';

let _root = null;
let _open = false;
let _songSig = '';        // 歌曲变化签名：换歌才重画信息区/封面/歌词
let _lyricSig = '';       // 歌词行渲染去抖签名（每 tick 跑，别重绘）
let _activeIdx = -1;

export function isImmersiveOpen() { return _open; }

// 同步监听器只在沉浸页打开期间存在（open 挂 / exit 摘）。
// 刻意不往 player-sync 的 syncToMiniPlayer 里挂钩：那里有守卫钉
// export 面与函数体结构；常驻期新开 timeupdate 才是「每帧跑两遍」
// 的老毛病，窗口期监听不在此列。
function _tick() { syncImmersive(getAudioEl()); }

export function openImmersive() {
  if (!_root) return;
  _open = true;
  _root.classList.remove('hidden');
  _lyricSig = '';
  _activeIdx = -1;
  const audio = getAudioEl();
  if (audio) audio.addEventListener('timeupdate', _tick);
  syncImmersive(audio);
}

export function exitImmersive() {
  if (!_root) return;
  _open = false;
  _root.classList.add('hidden');
  const audio = getAudioEl();
  if (audio) audio.removeEventListener('timeupdate', _tick);
}

function getAudioEl() {
  return document.getElementById('audioPlayer');
}

/**
 * 每 tick 的同步入口（由 player-sync.syncToMiniPlayer 调用）。
 * 关闭态直接返回 —— 一切成本只在沉浸页打开时产生。
 */
export function syncImmersive(audio) {
  if (!_open || !_root) return;
  const song = getState('currentPlaying');
  const $ = (id) => document.getElementById(id);

  // ── 信息区：只在歌曲变化时动 DOM（签名比对，tick 频率不重绘） ──
  const sig = song ? `${song.source || 'local'}:${song.id || ''}|${song.title || ''}` : '';
  if (sig !== _songSig) {
    _songSig = sig;
    $('immTitle').textContent = song ? (song.title || '未知歌曲') : '未在播放';
    $('immArtist').textContent = song ? (song.artist || '—') : '—';
    $('immSource').textContent = song && song.source ? srcLabel(song.source) : '';
    const img = $('immCover');
    const ph = $('immCoverPh');
    if (song && song.cover) {
      img.src = song.cover;
      img.style.display = '';
      ph.style.display = 'none';
      extractColor(img);
    } else {
      img.style.display = 'none';
      ph.style.display = '';
      applyColor('');
    }
    _lyricSig = ''; // 换歌强制重绘歌词
  }

  // ── 进度 ──
  if (audio) {
    const dur = audio.duration && isFinite(audio.duration)
      ? audio.duration
      : (song && song.durationMs ? song.durationMs / 1000 : 0);
    const cur = audio.currentTime || 0;
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    $('immFill').style.width = pct + '%';
    $('immThumb').style.left = pct + '%';
    $('immTimeNow').textContent = fmtTime(cur);
    $('immTimeTotal').textContent = fmtTime(dur);
    const playing = !audio.paused;
    $('immPlayIcon').innerHTML = playing
      ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }

  // ── 歌词：签名去抖 + 活动行增量切换 ──
  renderLyrics(audio ? (audio.currentTime || 0) : 0);
}

function renderLyrics(nowSec) {
  const box = document.getElementById('immLyrics');
  if (!box) return;
  const lines = getState('parsedLyrics') || [];
  const sig = lines.length + ':' + (lines[0] ? lines[0].t + (lines[0].text || '') : '');
  if (sig !== _lyricSig) {
    _lyricSig = sig;
    if (!lines.length) {
      box.innerHTML = '<div class="imm-lyric-empty">暂无歌词</div>';
      _activeIdx = -1;
      return;
    }
    box.innerHTML = lines.map((l, i) =>
      `<div class="imm-lyric-line" data-idx="${i}" data-t="${l.t}">${esc(l.text || '')}</div>`).join('');
  }
  // 活动行：线性找（歌词 ≤ 几百行，tick 级可接受；已按时间排序）
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= nowSec) idx = i; else break;
  }
  if (idx !== _activeIdx) {
    const old = box.querySelector('.imm-lyric-line.active');
    if (old) old.classList.remove('active');
    const el = box.querySelector(`.imm-lyric-line[data-idx="${idx}"]`);
    if (el) {
      el.classList.add('active');
      // 居中滚动（手算式，与底栏歌词区同思路：offsetTop 相对本容器）
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
    }
    _activeIdx = idx;
  }
}

/** 点歌词行跳播 —— 走 engine.seek（P4 纪律，与底栏歌词同一出口） */
export function immSeekLine(el) {
  const t = Number(el && el.dataset && el.dataset.t);
  if (!Number.isFinite(t)) return;
  const engine = typeof window !== 'undefined' ? window.__playbackEngine : null;
  if (!engine) return;
  const snap = engine.getSnapshot();
  if (!snap || !(snap.duration > 0)) return;
  engine.seek(Math.min(t, Math.max(0, snap.duration - 0.5)));
}

// ── 封面取色（渲染层 canvas 采样，CORS 失败退无着色兜底） ──

function extractColor(img) {
  // 封面 onload 后再采样；直接同步画可能撞上还没解码完的图
  const grab = () => {
    try {
      const c = document.createElement('canvas');
      const S = 16;
      c.width = S; c.height = S;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, S, S);
      // 四角 + 中心 5 点（设计师规格）
      const pts = [[1, 1], [S - 2, 1], [1, S - 2], [S - 2, S - 2], [S >> 1, S >> 1]];
      let r = 0, g = 0, b = 0;
      for (const [x, y] of pts) {
        const p = ctx.getImageData(x, y, 1, 1).data;
        r += p[0]; g += p[1]; b += p[2];
      }
      const n = pts.length;
      applyColor(`rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`);
    } catch {
      applyColor(''); // 跨域污染或解码失败：无着色兜底
    }
  };
  if (img.complete && img.naturalWidth) grab();
  else img.addEventListener('load', grab, { once: true });
}

function applyColor(color) {
  if (!_root) return;
  if (color) {
    _root.style.setProperty('--cover-color', color);
    _root.dataset.tinted = '1';
  } else {
    _root.style.removeProperty('--cover-color');
    delete _root.dataset.tinted;
  }
}

// ── 接线：ESC 关闭 + 背景点击 + 歌词行点击委托 + 底栏封面入口 ──

export function wireImmersive() {
  _root = document.getElementById('immersiveRoot');
  if (!_root) return;
  // Esc 关闭不在此自挂监听：modal 注册表（shortcuts.js handleKey）按
  // data-modal-close="exitImmersive" 契约统一派发，自挂就是第二份真相源。
  // 点背景（非交互区）退出：命中根/背景层/主体留白才关
  _root.addEventListener('click', (e) => {
    if (e.target === _root
      || e.target.classList.contains('imm-bg')
      || e.target.classList.contains('imm-scrim')
      || e.target.classList.contains('imm-body')) {
      exitImmersive();
    }
  });
  // 歌词行点击跳播（委托，行是动态 innerHTML）
  const box = document.getElementById('immLyrics');
  if (box) box.addEventListener('click', (e) => {
    const line = e.target.closest('.imm-lyric-line');
    if (line) immSeekLine(line);
  });
  // 进度条点击 seek（与底栏轨道同口径：走 engine，钳制越界）
  const track = document.getElementById('immTrack');
  if (track) track.addEventListener('click', (e) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const engine = typeof window !== 'undefined' ? window.__playbackEngine : null;
    if (!engine) return;
    const snap = engine.getSnapshot();
    if (!snap || !(snap.duration > 0)) return;
    engine.seek(Math.min(ratio * snap.duration, Math.max(0, snap.duration - 0.5)));
  });
  // 底栏封面 = 沉浸页入口（zoom-in 光标提示在 CSS）
  const coverEl = document.querySelector('.pc-cover');
  if (coverEl) {
    coverEl.style.cursor = 'zoom-in';
    coverEl.addEventListener('click', () => {
      if (_open) exitImmersive(); else openImmersive();
    });
  }
}

// window 桥：HTML onclick（exitImmersive）与 player-sync 调用两条路都要够得到
window.exitImmersive = exitImmersive;
window.openImmersive = openImmersive;
window.syncImmersive = syncImmersive;
window.wireImmersive = wireImmersive;
