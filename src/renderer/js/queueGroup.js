/**
 * 下载队列「🧩 按平台分组」纯函数
 *
 * 状态标签（41/47）只能按阶段切，看不出「哪个平台在堵」——而单平台并发上限
 * （79）恰恰要按平台判断。这里只做数据聚合与选态切换，DOM 编排留给
 * views/download.js。
 */

const UNKNOWN_KEY = 'unknown';

/** 任务归属平台键：缺 source 的任务统一归 unknown 组（不丢弃），大小写归一 */
function platformKeyOf(task) {
  const s = task && task.source;
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v || UNKNOWN_KEY;
}

/**
 * 按平台聚合，保持组内原顺序。
 * @param {Array} tasks
 * @param {(key:string)=>string} [nameOf] 平台显示名（渲染层传 utils.platformName）
 * @returns {Array<{key,label,total,downloading,pending,done,error,tasks}>} 曲数多者在前，同数按名 zh 序
 */
function groupTasksByPlatform(tasks, nameOf) {
  const list = Array.isArray(tasks) ? tasks : [];
  const name = typeof nameOf === 'function' ? nameOf : (k) => k;
  const byKey = new Map();
  for (const t of list) {
    if (!t) continue;
    const key = platformKeyOf(t);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: name(key) || key, total: 0, downloading: 0, pending: 0, done: 0, error: 0, tasks: [] };
      byKey.set(key, g);
    }
    g.total += 1;
    if (t.status === 'downloading') g.downloading += 1;
    else if (t.status === 'pending') g.pending += 1;
    else if (t.status === 'done') g.done += 1;
    else if (t.status === 'error') g.error += 1;
    g.tasks.push(t);
  }
  return [...byKey.values()]
    .sort((a, b) => (b.total - a.total) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
}

/** 组标题：进行中（下载中+排队）/完成/失败，零计数段省略，全零时只报曲数 */
function groupHeaderLabel(g) {
  if (!g) return '';
  const parts = [];
  const running = (g.downloading || 0) + (g.pending || 0);
  if (running) parts.push(`进行中 ${running}`);
  if (g.done) parts.push(`完成 ${g.done}`);
  if (g.error) parts.push(`失败 ${g.error}`);
  const head = `${g.label} · ${g.total} 首`;
  return parts.length ? `${head}（${parts.join(' · ')}）` : head;
}

/** 折叠态切换：返回新集合，不改入参（渲染层用 Set 判成员） */
function toggleGroupCollapsed(collapsed, key) {
  const next = new Set(collapsed || []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 「只看该平台」切换：点同一个键即取消 */
function nextPlatformFilter(current, key) {
  const c = String(current || '');
  const k = String(key || '');
  return c === k ? '' : k;
}

export {
  UNKNOWN_KEY, platformKeyOf, groupTasksByPlatform, groupHeaderLabel,
  toggleGroupCollapsed, nextPlatformFilter,
};
