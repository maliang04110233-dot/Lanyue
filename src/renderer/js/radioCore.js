/**
 * 电台候选判定（3-A，渲染层 ESM 版）
 *
 * 为什么渲染层有一份，而不是 import 主进程那份
 * --------------------------------------------
 * src/utils/radio.js 是 CommonJS（module.exports），而渲染层是 ESM。
 * rollup 无法从 CJS 里解析**具名**导出，vite build 会直接报
 *   "shouldAutoContinue" is not exported by "src/utils/radio.js"
 * 且 src/utils 下 34 个文件全是 CJS、渲染层从不 import 它们——
 * 渲染层与主进程共用的纯逻辑一律放在 src/renderer/js/ 下写成 ESM
 * （先例：sortCycle.js / pathLite.js / historySort.js）。
 *
 * 所以这里有一份 ESM 实现。主进程那份 CJS 保留（main 用 require）。
 * 两者行为必须一致，由 test/radio-esm-parity.test.js 钉住关键判据。
 *
 * 判定逻辑本身（去重 / 冷却 / 打散）与 CJS 版逐条对应，改一处必须同步另一处。
 */

// 归一化：与 matchMusic 同口径（跨源同歌判定要用它）。
// 注意：src/utils/matchMusic.js 也是 CJS，这里不能 import，
// 故内联一份与它等价的最小实现（normalizeName 逐条对应）。
/** 全角 ASCII → 半角；只留字母数字与 CJK；转小写 */
function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 多人歌手：拆分 → 归一 → 排序 → 重新拼接（顺序无关） */
function normalizeArtists(s) {
  return String(s ?? '')
    .split(/[/\\,&;\u3001\uFF0C\uFF1B]\s*/)
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

/** 默认冷却：连续这么多首同一歌手后，下一首强制换人 */
const DEFAULT_ARTIST_COOLDOWN = 3;
/** 一次生成多少首 */
const DEFAULT_BATCH = 10;

/** 候选是否可播（能播、有 id 与来源） */
function isPlayable(song) {
  return !!(song && song.title && song.id != null && song.id !== '' && song.source);
}

/** 跨源唯一键：同一首歌在不同平台算同一首 */
function trackKey(song) {
  if (!isPlayable(song)) return '';
  return normalizeName(song.title) + '\u241F' + normalizeArtists(song.artist);
}

/** 歌手键 */
function artistKey(song) {
  return normalizeArtists(song && song.artist);
}

/**
 * 打散：同歌手连续不超过 cooldown
 *
 * cooldown 语义 = 允许连续同歌手的最大条数。
 * 0 ⇒ 不许相邻同歌手（严格交替）；2 ⇒ 最多连 2 首。
 * curRun 最小值是 1，须用 max(1, limit) 兜住下界，
 * 否则 limit=0 时 1 <= 0 恒假，冷却在最该生效的场景完全失效。
 */
function diversifyByArtist(songs, cooldown) {
  const raw = Number(cooldown);
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_ARTIST_COOLDOWN;
  const maxRun = Math.max(1, limit);

  const rest = songs.slice();
  const out = [];
  let run = 0;
  let lastArtist = '';

  while (rest.length) {
    let picked = -1;
    for (let i = 0; i < rest.length; i++) {
      const ak = artistKey(rest[i]);
      const curRun = ak === lastArtist ? run + 1 : 1;
      if (curRun <= maxRun) { picked = i; break; }
    }
    if (picked < 0) {
      // 所有候选都会让冷却超标 ⇒ 池子里几乎没有别的歌手了。
      // 优先挑与上一首不同歌手的，直接取 0 会把同歌手又接上，等于白打了散。
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
 * @param {Object} seed 刚播完的曲目
 * @param {Array} pool 可选池（来自主进程 radioPool）
 * @param {Object} [opts] { playedKeys, artistCooldown, batch, random }
 */
function generateRadioCandidates(seed, pool, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const stats = { pool: 0, usable: 0, afterPlayed: 0 };

  if (!isPlayable(seed)) {
    return { songs: [], stats: { ...stats, pool: Array.isArray(pool) ? pool.length : 0 } };
  }

  const list = Array.isArray(pool) ? pool : [];
  stats.pool = list.length;

  let usable = list.filter(isPlayable);
  const seedKey = trackKey(seed);
  usable = usable.filter((x) => trackKey(x) !== seedKey);
  stats.usable = usable.length;

  const played = new Set(o.playedKeys || []);
  usable = usable.filter((x) => !played.has(trackKey(x)));
  stats.afterPlayed = usable.length;

  if (!usable.length) return { songs: [], stats };

  // 同歌手优先：电台的核心是"顺着刚才那首的人继续"
  const seedArtist = artistKey(seed);
  const sameArtist = usable.filter((x) => artistKey(x) === seedArtist);
  const others = usable.filter((x) => artistKey(x) !== seedArtist);
  const combined = sameArtist.concat(others);

  const diversified = diversifyByArtist(combined, o.artistCooldown);

  const rand = typeof o.random === 'function' ? o.random : Math.random;
  const batch = Number.isFinite(Number(o.batch)) && Number(o.batch) > 0
    ? Math.floor(Number(o.batch)) : DEFAULT_BATCH;
  const picked = diversified.slice(0, batch);
  if (picked.length > 1) {
    // 只在同一歌手段内部做小范围抖动
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
 * 是否该在队列耗尽时接管（保守优先）
 *
 * 任一不成立都**不**接管，保持「停在放完」：
 *   · 开关关闭；
 *   · 单曲循环（用户明确要求重播这一首，别插队）；
 *   · 种子不可播。
 */
function shouldAutoContinue(args) {
  const a = (args && typeof args === 'object') ? args : {};
  if (!a.enabled) return false;
  if (Number(a.loopMode) === 2) return false;
  if (!isPlayable(a.seed)) return false;
  return true;
}

export {
  DEFAULT_ARTIST_COOLDOWN,
  DEFAULT_BATCH,
  normalizeName,
  normalizeArtists,
  isPlayable,
  trackKey,
  artistKey,
  diversifyByArtist,
  generateRadioCandidates,
  shouldAutoContinue,
};
