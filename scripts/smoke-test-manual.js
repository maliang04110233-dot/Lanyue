'use strict';

/**
 * Windows 解包产物真机冒烟：
 * 1) 首实例可拉起并持续存活；2) 第二实例被单实例锁快速拒绝；
 * 3) stdout/stderr 与本机 main.log 没有常见致命错误。
 *
 * 用法：node scripts/smoke-test-manual.js [exe路径]
 * 默认：release/win-unpacked/Lanyue.exe
 * 退出码：0 全通过；1 断言失败；2 环境/产物缺失。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
} = require('./release-smoke-checks.cjs');

if (process.platform !== 'win32') {
  console.error('SKIP/ERROR  本门禁只支持 Windows 真机');
  process.exit(2);
}

const exePath = path.resolve(process.argv[2] || path.join('release', 'win-unpacked', 'Lanyue.exe'));
if (!fs.existsSync(exePath)) {
  console.error('找不到解包产物:', exePath);
  console.error('请先执行 npm run package，或传入 Lanyue.exe 路径。');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const capture = () => {
  const state = { spawnError: null, exitCode: null, exitSignal: null, stdout: '', stderr: '', timedOut: false };
  const child = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  child.stdout.on('data', (d) => { state.stdout = (state.stdout + d).slice(-8000); });
  child.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-8000); });
  child.on('error', (e) => { state.spawnError = e; });
  child.on('exit', (code, signal) => { state.exitCode = code; state.exitSignal = signal; });
  return { child, state };
};

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await delay(1000);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function main() {
  console.log('exe:', exePath, `(${fs.statSync(exePath).size} B)`);
  const first = capture();
  await delay(6000);
  first.state.timedOut = first.state.exitCode == null && !first.state.spawnError;
  const firstAlive = processStayedAlive(first.state);
  check('首实例启动后持续存活 6 秒', firstAlive,
    first.state.spawnError ? first.state.spawnError.message : `exit=${first.state.exitCode} signal=${first.state.exitSignal}`);

  let second = null;
  if (firstAlive) {
    second = capture();
    await delay(4000);
    second.state.timedOut = second.state.exitCode == null && !second.state.spawnError;
    const rejected = secondInstanceWasRejected({
      firstAlive,
      secondSpawnError: second.state.spawnError,
      secondExitCode: second.state.exitCode,
      secondTimedOut: second.state.timedOut,
    });
    check('第二实例被单实例锁快速拒绝并以 0 退出', rejected,
      `exit=${second.state.exitCode} timedOut=${second.state.timedOut}`);
  } else {
    check('第二实例被单实例锁快速拒绝并以 0 退出', false, '首实例未存活，无法验证');
  }

  const processLog = [first.state.stdout, first.state.stderr,
    second ? second.state.stdout : '', second ? second.state.stderr : ''].join('\n');
  check('进程输出无常见致命错误', startupLogLooksHealthy(processLog));

  const logCandidates = [
    path.join(process.env.APPDATA || '', 'music-downloader', 'logs', 'main.log'),
    path.join(process.env.APPDATA || '', 'Lanyue', 'logs', 'main.log'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'music-downloader', 'logs', 'main.log'),
  ].filter(Boolean);
  const logPath = logCandidates.find((p) => fs.existsSync(p));
  if (logPath) {
    const text = fs.readFileSync(logPath, 'utf8').slice(-20000);
    check('本机 main.log 尾部无常见致命错误', startupLogLooksHealthy(text), path.relative(os.homedir(), logPath));
  } else {
    console.log('SKIP  未定位到本机 main.log（进程输出检查仍已执行）');
  }

  await stop(second && second.child);
  await stop(first.child);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('发行冒烟执行失败:', e && e.stack || e);
  process.exitCode = 2;
});
