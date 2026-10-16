'use strict';

/**
 * Windows 发行冒烟的纯判据。与进程拉起分离，确保门禁自身可被单测。
 */
function processStayedAlive({ spawnError, exitCode, exitSignal, timedOut }) {
  if (spawnError) return false;
  if (!timedOut) return false;
  return exitCode == null && exitSignal == null;
}

function secondInstanceWasRejected({ firstAlive, secondSpawnError, secondExitCode, secondTimedOut }) {
  return !!firstAlive && !secondSpawnError && !secondTimedOut && secondExitCode === 0;
}

function startupLogLooksHealthy(text) {
  const log = String(text || '');
  const fatal = [
    /uncaught exception/i,
    /unhandled rejection/i,
    /cannot find module/i,
    /ERR_ELECTRON/i,
    /SyntaxError:/i,
    /TypeError:.*(?:undefined|null)/i,
  ];
  return !fatal.some((re) => re.test(log));
}

module.exports = { processStayedAlive, secondInstanceWasRejected, startupLogLooksHealthy };
