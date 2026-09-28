/**
 * MusicDL 播放器 — 歌词系统（LRC 解析 / 逐字高亮 / 显隐偏好）
 *
 * 自 player.js 拆出：只操作 #lyricsArea DOM 与 state.parsedLyrics。
 * 依赖全局：api、getState、setState、esc
 */

import { showContextMenu } from '../contextMenu.js';
import { copyText } from '../songShare.js';
import { lrcToPlain } from '../lyricEdit.js';
import { createFollowState, shouldAutoFollow, scrollPause, hoverSet, followReset, FOLLOW_SCROLL_RESUME_MS } from '../lyricFollow.js';

// ── 歌词设置（同步缓存，避免 timeupdate 热路径异步） ────
let _lyricFontSize = 18;
let _lyricOffset = 0;

function _loadLyricSettings() {
  api.getPref('lyricFontSize').then(v => { _lyricFontSize = v != null ? +v : 18; });
  api.getPref('lyricOffset').then(v => { _lyricOffset = v != null ? +v : 0; });
}
// 页面加载时读取一次
setTimeout(_loadLyricSettings, 0);

export function applyLyricFontSize(size) {
  _lyricFontSize = +size || 18;
  const lyricsArea = document.getElementById('lyricsArea');
  if (lyricsArea) lyricsArea.style.fontSize = _lyricFontSize + 'px';
}

export function applyLyricOffset(ms) {
  _lyricOffset = +ms || 0;
}

export function getLyricOffset() {
  return _lyricOffset;
}

// ── 歌词系统（逐字高亮）──────────────────────────────
export function parseLrc(lrc) {
  if (!lrc) { showNoLyrics(); return; }
  const parsedLyrics = [];
  let hasLangTags = false;

  // 第一遍：解析所有行，检测 [lang:xx] 标签
  const rawEntries = [];
  lrc.split('\n').forEach(line => {
    const langTagMatch = line.match(/^\[lang:(\w+)\]/);
    if (langTagMatch) {
      hasLangTags = true;
      // 提取 [lang:xx] 后面的时间戳和文本
      const rest = line.slice(langTagMatch[0].length);
      const m = rest.match(/\[(\d+):(\d+\.?\d*)\](.*)/);
      if (m) {
        rawEntries.push({
          lang: langTagMatch[1],
          t: parseInt(m[1]) * 60 + parseFloat(m[2]),
          text: m[3].trim()
        });
      }
    } else {
      const m = line.match(/\[(\d+):(\d+\.?\d*)\](.*)/);
      if (m) {
        rawEntries.push({
          lang: null,
          t: parseInt(m[1]) * 60 + parseFloat(m[2]),
          text: m[3].trim()
        });
      }
    }
  });

  if (hasLangTags) {
    // 双语模式：按时间戳分组，合并主语言和副语言
    const byTime = new Map(); // key = time, value = {main: text, sub: text}
    rawEntries.forEach(e => {
      const key = e.t.toFixed(3);
      if (!byTime.has(key)) {
        byTime.set(key, { t: e.t, text: '', subText: '' });
      }
      const entry = byTime.get(key);
      // 第一个出现的语言为主语言，第二个为副语言
      if (!entry.text) {
        entry.text = e.text;
      } else if (!entry.subText) {
        entry.subText = e.text;
      }
    });
    // 转为数组并排序
    for (const entry of byTime.values()) {
      parsedLyrics.push(entry);
    }
  } else {
    // 单语模式：保持原有行为
    rawEntries.forEach(e => {
      parsedLyrics.push({ t: e.t, text: e.text, subText: '' });
    });
  }

  parsedLyrics.sort((a, b) => a.t - b.t);

  const lyricsArea = document.getElementById('lyricsArea');
  if (!parsedLyrics.length) { showStaticLyrics(lrc); return; }

  // 为每行计算逐字时间戳（仅基于主语言文本）
  for (let i = 0; i < parsedLyrics.length; i++) {
    const cur = parsedLyrics[i];
    const next = parsedLyrics[i + 1];
    const lineDuration = next ? (next.t - cur.t) : 3; // 默认 3 秒
    // 按字符拆分（CJK 每字一个 span，英文按空格分词）
    cur.words = splitToWords(cur.text);
    const wordDuration = lineDuration / Math.max(cur.words.length, 1);
    cur.wordTimes = cur.words.map((_, j) => cur.t + j * wordDuration);
  }

  const hasBilingual = parsedLyrics.some(l => l.subText);

  if (lyricsArea) {
    // 手动隐藏时内容照常解析（恢复时立即可用），只是不显示
    lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : 'block';
    lyricsArea.classList.remove('static-mode');
    lyricsArea.innerHTML = parsedLyrics.map((l, i) => {
    const wordSpans = l.words.map((w, j) =>
      `<span class="lyric-word" data-t="${l.wordTimes[j].toFixed(2)}">${esc(w)}</span>`
    ).join('');
    const subHtml = l.subText
      ? `<div class="lyric-sub-text">${esc(l.subText)}</div>`
      : '';
    return `<div class="lyric-line${hasBilingual ? ' bilingual' : ''}" id="lyric-${i}" data-t-line="${l.t.toFixed(3)}">${wordSpans || '&nbsp;'}${subHtml}</div>`;
  }).join('');
  // 应用歌词字体大小
  if (lyricsArea) lyricsArea.style.fontSize = _lyricFontSize + 'px';
  }
  setState('parsedLyrics', parsedLyrics);
  // 重置歌词 DOM 缓存
  _cachedLyricEls = null;
  _cachedLyricCount = 0;
  _prevLyricIdx = -1;
}

