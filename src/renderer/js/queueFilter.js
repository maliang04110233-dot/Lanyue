/**
 * 下载队列过滤 —— 状态筛选 × 关键词搜索 × 平台的 AND 组合
 *
 * 状态标签（全部/下载中/已完成/失败）解决「按阶段看」，输入关键词解决
 * 「在一堆任务里找那首歌」，平台维度解决「哪个源在堵」；三者叠加互不覆盖。
 * 纯函数独立成模块供 node:test，download.js 只做 DOM 编排。
 */

const STATUS_MATCH = {
  active: (s) => s.status === 'downloading' || s.status === 'pending',
  done: (s) => s.status === 'done',
  error: (s) => s.status === 'error',
};

/** 关键词命中：歌名或歌手（不区分大小写，任一部分包含即中） */
export function queueItemMatchesKeyword(s, kwLower) {
  if (!kwLower) return true;
  const hay = (String(s.title || '') + ' ' + String(s.artist || '')).toLowerCase();
  return hay.includes(kwLower);
}

/**
 * queue → 过滤后的可见列表（保持原顺序）。
 * mode: 'all' | 'active' | 'done' | 'error'；keyword 前后空白忽略，空串=不过滤。
 * platform：平台 id，空串=不过滤；与状态/关键词同为 AND 叠加。
 * 无 source 的任务按 queueGroup 的约定归 'unknown' 组，所以「只看其他」也要能命中它们。
 */
const NO_SOURCE_KEY = 'unknown';

export function applyQueueFilter(queue, mode, keyword, platform) {
  const list = Array.isArray(queue) ? queue : [];
  const kw = String(keyword || '').trim().toLowerCase();
  const plat = String(platform || '').trim().toLowerCase();
  const statusFn = STATUS_MATCH[mode];
  const sourceKeyOf = (s) => String(s.source || '').trim().toLowerCase() || NO_SOURCE_KEY;
  return list.filter(s => s
    && (!statusFn || statusFn(s))
    && queueItemMatchesKeyword(s, kw)
    && (!plat || sourceKeyOf(s) === plat));
}
