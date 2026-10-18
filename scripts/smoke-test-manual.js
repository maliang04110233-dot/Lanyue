'use strict';

/**
 * Windows 解包产物真机冒烟：
 * 1) 首实例可拉起并持续存活；2) 第二实例被单实例锁快速拒绝；
 * 3) stdout/stderr 无常见致命错误；
 * 4) 本机 main.log 本次启动增量：无致命错误 + 全局快捷键注册成功（已注册 N/M 且 N≥1）
 *    + 托盘无失败记录（无 [tray] 告警）。
 *    —— 第 4 组判据消费的是主进程既有日志（src/main/globalShortcuts.js:51、
 *    src/main/tray.js:52），不要求新增日志行为；增量窗口从首个实例 spawn 之前
 *    的字节偏移算起，多字节 UTF-8 切割与日志轮转均有退路。
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
  shortcutsRegisteredInLog,
  trayFailureAbsent,
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
const finish = () => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
};
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

  // 在拉起首个实例之前记录本机 main.log 的当前字节大小，作为「本次启动」
  // 的增量切片起点——后续 tray/shortcuts/致命错误断言只看这个偏移之后的
  // 新增内容，避免历史日志误伤。多字节 UTF-8 切割处理见下方 readIncremental。
  const logCandidatesPre = [
    path.join(process.env.APPDATA || '', 'music-downloader', 'logs', 'main.log'),
    path.join(process.env.APPDATA || '', 'Lanyue', 'logs', 'main.log'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'music-downloader', 'logs', 'main.log'),
  ].filter(Boolean);
  const logPathPre = logCandidatesPre.find((p) => fs.existsSync(p));
  const spawnOffset = logPathPre ? fs.statSync(logPathPre).size : null;

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
  if (!logPath) {
    console.log('SKIP  未定位到本机 main.log（进程输出检查仍已执行）');
    await stop(second && second.child);
    await stop(first.child);
    finish();
    return;
  }
  if (logPath !== logPathPre) {
    console.log('WARN  使用的 main.log 路径在启动前后发生了变化，增量切片退化为尾部片段');
  }

  // 增量读取：fs.statSync 偏移是字节，多字节 UTF-8 字符可能被切在中间。
  // 安全做法：从偏移处切片后，若首字节不是合法 UTF-8 序列起点，
  // 再往前多回退 4 字节内的对齐窗口，然后跳到下一行行首。
  const buf = fs.readFileSync(logPath);
  const sliceStart = spawnOffset != null ? Math.min(spawnOffset, buf.length) : Math.max(0, buf.length - 20000);
  let incremental = buf.slice(sliceStart).toString('utf8');
  if (buf.length > sliceStart && buf[sliceStart] >= 0x80) {
    // 切点落在多字节序列中间 → 丢弃第一行
    incremental = incremental.replace(/^[^\n]*\n?/, '');
  }
  if (spawnOffset != null && sliceStart > 0) {
    // 尾部截断保护：若因 log 轮转/截断导致偏移超过当前文件长度，退化为尾部
    if (sliceStart >= buf.length) incremental = buf.slice(Math.max(0, buf.length - 20000)).toString('utf8');
  }

  check('本机 main.log 增量无常见致命错误', startupLogLooksHealthy(incremental), path.relative(os.homedir(), logPath));
  check('全局快捷键注册成功（已注册 N/M 且 N≥1）', shortcutsRegisteredInLog(incremental),
    shortcutsRegisteredInLog(incremental) ? '' : '增量日志未出现「[shortcuts] 全局快捷键已注册 N/M」或 N=0');
  check('托盘启动无失败记录（日志无 [tray] 告警）', trayFailureAbsent(incremental),
    trayFailureAbsent(incremental) ? '' : '增量日志包含 [tray] 失败记录');

  await stop(second && second.child);
  await stop(first.child);
  finish();
}

main().catch((e) => {
  console.error('发行冒烟执行失败:', e && e.stack || e);
  process.exitCode = 2;
});
