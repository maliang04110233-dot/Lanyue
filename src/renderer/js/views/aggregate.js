// ── 跨源聚合视图（3-B）────────────────────────────────────
// 把本地红心/多份平台歌单合并成一份，并标出跨源同曲的重复项。
// 数据由 api.aggregateCrossSource() 给（主进程只读聚合，见 commit 78057ae），
// 视图层只负责渲染与筛选，不再自己算一遍同曲判定。

let _aggState = null;      // 最近一次聚合结果
let _aggLoading = false;
let _aggFilter = 'all';    // all | dup | <source>
let _aggKeyword = '';

/** 拉一次聚合并渲染。opts: {sources?, playlists?, markDuplicates?} */
async function loadAggregated(opts = {}) {
  if (_aggLoading) return;
  _aggLoading = true;
  renderAggregated();
  try {
    const r = await api.aggregateCrossSource(opts);
    _aggState = {
      songs: Array.isArray(r && r.songs) ? r.songs : [],
      stats: (r && r.stats) || { total: 0, sources: 0, duplicates: 0, groups: 0, undecidable: 0 },
      failed: Array.isArray(r && r.failed) ? r.failed : [],
      truncated: (r && r.truncated && typeof r.truncated === 'object') ? r.truncated : {},
    };
  } catch (e) {
    logger.warn('聚合曲库失败:', e && e.message);
    _aggState = {
      songs: [],
      stats: { total: 0, sources: 0, duplicates: 0, groups: 0, undecidable: 0 },
      failed: [],
      truncated: {},
    };
  } finally {
    _aggLoading = false;
    renderAggregated();
  }
}

/** 当前筛选条件下可见的曲目 */
function _aggVisible() {
  const all = (_aggState && _aggState.songs) || [];
  const kw = _aggKeyword.trim().toLowerCase();
  return all.filter((s) => {
    if (_aggFilter === 'dup' && !s._crossSource) return false;
    if (_aggFilter !== 'all' && _aggFilter !== 'dup' && s.source !== _aggFilter) return false;
    if (!kw) return true;
    return (String(s.title || '') + ' ' + String(s.artist || '')).toLowerCase().includes(kw);
  });
}

function _aggSourceOptions() {
  const all = (_aggState && _aggState.songs) || [];
  const ids = [...new Set(all.map((s) => s.source).filter(Boolean))].sort();
  return [
    '<option value="all"' + (_aggFilter === 'all' ? ' selected' : '') + '>'
      + esc(t('aggregate.allSources')) + '</option>',
    '<option value="dup"' + (_aggFilter === 'dup' ? ' selected' : '') + '>'
      + esc(t('aggregate.onlyDup')) + '</option>',
    ...ids.map((id) => '<option value="' + escAttr(id) + '"'
      + (_aggFilter === id ? ' selected' : '') + '>' + esc(platformName(id) || id) + '</option>'),
  ].join('');
}

function _aggStatBar() {
  const st = (_aggState && _aggState.stats) || { total: 0, sources: 0, duplicates: 0, groups: 0, undecidable: 0 };
  const failed = (_aggState && _aggState.failed) || [];
  const parts = [
    esc(t('aggregate.statTotal', { count: st.total })),
    esc(t('aggregate.statSources', { count: st.sources })),
    esc(t('aggregate.statDupGroups', { count: st.groups })),
  ];
  let html = '<span class="agg-stats">' + parts.join(' · ') + '</span>';
  if (failed.length) {
    // 失败的源要点名，不能只说"有些源挂了"——用户不知道该检查哪张卡
    html += '<span class="agg-failed" title="' + escAttr(t('aggregate.failedHint')) + '">'
      + esc(t('aggregate.failedSome', { names: failed.join(', ') })) + '</span>';
  }
  // 判据不全的条目：这些歌**在**，只是没法判断是否跨源同曲。
  // 不说这句，用户会以为该平台没有这首歌。
  if (st.undecidable > 0) {
    html += '<span class="agg-undecidable" title="' + escAttr(t('aggregate.undecidableHint')) + '">'
      + esc(t('aggregate.undecidableSome', { count: st.undecidable })) + '</span>';
  }
  // 触达单源取数上限的来源：有数据，但只有前 N 首。
  // 与 failed 分开表述 —— failed 说"这个源没数据"，这里说"这个源数据不全"，
  // 混成一句话会让用户去反复重登一个其实能用的源。
  const truncated = (_aggState && _aggState.truncated) || {};
  const cutNames = Object.keys(truncated);
  if (cutNames.length) {
    // 各源上限相同，取任一即可（不一致时这里会显示最小值，属于偏保守的说法）
    const n = Math.min.apply(null, cutNames.map((s) => Number(truncated[s]) || 0));
    const names = cutNames.map((src) => platformName(src) || src).join('、');
    html += '<span class="agg-truncated" title="' + escAttr(t('aggregate.truncatedHint')) + '">'
      + esc(t('aggregate.truncatedSome', { n, names })) + '</span>';
  }
  return html;
}

