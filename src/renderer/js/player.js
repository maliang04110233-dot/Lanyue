/**
* MusicDL 播放器 — 霓虹科技风格
* 方形封面 + 封面下缘进度条（环形进度已随 UI 重设计移除）
* 
* ES Module — export 供其他模块 import，同时保留 window 全局供 HTML onclick
 */

import { logger } from './logger.js';
import { resolveQuality, playedQualityLabel } from './quality.js';
import { createPrefetchStore, prefetchKeyOf, nextPrefetchIdx, shouldPrefetchNow, prefetchRetryAllowed } from './playPrefetch.js';
import { buildFallbackNotice } from './fallbackNotice.js';
import {
  addToRecentlyPlayed, updatePlayStatsOnStart, updatePlayStatsOnStop, recordPlay,
  restartPlayTimer, getRecentlyPlayed, loadRecentlyPlayed, clearRecentlyPlayed,
  getPlayStats, getMostPlayed, loadPlayStats, resetPlayStats, generatePlayReport,
  copyPlayReportText,
} from './player/stats.js';
import {
  parseLrc, showStaticLyrics, showNoLyrics, updateLyric, toggleLyricsArea,
  applyLyricFontSize, applyLyricOffset, getLyricOffset,
} from './player/lyrics.js';
import { getLyricOverride } from './lyricEditor.js';
import { createResumeSeeker } from './player/resumeSeek.js';

const audio = document.getElementById('audioPlayer');

// ── 状态 ─────────────────────────────────────────────
let audioCtx = null;


// ── EQ 均衡器（已拆出 player/eq.js） ─────────────────
// 本文件只做 re-export，保持 player.js 的公开面（含 window 挂载）逐字不变；
// 实现、已知状态说明与守卫测试见 player/eq.js 头部注释。
import {
  applyEqPreset, toggleEqBypass, setEqBand, resetEq,
  saveEqSettings, restoreEqPresetSetting, cycleEqPreset,
} from './player/eq.js';

export {
  applyEqPreset, toggleEqBypass, setEqBand, resetEq,
  saveEqSettings, restoreEqPresetSetting, cycleEqPreset,
};

// ── 更新播放器卡片信息（不播放） ─────────────────────
// 标题超宽时加 marquee 类（CSS 匀速滚动），并把实测溢出量写进 CSS 变量
function _applyTitleMarquee() {
  const titleEl = document.getElementById('playerTitle');
  if (!titleEl) return;
  const lineEl = titleEl.parentElement;
  titleEl.classList.remove('marquee');
  // 类移除后测 scrollWidth（动画会干扰测量）
  const overflow = titleEl.scrollWidth - lineEl.clientWidth;
  if (overflow > 2) {
    titleEl.style.setProperty('--marquee-shift', `-${overflow + 16}px`);
    titleEl.classList.add('marquee');
  }
}

/** 顶栏状态文本（未在播放 / 正在播放 / 已暂停）。
    纯展示用途：配色由 .player-card 的 playing/paused 类决定，此处只管文案。
    挂到 window 供 app.js 的 play/pause 事件复用，避免两处各写一份 DOM 操作。 */
/* ── 顶栏「更多」弹层 ────────────────────────────────
   低频操作（封面动画 / 迷你播放器 / 桌面歌词 / 队列 / 倍速）收纳于此，
   原先 7 个工具键挤在 184×29px 的一行里，单键命中区仅 26px。 */
