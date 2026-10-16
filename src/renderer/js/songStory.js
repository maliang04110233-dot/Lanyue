/**
 * 歌曲讲解（候选方向 1：背景卡片）
 *
 * 播放页「✨」按钮 → get-song-story（主进程出网 + songKey 缓存）→ 卡片上屏。
 * 纪律：文本一律 textContent（模型回复可能含尖括号）；文案全部走词典；
 * 未在播放时点了只提示，不发起任何出网；同一首歌重复点直接吃缓存。
 */

import { t, getLang } from './i18n.js';
import { showToast } from './toast.js';
import { getState } from './state.js';

let _open = false;
let _busy = false;

function _els() {
  return {
    card: document.getElementById('songStoryCard'),
    title: document.getElementById('songStoryTitle'),
    body: document.getElementById('songStoryBody'),
    btn: document.getElementById('btnSongStory'),
  };
}

/** 当前播放的歌（无音源时是 null —— 此时点了只提示，不出网） */
function _currentSong() {
  return getState('currentPlaying');
}

function _lang() {
  return (getLang() || 'zh');
}

async function toggleSongStory() {
  const { card, body } = _els();
  if (!card || !body || _busy) return;
  if (_open) {
    _open = false;
    card.style.display = 'none';
    return;
  }
  const song = _currentSong();
  if (!song || !song.title) {
    showToast(t('player.storyEmpty'), 'info');
    return;
  }
  _open = true;
  card.style.display = 'block';
  body.textContent = t('player.storyLoading');
  _busy = true;
  try {
    const r = await api.getSongStory(String(song.title), String(song.artist || ''), _lang());
    if (r && r.ok) {
      // 文本一律 textContent：模型回复可能含尖括号
      body.textContent = r.story;
    } else if (r && r.error === 'NO_KEY') {
      body.textContent = t('player.storyNoKey');
    } else {
      body.textContent = t('player.storyFailed');
    }
  } catch (_e) {
    body.textContent = t('player.storyFailed');
  } finally {
    _busy = false;
  }
}

window.toggleSongStory = toggleSongStory;
