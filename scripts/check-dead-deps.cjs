#!/usr/bin/env node
/**
 * 死依赖检测 —— 复验 build/config.cjs 里那批 `!node_modules/xxx/**` 排除项
 * 是否仍然安全。
 *
 * 为什么需要这个脚本：
 *   build/config.cjs 排除了 jade 模版引擎依赖链（asar 减重 3.70 MB / 10.1%）。
 *   依据是「运行时从未加载 + 全仓无 require 引用」——但上游 SDK 一旦升级、
 *   或新增代码走了 jade 渲染的分支，排除项就会**静默**删掉运行时需要的包，
 *   而 npm 构建照样成功、大部分测试照样通过（因为测试不打包）。
 *   这类失效的症状是「用户机器上某个功能莫名其妙报 Cannot find module」。
 *   所以把它做成可复现检查，而不是一次性判断。
 *
 * 用法：
 *   node scripts/check-dead-deps.cjs           # 检查（CI 可跑）
 *   node scripts/check-dead-deps.cjs --verbose  # 打印运行时包全集
 *
 * 退出码：0 = 排除项仍安全；1 = 发现某个排除项被实际 require 了（必须处理）
 *
 * 为什么本文件能被 require：顶层原本就 `process.exit(main())`，测试
 * require 它会把自己一起干掉 —— 于是判据永远没有自测。191 立的那条律
 * 「扫描器必须自带自测」到本文件为止都没兑现过。现在退出码只在
 * `require.main === module` 时才交出去，纯函数照常导出给
 * test/dead-deps-scanner.test.js。
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// ── 从 build/config.cjs 读取当前的排除清单（单一事实来源，不重复维护）──
function excludedPackages() {
  const cfgPath = path.join(ROOT, 'build', 'config.cjs');
  const src = fs.readFileSync(cfgPath, 'utf8');
  const filesBlock = /files\s*:\s*\[([\s\S]*?)\]/.exec(src);
  if (!filesBlock) throw new Error('无法在 build/config.cjs 中定位 files 数组');
  const pkgs = new Set();
  for (const m of filesBlock[1].matchAll(/['"]!node_modules\/(@[^/'"]+\/[^/'"]+|[^/'"]+)\/\*\*['"]/g)) {
    pkgs.add(m[1]);
  }
  return pkgs;
}

// ── 源码扫描（纯函数，判据全在这里）────────────────────
// 为什么不能「stripComments 完直接裸正则」：本扫描器要找的模块名恰恰**住在字符串
// 里**（require('jade')），把字符串挖掉就什么都扫不出来；可只挖注释又漏掉两类假包名
//  ① 注释里举的例子：写文档时顺手写一句 // 运行时从不 require('jade')，CI 当场变红，
//     而全仓没有任何一行真的 require 过它 —— 排除项其实仍然安全，却没人敢碰；
//  ② 字符串里的 require(：文案/正则里出现 "…require('jade')…" 这段文本。
//     同批一起加进来的 DYN_SEG（动态 require 整段抽字面量）还多漏一类：
//     require(Buffer.from('x')) 里的 'x' 是 Buffer 的实参，不是模块名，pkgOf 却
//     对任何非内置裸串都原样返回，于是 'x' 被当成一个第三方包。
// 所以这里不改正文，只给每个下标打「这段是代码吗」的标：命中之后再问一句
// 「require 这个词自己是不是代码」。字面量一律整段跳过（故 regex 分支的定界符
// 标为代码、内容不标），动态 require 则只认**顶层实参**里的字面量 —— 模块名是
// require 的实参，不是实参里某个调用的实参。

/** 从引号下标起跳到收尾引号（尊重反斜杠转义）；返回收尾引号下标 */
function skipQuoted(src, q) {
  const quote = src[q];
  for (let i = q + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === quote) return i;
  }
  return src.length - 1;
}

/** 从 `/` 下标起跳过一个正则字面量（含尾随 flag）；返回下一个待处理下标 */
function skipRegexLiteral(src, i) {
  let inClass = false;
  for (let k = i + 1; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') { k++; continue; }
    if (c === '\n') return k + 1;            // 没闭合就当普通字符，绝不吞掉后面的代码
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      k++;
      while (k < src.length && /[a-z]/.test(src[k])) k++;
      return k;
    }
  }
  return src.length;
}

// `/` 到底是正则还是除号：看它前面那个「有意义的代码字符」。
// 除号的前驱永远是 ) ] 数字 标识符，正则的前驱是 ( , = : [ ! & | ? { } ; 换行 之类。
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n',
  '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof']);

/**
 * 源码 → 「哪些下标是真代码」的掩码（1 = 代码，0 = 注释 / 字符串正文 / 正则正文）。
 * 字面量的两个定界符标为代码：调用点的实参要从原文里读出来，靠的就是它们。
 * @param {string} src
 * @returns {Uint8Array} 与 src 等长
 */
