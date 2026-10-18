'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
} = require('../scripts/release-smoke-checks.cjs');

test('首实例只有在无拉起错误且观察期内持续存活时通过', () => {
  assert.equal(processStayedAlive({ spawnError: null, exitCode: null, exitSignal: null, timedOut: true }), true);
  assert.equal(processStayedAlive({ spawnError: null, exitCode: 1, exitSignal: null, timedOut: false }), false);
  assert.equal(processStayedAlive({ spawnError: new Error('ENOENT'), exitCode: null, exitSignal: null, timedOut: false }), false);
});

test('第二实例必须快速以 0 退出，证明单实例锁生效', () => {
  assert.equal(secondInstanceWasRejected({ firstAlive: true, secondSpawnError: null, secondExitCode: 0, secondTimedOut: false }), true);
  assert.equal(secondInstanceWasRejected({ firstAlive: true, secondSpawnError: null, secondExitCode: null, secondTimedOut: true }), false);
  assert.equal(secondInstanceWasRejected({ firstAlive: false, secondSpawnError: null, secondExitCode: 0, secondTimedOut: false }), false);
});

test('启动日志拒绝常见致命错误，但允许普通 warning', () => {
  assert.equal(startupLogLooksHealthy('[main] ready\nwarning: optional feature disabled'), true);
  assert.equal(startupLogLooksHealthy('Cannot find module axios'), false);
  assert.equal(startupLogLooksHealthy('Unhandled rejection: boom'), false);
  assert.equal(startupLogLooksHealthy('SyntaxError: Unexpected token'), false);
});

// 真机 e2e 扩项（2026-10-17）：全局快捷键注册成功是既有日志证据
// （真机 main.log 实测「[shortcuts] 全局快捷键已注册 3/3」），此前从未被
// 门禁断言过。这里钉住判据：出现「已注册 N/M」且 N>=1 才算通过。
test('全局快捷键：日志出现「已注册 N/M」且 N>=1 才算注册成功', () => {
  assert.equal(shortcutsRegisteredInLog('[LOG] [shortcuts] 全局快捷键已注册 3/3'), true);
  assert.equal(shortcutsRegisteredInLog('[LOG] [shortcuts] 全局快捷键已注册 2/3'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 0/3'), false, '一枚都没注册上不算通过');
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 注册失败（可能已被系统或其它应用占用）'), false, '只有失败记录而无成功行不算通过');
  assert.equal(shortcutsRegisteredInLog(''), false);
  assert.equal(shortcutsRegisteredInLog(null), false);
});

test('全局快捷键：被占用时允许 N<M，但 N 必须为正整数', () => {
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 1/4'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 4/4'), true);
  assert.equal(shortcutsRegisteredInLog('[shortcuts] 全局快捷键已注册 abc/4'), false, '不匹配正则相等价于「没有注册行」');
});

// 托盘：createTray 失败路径（图标加载失败 / Tray 构造抛错）都会走
// [tray] warn 链路（src/main/tray.js:52、src/main/index.js:389 之外的兜底）。
// 正常启动时日志里不应出现 [tray] 的失败记录。
test('托盘：日志中不应出现 [tray] 失败记录', () => {
  assert.equal(trayFailureAbsent('ready\nno errors here'), true);
  assert.equal(trayFailureAbsent('[tray] 图标加载失败: ENOENT'), false);
  assert.equal(trayFailureAbsent('[tray] 打开桌面歌词失败: xxx'), false);
  assert.equal(trayFailureAbsent(''), true);
  assert.equal(trayFailureAbsent(null), true);
});
