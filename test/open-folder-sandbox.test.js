/**
 * open-folder 通道的目录沙箱（2026-09 审计 P1-9）
 *
 * 缺口：src/main/ipc/window.js 的 openFolderImpl 只挡协议前缀
 * （file:/http:/javascript: 这类"伪路径"），挡不住"合法盘符路径"——
 * 渲染层可以拿任意绝对路径（契约参数只限 t.str(1024)）做两件事：
 *   1. 存在性探测：返回值 { ok:true } / { ok:false } 泄漏盘面信息；
 *   2. 把资源管理器拉到任意目录（社工素材也能落在受害者眼前）。
 * 同一仓库 src/main/ipc/library.js 的 15 处路径通道都过了
 * isValidPath + isInAllowedDir 两道，open-folder 是唯一漏网的那条。
 *
 * 为什么必须是"行为测试"而不是扫源码：这个通道的判据是 approvedDirs 的
 * 词法快筛 + 真实路径复核两道，只有真路径（真临时目录、真 junction）
 * 才能证明第二道闸确实在跑。顺带钉住顺序：闸口必须早于 showItemInFolder，
 * 晚一步就等于"先打开了再判断"。
 *
 * 反恒真：每条用例都配了对侧的对照（批准目录内的路径确实放行、不传 signal
 * 确实拿到结果）。只断言"被拒"的用例在"全拒"这种坏实现下同样会绿。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── electron 桩：open-folder 只用到 shell / app，register() 本身不建窗口 ──
const handlers = new Map();
const shown = [];           // showItemInFolder 的实参（开过哪些目录）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ofbox-'));
const userDataDir = path.join(tmpRoot, 'userdata');
const musicDir = path.join(tmpRoot, 'music');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
      app: { getPath: (name) => (name === 'userData' ? userDataDir : musicDir) },
      shell: { showItemInFolder: (p) => { shown.push(p); } },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      BrowserWindow: class { static getAllWindows() { return []; } },
    };
  }
  return originalLoad(request, parent, isMain);
};
const approvedDirs = require(path.join(ROOT, 'src/main/approvedDirs'));
const ipcWindow = require(path.join(ROOT, 'src/main/ipc/window'));
Module._load = originalLoad;

ipcWindow.register();

const { ENVELOPE_KEY } = require(path.join(ROOT, 'src/shared/ipcContract'));

/** 直调注册好的 handler，并按 preload 的方式拆掉传输层信封 */
async function openFolder(folder) {
  const fn = handlers.get('open-folder');
  assert.ok(fn, 'open-folder handler 未注册');
  const env = await fn({}, folder);
  assert.equal(env && env[ENVELOPE_KEY], 1, `返回的不是信封形态: ${JSON.stringify(env)}`);
  return env.data;
}

const tmp = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}

/** 建目录链接；平台不支持时返回 null（跳过该分支，而不是假绿） */
function tryLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return linkPath;
  } catch (_e) {
    return null;
  }
}

test.after(() => {
  for (const d of tmp) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* 尽力而为 */ }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { /* 同上 */ }
});

// ── 对照组：批准目录必须放行（否则"全拒"也能让下面几条绿）──
test('对照组：已批准目录放行，且真的调到了 shell.showItemInFolder', async () => {
  const base = tmpDir('ofbox-ok-');
  approvedDirs.approve(base);
  shown.length = 0;

  const r = await openFolder(base);
  assert.equal(r.ok, true, `已批准目录不该被拒: ${JSON.stringify(r)}`);
  assert.deepEqual(shown, [path.resolve(base)], '放行时必须真的打开了该目录');

  // 渲染层送的是**文件**路径（savePath / filePath），不是目录 —— 同样得放行
  const song = path.join(base, '周杰伦 - 晴天.mp3');
  fs.writeFileSync(song, 'x', 'utf8');
  shown.length = 0;
  const r2 = await openFolder(song);
  assert.equal(r2.ok, true);
  assert.deepEqual(shown, [path.resolve(song)], '文件路径要能定位（队列行/历史行的真实用法）');

  // 子目录（含尚不存在的）也在沙箱内
  const r3 = await openFolder(path.join(base, 'sub', 'deeper', 'x.mp3'));
  assert.equal(r3.ok, true, '已批准目录的子目录不该被拒');
});