export function togglePlayerMore() {
  const pop = document.getElementById('pcMorePop');
  const btn = document.getElementById('btnMoreToggle');
  if (!pop) return;
  const open = pop.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

export function closePlayerMore() {
  const pop = document.getElementById('pcMorePop');
  const btn = document.getElementById('btnMoreToggle');
  if (!pop || !pop.classList.contains('open')) return;
  pop.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/* 点击弹层外 / 按 Esc 收起。capture 阶段监听：不受内部元素 stopPropagation 影响 */
document.addEventListener('pointerdown', (e) => {
  const pop = document.getElementById('pcMorePop');
  if (!pop || !pop.classList.contains('open')) return;
  if (pop.contains(e.target)) return;
  if (document.getElementById('btnMoreToggle')?.contains(e.target)) return;
  closePlayerMore();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePlayerMore();
});

export function setPlayerState(label) {
  const el = document.getElementById('pcState');
  if (el) el.textContent = label;
}

/**
 * 依据「当前是否真的在播放」推导顶栏状态文案，并写入。
 *
 * ⚠️ 为什么需要它（2026-09-18 修复）：
 *   pause 事件**每次换歌都会触发** —— loadAndPlay 给 audio.src 赋新值时，
 *   浏览器会先 pause 旧音源。此刻 getState('currentPlaying') 可能仍指向上一首
 *   （playSongByIdx 是 setState('currentPlaying') 之后才 loadAndPlay，
 *   而 loadAndPlay 内部还有 await），于是顶栏被写成「已暂停」，
 *   紧接着 play 事件再纠正为「正在播放」——肉眼看是闪一下，无头/慢盘下会停错。
 *   更糟的是 app.js 的 pause 分支判定与 play 分支不对称：pause 看 currentPlaying，
 *   play 却无条件写「正在播放」，两侧不同源。
 *
 * 统一为：只看 audio 的真实状态，不看 currentPlaying。无音源时才是「未在播放」。
 */
export function refreshPlayerState() {
  if (!audio || !audio.src) { setPlayerState('未在播放'); return; }
  setPlayerState(audio.paused ? '已暂停' : '正在播放');
}

export function updatePlayerCard(song) {
  if (!song) {
    setPlayerState('未在播放');
    document.getElementById('playerTitle').textContent = '未在播放';
    document.getElementById('playerArtist').textContent = '—';
    document.getElementById('playerDiscImg').style.display = 'none';
    document.getElementById('playerDiscPh').style.display = 'flex';
    _updateQualityBadge(null);
    _applyTitleMarquee();
    return;
  }
  // 只声明「这首是谁」，不声明「在不在播」——后者由 refreshPlayerState() 按
  // audio 真实状态决定。原先此处无条件写「正在播放」，与函数自身注释
  // 「不修改播放状态」矛盾，也会在恢复播放队列（未自动播放）时显示错文案。
  document.getElementById('playerTitle').textContent = song.title || '未知歌曲';
  document.getElementById('playerArtist').textContent = song.artist || '未知艺术家';
  _updateQualityBadge(song);
  _applyTitleMarquee();
  const discPh = document.getElementById('playerDiscPh');
  const discImg = document.getElementById('playerDiscImg');
  if (song.cover && song.cover !== discImg.src) {
    discImg.src = song.cover;
    discImg.style.display = 'block';
    discPh.style.display = 'none';
  } else if (!song.cover) {
    discImg.style.display = 'none';
    discPh.style.display = 'flex';
  }
  // 不修改进度条、频谱等播放状态
}

/** 播放音质徽标：显示本次实际取流档位（song._playedQuality，由取流成功处回写） */
function _updateQualityBadge(song) {
  const badge = document.getElementById('playerQualityBadge');
  if (!badge) return;
  const label = playedQualityLabel(song && song._playedQuality);
  if (label) {
    badge.textContent = label;
    badge.title = '本次播放音质';
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}


// ── 播放进度记忆 ─────────────────────────────────────
const _playProgressKey = (song) => song.filePath || `${song.source}:${song.id}`;

async function savePlayProgress(song, time) {
  try {
    const enabled = await api.getPref('playProgressMemory');
    if (enabled === false) return;
    const key = _playProgressKey(song);
    const progressMap = await api.getPref('playProgressMap') || {};
    progressMap[key] = { time, savedAt: Date.now() };
    // 只保留最近 200 首的进度
    const entries = Object.entries(progressMap);
    if (entries.length > 200) {
      entries.sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
      const trimmed = Object.fromEntries(entries.slice(-200));
      await api.setPref('playProgressMap', trimmed);
    } else {
      await api.setPref('playProgressMap', progressMap);
    }
  } catch (_e) { /* ignore */ }
}

async function restorePlayProgress(song) {
  try {
    const enabled = await api.getPref('playProgressMemory');
    if (enabled === false) return 0;
    const key = _playProgressKey(song);
    const progressMap = await api.getPref('playProgressMap') || {};
    const entry = progressMap[key];
    if (entry && entry.time > 3) return entry.time; // 忽略前 3 秒
    return 0;
  } catch (_e) { return 0; }
}

// ── 歌词请求序号（M8）：快速切歌时旧歌词请求不得覆盖新歌 ──
let _lyricRequestId = 0;

// ── 恢复进度 seek（根因 2，逻辑在 player/resumeSeek.js）──
// 两个方向都得治，所以监听要挂两处：
//   1. 跨歌泄漏（M7）：歌 A 的监听在 B 加载时触发，把 B seek 到 A 的进度。
//   2. loadedmetadata 先到（根因 2）：`audio.src = url` 之后要 await 两次
//      getPref 才能拿到进度，这期间媒体就绪、事件已发完，事后挂的监听
//      永远收不到 —— 表现是从 0 开始播，无报错。
// 抽成模块是因为这段逻辑无状态、无 DOM 依赖，能对着假 audio 元素真跑竞态；
// player.js 顶层依赖 audioPlayer 元素和十余个 import，测试里拉不起来。
const _resumeSeeker = createResumeSeeker({
  onSeek: (_audio, t) => {
    showToast(`📍 从 ${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')} 继续播放`, 'info', 2000);
  },
});

export async function loadAndPlay(song, prefetchedUrl, isNetworkSong = false) {
  if (!song) return;

  // 记录到最近播放
  addToRecentlyPlayed(song);
  updatePlayStatsOnStart();
  recordPlay(song);

  const localUrl = prefetchedUrl || (song.filePath ? 'file://' + song.filePath : null);

  // ── 本地歌曲分支（仅当明确是本地歌曲或没有预获取URL时）─────────
  if (!isNetworkSong && localUrl && localUrl.startsWith('file://')) {
    // 封面：优先用缓存，缺失时搜在线封面
    if (!song.cover) {
      try {
        const online = await api.fetchOnlineCover(song.title || '', song.artist || '');
        if (online && online.coverBase64) {
          const ok = await api.updateId3Cover(song.filePath, online.coverBase64);
          if (ok && ok.success) {
            song.cover = online.coverBase64;
            const localSongs = getState('localSongs');
            const i2 = localSongs.findIndex(x => x.filePath === song.filePath);
            if (i2 >= 0) localSongs[i2].cover = online.coverBase64;
          }
        }
      } catch (_e) { /* ignore */ }
    }

    const discPh = document.getElementById('playerDiscPh');
    const discImg = document.getElementById('playerDiscImg');
    if (discImg && discPh) {
      if (song.cover) {
        discImg.src = song.cover;
        discImg.style.display = 'block';
        discPh.style.display = 'none';
      } else {
        discImg.style.display = 'none';
        discPh.style.display = 'flex';
      }
    }
    const titleEl = document.getElementById('playerTitle');
    const artistEl = document.getElementById('playerArtist');
    if (titleEl) titleEl.textContent = song.title || '未知歌曲';
    if (artistEl) artistEl.textContent = song.artist || '未知艺术家';
    _applyTitleMarquee();

    audio.src = localUrl;
    // 恢复播放进度
    const savedTime = await restorePlayProgress(song);
    if (savedTime > 0) {
      _resumeSeeker.attach(audio, savedTime);
    }
    audio.play().catch(() => {
      showToast('⚠️ 自动播放被拦截，请点击播放按钮', 'warn', 3000);
    });

    // 加载歌词
    const lyricsArea = document.getElementById('lyricsArea');
    if (lyricsArea) {
      setState('parsedLyrics', []);
      lyricsArea.style.display = 'none';
      lyricsArea.classList.remove('static-mode');
    }
    // M8：歌词请求序号守卫——读 LRC 期间切歌，过期结果不得覆盖新歌歌词
    const reqId = ++_lyricRequestId;
    try {
      const r = await api.readLocalLrc(song.filePath);
      if (reqId !== _lyricRequestId) return;
      if (r && r.lrc && r.lrc.trim()) {
        window.parseLrc(r.lrc);
        setState('_currentLyricRaw', r.lrc);
        if (r.source === 'embedded') {
          showToast('使用嵌入歌词', 'info', 1500);
        }
      } else {
        setState('_currentLyricRaw', '');
        showNoLyrics();
      }
    } catch (_e) {
      setState('_currentLyricRaw', '');
      showNoLyrics();
    }
    return;
  }

  // ── 网络歌曲分支 ─────────────────────────────────────
  setState('_currentLocalFilePath', null);
  const titleEl = document.getElementById('playerTitle');
  const artistEl = document.getElementById('playerArtist');
  if (titleEl) titleEl.textContent = song.title || '未知歌曲';
  if (artistEl) artistEl.textContent = song.artist || '未知艺术家';
  _applyTitleMarquee();

  const discPh2 = document.getElementById('playerDiscPh');
  const discImg2 = document.getElementById('playerDiscImg');
  if (discImg2 && discPh2) {
    if (song.cover) {
      discImg2.src = song.cover;
      discImg2.style.display = 'block';
      discPh2.style.display = 'none';
    } else {
      discImg2.style.display = 'none';
      discPh2.style.display = 'flex';
    }
  }

  // 如果有预获取的 URL（来自 proxyPlay），则播放音频
  if (localUrl) {
    audio.src = localUrl;
    // 恢复播放进度
    const savedTime2 = await restorePlayProgress(song);
    if (savedTime2 > 0) {
      _resumeSeeker.attach(audio, savedTime2);
    }
    audio.play().catch(() => {
      showToast('⚠️ 自动播放被拦截，请点击播放按钮', 'warn', 3000);
    });
  }

  // 尝试获取歌词（本机覆写优先于平台歌词）
  const reqId = ++_lyricRequestId;
  try {
    const ov = await getLyricOverride(song);
    const r = ov ? { lrc: ov } : await api.getLyrics(song.id, song.source, song.title, song.artist);
    if (reqId !== _lyricRequestId) return; // 已切歌，丢弃过期歌词
    if (r && r.lrc) {
      parseLrc(r.lrc);
      setState('_currentLyricRaw', r.lrc);
    } else {
      setState('_currentLyricRaw', '');
    }
  } catch (_e) { /* ignore */ }
}

// ── 切歌 ─────────────────────────────────────────────
/**
 * 播放队列第 idx 行（队列面板点击）。队列行对象不带 url（url 只在取流后
 * 存在），必须走 playSongByIdx 的取流链路；此前 app.js 里
 * `if (queue[idx].url)` 恒假，点击队列行只挪高亮不发声。
 */
export async function playQueueIdx(idx) {
  const playQueue = getState('playQueue');
  if (!playQueue || idx < 0 || idx >= playQueue.length) return;
  setState('playIdx', idx);
  await playSongByIdx(idx, playQueue[idx]);
}

export async function nextSong() {
  const playQueue = getState('playQueue');
  if (!playQueue || !playQueue.length) return;
  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');
  let playIdx = getState('playIdx');

  if (isShuffled) {
    playIdx = Math.floor(Math.random() * playQueue.length);
  } else if (loopMode === 1) {
    playIdx = (playIdx + 1) % playQueue.length;
  } else {
    // 不循环模式：到末尾则停止
    if (playIdx >= playQueue.length - 1) {
      updatePlayStatsOnStop();
      audio.pause();
      audio.currentTime = 0;
      return;
    }
    playIdx = playIdx + 1;
  }

  const song = playQueue[playIdx];
  setState('playIdx', playIdx);
  await playSongByIdx(playIdx, song);
}

export async function prevSong() {
  const playQueue = getState('playQueue');
  if (!playQueue || !playQueue.length) return;
  const isShuffled = getState('isShuffled');
  let playIdx = getState('playIdx');

  if (isShuffled) {
    playIdx = Math.floor(Math.random() * playQueue.length);
  } else {
    playIdx = Math.max(0, playIdx - 1);
  }

  const song = playQueue[playIdx];
  setState('playIdx', playIdx);
  await playSongByIdx(playIdx, song);
}

// 通用播放函数：根据索引播放队列中的歌曲
// 取流用智能接口（本源失败自动换源）；快速切歌用请求序号做竞态守卫，
// 旧请求返回时歌已切走则丢弃（借鉴 lx-music-desktop gettingUrlId 模式）
let _playRequestId = 0;

async function playSongByIdx(idx, song) {
  if (!song) return;
  // 拖放即播行：blob URL 是 drop 现场造的，不走取流链路；
  // 跨会话残留（理论上已被 sanitizeSavedQueue 滤掉）只提示不发起请求
  if (song.source === 'drop') {
    if (song._blobUrl) {
      setState('currentPlaying', song);
      await loadAndPlay(song, song._blobUrl, true);
      return;
    }
    showToast('⚠️ 拖放歌曲已失效，请重新拖入文件', 'warn', 2600);
    return;
  }
  const pkey = prefetchKeyOf(song);
  const hit = pkey ? _prefetch.take(pkey) : null;
  // 预热时的音质与当前设置不一致（用户在剩余 20s 窗口里改过音质）则弃用缓存，走原路重取
  if (hit && hit.quality !== resolveQuality(song.source)) {
    logger.error('预取音质与当前设置不符，弃用缓存:', hit.quality);
  } else if (hit) {
    ++_playRequestId; // 命中预取：作废仍在飞的旧取流
    song._playedQuality = hit.quality;
    if (hit.altSource) song._altSource = hit.altSource;
    setState('currentPlaying', song);
    await loadAndPlay(song, hit.fileUrl, true);
    return;
  }
  const quality = resolveQuality(song.source);
  const reqId = ++_playRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== _playRequestId) return; // 已切到别的歌，丢弃过期结果
    if (!result || !result.url) {
      showToast('⚠️ 暂无法获取音源', 'warn', 3000);
      return;
    }
    song._playedQuality = quality;
    const notice = buildFallbackNotice(result, song.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
      updatePlayerCard(song); // 音质等徽标随实际取流结果刷新
    }
    const referer = playReferer(result.source || song.source, result);
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _playRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 3000);
      return;
    }
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
  } catch (e) {
    if (reqId === _playRequestId) logger.error('切歌失败:', e);
  }
}

