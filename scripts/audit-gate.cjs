#!/usr/bin/env node
/**
 * npm audit 门禁 —— 豁免必须可复核，剩余高危仍然阻断
 *
 * 为什么不直接用 `npm audit --audit-level=high`
 * ------------------------------------------------
 * 那条命令只看「lock 里有没有漏洞」，不问「这份代码会不会真的被执行」。于是两种
 * 情况都算失败，而它们的处理方式完全相反：
 *   · 不可达且已排除出包（jade 依赖链）—— 产物里根本没有这份代码，升级它没有
 *     任何收益，只会把发版永久堵死；
 *   · 上游锁死（NeteaseCloudMusicApi 内置的 express 4.16.4 等）—— 根因在已发布的
 *     最新版上游包，跨大版本升级会破坏它的 HTTP 服务行为，只能等上游。
 *
 * 所以这里改成：读 scripts/audit-allowlist.json 的显式豁免（每条带理由与核查
 * 日期），过滤后**剩余的 high/critical 仍然退出码 1**。
 *
 * 三条纪律
 * --------
 * 1. 豁免项必须写理由。理由为空或缺字段 ⇒ 本脚本直接失败，不放行。豁免是判断，
 *    不是黑名单；没有理由的豁免等于悄悄关掉了这道门。
 * 2. `unreachable_*` 两组的依据是 scripts/check-dead-deps.cjs 的可达性判据
 *    （运行时插桩 ∪ 源码静态引用）。任何人把这些包加回运行路径，本脚本不报警，
 *    但 check:dead-deps 会红 —— 两条闸是配套的。
 * 3. 本脚本不吞掉 npm audit 的原始输出：豁免了什么、剩了什么，都打印出来。
 *
 * 用法：node scripts/audit-gate.cjs
 * 退出码：0 = 通过；1 = 有未豁免的 high/critical，或豁免清单本身不合规
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWLIST = path.join(ROOT, 'scripts', 'audit-allowlist.json');
// Windows 上 npm 是 npm.cmd（批处理文件），不能被 spawnSync 直接 CreateProcess
// （EINVAL），必须经由 shell；命令本身是固定字面量，不含任何外部输入。
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const LEVELS = ['critical', 'high'];

/** npm 在部分平台上会给 JSON 输出加 BOM，直接 JSON.parse 会炸 */
function parseAuditJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF+/, ''));
}

/**
 * 解析并校验豁免清单
 *
 * @param {object} [overrideRaw] 直接给清单内容（测试用）。不给则读磁盘。
 * @returns {{exempt:Map<string,string>, problems:string[]}}
 */
function loadAllowlist(overrideRaw) {
  let raw = overrideRaw;
  if (!raw) {
    if (!fs.existsSync(ALLOWLIST)) {
      console.error('缺少 scripts/audit-allowlist.json —— 豁免必须显式登记，不接受「先放过再说」');
      process.exit(1);
    }
    try { raw = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')); }
    catch (e) { console.error('audit-allowlist.json 解析失败：', e.message); process.exit(1); }
  }

  const exempt = new Map();      // pkg -> 分组
  const problems = [];
  for (const [group, entry] of Object.entries(raw)) {
    if (group.startsWith('_')) continue;
    if (!Array.isArray(entry.packages)) { problems.push(`${group} 缺 packages 数组`); continue; }
    if (typeof entry._why !== 'string' || entry._why.trim().length < 20) {
      problems.push(`${group} 的 _why 缺失或过短 —— 豁免必须写清理由`);
    }
    if (typeof entry._verified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry._verified)) {
      problems.push(`${group} 缺 _verified 日期（YYYY-MM-DD）—— 豁免需要知道何时核查过`);
    }
    for (const p of entry.packages) {
      if (exempt.has(p)) problems.push(`${p} 同时出现在 ${exempt.get(p)} 与 ${group}`);
      exempt.set(p, group);
    }
  }
  return { exempt, problems };
}