test('未批准的盘符路径被拒：D:\\ 拿不到存在性探测，也拉不起资源管理器', async () => {
  shown.length = 0;
  const r = await openFolder('D:\\');
  assert.equal(r.ok, false, 'D:\\ 不在任何批准目录内，必须被拒');
  assert.ok(r.error, `拒绝时要说清原因: ${JSON.stringify(r)}`);
  assert.deepEqual(shown, [], '被拒的路径绝不能碰 shell.showItemInFolder');

  // 更狠的一条：真实存在、但用户从没批准过的目录。
  // 旧实现对它返回 ok:true 并真的打开（存在性探测 + 任意目录打开，两条都中）
  const stranger = tmpDir('ofbox-stranger-');
  shown.length = 0;
  const r2 = await openFolder(stranger);
  assert.equal(r2.ok, false, '未批准的真实目录也必须被拒（旧实现会放行）');
  assert.deepEqual(shown, [], '未批准目录不该被打开');
});

test('前缀碰撞：C:\\MusicX 不在 C:\\Music 沙箱内（词法闸不许用 startsWith）', async () => {
  const base = tmpDir('ofbox-pc-');
  const sibling = `${base}X`;
  fs.mkdirSync(sibling, { recursive: true });
  tmp.push(sibling);
  approvedDirs.approve(base);
  shown.length = 0;

  assert.ok(sibling.startsWith(base),
    '先确认这条路径的词法前缀与批准目录相同（否则本用例测不到 startsWith 型实现）');
  const r = await openFolder(sibling);
  assert.equal(r.ok, false, '前缀相同不等于包含');
  assert.deepEqual(shown, []);
});

test('符号链接绕过：批准目录内的链接指向外部 ⇒ 判否（真实路径复核在跑）', async () => {
  const base = tmpDir('ofbox-link-base-');
  const outside = tmpDir('ofbox-link-out-');
  const link = path.join(base, 'link');
  if (!tryLink(outside, link)) {
    // 平台不支持建链接：改用"未批准但存在"的兄弟目录确认闸口仍在
    const r = await openFolder(outside);
    assert.equal(r.ok, false, '建不了链接时也不能把外部目录放进来');
    return;
  }
  approvedDirs.approve(base);
  shown.length = 0;

  const r = await openFolder(path.join(link, 'evil.txt'));
  assert.equal(r.ok, false, '批准目录内的链接指向外部时必须判否（只做词法判定会放行）');
  assert.deepEqual(shown, []);
});

test('协议前缀仍然被拒（既有防线不许因为加了沙箱而退化）', async () => {
  shown.length = 0;
  for (const p of [
    'file:///C:/Windows/System32',
    'javascript:alert(1)',
    'http://evil.example/x',
    'smb://attacker/share',
    'ms-msdt:/id',
  ]) {
    const r = await openFolder(p);
    assert.equal(r.ok, false, `${p} 必须被拒: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(shown, [], '协议伪路径一个都不许碰 shell');
});

test('脏入参（空/非字符串）不进沙箱也不开目录', async () => {
  shown.length = 0;
  // 字符串形态的脏值：handler 自己挡
  for (const p of [null, undefined, '']) {
    const r = await openFolder(p);
    assert.equal(r.ok, false, `${JSON.stringify(p)} 应当被拒`);
  }
  // 非字符串：契约层 t.str(1024) 先挡（返回 fatal 信封），无论哪一层挡，
  // 都不许出现"成功开目录"
  for (const p of [123, {}, [], true]) {
    const r = await openFolder(p);
    assert.notEqual(r.ok, true, `${JSON.stringify(p)} 不该被判成功`);
  }
  assert.deepEqual(shown, []);
});

test('顺序钉：沙箱闸口早于 showItemInFolder（先打开再判断等于没判断）', () => {
  const src = read('src/main/ipc/window.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf('openFolderImpl');
  const body = src.slice(start, src.indexOf('const openExternalImpl', start));
  assert.ok(start >= 0 && body.length > 50, 'openFolderImpl 入口漂移（改名/换位置了？）');
  const gate = body.indexOf('isApprovedDir');
  const open = body.indexOf('showItemInFolder');
  assert.ok(gate >= 0, 'open-folder 没接 approvedDirs 判据（P1-9 复发）');
  assert.ok(open >= 0, 'open-folder 不再打开目录，行为漂移了？');
  assert.ok(gate < open, '闸口必须早于 shell 调用');
});
