/**
 * 用户歌单 IPC
 *
 * 注册：get-user-playlists / save-user-playlist / delete-user-playlist /
 *       add-to-user-playlist / remove-from-user-playlist
 *
 * 持久化到 userData/prefs.json
 */

const prefs = require('../../utils/prefs');
const { handle } = require('./register');
const { trashRemove, trashRestore, purgeExpired, trashView, trashPurge } = require('../../utils/playlistTrash');

// 回收站单独一个 prefs 键，不掺进 userPlaylists（见 utils/playlistTrash.js 头注）。
// 主进程内部键，与 userPlaylists 同待遇：不进 set-pref 白名单、不进云同步。
const TRASH_KEY = 'playlistTrash';

function _trash() {
  return prefs.get(TRASH_KEY) || [];
}

// ── 收藏歌单（红心）──────────────────────────────────────
// 收藏不是独立的存储，而是 userPlaylists 里 id 固定的系统歌单：
// 这样红心状态、歌单管理、导入导出复用同一套数据与 IPC，无需第二份存储。
const FAVORITES_ID = 'favorites';
const FAVORITES_NAME = '收藏';

/** 歌曲在歌单内的唯一键：只按 id 会跨平台撞车（网易云与 QQ 常有相同数字 id） */
function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

/** 确保收藏歌单存在，返回最新的歌单数组 */
function ensureFavorites() {
  const playlists = prefs.get('userPlaylists') || [];
  if (!playlists.some(p => p.id === FAVORITES_ID)) {
    const now = Date.now();
    playlists.unshift({
      id: FAVORITES_ID,
      name: FAVORITES_NAME,
      desc: '红心收藏的歌曲',
      songs: [],
      system: true,
      createdAt: now,
      updatedAt: now,
    });
    prefs.set('userPlaylists', playlists);
  }
  return playlists;
}

