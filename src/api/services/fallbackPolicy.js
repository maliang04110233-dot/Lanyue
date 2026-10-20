/**
 * 换源平台排除策略 + 跨源换源总开关—— 纯函数，无 IO。
 *
 * 用户可在设置页勾选「不参与换源的平台」：某些平台长期无版权/风控严，
 * 换源时在它们身上逐个撞墙既慢又浪费请求。该清单只影响**跨源路径**
 * （候选过滤 + _altSource 记忆），本源取流永远不受限 —— 用户禁了 kuwo
 * 也不该导致 kuwo 自己的歌播不了。
 *
 * prefs 键 `fallbackDisabledPlatforms` 的容错解析集中在这里：
 * 渲染层写数组，旧备份/手改可能出现对象映射或垃圾值，一律安全降级。
 */

/**
 * 跨源换源总开关。
 *
 * 产品口径（2026-10-20 改版，覆盖 2026-09-22 旧口径）：**播放源无效时自动换源**。
 * 旧口径「搜索结果里的歌 = 它自己平台的音源，拿不到就诚实失败」的顾虑
 * （别家同名整曲可能是现场版/翻唱）由 UI 兜住：换源成功时 fallbackNotice
 * 明示「已从 X 切到 Y」+ 播放条源徽章显示实际来源，用户始终知道听到的是谁。
 * 2026-09-22 的实测（网易云 3/4 首仅试听片段、酷狗/酷我 0/4 整曲）恰恰说明
 * 关掉换源会让这些平台「能出声」的路被掐死——新版把它们放回来。
 *
 * 实现：懒读 prefs 键 `crossSourceAutoFallback`（用户在设置页可关），
 * 未设置/读盘失败 → 默认开。照 getDisabledPlatforms 先例（api/index.js:153），
 * 模块初始化期不拖 prefs 磁盘依赖，测试 require 本模块零副作用。
 *
 * @returns {boolean}
 */
function crossSourceEnabled() {
  try {
    // 只有显式 false 才关；未初始化/未设置/垃圾值一律默认开
    return require('../../utils/prefs').get('crossSourceAutoFallback', true) !== false;
  } catch {
    return true;
  }
}

/**
 * 把 prefs 原始值归一化为平台 id 集合。
 * 接受：字符串数组 / `{id:true}` 对象映射；其余（null/对象数组/垃圾）→ 空集。
 * @param {unknown} raw
 * @returns {Set<string>}
 */
function normalizeDisabledPlatforms(raw) {
  const out = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof k === 'string' && k.trim()) out.add(k.trim());
    }
  }
  return out;
}

/**
 * 过滤掉被禁用平台的换源候选。缺 source/id 的畸形候选原样保留 ——
 * 主循环自会跳过它们，这里不做二次裁判（保持纯过滤职责）。
 * @param {Array<{source?:string}>} candidates
 * @param {Set<string>} disabled
 * @returns {Array}
 */
function filterDisabledCandidates(candidates, disabled) {
  if (!Array.isArray(candidates) || !disabled || disabled.size === 0) return candidates;
  return candidates.filter((c) => !c || !c.source || !disabled.has(c.source));
}

module.exports = { normalizeDisabledPlatforms, filterDisabledCandidates, crossSourceEnabled };
