/**
 * 全库音质扫描：纯逻辑（目标去重 / 顺序 runner / 汇总 / 报告文案）+ 报告弹层。
 * UI 编排在 views/local.js（复用 _probeCache，扫描结果即时进入行内缓存）。
 * 本模块顶层不触碰 document / api，node 可直接单测。
 */

// ── 纯函数 ───────────────────────────────────────────

/**
 * 收集待扫描曲目：按 filePath 去重，跳过已实测过的（cachedPaths 需有 .has()）。
 * @returns {{targets: Array, cached: number}}
 */
function collectProbeTargets(songs, cachedPaths) {
  const seen = new Set();
  const targets = [];
  let cached = 0;
  for (const s of (songs || [])) {
    if (!s || typeof s.filePath !== 'string' || !s.filePath || seen.has(s.filePath)) continue;
    seen.add(s.filePath);
    if (cachedPaths && typeof cachedPaths.has === 'function' && cachedPaths.has(s.filePath)) { cached++; continue; }
    targets.push(s);
  }
  return { targets, cached };
}

/** 顺序扫描 runner：一次只跑一个探测进程，支持外部取消与进度回调。 */
async function runSequentialScan({ items, worker, isCancelled, onProgress }) {
  const results = [];
  const list = items || [];
  let cancelled = false;
  for (let i = 0; i < list.length; i++) {
    if (isCancelled && isCancelled()) { cancelled = true; break; }
    let r;
    try {
      r = await worker(list[i]);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    results.push(r);
    if (onProgress) {
      try { onProgress(i + 1, list.length, r, list[i]); } catch (_e) { /* 进度回调异常不应中断扫描 */ }
    }
  }
  return { results, cancelled };
}

/** 汇总各判定计数（缺 ok 或 ok!==true 一律算失败）。 */
function summarizeProbe(results) {
  const sum = { total: (results || []).length, lossless: 0, suspicious: 0, lossy: 0, failed: 0 };
  for (const r of (results || [])) {
    if (!r || r.ok !== true) sum.failed++;
    else if (r.verdict === 'lossless') sum.lossless++;
    else if (r.verdict === 'suspicious') sum.suspicious++;
    else if (r.verdict === 'lossy') sum.lossy++;
    else sum.failed++;
  }
  return sum;
}

/** 一行式扫描结论（toast 文案）。 */
function probeReportLine(summary, cancelled) {
  const parts = [`✅ 真无损 ${summary.lossless}`, `⚠️ 存疑 ${summary.suspicious}`, `❌ 有损 ${summary.lossy}`];
  if (summary.failed) parts.push(`💥 失败 ${summary.failed}`);
  let line = `音质扫描：${parts.join(' · ')}`;
  if (cancelled) line += '（已取消，未扫完）';
  return line;
}

// ── 报告弹层（仅非无损曲目清单，复用 edit-overlay 体系） ─────────

function closeProbeReport() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('probeReportOverlay');
  if (el) el.remove();
}

/**
 * @param {Array<{icon:string, text:string}>} items
 */
function showProbeReportModal(items) {
  if (typeof document === 'undefined') return;
  closeProbeReport();
  const overlay = document.createElement('div');
  overlay.id = 'probeReportOverlay';
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', 'closeProbeReport');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeProbeReport(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  title.textContent = `🔬 音质扫描报告（${items.length}）`;
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.setAttribute('data-ico', 'x');
  close.setAttribute('data-ico-only', '');
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeProbeReport);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const list = document.createElement('div');
  list.className = 'sched-list';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'sched-job';
    const icon = document.createElement('span');
    icon.className = 'sched-job-time';
    icon.textContent = it.icon || '';
    const lines = document.createElement('span');
    lines.className = 'sched-job-lines';
    lines.textContent = it.text || '';
    row.appendChild(icon);
    row.appendChild(lines);
    list.appendChild(row);
  }
  body.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'edit-footer';
  const okBtn = document.createElement('button');
  okBtn.className = 'edit-btn-cancel';
  okBtn.textContent = '关闭';
  okBtn.addEventListener('click', closeProbeReport);
  footer.appendChild(okBtn);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

// ── 桥接 ─────────────────────────────────────────────
if (typeof document !== 'undefined') {
  window.closeProbeReport = closeProbeReport;
}

export {
  collectProbeTargets,
  runSequentialScan,
  summarizeProbe,
  probeReportLine,
  showProbeReportModal,
  closeProbeReport,
};
