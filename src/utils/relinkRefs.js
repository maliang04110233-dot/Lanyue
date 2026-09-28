/**
 * 路径引用的回写规则（纯函数，无 IO）
 *
 * 磁盘文件一改名，按路径记账的东西会集体失联：下载历史的 save_path、
 * 歌单/收藏夹里本地歌的 filePath、最近播放条目、播放进度记忆的键、
 * 以及歌曲旁边的 .lrc。这里只负责"给定旧路径/新路径，各存储该变成什么样"，
 * 真正的读写在 utils/fileRelink.js（prefs/history）与 ipc/library.js。
 *
 * pathsEqual 是这套规则的地基，必须容忍同一文件的多种写法：
 * 分隔符（\ 与 /）、重复斜杠、`.` 段，Windows 下还有大小写。
 * 判等太严 ⇒ 回写漏掉一半记录；判等太松 ⇒ 改 A 歌把 B 歌带走。
 */

const path = require('path');

/**
 * 路径的"同一文件"判等写法：分隔符统一成 /、去掉 . 段、Windows 下压大小写。
 * 凡是要拿磁盘路径做对账/归并的地方都必须用它 —— 各模块自己抄一份
 * replace(/\\/g,'/'）必然漂移（/151 的教训）。
 */
function canonPath(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim().replace(/\\/g, '/');
  if (!s) return '';
  const norm = path.posix.normalize(s);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function pathsEqual(a, b) {
  const x = canonPath(a);
  const y = canonPath(b);
  return Boolean(x) && Boolean(y) && x === y;
}

/** 音频路径 → 同名歌词 sidecar 路径（与 library.js/downloadQueue 的既有写法逐字符一致） */
function sidecarPathFor(audioPath) {
  const s = typeof audioPath === 'string' ? audioPath : '';
  if (!s) return '';
  return /\.[^.\\/]+$/.test(s) ? s.replace(/\.[^.\\/]+$/, '.lrc') : `${s}.lrc`;
}

/**
 * 歌单数组（prefs.userPlaylists）：命中旧路径的歌曲换成新路径。
 * 不改入参 —— 渲染层此刻可能还持有同一批对象的引用，就地改会造出"看不见的联动"。
 */
function relinkPlaylists(playlists, oldPath, newPath) {
  if (playlists == null) return { playlists: [], changed: 0 };
  if (!Array.isArray(playlists)) return { playlists, changed: 0 };
  let changed = 0;
  const out = playlists.map((pl) => {
    if (!pl || typeof pl !== 'object') return pl;
    if (!Array.isArray(pl.songs)) return { ...pl };
    let touched = false;
    const songs = pl.songs.map((s) => {
      if (s && typeof s === 'object' && pathsEqual(s.filePath, oldPath)) {
        touched = true;
        changed += 1;
        return { ...s, filePath: newPath };
      }
      return s;
    });
    return touched ? { ...pl, songs } : pl;
  });
  return { playlists: out, changed };
}

/** 播放进度记忆（键 = 本地歌的 filePath）：键搬家；新名下已有更晚的进度则不覆盖 */
function relinkProgressMap(map, oldPath, newPath) {
  const src = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  const out = {};
  let moved = null;
  for (const [k, v] of Object.entries(src)) {
    if (pathsEqual(k, oldPath)) { moved = v; continue; }
    out[k] = v;
  }
  if (!moved) return { map: out, changed: 0 };
  const hitKey = Object.keys(out).find(k => pathsEqual(k, newPath));
  const key = hitKey || newPath;
  const cur = hitKey ? out[hitKey] : null;
  const at = (e) => (e && Number(e.savedAt)) || 0;
  if (!cur || at(moved) > at(cur)) out[key] = moved;
  return { map: out, changed: 1 };
}

/** 最近播放（prefs.recentlyPlayed 存的是 JSON 串，不是对象）：串进串出 */
function relinkRecent(raw, oldPath, newPath) {
  if (typeof raw !== 'string' || !raw) return { value: raw, changed: 0 };
  let arr = null;
  try { arr = JSON.parse(raw); } catch (_e) { return { value: raw, changed: 0 }; }
  if (!Array.isArray(arr)) return { value: raw, changed: 0 };
  let changed = 0;
  const out = arr.map((s) => {
    if (s && typeof s === 'object' && pathsEqual(s.filePath, oldPath)) {
      changed += 1;
      return { ...s, filePath: newPath };
    }
    return s;
  });
  return { value: changed ? JSON.stringify(out) : raw, changed };
}

module.exports = { pathsEqual, canonPath, sidecarPathFor, relinkPlaylists, relinkProgressMap, relinkRecent };
