/**
 * MusicDL 渲染层 — 下载队列总览条
 *
 * 把 queueSnapshot 的计数与逐任务 download-progress 事件的实时速度/剩余
 * 聚合成一行「⬇ n 下载中 · m 排队 · 总速 X/s · 约剩 t · ❌ k 失败」。
 * 纯函数导出供 node:test；DOM 只在元素存在时写，模块加载不碰 document。
 */

// taskId -> 最近一次进度事件的速度/剩余/字节（main 端按 PROGRESS_THROTTLE_MS=120ms
// 节流，量级 = 并发数；这条注释以前写着「main 端已节流」而其实并没有，直到 2026-10-13）
const _live = new Map();

export function recordLive(info) {
  if (!info || info.id == null) return;
  _live.set(String(info.id), {
    speedBps: Number(info.speedBps) || 0,
    etaSec: info.etaSec,
    receivedBytes: Number(info.receivedBytes) || 0,
    totalBytes: Number(info.totalBytes) || 0,
  });
}

/** 清掉已出队任务的历史进度，防 _live 无界增长 */
export function pruneLive(items) {
  const ids = new Set((items || []).map(s => String(s.taskId)));
  for (const key of _live.keys()) if (!ids.has(key)) _live.delete(key);
}

export function computeQueueSummary(items) {
  const sum = {
    downloading: 0, pending: 0, done: 0, error: 0,
    speedBps: 0, remainSec: null, receivedBytes: 0, totalBytes: 0,
  };
  for (const s of items || []) {
    if (s.status === 'downloading') {
      sum.downloading++;
      const live = _live.get(String(s.taskId));
      if (!live) continue;
      sum.speedBps += live.speedBps;
      sum.receivedBytes += live.receivedBytes;
      sum.totalBytes += live.totalBytes;
      // 并发下载时整队列约在「最慢的那个」完成，取 max
      if (Number(live.etaSec) > 0) sum.remainSec = Math.max(sum.remainSec || 0, live.etaSec);
    } else if (s.status === 'pending') sum.pending++;
    else if (s.status === 'done') sum.done++;
    else if (s.status === 'error') sum.error++;
  }
  return sum;
}

export function summaryText(sum, fmtBytes, fmtEta) {
  if (!sum || (!sum.downloading && !sum.pending)) return '';
  const parts = [];
  if (sum.downloading) parts.push(`⬇ ${sum.downloading} 下载中`);
  if (sum.pending) parts.push(`${sum.pending} 排队`);
  if (sum.downloading && sum.speedBps > 0) parts.push(`总速 ${fmtBytes(sum.speedBps)}/s`);
  if (sum.downloading && sum.remainSec != null) parts.push(`约剩 ${fmtEta(sum.remainSec)}`);
  if (sum.error) parts.push(`❌ ${sum.error} 失败`);
  return parts.join(' · ');
}

function _fmtEta(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function _text(items) {
  // formatBytes 是渲染层全局；node 测试里没有声明，typeof 兜底避免 ReferenceError
  const fmtBytes = typeof formatBytes === 'function' ? formatBytes : (n => n + 'B');
  return summaryText(computeQueueSummary(items), fmtBytes, _fmtEta);
}

/** 刷新总览条（快照渲染后 + 每次进度事件后调用） */
export function refresh(items) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('queueSummaryBar');
  if (!el) return;
  pruneLive(items);
  const text = _text(items);
  if (text) { el.textContent = text; el.style.display = ''; }
  else { el.textContent = ''; el.style.display = 'none'; }
}

export function summaryLine(items) {
  return _text(items) || '队列当前没有进行中的任务';
}

if (typeof document !== 'undefined') {
  window.recordDlProgress = (info) => { recordLive(info); refresh(getState('queueSnapshot') || []); };
  window.refreshQueueSummary = () => refresh(getState('queueSnapshot') || []);
  window.showQueueSummaryToast = () => showToast(summaryLine(getState('queueSnapshot') || []), 'info', 3000);
}
