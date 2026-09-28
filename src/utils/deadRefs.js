/**
 * 下载历史"判活"规则—— 纯规则 + 注入判活函数，node 可单测
 *
 * 历史表存的是下载成功那一刻的 save_path，此后磁盘发生什么它一无所知：用户手工
 * 清了下载目录、换了硬盘、把音乐整批挪走之后，历史仍是一片 ✅，行尾 ▶ 点了报
 * "本地文件读不到"，搜索页还挂着「✔ 已下载」（dlStatus 只读历史表，从不看磁盘），
 * 导出 m3u 会把死路径写进播放列表。
 *
 * 与/152 的分工：那两条治"文件还在但路径变了"（改名 ⇒ 回写救得回来），
 * 这里治另一半"文件真没了"（记录本身是死的，只能删记录）。判活这件事必须由主进程
 * 做（渲染层没有 fs），所以规则放这儿、IO 由调用方注入 —— 既能在 node 下用真临时
 * 文件测，也不会把 fs 拖进历史模块（它是纯 sqlite 层）。
 *
 * 两条安全边界（都来自"错删一条记录用户找不回来，多留一条只是列表长点"）：
 *   - 判活函数抛错 ⇒ 按"还活着"处理，绝不因为一次 EACCES 就把记录标成可删；
 *   - 一次最多判 MAX_MARK_CHECK 个不同路径，超出部分干脆不标（missing 字段都不给），
 *     因为 queryHistory 的 limit 可以到 100000，逐条 stat 会把主进程钉住。
 */

const { canonPath } = require('./relinkRefs');

/** 单次判活的路径数上限：历史页只有 50 行，留足余量给"整表清一遍"那种调用 */
const MAX_MARK_CHECK = 2000;

/** 只有"成功且有可查路径"的记录谈得上失效：error 行本来就没文件 */
function _judgeable(item) {
  return !!item && typeof item === 'object'
    && item.status === 'done'
    && typeof item.savePath === 'string'
    && Boolean(canonPath(item.savePath));
}

/**
 * 给查询结果标 missing：true=文件确实不在，false=文件还在；判不了的行不加这个字段。
 * 同一路径只判一次（同一首歌可能在历史里出现多遍），不同分隔符写法算同一路径。
 *
 * @param {Array<object>} items queryHistory 的 items
 * @param {(p:string)=>Promise<boolean>} exists 判活函数（生产传 fsAsync.exists）
 * @returns {Promise<Array<object>>} 新数组；未参与判活的行沿用原对象引用
 */
async function markMissing(items, exists) {
  if (!Array.isArray(items)) return [];
  if (typeof exists !== 'function') return items.slice();

  const judged = [];
  for (const it of items) if (_judgeable(it)) judged.push(it);

  const distinct = [];
  const seen = new Set();
  for (const it of judged) {
    const key = canonPath(it.savePath);
    if (seen.has(key)) continue;
    seen.add(key);
    if (distinct.length >= MAX_MARK_CHECK) break;
    distinct.push(key);
  }
  const verdict = new Map();
  await Promise.all(distinct.map(async (key) => {
    let ok = true;
    try {
      ok = await exists(key);
    } catch (_e) {
      ok = true; // 判不了就当还在：宁可留下死账，不可错杀活账
    }
    verdict.set(key, Boolean(ok));
  }));

  return items.map((it) => {
    // 判过的行才下结论：同一 savePath 上挂着一条 error 记录时，不许顺带把它也标死
    // （失败记录是「🔁 重试失败项」的靶子，被清理入口误删就是凭空丢数据）
    if (!_judgeable(it)) return it;
    const key = canonPath(it.savePath);
    if (!verdict.has(key)) return it;
    return { ...it, missing: !verdict.get(key) };
  });
}

/**
 * 从标过缺的结果里挑出可删的条目（remove-history 只要主键，但确认弹层要点名歌，
 * 所以顺手带上 title/artist —— 多出来的字段进 remove 会被忽略，不会写坏任何记录）。
 * 只认 missing === true —— 没判过的行（超限、非 done、无路径）一律不动。
 * @returns {Array<{id:string, source:string, title:string, artist:string}>}
 */
function pickDeadEntries(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object' || it.missing !== true) continue;
    const id = it.id == null ? '' : String(it.id);
    const source = it.source == null ? '' : String(it.source);
    if (!id || !source) continue; // 没有主键删不掉，别假装删了
    const key = `${source}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id, source,
      title: String(it.title || ''), artist: String(it.artist || ''),
      // 重下要用的字段也在这里补齐 —— 「哪些行算死账」与「死账带什么上路」
      // 同属一处规则。注意只搬运、不设默认值：音质默认归 enqueuePayloadFor 一家管
      album: String(it.album || ''),
      quality: String(it.quality || ''),
    });
  }
  return out;
}

module.exports = { markMissing, pickDeadEntries, MAX_MARK_CHECK };
