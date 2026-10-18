/**
 * 本地音乐库 IPC · 元数据/标签域
 * 注册：read-local-metadata / update-id3-tags / update-id3-cover / fetch-online-cover
 */

const { handle } = require('../register');
const {
  readAudioMetadata,
  writeAudioMetadata,
  writeAudioCover,
} = require('../../../utils/localLibrary');
const { fetchOnlineCover } = require('../../../utils/onlineCover');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register() {
  // 读取单首歌曲元数据
  handle('read-local-metadata', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      return await readAudioMetadata(filePath);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 更新 ID3 标签（渲染层位置参数：api.updateId3Tags(filePath, tags)）
  handle('update-id3-tags', async (_, filePath, tags) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      return await writeAudioMetadata(filePath, tags);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 更新封面（渲染层位置参数：api.updateId3Cover(filePath, imageBase64)）
  handle('update-id3-cover', async (_, filePath, imageBase64) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
        return { success: false, error: '无效的封面数据' };
      }
      // writeAudioCover 期望 data URL 字符串（内部 split(',') 取 base64 段）；
      // 此前先解码成 Buffer 再传入，Buffer 没有 split，功能必然失败。
      return await writeAudioCover(filePath, imageBase64);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 在线拉取封面（渲染层位置参数：api.fetchOnlineCover(title, artist)）
  handle('fetch-online-cover', async (_, title, artist) => {
    try {
      const result = await fetchOnlineCover(title || '', artist || '');
      if (!result) return { success: false, error: '未找到匹配的封面' };
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = register;
