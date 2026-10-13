/**
 * 源可用性健康记录（P2 探针的被动部分）
 *
 * 滑动窗口记每源最近 WINDOW 次取流成败（内存态，会话级——重启即重新观察，
 * 不持久化：源的健康状况天然时效短，落盘只会误导下次会话）。
 *
 * 消费方：
 *   - api/index.js getDownloadUrlSmart：各环节取流后 recordResult，
 *     候选列表 rankByHealth 重排（好源先试）
 *   - IPC get-source-health / probe-sources：设置页展示
 *
 * ── P2-7（2026-10-13 复审）两处修正 ──────────────────────────
 *
 * 1. 分数改为**拉普拉斯平滑** (ok+1)/(len+2)，不再让单次失败把分数打到 0。
 *    旧实现是 ok/len：一次失败即 0 分，而 rankByHealth 把 0 分排在所有「无数据 = 1
 *    分」的源之后 ⇒ 垫底的源几乎不会被优先选中 ⇒ 新样本进不来 ⇒ 要连续约 20 次
 *    成功才爬得回来。一次网络抖动造成的降权，在会话内变成了准永久的。
 *
 * 2. **探测结果与真实下载结果分桶**。设置页的「源可用性实测」此前把结果写进
 *    与真实取流同一个窗口（api/index.js 的 recordProbeResult 直接调 recordResult）
 *    —— 于是弱网下点一次实测，就把全部源一起打到 0 分并重排到末尾：用户为了
 *    诊断而点的按钮，反而把所有源都降权了。现在探测只进 _probes，只用于展示，
 *    不参与换源排序。
 *
 * 不做时间衰减：窗口本身就限制了旧样本的影响。
 */

const WINDOW = 20;
const _records = new Map();   // source → [bool]（尾部为最新）真实下载取流
const _probes = new Map();    // source → [bool] 主动探测（只展示，不排序）

function _push(map, source, ok) {
  if (!source) return;
  let arr = map.get(source);
  if (!arr) { arr = []; map.set(source, arr); }
  arr.push(!!ok);
  if (arr.length > WINDOW) arr.shift();
}

/** 真实下载取流结果：参与换源排序 */
function recordResult(source, ok) {
  _push(_records, source, ok);
}

/** 主动探测结果：只用于设置页展示，**不**参与换源排序（见文件头第 2 点） */
function recordProbeResult(source, ok) {
  _push(_probes, source, ok);
}

function getHealthScore(source) {
  const arr = _records.get(source);
  if (!arr || !arr.length) return 1; // 无数据视为健康：避免冷启动误杀
  const ok = arr.filter(Boolean).length;
  // 平滑：单次失败只是降权（1/3），连续失败仍会明显沉底（20 连败 ≈ 0.045）
  return (ok + 1) / (arr.length + 2);
}

function getSampleCount(source) {
  const arr = _records.get(source);
  return arr ? arr.length : 0;
}

/**
 * 健康信息快照（IPC 用）
 * @param {string[]} sources 要报告的源列表
 */
function getHealthMap(sources) {
  const out = {};
  for (const s of sources || []) {
    const n = getSampleCount(s);
    const p = _probes.get(s);
    out[s] = {
      score: n ? getHealthScore(s) : null,
      samples: n,
      // 探测样本单列：设置页可展示，但排序不用它
      probe: (p && p.length)
        ? { score: (p.filter(Boolean).length + 1) / (p.length + 2), samples: p.length }
        : null,
    };
  }
  return out;
}

/**
 * 按源健康度降序稳定重排（同源内部保持原顺序——原序已是匹配分排序）
 * 只看真实下载样本：探测结果不参与，否则「点一次实测」会重排整个候选表。
 * @param {Array} items 含 source 字段的对象（候选歌曲）
 */
function rankByHealth(items) {
  const scoreOf = it => getHealthScore(it.source);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (scoreOf(b.it) - scoreOf(a.it)) || (a.i - b.i))
    .map(x => x.it);
}

// 测试辅助
function _resetForTest() {
  _records.clear();
  _probes.clear();
}

module.exports = {
  WINDOW,
  recordResult,
  recordProbeResult,
  getHealthScore,
  getSampleCount,
  getHealthMap,
  rankByHealth,
  _resetForTest,
};
