/**
 * 本地音乐库 IPC · 文件操作域
 * 注册：delete-file / rename-file
 */

const { handle } = require('../register');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../../utils/fsAsync');
const { relinkFileRefs } = require('../../../utils/fileRelink');
const logger = require('../../../utils/logger');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register() {
  // 删除文件（回收站或永久删除）
  handle('delete-file', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      if (!await fsa.exists(filePath)) {
        return { success: false, error: '文件不存在' };
      }
      const { shell } = require('electron');
      await shell.trashItem(filePath);
      return { success: true };
    } catch (e) {
      logger.warn('[delete-file] 删除失败:', e.message);
      return { success: false, error: e.message };
    }
  });

  // 重命名文件
  handle('rename-file', async (_, oldPath, newPath) => {
    try {
      if (!isValidPath(oldPath) || !isValidPath(newPath)) return { success: false, error: '非法路径' };
      if (!isInAllowedDir(oldPath) || !isInAllowedDir(newPath)) return { success: false, error: '路径不可访问' };
      // 先检查目标是否存在：Windows 上 rename 会直接覆盖，这步不能省
      if (!await fsa.exists(oldPath)) {
        return { success: false, error: '源文件不存在' };
      }
      if (await fsa.exists(newPath)) {
        return { success: false, error: '目标文件已存在' };
      }
      await fsa.fsp.rename(oldPath, newPath);
      // 名字一改，按路径记账的东西（历史/歌单/收藏/最近播放/进度/.lrc）会集体失联，
      // 善后必须在 rename 成功之后、且在返回之前做完
      let relink = null;
      try {
        relink = await relinkFileRefs(oldPath, newPath);
      } catch (e) {
        // 文件已经改成功了，回写失败不能报"重命名失败"（那会诱导用户再改一次）
        logger.warn('[rename-file] 路径引用回写失败:', e.message);
      }
      return { success: true, relink };
    } catch (e) {
      logger.warn('[rename-file] 重命名失败:', e.message);
      return { success: false, error: e.message };
    }
  });
}

module.exports = register;
