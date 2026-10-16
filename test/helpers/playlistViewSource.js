/**
 * 播放列表视图源码读取助手
 *
 * 背景：views/playlist.js 约 1500 行单文件已拆分为 views/playlist/ 子目录，
 * 原文件退化为兼容层（import plState + 全部函数定义 + window 桥接）。
 *
 * 一批「源码守卫测试」保护的是「整个播放列表视图」这个语义，而不是
 * 某一个物理文件。拆文件后若每个测试各自去拼目录，改一次结构要改
 * 一打测试；统一从这里取全量源码，既让守卫继续有效，也不把测试焊死
 * 在文件布局上。
 *
 * 聚合顺序：兼容层在前、子模块按文件名排序在后。各测试的计数钉
 * （如 await askConfirm 处数）依赖这段聚合文本；顺序变化不影响计数，
 * 只要内容只出现一次即可——兼容层现在不重复任何逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const VIEW_DIR = path.join(ROOT, 'src', 'renderer', 'js', 'views');
const COMPAT_FILE = path.join(VIEW_DIR, 'playlist.js');
const PLAYLIST_DIR = path.join(VIEW_DIR, 'playlist');

/** 播放列表视图的全部物理文件绝对路径（兼容层在前，子模块按名排序在后） */
function playlistViewFiles() {
  const mods = fs.readdirSync(PLAYLIST_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(PLAYLIST_DIR, f));
  return [COMPAT_FILE, ...mods];
}

/** 相对仓库根的播放列表视图文件清单（POSIX 分隔符） */
function playlistViewRelFiles() {
  return playlistViewFiles().map((p) => path.relative(ROOT, p).replace(/\\/g, '/'));
}

/** 拼接播放列表视图全量源码（LF 归一化） */
function readPlaylistView() {
  return playlistViewFiles()
    .map((p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    .join('\n');
}

/** 判断一个路径（相对/绝对、任意分隔符）是否属于播放列表视图 */
function isPlaylistViewPath(p) {
  const norm = path.normalize(String(p)).replace(/\\/g, '/').toLowerCase();
  return /(^|\/)views\/playlist\.js$/.test(norm)
    || /(^|\/)views\/playlist\/[^/]+\.js$/.test(norm);
}

module.exports = {
  ROOT,
  PLAYLIST_DIR,
  playlistViewFiles,
  playlistViewRelFiles,
  readPlaylistView,
  isPlaylistViewPath,
};