function register() {
  // 启动即清过期回收站条目（30 天 TTL，规则在 utils/playlistTrash.js 一家管）
  const trashNow = _trash();
  const { trash: alive, purged } = purgeExpired(trashNow, Date.now());
  if (purged.length) prefs.set(TRASH_KEY, alive);

  // 获取所有用户歌单；71b3f75 起支持 opts.trash —— 带 {trash:true} 返回回收站视图
  // （含剩余天数，主进程算好，TTL 默认值不给渲染层抄第二份）。
  // 本频道契约无 args 规格（normalizeArgs 原样放行），零新通道、契约零改动。
  handle('get-user-playlists', (_, opts) => {
    if (opts && opts.trash) return trashView(_trash(), Date.now());
    return ensureFavorites();
  });

  // 保存歌单（新建或更新）
  handle('save-user-playlist', (_, playlist) => {
    if (!playlist || !playlist.name) return { success: false, error: '歌单名称不能为空' };
    const playlists = ensureFavorites();
    const now = Date.now();

    if (playlist.id) {
      // 更新已有歌单
      const idx = playlists.findIndex(p => p.id === playlist.id);
      if (idx >= 0) {
        playlists[idx] = { ...playlists[idx], ...playlist, updatedAt: now };
        prefs.set('userPlaylists', playlists);
        // 歌单已在列表中（撤销成功过 / 云端把它带回来了）⇒ 回收站里那份
        // 陈旧条目顺手清掉，不然同一歌单会"既在列表又在回收站"地挂着
        const tr0 = _trash();
        const rr0 = trashRestore(playlists, tr0, playlist);
        if (rr0.trash.length !== tr0.length) prefs.set(TRASH_KEY, rr0.trash);
        return { success: true, playlist: playlists[idx] };
      }
      // 带 id 却不在列表 —— 可能是"撤销删除"：渲染层攥着被删歌单的完整副本
      // 走这条既有通道原 id 保存回来（零新 IPC 通道，契约 args 形状未动）。
      const rr = trashRestore(playlists, _trash(), playlist);
      if (rr.restored) {
        prefs.set(TRASH_KEY, rr.trash);
        prefs.set('userPlaylists', rr.playlists);
        return { success: true, playlist: rr.restored, restored: true };
      }
    }

    // 新建歌单
    const newPlaylist = {
      id: 'pl_' + now + '_' + Math.random().toString(36).slice(2, 8),
      name: playlist.name,
      desc: playlist.desc || '',
      cover: playlist.cover || '',
      songs: playlist.songs || [],
      createdAt: now,
      updatedAt: now,
    };
    playlists.unshift(newPlaylist);
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: newPlaylist };
  });

  // 删除歌单（硬删改挪回收站，5 秒内可撤销、30 天内可恢复）
  handle('delete-user-playlist', (_, playlistId) => {
    if (!playlistId) return { success: false, error: '缺少歌单ID' };
    const playlists = ensureFavorites();
    const pl = playlists.find(p => p.id === playlistId);
    if (pl && pl.system) return { success: false, error: '收藏歌单不能删除' };
    // 列表里没有、回收站里倒是有 ⇒ 这次"再删一次"就是回收站的彻底删除
    // （同一频道同一 args 形状，不另开 purge 通道）
    if (!pl) {
      const pr = trashPurge(_trash(), playlistId);
      if (!pr.purged) return { success: false, error: '歌单不存在' };
      prefs.set(TRASH_KEY, pr.trash);
      return { success: true, purged: true };
    }
    const res = trashRemove(playlists, _trash(), playlistId, Date.now());
    if (!res.removed) return { success: false, error: '歌单不存在' };
    prefs.set('userPlaylists', res.playlists);
    prefs.set(TRASH_KEY, res.trash);
    return { success: true };
  });

  // 添加歌曲到歌单
  // 参数为位置参数（renderer 侧 api.addToUserPlaylist(playlistId, song)）
  handle('add-to-user-playlist', (_, playlistId, song) => {
    if (!playlistId || !song) return { success: false, error: '参数不完整' };
    const playlists = prefs.get('userPlaylists') || [];
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx < 0) return { success: false, error: '歌单不存在' };

    const pl = playlists[idx];
    // 避免重复添加（按 source+id 判断）
    const exists = pl.songs.some(s => s.source === song.source && s.id === song.id);
    if (exists) return { success: true, skipped: true };

    pl.songs.push({ ...song, addedAt: Date.now() });
    pl.updatedAt = Date.now();
    playlists[idx] = pl;
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: pl };
  });

  // 从歌单移除歌曲（位置参数，同上）
  handle('remove-from-user-playlist', (_, playlistId, songId, source) => {
    if (!playlistId || !songId) return { success: false, error: '参数不完整' };
    const playlists = ensureFavorites();
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return { success: false, error: '歌单不存在' };

    // source 为空时退回按 id 匹配（旧调用方），非空时精确到 source+id
    const wantId = String(songId);
    const wantSrc = source == null || source === '' ? null : String(source);
    pl.songs = pl.songs.filter(s => !(
      String(s.id) === wantId &&
      (wantSrc === null || String(s.source || '') === wantSrc)
    ));
    pl.updatedAt = Date.now();
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: pl };
  });

  // 红心收藏：在收藏歌单中按 source+id 增删切换
  // 参数为位置参数（renderer 侧 api.toggleFavorite(source, id, song)）
  handle('toggle-favorite', (_, source, songId, song) => {
    if (!songId || !song || typeof song !== 'object') {
      return { success: false, error: '参数不完整' };
    }
    const playlists = ensureFavorites();
    const pl = playlists.find(p => p.id === FAVORITES_ID);
    if (!pl) return { success: false, error: '收藏歌单不存在' };

    const wantKey = String(songId) + ':' + String(source || '');
    const idx = pl.songs.findIndex(s => songKey(s) === wantKey);
    if (idx >= 0) {
      pl.songs.splice(idx, 1);
    } else {
      pl.songs.push({ ...song, source, id: songId, addedAt: Date.now() });
    }
    pl.updatedAt = Date.now();
    prefs.set('userPlaylists', playlists);
    return { success: true, favorited: idx < 0, playlist: pl };
  });
}

module.exports = { register, FAVORITES_ID, FAVORITES_NAME, songKey, ensureFavorites };
