/**
 * 发布时生成 update-integrity.json
 *
 * electron-builder 在 publish 时已在 GitHub Releases 上生成 latest.yml，
 * 里面每个 artifact 都带 sha512。这份脚本的产物 update-integrity.json 是
 * latest.yml sha512 列表的**独立副本**，发布时作为额外资产一并上传。
 *
 * 运行时，updater.js 会从**两个独立来源**（latest.yml 与 update-integrity.json）
 * 取 sha512 列表并交叉比对——两者一致才信任并继续下载。这样：
 *   · 单来源 MiTM（只替换 latest.yml）→ 两列表不一致 → 拒绝
 *   · 双来源 MiTM（同时替换两份）→ 需要同时篡改 GitHub API 与另一个资产文件，
 *     攻击面从「一次 HTTP 劫持」提升到「两次不同路径劫持」
 *
 * 用法：electron-builder 打包后、publish 前执行。
 *   node scripts/gen-update-integrity.cjs --release-dir release
 *   （publish 阶段会自动把 release-dir 下的文件作为额外资产上传）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const releaseDirArg = args.find(a => a.startsWith('--release-dir='));
const releaseDir = releaseDirArg ? releaseDirArg.split('=')[1] : 'release';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sha512File(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function main() {
  const artifacts = walk(releaseDir).filter(f => {
    const lower = f.toLowerCase();
    return (
      lower.endsWith('.exe') ||
      lower.endsWith('.zip') ||
      lower.endsWith('.dmg') ||
      lower.endsWith('.AppImage') ||
      lower.endsWith('.deb') ||
      lower.endsWith('.yml') ||
      lower.endsWith('.blockmap')
    );
  });

  const entries = [];
  for (const artifact of artifacts) {
    const relative = path.relative(releaseDir, artifact).replace(/\\/g, '/');
    entries.push({
      file: relative,
      sha512: sha512File(artifact),
      size: fs.statSync(artifact).size,
    });
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    artifacts: entries,
  };

  const outPath = path.join(releaseDir, 'update-integrity.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const totalBytes = entries.reduce((a, b) => a + b.size, 0);
  console.log(`[gen-update-integrity] ${entries.length} 个资产，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[gen-update-integrity] 输出: ${outPath}`);
}

main();
