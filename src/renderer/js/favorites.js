/**
 * 收藏（红心）
 *
 * 收藏歌单 = 主进程 userPlaylists 里 id 为 favorites 的系统歌单；红心状态从
 * state.favoriteKeys 派生。本模块负责：生成行内红心按钮 HTML、点击切换、
 * 就地刷新所有同键红心，并把渲染过的歌曲对象留在登记表里供切换时取用。
 *
 * 切换后只刷新按钮本身，不重渲染整张列表 —— 搜索结果与首页榜单都是
 * 整块 innerHTML 重写，重渲染会丢滚动位置和已勾选状态。
 *
 * 按钮不带内联字符串参数（改用 data-fav-key + this 回传），
 * 避免把用户可控的歌曲字段拼进 onclick。
*/

import { errBrief } from './errBrief.js';
import { logger } from './logger.js';
import { FAVORITES_PLAYLIST_ID, favKey } from './state.js';

export const HEART_ON = '♥';
export const HEART_OFF = '♡';

/** 渲染时登记歌曲，收藏/取消时才能带回完整元数据 */
const _songRegistry = new Map();

export function registerFavSong(song) {
  if (song && song.id != null) _songRegistry.set(favKey(song.source, song.id), song);
  return song;
}

export function isFavorite(song) {
  if (!song || song.id == null) return false;
  return (getState('favoriteKeys') || new Set()).has(favKey(song.source, song.id));
}

/**
 * 本地歌曲 → 收藏歌单可存的形态：source='local' + id=filePath。
 * filePath 全局唯一，天然不与其他平台撞键；其余字段（含 filePath 本身）
 * 原样保留，收藏详情里点播放走 player 的 file:// 本地分支。
 */
export function localFavSong(song) {
  if (!song || !song.filePath) return null;
  return { ...song, source: 'local', id: song.filePath };
}

export function isLocalFavorite(song) {
  const s = localFavSong(song);
  return !!s && isFavorite(s);
}

export function toggleLocalFavorite(song) {
  const s = localFavSong(song);
  if (!s) { showToast('收藏失败：歌曲缺少文件路径', 'warn'); return; }
  registerFavSong(s);
  return toggleFavoriteByKey(favKey('local', s.filePath));
}

/**
 * 播放队列行 → 收藏对象：本地行与本地曲库同走 filePath:local 键
 * （行对象 id 未必是 filePath，直接heart会和本地库红心分裂成两条）；
 * 无 id 的行（异常数据）不出红心。
 */
export function queueFavSong(s) {
  if (!s) return null;
  if (String(s.source || '') === 'local') return localFavSong(s);
  return s.id != null ? s : null;
}

/**
 * 收藏/取消当前正在播放的歌（命令面板入口）。
 *
 * 五个行面红心只覆盖列表行；主播放器/迷你窗/桌面词上没有点心处。
 * 键对齐直接复用 queueFavSong（本地折叠 filePath:local，与本地库/队列
 * 红心同一颗心），登记后走 toggleFavoriteByKey 的整条切换+播报链。
 */
export async function toggleFavoriteCurrent() {
  const cur = typeof getState === 'function' ? getState('currentPlaying') : null;
  const s = queueFavSong(cur);
  if (!s) { showToast('当前没有可收藏的歌', 'info'); return; }
  registerFavSong(s);
  await toggleFavoriteByKey(favKey(s.source, s.id));
}

/**
 * 红心按钮 HTML，返回完整 button 标签
 * @param {Object} song 需含 source / id
 * @param {string} [baseClass] 行内按钮基类（搜索页 action-btn，首页 top-song-action）
 */
export function heartBtnHtml(song, baseClass) {
  registerFavSong(song);
  const key = favKey(song.source, song.id);
  const on = isFavorite(song);
  const cls = (baseClass || 'action-btn') + ' heart-btn' + (on ? ' fav-on' : '');
  const title = on ? '取消收藏' : '收藏';
  return '<button class="' + escAttr(cls) + '" data-fav-key="' + escAttr(key) + '"' +
    ' title="' + escAttr(title) + '"' +
    ' onclick="event.stopPropagation();favHeartClick(this)">' +
    (on ? HEART_ON : HEART_OFF) + '</button>';
}

/** 红心按钮的 onclick 入口（this 回传，避免内联字符串参数） */
export function favHeartClick(btn) {
  const key = btn && btn.getAttribute('data-fav-key');
  if (key) toggleFavoriteByKey(key);
}

/**
 * 按收藏键切换状态并就地刷新全部红心按钮。
 * @param {boolean} [silent] 批量路径用：不弹单曲 toast，成败看返回值，
 *   由调用方聚合播报；缺省时行为与旧版逐字一致。
 */
export async function toggleFavoriteByKey(key, silent) {
  const _toast = silent ? () => {} : showToast;
  const song = _songRegistry.get(key);
  if (!song) { _toast('收藏失败：歌曲信息缺失', 'warn'); return false; }
  try {
    const r = await api.toggleFavorite(String(song.source || ''), String(song.id), song);
    if (!r || !r.success) {
      _toast((r && r.error) || '收藏失败', 'error');
      return false;
    }
    // 写回主进程返回的收藏歌单，favoriteKeys 计算属性随之失效重建
    const pls = (getState('userPlaylists') || []).slice();
    const idx = pls.findIndex(pl => pl && pl.id === FAVORITES_PLAYLIST_ID);
    if (idx >= 0) pls[idx] = r.playlist; else pls.unshift(r.playlist);
    setState('userPlaylists', pls);
    refreshFavoriteHearts();
    // 本地歌收藏变化钩子：仅收藏视图需要即时重过滤（行菜单与行内红心共用一条路）
    if (String(song.source || '') === 'local' && typeof window.onLocalFavToggle === 'function') {
      window.onLocalFavToggle();
    }
    const name = song.title || song.artist || '';
    _toast((r.favorited ? '已收藏' : '已取消收藏') + (name ? '：' + name : ''),
      r.favorited ? 'success' : 'info', 1800);
    return true;
  } catch (e) {
    logger.warn('收藏失败:', e);
    _toast('收藏失败: ' + errBrief(e), 'error');
    return false;
  }
}

/** 就地刷新所有红心按钮外观（不重渲染列表） */
export function refreshFavoriteHearts() {
  const keys = getState('favoriteKeys') || new Set();
  document.querySelectorAll('[data-fav-key]').forEach(btn => {
    const on = keys.has(btn.getAttribute('data-fav-key'));
    btn.classList.toggle('fav-on', on);
    btn.textContent = on ? HEART_ON : HEART_OFF;
    btn.title = on ? '取消收藏' : '收藏';
  });
}

window.toggleFavoriteByKey = toggleFavoriteByKey;
window.favHeartClick = favHeartClick;
window.refreshFavoriteHearts = refreshFavoriteHearts;
window.toggleLocalFavorite = toggleLocalFavorite;
window.toggleFavoriteCurrent = toggleFavoriteCurrent;
