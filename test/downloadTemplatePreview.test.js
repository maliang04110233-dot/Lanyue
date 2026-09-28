/**
 * 集成测试：main/ipc/downloadTemplates.js 的预览与保存 handler（真实 prefs + 信封）
 *
 * 与 test/download-path.test.js 的分工：那边钉的是"源码里有没有接上"（渲染层
 * 跑不起来，只能钉文本），本文件把注册好的 handler 真调一遍 —— 契约校验、
 * 传输层信封、prefs 读写这三段只有真实调用链才会走到的路，字符串钉碰不到。
 *
 * 覆盖的两条承诺：
 *   1) 'preview-naming-template' 一条通道吃两种入参：字符串=文件名模板（老口径，
 * 设置页命名输入框在用），{ pathTpl }=目录模板（668bad9 的实时预览）。
 *      为预览再开一条通道没有意义，但两种入参必须在同一次调用里互不污染。
 * 2) f5f5a08 修掉的"相对路径按进程 CWD 解析"：用户照提示写 {artist}/{album}
 *      必须存得下来，并且存下的 subpath 就是这段相对片段（落盘时按它建目录）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 环境搭建：桩 electron，其余全走真实实现 ──────────────────
const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-tpl-userdata-'));
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-tpl-music-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-tpl-outside-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: (name) => (name === 'userData' ? userDataDir : musicDir) },
    };
  }
  return originalLoad(request, parent, isMain);
};
// 不还原 Module._load：handler 内部会惰性 require('electron')（currentSaveDir
// 在没有 prefs.saveDir 时取 app.getPath('music')），桩必须全程有效。

const prefs = require('../src/utils/prefs');
prefs.init(userDataDir);
prefs.set('saveDir', musicDir);

const ipcTemplates = require('../src/main/ipc/downloadTemplates');
ipcTemplates.register();

const { ENVELOPE_KEY } = require('../src/shared/ipcContract');
/** 直调 ipcMain 包装器并解包信封，等价于渲染层 api.xxx() 拿到的值 */
async function invoke(channel, arg) {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  const env = await fn({}, arg);
  assert.ok(env && typeof env === 'object', 'handler 必须回信封对象');
  assert.equal(env[ENVELOPE_KEY], 1, '必须是传输层信封');
  assert.equal(env.ok, true, '不该抛错: ' + (env.error && env.error.message));
  return env.data;
}

// ── 1) 预览：两种入参同一通道 ────────────────────────────────

test('字符串入参仍是文件名模板预览（老口径不许被668bad9 挤坏）', async () => {
  const r = await invoke('preview-naming-template', '{artist} - {title}');
  assert.equal(r.preview, '周杰伦 - 晴天.mp3');
  assert.deepEqual(r.unknown, []);
  assert.ok(!('pathSegments' in r), '没传 pathTpl 就不该凭空多出目录预览字段');
});

test('pathTpl 入参回「会建哪几层」', async () => {
  const r = await invoke('preview-naming-template', { pathTpl: '{artist}/{album}' });
  assert.deepEqual(r.pathSegments, ['周杰伦', '叶惠美']);
  assert.deepEqual(r.pathDropped, []);
});

test('pathTpl 里不认识的变量：整段丢弃且如实回报（否则用户以为建了）', async () => {
  const r = await invoke('preview-naming-template', { pathTpl: '{artist}/{albumX}' });
  assert.deepEqual(r.pathSegments, ['周杰伦']);
  assert.deepEqual(r.pathDropped, ['{albumX}']);
});

test('空 pathTpl 不产生目录预览字段（未填 = 落在下载目录根，由渲染层说这句）', async () => {
  const r = await invoke('preview-naming-template', { pathTpl: '   ' });
  assert.ok(!('pathSegments' in r));
});

// ── 2) 保存：相对写法与越界拒绝 ──────────────────────────────

test('照设置页提示写的相对模板存得下来，subpath 就是那段相对片段', async () => {
  const r = await invoke('save-download-template', { name: '按歌手', path: '{artist}/{album}' });
  assert.equal(r.success, true, '相对写法必须能存：' + r.error);
  const got = await invoke('get-download-templates', undefined);
  const tpl = got.templates.find((t) => t.name === '按歌手');
  assert.ok(tpl, '模板应已入库');
  assert.equal(tpl.subpath, path.join('{artist}', '{album}'));
  assert.equal(
    path.isAbsolute(tpl.path) && tpl.path.startsWith(path.resolve(musicDir)),
    true, '绝对 path 应落在下载目录内（展示用）'
  );
});

test('模板路径写到下载目录外：拒绝而不是静默放行', async () => {
  const escape = path.join(outsideDir, '{artist}');
  const r = await invoke('save-download-template', { name: '越界', path: escape });
  assert.equal(r.success, false);
  assert.match(r.error, /下载目录/);
});