// ── 下一首预取──────────────────────────────
// 切歌空白来自「取流 + 代理」两次串行网络往返。当前歌只剩 20s 时在后台把下一首的直链取好，
// 下一首播时直接开播（判定口径全在 playPrefetch.js，此处只做网络调用与缓存）。
const _prefetch = createPrefetchStore();
let _prefetchBusy = null;
let _prefetchFail = null;

function _startPrefetch() {
  const playQueue = getState('playQueue');
  if (!Array.isArray(playQueue) || !playQueue.length) return;
  const idx = nextPrefetchIdx(playQueue.length, getState('playIdx'), {
    isShuffled: getState('isShuffled'),
    loopMode: getState('loopMode'),
  });
  if (idx === null) return;
  const song = playQueue[idx];
  const key = prefetchKeyOf(song);
  if (!key || _prefetch.has(key) || _prefetchBusy === key) return;
  if (!prefetchRetryAllowed(_prefetchFail, key)) return;
  _prefetchBusy = key;
  const markFail = () => { _prefetchFail = { key, at: Date.now() }; };
  const quality = resolveQuality(song.source);
  api.getDownloadUrlSmart(song, quality).then(async (result) => {
    if (!result || !result.url) { markFail(); return; }
    const referer = playReferer(result.source || song.source, result);
    const proxied = await api.proxyPlay(result.url, referer);
    if (!proxied || !proxied.fileUrl) { markFail(); return; }
    _prefetch.put(key, {
      fileUrl: proxied.fileUrl,
      quality,
      altSource: result.matchedSong
        ? { source: result.matchedSong.source, id: String(result.matchedSong.id) }
        : null,
    });
    _prefetchFail = null;
  }).catch((e) => {
    markFail();
    // 预热失败不该惊动用户：下一首退回常规取流链路，最多是回到「切歌有空白」的旧行为
    logger.error('下一首预热失败:', e);
  }).finally(() => {
    _prefetchBusy = null;
  });
}

