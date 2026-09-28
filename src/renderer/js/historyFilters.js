/**
 * 下载历史筛选 —— 纯函数（node 可单测，无 window 依赖）
 *
 * 主进程 history.query 早就支持 {source, status, keyword}，渲染层一直只接 keyword。
 * 这里把「页码 × 关键词 × 状态 × 来源」组合成查询 opts：任何维度变更须回第 0 页，
 * 空值一律不进 opts（避免 SQL 侧收到空串条件）。
 */

import { normalizeSortParam } from './historySort.js';

const HISTORY_STATUS_TABS = [
  { v: '', label: '全部' },
  { v: 'done', label: '成功' },
  { v: 'error', label: '失败' },
];

/** 归一筛选态：非法 status 丢弃、其余空值转 '' */
function normalizeHistoryFilter(f) {
  const src = f || {};
  const status = String(src.status || '');
  return {
    keyword: String(src.keyword || '').trim(),
    status: HISTORY_STATUS_TABS.some(t => t.v && t.v === status) ? status : '',
    source: String(src.source || '').trim(),
  };
}

/** 组合 queryHistory opts；页码由调用方在筛选变更后置 0 */
function buildHistoryQuery(src, page, pageSize) {
  const f = normalizeHistoryFilter(src);
  const opts = { limit: pageSize, offset: Math.max(0, page) * pageSize };
  if (f.keyword) opts.keyword = f.keyword;
  if (f.status) opts.status = f.status;
  if (f.source) opts.source = f.source;
  const sort = normalizeSortParam(src && src.sort);
  if (sort) opts.sort = sort;
  return opts;
}

/** 动态生成来源下拉的 option 清单（平台 manifest → [{v,label}]，含「全部来源」头） */
function sourceOptions(platforms) {
  const list = [{ v: '', label: '全部来源' }];
  for (const p of platforms || []) {
    if (p && p.id) list.push({ v: p.id, label: p.name || p.id });
  }
  return list;
}

/** 重试汇总 → toast 文案 */
function retrySummary(tally) {
  const t = tally || {};
  return `🔁 重试完成：入队 ${t.added || 0}、已在队列 ${t.dup || 0}、已下载跳过 ${t.had || 0}、失败 ${t.fail || 0}`;
}

/** 清理结果 → toast 文案（一条都没清掉时不许报成功） */
function deadSummary(removed, checked) {
  if (!removed) return `ℹ️ 已核对 ${checked || 0} 条成功记录，文件都在，没有需要清理的失效记录`;
  return `🧹 已清理 ${removed} 条文件已不存在的下载记录（本轮核对 ${checked || 0} 条，未改动磁盘上任何文件）`;
}

/**
 * 清理/重下前确认文案（154 加 mode）。三件事必须写在脸上：
 * 只删记录不动文件；文件"不在"不等于"没了" —— 整库挪盘时全部记录都会被判失效，
 * 这时用户该取消而不是确认，所以把补救办法一起给出（放回原目录 / 扫描后自动接回）；
 * 以及「删记录」和「重下这首歌」是两个不同意图，别把后者逼进前者。
 * @param {'delete'|'redownload'} mode
 */
function deadConfirmText(dead, checked, mode) {
  const list = dead || [];
  const shown = list.slice(0, 5).map(s => `  · ${s.title || s.id}${s.artist ? ' - ' + s.artist : ''}`).join('\n');
  const more = list.length > 5 ? `\n  …共 ${list.length} 条` : '';
  const head = `发现 ${list.length} 条记录的文件已不在磁盘上${checked ? `（本轮核对 ${checked} 条）` : ''}：\n${shown}${more}\n\n`;
  if (mode === 'redownload') {
    return head
      + '确认把这些歌重新加入下载队列？\n'
      + '· 历史记录先留着：重新下成后会自动更新成新路径\n'
      + '· 只想删记录、不想要这首歌了：改用「🧹 清理失效」\n'
      + '· 文件其实还在别处：先「取消」，把文件放回原目录或在本地曲库重新扫描（被改名的会自动接回）';
  }
  return head
    + '确认删除这些历史记录？\n'
    + '· 只删记录，磁盘上任何文件都不会被改动\n'
    + '· 歌若只是挪了目录/换了硬盘，请先「取消」：把文件放回原目录，或在本地曲库重新扫描（被改名的文件会自动接回）\n'
    + '· 还想再听这些歌：别删记录，用「⬇ 重新下载失效项」（命令面板 Ctrl+K 可搜到）';
}

/** 失效项重下汇总 → toast（一首都没入队时用 ℹ️，不给自己发成功） */
function deadRetrySummary(tally) {
  const t = tally || {};
  const icon = t.added ? '⬇' : 'ℹ️';
  return `${icon} 失效项重新下载：入队 ${t.added || 0}、已在队列 ${t.dup || 0}、`
    + `文件又回来了跳过 ${t.had || 0}、失败 ${t.fail || 0}`;
}

export { HISTORY_STATUS_TABS, normalizeHistoryFilter, buildHistoryQuery, sourceOptions, retrySummary, deadSummary, deadConfirmText, deadRetrySummary };
