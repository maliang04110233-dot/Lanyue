/**
 * 首页平台 tab —— 纯决策
 *
 * 只做「现在该显示哪个平台」的算术，一律不碰 DOM：
 * DOM 接线在 views/home.js，这样切换规则可单测、可被别的表面复用。
 *
 * 平台清单**从 HOME_PLATFORMS 注册表派生**，绝不在此抄第二份 ——
 * 注册表加一个平台，tab 顺序、循环回绕、回落默认值自动跟上。
 */

/** 记住上次所选平台的 localStorage 键 */
export const HOME_PLAT_LS_KEY = 'homeActivePlat';

/** 注册表 → 平台 id 顺序数组（脏项跳过，保持注册表原序） */
export function platIdsOf(platforms) {
  return (Array.isArray(platforms) ? platforms : [])
    .filter(p => p && typeof p.plat === 'string' && p.plat)
    .map(p => p.plat);
}

/**
 * 归一化所选平台：不在清单里（localStorage 存了个已下线平台、
 * 或调用方传了脏值）一律回落到首个平台，避免首页出现空白 tab。
 */
export function normalizePlatTab(ids, wanted) {
  if (!Array.isArray(ids) || !ids.length) return null;
  return ids.includes(wanted) ? wanted : ids[0];
}

/**
 * ← / → 循环切换：delta 取 ±1，两端回绕。
 * 当前项不在清单（含 null）时从首端开始，而不是抛错或原地不动。
 */
export function nextPlatTab(ids, current, delta) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const at = ids.indexOf(current);
  if (at < 0) return ids[0];
  const n = ids.length;
  const step = Number(delta) || 0;
  return ids[((at + step) % n + n) % n];
}
