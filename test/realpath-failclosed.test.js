/**
 * 真实路径复核的 fail-closed 语义（2026-10-13 复审 F14）
 *
 * 背景：本轮复审在 Windows 上实测到，某些环境（含开发机）对 junction 的
 * `stat` / `realpathSync` 一律返回 `UNKNOWN(-4094)`，而 `readlinkSync` 正常。
 * 而当时的 realpathDeep 把**所有**失败都当成「路径不存在」→ 逐级回退到
 * 最近祖先的真实路径再把剩余段拼回去。
 *
 * 那个回退的前提是「失败原因只有不存在一种」。前提不成立时它是 fail-open：
 * `D:\Music\link\evil.dll`（link 指向沙箱外）回退后被算成
 * `D:\Music\link\evil.dll` 本身 ⇒ 第二道闸判定「在沙箱内」⇒ 链接绕过成立。
 * 这不是理论风险：approved-dirs / download-path-symlink / open-folder-sandbox
 * 三个守卫文件共 4 个用例在开发机上就是这么红的。
 *
 * 本文件钉住修复后的语义：
 *   1. 无法验证真实路径（realpath 抛非 ENOENT 且 readlink 也解不出）⇒ 判否，
 *      且**不得**冒泡成异常把 IPC handler 掀翻；
 *   2. 不得因为加了闸口而误伤「路径尚不存在」的正常下载目录（ENOENT 仍回退）；
 *   3. 链接可解析时（readlink 能读出目标）仍要精确判定：指向沙箱外 ⇒ 判否。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 每个用例拿一份干净的注册表（模块级单例，别互相污染） */
function freshApprovedDirs() {
  delete require.cache[require.resolve(path.join(ROOT, 'src/main/approvedDirs'))];
  return require(path.join(ROOT, 'src/main/approvedDirs'));
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建目录链接；平台不支持时返回 null */
function tryLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return linkPath;
  } catch (_e) {
    return null;
  }
}

test('无法验证真实路径 ⇒ 判否，且不冒泡（fail-closed 的核心语义）', () => {
  const ad = freshApprovedDirs();
  const base = tmpDir('rpfc-base-');
  const inside = path.join(base, 'sub', 'song.mp3');

  // 让 realpathSync 模拟「无权限」——非 ENOENT，且 readlink 也解不出任何东西
  const orig = fs.realpathSync;
  fs.realpathSync = () => {
    const e = new Error('mock: access denied');
    e.code = 'EACCES';
    throw e;
  };
  try {
    ad.approve(base);
    // 词法快筛命中（路径确实在 base 内），必须走到第二道闸
    assert.strictEqual(ad.isInside(base, inside), true, '前提：词法上在沙箱内');
    let res;
    assert.doesNotThrow(() => { res = ad.isApprovedDir(inside); },
      '无法验证时不得把异常抛给调用方（会把 IPC handler 掀翻）');
    assert.strictEqual(res, false,
      'realpath 不可用且无链接可解析时必须判否，绝不能回退到祖先真实路径放行');
  } finally {
    fs.realpathSync = orig;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ENOENT（路径尚不存在）仍要放行：加闸口不能误伤新建下载目录', () => {
  const ad = freshApprovedDirs();
  const base = tmpDir('rpfc-new-');
  try {
    ad.approve(base);
    // 这一级根本不存在 —— 真实存在的下载场景（首次下载到新建子目录）
    assert.strictEqual(ad.isApprovedDir(path.join(base, 'not-created-yet', 'song.mp3')), true,
      '尚不存在的路径应按最近存在祖先的真实路径判定，不该被 fail-closed 误伤');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('链接指向沙箱外 ⇒ 判否（链接可解析时也必须精确判定）', () => {
  const ad = freshApprovedDirs();
  const base = tmpDir('rpfc-link-base-');
  const outside = tmpDir('rpfc-link-out-');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'secret', 'utf8');
  const link = path.join(base, 'link');
  if (!tryLink(outside, link)) {
    assert.ok(true, '当前平台/权限不支持创建目录链接，跳过');
    return;
  }
  try {
    ad.approve(base);
    assert.strictEqual(ad.isInside(base, path.join(link, 'evil.dll')), true,
      '前提：词法上在沙箱内');
    assert.strictEqual(ad.isApprovedDir(path.join(link, 'evil.dll')), false,
      '批准目录内的链接指向外部时必须拒绝');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
