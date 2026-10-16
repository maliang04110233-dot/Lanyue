/**
 * 下载队列状态机
 *
 * 将隐含在 _processOneSongInner 流程中的状态转换显式化。
 *
 * 状态定义：
 *   pending     — 已入队，等待调度
 *   downloading — 正在下载（含重试退避窗口）
 *   done        — 下载完成（或被策略跳过）
 *   error       — 下载失败（含取消、超时、版权限制）
 *
 * 转换规则：
 *   pending → downloading    开始下载
 *   pending → error          排队超时 / 用户取消
 *   downloading → done       下载成功
 *   downloading → error      下载失败（不可重试或重试耗尽）
 *   downloading → pending     可重试错误，等待下一轮
 *   done → pending           用户重试
 *   error → pending          用户重试
 *   error → cancelled        用户移除（终态）
 *
 * 设计约束：
 *   - 本模块是纯函数，不依赖 Electron / 文件系统 / 网络
 *   - 所有转换必须通过 transition() 执行，便于审计和测试
 *   - 非法转换抛错，调用方决定如何处理
 */

const STATES = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

const TRANSITIONS = Object.freeze({
  pending: ['downloading', 'error', 'cancelled'],
  downloading: ['done', 'error', 'pending'],
  done: ['pending'],
  error: ['pending', 'cancelled'],
  cancelled: [],
});

/**
 * 检查转换是否合法（不抛错）
 * @param {string} from - 当前状态
 * @param {string} to - 目标状态
 * @returns {boolean}
 */
function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * 执行状态转换
 * @param {Object} song - 任务对象
 * @param {string} to - 目标状态
 * @param {string} [reason] - 转换原因（用于审计）
 * @returns {Object} 任务对象（便于链式调用）
 * @throws {Error} 非法转换时抛错
 */
function transition(song, to, reason) {
  if (!song || typeof song !== 'object') {
    throw new Error('[statemachine] 任务对象不能为空');
  }
  const from = song.status || 'pending';
  if (!canTransition(from, to)) {
    throw new Error(`[statemachine] 非法状态转换: ${from} → ${to} (${reason || '未说明原因'})`);
  }
  song.status = to;
  song._lastTransition = { from, to, at: Date.now(), reason: reason || null };
  return song;
}

/**
 * 获取转换历史
 * @param {Object} song - 任务对象
 * @returns {Array<{from, to, at, reason}>}
 */
function getTransitionHistory(song) {
  if (!song || !song._transitionHistory) return [];
  return [...song._transitionHistory];
}

/**
 * 记录转换历史（内部使用）
 * @param {Object} song - 任务对象
 * @param {string} from - 原状态
 * @param {string} to - 目标状态
 * @param {string} [reason] - 原因
 */
function _recordTransition(song, from, to, reason) {
  if (!song._transitionHistory) song._transitionHistory = [];
  song._transitionHistory.push({ from, to, at: Date.now(), reason: reason || null });
  // 只保留最近 10 条，防止内存泄漏
  if (song._transitionHistory.length > 10) {
    song._transitionHistory = song._transitionHistory.slice(-10);
  }
}

/**
 * 包装 transition() 并自动记录历史
 * @param {Object} song - 任务对象
 * @param {string} to - 目标状态
 * @param {string} [reason] - 原因
 * @returns {Object} 任务对象
 */
function transitionWithHistory(song, to, reason) {
  const from = song.status || 'pending';
  const result = transition(song, to, reason);
  _recordTransition(song, from, to, reason);
  return result;
}

/**
 * 获取当前所有合法转换
 * @param {string} from - 当前状态
 * @returns {string[]}
 */
function getAllowedTransitions(from) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) ? [...allowed] : [];
}

module.exports = {
  STATES,
  TRANSITIONS,
  canTransition,
  transition,
  transitionWithHistory,
  getTransitionHistory,
  getAllowedTransitions,
};