/** 将歌词文本拆分为单词/字符数组（CJK 逐字，英文按空格） */
function splitToWords(text) {
  if (!text) return [];
  const words = [];
  let buf = '';
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff' || ch >= '\u3400' && ch <= '\u4dbf') {
      // CJK 字符：每个字单独
      if (buf) { words.push(buf); buf = ''; }
      words.push(ch);
    } else if (ch === ' ') {
      if (buf) { words.push(buf); buf = ''; }
      words.push(' ');
    } else {
      buf += ch;
    }
  }
  if (buf) words.push(buf);
  return words;
}

export function showStaticLyrics(text) {
  const lyricsArea = document.getElementById('lyricsArea');
  if (!text || !text.trim()) { showNoLyrics(); return; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lyricsArea) { showNoLyrics(); return; }
  lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : 'block';
  lyricsArea.classList.add('static-mode');
  lyricsArea.innerHTML = lines.map(l => `<div class="lyric-line static">${esc(l)}</div>`).join('');
  lyricsArea.style.fontSize = _lyricFontSize + 'px';
  lyricsArea.scrollTop = 0;
  setState('parsedLyrics', []);
}

export function showNoLyrics() {
  const lyricsArea = document.getElementById('lyricsArea');
  if (!lyricsArea) return;
  // 用户手动隐藏歌词时保持隐藏（只切按钮态，不弹"暂无歌词"占位）
  if (_lyricsHiddenByUser) { lyricsArea.style.display = 'none'; return; }
  lyricsArea.style.display = 'flex';
  lyricsArea.classList.add('static-mode');
  lyricsArea.innerHTML = '<div class="lyric-line static" style="text-align:center;opacity:0.45">暂无歌词</div>';
  setState('parsedLyrics', []);
}

// ── 歌词区手动开关（用户控制"全有或全无"的弹出） ──────────
// 默认跟随后端自动行为（有词显示/无词占位/切歌清空）；
// 用户点按钮后进入手动模式：隐藏时任何歌词加载都不再弹出，
// 再点恢复自动。偏好持久化到 prefs.lyricsVisible。
let _lyricsHiddenByUser = false;
export function toggleLyricsArea() {
  _lyricsHiddenByUser = !_lyricsHiddenByUser;
  const lyricsArea = document.getElementById('lyricsArea');
  const btn = document.getElementById('btnLyricsToggle');
  if (lyricsArea) {
    lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : '';
    // 恢复时若当前无词，重新展示占位（保持"暂无歌词"的语义可见）
    if (!_lyricsHiddenByUser && !(getState('parsedLyrics') || []).length) showNoLyrics();
  }
  if (btn) {
    btn.classList.toggle('active', !_lyricsHiddenByUser);
    btn.setAttribute('aria-pressed', String(!_lyricsHiddenByUser));
  }
  try { if (typeof api !== 'undefined' && api.setPref) api.setPref('lyricsVisible', !_lyricsHiddenByUser); } catch (_e) { /* 持久化失败不影响本次切换 */ }
}

// 启动时恢复用户歌词显隐偏好（默认显示），并同步按钮初始态
(function restoreLyricsPref() {
  const restore = () => {
    const btn = document.getElementById('btnLyricsToggle');
    try {
      if (typeof window.api !== 'undefined' && window.api.getPref) {
        window.api.getPref('lyricsVisible').then(v => {
          if (v === false) {
            _lyricsHiddenByUser = false; toggleLyricsArea(); // 切一次 → 隐藏
          } else {
            // 默认/记忆为显示：按钮态设为"开"（歌词区本身由加载流程控制显隐）
            if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
          }
        }).catch(() => { if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); } });
      } else if (btn) {
        btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
      }
    } catch (_e) { /* ignore */ }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  } else {
    setTimeout(restore, 0);
  }
})();

// 缓存歌词 DOM 元素，避免每次 timeupdate 重复查询
let _cachedLyricEls = null;
let _cachedLyricCount = 0;
let _prevLyricIdx = -1;
// 滚动跟随暂停态（悬停/滚轮暂停，到期或跳播恢复）
let _follow = createFollowState();

