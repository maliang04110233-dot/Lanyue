#!/usr/bin/env node
/**
 * 攻击面门禁 —— 让 audit-allowlist.json 里「server 从未启动」这句豁免理由
 * 每次都能被机器重新验证，而不是停留在上次的分析结论上。
 *
 * 背景（完整取证见 documents/adr/ADR-20261017-01）
 * ------------------------------------------------------------------
 * NeteaseCloudMusicApi/main.js 末尾有一句**无条件的**
 *   Object.assign(module.exports, require('./server'))
 * 加载 SDK 即把 express 整棵树拉进运行时 —— 所以 express/body-parser/
 * path-to-regexp 必须留在 asar 里（build/config.cjs 明令注释不可删）。
 * 但本项目对 SDK 的消费面只有 src/api/platforms/netease.js 的 10 个纯数据
 * 方法，server.js 的 HTTP 监听分支从未执行。「带漏洞的 express 4 在运行时
 * 存在」与「它能被远程 HTTP 请求打中」是两回事：前者要求供应链可信，后者
 * 才是真正的漏洞可达 —— 本检查把后者的判据固化下来，每次 CI 复核。
 *
 * 四条判据（对 src/ 全部 .js，用 check-dead-deps 的 codeMask 只看真代码：
 * 注释与字符串里的 createServer/listen 举例不算 —— 那正是文档注释最常
 * 出现的形态）
 *   A. 直达使用：分组包（express/body-parser/path-to-regexp）若被 src/
 *      下任何文件直接 require/import ⇒ 失败 —— 有人开始直接写 server 代码，
 *      「分组包无直接代码消费」的前提被打破。
 *   B. 打包前提：分组包不得被 build/config.cjs 排除 —— SDK 加载即 require
 *      它们，被排除必然 Cannot find module。与 check:dead-deps 互逆互补：
 *      那条闸防「被排除却被引用」（仓库自己的排除项失效），本条防
 *      「被引用却被排除」（上游打包前提失效）。
 *   C. 唯一消费面：require('NeteaseCloudMusicApi') 只允许出现在
 *      src/api/platforms/netease.js；显式子路径加载（…/server、…/main）
 *      直接失败 —— 那等于把 HTTP 服务实现拉进项目代码。
 *   D. 启动门：src/ 下 http.createServer / .listen( 的代码级出现点只允许
 *      在许可清单里（当前仅 src/main/mcp/mcpServer.js）。SDK 的 express
 *      若真被启动，必然产生新的 listen 语句 —— 本条必红。
 *
 * 与其他闸的关系：check:dead-deps 闸的是仓库自己的排除项；本检查闸的是
 * audit-allowlist.json 里 `upstream_locked_server_never_launched` 分组
 * 那句理由是否仍然成立。两条都是离线可复现检查，因此都串在 npm run
 * verify 链里（命名特意避开 "audit" 字样 —— verify 链钉有「不含 audit」
 * 的守卫，npm audit 的退出码歧义问题见 test/verify-chain.test.js）。
 *
 * 用法：node scripts/audit-attack-surface.cjs
 * 退出码：0 = 判据全绿；1 = 任一判据失败（须修复代码或重评并改写豁免理由）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { staticRefsIn, codeMask, excludedPackages } = require('./check-dead-deps.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRCDIR = path.join(ROOT, 'src');

/** 「server 从未启动」分组所承诺的包 —— audit-allowlist.json 同名组的机器判据侧 */
const GROUP = Object.freeze(['express', 'body-parser', 'path-to-regexp']);
const SDK = 'NeteaseCloudMusicApi';
const SDK_CONSUMER = 'src/api/platforms/netease.js';
/** 允许出现 HTTP 监听语句的文件（相对 ROOT 的正斜杠路径） */
const LISTEN_ALLOWED = Object.freeze(['src/main/mcp/mcpServer.js']);

