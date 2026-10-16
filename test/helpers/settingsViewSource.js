/**
 * 设置视图源码读取助手
 *
 * 背景：设置视图（原 src/renderer/js/views/settings.js，约 1600 行）已拆分为
 * settings/ 目录下的若干子模块，原文件退化为兼容层（只做 export *）。
 *
 * 一批「源码守卫测试」保护的是**整个设置视图**这个语义，而不是某一个物理文件。
 * 拆文件后若每个测试各自去拼目录，改一次结构要改一打测试；统一从这里取
 * 全量源码，既让守卫继续有效，也不把测试焊死在文件布局上。
 *
 * 注意：聚合顺序是「兼容层在前、子模块按文件名排序在后」。各测试的计数钉
 * （如 await askConfirm 处数）依赖这段聚合文本；顺序变化不影响计数，只要
 * 内容只出现一次即可 —— 兼容层现在只剩一行 export *，不重复任何逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const VIEW_DIR = path.join(ROOT, 'src', 'renderer', 'js', 'views');
const COMPAT_FILE = path.join(VIEW_DIR, 'settings.js');
const SETTINGS_DIR = path.join(VIEW_DIR, 'settings');

/** 设置视图的全部物理文件绝对路径（兼容层在前，子模块按名排序在后） */
function settingsViewFiles() {
  const mods = fs.readdirSync(SETTINGS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(SETTINGS_DIR, f));
  return [COMPAT_FILE, ...mods];
}

/** 相对仓库根的设置视图文件清单（用于数组式扫描，POSIX 分隔符） */
function settingsViewRelFiles() {
  return settingsViewFiles().map((p) => path.relative(ROOT, p).replace(/\\/g, '/'));
}

/** 拼接设置视图全量源码（LF 归一化） */
function readSettingsView() {
  return settingsViewFiles()
    .map((p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    .join('\n');
}

/** 判断一个路径（相对/绝对、任意分隔符）是否属于设置视图 */
function isSettingsViewPath(p) {
  const norm = path.normalize(String(p)).replace(/\\/g, '/').toLowerCase();
  return /(^|\/)views\/settings\.js$/.test(norm)
    || /(^|\/)views\/settings\/[^/]+\.js$/.test(norm);
}

module.exports = {
  ROOT,
  SETTINGS_DIR,
  settingsViewFiles,
  settingsViewRelFiles,
  readSettingsView,
  isSettingsViewPath,
};
