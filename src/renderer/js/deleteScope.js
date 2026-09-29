/**
 * Delete 键的作用对象：注册表（不碰宿主）
 *
 * 各列表把**自己的批量动作**交出来（与批量按钮同一个函数，逐字复用，
 * 于是确认弹窗、toast、选中态清理都跟点击按钮完全一致），
 * 本模块只负责挑出「当前在场、且确有勾选」的那一个。
 *
 * 为什么优先级要显式写 order：播放队列面板是浮在其它页面上的抽屉，下载队列
 * 与本地曲库又是同层页面 —— 「按注册顺序决定谁优先」的写法会在某个视图挪进
 * DOM 之后静默换掉 Delete 的作用对象，而用户看到的症状叫「Delete 删错了东西」。
 * 小者优先，与平台 policies.order 同一口径。
 *
 * 不做的事：不给没有批量删除动作的列表发明 Delete 语义。本地曲库的选择条
 * 只有导出 m3u / 批量编辑 / 批量重命名（删文件是另一条更重、要碰磁盘的路径），
 * 所以它不注册作用域 —— 这不是遗漏，见 selectionRange.js 与该文件的接线。
 */

const _scopes = [];

/**
 * @param {{id:string, order:number, active:()=>boolean, count:()=>number, run:()=>*}} scope
 *   active()  = 该列表此刻是否在场（可见且处于多选模式）
 *   count()   = 已勾选的行数
 *   run()     = 该列表既有的批量动作，原样调用
 * 同 id 重复注册按覆盖处理（视图模块被重复 import 时不该堆出两条）。
 */
export function registerDeleteScope(scope) {
  if (!scope || !scope.id || typeof scope.active !== 'function'
    || typeof scope.count !== 'function' || typeof scope.run !== 'function') return;
  const at = _scopes.findIndex((s) => s.id === scope.id);
  if (at >= 0) _scopes.splice(at, 1);
  _scopes.push({ order: 0, ...scope });
  _scopes.sort((a, b) => a.order - b.order);
}

/** 挑出第一个「在场且有勾选」的作用域；都没有则 null。 */
export function pickDeleteScope() {
  for (const s of _scopes) {
    try {
      if (s.active() && s.count() > 0) return s;
    } catch { /* 判据抛错 = 该列表不在场，不打扰其它列表 */ }
  }
  return null;
}

/**
 * 对当前在场且有勾选的列表执行其批量动作。
 * @returns {boolean} 是否处理了这枚按键（false 时调用方**不要** preventDefault）
 */
export function runDeleteOnActiveScope() {
  const scope = pickDeleteScope();
  if (!scope) return false;
  scope.run();
  return true;
}

/** 测试面：清空注册表，避免用例之间互相污染。 */
export function _resetDeleteScopes() { _scopes.length = 0; }