const LISTEN_RE = /(?:\bhttp\s*\.\s*)?createServer\s*\(|\.\s*listen\s*\(/g;
// 字符类要同时收单/双引号：SDK 源码是单引号费 Style，本仓测试串里两种都有。
// 用字符类 ['"] 表达 —— 不玩 source.replace 字符串变形（多层转义会把替换
// 做到字符类字面量自身上，产出永远不匹配任何东西的正则）。
const SDK_SUBPATH_RE = /(?:require|import)?\s*\(?\s*'NeteaseCloudMusicApi\/(?:server|main)'|"(?:require|import)?\s*\(?\s*NeteaseCloudMusicApi\/(?:server|main)"/g;

function collectFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

/**
 * 攻击面判据本体（纯函数，测试从这里进）。
 * @param {object} cfg
 * @param {{relPath:string, src:string}[]} cfg.files
 * @param {Set<string>} cfg.excludedPackages build/config.cjs 的排除项
 * @param {string[]} [cfg.listenAllowed]
 * @param {string[]} [cfg.group]
 * @param {string} [cfg.consumer] SDK 唯一许可消费文件
 * @param {string} [cfg.sdk]
 * @returns {string[]} findings（空数组 = 通过）
 */
function evaluate(cfg) {
  const {
    files, excluded,
    listenAllowed = LISTEN_ALLOWED,
    group = GROUP,
    consumer = SDK_CONSUMER,
    sdk = SDK,
  } = cfg;
  const findings = [];
  const consumers = [];

  for (const f of files) {
    const refs = staticRefsIn(f.src, f.relPath);
    for (const p of group) {
      if (refs.has(p)) {
        findings.push('A ' + f.relPath + ' 直接引用了 ' + p
          + ' —— 「分组包无直接代码消费」不再成立，server 行为已进入项目代码，须重评豁免理由');
      }
    }
    if (refs.has(sdk)) consumers.push(f.relPath);

    const mask = codeMask(f.src);
    for (const m of f.src.matchAll(LISTEN_RE)) {
      if (!mask[m.index]) continue; // 注释/字符串里的举例不算
      if (!listenAllowed.includes(f.relPath)) {
        findings.push('D 启动门：' + f.relPath + ' 出现 createServer/listen —— 豁免理由的前提'
          + '「HTTP 监听分支不可达」被打破；若确需启动须重评 express 攻击面并改写 allowlist');
      }
    }
    for (const m of f.src.matchAll(SDK_SUBPATH_RE)) {
      if (!mask[m.index]) continue;
      findings.push('C 子路径加载：' + f.relPath + ' 直接加载了 ' + sdk
        + '/server 或 /main —— 显式引入 HTTP 服务实现，与「server 从未启动」互斥');
    }
  }

  for (const c of consumers) {
    if (c !== consumer) {
      findings.push('C 消费面扩散：' + c + ' 也加载了 ' + sdk
        + '（消费面必须唯一：' + consumer + '）');
    }
  }
  for (const p of group) {
    if (excluded.has(p)) {
      findings.push('B 打包前提破坏：' + p + ' 被 build/config.cjs 排除出 asar，但 ' + sdk
        + ' 加载即 require 它 —— 打包后启动必报 Cannot find module');
    }
  }
  // 同一文件里 createServer 与 .listen( 连写会对 D 命中两次 —— 去重，输出按 A/B/C/D 排
  return [...new Set(findings)];
}

function main() {
  const files = collectFiles(SRCDIR).map((abs) => ({
    relPath: path.relative(ROOT, abs).split(path.sep).join('/'),
    src: fs.readFileSync(abs, 'utf8'),
  }));

  console.log('攻击面门禁：扫描 src/ 下 ' + files.length + ' 个模块；'
    + '分组包 ' + GROUP.join('/') + '；启动许可 ' + LISTEN_ALLOWED.join('/'));

  const findings = evaluate({ files, excluded: excludedPackages() });
  if (findings.length) {
    console.error('\n✗ 攻击面判据失败（' + findings.length + ' 条）：');
    findings.forEach((f) => console.error('    ' + f));
    console.error('\n「server 从未启动」的豁免理由不再成立 —— 修复代码，或重评后改写'
      + ' scripts/audit-allowlist.json 的 upstream_locked_server_never_launched 组'
      + '（处置路线见 documents/adr/ADR-20261017-01）。');
    return 1;
  }

  console.log('\n✓ 四条判据全部成立：「server 从未启动」的豁免理由本轮重新复核通过。');
  return 0;
}

module.exports = { evaluate, GROUP, SDK, SDK_CONSUMER, LISTEN_ALLOWED };
// 判据纯函数导出给 test/audit-attack-surface.test.js；退出码只在被当脚本跑时交出
// （与 audit-gate.cjs / check-dead-deps.cjs 同一纪律 —— 顶层 exit 会把测试进程带走）。
if (require.main === module) process.exit(main());
