/**
 * 跨源聚合去重层（3-B）
 *
 * 解决的问题
 * ----------
 * 8 个平台各自有歌单与收藏，用户想看「我所有收藏」得切 8 次。
 * 本模块把多份来源的曲目聚合成一份，并**标出**跨源同曲的重复项。
 *
 * 关键取舍：只标记，不删除
 * ----------------------
 * 跨源「同一首歌」有两种，混淆会造成严重误伤：
 *   · 同曲不同源   —— 该标记（网易云和 QQ 都有《晴天》）
 *   · 同名不同曲   —— **绝不能**标记（某翻唱版也叫《晴天》）
 * 二者只有时长与完整歌手可比，所以判定刻意收得很紧。
 *
 * 为什么不能直接拿 matchScore 当门槛（实测踩过的坑）
 * --------------------------------------------------
 * matchScore 的分档里有两支都返回 2，语义完全不同：
 *   (a) 歌名+歌手中、**时长不符**  → 伴奏 / 现场 / 变速，不是同一首
 *   (b) 一侧缺歌手、**时长符合**  → 判据不全，也不足以断言
 * 只看「score >= 2」会把上面两种都当成同曲，于是
 * 「晴天(伴奏 140s)」与「晴天(269s)」被并成一条——用户点下载拿到的是伴奏。
 * 因此本模块**不复用裸 matchScore 作门槛**，而是自己判：
 *   跨源同曲 ⇔ 歌名命中 且 歌手归一后相等 且 时长已知且在 5s 容差内
 * 三者缺一不可。这也顺带避免了 score 1（仅歌名命中）被误当成同曲。
 *
 * 与换源机制的关系
 * ----------------
 * 归一化（normalizeName / normalizeArtists）仍复用 matchMusic —— 那是仓库里
 * 唯一被 8 个平台单测钉过的名称归一实现。
 * 但**不**复用 findMatchedCandidates：它会发起网络搜索去别的源找这首歌，
 * 而聚合是对**已有数据**分组，不该在渲染过程中打网络。
 *
 * 纯函数：不碰 fs / IPC / prefs / 网络（与 qualityPolicy 同一纪律）。
 */

const { normalizeName, normalizeArtists } = require('./matchMusic');

/**
 * 时长容差：5 秒（毫秒）
 *
 * 全仓 duration 一律**毫秒**（qq/kugou 平台插件显式 * 1000，
 * netease 的 dt 原生即毫秒，fmtDuration(ms) 也除以 1000 展示）。
 * matchScore 里的 `Math.abs(a - b) <= 5000` 正是这个 5s 容差。
 */
const DURATION_TOLERANCE_MS = 5000;

/**
 * 跨源同曲判定
 *
 * 三个条件全部成立才算同曲（缺一即否）：
 *   1. 歌名归一后互相命中（含版本词剥离，如「七里香」vs「七里香 (Live)」）
 *   2. 两侧歌手都存在，且归一后完全相等（顺序无关，「周杰伦/费玉清」≡「费玉清/周杰伦」）
 *   3. 两侧时长都存在，且差值 ≤ 5s
 *
 * 条件 3 是与裸 matchScore 的关键差异：它让「同名同歌手但时长对不上」
 * （伴奏 / 现场 / 变速）落在判定之外。
 *
 * @returns {boolean}
 */
function isCrossSourceSameSong(a, b) {
  if (!a || !b) return false;
  if (!sameTitle(a.title, b.title)) return false;
  if (!sameArtist(a.artist, b.artist)) return false;
  return durationCompatible(a.duration, b.duration);
}

/** 时长是否可比且在容差内（缺任一侧 ⇒ 不可判，不算同曲） */
function durationCompatible(x, y) {
  const a = Number(x);
  const b = Number(y);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= DURATION_TOLERANCE_MS;
}

/** 歌手：两侧都存在且归一后相等（多人歌手顺序无关） */
function sameArtist(x, y) {
  if (!x || !y) return false;
  const na = normalizeArtists(x);
  const nb = normalizeArtists(y);
  return !!na && na === nb;
}

/** 版本装饰词（Live / DJ / 伴奏 / 纯音乐 …）——歌名差异不算换曲 */
const VERSION_TAILS = [
  'live', 'dj', 'djversion', 'remix', 'cover', '伴奏', '纯音乐', 'instrumental',
  'acoustic', 'karaoke', '现场', '录音室', 'version', '伴奏版', '现场版', '完整版',
  '高音质', '无损', 'official', 'officialvideo', 'explicit',
];

/**
 * 版本词剥完后可能还剩「版 / 版本」这类纯修饰字（normalizeName 已吃掉括号，
 * 「七里香（现场版）」→「七里香现场版」→ 剥掉「现场」还剩「版」）。
 * 这些字必须放在版本词**之后**剥，且只剥尾部，否则会把歌名里的字当装饰剥掉。
 */
const VERSION_MODIFIERS = ['版', '版本', 'mv', 'officialvideo'];

/**
 * 剥掉歌名尾部的版本装饰词
 *
 * 必须在 **normalizeName 之后** 做：归一会把「七里香 (Live)」压平成
 * 「七里香live」，括号在那一阶段就没了，先剥括号永远剥不到东西。
 * 这里按 matchMusic 的 VERSION_TAILS 思路，改为对归一后的串做尾部剥离，
 * 最多剥两轮（「七里香livered」这类叠词不至于无限递归）。
 */
function stripVersionTail(normalized) {
  let out = String(normalized || '');
  for (let pass = 0; pass < 2; pass++) {
    const next = VERSION_TAILS.reduce(
      (acc, tail) => (acc.length > tail.length && acc.endsWith(tail) ? acc.slice(0, -tail.length) : acc),
      out
    );
    if (next === out) break;
    out = next;
  }
  // 版本词之后可能还剩「版 / 版本」这类纯修饰字
  for (const mod of VERSION_MODIFIERS) {
    if (out.length > mod.length && out.endsWith(mod)) {
      out = out.slice(0, -mod.length);
      break;
    }
  }
  return out;
}