function runAudit() {
  const cmd = `${NPM} audit --omit=dev --json --registry=https://registry.npmjs.org`;
  try {
    return parseAuditJson(execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    // npm audit 发现漏洞时退出码非 0，但仍会把 JSON 写到 stdout
    if (e.stdout) { try { return parseAuditJson(e.stdout); } catch (_x) { /* fallthrough */ } }
    // 抛而不是 exit：顶层 process.exit 会把 require 本文件的测试进程一起带走
    throw new Error('npm audit 执行失败：' + e.message);
  }
}

function main() {
  const { exempt, problems } = loadAllowlist();
  if (problems.length) {
    console.error('✗ 豁免清单不合规：');
    problems.forEach((p) => console.error('    ' + p));
    return 1;
  }

  const audit = runAudit();
  const vulns = (audit && audit.vulnerabilities) || {};
  const order = { critical: 0, high: 1, moderate: 2, low: 3 };
  const entries = Object.values(vulns).sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const remaining = [];
  const usedGroups = new Map();
  console.log('依赖漏洞审计（豁免清单：scripts/audit-allowlist.json）\n');
  for (const v of entries) {
    if (exempt.has(v.name)) {
      const g = exempt.get(v.name);
      usedGroups.set(g, (usedGroups.get(g) || 0) + 1);
      console.log(`  豁免  ${v.name.padEnd(22)} ${String(v.severity).padEnd(9)} ${g}`);
    } else {
      const mark = LEVELS.includes(v.severity) ? '未豁免' : '记录  ';
      console.log(`  ${mark} ${v.name.padEnd(22)} ${String(v.severity).padEnd(9)}${v.isDirect ? '直接依赖' : '传递依赖'}`);
      if (LEVELS.includes(v.severity)) remaining.push(v);
    }
  }

  const exempted = entries.filter((v) => exempt.has(v.name)).length;
  console.log(`\n豁免 ${exempted} 项`
    + (usedGroups.size ? `（${[...usedGroups].map(([g, n]) => g + ' ' + n).join('，')}）` : '')
    + `，未豁免 ${entries.length - exempted} 项`);

  // 清单里写了但当前 audit 没报 —— 说明上游修好了，应当从清单里移除，
  // 否则「豁免」会变成一个只增不减、掩盖新情况的集合。
  const reported = new Set(entries.map((v) => v.name));
  const stale = [...exempt.keys()].filter((p) => !reported.has(p));

  if (remaining.length) {
    console.error(`\n✗ 存在未豁免的 high/critical（${remaining.length} 项），发版被阻断：`);
    remaining.forEach((v) => console.error(`    ${v.name} ${v.severity}`));
    console.error('\n处理方式：能安全升级就加进 package.json 的 overrides；'
      + '确实不可达或上游锁死，写进 audit-allowlist.json 并附理由与核查日期。');
    return 1;
  }
  if (stale.length) {
    console.error(`\n✗ 豁免清单里有 ${stale.length} 项当前已无对应漏洞，请移除：`);
    stale.forEach((p) => console.error('    ' + p));
    console.error('（豁免只应因「仍然有漏洞且已评估」而存在；上游修好后留着它，'
      + '就会掩盖下一次同类问题的复核）');
    return 1;
  }

  console.log('\n✓ 无未豁免的 high/critical，豁免清单与实际一致。');
  return 0;
}

// 判据以纯函数形态导出给 test/audit-gate.test.js；退出码只在「被当脚本跑」时交出去。
//
// 为什么必须这样：主流程若写在顶层，测试 import 本文件就会真的跑一遍 audit 并
// process.exit，把测试进程一起干掉 —— 表现为「测试全绿、实则一个用例都没跑」。
// 本仓已经为 check-dead-deps.cjs 栽过一次（见该文件头注），这里不重复。
module.exports = { loadAllowlist, parseAuditJson, main };

if (require.main === module) process.exit(main());