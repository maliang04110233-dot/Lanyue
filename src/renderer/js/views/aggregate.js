// ── 跨源聚合视图（3-B）────────────────────────────────────
// 把本地红心/多份平台歌单合并成一份，并标出跨源同曲的重复项。
// 数据由 api.aggregateCrossSource() 给（主进程只读聚合，见 commit 78057ae），
// 视图层只负责渲染与筛选，不再自己算一遍同曲判定。

let _aggState = null;      // 最近一次聚合结果
let _aggLoading = false;
let _aggFilter = 'all';    // all | dup | <source>
let _aggKeyword = '';

/** 拉一次聚合并渲染。opts: {sources?, playlists?, markDuplicates?, includeLocal?, orderMerged?}
 *  005「我的歌」默认开 includeLocal + orderMerged：本地曲库与红心同库混排，
 *  同曲簇代表优先本地副本（断网可播），成块相邻。 */
async function loadAggregated(opts = {}) {
  if (_aggLoading) return;
  _aggLoading = true;
  renderAggregated();
  try {
    const r = await api.aggregateCrossSource({ includeLocal: true, orderMerged: true, ...opts });
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

/** 当前筛选条件下可见的曲目（带原始下标——行内播放/下载经它回查，
 *  过滤后重排下标会点 A 播 B，与 songRowsHtml 同一条纪律） */
function _aggVisible() {
  const all = (_aggState && _aggState.songs) || [];
  const kw = _aggKeyword.trim().toLowerCase();
  return all
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => {
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
      + (_aggFilter === id ? ' selected' : '') + '>'
      + esc(id === 'local' ? t('mine.local') : (platformName(id) || id)) + '</option>'),
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

/** 单曲一行（i 为原始下标：行内播放/下载经 aggPlay/aggDownload 回查原数组） */
function _aggRowHtml({ s, i }) {
  const isLocal = s.source === 'local';
  const srcName = isLocal ? t('mine.local') : (platformName(s.source) || s.source || '');
  const badge = s._crossSource
    ? '<span class="agg-dup-badge" title="' + escAttr(t('aggregate.dupBadgeTitle', { count: s._dupCount })) + '">'
      + esc(t('aggregate.dupBadge', { count: s._dupCount })) + '</span>'
    : '';
  // 判不了 ≠ 不是重复：逐条点明原因，比只在统计栏给一个总数有用
  const undecidableTip = s._undecidable
    ? '<span class="agg-undecidable-badge" title="' + escAttr(t('aggregate.undecidableRowHint')) + '">'
      + esc(t('aggregate.undecidableBadge')) + '</span>'
    : '';
  // 在线条目但同簇里有本地副本：明示「已有本地版」（断网也能播的就是它）
  const hasLocalTip = (!isLocal && s._hasLocal)
    ? '<span class="variant-badge" title="' + escAttr(t('mine.hasLocalTip')) + '">'
      + esc(t('mine.hasLocal')) + '</span>'
    : '';
  // 只在跨源簇里的非代表条目上提示"优先用另一条"，避免用户下到取不到流的那条
  const primaryTip = (s._crossSource && s._primary === false)
    ? ' title="' + escAttr(t('aggregate.preferPrimary')) + '"' : '';
  // 本地文件没有"再下载"的意义；在线条目才给下载钮
  const dlBtn = isLocal ? '' :
    '<button class="btn-sm" title="' + escAttr(t('aggregate.download')) + '" data-ico="download" data-ico-only'
    + ' onclick="event.stopPropagation();aggDownload(' + i + ')"></button>';
  return '<div class="agg-row agg-song-row' + (s._primary === false ? ' merged-alt' : '') + '"' + primaryTip
    + ' onclick="aggPlay(' + i + ')" role="button" tabindex="0">'
    + '<span class="agg-src source-badge badge-' + (isLocal ? 'local' : badgeCls(s.source)) + '">' + esc(srcName) + '</span>'
    + '<span class="agg-title">' + esc(s.title || '') + '</span>'
    + '<span class="agg-artist">' + esc(s.artist || '') + '</span>'
    + badge
    + hasLocalTip
    + undecidableTip
    + '<span class="agg-dur">' + esc(fmtDuration(s.duration)) + '</span>'
    + '<span class="agg-actions">'
    + '<button class="btn-sm" title="' + escAttr(t('aggregate.play')) + '" data-ico="play" data-ico-only'
    + ' onclick="event.stopPropagation();aggPlay(' + i + ')"></button>'
    + dlBtn
    + '</span>'
    + '</div>';
}

/** 行内播放：本地文件直接 loadAndPlay（file:// 永远可播）；
 *  在线歌复用搜索页同一播放管线——playSong 按下标读 state.songs，
 *  所以先把本列表挂进去（切回搜索页时它自己的渲染链路会重写该键）。 */
async function aggPlay(i) {
  const s = _aggState && _aggState.songs[i];
  if (!s) return;
  if (s.filePath) { window.loadAndPlay(s); return; }
  setState('songs', _aggState.songs);
  if (typeof window.playSong === 'function') window.playSong(i);
}

/** 行内下载：本地条目无下载语义（本身就是文件），直接忽略 */
function aggDownload(i) {
  const s = _aggState && _aggState.songs[i];
  if (!s || s.source === 'local') return;
  setState('songs', _aggState.songs);
  if (typeof window.addDownload === 'function') window.addDownload(i);
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
  window.aggPlay = aggPlay;
  window.aggDownload = aggDownload;
}

/** 供诊断页/测试读取当前聚合快照 */
function getAggregatedState() {
  return _aggState;
}
