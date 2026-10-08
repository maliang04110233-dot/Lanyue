/**
 * 电台候选生成（3-A，最小可用版）
 *
 * 目标
 * ----
 * 播放队列播完后不再停在「放完了」，而是顺着**同一歌手**的其他作品续播。
 * 先把「怎么挑下一首」这件事做成纯函数，UI/播放器只负责取数与播放。
 *
 * 为什么先做最小版
 * ----------------
 * 相似推荐（曲风/年代/向量）需要真实数据调优，且效果好坏无法用单测保证。
 * 「同歌手其他作品」这一条虽然朴素，但它确定性强、可测、且用户感知明确——
 * 听完周杰伦接着放周杰伦，是任何推荐系统都会做的第一步。
 * 语义相似可以在此基础上叠加，不影响本层的接口。
 *
 * 关键纪律
 * --------
 * 1. **不无限推同一首歌**：已播过的按 source+id 排除。
 * 2. **同歌手有冷却**：连着推 N 首同一歌手后要打散，否则电台听起来像复读。
 *    冷却只统计**电台自己加的**歌，不统计用户主动播放的——
 *    否则用户自己连播周杰伦会被误判成需要打散。
 * 3. **随机但可注入**：用 deps.random 注入随机源，单测可完全确定。
 * 4. **纯函数**：不碰 fs/IPC/网络（与 qualityPolicy、crossSourceAggregate 同一纪律）。
 */

// 默认冷却：连续这么多首同一歌手后，下一首强制换人
const DEFAULT_ARTIST_COOLDOWN = 3;
// 一次生成多少首（够播放器随手取，不必每次都去请求）
const DEFAULT_BATCH = 10;

// 归一化直接用 matchMusic 的实现 —— 那是仓库里被 8 个平台单测钉过的口径。
// 若这里自己写一套小写化，跟 crossSourceAggregate 的判定就会打架：
// 同一个「ADele / Adele」在电台算同一首、在聚合视图算两首。
const { normalizeName: _mn, normalizeArtists: _ma } = require('./matchMusic');

let normalizeName = _mn;
let normalizeArtists = _ma;

/**
 * 注入归一化实现（避免重复 require；测试可替换）
 * @param {Function} nameFn
 * @param {Function} artistsFn
 */
function setNormalizers(nameFn, artistsFn) {
  if (typeof nameFn === 'function') normalizeName = nameFn;
  if (typeof artistsFn === 'function') normalizeArtists = artistsFn;
}

/** 候选曲目是否可用（能播、有 id 与来源） */
function isPlayable(song) {
  return !!(song && song.title && song.id != null && song.id !== '' && song.source);
}

/** 跨源唯一键：同一首歌在不同平台算同一首，电台不该重复放 */
function trackKey(song) {
  if (!isPlayable(song)) return '';
  const t = normalizeName(song.title);
  const a = normalizeArtists(song.artist);
  return t + '␟' + a;
}

/** 歌手键（多人歌手取归一后整体，作为"同一个人"的判据） */
function artistKey(song) {
  return normalizeArtists(song && song.artist);
}

/**
 * 打散：把候选按"同歌手连续不超过 cooldown"重排
 *
 * 做法是贪心填充——每轮从剩余里挑一个"当前允许"且最靠前的候选，
 * 保证同样输入下结果稳定（不引入额外随机）。
 *
 * @param {Array} songs 候选（已过滤掉已播与不可播）
 * @param {number} cooldown 允许连续同歌手的上限
 * @returns {Array} 打散后的序列
 */
function diversifyByArtist(songs, cooldown) {
  // cooldown 语义 = 允许连续同歌手的最大条数。
  // limit 0 ⇒ 不许相邻同歌手（严格交替）；limit 2 ⇒ 最多连 2 首。
  const raw = Number(cooldown);
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_ARTIST_COOLDOWN;
  // curRun 最小值是 1（下界由 max(1, limit) 兜住），
  // 否则 limit=0 时 1 <= 0 恒假，冷却在最该生效的场景完全失效。
  const maxRun = Math.max(1, limit);

  const rest = songs.slice();
  const out = [];
  let run = 0;          // 当前歌手已连续出现的次数
  let lastArtist = '';

  while (rest.length) {
    let picked = -1;
    // 先找不违反冷却的（贪心取最靠前，保证结果稳定可复现）
    for (let i = 0; i < rest.length; i++) {
      const ak = artistKey(rest[i]);
      const curRun = ak === lastArtist ? run + 1 : 1;
      if (curRun <= maxRun) { picked = i; break; }
    }
    if (picked < 0) {
      // 所有候选都会让冷却超标 —— 说明可选池里几乎没有别的歌手了。
      // 此时**优先挑与上一首不同歌手的**（若存在），实在没有才取第一个，
      // 直接取 0 会把同歌手又接上，等于白打了散。
      const alt = rest.findIndex((x) => artistKey(x) !== lastArtist);
      picked = alt >= 0 ? alt : 0;
    }

    const [song] = rest.splice(picked, 1);
    const ak = artistKey(song);
    run = ak === lastArtist ? run + 1 : 1;
    lastArtist = ak;
    out.push(song);
  }
  return out;
}

