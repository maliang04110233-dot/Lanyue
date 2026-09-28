/**
 * 命令面板「最近使用」纯函数
 *
 * 记录 = id 前置去重 + 封顶；展示 = id 投影回命令对象（已下架的 id 静默跳过，
 * 命令清单改 id 不需要清存储）。localStorage 读写留在调用侧，这里零环境依赖。
 */

function recordRecent(list, id, cap = 8) {
  if (!id) return Array.isArray(list) ? list.slice() : [];
  const kept = (Array.isArray(list) ? list : []).filter(x => x && x !== id);
  return [id, ...kept].slice(0, Math.max(1, cap));
}

/** ids（新→旧）× 命令表 → 带「🕘 最近」组标的浅拷贝命令，顺序即最近顺序 */
function pickRecents(ids, cmds) {
  const byId = new Map();
  for (const c of (cmds || [])) {
    if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
  }
  const out = [];
  const used = new Set();
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const c = byId.get(id);
    if (!c || used.has(id)) continue;
    used.add(id);
    out.push({ ...c, group: '🕘 最近' });
  }
  return out;
}

export { recordRecent, pickRecents };
