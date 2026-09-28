/**
 * 本地音乐库 IPC
 *
 * 注册：scan-local-library / read-local-metadata / read-local-lrc /
 *      update-id3-tags / update-id3-cover
 */

const { handle } = require('./register');
const path = require('path');
const { app } = require('electron');
const {
  scanDirectory,
  readAudioMetadata,
  writeAudioMetadata,
  writeAudioCover,
  readEmbeddedLyrics,
} = require('../../utils/localLibrary');
const { incrementalScan, loadIndex } = require('../../utils/libraryIndex');
const { fetchOnlineCover } = require('../../utils/onlineCover');
const logger = require('../../utils/logger');
const { scheduleOnlineLrcFetch } = require('../../utils/onlineLrc');
const { safeSend } = require('../context');
const prefs = require('../../utils/prefs');
const approvedDirs = require('../approvedDirs');
const { convertAudioFile, normalizeFormat, formatExtension, normalizeClip, clipNameSuffix } = require('../../utils/audioConvert');
const { bucketBySize, slicePlan, groupByHash, dupGroupView, wastedBytes } = require('../../utils/dupScan');
const { relinkFileRefs, reconcileScannedRefs } = require('../../utils/fileRelink');
const { sidecarPathFor } = require('../../utils/relinkRefs');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../utils/fsAsync');

// 转码中止标志：cancel-convert-audio 置位，convert-audio 每次开始前复位
let _cancelRequested = false;

// ── C9: 路径沙箱 ───────────────────────────────────────────
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
    bases.push(app.getPath('music'));
    return approvedDirs.isInsideRealAny(bases, resolved);
  } catch { return false; }
}

