/**
 * IPC 契约一致性测试（常驻版，取代一次性 scripts/audit-ipc.js）
 *
 * 守护三条不变量：
 *   1. 契约自身合法（方向/窗口/参数规格结构正确）
 *   2. 实现 ↔ 契约不漂移：主进程注册与 webContents.send 的每个通道都
 *      必须声明在契约里；契约里声明的 invoke/send/receive 也必须有实现
 *   3. 渲染层只能看到契约允许的面：musicAPI 方法、兼容桥与二级窗口
 *      miniAPI 的字面通道引用逐一对照契约白名单
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { CHANNELS, METHODS, EVENTS, channelsFor, normalizeArgs, buildContractArg } = require('../src/shared/ipcContract');

const MAIN_INVOKE  = channelsFor('main', 'invoke');
const MAIN_SEND    = channelsFor('main', 'send');
const MAIN_RECEIVE = channelsFor('main', 'receive');
const SEC_SEND     = channelsFor('secondary', 'send');
const SEC_RECEIVE  = channelsFor('secondary', 'receive');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(p)) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 去掉整行注释后的代码文本（保留行号结构无关，仅供匹配） */
function codeOnly(src) {
  return src.split('\n').filter(l => {
    const t0 = l.trim();
    return !(t0.startsWith('//') || t0.startsWith('*') || t0.startsWith('/*'));
  }).join('\n');
}

const mainFiles = walk(path.join(ROOT, 'src', 'main'))
  .filter(f => !/[\\/]preload(-secondary)?\.js$/.test(f));
const rendererFiles = walk(path.join(ROOT, 'src', 'renderer'));

// ── 收集实现侧清单 ──────────────────────────────────────────

const registeredHandle = new Set(); // handle('ch') / ipcHandle('ch')
const registeredOn = new Set();     // on('ch') / ipcOn('ch')
const sentChannels = new Set();     // webContents.send / safeSend
const rawIpcMain = [];              // 架构违规：绕过 register.js 的裸 ipcMain