/**
 * 生成电台候选
 *
 * @param {Object} seed 刚播完的曲目（电台的种子）
 * @param {Array} pool 可选池：同歌手的其他作品等（通常来自平台接口）
 * @param {Object} [opts]
 * @param {Set<string>|string[]} [opts.playedKeys] 已播过的 trackKey
 * @param {Array} [opts.recentRadioKeys] 电台最近加过的（用于冷却统计）
 * @param {number} [opts.artistCooldown] 同歌手连续上限
 * @param {number} [opts.batch] 生成数量
 * @param {Function} [opts.random] 注入随机源（同分时随机，默认 Math.random）
 * @returns {{songs:Array, stats:{pool:number, usable:number, afterPlayed:number}}}
 */
function generateRadioCandidates(seed, pool, opts) {
  // 默认参数只在传 undefined 时生效；显式传 null 很常见（IPC 往返），要自己兜住
  const o = (opts && typeof opts === 'object') ? opts : {};
  const stats = { pool: 0, usable: 0, afterPlayed: 0 };

  // 种子自身不可播 ⇒ 直接给空（上层据此不该切电台模式）
  if (!isPlayable(seed)) return { songs: [], stats: { ...stats, pool: Array.isArray(pool) ? pool.length : 0 } };

  const list = Array.isArray(pool) ? pool : [];
  stats.pool = list.length;

  // 1) 去掉不可播
  let usable = list.filter(isPlayable);
  // 2) 去掉种子自己（同一首歌不该紧跟着自己）
  const seedKey = trackKey(seed);
  usable = usable.filter((s) => trackKey(s) !== seedKey);
  stats.usable = usable.length;

  // 3) 去掉已播过（跨源同歌也算播过）
  const played = new Set(o.playedKeys || []);
  usable = usable.filter((s) => !played.has(trackKey(s)));
  stats.afterPlayed = usable.length;

  if (!usable.length) return { songs: [], stats };

  // 4) 同歌手优先：电台的核心是"顺着刚才那首的人继续"
  const seedArtist = artistKey(seed);
  const sameArtist = usable.filter((s) => artistKey(s) === seedArtist);
  const others = usable.filter((s) => artistKey(s) !== seedArtist);
  // 同歌手不足时用其他歌手补，保证批次是满的
  const combined = sameArtist.concat(others);

  // 5) 打散，避免连着推同一歌手
  const diversified = diversifyByArtist(combined, o.artistCooldown);

  // 6) 同分随机：既保持"同歌手优先"的大方向，又不至于每次都一样
  const rand = typeof o.random === 'function' ? o.random : Math.random;
  const batch = Number.isFinite(Number(o.batch)) && Number(o.batch) > 0
    ? Math.floor(Number(o.batch)) : DEFAULT_BATCH;
  const picked = diversified.slice(0, batch);
  if (picked.length > 1) {
    // 只在同一歌手段内部做小范围抖动：swap 相邻且同歌手的两首
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      if (artistKey(picked[i]) === artistKey(picked[j])) {
        const t = picked[i]; picked[i] = picked[j]; picked[j] = t;
      }
    }
  }

  return { songs: picked, stats };
}

/**
 * 电台是否该在队列耗尽时接管
 *
 * 保守优先：以下任一成立就**不**接管，让原有行为（停在放完）保持不变——
 *   · 开关关闭；
 *   · 正在单曲循环（用户明确要求重播这一首，别插队）；
 *   · 刚播完的这一首没有可用种子（拿不到元数据就别猜）。
 *
 * @param {Object} args
 * @returns {boolean}
 */
function shouldAutoContinue(args) {
  // 默认参数只挡 undefined；显式传 null（IPC 往返很常见）要自己兜住
  const a = (args && typeof args === 'object') ? args : {};
  if (!a.enabled) return false;
  if (Number(a.loopMode) === 2) return false; // 2 = 单曲循环
  if (!isPlayable(a.seed)) return false;
  return true;
}

module.exports = {
  DEFAULT_ARTIST_COOLDOWN,
  DEFAULT_BATCH,
  setNormalizers,
  isPlayable,
  trackKey,
  artistKey,
  diversifyByArtist,
  generateRadioCandidates,
  shouldAutoContinue,
};