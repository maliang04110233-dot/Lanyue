/**
 * 生产日志控制
 *
 * 开发环境：log / info / warn / error 全部输出到控制台
 * 生产环境（NODE_ENV === 'production'）：控制台仅输出 error，其余静默
 *
 * ⚠️ info 与 log 行为一致（都是「非生产才输出」）。
 *    它存在是因为 downloader.js 的断点续传分支调用了 logger.info ——
 *    此前 logger 只导出 { log, warn, error }，导致那条分支抛
 *    "logger.info is not a function"，**把断点续传整个打断**
 *    （只有传输出错且已有部分落盘时才会走到，故长期未被发现）。
 *    保留 info 既有语义、又补齐接口，比把调用点改成 log 更稳
 *    （调用点语义上确实是「信息」而非「日志」）。
 *
 * ── 2026-09-28 复审补充：warn 落盘（P3-1）────────────────────
 *
 * 问题：控制台「生产环境只留 error」本身是对的（不给用户刷屏），但全仓
 * **155 处 logger.warn** 也随之静默 —— 而这些 warn 恰恰记录了所有**降级路径**：
 * 更新镜像兜底失败（updater.js）、队列恢复丢弃脏记录（downloadQueue.js）、
 * 下载目录模板未生效（downloadPath.js）、路径模板回落、statfs 预检跳过……
 * 用户报「更新一直失败」「目录模板没生效」时，现场没有任何日志可看，
 * 只能靠复现，而降级路径往往依赖特定网络/文件状态，极难复现。
 *
 * 处置：控制台行为**保持不变**（不刷屏），另加可选的文件落盘。
 * 由主进程在 app ready 后调用 initLogFile(userData/logs/main.log) 开启；
 * **未调用时（单测、CLI、打包脚本）行为与从前逐字节一致**。
 *
 * 实现约束（主进程即 UI 线程，逐条都有代价）：
 *   - 全异步 appendFile，绝不同步写盘（同步 IO 会冻结窗口）；
 *   - 内存缓冲 + 定时合并落盘（默认 500ms），把「一条 warn 一次 IO」
 *     压成「一批一次 IO」；缓冲上限兜底，防日志风暴吃内存；
 *   - 落盘失败只吞不抛（日志坏掉不该让业务跟着崩），并置标记避免反复试探；
 *   - 单文件超过上限即轮转一份 .1（只保留一代，防止长期运行撑满磁盘）；
 *   - 定时器 unref()，不阻塞进程退出。
 */

const fsp = require('fs').promises;
const path = require('path');

const _isProduction = process.env.NODE_ENV === 'production';

// ── 落盘状态（全部默认关闭）─────────────────────────────
let _logPath = null;          // 启用后的日志文件绝对路径
let _buffer = [];             // 待写行
let _flushTimer = null;
let _enabled = false;         // 落盘开关（initLogFile 成功后为 true）
let _disabledByError = false; // 落盘出错后停用，避免每条日志都炸一次

/** 定时落盘间隔（ms）：合并写入，降低 IO 次数 */
const FLUSH_INTERVAL_MS = 500;
/** 缓冲行数上限：超过即立刻冲刷，防日志风暴把内存吃光 */
const MAX_BUFFER_LINES = 200;
/** 单文件上限：8 MB；超出即轮转为 .1（只留一代） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 单行长度上限：避免一条畸形日志（如巨大请求体）撑爆文件 */
const MAX_LINE_CHARS = 4000;

/** 参数 → 单行文本（对齐 console 的可读性，且永不抛错） */
function stringifyArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return String(a);
  if (typeof a === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
  try {
    return JSON.stringify(a);
  } catch (_e) {
    // 循环引用 / BigInt 混入等：退回 String，仍不抛
    try { return String(a); } catch (_e2) { return '[Unserializable]'; }
  }
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  let text = args.map(stringifyArg).join(' ');
  if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + '…[截断]';
  return `${ts} [${level.toUpperCase()}] ${text}\n`;
}

/** 当前日志文件是否已达上限（取不到大小按未超处理，绝不因统计失败挡日志） */
async function _needsRotate() {
  try {
    const st = await fsp.stat(_logPath);
    return st.size >= MAX_FILE_BYTES;
  } catch (_e) {
    return false;
  }
}

async function _rotate() {
  try {
    await fsp.rename(_logPath, _logPath + '.1');
  } catch (_e) {
    // 轮转失败（如 .1 被占用）不致命：继续往原文件写，
    // 大不了这一代超一点体积，好过日志整个停摆。
  }
}

/**
 * 把缓冲写入磁盘：串行排空，出错即停用。
 *
 * 并发正确性（单测暴露过一版 bug）：早期实现用 `if (_writing) return;` 做单飞，
 * 结果「触顶冲刷」与「定时冲刷」同时发生、后者抢先拿到 _writing 时，
 * 新入缓冲就被留在内存里直到下一个 500ms —— 若此时进程退出就丢了。
 * 现在改为：并发调用共享同一次排空循环，循环一直到缓冲为空才结束，
 * 任何调用方 await 到的都是「此刻已入缓冲的内容都已写出」。
 */