function codeMask(src) {
  const text = String(src);
  const n = text.length;
  const mask = new Uint8Array(n);
  // 帧栈：{code:true, brace} 是代码上下文（brace 记 ${ } 深度）；
  // {code:false} 是模板字面量正文。两种上下文的字符规则完全不同，用栈才不用记状态机。
  const frames = [{ code: true, brace: 0 }];
  let prev = '';
  let i = 0;
  while (i < n) {
    const top = frames[frames.length - 1];
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (!top.code) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { mask[i] = 1; frames.pop(); prev = '`'; i++; continue; }
      if (c === '$' && c2 === '{') { frames.push({ code: true, brace: 1 }); i += 2; continue; }
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_PREV.has(prev))) {
      mask[i] = 1;
      i = skipRegexLiteral(text, i);
      prev = '/';
      continue;
    }
    if (c === '`') { mask[i] = 1; frames.push({ code: false, brace: 0 }); i++; continue; }
    if (c === "'" || c === '"') {
      mask[i] = 1;
      const close = skipQuoted(text, i);
      mask[close] = 1;
      i = close + 1;
      prev = c;
      continue;
    }
    if (c === '{') top.brace++;
    else if (c === '}' && top.brace > 0 && --top.brace === 0 && frames.length > 1) {
      mask[i] = 1;
      frames.pop();
      prev = '}';
      i++;
      continue;
    }
    mask[i] = 1;
    // 空白不算「前驱」：`= /re/` 的除号前是空格，若把空格记进 prev，
    // 后面那个 `/` 会被当成除号，整段正则正文都被标成代码（自测第一版就踩了这个）。
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return mask;
}

/** require 请求 → 包名（内建/相对/绝对路径返回 null，其余裸串原样当包名） */
function pkgOf(request, parent) {
  if (typeof request !== 'string' || request === '\0electron-stub') return null;
  // node: 前缀必须先摘掉再查内建表：Module.builtinModules 里只有 'path'，
  // 没有 'node:path'，漏了这一步会把 node:http / node:fs 之类的内建模块
  // 原样当成第三方包报进「源码静态引用」清单（自测时实测到）。
  if (Module.builtinModules.includes(request)
    || Module.builtinModules.includes(request.replace(/^node:/, ''))) return null;
  if (request.startsWith('.')) {
    const f = parent && parent.filename;
    const m = f && /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/]/.exec(f);
    return m ? m[1].replace(/\\/g, '/') : null;
  }
  if (/^[A-Za-z]:[\\/]/.test(request) || request.startsWith('/')) {
    const m = /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(request);
    return m ? m[1].replace(/\\/g, '/') : null;
  }
  const segs = request.replace(/\\/g, '/').split('/');
  return request.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
}

const LITERAL_REQ = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
const DYN_SEG = /require\s*\(\s*[^'")][^)]*\)/g; // 动态 require 整段

/**
 * 动态 require 实参里**顶层**的字符串字面量（模块名只可能是 require 的实参，
 * 不可能是实参里某个调用的实参 —— 那是 require(Buffer.from('x')) 的 'x'）。
 * @returns {string[]}
 */
function topLevelLiterals(text, mask, openIdx) {
  const out = [];
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (!mask[i]) continue;
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && (c === "'" || c === '"')) {
      const close = skipQuoted(text, i);
      out.push(text.slice(i + 1, close));
      i = close;
    }
  }
  return out;
}

/**
 * 一份源码静态引用到的第三方包名（纯函数 —— 本文件全部扫描判据的入口）。
 * @param {string} src 源码文本
 * @param {string} filename 归属路径（只用于相对 require 往上找 node_modules）
 * @returns {Set<string>}
 */
function staticRefsIn(src, filename) {
  const text = String(src);
  const mask = codeMask(text);
  const out = new Set();
  const add = (req) => {
    const p = pkgOf(req, { filename });
    if (p) out.add(p);
  };
  for (const m of text.matchAll(LITERAL_REQ)) {
    if (!mask[m.index]) continue; // 注释 / 字符串里的 require 举例不算引用
    add(m[1]);
  }
  for (const m of text.matchAll(DYN_SEG)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].indexOf('(');
    for (const lit of topLevelLiterals(text, mask, open)) add(lit);
  }
  return out;
}

