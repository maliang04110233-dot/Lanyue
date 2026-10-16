/**
 * 搜索结果 LRU 缓存。
 *
 * 从 views/search.js 拆出（阶段 4 渲染层模块化）：纯内存缓存，不依赖 DOM/state，
 * 适合独立单测。搜索视图通过 searchCacheKey/searchCacheGet/searchCacheSet 读写，
 * 共享同一模块级 Map 实例。
 */

export const SEARCH_CACHE_MAX = 20;
export const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

const _searchCache = new Map();

export function searchCacheKey(type, page, keyword, source) {
  return `${type}:${source || ''}:${keyword}:${page}`;
}

export function searchCacheGet(key) {
  const entry = _searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL) {
    _searchCache.delete(key);
    return null;
  }
  return entry.data;
}

export function searchCacheSet(key, data) {
  if (_searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = _searchCache.keys().next().value;
    _searchCache.delete(oldest);
  }
  _searchCache.set(key, { data, ts: Date.now() });
}