audio.addEventListener('timeupdate', () => {
  if (audio.paused) return;
  if (!shouldPrefetchNow({ currentTime: audio.currentTime, duration: audio.duration })) return;
  _startPrefetch();
});

// ── 播放控制 ─────────────────────────────────────────
export function togglePlay() {
  // 无音频源但有队列时：从当前 playIdx 开始播放
  if (audio.paused && (!audio.src || audio.src === '')) {
    const playQueue = getState('playQueue');
    if (Array.isArray(playQueue) && playQueue.length) {
      const playIdx = getState('playIdx');
      const song = playIdx >= 0 && playIdx < playQueue.length ? playQueue[playIdx] : playQueue[0];
      if (song) {
        setState('playIdx', playQueue.indexOf(song));
        loadAndPlay(song);
        return;
      }
    }
  }
  if (audio.paused) {
    audio.play().then(() => {}).catch(() => {});
  } else {
    // 暂停时保存播放进度
    const curSong = getState('currentPlaying');
    if (curSong && audio.currentTime > 0) { savePlayProgress(curSong, audio.currentTime); }
    updatePlayStatsOnStop();
    // 淡出档位开着时交给缓停收尾（音量降到 0 才真 pause），否则立即停
    if (typeof window.fadeOutPause === 'function' && window.fadeOutPause(audio)) return;
    audio.pause();
  }
}

