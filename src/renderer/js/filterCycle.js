/**
 * 「循环过滤/排序档位」按钮的共通动作：走一格 → 同步按钮文案(+.active) → 回调
 *
 * 为什么抽这个：本地曲库就有四枚这样的按钮（🧪 音质 / 🏷 完整度 / 🎞 格式 /
 * ↕ 排序），每枚都是「取 next 档 → 把文案/高亮算准 → 重新过筛」三行，却各写一遍；
 * 其余列表还有同构的。档位表与文案词表**留在各自的卫星模块**（localQualityFilter
 * 等已各自钉住并有单测），本文件只管"怎么把一次循环落到按钮上"这个动作。
 *
 * 为什么不并进 listSelection：那是"多选"的状态与动作；这是"单值档位轮转"，两者
 * 状态形状不同（Set+锚点 vs 一个枚举），合在一起反而糊。
 *
 * 契约（与各卫星保持一致，缺一不可）：
 *   · next(mode, ...extra)  走下一档；可能需要额外上下文（如格式档要看全集格式表）
 *   · label(mode)           当前档的按钮文案
 *   · isActive(mode)        这档是否"在筛"（决定 .active 高亮；纯排序轴可传 () => false）
 *
 * 刻意保留的行为细节（逐字照搬，别在重构里"顺手优化"）：
 *   · 必须回调到**重新过筛**（filter），不能只重画已算好的结果——后者换档等于没换。
 *   · 档位文案与 .active 必须一处算：分两处写迟早漂成"按钮亮着但视图没筛"。
 */

/**
 * @param {object} cfg
 * @param {string} cfg.btnId            按钮 DOM id
 * @param {() => string} cfg.getMode    读当前档
 * @param {(m:string)=>void} cfg.setMode 写当前档（工厂把 next 出来的新档交回）
 * @param {(m:string, ...extra:any[]) => string} cfg.next   取下一档
 * @param {(m:string) => string} cfg.label                  当前档文案
 * @param {(m:string) => boolean} [cfg.isActive]            该档是否高亮（默认 !== 'all'）
 * @param {(...extra:any[]) => void} cfg.onChange 换档后的回调（一般是重新过筛）
 * @param {() => any[]} [getExtra]       传给 next 的额外上下文（按次取，故 next 可多参）
 */
function createCycleButton(cfg) {
  const isActive = cfg.isActive || ((m) => m !== 'all');

  function sync() {
    const mode = cfg.getMode();
    const btn = document.getElementById(cfg.btnId);
    if (!btn) return;
    btn.textContent = cfg.label(mode);
    btn.classList.toggle('active', !!isActive(mode));
  }

  /** 走一格并落按钮 + 回调。extra 由 getExtra 在当次取，避免把上下文存成状态。 */
  function cycle() {
    const extra = cfg.getExtra ? cfg.getExtra() : [];
    const next = cfg.next(cfg.getMode(), ...extra);
    cfg.setMode(next);
    sync();
    cfg.onChange();
  }

  /** 只同步按钮（初始化用），不换档。 */
  function init() { sync(); }

  return { cycle, sync, init };
}

export { createCycleButton };
