/**
 * 目录模板落盘点的真实路径防线（2026-09 审计 P1-7）
 *
 * 缺口长什么样：planDownloadDir 拼完子目录后只过一遍**词法**包含判定
 * （isInsideDir = normDir 相等或 startsWith(base + sep)），没有 realpath；
 * 而 downloadQueue 只对**根目录**过 approvedDirs.isApprovedDir，模板渲染出来的
 * 子目录随后直接 mkdir recursive 就把文件写出去了。
 *
 * 词法挡得住 C:\MusicX 冒充 C:\Music，挡不住符号链接：批准根目录下的
 * D:\Music\link → C:\Windows\System32 时，D:\Music\link\evil 词法上"在根目录内"，
 * 真实落盘却在沙箱外。同仓库的 approvedDirs 早就把这条列为 P1 并用
 * realpath + realpathDeep 关掉了（见该文件 P1 加固段）—— 这一路没复用它，
 * 是架构不一致，不是一个能直接打的洞。这里把同一道防线接上。
 *
 * Windows 上目录链接用 junction 创建（无需管理员权限），realpath 同样解析。
 * 建不出来（权限/文件系统不支持）时用例 skip 并写明原因，不写恒真断言。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planDownloadDir, subpathFromAbsolute, isInsideDir } = require('../src/utils/downloadPath');
const approvedDirs = require('../src/main/approvedDirs');
const { createDownloadQueueEngine } = require('../src/main/downloadQueue');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-01-15T12:00:00');
const SONG = { title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', id: '12345' };

const cleanup = [];
test.after(() => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* 尽力而为 */ }
  }
});

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

/** 建目录链接；平台/权限不支持时返回 null（调用方 skip，而不是假绿） */
function tryLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return linkPath;
  } catch (_e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// 1) 真实链接的行为测试（审计 P1-7 的核心）
// ══════════════════════════════════════════════════════════

test('根目录内的目录链接指向外部 ⇒ 模板子目录被拒并落回根目录', () => {
  const base = tmpDir('dp-link-base-');
  const outside = tmpDir('dp-link-out-');
  const link = path.join(base, 'link');
  if (!tryLink(outside, link)) {
    return { skipped: true }; // 平台不支持建目录链接，见文件头说明
  }
  const sub = path.join(base, 'link', 'album');

  // 先确认这条路径词法上确实"在根目录内" —— 否则本用例没测到东西
  assert.strictEqual(isInsideDir(base, sub), true,
    '前提：词法判定必须放行这条路径（否则测不到 realpath 那一道闸）');
  // 真实路径确实在外面
  assert.strictEqual(approvedDirs.isInsideReal(base, sub), false,
    '前提：真实路径复核必须认出它已经跑出去了');

  const r = planDownloadDir({ subpath: 'link/album' }, base, SONG, { now: NOW });
  assert.deepStrictEqual(r, { dir: base, applied: false, reason: 'link-escapes-save-dir' },
    '链接把落盘点甩出根目录时，必须回落根目录而不是照样 mkdir');
});

test('链接目录本身就是模板子目录（零层剩余）同样被拒', () => {
  const base = tmpDir('dp-link2-base-');
  const outside = tmpDir('dp-link2-out-');
  const link = path.join(base, 'link');
  if (!tryLink(outside, link)) return;
  // subpath 只有一段，且正好落在链接上 —— 词法判定放行、真实路径在外
  assert.strictEqual(isInsideDir(base, link), true);
  const r = planDownloadDir({ subpath: 'link' }, base, SONG, { now: NOW });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.reason, 'link-escapes-save-dir');
  assert.strictEqual(r.dir, base);
});

