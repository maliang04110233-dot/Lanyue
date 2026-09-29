/**
 * 下载质量策略引擎（3-C）
 *
 * 解决的问题
 * ----------
 * 现状：音质是「标准 / 高品质 / 无损」三档单选，全局一个设置，队列里逐首照办。
 * 于是「下满 300 首、回头一看 200 首是重复的低音质」只能靠人工查重清理。
 *
 * 本模块提供**用户可自定义的规则队列**：下载前逐条求值，命中即按规则动作
 * （跳过 / 降档 / 保持），每条命中都带可读原因回显到任务行。
 *
 * 设计约束（与本仓既有范式一致）
 * ------------------------------
 * 1. **纯函数**：不碰 fs / IPC / prefs / 网络。规则求值是纯计算，
 *    因此可以单测到 100%，且单测无需 Electron 环境。
 *    读取偏好、查重、落盘一律由调用方（downloadQueue）注入依赖完成。
 * 2. **降级而非抛错**：prefs 里存的是用户手编的 JSON，垃圾值必须安静降级
 *    为「无规则」，绝不能因为一条规则写坏就让整个队列停摆
 *    （同 fallbackPolicy.normalizeDisabledPlatforms 的处理）。
 * 3. **短路即终判**：规则按用户排定的顺序依次求值，**第一条命中即返回**。
 *    用户拖拽排序 = 调整优先级，符合「先判跳过、再判降档」这类朴素心智。
 *
 * 音质档位沿用全仓既有三档（ipcContract 'get-download-url' 的 enum 已钉）：
 *   standard(128k) < hq(320k) < lossless(FLAC)
 * 刻意**不**在此处复刻各平台码率阶梯（netease 999000/320000/128000 等）：
 *   那是各平台插件的职责，且会随平台变化；策略层只认**档位序**。
 *
 * 与跨源换源的关系
 * ----------------
 * 无耦合。fallbackPolicy.crossSourceEnabled() 当前是**关闭**的产品决策
 * （见 test/fallback-policy.test.js：「别家平台的整曲不是这首歌」），
 * 本模块不复述、不绕过该开关：策略只对**本次要下的这一首**下判断，
 * 取流走哪条路仍由 resolveTrackService 的既有决策决定。
 */

// ── 档位序（唯一的真值来源）──────────────────────────────
/** 档位 → 权重。数字越大越好，仅用于比较，不对外承诺具体码率 */
const QUALITY_RANK = { standard: 1, hq: 2, lossless: 3 };

/** 数值归一到已知档位；未知/缺省 → 'standard'（与全仓默认一致） */
function normalizeQuality(q) {
  const s = String(q == null ? '' : q).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(QUALITY_RANK, s) ? s : 'standard';
}

/**
 * 规则表（设置页下拉的唯一事实来源）
 *
 * action 语义：
 *   'skip'   —— 命中即丢弃该任务，回显 reason
 *   'demote' —— 命中即把目标档位压到 params.to，回显 reason
 *
 * params 契约随 rule 而异，见 evaluateQualityPolicy 内各分支注释。
 * 新增规则时：在此登记 → 在 evaluate 里加分支 → 补 test/qualityPolicy.test.js。
 * test 里的「规则表完备性」用例会兜住漏登记。
 */
const QUALITY_RULES = {
  /** 目标音质低于门槛即跳过。params: { min: 'hq' } */
  min_quality: { action: 'skip' },
  /** 体积上限（MB）；超标降档。params: { to: 'hq', maxMb: 50 } */
  max_size: { action: 'demote' },
  /** 同歌手/同专辑已在本地则跳过。params: { scope: 'artist'|'album' } */
  already_have: { action: 'skip' },
  /** 命中歌名/歌手/专辑名单即跳过。params: { names: string[] } */
  exclude_names: { action: 'skip' },
};

/** 规则 id 列表（设置页渲染顺序 = 这里的键顺序） */
const QUALITY_RULE_IDS = Object.keys(QUALITY_RULES);

/** 单条规则归一：垃圾值 → null（调用方跳过该条，不阻断整队列） */
function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const id = String(rule.id || '').trim();
  if (!Object.prototype.hasOwnProperty.call(QUALITY_RULES, id)) return null;
  const out = { id, enabled: rule.enabled !== false };
  if (rule.params && typeof rule.params === 'object' && !Array.isArray(rule.params)) {
    out.params = { ...rule.params };
  } else {
    out.params = {};
  }
  return out;
}

/**
 * 规则队列归一（prefs 垃圾值 → 空队列）
 * 宽容度参照 normalizeDisabledPlatforms：数组/单对象/JSON 串都收，坏元素丢弃。
 * @param {*} raw prefs 里存的原始值
 * @returns {Array<{id:string, enabled:boolean, params:object}>}
 */
function normalizeRules(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (list && !Array.isArray(list)) {
    // 旧备份/手编 JSON 常见形态：{ rules: [...] } 或单条规则对象
    list = Array.isArray(list.rules) ? list.rules : [list];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const n = normalizeRule(r);
    if (n) out.push(n);
  }
  return out;
}