/** 歌名：归一后相等，或剥掉尾部版本词后相等（(Live) 不算换曲） */
function sameTitle(x, y) {
  const a = normalizeName(x);
  const b = normalizeName(y);
  if (!a || !b) return false;
  if (a === b) return true;
  return stripVersionTail(a) === stripVersionTail(b);
}

/**
 * 聚类键：归一**并剥掉版本词**后的歌名 + 歌手
 *
 * 关键：桶键必须与判定口径一致。若这里用未剥版本词的 normalizeName，
 * 「七里香」与「七里香 (Live)」会分进不同桶，两两比较永不发生，
 * 判定函数返回 true 也没用——**粗筛比判定更严会把真同曲筛掉**。
 * 所以这里复用 stripVersionTail，与 isCrossSourceSameSong 走同一套口径。
 */
function clusterKey(song) {
  const t = stripVersionTail(normalizeName(song && song.title));
  if (!t) return '';
  return t + '␟' + normalizeArtists(song && song.artist);
}

/** 跨源标识：同一首歌在同一平台内可能有多个条目（不同专辑的同一首） */
function songKey(song) {
  if (!song || song.id == null || song.id === '') return '';
  return String(song.source || '') + '␟' + String(song.id);
}

/** 有效曲目：有 id 与 source 才能下载/去重；垃圾项静默丢弃 */
function isUsableSong(song) {
  return !!(song && song.id != null && song.id !== '' && song.source);
}

/**
 * 聚合 + 跨源去重标记（纯函数，不修改传入的分组结构）
 *
 * @param {Array<{source:string, songs:Array}>} groups 按来源分组的曲目
 * @param {Object} [opts]
 * @param {boolean} [opts.markDuplicates=true] 是否标记跨源同曲
 * @returns {{songs:Array, stats:{total:number, sources:number, duplicates:number, groups:number}}}
 *   命中标记的曲目会多出：
 *     _dupOf: string[]     同曲的其他条目 key（跨源重复时才有）
 *     _dupCount: number    同曲条目总数（含自己）
 *     _crossSource: boolean 该曲在多个平台上都有
 */
function aggregateAcrossSources(groups, opts = {}) {
  const out = [];
  const seenKeys = new Set(); // 同平台同 id 只收一次（歌单之间天然重叠）

  for (const g of (Array.isArray(groups) ? groups : [])) {
    if (!g || !Array.isArray(g.songs)) continue;
    for (const s of g.songs) {
      if (!isUsableSong(s)) continue;
      const k = songKey(s);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      out.push(s);
    }
  }

  const stats = {
    total: out.length,
    sources: new Set(out.map((s) => s.source)).size,
    duplicates: 0,
    groups: 0,
  };
  if (!out.length || opts.markDuplicates === false) return { songs: out, stats };

  // 粗分组：归一后歌名+歌手相同的一批（把 O(n²) 的比较压到 O(n·k)）
  const buckets = new Map();
  for (const s of out) {
    const k = clusterKey(s);
    if (!k) continue;
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(s);
  }

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // 并查集：把判定为同曲的条目并到一簇
    const parent = bucket.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (isCrossSourceSameSong(bucket[i], bucket[j])) union(i, j);
      }
    }

    const clusters = new Map();
    bucket.forEach((s, i) => {
      const r = find(i);
      let arr = clusters.get(r);
      if (!arr) { arr = []; clusters.set(r, arr); }
      arr.push(s);
    });

    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      // 同源多副本（同歌不同专辑）不算「跨源重复」
      if (new Set(members.map((s) => s.source)).size < 2) continue;

      const keys = members.map((s) => songKey(s));
      for (const m of members) {
        m._dupOf = keys.filter((k) => k !== songKey(m));
        m._dupCount = members.length;
        m._crossSource = true;
      }
      stats.duplicates += members.length;
      stats.groups += 1;
    }
  }

  return { songs: out, stats };
}

/**
 * 挑一个「代表条目」：同曲多源时，下载优先选它
 *
 * 排序依据（依次）：
 *   1. 已登录的平台优先 —— 未登录时会员资源取不到流
 *   2. 时长已知且非零的优先 —— 时长是同曲判定的必要条件之一
 *   3. 其余保持原顺序（Array#sort 在 V8 上稳定）
 *
 * @param {Array} members 同一簇的曲目
 * @param {Set<string>|string[]} [loggedIn] 已登录平台集合
 * @returns {Object|null} 代表条目（members 为空则 null）
 */
function pickRepresentative(members, loggedIn) {
  const list = (Array.isArray(members) ? members : []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const auth = loggedIn instanceof Set ? loggedIn : new Set(loggedIn || []);
  const hasDur = (s) => Number.isFinite(Number(s && s.duration)) && Number(s.duration) > 0;

  const ranked = list.map((s, i) => ({
    s, i,
    auth: auth.has(s.source) ? 1 : 0,
    dur: hasDur(s) ? 1 : 0,
  }));
  ranked.sort((a, b) => (b.auth - a.auth) || (b.dur - a.dur) || (a.i - b.i));
  return ranked[0].s;
}

module.exports = {
  DURATION_TOLERANCE_MS,
  VERSION_TAILS,
  VERSION_MODIFIERS,
  aggregateAcrossSources,
  pickRepresentative,
  isCrossSourceSameSong,
  sameTitle,
  sameArtist,
  durationCompatible,
  clusterKey,
  songKey,
  isUsableSong,
};
