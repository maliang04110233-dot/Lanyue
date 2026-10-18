/**
 * 本地音乐库 IPC · 转码域
 * 注册：convert-audio / cancel-convert-audio
 *
 * ffmpeg 定位/参数拼装/进度/中止都在 utils/audioConvert.js，这里只做沙箱校验、
 * 把进度经 safeSend 回推渲染层，以及「未指定输出目录时弹保存对话框」这一处
 * 需要 electron 的分支。
 * 注意：IPC 走 structured clone，函数无法跨进程传递——进度与中止不能从
 * params 带进来，必须由主进程自己构造闭包。
 */

const { handle } = require('../register');
const { safeSend } = require('../../context');
const path = require('path');
const {
  convertAudioFile,
  normalizeFormat,
  formatExtension,
  normalizeClip,
  clipNameSuffix,
} = require('../../../utils/audioConvert');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../../utils/fsAsync');
const prefs = require('../../../utils/prefs');
const approvedDirs = require('../../approvedDirs');
const { isValidPath, isInAllowedDir } = require('./sandbox');

// 转码中止标志：cancel-convert-audio 置位，convert-audio 每次开始前复位
let _cancelRequested = false;

function register() {
  // ── 多格式转码 ──────────────────────────────────────────
  handle('convert-audio', async (_, params) => {
    const { dialog, shell } = require('electron');

    try {
      const {
        inputPath,
        outputFormat = 'mp3',
        bitrate = '320k',
        outputDir = null,
        revealFolder = false,
        timeoutMs,
        start = null,
        end = null,
      } = params;

      if (!isValidPath(inputPath) || !isInAllowedDir(inputPath)) {
        return { error: '路径不可访问' };
      }
      if (!await fsa.exists(inputPath)) {
        return { error: '源文件不存在' };
      }
      if (!normalizeFormat(outputFormat)) {
        return { error: `不支持的格式: ${outputFormat}` };
      }
      if (outputDir && !isInAllowedDir(outputDir)) {
        return { error: '输出目录不可访问' };
      }
      // 传了任一端却合不成合法区间 = 调用方逻辑出错，宁可明确失败，
      // 也不能静默按全曲输出（用户以为截了 30 秒，结果拿到整首）
      const clip = (start != null || end != null) ? normalizeClip(start, end) : null;
      if ((start != null || end != null) && !clip) {
        return { error: '片段区间无效：终点须晚于起点' };
      }
      const nameSuffix = clip ? clipNameSuffix(clip.start, clip.end) : '';

      // 无输出目录 = 用户想自己挑保存位置，必须弹对话框；
      // 批量转换页总是传 outputDir，不会走到这里
      let resolvedOutputDir = outputDir;
      if (!resolvedOutputDir) {
        const ext = formatExtension(outputFormat);
        const defaultName = path.basename(inputPath, path.extname(inputPath)) + nameSuffix + '.' + ext;
        const result = await dialog.showSaveDialog({
          defaultPath: defaultName,
          filters: [
            { name: `${ext.toUpperCase()} 文件`, extensions: [ext] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (result.canceled) return { canceled: true };
        resolvedOutputDir = path.dirname(result.filePath);
        // 用户在原生保存对话框当场确认的目录 = 批准目录
        approvedDirs.approve(resolvedOutputDir);
      }

      _cancelRequested = false;
      const result = await convertAudioFile({
        inputPath,
        outputDir: resolvedOutputDir,
        format: outputFormat,
        bitrate,
        // 响度归一（P0-B）是全局转码偏好，在设置页勾选，不由调用方逐次传
        loudnorm: prefs.get('convertLoudnorm') === true,
        start: clip ? clip.start : null,
        end: clip ? clip.end : null,
        onProgress: (pct) => safeSend('convert-audio-progress', { path: inputPath, pct }),
        shouldStop: () => _cancelRequested,
        timeoutMs,
      });
      if (result.success && revealFolder) shell.showItemInFolder(result.path);
      return result;
    } catch (e) {
      return { error: e.message };
    }
  });

  // 中止当前正在进行的转码（渲染层点「取消」）
  handle('cancel-convert-audio', () => {
    _cancelRequested = true;
    return { success: true };
  });
}

module.exports = register;
