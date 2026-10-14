// 本模块跑在主进程（UI 线程），全部文件 IO 必须异步：禁止引入 fs.*Sync
const fsp = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.wma']);

// 元数据缓存：按 (mtimeMs + size) 失效，避免同一文件在多次扫描（初始/去重/增量）中重复解码 ID3。
// 上限 2000 条，超出清空重建，防止长时间运行内存膨胀。
const _metaCache = new Map();
const META_CACHE_MAX = 2000;

/**
 * 递归扫描目录，返回所有音频文件路径（异步，不阻塞 UI）
 *
 * 修复 P1-4：旧实现是同步递归 + 同步 statSync，5000+ 歌曲时会卡 UI 几秒
 *
 * @param {string} dirPath - 起始目录
 * @param {(progress: {scanned: number, currentDir: string}) => void} [onProgress] - 进度回调（每 50 个文件触发一次）
 * @returns {Promise<string[]>} 音频文件绝对路径数组
 */
async function scanDirectory(dirPath, onProgress) {
  const results = [];
  let scanned = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // 跳过无权限/不存在的目录
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTS.has(ext)) {
          results.push(fullPath);
        }
        scanned++;
        // 节流：每 50 个文件回调一次，避免 IPC 风暴
        if (onProgress && scanned % 50 === 0) {
          try { onProgress({ scanned, currentDir: dir }); } catch (_e) { /* 回调失败忽略 */ }
        }
      }
    }
  }

  await walk(dirPath);
  // 最后再回调一次（确保 < 50 个文件时也能收到）
  if (onProgress) {
    try { onProgress({ scanned, currentDir: dirPath, done: true }); } catch (_e) { /* 回调失败忽略 */ }
  }
  return results;
}

/**
 * 读取音频文件的元数据（封面 / 标签 / 嵌入歌词 / 真实时长）
 *
 * 修复本地播放无图无词：
 *   1. 主解析器换成 music-metadata（支持 MP3/FLAC/M4A/OGG/WAV 全格式）
 *   2. 失败时 node-id3 兜底（仅 MP3）— 兼容老旧/损坏 ID3
 *   3. 封面三重兜底：嵌入 → 同目录 cover.jpg/folder.jpg/front.jpg/AlbumArt* / 同名 → 留空
 *   4. 嵌入歌词（USLT / Vorbis LYRICS / MP4 ©lyr）合并返回 embeddedLyrics 字段
 *   5. 时长：music-metadata 真实解码时长，失败才走 estimateDuration
 */
async function readAudioMetadata(filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    logger.warn('[readAudioMetadata] stat failed:', e.message);
    return { title: '', artist: '', album: '', year: '', genre: '', coverBase64: null, embeddedLyrics: '', realDurationMs: null, bitrate: 0, size: 0, source: '', error: e.message };
  }
  // 缓存命中且文件未变更：直接返回，避免重复解码
  const key = `${filePath}::${stat.mtimeMs}::${stat.size}`;
  const cached = _metaCache.get(filePath);
  if (cached && cached._key === key) {
    return cached.meta;
  }

  const meta = await _decodeAudioMetadata(filePath, stat);
  if (_metaCache.size >= META_CACHE_MAX) _metaCache.clear();
  _metaCache.set(filePath, { _key: key, meta });
  return meta;
}

