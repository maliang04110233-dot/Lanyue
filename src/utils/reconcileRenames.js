/**
 * 外部改名对账规则（纯函数，无 IO）
 *
 * 用户在 app 之外（资源管理器、标签编辑器、另一台设备）改了下载文件的文件名时，
 * 所有按路径记账的东西会集体失联。曲库扫描恰好握着磁盘上真实存在的文件清单和
 * 它们的 ID3 标题/歌手 —— 拿两边一对，就能把新名字认回来。
 *
 * 判"失联"只看本次扫描结果（成员判定走 canonPath，不再 stat 磁盘）：
 * 扫描目录之外的记录本来也没有候选可比，天然不会被误修。
 *
 * 只认同目录 + 标题歌手相等 + 候选唯一。任何一点不确定都放弃：
 * 认错一首歌的代价（把 B 歌的下载状态记到 A 歌头上，B 歌从此永不重下）
 * 远高于继续漏修一条（用户顶多重下一遍）。
 */

const path = require('path');
const { canonPath } = require('./relinkRefs');

/** 元数据文本判等：去首尾空白、压内部空白、忽略大小写（ID3 与历史记录各有各的写法） */
function _norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {Array<{id,source,title,artist,savePath}>} refs 下载历史里「已完成」的记录
 * @param {Array<{filePath,title,artist}>} scanned 本次扫描到的文件（含元数据）
 * @returns {{fixes:Array<{id,source,title,artist,from,to}>, ambiguous:number}}
 *   fixes.to 用扫描结果里的原始写法（回写要落回磁盘真实路径，不能是归一化后的串）；
 *   ambiguous = 有候选但认不准、按规则放弃的记录数。
 */
function matchRenamedRefs(refs, scanned) {
  if (!Array.isArray(refs) || !Array.isArray(scanned)) return { fixes: [], ambiguous: 0 };

  const present = new Set();
  /** 「canon目录|标题|歌手」→ 该键下的候选文件数组 */
  const byKey = new Map();
  for (const s of scanned) {
    if (!s || typeof s !== 'object') continue;
    const cp = canonPath(s.filePath);
    if (!cp) continue;
    present.add(cp);
    const key = `${path.posix.dirname(cp)}|${_norm(s.title)}|${_norm(s.artist)}`;
    const arr = byKey.get(key);
    if (arr) arr.push(s);
    else byKey.set(key, [s]);
  }

  /**
   * 候选文件 → 认领它的记录。同一个文件被多条记录认领是允许的，但仅限这些记录的
   * 旧路径本来就相同（同一首歌被两个平台重复登记时 savePath 会同名）；旧路径不同
   * 却抢同一个文件，说明磁盘上最多只剩其中一首，全放弃。
   */
  const claims = new Map();
  let ambiguous = 0;
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue;
    const from = canonPath(r.savePath);
    if (!from || present.has(from)) continue;
    if (!_norm(r.title)) continue;
    const cands = byKey.get(`${path.posix.dirname(from)}|${_norm(r.title)}|${_norm(r.artist)}`) || [];
    if (cands.length === 0) continue;
    if (cands.length > 1) { ambiguous += 1; continue; }
    const to = canonPath(cands[0].filePath);
    const bucket = claims.get(to);
    if (bucket) bucket.rows.push(r);
    else claims.set(to, { to: cands[0].filePath, rows: [r] });
  }

  const fixes = [];
  for (const { to, rows } of claims.values()) {
    const distinct = new Set(rows.map(r => canonPath(r.savePath)));
    if (distinct.size > 1) {
      ambiguous += rows.length;
      continue;
    }
    for (const r of rows) {
      fixes.push({ id: r.id, source: r.source, title: r.title, artist: r.artist, from: r.savePath, to });
    }
  }
  return { fixes, ambiguous };
}

module.exports = { matchRenamedRefs };
