/**
 * 自然语言搜索编排服务（P0-A）
 *
 * 结构刻意保持"零依赖注入"：改写（LLM）与聚合搜索都以函数传入，
 * 与 resolveTrackService 的 probeUrl 注入同一模式 —— 单测不触网。
 *
 * 流程：phrase → rewrite 得 1~3 个关键词 → 并行扇出 searchAll →
 * 按 id+source 去重（先出现者优先）→ 超上限截断。
 * 改写失败/为空时退回用原句搜一次，保证 AI 不可用时功能不回归。
 */

const MAX_QUERIES = 3;

/**
 * @param {Object} deps
 * @param {string} deps.phrase - 用户自然语言需求
 * @param {(phrase:string)=>Promise<string[]>} deps.rewrite - LLM 改写
 * @param {(keyword:string)=>Promise<Object[]>} deps.searchAll - 单关键词聚合搜索
 * @param {number} [deps.limit=60] - 合并结果上限
 * @returns {Promise<{songs:Object[], queries:string[], truncated?:boolean,
 *                    failedQueries?:Array<{query:string,error:string}>, error?:string}>}
 *   failedQueries：并行扇出中失败/超时的关键词（P2-13）。成功的结果照常返回，
 *   但失败这件事必须让界面看得见 —— 否则用户会把「1/3 的关键词挂了」误读成
 *   「LLM 就改写出这几首」。
 */
async function searchByPhrase({ phrase, rewrite, searchAll, limit = 60 }) {
  const p = typeof phrase === 'string' ? phrase.trim() : '';
  if (!p) return { songs: [], queries: [], error: '请输入搜索需求' };

  let queries = [];
  try {
    queries = (await rewrite(p)) || [];
  } catch (_) {
    queries = [];
  }
  queries = Array.from(new Set(
    queries.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim()),
  )).slice(0, MAX_QUERIES);
  if (!queries.length) queries = [p];

  // P2-13（2026-10-13 复审）：单个关键词失败必须**看得见**。
  //
  // 旧写法是 `.catch(() => [])`：某关键词超时/报错就落成空列表，而 queries 原样
  // 返回 ⇒ 界面看不出有 1~2 个关键词挂了，用户以为「LLM 改写出来的结果就这些」。
  // 现在把失败收进 failedQueries，随结果一起返回（成功的结果一条不丢）。
  const settled = await Promise.all(
    queries.map(async (q) => {
      try {
        return { q, list: await Promise.resolve(searchAll(q)) || [], err: null };
      } catch (e) {
        return { q, list: [], err: (e && e.message) || String(e) || '搜索失败' };
      }
    }),
  );
  const lists = settled.map(r => r.list);
  const failedQueries = settled
    .filter(r => r.err)
    .map(r => ({ query: r.q, error: r.err }));

  const songs = [];
  const seen = new Set();
  let truncated = false;
  outer: for (const list of lists) {
    for (const s of list || []) {
      if (!s || s.id == null) continue;
      const key = `${String(s.id)}:${String(s.source || '')}`;
      if (seen.has(key)) continue;
      if (songs.length >= limit) { truncated = true; break outer; }
      seen.add(key);
      songs.push(s);
    }
  }

  const out = { songs, queries };
  if (truncated) out.truncated = true;
  if (failedQueries.length) out.failedQueries = failedQueries;
  return out;
}

module.exports = { searchByPhrase, MAX_QUERIES };
