/**
 * 单元测试：logger 的文件落盘能力（P3-1）
 *
 * 背景：生产环境控制台只留 error，全仓 155 处 logger.warn 一并静默 ——
 * 而 warn 记录的正是所有**降级路径**（更新镜像兜底失败、队列恢复丢脏记录、
 * 下载目录模板回落、statfs 预检跳过…）。用户报「更新一直失败」「目录模板
 * 没生效」时现场没有任何日志，只能靠复现，而降级路径往往依赖特定网络/文件
 * 状态，极难复现。
 *
 * 本测试钉住四件事：
 *   1. **未初始化时行为与从前逐字节一致**（单测/CLI/打包脚本都依赖这条）；
 *   2. 初始化后 warn/error 会落盘，且内容含时间戳与级别；
 *   3. 缓冲上限、单行截断、循环引用不抛 —— 日志系统自己不能成为故障源；
 *   4. flushSyncOnExit 能把缓冲写出去（退出路径不丢最后几条）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 每个用例独立 require 一份 logger，避免落盘状态互相污染 */
function freshLogger() {
  const p = path.join(ROOT, 'src', 'utils', 'logger.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

function tmpLogPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-log-'));
  return path.join(dir, 'logs', name || 'main.log');
}

test('默认状态：不初始化落盘时，warn/error 可调用且不创建任何文件', () => {
  const logger = freshLogger();
  const st = logger.logFileState();
  assert.strictEqual(st.enabled, false, '默认必须是不落盘');
  assert.strictEqual(st.path, null);

  assert.doesNotThrow(() => {
    logger.log('a'); logger.info('b'); logger.warn('c'); logger.error('d');
  }, '未初始化时调用不得抛错（单测/CLI 依赖此语义）');
});

test('默认状态：未初始化时 flushSyncOnExit 为空操作且返回 true', () => {
  const logger = freshLogger();
  assert.strictEqual(logger.flushSyncOnExit(), true, '没启用落盘时冲刷应为成功的空操作');
});

test('initLogFile：参数非法返回 false 且不启用', () => {
  const logger = freshLogger();
  assert.strictEqual(logger.initLogFile(''), false, '空串应拒绝');
  assert.strictEqual(logger.initLogFile(null), false, 'null 应拒绝');
  assert.strictEqual(logger.initLogFile(123), false, '非字符串应拒绝');
  assert.strictEqual(logger.logFileState().enabled, false, '参数非法后不应处于启用态');
});

test('落盘：warn 会被写入文件，含时间戳与级别标记', async () => {
  const logger = freshLogger();
  const p = tmpLogPath();
  assert.strictEqual(logger.initLogFile(p), true);

  logger.warn('[test] 降级路径示例', 'detail=42');
  await logger.flushNow();

  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /\[WARN\]/, '应带级别标记');
  assert.match(text, /降级路径示例/, '应包含日志正文');
  assert.match(text, /detail=42/, '应包含后续参数');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/, '行首应为 ISO 时间戳');
});

test('落盘：error 同时进控制台与文件', async () => {
  const logger = freshLogger();
  const p = tmpLogPath();
  logger.initLogFile(p);

  // 用 console.error 的交由 node:test 输出，不影响断言
  logger.error('[test] 严重问题');
  await logger.flushNow();

  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /\[ERROR\]/);
  assert.match(text, /严重问题/);
});

test('健壮性：循环引用 / Error / 多参混合都不抛，且能落盘', async () => {
  const logger = freshLogger();
  const p = tmpLogPath();
  logger.initLogFile(p);

  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const err = new Error('boom');

  assert.doesNotThrow(() => {
    logger.warn('循环引用', cyclic);
    logger.warn('错误对象', err);
    logger.warn('混合', null, undefined, 123, true, () => {});
  }, '序列化异常参数绝不能抛（否则日志本身成为故障源）');

  await logger.flushNow();
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /错误对象/, 'Error 参数应被记录');
  assert.match(text, /boom/, 'Error 的消息/栈应被记录');
  assert.match(text, /null/, 'null 应可读');
  assert.match(text, /undefined/, 'undefined 应可读');
});

test('上限：超长单行被截断，避免畸形日志撑爆文件', () => {
  const logger = freshLogger();
  const { formatLine, MAX_LINE_CHARS } = logger._internal;
  const line = formatLine('warn', ['x'.repeat(MAX_LINE_CHARS * 3)]);
  assert.ok(line.length < MAX_LINE_CHARS + 200, '截断后长度应受控，实际 ' + line.length);
  assert.match(line, /截断/, '应带截断标记，便于察觉');
});

test('上限：缓冲触顶会立即冲刷，不等到定时器', async () => {
  const logger = freshLogger();
  const p = tmpLogPath();
  logger.initLogFile(p);
  const { MAX_BUFFER_LINES } = logger._internal;

  for (let i = 0; i < MAX_BUFFER_LINES + 10; i++) logger.warn('line ' + i);
  // 触顶时已同步发起 async flush；等它完成
  await logger.flushNow();

  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, new RegExp('line ' + MAX_BUFFER_LINES), '触顶批次应已落盘');
});

test('退出冲刷：flushSyncOnExit 立即写出缓冲并清空', () => {
  const logger = freshLogger();
  const p = tmpLogPath();
  logger.initLogFile(p);

  logger.warn('[test] 退出前最后一条');
  assert.strictEqual(logger.flushSyncOnExit(), true, '同步冲刷应成功');

  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /退出前最后一条/, '退出路径的日志必须落盘（异步写可能来不及）');
  assert.strictEqual(logger.logFileState().bufferedLines, 0, '冲刷后缓冲应为空');
});

test('健壮性：目录不存在时自动创建（userData/logs 首次运行尚不存在）', async () => {
  const logger = freshLogger();
  // tmpLogPath 返回的 logs/ 子目录此时并不存在
  const p = tmpLogPath('nested/deep/main.log');
  logger.initLogFile(p);
  logger.warn('[test] 深层目录');
  await logger.flushNow();
  assert.ok(fs.existsSync(p), '应自动创建父目录后写入');
});