test('正常模板不被误伤：尚不存在的新目录与已存在的目录都照常生效', () => {
  const base = tmpDir('dp-ok-base-');
  // 尚不存在（realpathDeep 逐级回退到最近已存在祖先）—— 新建目录场景必须放行
  const r1 = planDownloadDir({ subpath: '{artist}/{album}' }, base, SONG, { now: NOW });
  assert.strictEqual(r1.applied, true, '本次下载才新建的子目录不该被判越界: ' + r1.reason);
  assert.strictEqual(r1.dir, path.join(base, '周杰伦', '叶惠美'));
  // 已存在的普通子目录
  fs.mkdirSync(path.join(base, 'Pop', '2026'), { recursive: true });
  const r2 = planDownloadDir({ subpath: 'Pop/2026' }, base, SONG, { now: NOW });
  assert.strictEqual(r2.applied, true);
  assert.strictEqual(r2.dir, path.join(base, 'Pop', '2026'));
});

test('下载根目录本身是链接：按用户选中的那一形态放行（不因加了闸口而误伤）', () => {
  const real = tmpDir('dp-alias-real-');
  const parent = tmpDir('dp-alias-parent-');
  const alias = path.join(parent, 'alias');
  if (!tryLink(real, alias)) return;
  const r = planDownloadDir({ subpath: '{artist}' }, alias, SONG, { now: NOW });
  assert.strictEqual(r.applied, true,
    '用户自己选中的链接目录必须照常用（否则链接目录一当下载根就全盘失效）: ' + r.reason);
  assert.strictEqual(r.dir, path.join(alias, '周杰伦'));
});

// ══════════════════════════════════════════════════════════
// 2) 纯函数层边界：isInsideDir / subpathFromAbsolute / planDownloadDir
// ══════════════════════════════════════════════════════════

// 跨平台都成立的绝对路径（Windows 下 '/tmp/x' 是当前盘根的相对写法，必须 resolve）
const MUSIC = path.resolve(path.join(path.sep + 'tmp', 'dp-music'));
const CI = process.platform === 'win32' || process.platform === 'darwin';
const flipCase = (s) => (s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase());

test('isInsideDir: 同名前缀的兄弟目录不算在内部（D:\\music2 vs D:\\music）', () => {
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + '2'), false, '前缀相同不等于包含');
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + '2' + path.sep + 'x'), false);
  assert.strictEqual(isInsideDir(MUSIC, path.join(MUSIC + '2', 'x')), false);
  // 反向也不成立：子目录不能反过来"包含"父目录
  assert.strictEqual(isInsideDir(path.join(MUSIC, 'a'), MUSIC), false);
  // 真正的内部
  assert.strictEqual(isInsideDir(MUSIC, path.join(MUSIC, 'a')), true);
  assert.strictEqual(isInsideDir(MUSIC, MUSIC), true);
});

test('isInsideDir: .. 穿越出去一律判否（尾随分隔符也不放过）', () => {
  assert.strictEqual(isInsideDir(MUSIC, path.join(MUSIC, '..', 'evil')), false);
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + path.sep + '..' + path.sep + 'evil'), false);
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + path.sep + 'a' + path.sep + '..' + path.sep + '..' + path.sep + 'evil'), false);
  // 绕一圈回到原地仍算内部
  assert.strictEqual(isInsideDir(MUSIC, path.join(MUSIC, 'a', '..', 'b')), true);
});

test('isInsideDir: 尾分隔符归一后仍算内部（base 与 target 两侧都要归一）', () => {
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + path.sep), true);
  assert.strictEqual(isInsideDir(MUSIC, MUSIC + path.sep + path.sep), true);
  assert.strictEqual(isInsideDir(MUSIC + path.sep, path.join(MUSIC, 'a')), true);
  assert.strictEqual(isInsideDir(MUSIC + path.sep + path.sep, path.join(MUSIC, 'a', 'b')), true);
});

test('isInsideDir: 大小写按平台语义归一（不误伤合法模板，也不是无条件忽略大小写）', () => {
  const inner = path.join(flipCase(MUSIC), flipCase('x'));
  assert.strictEqual(isInsideDir(MUSIC, inner), CI,
    `大小写不敏感平台（win32/darwin）应放行，实际平台 ${process.platform}`);
  assert.strictEqual(isInsideDir(flipCase(MUSIC), path.join(MUSIC, 'a')), CI);
});