// ── 运行时插桩：记录 src/ 全部模块真正 require 了哪些第三方包 ──
function runtimePackages() {
  const origResolve = Module._resolveFilename;
  const stub = new Proxy({}, {
    get: (_, k) => {
      const noop = () => {};
      switch (k) {
        case 'app': return { getPath: () => '.', getVersion: () => '0.0.0', getAppPath: () => '.',
          getName: () => 'x', isPackaged: false, whenReady: () => Promise.resolve(),
          on: noop, quit: noop, requestSingleInstanceLock: () => true,
          commandLine: { appendSwitch: noop } };
        case 'ipcMain':
        case 'ipcRenderer': return { handle: noop, on: noop, removeHandler: noop,
          invoke: () => Promise.resolve(), send: noop };
        case 'contextBridge': return { exposeInMainWorld: noop };
        case 'BrowserWindow': return class { static getAllWindows() { return []; } };
        case 'Menu': return { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
        case 'Tray': return class { setToolTip() {} setContextMenu() {} on() {} };
        case 'dialog': return { showOpenDialog: () => Promise.resolve({ canceled: true }),
          showMessageBox: () => Promise.resolve({}) };
        case 'shell': return { openExternal: noop, openPath: noop };
        case 'session': return { defaultSession: { webRequest: {
          onBeforeSendHeaders: noop, onHeadersReceived: noop } } };
        case 'screen': return { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) };
        case 'nativeTheme': return { shouldUseDarkColors: false, on: noop };
        case 'protocol': return { handle: noop };
        case 'net': return { fetch: () => Promise.resolve() };
        default: return () => ({});
      }
    },
  });
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return '\0electron-stub';
    return origResolve.call(this, request, ...rest);
  };
  require.cache['\0electron-stub'] = {
    id: '\0electron-stub', filename: '\0electron-stub', loaded: true, exports: stub,
  };

  const loaded = new Set();
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    const p = pkgOf(request, parent);
    if (p) loaded.add(p);
    return origLoad.apply(this, arguments);
  };

  // 遍历 src/（renderer 由 vite 打包，不进 main bundle，单独按需引入）
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'src'));

  // 静态扫描：require/import 字面量 + 动态 require(模板串) 的顶层字面量。
  // 插桩只覆盖「执行时真正走到」的路径；惰性分支（如仅在某 IPC 里
  // require 的 iconv-lite）在单测/本脚本遍历时不会触发，必须靠源码扫。
  const staticRefs = new Set();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (_e) { continue; }
    for (const p of staticRefsIn(src, f)) staticRefs.add(p);
  }

  const failures = [];
  for (const f of files) {
    try { require(f); }
    catch (e) {
      // preload.js 需要真实 electron 的 contextBridge 形态；其依赖
      // 已被主进程链覆盖，失败不影响结论
      failures.push(path.relative(ROOT, f) + ' → ' + (e.message || e).split('\n')[0]);
    }
  }
  return { loaded, staticRefs, failures, fileCount: files.length };
}

function main() {
  const excluded = excludedPackages();
  if (!excluded.size) {
    console.log('build/config.cjs 中没有 !node_modules/** 排除项，无需检查。');
    return 0;
  }

  console.log('检查 ' + excluded.size + ' 个被排除的包 …\n');
  const { loaded, staticRefs, failures, fileCount } = runtimePackages();
  // 运行时插桩 ∪ 源码静态引用：任一命中即视为「排除项不安全」。
  // 惰性 require 只会被静态扫描抓住，不会出现在 loaded 里。
  const referenced = new Set([...loaded, ...staticRefs]);
  console.log('运行时插桩：遍历 src/ 下 ' + fileCount + ' 个模块，'
    + '实际加载第三方包 ' + loaded.size + ' 个；源码静态引用 ' + staticRefs.size + ' 个');
  if (failures.length && VERBOSE) {
    console.log('（以下模块未能独立加载，其依赖已由主进程链覆盖）');
    failures.forEach(f => console.log('    ' + f));
  }
  if (VERBOSE) {
    console.log('\n运行时包全集：');
    console.log([...loaded].sort().map(s => '  ' + s).join('\n'));
  }

  const violations = [...excluded].filter(p => referenced.has(p)).sort();
  console.log('');
  if (violations.length) {
    console.error('✗ 发现被排除但运行时/源码确实引用的包（' + violations.length + ' 个）：');
    violations.forEach(p => console.error('    ' + p));
    console.error('\n这些包从 build/config.cjs 的 files 排除项中移除，否则打包后运行会报 Cannot find module。');
    return 1;
  }

  console.log('✓ 全部 ' + excluded.size + ' 个排除项均未被运行时加载，排除仍然安全。');
  return 0;
}

// 判据以纯函数形态导出给 test/dead-deps-scanner.test.js；退出码只在「被当脚本跑」
// 时交出去（见文件头）—— 否则测试 require 本文件会把自己一起 process.exit 掉。
module.exports = { codeMask, pkgOf, staticRefsIn, excludedPackages, runtimePackages };

if (require.main === module) process.exit(main());