let _drainPromise = null;

function _flush() {
  if (!_enabled || _disabledByError) return Promise.resolve();
  if (_drainPromise) return _drainPromise; // 已有排空在跑，它会带走新入的行

  _drainPromise = (async () => {
    try {
      // 循环排空：一次 append 期间可能又有新行进来
      for (;;) {
        if (_disabledByError || !_buffer.length) break;
        const batch = _buffer.join('');
        _buffer = [];
        try {
          await fsp.mkdir(path.dirname(_logPath), { recursive: true });
          if (await _needsRotate()) await _rotate();
          await fsp.appendFile(_logPath, batch, 'utf8');
        } catch (_e) {
          // 落盘失败不抛：日志系统的故障不该升级成业务故障。
          // 停用开关避免每写一条都失败一次（磁盘满/权限变更等持续态）。
          _disabledByError = true;
          break;
        }
      }
    } finally {
      _drainPromise = null;
    }
  })();
  return _drainPromise;
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _flush().catch(() => { /* 已在 _flush 内归口，这里只是防未处理拒绝 */ });
  }, FLUSH_INTERVAL_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * 采集一行待落盘日志。仅在落盘启用后才做事 —— 未启用时是**零开销**的空函数，
 * 保证单测/CLI 下与从前完全一致。
 */
function _sink(level, args) {
  if (!_enabled || _disabledByError) return;
  _buffer.push(formatLine(level, args));
  // 缓冲触顶：立刻冲刷而不等定时器（日志风暴时优先保证不丢关键上下文）
  if (_buffer.length >= MAX_BUFFER_LINES) {
    _flush().catch(() => { /* 同上 */ });
    return;
  }
  _scheduleFlush();
}

function log(...args) {
  if (!_isProduction) {
    console.log(...args);
  }
  _sink('log', args);
}

/** 信息级日志：与 log 同级别（非生产才输出） */
function info(...args) {
  if (!_isProduction) {
    console.log(...args);
  }
  _sink('info', args);
}

function warn(...args) {
  if (!_isProduction) {
    console.warn(...args);
  }
  _sink('warn', args);
}

function error(...args) {
  console.error(...args);
  _sink('error', args);
}

/**
 * 启用文件落盘。由主进程在 app ready 后调用一次。
 *
 * @param {string} filePath 日志文件绝对路径（调用方负责给 userData 下的路径）
 * @returns {boolean} 是否启用成功（参数非法即 false，绝不抛）
 */
function initLogFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  try {
    _logPath = path.resolve(filePath);
  } catch (_e) {
    return false;
  }
  _enabled = true;
  _disabledByError = false;
  _buffer = [];
  _sink('log', [`[logger] 日志落盘已启用: ${_logPath}`]);
  return true;
}

/**
 * 立即冲刷缓冲（进程退出前调用，防 500ms 窗口内的最后几条丢失）。
 * @returns {Promise<void>}
 */
async function flushNow() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await _flush();
}

/**
 * 退出路径专用：同步冲刷。
 *
 * 为什么这里允许同步 IO：window-all-closed 之后 app.quit() 立即返回，
 * 异步 appendFile 排在事件循环里可能**还没落盘进程就没了**；而此时窗口
 * 已经在关闭、UI 对冻结不敏感，同步写是正确取舍（与 prefs.flush 同款理由）。
 * 仅在应用退出时调用，常规运行期一律走异步 _flush。
 *
 * @returns {boolean} 是否写出成功
 */
function flushSyncOnExit() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!_enabled || _disabledByError || !_buffer.length) return true;
  const batch = _buffer.join('');
  _buffer = [];
  try {
    const fsSync = require('fs');
    fsSync.mkdirSync(path.dirname(_logPath), { recursive: true });
    // 退出路径不再做体积轮转判断：一次退出最多多写 8MB 量级，
    // 而多做一次 stat + rename 反而增加退出时的不确定性。
    fsSync.appendFileSync(_logPath, batch, 'utf8');
    return true;
  } catch (_e) {
    _disabledByError = true;
    return false;
  }
}

/** 当前落盘状态（供诊断与测试使用） */
function logFileState() {
  return {
    enabled: _enabled,
    path: _logPath,
    disabledByError: _disabledByError,
    bufferedLines: _buffer.length,
  };
}

module.exports = {
  log, info, warn, error,
  initLogFile, flushNow, flushSyncOnExit, logFileState,
  // 供单测：验证上限与格式化行为
  _internal: { stringifyArg, formatLine, MAX_FILE_BYTES, MAX_BUFFER_LINES, MAX_LINE_CHARS },
};
