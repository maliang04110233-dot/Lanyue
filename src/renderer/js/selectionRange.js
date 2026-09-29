/**
 * 多选的「Shift 连选」计算（纯函数，不碰宿主）
 *
 * 为什么锚点存**键**而不是行号：四个列表（歌单详情 / 播放队列 / 下载队列 /
 * 本地曲库）的行号都是「当前视图序」的下标，过滤、排序、分组一变动它指的
 * 就是另一行。键是行的身份 ⇒ 「先点第 3 行、改排序、再 Shift 点第 9 行」
 * 连上的仍是那两行之间的内容，与用户直觉一致。
 * （与 _plSelKeys 记身份不记行号同一口径，见 plBulkRemove.js 头注。）
 *
 * 只并入、不清空：勾选框语义下 Shift 是「延伸选择」。把既有勾选冲掉的话，
 * 一次误触就让用户丢掉整批手工勾出来的行 —— 那批往往是逐框点出来的。
 * 取消单行仍可点该行的框，整批清空走各列表既有的「取消全选」。
 */

/** 本次点击走「连选」还是「单行切换」？带其它修饰键时让位给单行切换。 */
export function isRangeClick(e) {
  return !!(e && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey);
}

/**
 * 视图序里 [锚点 … 本次点击] 闭区间的键。
 *
 * index 越界（视图刚重排、行已不存在）返回空；锚点不在当前视图（被过滤掉、
 * 换了歌单、队列清空）退化成只取本次点击那一行 —— 宁可不连，也不替用户
 * 勾一段它没打算勾的区间。
 */
export function rangeKeys(viewKeys, anchorKey, index) {
  if (!Array.isArray(viewKeys) || index < 0 || index >= viewKeys.length) return [];
  const at = anchorKey == null ? -1 : viewKeys.indexOf(anchorKey);
  const from = at < 0 ? index : at;
  return viewKeys.slice(Math.min(from, index), Math.max(from, index) + 1);
}
