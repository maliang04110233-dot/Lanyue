/**
 * AI 音乐生成 IPC 处理器
 *
 * 注册：ai-generate-lyrics / ai-generate-music /
 *      ai-history / ai-clear-history
 */

const { handle } = require('./register');
const { app } = require('electron');
const path = require('path');
const aiMusic = require('../../api/ai-music');
const { defaultDownloadDir, AI_SUBDIR_NAME } = require('../../shared/downloadDefaults');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');
const { sidecarPathFor } = require('../../utils/relinkRefs');

/**
 * 根据歌词内容和歌曲时长，生成带时间轴的 LRC 文件
 *
 * @param {string} lyrics - 歌词文本
 * @param {string} title - 歌曲标题
 * @param {number} durationMs - 歌曲时长（毫秒）
 * @returns {string} LRC 格式歌词
 */
function generateLrcWithTiming(lyrics, title, durationMs) {
  const durationSec = durationMs / 1000;

  // 解析歌词结构
  const lines = lyrics.split('\n');
  const sections = []; // { tag, lines: [] }
  let currentSection = { tag: '', lines: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 检测结构标签 [主歌] [副歌] 等
    const tagMatch = trimmed.match(/^\[(.+)\]$/);
    if (tagMatch) {
      if (currentSection.lines.length > 0 || currentSection.tag) {
        sections.push(currentSection);
      }
      currentSection = { tag: tagMatch[1], lines: [] };
    } else {
      currentSection.lines.push(trimmed);
    }
  }
  if (currentSection.lines.length > 0 || currentSection.tag) {
    sections.push(currentSection);
  }

  // 如果没有解析出结构，把所有行当作一个段落
  if (sections.length === 0) {
    sections.push({ tag: '', lines: lines.filter(l => l.trim()) });
  }

  // 计算总行数
  const totalLines = sections.reduce((sum, s) => sum + s.lines.length, 0);
  if (totalLines === 0) return `[ti:${title || 'AI创作'}]\n[00:00.00] 纯音乐`;

  // 计算每行的时间间隔
  const introTime = 3; // 前奏 3 秒
  const outroTime = 2; // 结尾 2 秒
  const availableTime = durationSec - introTime - outroTime;
  const timePerLine = Math.max(2, availableTime / totalLines); // 每行至少 2 秒

  // 生成 LRC 内容
  let lrcContent = `[ti:${title || 'AI创作'}]\n`;
  lrcContent += `[ar:AI创作]\n`;
  lrcContent += `[al:${title || 'AI创作'}]\n`;
  lrcContent += `[by:MusicDL]\n\n`;

  let currentTime = introTime;

  for (const section of sections) {
    // 添加段落标签
    if (section.tag) {
      const tagMap = {
        '前奏': 'Intro', '主歌': 'Verse', '副歌': 'Chorus',
        '间奏': 'Interlude', '桥段': 'Bridge', '结尾': 'Outro',
        '导歌': 'Pre-Chorus', '尾奏': 'Outro',
      };
      // ★ 处理带数字的标签（如"主歌1"→"Verse 1"）
      const numMatch = section.tag.match(/^(.+?)(\d+)$/);
      const baseTag = numMatch ? numMatch[1] : section.tag;
      const numSuffix = numMatch ? ' ' + numMatch[2] : '';
      const engTag = (tagMap[baseTag] || baseTag) + numSuffix;
      lrcContent += `[${formatTime(currentTime)}] ${engTag}\n`;
    }

    // 添加歌词行
    for (const line of section.lines) {
      lrcContent += `[${formatTime(currentTime)}] ${line}\n`;
      currentTime += timePerLine;
    }

    // 段落之间添加短暂间隔
    currentTime += 0.5;
  }

  return lrcContent;
}

/**
 * 格式化时间为 LRC 格式 (mm:ss.xx)
 */
