/**
 * WebDAV 快照合并核心（纯函数，无 IO）
 *
 * 场景：多台设备共享一个 WebDAV 快照文件。同步 = 拉取远端 → 与本地合并 →
 * 合并结果既回写远端也回写本地。盲覆盖（现有 import-all-data 的行为）会让
 * 旧备份吞掉新数据，这里给每类数据定合并规则：
 *
 *   - 歌单     按 id 并集；同 id 以 updatedAt 较新者为基底，另一方独有的
 *              歌曲按 songKey(id:source) 并入。无墓碑机制 ⇒ 删歌/删歌单不跨
 *              设备传播，只会"复活"，与 lx-music-desktop 的 sync 行为一致，
 *              是快照合并方案共同的已知取舍（换取零冲突状态）。
 *   - 下载模板 按 id 并集；同 id updatedAt 新者胜（整条覆盖，无子结构）。
 *   - 历史记录 按 id+source 去重，finishedAt 新者胜；输出 finishedAt 倒序。
 *
 * songKey 与 main/ipc/playlist.js 保持同一规则：只按 id 会跨平台撞车。
 */

function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

function _arr(x) {
  return Array.isArray(x) ? x : [];
}

function _ts(x, field = 'updatedAt') {
  const n = x && Number(x[field]);
  return Number.isFinite(n) ? n : 0;
}

// 渲染层会把条目 id 用作 data-id / onclick 实参，外来快照（NAS/备份文件）的
// id 可任意 —— 非法形状的 id 一律换成安全生成 id（条目保留），封堵存储型 XSS。
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// P2-6（2026-10-13 复审）：修复后的 id 必须**确定性**，不能用模块级递增计数。
//
// 旧实现是 `_fixedSeq++`：412 冲突重试时，cloudSyncCore 会拿「首次合并结果」当
// local 再合一次 remote2。首次合并把 remote1 里的坏 id 修成 ..._seqA；而首次
// PUT 因 412 并未写入远端，所以 remote2 里那条仍是原始坏 id，第二次修成
// ..._seqB。mergePlaylists 按 id 做并集 ⇒ 同一条目变成两条，并随下次同步继续扩散。
//
// 改成「原始 id 的哈希」后：同一条坏 id 无论被修几次都得到同一个新 id，
// 并集自然收敛回一条，且结果与合并次数、与本进程先修过什么无关。
function _hashId(s) {
  return require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function repairIds(list, prefix) {
  // 同列表内的重复计数：只用来保证「同一个列表里两个相同坏 id」不撞车。
  // 它不破坏确定性 —— 同一份输入列表每次算出的计数序列都一样。
  const dupCount = new Map();
  return _arr(list).filter(x => x && typeof x === 'object').map((item) => {
    if (item.id == null) return item;
    const id = String(item.id);
    if (SAFE_ID_RE.test(id)) return item;
    const base = _hashId(id);
    const n = dupCount.get(base) || 0;
    dupCount.set(base, n + 1);
    const fixed = n === 0 ? `${prefix}_fixed_${base}` : `${prefix}_fixed_${base}_${n}`;
    // 结果形如 pl_fixed_<16 hex>，天然满足 SAFE_ID_RE ⇒ 不会被再次修复
    return { ...item, id: fixed };
  });
}

function mergePlaylists(local, remote) {
  const out = repairIds(local, 'pl').filter(p => p.id != null).map(p => ({ ...p }));
  const byId = new Map(out.map(p => [String(p.id), p]));

  for (const r of repairIds(remote, 'pl')) {
    if (!r || r.id == null) continue;
    const key = String(r.id);
    const l = byId.get(key);
    if (!l) {
      const clone = { ...r };
      out.push(clone);
      byId.set(key, clone);
      continue;
    }
    // 较新者为基底（同值取本地），旧方独有歌曲并入
    const newer = _ts(r) > _ts(l) ? r : l;
    const older = newer === r ? l : r;
    const seen = new Set(_arr(newer.songs).map(songKey));
    const merged = _arr(newer.songs).concat(
      _arr(older.songs).filter(s => s && !seen.has(songKey(s))),
    );
    const base = { ...newer, songs: merged };
    out[out.indexOf(l)] = base;
    byId.set(key, base);
  }
  return out;
}

function mergeTemplates(local, remote) {
  const out = repairIds(local, 'tpl').filter(t => t.id != null);
  const byId = new Map(out.map(t => [String(t.id), t]));
  for (const r of repairIds(remote, 'tpl')) {
    if (!r || r.id == null) continue;
    const key = String(r.id);
    const l = byId.get(key);
    if (!l) {
      out.push(r);
      byId.set(key, r);
    } else if (_ts(r) > _ts(l)) {
      out[out.indexOf(l)] = r;
      byId.set(key, r);
    }
  }
  return out;
}

function mergeHistory(local, remote) {
  const byKey = new Map();
  for (const e of _arr(local).concat(_arr(remote))) {
    if (!e || e.id == null || !e.source) continue;
    const key = `${String(e.id)}:${e.source}`;
    const prev = byKey.get(key);
    if (!prev || _ts(e, 'finishedAt') > _ts(prev, 'finishedAt')) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => _ts(b, 'finishedAt') - _ts(a, 'finishedAt'));
}

/**
 * 合并两份快照的 data 段（与 export-all-data 的 data 键对齐）
 */
function mergeSnapshotData(localData, remoteData) {
  const l = localData && typeof localData === 'object' ? localData : {};
  const r = remoteData && typeof remoteData === 'object' ? remoteData : {};
  return {
    userPlaylists: mergePlaylists(l.userPlaylists, r.userPlaylists),
    downloadTemplates: mergeTemplates(l.downloadTemplates, r.downloadTemplates),
    downloadHistory: mergeHistory(l.downloadHistory, r.downloadHistory),
  };
}

module.exports = { mergePlaylists, mergeTemplates, mergeHistory, mergeSnapshotData, repairIds };