export function toggleShuffle() {
  const v = !getState('isShuffled');
  setState('isShuffled', v);
  updatePlayModeButton();
  showToast(v ? '随机播放 开' : '随机播放 关', 'info');
}

export function toggleLoop() {
  const v = (getState('loopMode') + 1) % 3;
  setState('loopMode', v);
  updatePlayModeButton();
  const labels = ['不循环', '列表循环', '单曲循环'];
  showToast(labels[v], 'info');
}

// ── 播放模式 ──────────────────────────────────────────
const PLAY_MODES = [
  { shuffle: false, loop: 0, label: '顺序播放' },
  { shuffle: true,  loop: 0, label: '随机播放' },
  { shuffle: false, loop: 1, label: '列表循环' },
  { shuffle: false, loop: 2, label: '单曲循环' },
];

// ── 播放模式按钮（合并随机+循环）─────────────────────
export function cyclePlayMode() {
  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');

  // 找到当前模式
  let currentIdx = 0;
  if (isShuffled && loopMode === 0) currentIdx = 1;
  else if (!isShuffled && loopMode === 1) currentIdx = 2;
  else if (!isShuffled && loopMode === 2) currentIdx = 3;

  // 切换到下一个模式
  const nextIdx = (currentIdx + 1) % PLAY_MODES.length;
  const next = PLAY_MODES[nextIdx];

  setState('isShuffled', next.shuffle);
  setState('loopMode', next.loop);
  updatePlayModeButton();
  showToast(next.label, 'info');
}

export function updatePlayModeButton() {
  const btn = document.getElementById('btnPlayMode');
  const icon = document.getElementById('btnPlayModeIcon');
  if (!btn || !icon) return;

  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');
  const isActive = isShuffled || loopMode > 0;

  // 更新图标和样式
  if (isActive) {
    btn.style.color = 'var(--accent-ui)';
  } else {
    btn.style.color = '';
  }

  // 更新 SVG 图标
  if (isShuffled && loopMode === 0) {
    // 随机播放
    icon.innerHTML = '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>';
  } else if (!isShuffled && loopMode === 1) {
    // 列表循环
    icon.innerHTML = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
  } else if (!isShuffled && loopMode === 2) {
    // 单曲循环
    icon.innerHTML = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="13" text-anchor="middle" font-size="7" fill="currentColor" stroke="none">1</text>';
  } else {
    // 顺序播放
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
  }

  // tooltip / aria-label 随模式更新：纯图标很难分辨四种模式，悬停提示+读屏器
  // 需要告知当前模式和点击后切换到什么
  const modeNames = { shuffle: '随机播放', list: '列表循环', one: '单曲循环', order: '顺序播放' };
  const nextNames = { shuffle: '列表循环', list: '单曲循环', one: '顺序播放', order: '随机播放' };
  let cur = modeNames.order, next = nextNames.order;
  if (isShuffled && loopMode === 0) { cur = modeNames.shuffle; next = nextNames.shuffle; }
  else if (!isShuffled && loopMode === 1) { cur = modeNames.list; next = nextNames.list; }
  else if (!isShuffled && loopMode === 2) { cur = modeNames.one; next = nextNames.one; }
  btn.title = `${cur}（点击切换：${next}）`;
  btn.setAttribute('aria-label', `播放模式：${cur}，点击切换到${next}`);
}

// ── 封面动画控制 ─────────────────────────────────────
let _coverAnimation = 'rotate'; // 'rotate' | 'pulse' | 'none'

export function setCoverAnimation(style) {
  _coverAnimation = style;
  const disc = document.getElementById('playerDiscInner');
  if (!disc) return;
  disc.className = 'player-disc-inner animation-' + style;
}

export function cycleCoverAnimation() {
  const styles = ['rotate', 'pulse', 'none'];
  const idx = styles.indexOf(_coverAnimation);
  const next = styles[(idx + 1) % styles.length];
  setCoverAnimation(next);
  const labels = { rotate: '轻摆', pulse: '脉动', none: '静态' };
  showToast('封面动画：' + labels[next], 'info');
}