function register() {
  // 扫描本地目录（增量扫描：缓存索引 + 只处理变更文件）
  handle('scan-local-library', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', songs: [] };
      // C1: 未批准/未配置目录不可枚举（原实现可扫全盘任意目录）
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', songs: [] };
      if (!await fsa.exists(dirPath)) return { error: '目录不存在', songs: [] };

      // 扫描成功即（重新）武装目录监听：用户换目录后 watcher 自动跟随
      try {
        const { setLibraryWatchDir } = require('../context').getCtx();
        if (typeof setLibraryWatchDir === 'function') setLibraryWatchDir(dirPath);
      } catch (_e) { /* watcher 未就绪不影响扫描 */ }

      // 尝试增量扫描（不再推扫描进度：渲染层无人订阅该事件，通道已随空发一并清理；
      // 扫描期间本地页有 _scanRunning 防重入）
      const result = await incrementalScan(
        dirPath,
        scanDirectory,
        readAudioMetadata,
      );

      // 用户在 app 外面改过文件名时，下载历史指向的旧路径已经失联。
      // 刚扫到的文件清单就是磁盘真相，拿它对账一次并接回（失败不影响扫描本身）。
      let relinked = { fixed: 0, ambiguous: 0 };
      try {
        relinked = await reconcileScannedRefs(result.songs);
      } catch (e) {
        logger.warn('[scan-local-library] 外部改名对账失败:', e.message);
      }

      return { songs: result.songs, count: result.songs.length, incremental: true, relinked };
    } catch (e) {
      logger.warn('[Library] 增量扫描失败，回退全量扫描:', e.message);

      // 回退到全量扫描
      try {
        const filePaths = await scanDirectory(dirPath);
        const songs = [];
        const BATCH = 20;
        for (let i = 0; i < filePaths.length; i += BATCH) {
          const batch = filePaths.slice(i, i + BATCH);
          const metas = await Promise.allSettled(batch.map(fp => readAudioMetadata(fp)));
          for (const r of metas) {
            if (r.status === 'fulfilled') songs.push(r.value);
            else logger.warn('读取元数据失败:', r.reason?.message);
          }
          await new Promise(r => setImmediate(r));
        }
        // 回退路径同样对账：漏了它等于"只有增量扫描才修得好"，那是半残功能
        let relinked = { fixed: 0, ambiguous: 0 };
        try {
          relinked = await reconcileScannedRefs(songs);
        } catch (e) {
          logger.warn('[Library] 外部改名对账失败:', e.message);
        }
        return { songs, count: songs.length, incremental: false, relinked };
      } catch (e2) {
        return { error: e2.message, songs: [] };
      }
    }
  });

  // 读取缓存索引（启动时秒加载）
  handle('load-library-index', async () => {
    try {
      const index = await loadIndex();
      return { songs: index.songs || [], dirPath: index.dirPath, lastScan: index.lastScan };
    } catch (e) {
      return { songs: [], dirPath: '', lastScan: 0 };
    }
  });

  // 读取单首歌曲元数据
  handle('read-local-metadata', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      return await readAudioMetadata(filePath);
    } catch (e) {
      return { error: e.message };
    }
  });

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
        await scheduleOnlineLrcFetch(s.filePath, { readAudioMetadata, getLyrics: require('../../api').getLyrics });
        results.push({ filePath: s.filePath, ok: true });
      } catch (e) {
        results.push({ filePath: s.filePath, ok: false, error: e.message });
      }
    }
    return results;
  });

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

  // ── 多格式转码 ──────────────────────────────────────────
  // ffmpeg 定位/参数拼装/进度/中止都在 utils/audioConvert.js，这里只做沙箱校验、
  // 把进度经 safeSend 回推渲染层，以及「未指定输出目录时弹保存对话框」这一处
  // 需要 electron 的分支。
  // 注意：IPC 走 structured clone，函数无法跨进程传递——进度与中止不能从
  // params 带进来，必须由主进程自己构造闭包。
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

  // 内容级查重：字节哈希（大小分桶 → 头尾切片 hash → 同哈希成组）
  // 与渲染层按「标题+歌手」的元数据查重互补，抓改名/换目录的同内容副本
  handle('find-content-duplicates', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', groups: [] };
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', groups: [] };
      if (!await fsa.exists(dirPath)) return { error: '目录不存在', groups: [] };

      const filePaths = await scanDirectory(dirPath);
      const sized = [];
      const BATCH = 50;
      for (let i = 0; i < filePaths.length; i += BATCH) {
        const chunk = filePaths.slice(i, i + BATCH);
        const stats = await Promise.all(chunk.map(fp => fsa.statOrNull(fp)));
        chunk.forEach((fp, j) => {
          const st = stats[j];
          if (st && typeof st.size === 'number' && st.size > 0 && (!st.isFile || st.isFile())) {
            sized.push({ filePath: fp, fileSize: st.size });
          }
        });
        await new Promise(r => setImmediate(r));
      }

      // 极端大库守护：候选文件哈希量封顶（分桶后仍是同大小者才进候选）
      const hashed = [];
      let budget = 5000;
      for (const bucket of bucketBySize(sized)) {
        for (const f of bucket) {
          if (budget-- <= 0) break;
          const hash = await _hashFileSlices(f.filePath, f.fileSize);
          if (!hash) continue;
          hashed.push({ ...f, hash });
        }
        await new Promise(r => setImmediate(r));
      }

      const dupGroups = groupByHash(hashed);
      return {
        groups: dupGroups.map(dupGroupView),
        wasted: wastedBytes(dupGroups),
        scanned: filePaths.length,
      };
    } catch (e) {
      logger.warn('[find-content-duplicates] 失败:', e.message);
      return { error: e.message, groups: [] };
    }
  });

  // 伪无损检测：ffprobe 实测真实编码/码率（与转码同款路径沙箱）
  handle('probe-audio', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      const { probeAudioFile } = require('../../utils/audioProbe');
      return await probeAudioFile(filePath);
    } catch (e) {
      logger.warn('[probe-audio] 检测失败:', e && e.message);
      return { error: e.message };
    }
  });
}

// ─── 内容查重：单文件头尾切片哈希（size 进哈希摘要防切片碰撞误判） ───
async function _hashFileSlices(filePath, size) {
  const crypto = require('crypto');
  let fh;
  try {
    fh = await fsa.fsp.open(filePath, 'r');
    const h = crypto.createHash('sha256');
    h.update(String(size));
    for (const r of slicePlan(size)) {
      const buf = Buffer.alloc(r.end - r.start);
      await fh.read(buf, 0, buf.length, r.start);
      h.update(buf);
    }
    return h.digest('hex');
  } catch {
    return null; // 占用中/无权限的文件跳过而不是让整次查重失败
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
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

module.exports = { register };