/** 单曲一行 */
function _aggRowHtml(s) {
  const badge = s._crossSource
    ? '<span class="agg-dup-badge" title="' + escAttr(t('aggregate.dupBadgeTitle', { count: s._dupCount })) + '">'
      + esc(t('aggregate.dupBadge', { count: s._dupCount })) + '</span>'
    : '';
  // 判不了 ≠ 不是重复：逐条点明原因，比只在统计栏给一个总数有用
  const undecidableTip = s._undecidable
    ? '<span class="agg-undecidable-badge" title="' + escAttr(t('aggregate.undecidableRowHint')) + '">'
      + esc(t('aggregate.undecidableBadge')) + '</span>'
    : '';
  // 只在跨源簇里的非代表条目上提示"优先用另一条"，避免用户下到取不到流的那条
  const primaryTip = (s._crossSource && s._primary === false)
    ? ' title="' + escAttr(t('aggregate.preferPrimary')) + '"' : '';
  return '<div class="agg-row"' + primaryTip + '>'
    + '<span class="agg-src">' + esc(platformName(s.source) || s.source || '') + '</span>'
    + '<span class="agg-title">' + esc(s.title || '') + '</span>'
    + '<span class="agg-artist">' + esc(s.artist || '') + '</span>'
    + badge
    + undecidableTip
    + '</div>';
}

function renderAggregated() {
  const el = document.getElementById('aggregateList');
  const bar = document.getElementById('aggregateBar');
  if (!el || !bar) return;

  if (bar.dataset.built !== '1') {
    bar.dataset.built = '1';
    bar.innerHTML = '<select class="setting-select" style="width:auto" onchange="onAggFilter(this.value)">'
      + _aggSourceOptions() + '</select>'
      + '<input class="search-input" placeholder="' + escAttr(t('aggregate.filterPh')) + '"'
      + ' oninput="onAggKeyword(this.value)" style="max-width:220px;">'
      + '<button class="tab" onclick="loadAggregated()">' + esc(t('aggregate.refresh')) + '</button>'
      + '<span id="aggregateStatBar">' + _aggStatBar() + '</span>';
  } else {
    // 只换下拉与统计，保留输入框里用户正在敲的字
    const sel = bar.querySelector('select');
    if (sel) sel.innerHTML = _aggSourceOptions();
    const sb = document.getElementById('aggregateStatBar');
    if (sb) sb.innerHTML = _aggStatBar();
  }

  if (_aggLoading) {
    el.innerHTML = '<div class="setting-hint">' + esc(t('aggregate.loading')) + '</div>';
    return;
  }

  const list = _aggVisible();
  if (!list.length) {
    const emptyKey = (_aggState && _aggState.songs.length) ? 'aggregate.noMatch' : 'aggregate.empty';
    el.innerHTML = '<div class="setting-hint">' + esc(t(emptyKey)) + '</div>';
    return;
  }
  el.innerHTML = list.map(_aggRowHtml).join('');
}

function onAggFilter(v) {
  _aggFilter = String(v || 'all');
  renderAggregated();
}

function onAggKeyword(v) {
  _aggKeyword = String(v || '');
  renderAggregated();
}

// inline onclick 只能看到 window 上的东西，所以这些要显式导出
if (typeof window !== 'undefined') {
  window.loadAggregated = loadAggregated;
  window.renderAggregated = renderAggregated;
  window.onAggFilter = onAggFilter;
  window.onAggKeyword = onAggKeyword;
  window.getAggregatedState = getAggregatedState;
}

/** 供诊断页/测试读取当前聚合快照 */
function getAggregatedState() {
  return _aggState;
}
