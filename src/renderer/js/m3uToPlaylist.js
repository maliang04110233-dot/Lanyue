/**
 * 导入 m3u 为用户歌单
 *
 * 的 m3u 导入是「解析→在线搜索→入队下载」；但本地播放器导出的 m3u
 * 大多数的歌本就躺在曲库里，再造一遍下载是浪费。本模块走第二条路：
 * 路径优先、曲名+歌手兜底，两级匹配本地曲库；命中歌折叠成
 * source:'local' + id=filePath（与收藏红心、播放器 file:// 分支同键形，
 * 导入即可播），整单走既有 api.saveUserPlaylist 通道，零新 IPC。
 * 未匹配行只在描述/播报里报数，不静默丢。
 */

import { errBrief } from './errBrief.js';
import { logger } from './logger.js';

export const AUDIO_EXT_RE = /\.(flac|mp3|m4a|wav|ogg|ape|wma|aac|opus)$/i;

function _normPath(p) {
  return String(p || '').trim().toLowerCase().replace(/\\/g, '/');
}

/** 「歌手 - 歌名」拆分；无 " - " 时整串作曲名（拖放即播复用，见 dropPlay.js） */
export function splitTitleArtist(desc) {
  const s = String(desc || '').trim();
  const i = s.indexOf(' - ');
  if (i > 0) return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() };
  return { artist: '', title: s };
}

function _basename(line) {
  const parts = String(line).split(/[\\/]/);
  return parts[parts.length - 1].trim().replace(AUDIO_EXT_RE, '');
}

function _looksLikePath(line) {
  return AUDIO_EXT_RE.test(line) || /[\\/]/.test(line);
}

/** 纯函数：m3u 文本 → {title, artist, filePath|null} 条目数组（比 parseM3u 保留路径） */
export function parseM3uEntries(text, max = 500) {
  const out = [];
  let pending = null; // 最近一条 #EXTINF 的描述，等路径行确认
  const push = (name, filePath) => {
    if (out.length >= max) return;
    const { artist, title } = splitTitleArtist(name);
    if (title) out.push({ title, artist, filePath: filePath || null });
  };
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('#EXTINF')) {
      if (pending != null && pending !== '-') push(pending, null); // 坏文件：前一条先落袋
      const comma = line.indexOf(',');
      pending = comma >= 0 ? line.slice(comma + 1).trim() : '';
      continue;
    }
    if (line.startsWith('#')) continue; // 其余指令行不携带曲名
    const name = pending && pending !== '-' ? pending : _basename(line);
    push(name, _looksLikePath(line) ? line : null);
    pending = null;
  }
  if (pending != null && pending !== '-') push(pending, null);
  return out;
}

/**
 * 纯函数：m3u 条目 × 曲库 → { matched, unmatched }。
 * 路径命中（大小写/分隔符归一）优先，曲名+歌手相等兜底（任一方缺歌手不卡）；
 * matched 为曲库原歌的折叠副本（source:'local'、id=filePath，播放/红心键形统一）。
 */
export function matchEntriesToLibrary(entries, songs) {
  const matched = [];
  const unmatched = [];
  const list = Array.isArray(songs) ? songs : [];
  const byPath = new Map();
  for (const s of list) {
    if (s && s.filePath && !byPath.has(_normPath(s.filePath))) byPath.set(_normPath(s.filePath), s);
  }
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.title) { continue; }
    let hit = e.filePath ? byPath.get(_normPath(e.filePath)) : null;
    if (!hit) {
      const et = e.title.toLowerCase();
      const ea = (e.artist || '').toLowerCase();
      hit = list.find((s) => s && s.filePath
        && String(s.title || '').toLowerCase() === et
        && (!ea || !s.artist || String(s.artist).toLowerCase() === ea)) || null;
    }
    if (hit) matched.push({ ...hit, source: 'local', id: hit.filePath });
    else unmatched.push(e.title);
  }
  return { matched, unmatched };
}

/** 纯函数：'我的最爱.m3u8' → '我的最爱'（剥扩展名与目录） */
export function playlistNameFromFile(fn) {
  const base = String(fn || '').split(/[\\/]/).pop().replace(/\.m3u8?$/i, '').trim();
  return base || 'm3u 导入';
}

/** 主流程：m3u 文本 → 匹配曲库 → saveUserPlaylist 建单。返回 promise 便于测试等待。 */
export async function importM3uAsPlaylist(fileName, text) {
  const entries = parseM3uEntries(text);
  if (!entries.length) { showToast('m3u 里没有可解析的歌曲行', 'warn'); return; }
  let pool = (typeof getState === 'function' && getState('localSongs')) || [];
  if (!pool.length && typeof api !== 'undefined' && typeof api.loadLibraryIndex === 'function') {
    try {
      const r = await api.loadLibraryIndex();
      pool = (r && r.songs) || [];
    } catch (e) {
      logger.warn('[m3uToPlaylist] 曲库索引加载失败:', e && e.message);
    }
  }
  const { matched, unmatched } = matchEntriesToLibrary(entries, pool);
  if (!matched.length) {
    showToast(`曲库里没匹配到歌（m3u 共 ${entries.length} 行），可改用「导入 m3u 匹配入队下载」`, 'warn', 3600);
    return;
  }
  const name = playlistNameFromFile(fileName);
  const tail = unmatched.length ? `，未匹配 ${unmatched.length}` : '';
  try {
    const r = await api.saveUserPlaylist({
      name,
      desc: `m3u 导入 · ${matched.length} 首${tail}`,
      cover: '',
      songs: matched,
    });
    if (r && r.success) {
      if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
      showToast(`📥 已导入歌单「${name}」：匹配 ${matched.length} 首${tail}`, 'success', 3200);
    } else {
      showToast((r && r.error) || '导入失败', 'error');
    }
  } catch (e) {
    logger.warn('[m3uToPlaylist] 建单失败:', e && e.message);
    showToast('导入失败: ' + errBrief(e), 'error');
  }
}

/** 文件选择入口（工具栏按钮 / 命令面板共用） */
export function pickM3uForPlaylist() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.m3u,.m3u8,text/plain';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      await importM3uAsPlaylist(file.name, await file.text());
    } catch (e) {
      logger.warn('[m3uToPlaylist] 读文件失败:', e && e.message);
      showToast('读取 m3u 文件失败: ' + errBrief(e), 'error');
    }
  });
  input.click();
}

// node 直测（dropPlay 复用本模块纯函数）不得被 window 桥炸穿
if (typeof window !== 'undefined') {
  window.pickM3uForPlaylist = pickM3uForPlaylist;
  window.importM3uAsPlaylist = importM3uAsPlaylist;
}