function formatTime(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function register() {
  // 初始化历史存储路径
  aiMusic.setHistoryPath(app.getPath('userData'));

  // 生成歌词
  handle('ai-generate-lyrics', async (_, params) => {
    try {
      return await aiMusic.generateLyrics(params);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 生成音乐（同步返回 hex 数据）
  // M11：生成期间持有 AbortController，渲染层经 ai-cancel-generation 真取消
  // （此前取消只改 UI 状态，底层计费请求照跑）
  //
  // 一个 requestId 可能对应**多个并发版本**（一句话直出默认出 2 版，渲染层
  // 一次 Promise.allSettled 打两发），共用一个 controller：点一次取消 = 整批
  // 都停。所以登记里带在途计数 —— 谁先跑完谁就 delete 的话，剩下那一版
  // 就再也取消不掉，计费请求继续烧（取消链路又断在同一个地方）。
  const _aiGenControllers = new Map(); // requestId → { ctrl, pending }

  handle('ai-cancel-generation', (_, requestId) => {
    const entry = _aiGenControllers.get(String(requestId));
    if (!entry) return { cancelled: false };
    entry.ctrl.abort();
    _aiGenControllers.delete(String(requestId));
    return { cancelled: true };
  });

  handle('ai-generate-music', async (_, params) => {
    const requestId = params && params.requestId ? String(params.requestId) : '';
    let entry = requestId ? _aiGenControllers.get(requestId) : null;
    if (requestId && !entry) {
      entry = { ctrl: new AbortController(), pending: 0 };
      _aiGenControllers.set(requestId, entry);
    }
    if (entry) entry.pending++;
    try {
      const result = await aiMusic.generateMusic(params, { signal: entry ? entry.ctrl.signal : undefined });

      // 如果生成成功，保存为文件
      if (result.audioHex) {
        // H10: Validate saveDir — must be within allowed directories
        // 用 path.relative 判定（startsWith 有前缀碰撞：C:\MusicX 会误判在 C:\Music 内）
        const isInside = (base, target) => {
          const rel = path.relative(base, target);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        };
        const allowedBaseDirs = [
          path.resolve(defaultDownloadDir(app.getPath('music'))),
          path.resolve(app.getPath('userData')),
        ];
        let saveDir = params.saveDir
          ? path.resolve(params.saveDir)
          : path.join(defaultDownloadDir(app.getPath('music')), AI_SUBDIR_NAME);
        const isAllowed = allowedBaseDirs.some(base => isInside(base, saveDir));
        if (!isAllowed) {
          saveDir = path.join(defaultDownloadDir(app.getPath('music')), AI_SUBDIR_NAME);
        }
        await fsa.ensureDir(saveDir);

        const safeName = (params.title || 'AI创作').replace(/[\\/:*?"<>|]/g, '_');
        const savePath = path.join(saveDir, `${safeName}_${Date.now()}.mp3`);

        await aiMusic.saveAudioFromHex(result.audioHex, savePath);

        // 保存歌词到同目录 .lrc 文件
        if (params.lyrics) {
          const lrcPath = sidecarPathFor(savePath);
          const durationMs = result.duration || 180000; // 默认 3 分钟
          const lrcContent = generateLrcWithTiming(params.lyrics, params.title, durationMs);
          await fsa.writeText(lrcPath, lrcContent);
        }

        result.filePath = savePath;
      }

      return result;
    } catch (e) {
      return { error: e.message };
    } finally {
      // 最后一个在途版本走完才摘登记：摘早了会让仍在计费的那一版取消不掉
      if (entry) {
        entry.pending--;
        if (entry.pending <= 0) _aiGenControllers.delete(requestId);
      }
    }
  });

  // 获取生成历史
  handle('ai-history', async () => {
    try {
      return await aiMusic.loadHistory();
    } catch (e) {
      return { error: e.message };
    }
  });

  // 添加到历史
  handle('ai-add-history', async (_, item) => {
    try {
      return await aiMusic.addToHistory(item);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 清空历史
  handle('ai-clear-history', async () => {
    try {
      aiMusic.clearHistory();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  // 歌词翻译
  handle('ai-translate-lyrics', async (_, params) => {
    try {
      return await aiMusic.translateLyrics(params);
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { register };
