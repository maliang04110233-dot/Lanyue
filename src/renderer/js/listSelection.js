/**
 * 列表多选的**动作逻辑**（勾选/连选/全选/清空/选中条同步）——无自有状态
 *
 * 为什么抽这个：四个列表（歌单详情 / 播放队列 / 下载队列 / 本地曲库）各写一遍
 * 几乎逐字相同的六件套——enter / exit / toggle / selectAll / deselectAll /
 * 选中条同步。任何一处修「清空后锚点还指着不在选态里的行」这类边界，都要改
 * 四个地方、漏一处就行为不一致。收敛成一处后，边界只有一个事实源。
 *
 * 关键设计——**状态由视图持有，工厂只出动作**：视图把自己的
 * {模式位, 选中集, 锚点} 以钩子交给工厂，工厂不复制状态。这样：
 *   ① 视图里那几十处直接读 _selectedLocal / _localSelectionMode 的地方
 *      （渲染行、批量改、导出、批量重命名…）一行都不用动，行为逐字不变；
 *   ② 工厂可被 node 直接单测（不进 DOM、不 import 视图），
 *      符合本仓「可测文件不拖 DOM 进图」约定（见 toast.js 头注）。
 *
 * 与 selectionRange.js 的分工：那个是**纯函数**（Shift 连选区间数学，锚点存
 * 键不存行号），已共享；本文件只管有状态的外壳动作，区间数学转调给它。
 *
 * DOM 契约（默认适配本地曲库，其余列表按需覆盖 id）：
 *   选中条 <div id="{barId}">，计数 <b id="{countId}">，行勾选框 "{cbPrefix}{idx}"。
 */

import { isRangeClick, rangeKeys } from './selectionRange.js';

/**
 * @param {object} cfg
 * @param {() => boolean} cfg.isMode              读模式位
 * @param {(v:boolean)=>void} cfg.setMode         写模式位
 * @param {Set<string>} cfg.getSet                视图持有的选中集（工厂直接操作，不复制）
 * @param {() => (string|null)} cfg.getAnchor     读 Shift 锚点
 * @param {(k:string|null)=>void} cfg.setAnchor   写 Shift 锚点
 * @param {() => string[]} cfg.getViewKeys        当前视图序的行键（过滤+排序后）
 * @param {() => void} cfg.onRender               选态变化后重绘高亮
 * @param {(raw:string)=>string} [cfg.decodePath] 解码行上的值（默认原样）
 * @param {string} [cfg.barId] [cfg.countId] [cfg.cbPrefix] DOM id 覆盖
 * @param {(n:number)=>void} [cfg.onCountChange] 计数变化钩子（测试/埋点）
 */
function createListSelection(cfg) {
  const barId = cfg.barId;
  const countId = cfg.countId;
  const cbPrefix = cfg.cbPrefix;
  const getViewKeys = cfg.getViewKeys;
  const onRender = cfg.onRender || (() => {});
  const decodePath = cfg.decodePath || ((x) => x);
  const set = cfg.getSet();

  function syncBar() {
    const n = set.size;
    if (cfg.onCountChange) cfg.onCountChange(n);
    const bar = document.getElementById(barId);
    if (!bar) return;
    if (!cfg.isMode()) { bar.style.display = 'none'; return; }
    const count = document.getElementById(countId);
    if (count) count.textContent = String(n);
    bar.style.display = 'flex';
  }

  function enter() {
    cfg.setMode(true);
    set.clear();
    cfg.setAnchor(null);
    onRender();
    syncBar();
  }

  function exit() {
    cfg.setMode(false);
    set.clear();
    cfg.setAnchor(null);
    onRender();
    syncBar();
  }

  /** 勾选/取消一行；Shift 把「锚点 → 本次点击」整段并进来（只并入不清空）。 */
  function toggle(idx, keyOrEncoded, e) {
    const key = decodePath(keyOrEncoded);
    if (isRangeClick(e)) {
      const order = getViewKeys();
      if (order.includes(key)) {
        for (const k of rangeKeys(order, cfg.getAnchor(), idx)) set.add(k);
        onRender();
        syncBar();
        return;
      }
    }
    if (set.has(key)) set.delete(key);
    else set.add(key);
    cfg.setAnchor(key);
    // 只同步被点这一行的勾选框（局部），不重绘整表
    const cb = document.getElementById(cbPrefix + idx);
    if (cb) cb.checked = set.has(key);
    syncBar();
    onRender(); // 重绘高亮
  }

  /** 全选当前视图序（所见即所得）。 */
  function selectAll() {
    for (const k of getViewKeys()) set.add(k);
    onRender();
    syncBar();
  }

  function deselectAll() {
    set.clear();
    cfg.setAnchor(null); // 清空整批后，锚点指向的行已不在选态里
    onRender();
    syncBar();
  }

  return { enter, exit, toggle, selectAll, deselectAll, syncBar };
}

export { createListSelection };