async function _decodeAudioMetadata(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath, ext);

  let title = '';
  let artist = '';
  let album = '';
  let year = '';
  let genre = '';
  let coverBase64 = null;
  let embeddedLyrics = '';
  let realDurationMs = null;
  let bitrate = 0;
  let source = '';

  // 1) music-metadata 主解析（支持所有常见格式）
  try {
    const mm = require('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const cm = meta.common || {};
    const fmt = meta.format || {};
    title = cm.title || '';
    artist = cm.artist || '';
    album = cm.album || '';
    year = String(cm.year || '');
    genre = Array.isArray(cm.genre) ? cm.genre.filter(Boolean).join(', ') : (cm.genre || '');
    if (fmt.duration) realDurationMs = Math.round(fmt.duration * 1000);
    if (fmt.bitrate) bitrate = fmt.bitrate;
    // 封面
    if (cm.picture && cm.picture.length > 0) {
      const pic = cm.picture[0];
      if (pic.data && pic.data.length > 0) {
        const data = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
        coverBase64 = `data:${pic.format};base64,${data.toString('base64')}`;
      }
    }
    // 嵌入歌词（ID3 USLT / Vorbis LYRICS / MP4 ©lyr）— 通常是纯文本（非时间同步）
    // 修复 B17：cm.lyrics 可能是 string[] 或 {text, language}[]，统一抽 text
    if (cm.lyrics && cm.lyrics.length > 0) {
      embeddedLyrics = cm.lyrics
        .filter(Boolean)
        .map(l => (typeof l === 'string') ? l : (l && l.text) ? l.text : '')
        .filter(Boolean)
        .join('\n');
    }
    source = 'music-metadata';
  } catch (e) {
    // 2) 兜底：node-id3（仅 MP3 — ID3v2.3/2.4 旧文件或 music-metadata 解析失败）
    if (ext === '.mp3') {
      try {
        const NodeID3 = require('node-id3');
        const raw = NodeID3.read(filePath) || {};
        title = raw.title || '';
        artist = raw.artist || '';
        album = raw.album || '';
        year = String(raw.year || raw.recordingTime || '');
        genre = raw.genre || '';
        if (raw.image) {
          const img = Array.isArray(raw.image) ? raw.image[0] : raw.image;
          if (img && img.imageBuffer) {
            const mime = img.mime || 'image/jpeg';
            coverBase64 = `data:${mime};base64,${img.imageBuffer.toString('base64')}`;
          }
        }
        // node-id3 还能从 rawTags.unsynchronisedLyrics 取 USLT 文本
        if (raw.unsynchronisedLyrics) {
          const uslt = raw.unsynchronisedLyrics;
          embeddedLyrics = (uslt && uslt.text) ? uslt.text : (typeof uslt === 'string' ? uslt : '');
        }
        source = 'node-id3';
      } catch (e2) {
        // 全部失败：往下走文件名兜底
      }
    }
  }

  // 3) 文件夹封面兜底（cover.jpg / folder.jpg / front.jpg / AlbumArt 前缀 / 同名）
  if (!coverBase64) {
    const folderCover = await _findFolderCover(filePath, fileName);
    if (folderCover) {
      try {
        const buf = await fsp.readFile(folderCover);
        const mime = _guessMimeFromBuffer(buf);
        coverBase64 = `data:${mime};base64,${buf.toString('base64')}`;
      } catch (_e) { /* 封面读取失败使用默认 */ }
    }
  }

  // 4) 文件名兜底
  // 「标题到底来自标签还是文件名」必须在这一步之前定型：后面的在线封面兜底
  // 只能认标签里的标题（见第 6 步），而文件名兜底会把 title 填成猜测值。
  const titleFromTag = Boolean(title);
  if (!title && !artist) {
    const parsed = parseFilename(fileName);
    title = parsed.title;
    artist = parsed.artist;
  }
  if (!title) title = fileName;

  // 5) 时长：真实优先，否则估算
  const durationMs = realDurationMs || estimateDuration(filePath, ext, stat.size);

  // 6) 最后兑底：在线拉取封面（仅当 title 来自标签时才尝试）
  // 修复 B16：避免文件名 fallback 出来的"未知 - 01.mp3"产生错误匹配
  // 判据是 titleFromTag（标题的来源），不是 source（跑过哪个解析器）——
  // music-metadata 能打开文件却读不出标签时 source 仍是 'music-metadata'，
  // 那时标题是文件名猜的，照旧出网等于拿猜测值去搜真人真歌。
  if (!coverBase64 && titleFromTag) {
    try {
      const { fetchOnlineCover } = require('./onlineCover');
      const online = await fetchOnlineCover(title, artist);
      if (online && online.coverBase64) {
        coverBase64 = online.coverBase64;
        source = 'qq-online';  // 调试用
      }
    } catch (e) {
      // 静默：在线拉取失败不阻塞主流程
    }
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    ext,
    title,
    artist,
    album,
    year,
    genre,
    cover: coverBase64,
    embeddedLyrics: embeddedLyrics || undefined,
    durationMs,
    bitrate: bitrate || undefined,
    fileSize: stat.size,
    // 文件修改时间：下载落盘 ≈ 入库存档时间，「最近添加」排序用。
    // 全量扫描路径由此带出；增量路径（libraryIndex）另有一次 stat 注入，两者同口径。
    mtime: stat.mtimeMs,
    _source: source, // 调试用：哪个解析器拿到数据
  };
}

