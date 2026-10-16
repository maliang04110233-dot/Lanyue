/**
 * A-B 区间循环播放 —— 「副歌循环听」
 *
 * 三态点段：播放器「更多」菜单一项点三次成环 ——
 *   无 → 以当前进度设 A 点；有 A 无 B → 播到想要处再点设 B（须晚于 A）；
 *   已有 A+B → 清除。timeupdate 捕获监听在 cur 触到 B 时把进度拨回 A，
 *   换曲（loadstart）自动清段，避免把循环点错带到下一首。
 * 纯逻辑（状态机/回跳判定/格式化）export 供 node:test，顶层不触碰 document。
 */

/** 秒 → m:ss（循环点展示够用，不需要小时位） */
export function mmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 回跳判定：两端齐且有效、cur 已触到 B（0.05s 容差）→ 返回应拨回的 A，否则 null */
export function abRewindTo(cur, a, b) {
  if (a == null || b == null || !(b > a)) return null;
  return cur >= b - 0.05 ? a : null;
}

/**
 * 点段状态机（不修改入参）：返回 {st, msg, bad}。
 * st 恒为 {} | {a} | {a,b}；bad=true 表示本次点击无效（B 早于 A），维持原状。
 */
export function abAdvance(cur, st) {
  const t = Math.max(0, Number(cur) || 0);
  if (st && st.a != null && st.b != null) return { st: {}, msg: '已清除 A-B 循环' };
  if (st && st.a != null) {
    if (!(t > st.a)) return { st, msg: 'B 点须晚于 A 点（' + mmss(st.a) + '），继续播放到目标位置再点', bad: true };
    return { st: { a: st.a, b: t }, msg: '循环区间 ' + mmss(st.a) + ' – ' + mmss(t) };
  }
  return { st: { a: t }, msg: '已设 A 点 ' + mmss(t) + '，播到结尾处再点一次设 B' };
}

/**
 * 是否设过任一端点。判据必须是 != null：A 点落在第 0 秒也是设过。
 * 「清除」和「换曲自动清」两条路共用它 —— 一份判据只留一个出处，
 * 曾经清除那处用假值判断端点，A=0 时就永远清不掉。
 */
export function abHasPoints(st) {
  return !!(st && (st.a != null || st.b != null));
}

/** 菜单徽标文案：'' | 'A 1:20 已选' | '1:20–2:45' */
export function abLabel(st) {
  if (st && st.a != null && st.b != null) return mmss(st.a) + '–' + mmss(st.b);
  if (st && st.a != null) return 'A ' + mmss(st.a) + ' 已选';
  return '';
}

// ── 运行时（浏览器侧）────────────────────────────────
let _st = {};

function _audio() {
  return typeof document === 'undefined' ? null : document.getElementById('audioPlayer');
}

function _syncUi() {
  if (typeof document === 'undefined') return;
  const badge = document.getElementById('abLoopVal');
  if (badge) badge.textContent = abLabel(_st);
}

function abLoopClick() {
  const au = _audio();
  if (!au) { showToast('播放器未就绪', 'warn', 2000); return; }
  const r = abAdvance(au.currentTime, _st);
  _st = r.st;
  _syncUi();
  showToast(r.msg, r.bad ? 'warn' : 'success', 3000);
}

function clearAbLoop() {
  if (!abHasPoints(_st)) return;
  _st = {};
  _syncUi();
  showToast('已清除 A-B 循环', 'success', 2000);
}

/**
 * 当前 A-B 区间（两端齐全才返回），供「导出片段」等下游功能读取。
 * 返回副本：外部改了不该污染循环状态本身。
 */
export function getAbRegion() {
  return _st.a != null && _st.b != null ? { a: _st.a, b: _st.b } : null;
}

if (typeof document !== 'undefined') {
  // timeupdate/play/loadstart 在 audio 上不冒泡但可捕获，无需 player.js 埋点
  document.addEventListener('timeupdate', () => {
    const au = _audio();
    if (!au) return;
    const back = abRewindTo(au.currentTime, _st.a, _st.b);
    if (back != null) au.currentTime = back;
  }, true);
  document.addEventListener('loadstart', () => {
    if (abHasPoints(_st)) { _st = {}; _syncUi(); }
  }, true);
  window.abLoopClick = abLoopClick;
  window.clearAbLoop = clearAbLoop;
  setTimeout(_syncUi, 300); // 与歌词偏移徽标同款兜底：菜单首开前不残留脏值
}
