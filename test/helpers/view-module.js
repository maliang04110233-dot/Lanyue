/**
 * 把一个 views/*.js 视图模块装进 node 测试里。
 *
 * 拦路虎只有一处：视图文件都静态 import ../i18n.js，而 i18n.js 静态 import 了
 * lang/*.json —— node 的 ESM 加载器要求 JSON 写 `with { type: 'json' }`，
 * 本仓 eslint 解析不了（见 test/toast-i18n.test.js:866 那枚哨兵）。本仓既有约定是
 * "取词函数当参数传进来"，但视图文件是**静态** import，改那条约定是另一个增量的活。
 *
 * 所以这里用 resolve 钩子把整张图里的 i18n.js 指向 test/helpers/i18n-stub.js：
 * 钩子作用在**解析**层，入口文件与它的所有依赖一次覆盖，不用改任何产品代码。
 * 替身读的是同一份 zh/en 语言包、取词语义与真身逐字一致（见 i18n-stub.js）。
 *
 * 视图模块本身仍需要浏览器全局（document / requestAnimationFrame / getState …），
 * 那部分由 fake-dom.js 的 installBrowserGlobals 提供 —— 必须在 import **之前**装好，
 * 因为模块顶层就有 document.addEventListener('dragstart', …) 与 window.xxx = …。
 */
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

const REPO = path.join(__dirname, '..', '..');
let _registered = false;
let _seq = 0;

function registerI18nRedirect() {
  if (_registered) return;
  // 用绝对 file URL 而不是相对 specifier：parentURL 的基准在不同入口下不一致
  // （从 test/*.test.js 走和从本文件自己走会解析到不同目录），绝对路径没这个歧义。
  const hooks = pathToFileURL(path.join(__dirname, 'i18n-redirect-hooks.js')).href;
  register(hooks, pathToFileURL(__filename).href);
  _registered = true;
}

/**
 * 装好钩子后加载一个视图模块（每次调用返回**新实例**）。
 *
 * 每次加缓存戳是有意的：视图模块顶层有会话级状态（_currentPlaylistId、
 * _plRenderToken、_plSongKw…）。共用一个实例会让上一条测试的过滤词/排序模式漏进下一条，
 * 那种红灯是"顺序不对"而不是"逻辑写错"，比假绿还难查。依赖模块（state.js 等）仍共享 ——
 * 它们是被 import 的单例，本来就该共享。
 */
async function loadView(rel, dom) {
  registerI18nRedirect();
  const url = pathToFileURL(path.join(REPO, rel)).href;
  const mod = await import(`${url}?ck=${++_seq}`);
  // state.js 模块顶层把 window.getState/setState 换成真 store，import 之后必须把
  // 测试的桩钉回去（详见 fake-dom.js 里 reinstall 的注释）
  if (dom && typeof dom.reinstall === 'function') dom.reinstall();
  return mod;
}

module.exports = { loadView, registerI18nRedirect, REPO };
