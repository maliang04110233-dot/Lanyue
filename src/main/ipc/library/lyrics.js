/**
 * 本地音乐库 IPC · 歌词域
 * 注册：read-local-lrc / write-local-lrc / batch-fetch-lyrics
 *
 * LRC 解码（_decodeLrcBuffer 等）保留在 main 进程：只有 main 读本地文件。
 */

const { handle } = require('../register');
const { readAudioMetadata, readEmbeddedLyrics } = require('../../../utils/localLibrary');
const { scheduleOnlineLrcFetch } = require('../../../utils/onlineLrc');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../../utils/fsAsync');
const { sidecarPathFor } = require('../../../utils/relinkRefs');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register() {
  // 读取本地 LRC 歌词
  handle('read-local-lrc', async (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { lrc: '', source: '' };
      if (!/\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(filePath)) return { lrc: '', source: '' };
      if (!isInAllowedDir(filePath)) return { lrc: '', error: '路径不可访问' };

      // 1) 同目录 .lrc 优先
      const lrcPath = sidecarPathFor(filePath);
      if (await fsa.exists(lrcPath)) {
        const stat = await fsa.statOrNull(lrcPath);
        if (stat && stat.size > 0 && stat.size <= 1024 * 1024) {
          const buf = await fsa.fsp.readFile(lrcPath);
          const text = _decodeLrcBuffer(buf);
          if (text && text.trim()) return { lrc: text, source: 'sidecar' };
        }
      }

      // 2) 音频内嵌
      try {
        const embedded = await readEmbeddedLyrics(filePath);
        if (embedded && embedded.trim()) {
          return { lrc: embedded, source: 'embedded' };
        }
      } catch (_e) { /* fallback to online */ }

      // 3) 在线拉
      scheduleOnlineLrcFetch(filePath);
      return { lrc: '', source: '', fetching: true };
    } catch (e) {
      return { lrc: '', error: e.message, source: '' };
    }
  });

  // 写入 LRC 歌词到同目录 sidecar 文件（渲染层位置参数：api.writeLocalLrc(filePath, lrc)）
  handle('write-local-lrc', async (_, filePath, lrc) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      const lrcPath = sidecarPathFor(filePath);
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(lrc, 'utf8');
      await fsa.fsp.writeFile(lrcPath, Buffer.concat([bom, body]));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 批量获取歌词（按 title/artist 搜索网易云，写入 sidecar）
  handle('batch-fetch-lyrics', async (_, songs) => {
    const results = [];
    for (const s of songs) {
      try {
        // C1: 该通道会在 filePath 旁写 .lrc sidecar —— 必须先过沙箱，
        // 否则等于绕过同文件其余 handler 的 C9 校验往任意路径写文件
        if (!s || !isValidPath(s.filePath) || !isInAllowedDir(s.filePath)) {
          results.push({ filePath: s && s.filePath, ok: false, error: '路径不可访问' });
          continue;
        }
        await scheduleOnlineLrcFetch(s.filePath, { readAudioMetadata, getLyrics: require('../../../api').getLyrics });
        results.push({ filePath: s.filePath, ok: true });
      } catch (e) {
        results.push({ filePath: s.filePath, ok: false, error: e.message });
      }
    }
    return results;
  });
}

// ─── LRC 解码（保留在 main 进程，因为只有 main 读本地文件） ─────────
function _decodeLrcBuffer(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xFE && buf[1] === 0xFF) return _swapBytes16(buf.slice(2)).toString('utf16le');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const utf8Text = buf.toString('utf8');
  if (!_hasReplacementChar(utf8Text)) return utf8Text;
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buf, 'gbk');
  } catch {
    // ★ 兜底：移除乱码替换字符 (U+FFFD)，至少保证不显示 �
    return utf8Text.replace(/[\uFFFD]+/g, '');
  }
}

function _hasReplacementChar(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xFFFD) return true;
  }
  return false;
}

function _swapBytes16(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

module.exports = register;