/**
 * 写入 ID3 标签（MP3 用 node-id3，M4A/FLAC 用 Python mutagen）
 */
async function writeAudioMetadata(filePath, { title, artist, album, year, genre } = {}) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') {
      const NodeID3 = require('node-id3');
      const tags = {};
      if (title !== undefined) tags.title = title;
      if (artist !== undefined) tags.artist = artist;
      if (album !== undefined) tags.album = album;
      if (year !== undefined) tags.year = String(year);
      if (genre !== undefined) tags.genre = genre;
      const result = NodeID3.update(tags, filePath);
      return { success: result === true || result === null };
    } else {
      // M4A/FLAC/OGG: 用 Python mutagen
      const { embedTagsWithPython } = require('./downloader');
      const ok = await embedTagsWithPython(filePath, { title, artist, album });
      return { success: ok };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 写入封面图片
 */
async function writeAudioCover(filePath, imageBase64) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') {
      const NodeID3 = require('node-id3');
      const buffer = Buffer.from(imageBase64.split(',')[1] || imageBase64, 'base64');
      const mime = guessMime(buffer);
      const tags = {
        image: { mime, type: { id: 3, name: 'front cover' }, description: 'Album Cover', imageBuffer: buffer },
      };
      const result = NodeID3.update(tags, filePath);
      return { success: result === true || result === null };
    } else {
      // M4A/FLAC: 用 Python mutagen
      const { embedTagsWithPython } = require('./downloader');
      const tmpPath = filePath + '.cover.tmp';
      const raw = Buffer.from(imageBase64.split(',')[1] || imageBase64, 'base64');
      await fsp.writeFile(tmpPath, raw);
      try {
        const ok = await embedTagsWithPython(filePath, { cover_path: tmpPath });
        return { success: ok };
      } finally {
        try { await fsp.unlink(tmpPath); } catch (_e) { /* 清理失败忽略 */ }
      }
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 从文件名推断艺术家和标题
 *
 * 算法：优先用 " - " 切；否则用"最后一个" - 或 _ 切。比"第一个分隔符"更鲁棒
 *
 * 鲁棒性测试：
 *   "AC-DC - Back In Black"       → { artist: "AC-DC",   title: "Back In Black" }
 *   "陈奕迅 - 浮夸"                 → { artist: "陈奕迅",  title: "浮夸" }
 *   "周杰伦 - 晴天 - 伴奏"          → { artist: "周杰伦",  title: "晴天 - 伴奏" }
 *   "Taylor_Swift - Blank_Space"   → { artist: "Taylor_Swift", title: "Blank_Space" }
 *   "纯数字命名.mp3"                → { artist: "", title: "纯数字命名" }
 */
function parseFilename(name) {
  // 优先匹配 " - "（带空格的连字符，最常见）
  const spaced = name.match(/^(.+?)\s+-\s+(.+)$/);
  if (spaced) {
    return { artist: spaced[1].trim(), title: spaced[2].trim() };
  }
  // 退而求其次：最后一个 - 或 _ 分割（仅切一次）
  const lastSep = name.search(/[-_](?!.*[-_])/);
  if (lastSep > 0) {
    return { artist: name.slice(0, lastSep).trim(), title: name.slice(lastSep + 1).trim() };
  }
  return { artist: '', title: name };
}

/**
 * 粗略估算音频时长（毫秒）
 */
function estimateDuration(filePath, ext, fileSize) {
  // 简单按比特率估算
  const bitrateMap = {
    '.mp3': 192000,   // 192kbps avg
    '.flac': 800000,  // ~800kbps avg
    '.m4a': 256000,
    '.ogg': 192000,
    '.wav': 1411000,  // CD quality
    '.wma': 192000,
  };
  const bitrate = bitrateMap[ext] || 192000;
  return Math.round((fileSize * 8) / bitrate * 1000);
}

function guessMime(buffer) {
  if (!buffer || buffer.length < 4) return 'image/jpeg';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg';
}

// 向后兼容别名
const _guessMimeFromBuffer = guessMime;

/**
 * 在音频文件同目录查找封面图片
 * 候选顺序：cover.{jpg,png} → folder → front → Cover/Folder → 同名 → AlbumArt*
 *
 * 性能：旧实现对 22 个候选逐个 existsSync + statSync（每首歌最多 22 次同步
 * 磁盘调用，且它在「无内嵌封面」时必然执行），扫整库时叠加成明显卡顿。
 * 现在改为一次 readdir 拿到目录清单后在内存比对——1 次异步调用替代最多 23 次同步。
 * 比对走小写名映射，保留 Windows/macOS 大小写不敏感文件系统下
 * 「cover.jpg 命中 Cover.JPG」的既有行为。
 *
 * @param {string} audioPath - 音频文件路径
 * @param {string} baseName - 音频文件名（不含扩展名），用于「同名封面」
 * @returns {Promise<string|null>} 封面绝对路径
 */
async function _findFolderCover(audioPath, baseName) {
  let dir;
  try { dir = path.dirname(audioPath); } catch { return null; }

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    return null; // 目录不存在 / 无权限
  }
  const files = new Map();
  for (const e of entries) {
    if (e.isFile()) files.set(e.name.toLowerCase(), e.name);
  }

  const candidates = [
    'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
    'folder.jpg', 'folder.jpeg', 'folder.png', 'folder.webp',
    'front.jpg', 'front.jpeg', 'front.png', 'front.webp',
    'Cover.jpg', 'Cover.png',
    'Folder.jpg', 'Folder.png',
    'Front.jpg', 'Front.png',
    // 同名（"歌名.mp3" → "歌名.jpg"）
    `${baseName}.jpg`, `${baseName}.jpeg`, `${baseName}.png`, `${baseName}.webp`,
  ];
  for (const c of candidates) {
    const hit = files.get(c.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  // AlbumArt* 通配（Windows 兼容：用 readdir 替代 glob）
  for (const [lower, original] of files) {
    if (/^albumart.*\.(jpe?g|png|webp)$/.test(lower)) return path.join(dir, original);
  }
  return null;
}

/**
 * 从音频文件读取嵌入歌词（USLT / LYRICS / ©lyr）
 * 给主进程 IPC `read-local-lrc` 调用：sidecar 不存在时兜底
 * - 纯文本歌词（无时间标签）直接返回
 * - 如果文本含 [mm:ss] 标签，会被 renderer 的 parseLrc 识别为同步歌词
 */
async function readEmbeddedLyrics(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    // 1) music-metadata（支持所有格式）
    try {
      const mm = require('music-metadata');
      const meta = await mm.parseFile(filePath, { skipCovers: true });
      if (meta.common.lyrics && meta.common.lyrics.length > 0) {
        // 修复 B17：兼容 string[] 和 {text, language}[]
        return meta.common.lyrics
          .filter(Boolean)
          .map(l => (typeof l === 'string') ? l : (l && l.text) ? l.text : '')
          .filter(Boolean)
          .join('\n');
      }
    } catch (_e) { /* fallback to node-id3 */ }
    // 2) node-id3 兜底（仅 MP3）
    if (ext === '.mp3') {
      try {
        const NodeID3 = require('node-id3');
        const raw = NodeID3.read(filePath) || {};
        if (raw.unsynchronisedLyrics) {
          const uslt = raw.unsynchronisedLyrics;
          return (uslt && uslt.text) ? uslt.text : (typeof uslt === 'string' ? uslt : '');
        }
      } catch (_e) { /* fallback empty */ }
    }
  } catch (_e) { /* fallback empty */ }
  return '';
}

module.exports = {
  scanDirectory,
  readAudioMetadata,
  writeAudioMetadata,
  writeAudioCover,
  readEmbeddedLyrics,
  parseFilename,         // 修复 B29：暴露给测试和外部调用
  estimateDuration,
  guessMime,
  AUDIO_EXTS,
  _findFolderCover,    // 暴露给测试
  _guessMimeFromBuffer,
  clearMetaCache,
};

// 清空元数据缓存（重新扫描/文件被外部修改后调用，确保不返回陈旧数据）
function clearMetaCache() {
  _metaCache.clear();
}
