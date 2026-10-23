'use strict';

/**
 * Windows 解包产物真机冒烟。共 8 条断言，按执行顺序：
 *
 *   1) 首实例可拉起并在 6 秒观察期内持续存活；
 *   2) 第二实例被单实例锁快速拒绝并以 0 退出；
 *   3) 两个实例的 stdout/stderr 无常见致命错误；
 *   4) 本次启动确实写入了 main.log（独立断言，无新增即判失败）；
 *   5) 上述增量日志内无常见致命错误；
 *   6) 增量日志内全局快捷键注册成功（「已注册 N/M」且 N≥1）；
 *   7) 增量日志内无 [tray] 失败记录（托盘没有起不来）；
 *   8) 主窗口渲染层已加载（增量日志出现 [main] loadFile done）。
 *
 * 第 4~8 条消费的是主进程既有日志（src/main/index.js:128-131、
 * src/main/globalShortcuts.js:51、src/main/tray.js:52）。增量窗口从首个实例
 * spawn 之前的字节偏移算起：「无新增」直接判失败（进程没进主进程或日志路径
 * 变了）；「日志轮转/截断」只允许退化为尾部做诊断输出，四条日志内容断言一律
 * 不判绿。历史日志不得作为本次启动的证据。
 *
 * 第 8 条是 2026-10-23 补的：前 7 条全部只证明「进程活着」，7/7 全绿时用户
 * 仍可能拿到白屏应用（实测 --disable-gpu-sandbox 下进程存活但每次
 * loadFile failed: ERR_FAILED，CDP 查到 page target 但 title=""）。
 * 本环境渲染进程沙箱起不来，所以这一条在本机会真红；受限环境下可用
 * SMOKE_SKIP_RENDER_CHECK=1 显式跳过（记 SKIP，不记 PASS，见该开关的注释）。
 *
 * 环境依赖（Windows 真机冒烟的三项非可选配置，均附实测现象）：
 *
 * a) 子进程必须 `detached: true`（脱离父进程 job object）。
 *    现象：受限环境（agent sandbox / CI runner / 部分 IDE 拉起的进程树）下，
 *    未 detached 的 exe 被并入父进程 job，立即以 0x80000003
 *    （STATUS_BREAKPOINT，十进制 2147483651）退出；同一 exe 在 bash 后台直接
 *    启动可存活 8s。对照清单见 buildChildEnv 上方注释。
 *    代价：子进程不再随父进程退出而退出，故收尾必须 taskkill /T /F（见 stop()）。
 *
 * b) 必须清掉子进程环境里的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS。
 *    现象：工具链注入的 ELECTRON_RUN_AS_NODE=1 被 exe 继承后，exe 以纯 Node
 *    模式运行——exit=0、零 stdout/stderr、无窗口、连 userData 目录都不创建；
 *    此时给它传 --user-data-dir 会打印「bad option: --user-data-dir=...」
 *    （Node.js 的选项解析错误，标准 Electron 认识该参数）。残留 NODE_OPTIONS
 *    则启动即打「ERROR: Most NODE_OPTIONs are not supported in packaged apps」。
 *
 * c) 默认给子进程追加 `--disable-gpu-sandbox`，可用 SMOKE_BARE_LAUNCH=1 关闭。
 *    现象：修好 a) 之后才暴露的环境噪声——GPU 子进程反复以 0xC0000005
 *    (-1073741819) 崩溃，gpu_data_manager 打 FATAL 后触发断点，主进程以
 *    0x80000003 退出（实测 4.6–6.3s），「存活 6 秒」「第二实例被拒绝」两条
 *    断言在受限环境里变成抛硬币。
 *    这里必须认清：旗标是**环境适配**、不是产品修复，所以它得「可见且可关闭」。
 *    可见——开跑第一行打 ENV 声明（含旗标名），汇总行再重复一次启动方式，
 *      因为验收单贴的通常是尾部若干行，声明只放开头等于没写；
 *    可关闭——SMOKE_BARE_LAUNCH=1 不追加任何旗标，真正模拟用户双击。
 *      真机/发版前应至少裸跑一次：带旗标通过 ≠ 裸启动通过，两者是不同强度的
 *      结论，只有裸启动通过才够得上「产品可用」这一档。
 *
 * 用法：node scripts/smoke-test-manual.js [exe路径]
 * 默认：release/win-unpacked/Lanyue.exe
 *
 * 两个环境变量（都必须是严格 '=1'，'0'/false/no 一律视为未开启）：
 *   SMOKE_BARE_LAUNCH=1       不追加任何旗标（裸启动，见上 c)）；
 *   SMOKE_SKIP_RENDER_CHECK=1 第 8 条记 SKIP 而非判定（见其注释，会把结论
 *                             明确写成「渲染层: 未验证」，不是 PASS）。
 *
 * 退出码：0 全通过（含显式跳过）；1 断言失败；2 环境/产物缺失。
 * 跳过不计入失败 —— 否则开关就没意义；但它也绝不算通过，汇总行会单独报数。
 *
 * 找不到 main.log 时（本机日志路径与产物配置不符，两个候选目录都不存在）：
 * 依赖日志的 5 条断言一律记 **FAIL**（不是 SKIP），汇总行分母仍是 8，形如
 * 「3/8 通过 ｜ 日志缺失，5 条未验证」，退出码 1。理由：SKIP 是「显式声明后
 * 允许不做」，本机没有日志属冒烟前提不成立，按 docs/process/QA.md §五
 * 「条件错」口径，条件不可判定不得写通过。
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  processStayedAlive,
  secondInstanceWasRejected,
  startupLogLooksHealthy,
  shortcutsRegisteredInLog,
  trayFailureAbsent,
  logIncrementalState,
  rendererLoadedState,
} = require('./release-smoke-checks.cjs');

/**
 * 子进程启动方式：可见（ENV 行 + 汇总行）且可关闭（SMOKE_BARE_LAUNCH=1）。
 * 详见头注释「环境依赖」第 c) 条。
 *
 * 开关必须是严格字符串比较：'0' / 'false' / '' / 'no' 一律视为未开启。
 * 用真值判断（`if (process.env.SMOKE_BARE_LAUNCH)`）会让
 * `SMOKE_BARE_LAUNCH=0` 意外变成裸启动——那正好是本环境随机红的成因。
 */