test('isInsideDir: 空值/非字符串一律判否（不抛错）', () => {
  for (const bad of ['', null, undefined, 0, {}]) {
    assert.strictEqual(isInsideDir(bad, MUSIC), false, `base=${String(bad)}`);
    assert.strictEqual(isInsideDir(MUSIC, bad), false, `target=${String(bad)}`);
  }
});

test('subpathFromAbsolute: 尾分隔符的根算空片段，兄弟前缀与 .. 穿越都算不可用', () => {
  assert.strictEqual(subpathFromAbsolute(MUSIC + path.sep, MUSIC + path.sep), '');
  assert.strictEqual(subpathFromAbsolute(path.join(MUSIC, 'a'), MUSIC), 'a');
  assert.strictEqual(subpathFromAbsolute(MUSIC + '2' + path.sep + '{artist}', MUSIC), null);
  assert.strictEqual(subpathFromAbsolute(path.join(MUSIC, '..', 'evil', '{artist}'), MUSIC), null);
  assert.strictEqual(subpathFromAbsolute(path.join(MUSIC, '..', 'evil'), MUSIC), null);
});

test('planDownloadDir: 老模板的绝对路径落在兄弟前缀根目录里 ⇒ 越界回落', () => {
  const r = planDownloadDir({ path: MUSIC + '2' + path.sep + '{artist}' }, MUSIC, SONG, { now: NOW });
  assert.deepStrictEqual(r, { dir: MUSIC, applied: false, reason: 'outside-save-dir' });
});

test('planDownloadDir: 根目录带尾分隔符 / 大小写变体都照常生效', () => {
  const withSep = planDownloadDir({ subpath: '{artist}' }, MUSIC + path.sep, SONG, { now: NOW });
  assert.strictEqual(withSep.applied, true, withSep.reason);
  assert.strictEqual(withSep.dir, path.join(MUSIC, '周杰伦'));
  // 大小写变体：真实路径那一闸按平台语义归一后仍是同一个目录，不该被判越界
  const cased = planDownloadDir({ subpath: '{artist}' }, flipCase(MUSIC), SONG, { now: NOW });
  assert.strictEqual(cased.applied, true,
    `大小写变体的根目录不该被判越界（平台 ${process.platform}, 原因 ${cased.reason}）`);
  assert.ok(isInsideDir(flipCase(MUSIC), cased.dir), '子目录仍须长在变体根目录之下');
});

// ══════════════════════════════════════════════════════════
// 3) downloadQueue 端到端：mkdir 之前必须复核落盘目录
// ══════════════════════════════════════════════════════════

/** 造一台引擎；prefs 走 patch（引擎按既有约定直接 require 它），其余全部注入 */
function buildEngine(prefsStore, deps = {}) {
  const prefs = require('../src/utils/prefs');
  const origGet = prefs.get;
  prefs.get = (k) => prefsStore[k];
  const downloaded = [];
  const engine = createDownloadQueueEngine({
    userDataDir: () => tmpDir('dp-mq-'),
    safeSend: () => {},
    getDownloadUrlSmart: async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' }),
    getLyrics: async () => ({ lrc: '' }),
    history: { add: () => {} },
    fsa: { statOrNull: async () => ({ size: 1 }) },
    downloader: {
      downloadFileWithRetry: async (url, savePath) => { downloaded.push({ url, savePath }); },
      embedId3Tags: async () => {},
    },
    isSaveDirAllowed: deps.isSaveDirAllowed,
  });
  return { engine, downloaded, restore: () => { prefs.get = origGet; } };
}

async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

const QUEUE_SONG = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', taskId: 'x', status: 'pending' };

test('downloadQueue: 落盘目录没过沙箱复核时退回根目录，且不建那个子目录', async () => {
  const base = tmpDir('dp-mq-base-');
  // 只放行根目录本身：模拟"子目录这一层没通过复核"
  const rootOnly = (p) => path.resolve(p) === path.resolve(base);
  const { engine, downloaded, restore } = buildEngine(
    { saveDir: base, namingTemplate: '{artist} - {title}', downloadTemplates: [{ id: 't1', subpath: '{artist}' }], activeDownloadTemplate: 't1' },
    { isSaveDirAllowed: rootOnly },
  );
  try {
    engine.getQueue().push({ ...QUEUE_SONG });
    await engine.processQueue();
    await waitFor(() => downloaded.length === 1);
    assert.strictEqual(downloaded[0].savePath, path.join(base, '周杰伦 - 晴天.mp3'),
      '复核不过时必须退回根目录（根目录本身已过审）');
    assert.strictEqual(fs.existsSync(path.join(base, '周杰伦')), false,
      '没过复核的子目录不许被 mkdir 建出来');
    assert.strictEqual(engine.getQueue()[0].status, 'done', '目录不安全不能变成下载失败');
  } finally { restore(); }
});

