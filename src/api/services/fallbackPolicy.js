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
 * 产品口径：**「搜索结果里的这首歌 = 它自己平台的音源」**。拿别家平台的同名
 * 整曲冒充，用户听到的是另一版录音（现场版/翻唱/DJ 版），却以为原曲能播 ——
 * 这比"播不了"更糟。所以本源取不到流时诚实失败，让"没有音源"这件事被看见。
 *
 * 2026-09-22 实测口径（8 平台 × 4 曲）：网易云 3/4 首只有 30~45s 试听片段、
 * 酷狗与酷我 0/4 首能拿到本源整曲 —— 换源此前是这两家"能出声"的唯一原因，
 * 关掉后它们会明确失败。这是刻意的取舍，不是疏漏。
 *
 * 恢复换源只需把下面这一行翻成 true：机制（候选匹配 / 健康度重排 / 直链预检 /
 * 片段判定 / 排除清单 / 记忆路径）全部保留在 resolveTrackService 内，未删一行；
 * 播放 / 预取 / 下载队列 / 就地重试各链路都经 resolve，改一处即全部生效。
 *
 * @returns {boolean}
 */
function crossSourceEnabled() {
  return false;
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
