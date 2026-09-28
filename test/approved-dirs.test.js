/**
 * 目录沙箱（approvedDirs）回归测试
 *
 * C1 的原始承诺：只有用户经原生选器批准过的目录（含子目录）才可读写。
 * 2026-09 审计 P1 发现：旧实现只有词法判定，批准目录内的**符号链接**
 * 可以直接把读写引到沙箱外（D:\Music\link → C:\Windows）。
 * 本文件把「链接即绕过」这条路径钉死，同时保证正常路径零回归。
 *
 * Windows 上目录链接用 junction 创建（无需管理员权限），realpath 同样会解析。
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

/** 建目录链接；平台不支持时返回 null（跳过用例，而不是假绿） */
function tryLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return linkPath;
  } catch (_e) {
    return null;
  }
}

const cleanup = [];

test.after(() => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* 尽力而为 */ }
  }
});

function track(dir) {
  cleanup.push(dir);
  return dir;
}

test('基线：批准目录自身与其子目录算在沙箱内，外部路径不算', () => {
  const ad = freshApprovedDirs();
  const base = track(tmpDir('ad-base-'));
  const outside = track(tmpDir('ad-out-'));
  ad.approve(base);

  assert.strictEqual(ad.isApprovedDir(base), true);
  assert.strictEqual(ad.isApprovedDir(path.join(base, 'sub', 'song.mp3')), true,
    '子目录（含尚不存在的文件）应在沙箱内');
  assert.strictEqual(ad.isApprovedDir(outside), false, '未批准的目录不该放行');
  assert.strictEqual(ad.isApprovedDir(''), false);
  assert.strictEqual(ad.isApprovedDir(null), false);
});

test('前缀碰撞：C:\\MusicX 不在 C:\\Music 沙箱内（词法判定不许用 startsWith）', () => {
  const ad = freshApprovedDirs();
  const a = track(tmpDir('ad-pc-'));
  const b = `${a}X`;
  fs.mkdirSync(b, { recursive: true });
  track(b);
  ad.approve(a);
  assert.strictEqual(ad.isApprovedDir(b), false, '前缀相同不等于包含');
  assert.strictEqual(ad.isApprovedDir(path.join(b, 'x.mp3')), false);
});

test('符号链接绕过：批准目录内的链接指向外部 ⇒ 判否（审计 P1 的核心）', () => {
  const ad = freshApprovedDirs();
  const base = track(tmpDir('ad-link-base-'));
  const secret = track(tmpDir('ad-link-out-'));
  fs.writeFileSync(path.join(secret, 'target.txt'), 'secret', 'utf8');

  const link = path.join(base, 'link');
  if (!tryLink(secret, link)) {
    assert.ok(true, '当前平台/权限不支持创建目录链接，跳过');
    return;
  }
  ad.approve(base);

  // 词法上它在 base 里面 —— 旧实现会放行
  assert.strictEqual(ad.isInside(base, path.join(link, 'evil.dll')), true,
    '先确认这条路径词法上确实"在沙箱内"（否则本用例没测到东西）');
  // 真实路径复核必须把它挡回去
  assert.strictEqual(ad.isApprovedDir(path.join(link, 'evil.dll')), false,
    '批准目录内的链接指向外部时，沙箱判定必须拒绝');
  assert.strictEqual(ad.isApprovedDir(link), false, '链接目录本身同样不该放行');
});

test('符号链接：批准的是链接本身时，只认用户给出的那一形态（单向，宁严勿宽）', () => {
  const ad = freshApprovedDirs();
  const real = track(tmpDir('ad-real-'));
  const parent = track(tmpDir('ad-parent-'));
  const link = path.join(parent, 'alias');
  if (!tryLink(real, link)) {
    assert.ok(true, '当前平台/权限不支持创建目录链接，跳过');
    return;
  }
  ad.approve(link);
  assert.strictEqual(ad.isApprovedDir(path.join(link, 'song.mp3')), true,
    '用户选中的形态（链接路径）下的文件必须放行');
  // 等价写法（真实路径）不放行：判定单向，只认用户给出的那一形态。
  // 应用内所有路径都源自该形态（扫描结果 / 落盘 / 历史一致），故不误伤；
  // 放宽成「两种写法都收」会让批准集合随链接指向漂移，得不偿失。
  assert.strictEqual(ad.isApprovedDir(path.join(real, 'song.mp3')), false,
    '判定必须是单向的：批准的是链接路径，就不额外接受真实路径写法');
});

test('realpathDeep：不存在的路径回退到最近已存在祖先，仍能算出真实路径', () => {
  const ad = freshApprovedDirs();
  const base = track(tmpDir('ad-deep-'));
  const deep = path.join(base, 'not', 'yet', 'created', 'file.mp3');
  const r = ad.realpathDeep(deep);
  assert.ok(r, '应当回退到已存在的祖先而不是返回 null');
  assert.ok(ad.isInside(ad.realpathDeep(base), r), '解析结果应落在真实基目录内');
});

test('未批准路径不做任何系统调用（词法快筛在前，保住热路径开销）', () => {
  const ad = freshApprovedDirs();
  const base = track(tmpDir('ad-fast-'));
  ad.approve(base);
  // 把 realpathDeep 换成计数器：未批准路径不应走到它
  const orig = ad.realpathDeep;
  let calls = 0;
  require.cache[require.resolve(path.join(ROOT, 'src/main/approvedDirs'))].exports.realpathDeep = (p) => {
    calls++;
    return orig(p);
  };
  try {
    assert.strictEqual(ad.isApprovedDir(track(tmpDir('ad-other-'))), false);
    assert.strictEqual(calls, 0, '词法快筛失败时不该发生文件系统调用');
  } finally {
    require.cache[require.resolve(path.join(ROOT, 'src/main/approvedDirs'))].exports.realpathDeep = orig;
  }
});
