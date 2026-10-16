'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
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
