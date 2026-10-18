/**
 * 本地音乐库 IPC · 路径沙箱（C1/C9）
 *
 * 所有会碰文件路径的 handler 的公共守卫。词法包含判定已下沉到
 * approvedDirs.isInside / isInsideReal（含前缀碰撞与符号链接两道防线），
 * 本文件只负责汇总允许的基目录集合。
 */

const path = require('path');
const prefs = require('../../../utils/prefs');
const approvedDirs = require('../../approvedDirs');

function isValidPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/^(file|https?|data|javascript|ftp|smb|ms-|mailto):/i.test(p)) return false;
  return true;
}

/**
 * 路径是否在允许目录内。
 *
 * 词法包含判定已下沉到 approvedDirs.isInside / isInsideReal（含前缀碰撞与
 * 符号链接两道防线），本函数只负责**汇总允许的基目录集合**：
 * 批准目录注册表 + 各目录型偏好 + 系统音乐目录。
 *
 * 为什么必须走真实路径复核（2026-09 审计 P1）：只做词法判定时，
 * `D:\Music\link` 指向 `C:\Windows` 后，`D:\Music\link\evil.dll`
 * 字符串上"在沙箱内"，实际读写落在沙箱外。
 */
function isInAllowedDir(filePath) {
  try {
    const resolved = path.resolve(filePath);
    // C1: 任何用户经原生选器批准过的目录（含子目录）同样在沙箱内
    if (approvedDirs.isApprovedDir(resolved)) return true;
    const bases = [];
    const localDir = prefs.get('localDirPath') || '';
    if (localDir) bases.push(localDir);
    const saveDir = prefs.get('saveDir') || '';
    if (saveDir) bases.push(saveDir);
    // P2-2（2026-10-13 复审）：这里曾无条件 push(app.getPath('music'))，
    // 于是即便 prefs 全空、用户从未批准过任何目录，%USERPROFILE%\Music 下的
    // **任意**路径仍可被 delete-file / write-local-lrc / update-id3-tags /
    // rename-file 等十几条通道读写 —— 而同仓库里 open-folder 与下载落盘用的
    // 都是严格版 isApprovedDir。这就是「两套口径」的最后一处实体。
    //
    // 现在不再单列系统音乐目录：默认下载目录（defaultDownloadDir(music)）在
    // index.js 启动时已 approve，且 get-default-dir 展示的也是它，所以第一行的
    // isApprovedDir 已覆盖「用户还没配任何目录」的首次使用场景 —— 无需额外开口子。
    return approvedDirs.isInsideRealAny(bases, resolved);
  } catch { return false; }
}

module.exports = { isValidPath, isInAllowedDir };
