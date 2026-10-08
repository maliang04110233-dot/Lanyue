/**
 * 本地曲库「现在到底在筛什么」—— 纯函数（node 可单测，零 DOM）
 *
 * 病根：档位轴一多，"看得见"和"筛得出来"就分家了。上一轮把长标签瘦成
 * 「🧪 真无损」，这一轮又把它们折进「🔽 筛选 ▾」——菜单一关，生效中的筛选
 * 就在视觉上消失（唯一残迹是菜单里那行 .active，而它得点开才看得见）。
 * 用户看到的是"列表莫名少了 800 首，但我没筛东西"。这里补一行只在外头露面的
 * chip：哪条轴筛到了哪档、点它单清、外加一键全清。
 *
 * 两条不能破的单一来源：
 *   · chip 文案**只从轴表算**（label(mode)），绝不另立一份词表 —— 两处词表迟早
 *     漂成"菜单里写『真无损』、外面写『实测真无损』"。
 *   · "哪些轴进 chip"只有 CHIP_AXIS_IDS 一张名单，且与菜单行同源 —— 加第五条轴
 *     忘了登记，chip 就会漏报（能筛却不报，比不折叠更糟）。
 *
 * 刻意不 import localFormatFilter / localQualityFilter / localMetaFilter：
 * 轴快照由调用方投影进来（见 views/local.js 的 _chipSource），档位表那边怎么重构
 * 都不影响这里，本模块也永远起不了进程、碰不到 document。
 */

import { escHtml } from './highlight.js';

/** 折进「🔽 筛选 ▾」且需要在外面报出的轴；顺序 = 菜单行顺序 = chip 显示顺序 */
const CHIP_AXIS_IDS = ['fmt', 'qual', 'meta'];

/** 关档值：等于"这条轴没筛" */
const OFF = 'all';

/**
 * 从轴快照挑出生效中的筛选。
 *
 * @param {{id:string, mode:string, label:(m:string)=>string}[]} axes 调用方投影的轴
 * @returns {{id:string, text:string}[]} 按 CHIP_AXIS_IDS 顺序，没筛则为空数组
 *
 * 只报登记过的轴：名单外（fav 有自身高亮、sort 不是筛选、脏 id）一律不出 chip，
 * 免得出现"排序也算一条筛选"这种把用户带偏的报数。
 */
function activeFilterChips(axes) {
  const list = Array.isArray(axes) ? axes : [];
  const byId = new Map(list.filter((a) => a && a.id).map((a) => [a.id, a]));
  const out = [];
  for (const id of CHIP_AXIS_IDS) {
    const a = byId.get(id);
    if (!a || typeof a.label !== 'function') continue;
    const mode = a.mode;
    if (mode === undefined || mode === null || mode === OFF) continue;
    const text = String(a.label(mode) || '').trim();
    if (text) out.push({ id, text });
  }
  return out;
}

/**
 * chip 行的 markup（可直接 innerHTML）。
 *
 * 文案走 escHtml：轴表现在全是白名单值（扩展名/枚举），但这里是 innerHTML 出口，
 * 不赌上游永远干净。✕ 是 glyph 不是新文案——本模块刻意不新增任何中文字面量，
 * 免得给 i18n 欠账台账添新账。
 *
 * @param {{id:string, text:string}[]} chips
 * @param {string} [resetFn] 单清回调名（window 桥）
 */
function filterChipsHtml(chips, resetFn = 'resetLocalFilterAxis') {
  const list = Array.isArray(chips) ? chips : [];
  return list
    .filter((c) => c && c.id && CHIP_AXIS_IDS.includes(c.id))
    .map((c) => {
      const text = escHtml(c.text);
      return `<button class="filter-chip" onclick="${resetFn}('${c.id}')" `
        + `title="${text}">${text}<span class="filter-chip-x">✕</span></button>`;
    })
    .join('');
}

export { CHIP_AXIS_IDS, activeFilterChips, filterChipsHtml };
