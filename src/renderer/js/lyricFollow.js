/**
 * 歌词滚动跟随暂停纯函数
 *
 * 自动居中跟随会在用户上翻看前文时强行拽回。规则：指针悬停在歌词区
 * 暂停跟随（离开即恢复）；滚轮翻动额外暂停一段「阅读宽限期」；点行跳播
 * 视为回到当前，立即恢复。状态是不可变小对象 {hover, until}，判定用
 * 传入的 now，方便 node 直测。
 */

export const FOLLOW_SCROLL_RESUME_MS = 5000;

export function createFollowState() {
  return { hover: false, until: 0 };
}

/** 纯函数：此刻是否允许自动滚动跟随 */
export function shouldAutoFollow(st, now) {
  if (!st || st.hover) return false;
  return !(st.until && now < st.until);
}

/** 纯函数：滚轮翻动 → 延长暂停到 now+ms（不缩短已有更长暂停） */
export function scrollPause(st, now, ms) {
  const until = now + (Number.isFinite(ms) ? ms : FOLLOW_SCROLL_RESUME_MS);
  return { hover: !!(st && st.hover), until: Math.max(until, (st && st.until) || 0) };
}

/** 纯函数：悬停进/出歌词区 */
export function hoverSet(st, on) {
  return { hover: !!on, until: (st && st.until) || 0 };
}

/** 纯函数：立即恢复跟随（点行跳播等「回到当前」语义） */
export function followReset() {
  return createFollowState();
}
