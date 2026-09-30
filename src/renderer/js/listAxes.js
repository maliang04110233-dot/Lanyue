/**
 * 「列表过滤/排序轴」的一组声明式装配
 *
 * 背景：一个列表工具栏上并列着若干条**单值档位轴**——收藏开关、格式、音质、
 * 完整度、排序。它们在语义上是同一件事（"一个可循环/可切换的档位 + 按钮文案 +
 * 是否在生效的高亮 + 换完重新过筛"），但此前各写一段装配：连着排 4 段
 * createCycleButton 配置，收藏开关又单独特判（它是布尔两态，不走 cycle）。
 * 加一条轴要复制一段接线，漏一处就"按钮能点但视图没筛"。
 *
 * 本文件把这件事收成**一张表 + 一个循环**：每条轴是一份纯数据描述
 * （档位怎么取下一格 / 文案 / 是否高亮 / 需要什么额外上下文），装配与
 * 换档动作统一由 createCycleButton 承担（见 filterCycle.js）。
 *
 * 刻意不做的事：
 *   · 不生成 DOM。工具栏是静态 HTML + data-i18n（见 index.html），
 *     那是本仓 i18n 与「工具栏精简」守卫的地基，JS 重建会把它们全掀了。
 *   · 不吞掉视图的函数名。cycleXxx / toggleXxx 仍是视图上的函数（window
 *     桥与命令面板按名字找），这里只替它们把"点一下"这件事接到对应轴。
 *
 * 收藏开关为什么也能进这张表：它是**两态**——next 恒为取反、label 随 mode、
 * 高亮=mode 本身。语义与 cycle 相同，只是档位表只有两格。
 */

import { createCycleButton } from './filterCycle.js';

/**
 * @typedef {object} Axis
 * @property {string} id            轴的稳定标识（也用作调试/测试定位）
 * @property {string} btnId         按钮 DOM id
 * @property {() => string} get     读当前档
 * @property {(v:string) => void} set 写当前档
 * @property {(m:string, ...extra:any[]) => string} next 取下一档
 * @property {(m:string) => string} label 当前档文案
 * @property {(m:string) => boolean} [isActive] 是否高亮（默认 m !== 'all'）
 * @property {() => any[]} [getExtra] 传给 next 的额外上下文（按次取）
 */

/**
 * 装配一组轴。
 *
 * @param {Axis[]} axes
 * @param {() => void} onChange 所有轴共用的换档回调（一般是重新过筛）
 * @returns {{ byId: Record<string, ReturnType<typeof createCycleButton>>, cycle: (id:string)=>void, init: () => void }}
 *   byId 供按 id 取某个轴（点菜单/命令面板时用）；cycle(id) 走一格；
 *   init() 同步全部按钮（首屏/重置时用，不换档）。
 */
function wireAxes(axes, onChange) {
  const byId = {};
  for (const a of axes) {
    byId[a.id] = createCycleButton({
      btnId: a.btnId,
      getMode: a.get,
      setMode: a.set,
      next: a.next,
      label: a.label,
      isActive: a.isActive,
      getExtra: a.getExtra,
      onChange,
    });
  }
  return {
    byId,
    cycle(id) {
      const b = byId[id];
      if (b) b.cycle();
    },
    init() {
      for (const k of Object.keys(byId)) byId[k].init();
    },
  };
}

export { wireAxes };