const GPU_SANDBOX_FLAG = '--disable-gpu-sandbox';
const BARE_LAUNCH = process.env.SMOKE_BARE_LAUNCH === '1';

/** 实际传给子进程的参数。裸启动时为空数组，与用户双击行为一致。 */
const CHILD_ARGS = BARE_LAUNCH ? [] : [GPU_SANDBOX_FLAG];

/** 启动方式的人类可读描述，同时用于 ENV 声明行与汇总行。 */
const LAUNCH_MODE_LABEL = BARE_LAUNCH
  ? '裸启动（无附加旗标，与用户双击行为一致）'
  : `带 ${GPU_SANDBOX_FLAG}（非裸启动）`;

/**
 * 渲染层加载断言的显式跳过开关（第 8 条）。
 *
 * 为什么需要它：本执行环境（agent sandbox / 部分 CI runner / 无桌面会话的
 * 虚拟化环境）里渲染进程沙箱起不来，loadFile 每次都以 ERR_FAILED (-2) 失败
 * ——同机实测：`--no-sandbox` 下 title="揽乐"、日志 loadFile done；去掉它
 * 就是白屏 + loadFile failed。也就是说本机这一条**会真红**，且这是正确的红。
 *
 * 但「真红」不该把其余 7 条一起拖成跑不完/看不清。所以给一个**显式、留痕、
 * 不默认**的开关：置 1 时第 8 条输出 SKIP（明确不是 PASS），message 写明
 * 渲染层未验证、须在真实桌面会话补做；其余 7 条照常判定；汇总行显示
 * 「N/M 通过 K 跳过 ｜ 渲染层: 未验证」。
 *
 * 三条硬约束（改这条断言时不许松）：
 *   1) 不许把跳过做成默认 —— 默认路径必须先真判定，本机因此真红；
 *   2) 不许把 failed 判成 PASS —— 白屏是用户可见缺陷，判绿等于自欺；
 *   3) 开关严格比较字符串 '1'。用真值判断会让 SMOKE_SKIP_RENDER_CHECK=0 /
 *      false / no 意外变成跳过（= 把红藏起来），这是最坏的失效方向。
 */