// ── 应用关闭时释放 AudioContext ────────────────────
window.addEventListener('beforeunload', () => {
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
});

// ── 音量控制 ──────────────────────────────────────────
// 出厂音量只许有一个字面量：初始化、静音回退、「恢复所有设置」三处都读它
const DEFAULT_VOLUME = 0.8;
const DEFAULT_PLAYBACK_RATE = 1.0;

export function setVolume(value) {
  const vol = Math.max(0, Math.min(100, parseInt(value) || 0));
  audio.volume = vol / 100;
  const slider = document.getElementById('volumeSlider');
  const label = document.getElementById('volumeValue');
  const btn = document.getElementById('volumeBtn');
  if (slider) slider.value = vol;
  if (label) label.textContent = vol + '%';
  if (typeof _persistVolume === 'function') _persistVolume();
  // 更新图标
  if (btn) {
    if (vol === 0) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
    } else if (vol < 50) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    }
  }
}

export function toggleMute() {
  if (audio.volume > 0) {
    audio._prevVolume = audio.volume;
    setVolume(0);
  } else {
    setVolume(Math.round((audio._prevVolume || DEFAULT_VOLUME) * 100));
  }
}

// 初始化音量：恢复上次记住的音量（prefs.playerVolume），无记录则 80%。
// 注意恢复逻辑须等 window.api 就绪——player.js 被 app.js import 时 api getter
// 可能尚未挂上（模块体先于 app.js 执行），故挂 DOMContentLoaded 而非模块加载时执行
audio.volume = DEFAULT_VOLUME;
(function scheduleVolumeRestore() {
  const restore = () => {
    if (typeof window.api !== 'undefined' && typeof window.api.getPref === 'function') {
      window.api.getPref('playerVolume')
        .then(v => { if (typeof v === 'number' && !isNaN(v)) setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)); })
        .catch(() => {});
    }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(restore, 0);
  } else {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  }
})();
// 音量记忆：变更后防抖写 prefs（拖动滑条时 setVolume 高频触发，不能每步都写盘）
let _volPersistTimer = null;
/** playerVolume 的唯一落笔口：掐掉未执行的防抖，立刻写当前值 */
function _flushVolumePersist() {
  if (_volPersistTimer) { clearTimeout(_volPersistTimer); _volPersistTimer = null; }
  try { if (typeof api !== 'undefined' && typeof api.setPref === 'function') api.setPref('playerVolume', audio.volume); } catch (_e) { /* 持久化失败不影响音量本身 */ }
}
function _persistVolume() {
  if (_volPersistTimer) clearTimeout(_volPersistTimer);
  _volPersistTimer = setTimeout(() => { _volPersistTimer = null; _flushVolumePersist(); }, 600);
}

// ── 倍速播放 ──────────────────────────────────────────
// preservesPitch=true 时变速不变调（Chromium 默认支持），关掉会像磁带快进
const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 2.0];
let _playbackRate = DEFAULT_PLAYBACK_RATE;

function _applyPlaybackRate() {
  audio.playbackRate = _playbackRate;
  try { audio.preservesPitch = true; } catch (_e) { /* 旧内核无此属性 */ }
  const btn = document.getElementById('btnPlaybackRate');
  if (btn) {
    btn.textContent = _playbackRate === 1.0 ? '1x' : String(_playbackRate).replace(/\.?0+$/, '') + 'x';
    btn.title = `倍速：${_playbackRate}x（点击切换）`;
    btn.setAttribute('aria-label', `播放倍速 ${_playbackRate} 倍，点击切换下一档`);
  }
}

export function cyclePlaybackRate() {
  const idx = PLAYBACK_RATES.indexOf(_playbackRate);
  _playbackRate = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
  _applyPlaybackRate();
  showToast(`倍速：${_playbackRate}x`, 'info', 1500);
  try { api.setPref('playbackRate', _playbackRate); } catch (_e) { /* 持久化失败不影响本次 */ }
}

/**
 * 音量与倍速的「默认态」：设置页「恢复所有设置」叫这一家。
 * 这两个旋钮住在播放器上（音量滑条、倍速按钮），不在 GENERAL_PREFS 表里 —— 表管不着它们，
 * 于是过去的"恢复默认"漏掉了它们：滑条仍停在用户上次拖到的 15%、倍速仍是 2x，重启照旧。
 * 委派既有的 setVolume / _applyPlaybackRate：滑条、百分比、按钮图标、aria 各只有一家会改。
 */
export function resetPlaybackPrefs() {
  setVolume(DEFAULT_VOLUME * 100);
  _flushVolumePersist(); // 音量平时靠 600ms 防抖写盘，恢复默认必须当场落盘（按完就关窗也不能丢）
  _playbackRate = DEFAULT_PLAYBACK_RATE;
  _applyPlaybackRate();
  try { api.setPref('playbackRate', DEFAULT_PLAYBACK_RATE); } catch (_e) { /* 持久化失败不影响本次 */ }
}

