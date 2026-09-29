/**
 * 质量策略的「本地事实」来源（3-C already_have 规则的判据）
 *
 * 为什么单独一个模块
 * ------------------
 * downloadQueue 只接受**注入**的事实源（getPolicyFacts），因为求值器是纯函数。
 * 具体从哪里取"本地已有哪些歌手/专辑"属于主进程的知识，放这里：
 *   - downloadQueue 保持可单测（不 require electron / libraryIndex）；
 *   - 取数失败时本模块自己降级成空集合，调用方无需再包一层 try。
 *
 * 数据来源：utils/libraryIndex 的持久化索引（userData/library-index.json）。
 * 选它而不是现扫盘，有两个理由：
 *   1. 主进程跑在 UI 线程，扫盘会冻窗口（libraryIndex.js 开头有同样的告诫）；
 *   2. 索引已经在扫描时建好，策略求值只是读一次内存/文件。
 *
 * ⚠ 索引为空（用户从没扫过本地曲库）时**返回空集合**而不是报错：
 *   那样 already_have 自然不命中，规则退化为"不做限制"——这正是我们想要的。
 */

const logger = require('../utils/logger');
const libraryIndex = require('../utils/libraryIndex');

/** 归一：与 qualityPolicy._normNames 同口径（小写去首尾空白） */
function _normName(v) {
  return String(v || '').trim().toLowerCase();
}

/** 歌手字段可能是 "A / B" 或 "A、B" 形式，拆开才能逐个命中 */
/**
 * 歌手字段可能是 "A / B" 或 "A、B" 形式，拆开才能逐个命中。
 *
 * 只接受 string / number：String({}) === "[object Object]"、String(["a"]) === "a"，
 * 无条件 String() 会凭空造出一个「歌手名」，让任意歌曲都被误判成「本地已有」。
 */
function splitArtists(artist) {
  if (typeof artist !== 'string' || !artist.trim()) return [];
  return String(artist)
    .split(/[/\\,&;、，；]/)
    .map(_normName)
    .filter(Boolean)
}

/**
 * 取本地已有的歌手/专辑集合
 *
 * @param {Object} [opts]
 * @param {string} [opts.dirPath] 限定目录；不给则用索引里记录的目录
 * @returns {Promise<{haveArtist:Set<string>, haveAlbum:Set<string>, scanned:boolean}>}
 *   scanned=false 表示没拿到可用索引（未扫描过 / 读取失败），
 *   调用方应把规则当作"无判据"处理。
 */
async function loadLocalFacts(opts = {}) {
  let index;
  try {
    index = await libraryIndex.loadIndex();
  } catch (e) {
    logger.warn('[qualityPolicy] 读取本地索引失败，already_have 本次不参与:', e && e.message);
    return { haveArtist: new Set(), haveAlbum: new Set(), scanned: false };
  }

  const songs = Array.isArray(index && index.songs) ? index.songs : [];
  if (!songs.length) {
    // 没扫过或曲库为空：不是错误，只是没有判据
    return { haveArtist: new Set(), haveAlbum: new Set(), scanned: false };
  }

  // 目录变了就是另一份曲库，索引里的歌手/专辑对新目录无意义
  if (opts.dirPath && index.dirPath && opts.dirPath !== index.dirPath) {
    return { haveArtist: new Set(), haveAlbum: new Set(), scanned: false };
  }

  const haveArtist = new Set();
  const haveAlbum = new Set();
  for (const s of songs) {
    if (!s) continue;
    for (const a of splitArtists(s.artist)) haveArtist.add(a);
    const alb = _normName(s.album);
    if (alb) haveAlbum.add(alb);
  }

  return { haveArtist, haveAlbum, scanned: true };
}

/**
 * 适配成 downloadQueue 期望的 ctx 形状
 * （与 qualityPolicy.evaluateQualityPolicy 的 ctx 参数对应）
 */
async function getPolicyFactsForQueue() {
  const f = await loadLocalFacts();
  return { haveArtist: f.haveArtist, haveAlbum: f.haveAlbum };
}

module.exports = { loadLocalFacts, getPolicyFactsForQueue, splitArtists, _normName };