export function updateLyric(t) {
  const parsedLyrics = getState('parsedLyrics');
  if (!parsedLyrics || !parsedLyrics.length) return;
  // 应用歌词时间偏移（offset 单位 ms，t 单位 s）
  const adjustedT = t + _lyricOffset / 1000;
  let idx = parsedLyrics.findIndex(l => l.t > adjustedT) - 1;
  if (idx < 0) idx = 0;

  // 只在歌词行变化时更新 DOM
  if (idx === _prevLyricIdx) return;
  const prevIdx = _prevLyricIdx;
  _prevLyricIdx = idx;

  // 首次或歌词变化时缓存 DOM
  if (!_cachedLyricEls || _cachedLyricCount !== parsedLyrics.length) {
    _cachedLyricEls = document.querySelectorAll('.lyric-line');
    _cachedLyricCount = parsedLyrics.length;
  }
  const els = _cachedLyricEls;

  // 防御性检查：确保 DOM 元素存在
  if (!els || els.length === 0) return;

  // 只更新上一行和当前行，跳过不变的行
  if (prevIdx >= 0 && prevIdx < els.length && els[prevIdx]) {
    els[prevIdx].classList.remove('active');
    els[prevIdx].querySelectorAll('.lyric-word').forEach(w => w.classList.remove('word-active'));
  }
  if (idx >= 0 && idx < els.length && els[idx]) {
    const el = els[idx];
    el.classList.add('active');
    // 居中滚动：本 Chromium 下 CSS scroll-behavior:smooth 会让 scrollIntoView 立即滚
    // 却又静默丢帧（表现为 scrollTop 恒 0、当前行永远停在列表底部之外），故手动计算居中位置
    const la = document.getElementById('lyricsArea');
    if (la && shouldAutoFollow(_follow, Date.now())) {
      const target = el.offsetTop - (la.clientHeight - el.offsetHeight) / 2;
      la.scrollTop = Math.max(0, Math.min(target, la.scrollHeight - la.clientHeight));
    }
    // 逐字高亮
    const words = el.querySelectorAll('.lyric-word');
    words.forEach(w => {
      const wt = parseFloat(w.dataset.t);
      const nextLine = parsedLyrics[idx + 1];
      const lineEnd = nextLine ? nextLine.t : parsedLyrics[idx].t + 3;
      w.classList.toggle('word-active', adjustedT >= wt && adjustedT < lineEnd);
    });
  }
}

// ── 歌词区交互：点行跳播 + 右键复制/编辑 ──────────
function _lyricRowUnder(e) {
  const la = document.getElementById('lyricsArea');
  const row = e.target && e.target.closest ? e.target.closest('.lyric-line') : null;
  return la && row && la.contains(row) ? row : null;
}

document.addEventListener('click', (e) => {
  const row = _lyricRowUnder(e);
  if (!row) return;
  const t = parseFloat(row.getAttribute('data-t-line'));
  if (!Number.isFinite(t)) return; // 静态歌词无时间戳，不接管
  const audio = document.getElementById('audioPlayer');
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  // 行时间按带偏移的口径换算回播放时间：显示匹配用 playT+offset≥T
  const target = Math.max(0, t - _lyricOffset / 1000);
  audio.currentTime = Math.min(target, Math.max(0, audio.duration - 0.5));
  // 跳播=「回到当前」语义，立即恢复跟随并强制下次 update 重新居中
  _follow = followReset();
  _prevLyricIdx = -1;
});

document.addEventListener('contextmenu', (e) => {
  const row = _lyricRowUnder(e);
  if (!row) return;
  const raw = String(getState('_currentLyricRaw') || '');
  const items = [];
  if (raw.trim()) {
    const plain = lrcToPlain(raw);
    if (plain) items.push({ icon: '💬', label: '复制歌词纯文本', onClick: () => copyText(plain).then(ok => showToast(ok ? '歌词已复制' : '复制失败', ok ? 'success' : 'error')) });
    if (raw.includes('[')) items.push({ icon: '⏱', label: '复制带时间戳歌词', onClick: () => copyText(raw).then(ok => showToast(ok ? '带时间戳歌词已复制' : '复制失败', ok ? 'success' : 'error')) });
  }
  if (typeof window.openLyricEditor === 'function') {
    if (items.length) items.push({ sep: true });
    items.push({ icon: '✏️', label: '编辑歌词', onClick: () => window.openLyricEditor() });
  }
  if (!items.length) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, items);
});

// ── 滚动跟随暂停：悬停即停，滚轮给阅读宽限期 ──────
document.addEventListener('wheel', (e) => {
  const la = document.getElementById('lyricsArea');
  if (la && e.target && la.contains(e.target)) {
    _follow = scrollPause(_follow, Date.now(), FOLLOW_SCROLL_RESUME_MS);
  }
}, { passive: true });
document.addEventListener('mouseover', (e) => {
  const la = document.getElementById('lyricsArea');
  if (la && e.target && la.contains(e.target)) _follow = hoverSet(_follow, true);
});
document.addEventListener('mouseout', (e) => {
  const la = document.getElementById('lyricsArea');
  if (!la || !e.target || !la.contains(e.target)) return;
  if (!(e.relatedTarget && la.contains(e.relatedTarget))) _follow = hoverSet(_follow, false);
});