const SKIP_RENDER_CHECK = process.env.SMOKE_SKIP_RENDER_CHECK === '1';

/** 第 8 条断言的名称（SKIP 分支与判定分支共用，避免两处文案漂移）。 */
const RENDER_CHECK_NAME = '主窗口渲染层已加载（增量日志出现 [main] loadFile done）';

/** 跳过时写入验收单的说明：必须自证「未验证」，不许被读成「已通过」。 */
const RENDER_SKIP_NOTE =
  '渲染层未验证：本环境渲染进程沙箱不可用（实测 ERR_FAILED），须在真实桌面会话补做';

/** 失败时的归因提示：把「白屏」这件事直接写到验收单上。 */
const RENDER_FAIL_HINT =
  '渲染层未加载 = 用户白屏；若同时有 GPU/沙箱相关错误，先按环境错处理并改用真实桌面会话复测';

/**
 * 从增量日志里摘出 loadFile 失败的原文原因。
 * 真机实测形如：
 *   [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///...'
 * 只摘最后一条失败行（与时序判据一致），并保证 ERR_* 错误码一定出现在
 * message 里 —— 否则验收单上只剩「失败了」，复核的人无从判断是环境错还是
 * 产物错。
 */
function rendererFailureDetail(text) {
  const log = String(text || '');
  const lines = log.match(/\[main\]\s*loadFile\s+failed[^\r\n]*/gi) || [];
  const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
  const codeMatch = lastLine.match(/\bERR_[A-Z0-9_]+/) || log.match(/\bERR_[A-Z0-9_]+/);
  const code = codeMatch ? codeMatch[0] : '';
  const parts = [];
  if (lastLine) parts.push(lastLine.slice(0, 300));
  if (code && !lastLine.includes(code)) parts.push(`错误码 ${code}`);
  if (!parts.length) parts.push('增量日志未包含失败的详细原因');
  return parts.join(' ｜ ');
}

/**
 * ENV 声明行：脚本开跑的最前面输出一次（早于任何 check()）。
 * 冒烟产出的是一张给发版人签字的验收单，验收单必须自证「用了什么启动方式」，
 * 否则就是在用环境适配冒充产品可用。
 */
const ENV_LINE = BARE_LAUNCH
  ? 'ENV   子进程附加旗标: 无（裸启动，与用户双击行为一致）'
  : `ENV   子进程附加旗标: ${GPU_SANDBOX_FLAG}（受限环境 GPU 子进程崩溃，实测 0x80000003；裸启动见 SMOKE_BARE_LAUNCH=1）`;

console.log(ENV_LINE);

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

/** 依赖 main.log 的断线条数（第 4~8 条），汇总行与失败说明共用，避免数字漂移。 */
const LOG_DEPENDENT_COUNT = 5;

/**
 * 断言总数 = 汇总行的分母。
 *
 * 算术：进程侧 3 条（存活 / 第二实例被拒 / stdout-stderr 无致命错误）
 *     + 日志侧 5 条（有增量 / 增量无致命错误 / 快捷键 / 托盘 / 渲染层）= 8。
 *
 * 为什么必须是常量而不是 `results.length`：日志缺失路径下那 5 条压根没执行，
 * 拿 results.length 当分母会把汇总印成「3/3 通过」——验收人读到的是全绿，而
 * 事实是 5 条一条没验。口径定为「分母 = 全部断言，含因条件缺失未执行的」，且
 * 正常路径与日志缺失路径共用同一个 8；日志缺失路径靠补记 5 条 FAIL 让
 * results.length 也回到 8，finish() 里的记账自检会把这件事钉死。
 */
