/**
 * 发布包装脚本 —— 正确的资产上传顺序
 *
 * 顺序至关重要：
 *   1. vite build + postbuild
 *   2. electron-builder --publish never  → 产物落到 release/
 *   3. gen-update-integrity.cjs         → release/update-integrity.json 生成
 *   4. electron-builder --publish always --prepackaged release → 带完整性一起上传
 *
 * 如果第 4 步不接受 --prepackaged（electron-builder 版本差异），降级为再跑一次
 * electron-builder --publish always —— 这会重新打包（慢但安全），
 * 因为 integrity.json 在 release/ 里，electron-builder 会把它一起作为额外资产上传。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`\n✗ 步骤失败（退出码 ${result.status}）`);
    process.exit(result.status || 1);
  }
}

// 1. 前端构建
run('npx', ['vite', 'build']);
run('node', ['scripts/postbuild.js']);

// 2. 打包（不发布）
run('npx', ['electron-builder', '--config', 'build/config.cjs', '--win', '--x64', '--publish', 'never']);

// 3. 生成完整性
run('node', ['scripts/gen-update-integrity.cjs', '--release-dir', 'release']);

// 4. 发布（完整性文件已在 release/ 下，会被 electron-builder 作为额外资产上传）
run('npx', ['electron-builder', '--config', 'build/config.cjs', '--win', '--x64', '--publish', 'always']);

console.log('\n✓ 发布完成');
