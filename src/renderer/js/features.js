/**
 * 功能总开关 —— 「哪些特性开着」的唯一登记表
 *
 * 口径是「删掉 AI 创作」的可逆那版：api / IPC 契约 / 偏好键 / 已生成音频全部保留，
 * 只把用户走得进去的入口关掉。所以本文件存在的意义是**只此一处**：入口若各自
 * 写死自己的判断，就成了四份需要同步的清单（漏一条 = "看着删了其实还能进"）。
 *
 * 摘除用 remove() 而不是 hidden：.nav-item / .search-btn 在 CSS 里显式写了 display，
 * 类选择器优先级高于 [hidden]，隐藏属性会被盖掉（e1924ae 踩过）。
 */

// 翻回 true 即完整恢复，不需要改任何其它文件。
const FEATURES = {
  ai: false,
};

// tab → 所属特性。没登记的 tab 一律不受开关影响。
const TAB_FEATURES = {
  'ai-music': 'ai',
};

function featureOn(name) {
  return FEATURES[name] === true;
}

function tabAllowed(tab) {
  const feature = TAB_FEATURES[tab];
  return !feature || featureOn(feature);
}

/** 条目过滤：没声明 feature 的照常放行，声明了的看开关 */
function filterByFeature(items, on = featureOn) {
  return items.filter(it => !it.feature || on(it.feature));
}

/** 摘除 root 下所有挂在已关闭特性上的入口 */
function applyFeatureFlags(root = document, gate = { on: featureOn }) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  scope.querySelectorAll('[data-feature]').forEach((el) => {
    if (!gate.on(el.dataset.feature)) el.remove();
  });
}

export { FEATURES, TAB_FEATURES, featureOn, tabAllowed, filterByFeature, applyFeatureFlags };