const TOTAL_ASSERTIONS = 8;

/**
 * 日志缺失时的统一失败说明。五个 FAIL 共用它，措辞里必须同时写出「查了哪几处」
 * 和「这不算通过」，否则验收单上只剩一句「失败」，复核的人无从判断是产物问题
 * 还是观测条件问题。
 */
const LOG_MISSING_DETAIL =
  `未定位到本机 main.log（检查过 APPDATA/music-downloader 与 APPDATA/Lanyue 两处），`
  + `依赖日志的 ${LOG_DEPENDENT_COUNT} 条断言无法验证 —— 这属观测条件缺失，不得当作通过`;

/**
 * 断言记账：三种状态 pass / fail / skip。
 *
 * skip 只服务于第 8 条在受限环境下的显式跳过（SMOKE_SKIP_RENDER_CHECK=1），
 * 语义上「既不是通过也不是失败」：不计入通过数，但**也不计入失败数**——
 * 否则显式跳过会让退出码变红，开关就失去意义。汇总行必须把跳过数单独写出来
 * （「7/8 通过 1 跳过」），让跳过永远无法被误读成通过。
 */
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, status: ok ? 'pass' : 'fail' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
/** 显式跳过：输出 SKIP（不是 PASS），并单独计数。 */
const skip = (name, detail = '') => {
  results.push({ name, status: 'skip' });
  console.log(`SKIP  ${name}${detail ? ' — ' + detail : ''}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 渲染层的汇总结论。默认「未验证」——日志缺失路径要把第 8 条记成 FAIL 并把
 * 这里改成「未验证（日志缺失）」，绝不能让汇总行暗示渲染层已验证。
 */
let rendererSummary = '未验证';

/**
 * 汇总并落退出码。
 *
 * @param {string} [note] 追加在通过数之后的结论性说明（目前只有日志缺失路径用，
 *   内容为「日志缺失，N 条未验证」）。放在通过数右边，是因为验收单通常只贴
 *   尾部几行，「3/8 通过」单独出现仍然可能被读成「还行」，必须紧跟一句它为什么
 *   不是 8。
 */
const finish = (note = '') => {
  const passed = results.filter((r) => r.status === 'pass').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  // 记账自检：两条路径都应恰好记录 TOTAL_ASSERTIONS 条（日志缺失路径靠补记
  // 5 条 FAIL 补齐）。不等就说明分母与实际记账脱节，此时的汇总行不可信 ——
  // 按 fail-closed 直接判红，不许印出一个看似能签字的分数。
  const bookkeepingOk = results.length === TOTAL_ASSERTIONS;
  if (!bookkeepingOk) {
    console.log(
      `WARN  断言记账与分母不一致: 已记录 ${results.length} 条 / 分母 ${TOTAL_ASSERTIONS} 条 —— 汇总口径不可信，判红`,
    );
  }
  // 汇总行必须重复一次启动方式：验收单贴的通常是尾部若干行，
  // 只把旗标状态放在开头的 ENV 行等于没写。渲染层结论同理——它是「界面能用」
  // 的唯一证据，必须落在汇总行上，而不是只留在中间某一行 PASS/SKIP 里。
  const skippedPart = skipped ? ` ${skipped} 跳过` : '';
  const notePart = note ? ` ｜ ${note}` : '';
  console.log(
    `\n${passed}/${TOTAL_ASSERTIONS} 通过${skippedPart}${notePart} ｜ 启动方式: ${LAUNCH_MODE_LABEL} ｜ 渲染层: ${rendererSummary}`,
  );
  process.exitCode = failed || !bookkeepingOk ? 1 : 0;
};

/**
 * detached 子进程的同步强杀（用于 stop() 兜底与进程退出兜底）。
 * Windows 下必须用 taskkill /T 才能连渲染进程与崩溃处理子进程一并带走。
 */
function forceKillSync(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    // 进程已退出（taskkill 返回 128）或权限不足，交由调用方重试/忽略。
  }
}

// detached: true 让子进程脱离了父进程的 job object，也就脱离了「父进程退出时
// 子进程被一并回收」的默认语义。这里登记所有已拉起的子进程，进程退出时同步
// 清场，避免门禁异常中断后在机器上留下幽灵 Lanyue.exe（残留首实例会让下一次
// 「第二实例被拒绝」断言直接失效）。
const liveChildren = new Set();
const trackChild = (child) => {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
};
process.on('exit', () => {
  for (const child of liveChildren) forceKillSync(child.pid);
});

/**
 * 拉起 exe 并采集 stdout/stderr。
 *
 * 这里有两项非可选配置，均为 2026-10-23 真机定位的实测结论：
 *
 * 1) `detached: true` —— 在受限 job object（agent sandbox / CI runner / 某些
 *    IDE 启动的进程树）下，子进程会被并入父进程所在的 job。此时未 detached
 *    启动的 Electron exe 立即以 0x80000003（STATUS_BREAKPOINT，十进制
 *    2147483651）退出。对照实测（同一个 exe、同一环境）：
 *      bash 后台直接启动                                → ALIVE 8s（stdout 打全 8 个平台注册完成）
 *      spawn(exe, [], { stdio: ['ignore','pipe','pipe'] }) → EXITED 2147483651
 *      spawn(exe, [], { stdio: 'ignore' })                 → EXITED 2147483651
 *      spawn(exe, [], { stdio: ['ignore', fd, fd] })       → EXITED 2147483651
 *      spawn(exe, [], { shell: true })                     → EXITED 1
 *      spawn(exe, [], { detached: true })                  → ALIVE
 *    代价：子进程不再随父进程退出而退出，故 stop() 必须走 taskkill /T /F。
 *
 * 2) env 清理 —— 开发工具链会向本机环境注入 ELECTRON_RUN_AS_NODE=1，被 exe
 *    继承后 exe 以纯 Node 模式运行：exit=0、零 stdout/stderr、无窗口、连
 *    userData 目录都不创建；给它传 --user-data-dir 会输出
 *    「bad option: --user-data-dir=...」（Node.js 的选项解析错误，标准 Electron
 *    认识该参数）。清掉后同一个 exe 立即正常启动。NODE_OPTIONS 一并清，否则
 *    启动即打「ERROR: Most NODE_OPTIONs are not supported in packaged apps」。
 *    注意不可写成 `{ ELECTRON_RUN_AS_NODE: undefined }` —— Node 会把 undefined
 *    序列化成字符串 "undefined" 传给子进程，等于注入了一个值为 "undefined"
 *    的变量。正确做法是拷贝 process.env 后 delete 再传入。
 */
function buildChildEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * 拉起 exe 时附加的参数。
 *
 * `--disable-gpu-sandbox` —— 受限执行环境（沙箱/CI/虚拟化）里 GPU 子进程起不来，
 * 反复以 0xC0000005(-1073741819) 崩溃，随后 gpu_data_manager 打 FATAL 并调用
 * 断点，主进程以 0x80000003 退出。这是在修复 detached 之后才暴露出来的环境噪声
 * ——此前首实例在 spawn 阶段就死了，压根跑不到这里。2026-10-23 实测（单实例在
 * 不同旗标下 15 秒内存活情况）：
 *   []                                            → exit 2147483651 @5382ms
 *   ['--disable-gpu']                             → exit 2147483651 @4815ms
 *   ['--disable-gpu','--disable-software-rasterizer','--disable-gpu-compositing']
 *                                                 → exit 2147483651 @6288ms
 *   ['--use-gl=swiftshader','--disable-gpu']      → exit 2147483651 @4635ms
 *   ['--disable-gpu-sandbox']                     → alive@15s
 *   ['--in-process-gpu']                          → alive@15s
 * 选 `--disable-gpu-sandbox`：只关掉 GPU 进程沙箱，渲染/合成路径与生产一致，
 * 对断言口径没有任何放宽；`--in-process-gpu` 会改变进程架构，侵入性更大。
 * 不加这一项，「存活 6 秒」与「第二实例被拒绝」两条断言在受限环境里是抛硬币。
 *
 * 由于它是环境适配而非产品修复，本文件不把它写死：默认开启（否则本环境随机红），
 * SMOKE_BARE_LAUNCH=1 关闭（裸启动，与用户双击一致），并在 ENV 行与汇总行
 * 双向声明，避免「带旗标通过」被当成「产品可用」。取值见文件顶部 CHILD_ARGS /
 * BARE_LAUNCH / LAUNCH_MODE_LABEL。
 */

const capture = () => {
  const state = { spawnError: null, exitCode: null, exitSignal: null, stdout: '', stderr: '', timedOut: false };
  const child = spawn(exePath, CHILD_ARGS, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: true,
    env: buildChildEnv(),
  });
  trackChild(child);
  child.stdout.on('data', (d) => { state.stdout = (state.stdout + d).slice(-8000); });
  child.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-8000); });
  child.on('error', (e) => { state.spawnError = e; });
  child.on('exit', (code, signal) => { state.exitCode = code; state.exitSignal = signal; });
  return { child, state };
};

/** 等待子进程退出，最多 timeoutMs 毫秒；已退出则立即返回。 */
function waitExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

/**
 * 终止子进程。
 *
 * detached: true 之后，Windows 上 child.kill('SIGTERM') 只对自身句柄发信号，
 * 对已脱离进程组的 Electron 进程树不可靠（渲染进程/崩溃处理子进程可能残留）。
 * 因此 Windows 走 taskkill /PID /T /F，再以 child.kill('SIGKILL') 与
 * process.kill(pid) 兜底，并用「进程树是否仍有同名进程」做最终确认。
 * 残留首实例会让「第二实例被单实例锁拒绝」断言读到错误结论，所以这一步
 * 必须可靠，不能只是尽力而为。
 */
async function stop(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;

  if (process.platform === 'win32' && pid) {
    forceKillSync(pid);
    if (await waitExit(child, 3000)) return;
  }

  try { child.kill('SIGTERM'); } catch (_) { /* 句柄可能已失效 */ }
  if (await waitExit(child, 1500)) return;

  try { child.kill('SIGKILL'); } catch (_) { /* 句柄可能已失效 */ }
  if (await waitExit(child, 1500)) return;

  if (pid) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* 进程已不存在 */ }
    await waitExit(child, 1000);
  }
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
    // ── 日志缺失：冒烟前提不成立 → 5 条日志侧断言一律 FAIL ──────────────────
    // 这里原先只打一行 SKIP 就 finish()，于是汇总行分母只含已执行的前 3 条，
    // 印出来是「3/3 通过」，读起来像全绿 —— 而依赖日志的 5 条（含第 8 条
    // 渲染层）一条都没验。这不只是文案问题：验收人会据此签字。
    //
    // 为什么是 FAIL 不是 SKIP：SKIP 的语义是「显式声明后允许不做」（见
    // SMOKE_SKIP_RENDER_CHECK），而本机没有 main.log 属观测条件缺失，前提不
    // 满足就该红。参照 docs/process/QA.md §五：条件本身不可判定时「不改条件
    // 语义」，同样也不得写成通过。
    console.log(`日志观测条件缺失 —— ${LOG_MISSING_DETAIL}`);
    failLogDependentAssertions(LOG_MISSING_DETAIL);
    rendererSummary = '未验证（日志缺失）';
    await stop(second && second.child);
    await stop(first.child);
    finish(`日志缺失，${LOG_DEPENDENT_COUNT} 条未验证`);
    return;
  }
  if (logPath !== logPathPre) {
    console.log('WARN  使用的 main.log 路径在启动前后发生了变化，增量切片退化为尾部片段');
  }

  // 增量读取：fs.statSync 偏移是字节，多字节 UTF-8 字符可能被切在中间。
  // 安全做法：从偏移处切片后，若首字节不是合法 UTF-8 序列起点，
  // 再往前多回退 4 字节内的对齐窗口，然后跳到下一行行首。
  const buf = fs.readFileSync(logPath);
  const tailWindowStart = Math.max(0, buf.length - 20000);
  const logPathChanged = logPathPre != null && logPath !== logPathPre;

  // ---- 缺陷 3 修复：增量状态显式化，禁止静默退化为历史尾部 ----
  // 调用顺序是判据的一部分，不可调换：
  //   1) 先由 spawnOffset（首实例 spawn 之前的字节偏移）算出 logIncrementalState；
  //   2) 只有 'fresh' 才允许把增量切片交给四条日志内容断言（无致命错误 /
  //      快捷键 / 托盘 / 渲染层）；
  //   3) 'empty' / 'rotated' 一律不得判绿（历史内容无法证明本次启动健康）。
  // 启动前没有 main.log（spawnOffset === null）时基线按 0 计：此时整份文件都是
  // 本次启动写的，'fresh' 成立，且不存在历史内容冒充的情况。
  const baseline = spawnOffset == null ? 0 : spawnOffset;
  let logState = logIncrementalState(buf.length, baseline);
  if (logPathChanged) {
    // 启动前后定位到的不是同一个文件，偏移失去意义，只能退化为尾部。
    logState = 'rotated';
  }

  let incremental = '';
  if (logState === 'fresh') {
    incremental = buf.slice(baseline).toString('utf8');
    if (baseline < buf.length && buf[baseline] >= 0x80) {
      // 切点落在多字节序列中间 → 丢弃第一行
      incremental = incremental.replace(/^[^\n]*\n?/, '');
    }
  } else if (logState === 'rotated') {
    // 唯一允许的退化路径：仅用于诊断输出，下面四条日志内容断言全部被禁用。
    console.log('WARN  日志被轮转/截断，增量退化为尾部');
    incremental = buf.slice(tailWindowStart).toString('utf8');
  }

  const logStateDetail = logState === 'empty'
    ? '本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化'
    : '日志被轮转/截断，增量退化为尾部，无法区分新旧内容';

  // 独立断言：本次启动到底有没有写日志。这一条不过，后面四条日志内容断言一律
  // FAIL（含第 8 条渲染层），绝不允许「读到历史尾部」冒充本次启动健康。
  check('本次启动写了日志（main.log 增量非空）', logState === 'fresh',
    logState === 'fresh' ? `${buf.length - baseline} B 新增` : logStateDetail);

  const canAssertLogContent = logState === 'fresh';
  const logDetail = (okDetail) => (canAssertLogContent ? okDetail : logStateDetail);

  check('本机 main.log 增量无常见致命错误',
    canAssertLogContent && startupLogLooksHealthy(incremental),
    logDetail(path.relative(os.homedir(), logPath)));
  check('全局快捷键注册成功（已注册 N/M 且 N≥1）',
    canAssertLogContent && shortcutsRegisteredInLog(incremental),
    logDetail(shortcutsRegisteredInLog(incremental) ? '' : '增量日志未出现「[shortcuts] 全局快捷键已注册 N/M」或 N=0'));
  check('托盘启动无失败记录（日志无 [tray] 告警）',
    canAssertLogContent && trayFailureAbsent(incremental),
    logDetail(trayFailureAbsent(incremental) ? '' : '增量日志包含 [tray] 失败记录'));

  // ── 第 8 条：主窗口渲染层已加载 ─────────────────────────────────────────
  // 前 7 条都是「进程活着」的证据，白屏应用可以 7/7 全绿地通过它们。
  // 这一条读主进程既有日志（src/main/index.js:128-131）：
  //   loadFile(...).then(→ '[main] loadFile done')
  //              .catch(→ '[main] loadFile failed:', err)
  // 判定交给纯函数 rendererLoadedState（loaded / failed / unknown，
  // 「先 failed 后 done」按最后一次算，见该函数注释）。
  //
  // 三种非绿路径都必须说出来，不能只说「失败」：
  //   failed   —— 带上原文失败原因（如 ERR_FAILED）+ 白屏归因提示；
  //   unknown  —— 说明「未出现完成记录」的两种可能（没建窗口 / 日志口径变了）；
  //   非 fresh —— 连增量都没有，无从判定（不得因为「没读到失败的证据」就判绿）。
  // 受限环境的显式跳过见 SKIP_RENDER_CHECK 的注释：记 SKIP，绝不记 PASS。
  if (SKIP_RENDER_CHECK) {
    skip(RENDER_CHECK_NAME, RENDER_SKIP_NOTE);
    rendererSummary = '未验证';
  } else if (!canAssertLogContent) {
    check(RENDER_CHECK_NAME, false,
      `${logStateDetail}（增量日志不可采信，无法判定渲染层是否加载）`);
    rendererSummary = '未验证（增量日志不可采信）';
  } else {
    const renderState = rendererLoadedState(incremental);
    if (renderState === 'loaded') {
      check(RENDER_CHECK_NAME, true, '增量日志出现 [main] loadFile done');
      rendererSummary = '已加载（loadFile done）';
    } else if (renderState === 'failed') {
      check(RENDER_CHECK_NAME, false, `${rendererFailureDetail(incremental)} —— ${RENDER_FAIL_HINT}`);
      rendererSummary = '未加载（loadFile failed）';
    } else {
      check(RENDER_CHECK_NAME, false,
        '本次启动未出现 loadFile 完成记录 —— 应用可能启动后未创建窗口，或日志口径变化');
      rendererSummary = '无记录';
    }
  }

  await stop(second && second.child);
  await stop(first.child);
  finish();
}

/**
 * 日志缺失路径要补记的 5 条 FAIL（第 4~8 条，全部依赖 main.log）。
 *
 * 为什么是 FAIL 而不是 SKIP：SKIP 的语义是「显式声明后允许不做」（见
 * SMOKE_SKIP_RENDER_CHECK），而本机没有 main.log 属冒烟前提不成立。按
 * docs/process/QA.md §五 的「条件错」口径：条件本身不可判定时既不改条件语义、
 * 也不得写成通过 —— 前提不满足就该红，退出码 1。
 *
 * 名字必须与 main() 正常路径里那四处 check('...') 逐字一致：两处改名不同步会
 * 让验收单上出现两个不同的断言名。之所以不用常量集中管理，是因为
 * test/release-smoke-checks.test.js:114 的静态守卫认的是正常路径的**字面量**
 * 调用形态（check('本次启动写了日志（main.log 增量非空）' 等），抽成
 * CHECK_NAMES.xxx 会让那条守卫变红 —— 守卫是契约，不动它。
 *
 * 用函数声明（而非 const 箭头函数）是为了拿函数提升：它在 main() 的早退分支里
 * 被调用，而本声明在源码上位于 main() 之后，const 会踩 TDZ。
 *
 * @param {string} detail 统一失败说明（LOG_MISSING_DETAIL），5 条共用。
 */
function failLogDependentAssertions(detail) {
  check('本次启动写了日志（main.log 增量非空）', false, detail);
  check('本机 main.log 增量无常见致命错误', false, detail);
  check('全局快捷键注册成功（已注册 N/M 且 N≥1）', false, detail);
  check('托盘启动无失败记录（日志无 [tray] 告警）', false, detail);
  check(RENDER_CHECK_NAME, false, detail);
}

main().catch((e) => {
  console.error('发行冒烟执行失败:', e && e.stack || e);
  process.exitCode = 2;
});
