/**
 * 质量策略「被跳过」的说明文案（3-C 闸门 22，纯函数、无 DOM）
 *
 * 为什么单独一个模块
 * ------------------
 * 主进程把 skip 落在任务上（downloadQueue.js 写 `skipReason` / `skipRule`，
 * status 复用 done），但渲染层此前**完全不读**这两个字段——
 * 用户看到的是一行「已完成」，与真的下完了没有任何区别。
 * 这正是 R1 / R3 的已知伤害：规则误伤时用户既不知道为什么，
 * 也不知道去哪里改。
 *
 * 这里只做「事实 → 话术」的映射，不改判定口径。
 * 判定归 qualityPolicy.js 所有，话术归本文件所有 —— 两者分家，
 * 改文案不会碰到下载行为，改规则也不会顺手改坏措辞。
 *
 * 文案纪律（同 updateTrustChain 一路的那条）
 * ----------------------------------------
 * 措辞必须跟着**事实**走，不得反向暗示：
 *   · R1 全部候选被跳过 ⇒ 必须说「没有音源达到你设定的音质下限」，
 *     并给出调整入口。笼统说「已跳过」等于把误伤藏起来。
 *   · R3 命中 ⇒ 必须能查看判定依据（哪条规则、命中了什么），
 *     否则用户无法判断「是不是记错了我的本地库」。
 *   · 任何情况下都不得写「已完成」。status 复用 done 是有意为之
 *     （QUEUE_STATUSES 是闭集，改它要动二十多处分支），代价是
 *     **必须由本模块把「跳过」在界面上还原出来**。
 *
 * 模块形态：ESM —— 渲染层由 Vite 打包，与主进程的 CJS 不通用。
 * 单测侧用 createRequire 以 CJS 载入同一个文件，见 test/policy-skip-notice.test.js。
 */

/** 规则 id → 面向用户的一句话（说明是哪条规则拦下的） */
export const RULE_LABELS = {
  min_quality: '音质下限规则',
  max_size: '体积上限规则',
  already_have: '已存在规则',
  exclude_names: '排除名单规则',
};

/** 需要用户去设置页调整的规则（其余的只需说明，不需入口） */
export const TUNABLE_RULES = new Set(['min_quality', 'max_size', 'exclude_names']);

/**
 * 判断一个任务是不是「被策略跳过」而非真的下完。
 *
 * @param {Object} task 队列任务
 * @returns {boolean}
 */
export function isPolicySkipped(task) {
  if (!task) return false;
  // 两条判据都取：skipRule 是新写入的权威字段，skipReason 兜底旧数据
  if (task.skipRule) return true;
  return typeof task.skipReason === 'string' && task.skipReason.length > 0;
}

/**
 * 构造「被跳过」的解释对象，交给调用方渲染。
 *
 * @param {Object} task 队列任务
 * @returns {{skipped:boolean, ruleId:?string, ruleLabel:string, reason:string,
 *           summary:string, detail:string[], needsAdjust:boolean, hint:?string}}
 */
export function explainSkip(task) {
  if (!isPolicySkipped(task)) {
    return {
      skipped: false, ruleId: null, ruleLabel: '', reason: '',
      summary: '', detail: [], needsAdjust: false, hint: null,
    };
  }
  const ruleId = task.skipRule || null;
  const ruleLabel = RULE_LABELS[ruleId] || (ruleId ? `规则 ${ruleId}` : '质量策略');
  const reason = String(task.skipReason || '').trim();

  // R1 单独成句：它是唯一一种「所有候选都没了、任务真的没东西可下」的情形。
  // 其余三种 skip 都是「这一条不要」，用户下一步是查规则，不是重试。
  const summary = ruleId === 'min_quality'
    ? '没有音源达到你设定的音质下限'
    : `已按「${ruleLabel}」跳过`;

  const detail = [];
  if (reason) detail.push(reason);
  if (ruleId) detail.push(`触发规则：${ruleLabel}`);

  // 「已存在」需要可核对：用户要能判断本地库记错了没有。
  // 其余规则给调整入口即可。
  const needsAdjust = ruleId === 'already_have' || TUNABLE_RULES.has(ruleId);
  const hint = ruleId === 'already_have'
    ? '如本地确实没有这首，请到「设置 · 下载 · 质量策略」调整「已存在」规则'
    : '可在「设置 · 下载 · 质量策略」调整该规则';

  return {
    skipped: true,
    ruleId,
    ruleLabel,
    reason,
    summary,
    detail,
    needsAdjust,
    hint: needsAdjust ? hint : null,
  };
}
