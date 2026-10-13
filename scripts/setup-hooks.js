#!/usr/bin/env node
/**
 * 安装 git 钩子（scripts/setup-hooks.js）
 *
 * 为什么需要显式安装：Git 不会自动使用仓库里的 `hooks/` 目录。
 * `.git/hooks/` 是 git init 时按模板生成的本地副本，且**不在版本控制内**，
 * 所以想让它随仓库走，只能把 `core.hooksPath` 指向仓库内的 `hooks/`。
 *
 * 仓库里的 `hooks/pre-commit` 此前就是一个**从未被安装过的死规则**：
 * 它想做的「每次提交自动递增版本号」一次也没执行过
 * （见 scripts/version-bump.js 的文件头注释）。现在它改成质量闸门，
 * 由本脚本显式启用。
 *
 * 用法
 *   npm run setup:hooks              安装
 *   npm run setup:hooks -- --check   只检查当前状态，不改配置
 *
 * 说明：本脚本会写 **仓库本地** 的 git 配置（`.git/config`），不动全局配置。
 * 卸载：`git config --local --unset core.hooksPath`
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function main() {
  const checkOnly = process.argv.includes('--check');

  if (!isGitRepo()) {
    console.error('✖ 当前目录不是 git 仓库（或 .git 不在项目根），钩子无处安装。');
    console.error('  先执行：git init');
    process.exit(1);
  }

  const hookPath = path.join(ROOT, 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    console.error(`✖ 缺少钩子文件：${path.relative(ROOT, hookPath)}`);
    process.exit(1);
  }
  // Windows 上 git 可能按可执行脚本执行；确保至少可读
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch (_e) { /* Windows 上无所谓 */ }

  const current = git(['config', '--local', '--get', 'core.hooksPath'], { allowFail: true });

  if (checkOnly) {
    console.log(current === 'hooks'
      ? '✔ 已配置 core.hooksPath=hooks（pre-commit 生效中）'
      : `✖ 未启用仓库内钩子${current ? `（当前 core.hooksPath=${current}）` : ''}`);
    process.exit(current === 'hooks' ? 0 : 1);
  }

  if (current === 'hooks') {
    console.log('✔ core.hooksPath 已是 hooks，无需改动');
  } else {
    git(['config', '--local', 'core.hooksPath', 'hooks']);
    console.log('✔ 已设置 core.hooksPath=hooks（仅仓库本地，未改全局配置）');
  }

  console.log(`
pre-commit 现在会拦这些（每一项都能绕过，见文件头说明）：
  1. 凭据/本机文件（prefs.json、证书私钥、日志、媒体文件…）
  2. 暂存内容含 CRLF
  3. 编码损坏特征字符（乱码）
  4. ESLint（仅本次暂存的 js 文件）

验证它是否真的在生效：随便改一行加个 // TODO 再提交，若被拦即说明生效。
紧急绕过：SKIP_HOOKS=1 git commit -m "..."
卸载：    git config --local --unset core.hooksPath
`);
}

main();
