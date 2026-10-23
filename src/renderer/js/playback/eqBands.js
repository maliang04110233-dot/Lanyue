/**
 * playback/eqBands.js — EQ 五段频段定义（**唯一事实来源**）
 *
 * 为什么抽出来
 * ------------
 * 此前 EQ_BANDS 在 engine.js:50-56 内联定义，注释写着「必须与
 * player/eq.js:36-42 逐字一致。这里复制而不是 import，是因为 eq.js 依赖
 * DOM，而引擎的硬约束是零 DOM 依赖」。
 *
 * 也就是说：当时为了绕开 eq.js 的 DOM 依赖，**复制**了一份定义，
 * 并靠一条守卫测试保证两份不漂移。交叉淡入淡出引入了第三个使用方
 * （playback/audioPool.js），复制会变成三份。
 *
 * 正确的解法：把纯数据抽到这个零依赖模块里，让 engine.js、audioPool.js
 * 直接 import，让 eq.js 也 import 它 —— 谁都不再复制，漂移从「靠测试盯」
 * 变成「结构上不可能」。
 *
 * 频段数值本身**一个字都没改**：与原 engine.js:50-56 完全一致，
 * 改它等于改 EQ 曲线手感。
 */

/**
 * EQ 五段频段定义。
 *
 * 链序固定：lowshelf → peaking×3 → highshelf。
 * 与原 engine.js 逐字一致（freq / type / Q=1）。
 */
export const EQ_BANDS = Object.freeze([
  { freq: 60, type: 'lowshelf' },
  { freq: 230, type: 'peaking' },
  { freq: 910, type: 'peaking' },
  { freq: 3600, type: 'peaking' },
  { freq: 14000, type: 'highshelf' },
]);