for (const f of mainFiles) {
  const src = codeOnly(fs.readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/(?:^|[^.\w])(?:ipcHandle|handle)\(\s*['"]([\w-]+)['"]/g)) registeredHandle.add(m[1]);
  for (const m of src.matchAll(/(?:^|[^.\w])(?:ipcOn|on)\(\s*['"]([\w-]+)['"]/g)) registeredOn.add(m[1]);
  for (const m of src.matchAll(/webContents\.send\(\s*['"]([\w-]+)['"]|(^|[^.\w])safeSend\(\s*['"]([\w-]+)['"]/g)) {
    sentChannels.add(m[1] || m[3]);
  }
  if (!f.endsWith(path.join('ipc', 'register.js'))) {
    for (const m of src.matchAll(/ipcMain\.(handle|on)(?:Once)?\(/g)) rawIpcMain.push(`${path.relative(ROOT, f)}: ipcMain.${m[1]}`);
  }
}

// ── 1. 契约自身 ─────────────────────────────────────────────

test('契约结构合法（方向、窗口、参数规格）', () => {
  const WINS = new Set(['main', 'secondary']);
  for (const [ch, e] of Object.entries(CHANNELS)) {
    const dirs = ['invoke', 'send', 'receive'].filter(d => (e[d] || []).length);
    assert.ok(dirs.length, `${ch}: 至少声明一个方向`);
    for (const d of dirs) {
      for (const w of e[d]) assert.ok(WINS.has(w), `${ch}.${d}: 未知窗口 ${w}`);
    }
    if (e.args) {
      assert.ok(Array.isArray(e.args) && e.args.length > 0, `${ch}: args 必须是非空数组`);
      for (const a of e.args) {
        assert.ok(Array.isArray(a) && typeof a[0] === 'string' && a[1] && typeof a[1].k === 'string',
          `${ch}: 参数规格必须是 [名称, {k}]，得到 ${JSON.stringify(a)}`);
      }
    }
  }
  // 每个 METHODS/EVENTS 引用的通道必须存在且方向正确
  for (const [m, ch] of Object.entries(METHODS)) {
    const e = CHANNELS[ch];
    assert.ok(e, `METHODS.${m} 指向未登记通道 ${ch}`);
    assert.ok((e.invoke || []).includes('main') || (e.send || []).includes('main'),
      `METHODS.${m} → ${ch} 必须是 main 的 invoke 或 send`);
  }
  for (const [m, ch] of Object.entries(EVENTS)) {
    assert.ok((CHANNELS[ch]?.receive || []).includes('main'), `EVENTS.${m} → ${ch} 必须是 main receive`);
  }
});

test('通道数量钉死（意外增删即失败，逼迫改动者过目契约）', () => {
  assert.strictEqual(MAIN_INVOKE.size, 102); // +aggregate-cross-source（3-B 跨源聚合） // +ai-cancel-generation（AI 生成中断）；余项：-flush-prefs -flush-history（无人调用的僵尸通道）
  assert.strictEqual(MAIN_SEND.size, 16);
  assert.strictEqual(MAIN_RECEIVE.size, 26); // 余项：-library-scan-progress（main 发了没人收）
  assert.strictEqual(SEC_SEND.size, 7);
  assert.strictEqual(SEC_RECEIVE.size, 2);
  assert.strictEqual(Object.keys(METHODS).length, 106); // +aggregateCrossSource（3-B 跨源聚合） // +aiCancelGeneration；余项：-windowToggleFullscreen -closeDesktopLyric（死键）
});

test('僵尸通道已清除：flush 走 main 直调，扫描进度无人订阅不再空发', () => {
  for (const ch of ['flush-prefs', 'flush-history', 'library-scan-progress']) {
    assert.ok(!CHANNELS[ch], `僵尸通道 ${ch} 应已删除`);
  }
  for (const m of ['windowToggleFullscreen', 'closeDesktopLyric']) {
    assert.ok(!METHODS[m], `死 METHODS 键 ${m} 应已删除`);
  }
  const fsp = require('node:fs');
  const read = (p) => fsp.readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', p), 'utf8');
  assert.doesNotMatch(read('ipc/prefs.js'), /handle\('flush-prefs'/);
  assert.doesNotMatch(read('ipc/history.js'), /handle\('flush-history'/);
  assert.doesNotMatch(read('ipc/library.js'), /library-scan-progress/,
    '无人订阅的进度推送应连发送点一起删，而不是只删契约');
});

// ── 2. 实现 ↔ 契约 ──────────────────────────────────────────

test('主进程注册的通道全部在契约中声明且方向正确', () => {
  for (const ch of registeredHandle) {
    assert.ok(CHANNELS[ch], `handle('${ch}') 未声明在契约`);
    assert.ok((CHANNELS[ch].invoke || []).includes('main'), `handle('${ch}') 但契约未声明 invoke:main`);
  }
  for (const ch of registeredOn) {
    assert.ok(CHANNELS[ch], `on('${ch}') 未声明在契约`);
    assert.ok((CHANNELS[ch].send || []).length, `on('${ch}') 但契约未声明 send`);
  }
});

test('契约的 invoke/send(main) 通道全部有人注册（消灭静默失踪）', () => {
  const missing = [];
  for (const [ch, e] of Object.entries(CHANNELS)) {
    if ((e.invoke || []).includes('main') && !registeredHandle.has(ch)) missing.push(ch);
    if ((e.send || []).length && !registeredOn.has(ch)) missing.push(ch);
  }
  assert.deepStrictEqual(missing, [], `契约通道无人注册: ${missing.join(', ')}`);
});

test('主进程 send 到渲染层的通道都在某个窗口的 receive 清单', () => {
  const bad = [...sentChannels].filter(ch => !(CHANNELS[ch]?.receive || []).length);
  assert.deepStrictEqual(bad, [], `send 了未声明 receive 的通道: ${bad.join(', ')}`);
});

test('契约 receive 通道都有真实发送方（无死事件）', () => {
  const allReceive = new Set([...MAIN_RECEIVE, ...SEC_RECEIVE]);
  const dead = [...allReceive].filter(ch => !sentChannels.has(ch));
  assert.deepStrictEqual(dead, [], `无人发送的 receive 通道: ${dead.join(', ')}`);
});

test('禁止绕过 register.js 裸用 ipcMain.handle/on（统一契约入口）', () => {
  assert.deepStrictEqual(rawIpcMain, [], `发现裸 ipcMain 注册:\n${rawIpcMain.join('\n')}`);
});

// ── 3. 渲染层可见面 ─────────────────────────────────────────

test('渲染层 musicAPI 调用的方法都存在（METHODS/EVENTS/基座）', () => {
  const known = new Set([...Object.keys(METHODS), ...Object.keys(EVENTS), 'invoke', 'version', 'on']);
  const missing = new Set();
  for (const f of rendererFiles) {
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\b(?:window\.)?(?:musicAPI|api)\.(\w+)\s*\(/g)) {
      if (!known.has(m[1])) missing.add(m[1]);
    }
  }
  assert.deepStrictEqual([...missing], [], `渲染层调用了 preload 未暴露的方法: ${[...missing].join(', ')}`);
});

test('渲染层兼容桥 ipcRenderer.invoke/send/on 字面通道都在主窗口契约内', () => {
  const offenders = [];
  for (const f of rendererFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bipcRenderer\.(invoke|send|on)\(\s*['"]([\w-]+)['"]/g)) {
      const [, kind, ch] = m;
      const wl = kind === 'invoke' ? MAIN_INVOKE : kind === 'send' ? MAIN_SEND : MAIN_RECEIVE;
      if (!wl.has(ch)) offenders.push(`${path.relative(ROOT, f)}: ${kind}('${ch}')`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('二级窗口页面（mini/lyric）只使用 secondary 契约通道', () => {
  const pages = ['src/renderer/mini-player.html', 'src/renderer/desktop-lyric.html'];
  const offenders = [];
  for (const p of pages) {
    const src = read(p);
    for (const m of src.matchAll(/miniAPI\.send\(\s*['"]([\w-]+)['"]/g)) {
      if (!SEC_SEND.has(m[1])) offenders.push(`${p}: send('${m[1]}')`);
    }
    for (const m of src.matchAll(/miniAPI\.on\(\s*['"]([\w-]+)['"]/g)) {
      if (!SEC_RECEIVE.has(m[1])) offenders.push(`${p}: on('${m[1]}')`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

// ── 4. normalizeArgs 单元 ───────────────────────────────────

test('normalizeArgs: 位置参数钳制与默认值', () => {
  assert.deepStrictEqual(
    normalizeArgs('search-music', ['关键词', 'qq', '99999']),
    { ok: true, args: ['关键词', 'qq', 1000] });
  assert.deepStrictEqual(
    normalizeArgs('search-music', []),
    { ok: true, args: [undefined, undefined, 1] });
  assert.deepStrictEqual(
    normalizeArgs('get-download-url', [123, 'qq', 'bogus']),
    { ok: true, args: [123, 'qq', 'standard'] });
});

test('normalizeArgs: 对象/数组形态归一（旧 shim 的替代）', () => {
  assert.deepStrictEqual(
    normalizeArgs('write-local-lrc', [{ filePath: 'a.lrc', lrc: '[00:00]x' }]),
    { ok: true, args: ['a.lrc', '[00:00]x'] });
  assert.deepStrictEqual(
    normalizeArgs('rename-file', [['a', 'b']]),
    { ok: true, args: ['a', 'b'] });
});

test('normalizeArgs: 形状非法统一拒绝', () => {
  assert.strictEqual(normalizeArgs('add-to-queue', ['nope']).ok, false);
  assert.strictEqual(normalizeArgs('batch-fetch-lyrics', ['nope']).ok, false);
  // str 拒绝对象；但允许数字被 String 化
  assert.strictEqual(normalizeArgs('open-external', [{ a: 1 }]).ok, false);
  assert.strictEqual(normalizeArgs('get-pref', [42]).args[0], '42');
});

test('normalizeArgs: 未声明 args 的通道原样透传', () => {
  assert.deepStrictEqual(normalizeArgs('get-version', [1, 2, 3]), { ok: true, args: [1, 2, 3] });
});

test('normalizeArgs: 单数组形态不误伤 arr 型首参', () => {
  // batch-fetch-lyrics 首参本身就是数组：不能把它摊平成多个位置参数
  assert.deepStrictEqual(
    normalizeArgs('batch-fetch-lyrics', [[{ id: 1 }]]),
    { ok: true, args: [[{ id: 1 }]] });
});

// ── 5. argv 注入链路（sandbox preload 不能 require 应用文件）──

test('preload 源码禁止 require 应用相对路径（只允许 electron 内置）', () => {
  const preloads = ['src/main/preload.js', 'src/main/preload-secondary.js'];
  const offenders = [];
  for (const p of preloads) {
    const src = codeOnly(read(p));
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1].startsWith('.') || m[1].startsWith('/') || (!m[1].startsWith('electron') && !m[1].startsWith('node:'))) {
        offenders.push(`${p}: require('${m[1]}')`);
      }
    }
    assert.ok(/--ipc-contract=/.test(src), `${p} 必须从 process.argv 解析 --ipc-contract`);
  }
  assert.deepStrictEqual(offenders, [], `sandbox 下 preload require 应用文件会 module not found:\n${offenders.join('\n')}`);
});

test('buildContractArg 序列化结果与 channelsFor 一致（注入即契约）', () => {
  for (const win of ['main', 'secondary']) {
    const arg = buildContractArg(win);
    assert.ok(arg.startsWith('--ipc-contract='), `${win}: 必须是 --ipc-contract=<json> 形态`);
    const payload = JSON.parse(arg.slice('--ipc-contract='.length));
    assert.deepStrictEqual(new Set(payload.invoke), channelsFor(win, 'invoke'));
    assert.deepStrictEqual(new Set(payload.send), channelsFor(win, 'send'));
    assert.deepStrictEqual(new Set(payload.receive), channelsFor(win, 'receive'));
    if (win === 'main') {
      assert.deepStrictEqual(payload.methods, METHODS);
      assert.deepStrictEqual(payload.events, EVENTS);
    } else {
      // 二级窗口不带方法表：miniAPI 只有 send/on，攻击面不随 METHODS 膨胀
      assert.deepStrictEqual(payload.methods, {});
      assert.deepStrictEqual(payload.events, {});
    }
  }
});

test('主进程窗口创建处都注入 additionalArguments（漏注入=preload 直接瘫）', () => {
  const winMgrSrc = read('src/main/windowManager.js');
  const windowSrc = read('src/main/ipc/window.js');
  assert.ok(/buildContractArg\('main'\)/.test(winMgrSrc), 'windowManager.js createWindow 未注入 main 契约');
  assert.strictEqual((windowSrc.match(/buildContractArg\('secondary'\)/g) || []).length, 2,
    'window.js 迷你播放器与桌面歌词两处都要注入 secondary 契约');
});
