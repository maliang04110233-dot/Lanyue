/**
 * 打包冒烟门禁的判据（纯函数）—— scripts/smoke-asar.js 的检查逻辑住这里
 *
 * 为什么单独一个文件：smoke-asar.js 顶层就 `process.exit()`，测试 require 它会把自己干掉。
 * 判据抽成纯函数才能像 191 那样"扫描器自带自测"（test/smoke-asar-criteria.test.js）。
 * 只准用 node 内建模块：scripts/ 不在 check:dead-deps 的扫描面里，门禁工具拖进第三方包
 * 是没人报警的依赖增长。
 */

'use strict';

/**
 * 剥离 JS 注释后再做符号断言。
 * 必须如此：bundle 是压缩产物，若某行 `window.resetEq = resetEq;` 被注释掉，
 * 裸正则仍会命中注释文本，把「断链」误报成「已挂载」——守卫就白设了。
 * 块注释用等长空格替换以保留行结构。
 */
function stripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 ESM 源码推导导出名（四种写法：function / async function / const-let-var / export{} 别名）。
 * 派生清单漏一种写法 = 那一类导出一律不在判据视野里（前 `export const` 就是隐形的）。
 * @param {string} src 源码文本（不是路径：读文件与判存在性归调用方）
 * @returns {string[]} 升序去重
 */
function exportedNamesOf(src) {
  const code = stripJsComments(src);
  const acc = new Set();
  for (const m of code.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) acc.add(m[1]);
  for (const m of code.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) acc.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) acc.add(n);
    }
  }
  return [...acc].sort();
}

/** 把 NAME 的**声明处**（含 export 头与 export{} 清单）挖空，剩下的出现才是"被使用" */
function blankDeclarations(code, name) {
  const n = escapeRe(name);
  return code
    .replace(/export\s*\{[^}]*\}/g, (block) => (new RegExp(`\\b${n}\\b`).test(block) ? block.replace(new RegExp(`\\b${n}\\b`, 'g'), ' ') : block))
    .replace(new RegExp(`export\\s+(?:async\\s+)?function\\s+${n}\\b`, 'g'), ' ')
    .replace(new RegExp(`export\\s+(?:const|let|var)\\s+${n}\\b`, 'g'), ' ')
    .replace(new RegExp(`(^|[\\s{;])(?:async\\s+)?function\\s+${n}\\b`, 'g'), '$1 ')
    .replace(new RegExp(`(^|[\\s{;])(?:const|let|var)\\s+${n}\\b`, 'g'), '$1 ')
    .replace(new RegExp(`(^|[\\s{;])class\\s+${n}\\b`, 'g'), '$1 ');
}

/**
 * 本模块内部对 NAME 的真实使用次数（声明处与注释都不算）。
 * @param {string} src 本模块源码
 * @param {string} name 导出名
 * @returns {number}
 */
function internalUsesOf(src, name) {
  const code = blankDeclarations(stripJsComments(src), name);
  return (code.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) || []).length;
}

/**
 * ESM-only 导出里"哪都没人读"的那些（= 死导出）。
 *
 * 活路有两条，任一条成立即算活：
 *   ① 别的渲染模块提到它（跨模块 import / 调用）；
 * ② 本模块内部有调用点（导出只是为可测性，压缩器绝不会丢它 —— c664fdf 的
 *      matchPresetName 就是被旧判据按①单独判成孤儿、从此天天红的）。
 * 反过来：只有声明处提到自己、或只在别人的注释里出现过 ⇒ 仍然判死（189 的幽灵键同一把尺）。
 * @param {{selfSrc:string, otherSrc:string, names:string[]}} p
 * @returns {string[]} 按 names 原序返回无人使用的导出名
 */
function unownedEsmExports({ selfSrc, otherSrc, names }) {
  const others = stripJsComments(otherSrc);
  return names.filter((n) => {
    if (new RegExp(`\\b${escapeRe(n)}\\b`).test(others)) return false;
    return internalUsesOf(selfSrc, n) === 0;
  });
}

/**
 * 包是否早于源码（早于 ⇒ 包内内容锚点不代表当前代码，不能当判据）。
 * 用 mtime 而非 git：本脚本在打包机上跑，那里可能是浅克隆或 detached worktree。
 */
function isPackageStale({ packageMtime, newestInputMtime }) {
  return newestInputMtime > packageMtime;
}

const STALE_NOTE = 'app.asar 早于 src/ 最新改动 ⇒ 内容锚改判工作树 dist/ 产物；'
  + '发布前必须 npm run package 后复跑本脚本，否则验的是旧包';
const NO_BUNDLE_NOTE = '包内未找到渲染 bundle（postbuild/打包 files 漏拷？）：内容锚改判工作树 dist/';
const NOTHING_TO_JUDGE_NOTE = '包已陈旧且工作树没有 dist/ 产物 —— 先 npm run build（发布前还需 npm run package）再复跑本脚本';

/**
 * 选出「渲染层 bundle 内容断言」该判哪份产物。
 *
 * 分工（433eb5b 立的口径）：**内容**断言（逻辑有没有被 tree-shake、window 挂载在不在）
 * 判最新鲜的那份构建产物；**成员**断言（平台模块/拷贝清单/图标字节/依赖树）判包本身。
 * 旧包不该让内容断言天天红，但退化必须写在脸上，否则就成了"门禁绿着而没人重新打过包"。
 * @param {{asarBundle:string, distBundle:string, stale:boolean}} p 两份产物文本（缺则空串）
 * @returns {{text:string, from:'asar'|'dist'|'none', note:string}}
 */
function pickBundleSource({ asarBundle, distBundle, stale }) {
  if (!stale && asarBundle) return { text: asarBundle, from: 'asar', note: '' };
  if (distBundle) {
    return { text: distBundle, from: 'dist', note: stale ? STALE_NOTE : NO_BUNDLE_NOTE };
  }
  return { text: asarBundle || '', from: 'none', note: stale ? NOTHING_TO_JUDGE_NOTE : NO_BUNDLE_NOTE };
}

module.exports = {
  stripJsComments,
  exportedNamesOf,
  internalUsesOf,
  unownedEsmExports,
  isPackageStale,
  pickBundleSource,
};
