/**
 * 本地音乐库 IPC · 组装根
 *
 * ⚠️ 本文件只负责把各域模块的 register 串起来；handler 实现按域拆在同目录：
 *   sandbox.js   —— 路径沙箱守卫（isValidPath / isInAllowedDir，各域共用）
 *   scan.js      —— 扫描与索引（scan-local-library / load-library-index）
 *   metadata.js  —— 元数据/标签（read-local-metadata / update-id3-* / fetch-online-cover）
 *   lyrics.js    —— 歌词（read-local-lrc / write-local-lrc / batch-fetch-lyrics）
 *   files.js     —— 文件操作（delete-file / rename-file）
 *   convert.js   —— 转码（convert-audio / cancel-convert-audio）
 *   dupScan.js   —— 查重/检测（find-content-duplicates / probe-audio）
 *
 * 拆分前这里是 380 行的 register()；测试中的文本钉（relink-refs /
 * reconcile-renames / ab-clip 等）已同步钉到各域文件。
 */

function register() {
  require('./library/scan')();
  require('./library/metadata')();
  require('./library/lyrics')();
  require('./library/files')();
  require('./library/convert')();
  require('./library/dupScan')();
}

module.exports = { register };