test('downloadQueue: 复核通过时模板子目录照常生效（这道闸不许把模板打死）', async () => {
  const base = tmpDir('dp-mq-ok-');
  const { engine, downloaded, restore } = buildEngine(
    { saveDir: base, namingTemplate: '{artist} - {title}', downloadTemplates: [{ id: 't1', subpath: '{artist}' }], activeDownloadTemplate: 't1' },
    { isSaveDirAllowed: () => true },
  );
  try {
    engine.getQueue().push({ ...QUEUE_SONG });
    await engine.processQueue();
    await waitFor(() => downloaded.length === 1);
    assert.strictEqual(downloaded[0].savePath, path.join(base, '周杰伦', '周杰伦 - 晴天.mp3'));
    assert.ok(fs.existsSync(path.join(base, '周杰伦')), '子目录应被 mkdir 真建出来');
  } finally { restore(); }
});

test('downloadQueue: 未注入 isSaveDirAllowed 时不做复核（单测/旧调用方不被打扰）', async () => {
  const base = tmpDir('dp-mq-nodep-');
  const { engine, downloaded, restore } = buildEngine(
    { saveDir: base, namingTemplate: '{artist} - {title}', downloadTemplates: [{ id: 't1', subpath: '{artist}' }], activeDownloadTemplate: 't1' },
  );
  try {
    engine.getQueue().push({ ...QUEUE_SONG });
    await engine.processQueue();
    await waitFor(() => downloaded.length === 1);
    assert.strictEqual(downloaded[0].savePath, path.join(base, '周杰伦', '周杰伦 - 晴天.mp3'));
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 4) 接线钉：接线位置与依赖方向
// ══════════════════════════════════════════════════════════

test('downloadPath: 真实路径那闸接的是 approvedDirs 的同源判据（不另抄一份）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/utils/downloadPath.js'), 'utf8');
  assert.match(src, /require\('\.\.\/main\/approvedDirs'\)/, '要复用沙箱的 realpath 判据');
  assert.match(src, /isInsideReal\(/, '要真的调它');
  // 词法那道不许被顺手删掉 —— 两道闸是纵深防御，少一道就退回旧形态
  assert.match(src, /if \(!isInsideDir\(root, dir\)\)/, '词法闸仍须在 realpath 闸之前');
  assert.ok(
    src.indexOf('isInsideDir(root, dir)') < src.indexOf('isInsideReal(root, dir)'),
    '词法快筛必须排在 realpath 之前（先零系统调用否掉绝大多数）',
  );
});

test('依赖方向不会形成环：approvedDirs 只 require node 内置模块', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/approvedDirs.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ['path', 'fs'],
    'approvedDirs 一旦 require 了项目内模块，utils/downloadPath 反向引用它就可能成环 —— 复核一下');
});

test('downloadQueue: 沙箱复核必须排在 mkdir 与 statfs 之前（顺序错了等于没复核）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/downloadQueue.js'), 'utf8');
  const recheck = src.indexOf('isSaveDirAllowed(dirPlan.dir)');
  assert.ok(recheck > 0, '落盘前必须对 dirPlan.dir 再过一次沙箱判定');
  assert.ok(recheck < src.indexOf('mkdir(dirPlan.dir'),
    '复核在 mkdir 之后 ⇒ 目录已经建出去了，复核形同虚设');
  assert.ok(recheck < src.indexOf('statfs(dirPlan.dir'),
    '复核也必须早于 statfs（否则容量预检读的是没复核过的目录）');
});
