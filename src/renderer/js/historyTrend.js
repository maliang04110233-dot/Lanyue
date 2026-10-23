/**
 * 下载趋势面板：近 14 天按天柱状图 + 汇总
 *
 * 数据源复用 query-history（limit 300，seq 倒序即时间倒序），
 * 分桶/汇总/柱高都是纯函数便于 node 单测；弹层动态构建（与
 * batchProbe 的报告弹窗同一 edit-overlay 模式），不新增 CSS。
 */

import { errBrief } from './errBrief.js';

const DAY_MS = 86400000;
export const TREND_DAYS = 14;
export const TREND_SCAN_LIMIT = 300;

function _startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function _dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按本地日分桶（oldest → newest，最后一桶为 now 当天）。
 * 只统计 status==='done' 且 finishedAt 有效、落在窗口内的记录；
 * 未来时间戳（时钟漂移）与窗口外一律丢弃。
 */
export function bucketHistoryByDay(items, now, days = TREND_DAYS) {
  const n = days > 0 ? days : TREND_DAYS;
  const today = _startOfDay(Number(now) || Date.now());
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today - i * DAY_MS);
    out.push({ key: _dateKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0, bytes: 0 });
  }
  for (const it of items || []) {
    if (!it || it.status !== 'done') continue;
    const t = Number(it.finishedAt);
    if (!t) continue;
    const diff = Math.round((today - _startOfDay(t)) / DAY_MS);
    if (diff < 0 || diff >= n) continue;
    const b = out[n - 1 - diff];
    b.count++;
    b.bytes += Number(it.size) || 0;
  }
  return out;
}

/** 汇总：总首数 / 总字节 / 有下载的天数 / 峰值日（并列取较早一天） */
export function trendSummary(buckets) {
  let count = 0, bytes = 0, activeDays = 0, peak = null;
  for (const b of buckets || []) {
    count += b.count;
    bytes += b.bytes;
    if (b.count > 0) activeDays++;
    if (!peak || b.count > peak.count) peak = b;
  }
  return {
    count, bytes, activeDays,
    peakLabel: peak && peak.count > 0 ? peak.label : null,
    peakCount: peak ? peak.count : 0,
  };
}

/** 柱高百分比：非零柱最少给 8% 保证可见；count=0 返回 0 */
export function barPct(count, max) {
  if (!count || !max || max <= 0) return 0;
  return Math.max(8, Math.round((count / max) * 100));
}

function _closeTrendPanel() {
  const el = document.getElementById('trendOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _fmtBytes(n) {
  if (typeof formatBytes === 'function') return formatBytes(n);
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function _renderTrendModal(buckets, total) {
  _closeTrendPanel();
  const overlay = document.createElement('div');
  overlay.id = 'trendOverlay';
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeTrendPanel(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  const s = trendSummary(buckets);
  title.textContent = `📊 下载趋势 · 近 ${buckets.length} 天`;
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.setAttribute('data-ico', 'x');
  close.setAttribute('data-ico-only', '');
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', _closeTrendPanel);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const note = (total && total > buckets.reduce((a, b) => a + b.count, 0))
    ? `（基于最近 ${TREND_SCAN_LIMIT} 条记录）` : '';
  const peakLine = s.peakLabel ? ` · 峰值 ${s.peakLabel}（${s.peakCount} 首）` : '';
  const summary = document.createElement('div');
  summary.className = 'sched-job-lines';
  summary.textContent = `共 ${s.count} 首 · ${_fmtBytes(s.bytes)} · 活跃 ${s.activeDays} 天${peakLine}${note}`;

  const chart = document.createElement('div');
  chart.style.cssText = 'display:flex;align-items:flex-end;gap:6px;height:160px;margin-top:12px;';
  const max = buckets.reduce((a, b) => Math.max(a, b.count), 0);
  for (const b of buckets) {
    const col = document.createElement('div');
    col.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px;';
    col.title = `${b.label} · ${b.count} 首 · ${_fmtBytes(b.bytes)}`;
    const bar = document.createElement('div');
    const pct = barPct(b.count, max);
    bar.style.cssText = `width:70%;height:${pct}%;min-height:2px;border-radius:4px 4px 0 0;background:var(--accent, #4f8cff);opacity:${b.count ? 0.9 : 0.15};`;
    const lab = document.createElement('span');
    lab.style.cssText = 'font-size:10px;opacity:0.7;';
    lab.textContent = String(b.key.slice(8));
    col.appendChild(bar);
    col.appendChild(lab);
    chart.appendChild(col);
  }

  body.appendChild(summary);
  body.appendChild(chart);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

async function showTrendPanel() {
  try {
    const r = await api.queryHistory({ limit: TREND_SCAN_LIMIT });
    const items = (r && r.items) || [];
    const buckets = bucketHistoryByDay(items, Date.now(), TREND_DAYS);
    if (!buckets.some(b => b.count > 0)) {
      showToast('近期没有完成的下载记录，先去下几首吧', 'info', 2500);
      return;
    }
    _renderTrendModal(buckets, r && r.total);
  } catch (e) {
    showToast('趋势加载失败：' + errBrief(e), 'error');
  }
}

if (typeof document !== 'undefined') {
  window.showTrendPanel = showTrendPanel;
  window.closeTrendPanel = _closeTrendPanel;
}