// 启动恢复上次倍速（同 volume 模式：等 window.api 就绪）
(function scheduleRateRestore() {
  const restore = () => {
    if (typeof window.api !== 'undefined' && typeof window.api.getPref === 'function') {
      window.api.getPref('playbackRate')
        .then(v => {
          if (typeof v === 'number' && !isNaN(v) && v > 0 && v <= 4) {
            _playbackRate = PLAYBACK_RATES.includes(v) ? v : 1.0;
            _applyPlaybackRate();
          }
        })
        .catch(() => {});
    }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(restore, 0);
  } else {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  }
})();

// ── 音量弹层交互升级：拖动锁定 + 滚轮调节 ─────────────
// 旧交互仅 hover：拖动滑条到一半移出弹层直接断（opacity:0 + pointer-events:none
// 立即生效），且除拖滑条外无快速调节手段。
// 改为：滑条按下/聚焦期间弹层锁定显示（.pinned），松手 800ms 后自动收回；
// 滚轮在音量按钮或弹层上直接 ±5%。
function _initVolumeUX() {
  const wrap = document.getElementById('pcVolume');
  const slider = document.getElementById('volumeSlider');
  if (!wrap || !slider) return;
  let releaseTimer = null;
  const pin = () => { wrap.classList.add('pinned'); if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; } };
  const scheduleRelease = () => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { wrap.classList.remove('pinned'); releaseTimer = null; }, 800);
  };
  slider.addEventListener('pointerdown', pin);
  slider.addEventListener('focus', pin);
  slider.addEventListener('pointerup', scheduleRelease);
  slider.addEventListener('blur', scheduleRelease);
  // 拖动结束后指针通常已移出弹层，靠 pinned 保持收尾视觉一致
  slider.addEventListener('change', scheduleRelease);
  // 滚轮调节：在音量控件任意位置滚动直接加减，不必打开弹层
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = Math.round(audio.volume * 100);
    const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? 5 : -5)));
    if (next !== cur) setVolume(next);
  }, { passive: false });
}
window.addEventListener('beforeunload', () => { _flushVolumePersist(); });

// ── 进度条 ───────────────────────────────────────────
let _lastProgressSave = 0;
export function updateProgress() {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  const fill = document.getElementById('playerProgressFill');
  if (fill) fill.style.width = pct + '%';
  const thumb = document.getElementById('playerProgressThumb');
  if (thumb) thumb.style.left = pct + '%';
  const bar = document.getElementById('playerProgressBar');
  if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
  const now = document.getElementById('timeNow');
  if (now) now.textContent = fmtTime(audio.currentTime);
  const total = document.getElementById('timeTotal');
  if (total) total.textContent = fmtTime(audio.duration);
  updateLyric(audio.currentTime);
  // 每 30 秒自动保存播放进度
  const t = Date.now();
  if (t - _lastProgressSave > 30000 && audio.currentTime > 5) {
    _lastProgressSave = t;
    const curSong = getState('currentPlaying');
    if (curSong) savePlayProgress(curSong, audio.currentTime);
  }
}

export function seekAudio(e) {
  const bar = document.getElementById('playerProgressBar');
  if (!bar) return;
  const pct = _pointerToPct(bar, e);
  if (audio.duration) audio.currentTime = pct * audio.duration;
}

/** 指针事件 → 进度百分比（0~1，含边界钳制） */
function _pointerToPct(bar, e) {
  const rect = bar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

/** 百分比 → 显示时间文本 */
function _fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * 进度条拖动（scrubbing）：按住拖动实时预览进度，松手落定。
 * 替代旧版"只能点击"的交互——4px 命中区 + 无拖动是播放器最常见的可用性抱怨。
 * 悬停时显示时间预览气泡（progressHoverTime）。
 */
function _initProgressDrag() {
  const bar = document.getElementById('playerProgressBar');
  if (!bar) return;
  const fill = document.getElementById('playerProgressFill');
  const thumb = document.getElementById('playerProgressThumb');
  const hoverTime = document.getElementById('progressHoverTime');
  const ariaTarget = bar;

  // 悬停预览：指针在轨道上移动时显示对应时间气泡
  bar.addEventListener('pointermove', (e) => {
    if (!audio.duration || bar.classList.contains('dragging')) return;
    const pct = _pointerToPct(bar, e);
    if (hoverTime) {
      hoverTime.textContent = _fmtTime(pct * audio.duration);
      hoverTime.style.left = (pct * 100) + '%';
    }
  });

  // 拖动开始：按住即进入 scrubbing，实时移动填充和气泡
  bar.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    e.preventDefault();
    bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    const preview = (pct) => {
      if (fill) fill.style.width = (pct * 100) + '%';
      if (thumb) thumb.style.left = (pct * 100) + '%';
      if (hoverTime) {
        hoverTime.textContent = _fmtTime(pct * audio.duration);
        hoverTime.style.left = (pct * 100) + '%';
      }
      if (ariaTarget) ariaTarget.setAttribute('aria-valuenow', Math.round(pct * 100));
    };
    preview(_pointerToPct(bar, e));
    const onMove = (ev) => preview(_pointerToPct(bar, ev));
    const onUp = (ev) => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', onMove);
      try { bar.releasePointerCapture(ev.pointerId); } catch (_e) { /* 已释放 */ }
      const pct = _pointerToPct(bar, ev);
      if (audio.duration) audio.currentTime = pct * audio.duration;
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp, { once: true });
    bar.addEventListener('pointercancel', () => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', onMove);
    }, { once: true });
  });

  // 键盘可达：←/→ 微调 5 秒
  bar.tabIndex = 0;
  bar.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 30 : 5;
      audio.currentTime = Math.max(0, Math.min(audio.duration,
        audio.currentTime + (e.key === 'ArrowLeft' ? -step : step)));
    }
  });
}

