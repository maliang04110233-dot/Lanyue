/**
 * 歌单详情：大库分片渲染引擎（阶段 4，从 views/playlist.js 抽出）。
 *
 * 四个函数是「作废 / 登记 / 排空 / 是否在跑」这套分片记账，只依赖 plState
 * 的可变对象，不碰业务写库、不做确认框。详情列表的视图管线（_plVisiblePairs）
 * 仍留在 views/playlist.js —— 它依赖若干纯函数模块的导入，抽走会把这些导入
 * 悬空，故本轮不动。
 *
 * 原文件里那些取舍说明（为什么分片函数要返回 Promise、settle 为何必须摘名单等）
 * 随实现一并搬来，见各函数 JSDoc —— 它们记录的都是实测踩过的坑。
 */
import { plState } from './state.js';

// 大库分片渲染：首屏同步出结果，其余按片 rAF 追加；token 防快速重筛竞态。
//
// 为什么渲染函数要**返回一个 Promise**：分片期间 DOM 里只有前几片，而
// locatePlayingInDetail（定位正在播放）与 _plRowUnder（拖拽落点）都要求
// 「全部行已在 DOM」。旧实现在首屏那一瞬就同步查一次，查不到就把"还没渲染完"
// 误报成 toast.plRowNotVisible（"该行当前不在可见列表（检查排序/过滤）"）——
// 一句完全错误的诊断，把用户往排序/过滤上带，而真正的原因只是分片没跑完。
// 所以"分片全部落地"的时刻必须交出去，让调用方 await 它再查。
//
// 三个视图（playlist 详情 / local 网格 / converter 列表）统一这一套约定。
// 不抽公共模块是因为抽出去就得新增一个 src 模块，超出本次改动面；这段只有
// 十来行、且三家形状完全一致，抄一份比新增跨视图依赖便宜。
// plState.PL_RENDER_CHUNK / plState._plRenderToken / plState._plRenderPending 已迁出到 plState（阶段 4 第 A 步）。

/**
 * 开一次新渲染：作废旧分片并立即结算它们（旧 await 方不该被新渲染拖住）。
 *
 * 顺序有讲究：先把 plState._plRenderPending 换成新名单**再**结算旧的。settle() 会把自己从
 * 名单里摘掉，若顺序反过来，旧的 d.settle() 去 splice 的就是刚登记进来的新分片。
 */
function _plInvalidateRender() {
  plState._plRenderToken++;
  const old = plState._plRenderPending;
  plState._plRenderPending = [];
  for (const d of old) d.settle();
}

/**
 * 登记一次分片渲染。settle 幂等 ——「跑完」与「被作废」两条路径都会调它。
 *
 * ⚠️ settle() 必须**把自己从 plState._plRenderPending 里摘掉**，不只是 resolve promise。
 * 这份名单有两个消费者，摘不摘的后果各有一条（2026-09 实测，两条都踩过）：
 *   · _plRenderBusy()（拖拽守卫）读它的 length —— 只结算不摘的话，渲染正常跑完
 *     之后名单依然非空，起拖被**永久**拒绝，歌单拖拽排序整个瘫掉（且症状是
 *     "把手按下去没反应"，极难归因到一行分片记账）；
 *   · _plRenderIdle()（等排空）按它 while —— 同样只结算不摘的话，循环永远转下去，
 *     "点定位"变成一次永不返回的 await。
 * 名单的语义因此是"**在跑**的分片"，不是"曾经跑过的分片"。
 */
function _plDeferRender() {
  let done = false;
  let settle;
  const promise = new Promise((res) => { settle = res; });
  const d = {
    promise,
    settle() {
      if (done) return;
      done = true;
      const i = plState._plRenderPending.indexOf(d);
      if (i >= 0) plState._plRenderPending.splice(i, 1);
      settle();
    },
  };
  plState._plRenderPending.push(d);
  return d;
}

/**
 * 等当前在跑的分片全部落地（被作废的那轮早已结算，不会永久挂起）。
 *
 * 为什么是循环而不是一次 Promise.all —— 这正是首版修法的漏网处（实测）：
 * 等待期间完全可能又来一次渲染（别的动作保存了歌单、收藏同步触发重画）。那一轮
 * 会把本轮的句柄**结算掉**并把自己登记进 plState._plRenderPending，于是"只等一次"的 await
 * 在**新那一轮才画完第一片**的时刻就返回；调用方紧接着 querySelector，第 150 行
 * 仍然不在 DOM 里，缺陷 1 原样复发，只是窗口比修之前窄得多（窄到更难复现）。
 * 循环把不变量说成"返回时没有分片在跑"，而不是"我等的那些跑完了"。
 *
 * 终止性：每一轮渲染都在有限帧内结算（rows.length/CHUNK + 1 帧），所以只要没有
 * 无限自我重绘的视图，循环必然收敛。而无限自我重绘的视图本来就是坏的（rAF 永远
 * 排满、CPU 满载），多转一圈不比它更糟 —— 不加人为上限正是这个取舍。
 */
async function _plRenderIdle() {
  while (plState._plRenderPending.length) {
    await Promise.all(plState._plRenderPending.map((d) => d.promise));
  }
}

/** 分片是否还在跑。拖拽起手守卫用：半个列表算出来的落点会写错序 */
function _plRenderBusy() {
  return plState._plRenderPending.length > 0;
}

export { _plInvalidateRender, _plDeferRender, _plRenderIdle, _plRenderBusy };