/** 名单归一：Set / 数组 / 单值 → 小写去空白集合 */
function _normNames(v) {
  if (!v) return new Set();
  const arr = v instanceof Set ? [...v] : (Array.isArray(v) ? v : [v]);
  return new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** 歌名/歌手/专辑 取值：容错 + 归一（小写去首尾空白） */
function _field(song, key) {
  return String((song && song[key]) || '').trim().toLowerCase();
}

/**
 * 体积估算（MB）
 *
 * 刻意**只做估算**，不承诺精确值：真实大小只有取流后 stat 才知道，
 * 而策略要在取流**之前**生效。按码率 × 时长线性估算，常数取各档常见值。
 * 估算偏大时 max_size 会略保守（宁可多降一档），这是安全的一侧。
 *
 * @param {number} durationSec 歌曲时长（秒）
 * @param {string} quality 目标档位
 * @returns {number} 估算 MB
 */
function estimateSizeMb(durationSec, quality) {
  const sec = Number(durationSec);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  // kbps → MB：kbps/8 × 秒 /1024。lossless 按 FLAC 常见 800kbps 估
  const kbps = { standard: 128, hq: 320, lossless: 800 }[normalizeQuality(quality)] || 128;
  return Math.round((kbps / 8) * sec) / 1024;
}

/**
 * 核心求值：规则队列 × 单曲 → 终判
 *
 * @param {Array} rules 规则队列（未归一时内部自行归一）
 * @param {Object} song { title, artist, album, duration, quality }
 * @param {Object} [ctx] 外部事实，缺项即该规则不命中（**不**误杀）
 *   - haveArtist: Set<string>|string[]  本地已有的歌手
 *   - haveAlbum:  同上，按专辑
 *   - estSizeMb:  number  调用方自算的体积（不给则用 estimateSizeMb）
 * @returns {{action:'keep'|'skip'|'demote', quality:string, ruleId:?string, reason:string}}
 */
function evaluateQualityPolicy(rules, song, ctx = {}) {
  const list = normalizeRules(rules);
  const want = normalizeQuality(song && song.quality);
  if (!list.length) return { action: 'keep', quality: want, ruleId: null, reason: '' };

  const haveArtist = _normNames(ctx.haveArtist);
  const haveAlbum = _normNames(ctx.haveAlbum);
  const est = Number.isFinite(Number(ctx.estSizeMb))
    ? Number(ctx.estSizeMb)
    : estimateSizeMb(song && song.duration, want);

  for (const rule of list) {
    if (!rule.enabled) continue;
    const p = rule.params || {};

    switch (rule.id) {
      case 'min_quality': {
        const min = normalizeQuality(p.min);
        if (QUALITY_RANK[want] < QUALITY_RANK[min]) {
          return { action: 'skip', quality: want, ruleId: rule.id, reason: `目标音质 ${want} 低于门槛 ${min}` };
        }
        break;
      }
      case 'max_size': {
        const cap = Number(p.maxMb);
        if (!Number.isFinite(cap) || cap <= 0) break; // 参数非法 → 本条不生效
        if (est > cap) {
          const to = normalizeQuality(p.to);
          if (QUALITY_RANK[to] < QUALITY_RANK[want]) {
            return { action: 'demote', quality: to, ruleId: rule.id, reason: `估算 ${est.toFixed(1)}MB 超过上限 ${cap}MB，降档至 ${to}` };
          }
          // 目标已不高于 to：再降无意义，保持并说明为何不降
          return { action: 'keep', quality: want, ruleId: rule.id, reason: `估算 ${est.toFixed(1)}MB 超过上限 ${cap}MB，但已是最低档 ${want}` };
        }
        break;
      }
      case 'already_have': {
        const scope = String(p.scope || 'artist');
        if (scope === 'album') {
          const alb = _field(song, 'album');
          if (alb && haveAlbum.has(alb)) {
            return { action: 'skip', quality: want, ruleId: rule.id, reason: `本地已有该专辑《${song.album}》` };
          }
        } else {
          const art = _field(song, 'artist');
          if (art && haveArtist.has(art)) {
            return { action: 'skip', quality: want, ruleId: rule.id, reason: `本地已有该歌手的曲目（${song.artist}）` };
          }
        }
        break;
      }
      case 'exclude_names': {
        const names = _normNames(p.names);
        if (!names.size) break;
        const hay = [_field(song, 'title'), _field(song, 'artist'), _field(song, 'album')].filter(Boolean);
        const hit = hay.find((h) => names.has(h) || [...names].some((n) => h.includes(n)));
        if (hit) {
          return { action: 'skip', quality: want, ruleId: rule.id, reason: `命中排除名单：${hit}` };
        }
        break;
      }
      default:
        break; // 未知 id：归一阶段已滤掉，这里只是兜底
    }
  }

  return { action: 'keep', quality: want, ruleId: null, reason: '' };
}

module.exports = {
  QUALITY_RANK,
  QUALITY_RULES,
  QUALITY_RULE_IDS,
  normalizeQuality,
  normalizeRules,
  normalizeRule,
  estimateSizeMb,
  evaluateQualityPolicy,
};