export function onAudioEnded() {
  const loopMode = getState('loopMode');
  // 播放结束时清除进度记忆（已播完不需要恢复）
  const curSong = getState('currentPlaying');
  if (curSong) { try { savePlayProgress(curSong, 0); } catch (_e) { /* ignore */ } }
  // 「播完当前歌曲再停」排在连播/单曲循环之前：闩命中即收口，否则单曲循环永远等不到停
  if (typeof window.consumeSleepEndStop === 'function' && window.consumeSleepEndStop()) {
    updatePlayStatsOnStop();
    audio.pause();
    return;
  }
  if (loopMode === 2) {
    // 修复：单曲循环时也要记录播放时长，避免统计丢失
    updatePlayStatsOnStop();
    restartPlayTimer(); // 重置计时起点
    audio.currentTime = 0;
    audio.play().then(() => {}).catch(() => {});
    return;
  }
  updatePlayStatsOnStop();
  nextSong();
}


// esc() 和 fmtTime() 已由 utils.js 全局导出，此处不再重复定义

// ── 子模块转出（保持 player.js 公开 API 与拆分前一致）──
// 统计簇 → player/stats.js；歌词簇 → player/lyrics.js
export {
  getRecentlyPlayed, loadRecentlyPlayed, clearRecentlyPlayed,
  getPlayStats, getMostPlayed, loadPlayStats, resetPlayStats, generatePlayReport,
  copyPlayReportText,
  parseLrc, showStaticLyrics, showNoLyrics, updateLyric, toggleLyricsArea,
};

// ── ES Module 导出（其余函数已在定义处 export） ─────
// 本文件仍自持：EQ、播放控制、进度/音量、封面动画、播放卡片
//   applyEqPreset, toggleEqBypass, setEqBand, resetEq, saveEqSettings,
//   updatePlayerCard, loadAndPlay, nextSong, prevSong, togglePlay,
//   toggleShuffle, toggleLoop, cyclePlayMode, updatePlayModeButton,
//   setCoverAnimation, cycleCoverAnimation, setVolume, toggleMute,
//   updateProgress, seekAudio, onAudioEnded

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
// 进度条拖动/悬停预览/键盘微调 + 音量拖动锁定/滚轮调节。
// module script 在 DOM 解析完后执行，但仍加 readyState 守卫以防未来加载位置变动。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { _initProgressDrag(); _initVolumeUX(); }, { once: true });
} else {
  _initProgressDrag();
  _initVolumeUX();
}
window.loadAndPlay = loadAndPlay;
window.togglePlay = togglePlay;
window.updateProgress = updateProgress;
window.seekAudio = seekAudio;
window.onAudioEnded = onAudioEnded;
window.nextSong = nextSong;
window.prevSong = prevSong;
window.toggleShuffle = toggleShuffle;
window.toggleLoop = toggleLoop;
window.cyclePlayMode = cyclePlayMode;
window.updatePlayModeButton = updatePlayModeButton;
window.parseLrc = parseLrc;
window.showStaticLyrics = showStaticLyrics;
window.showNoLyrics = showNoLyrics;
window.updateLyric = updateLyric;
window.toggleLyricsArea = toggleLyricsArea;
window.applyLyricFontSize = applyLyricFontSize;
window.applyLyricOffset = applyLyricOffset;
window.getLyricOffset = getLyricOffset;
window.setCoverAnimation = setCoverAnimation;
window.cycleCoverAnimation = cycleCoverAnimation;
window.updatePlayerCard = updatePlayerCard;
window.setPlayerState = setPlayerState;
window.refreshPlayerState = refreshPlayerState;
window.togglePlayerMore = togglePlayerMore;
window.closePlayerMore = closePlayerMore;
window.setEqBand = setEqBand;
window.resetEq = resetEq;
window.saveEqSettings = saveEqSettings;
window.applyEqPreset = applyEqPreset;
window.toggleEqBypass = toggleEqBypass;
window.restoreEqPresetSetting = restoreEqPresetSetting;
window.cycleEqPreset = cycleEqPreset;
window.setVolume = setVolume;
window.toggleMute = toggleMute;
window.cyclePlaybackRate = cyclePlaybackRate;
window.resetPlaybackPrefs = resetPlaybackPrefs;
window.getRecentlyPlayed = getRecentlyPlayed;
window.clearRecentlyPlayed = clearRecentlyPlayed;
window.loadRecentlyPlayed = loadRecentlyPlayed;
window.getPlayStats = getPlayStats;
window.getMostPlayed = getMostPlayed;
window.resetPlayStats = resetPlayStats;
window.generatePlayReport = generatePlayReport;
window.copyPlayReportText = copyPlayReportText;
window.loadPlayStats = loadPlayStats;
