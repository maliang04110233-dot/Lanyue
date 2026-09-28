/**
 * 歌曲下载状态徽标（搜索/歌单等列表共用）
 *
 * 状态来源两级：
 * - 本次会话队列（调用方把 queue 快照传入，pending/downloading 实时）
 * - 跨会话已下载集合（启动后懒加载 queryHistory(status:'done') 一次 +
 *   queue-updated 里 observeQueue 增量补充 done）
 * 优先级：downloading > queued(pending) > done。
 */

const _downloaded = new Set(); // 'source:id' → 已下载（历史 ∪ 本次完成）
let _historyLoaded = false;
let _historyLoading = null;
const _listeners = []; // 多个列表视图各自订阅，互不覆盖

export function songDlKey(s) {
  if (!s || s.source == null || s.id == null) return null;
  return `${s.source}:${s.id}`;
}

/** done 事件回调（列表重渲染用），可注册多个 */
export function addDlChangeListener(fn) { if (typeof fn === 'function') _listeners.push(fn); }

function _fire() {
  for (const fn of _listeners) {
    try { fn(); } catch (_e) { /* 单个视图异常不拖垮其他订阅者 */ }
  }
}

/** queue-updated 驱动：吸收新的 done + 通知列表刷新 */
export function dlObserveQueue(queue) {
  if (Array.isArray(queue)) {
    for (const s of queue) {
      const k = s && songDlKey(s);
      if (k && s.status === 'done') _downloaded.add(k);
    }
  }
  _fire();
}

/** 懒加载一次下载历史（status:'done'）；重复调用返回同一 promise */
export function dlEnsureHistoryLoaded() {
  if (_historyLoaded) return Promise.resolve();
  if (_historyLoading) return _historyLoading;
  _historyLoading = Promise.resolve()
    .then(() => api.queryHistory({ status: 'done', limit: 100000 }))
    .then(r => {
      for (const e of (r && r.items) || []) {
        const k = songDlKey(e);
        if (k) _downloaded.add(k);
      }
      _historyLoaded = true;
      _fire();
    })
    .catch(() => { _historyLoading = null; /* 下次渲染再试 */ });
  return _historyLoading;
}

/** @param {object} s 歌曲（{source,id}） @param {Array} queue 当前队列快照 */
export function dlStatusFor(s, queue) {
  const k = songDlKey(s);
  if (!k) return null;
  let sawPending = false;
  if (Array.isArray(queue)) {
    for (const q of queue) {
      if (!q || songDlKey(q) !== k) continue;
      if (q.status === 'downloading') return 'downloading';
      if (q.status === 'pending') sawPending = true;
    }
  }
  if (sawPending) return 'queued';
  if (_downloaded.has(k)) return 'done';
  return null;
}

const _BADGES = {
  downloading: ['⬇ 下载中', '该歌曲正在下载'],
  queued:      ['⏳ 已加队', '已在下载队列中'],
  done:        ['✔ 已下载', '此前已成功下载'],
};

/**
 * 摘掉若干「✔ 已下载」徽标（清理死账记录之后必须同步）。
 * 集合是启动时从历史表灌进来的，历史行删了集合不会自己瘦 ——
 * 不摘的话，一首早被删掉的文件会一直顶着「已下载」，用户点了什么也不会发生。
 * @param {Array<string>} keys songDlKey 形状的键
 */
export function dlForgetKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  let changed = false;
  for (const k of keys) {
    if (typeof k === 'string' && _downloaded.delete(k)) changed = true;
  }
  if (changed) _fire();
}

/** 列表行内徽标 HTML（无状态返回空串；文本全部静态，无注入面） */
export function dlBadgeHtml(s, queue) {
  const st = dlStatusFor(s, queue);
  if (!st) return '';
  const [label, title] = _BADGES[st];
  return `<span class="dl-badge dl-badge-${st}" title="${title}">${label}</span>`;
}

/** 测试钩子：重置内部集合与加载标记 */
export function _resetDlStatus() {
  _downloaded.clear();
  _historyLoaded = false;
  _historyLoading = null;
  _listeners.length = 0;
}

if (typeof window !== 'undefined') {
  window.songDlKey = songDlKey;
  window.dlStatusFor = dlStatusFor;
  window.dlBadgeHtml = dlBadgeHtml;
  window.dlObserveQueue = dlObserveQueue;
  window.dlEnsureHistoryLoaded = dlEnsureHistoryLoaded;
  window.dlForgetKeys = dlForgetKeys;
  window.addDlChangeListener = addDlChangeListener;
}
