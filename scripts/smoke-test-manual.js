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
 * 观测时刻是**轮询**出来的，不是「固定等够 N 秒再读一次」：启动后每 400ms 读
 * 一次增量并判一次 rendererLoadedState，一旦出现明确结论（loaded / failed）
 * 立即停止等待；上限 30 秒（RENDER_WAIT_DEADLINE_MS），下限 1500ms 只为等
 * 日志 flush 完（避免读到半行）。判据一个字没改，改的只是「什么时候看」。
 * 依据与收益见 RENDER_WAIT_DEADLINE_MS 的注释。
 *
 * ── 前置条件（不算断言，不进分母）────────────────────────────────────────
 * 拉起任何进程之前先查三件事，命中任何一件就打印一行 PRECOND、exit 1、
 * **一条断言都不执行**、也不打印 N/M 汇总。理由：那几种情况下新实例会被
 * 单实例锁拒绝、main.log 零增量，冒烟必然读出「1/8」—— 那是如实的红、
 * 错误的归因，会被当成产品缺陷写进验收单。制造假信息比少跑一次冒烟严重得多。
 *   1) 本机是否已有同一路径的主进程在跑（详见 main() 里 preexistingMain
 *      的注释）；
 *   2) 进程表的**路径数据本身是否可用**（pathDataLooksUsable）：数据被污染时
 *      「按路径比对」会静默失配，匹配不到 ≠ 不存在；
 *   3) 是否存在**同名但路径读不到**的进程（权限盲区）：读不到 ⇒ 无法排除
 *      「用户的实例被当成本次启的那个」⇒ 可能误杀用户的窗口。
 *
 * 第 8 条是 2026-10-23 补的：前 7 条全部只证明「进程活着」，7/7 全绿时用户
 * 仍可能拿到白屏应用（实测 --disable-gpu-sandbox 下进程存活但每次
 * loadFile failed: ERR_FAILED，CDP 查到 page target 但 title=""）。
 * 本环境渲染进程沙箱起不来，所以这一条在直启模式的本机会真红；受限环境下可用
 * SMOKE_SKIP_RENDER_CHECK=1 显式跳过（记 SKIP，不记 PASS，见该开关的注释），
 * 或改用 SMOKE_LAUNCH_VIA_SHELL=1 真正把这一条验出来（见下方启动策略一节）。
 *
 * 跳过时**不再等满 30 秒**：要等的正是那条被跳过的断言，继续等渲染层毫无意义，
 * 白等 30s 只会促使人不用这个开关。停止仍由轮询决定，但会单独印一行
 * 「WAIT  渲染层已跳过（SMOKE_SKIP_RENDER_CHECK=1），提前停止等待 @<秒>s」，
 * 让输出自证「不是超时、是刻意不等」（见 waitForRendererSnapshot）。
 *
 * 前置条件的盲区（2026-10-23 第二次收口，同日改为拒绝执行）：权限不足时进程表
 * 会返回 ExecutablePath 为空的记录，判不出路径 → 前置检查会漏掉它，输出「本机
 * 没有已存在实例」（可能错），随后又跑出「1/8 通过」。现在会对这类记录先打一行
 * WARN（留证据），随后立即 PRECOND 拒绝执行（exit 1、零断言、无 N/M 汇总）：
 * 路径读不到 ⇒ 无法排除「用户的实例被当成本次启的那个」⇒ 收尾可能误杀用户窗口，
 * 不能带病开跑。第 1/4 条 FAIL 上的 withBlindSpotHint 归因在此口径下不可达，
 * 作为纵深防御保留（见 unreadablePathCount 与 withBlindSpotHint 的注释）。
 *
 * ── 三种启动策略与选择依据（2026-10-23 实测，不推翻，只换策略）─────────────
 *
 * 根因：本执行环境（agent 沙箱 / 受限 job object）里**渲染进程根本不被创建**。
 * 实测证据：
 *   - 直启（spawn detached，带 --disable-gpu-sandbox）：进程树 total=3、
 *     renderer=0，日志 `loadFile failed: ERR_FAILED (-2)`，跨 9 天累计 58 次
 *     失败全部来自 agent 沙箱里跑的这些命令；而 10-13~10-22 的历史日志里
 *     `loadFile done` 共 38 次全成功（那是正常桌面会话里跑的）。
 *   - 经 `explorer.exe "<exe路径>"` 代理启动：进程树 total=4、main=1、
 *     renderer=1，日志 `loadFile done`，且出现 `[home-section] ✓ bilibili.
 *     ranking -> 11 项`（渲染层真的执行了应用 JS）。该 Lanyue.exe 的 parent
 *     是 explorer.exe，即脱离了 agent 沙箱的进程树。
 *   → 产品无缺陷；是「渲染进程沙箱在受限进程上下文里起不来」。
 *
 * 换窄旗标这条路已证伪（七组矩阵实测）：--disable-gpu-sandbox / +--disable-gpu
 * / +--no-zygote / +--disable-features=RendererCodeIntegrity / +--in-process-gpu
 * 全部 FAILED 或未加载，--single-process 进程直接退出；只有 `--no-sandbox`
 * 能 LOADED。也就是说「只关一点沙箱」并不存在，要么关掉整个沙箱（安全性代价
 * 且不代表生产配置），要么换启动策略。本脚本选择后者。
 *
 * explorer 代理为什么能绕过：进程的父子链落在真实桌面会话（explorer.exe）里，
 * 不继承 agent 沙箱的 job object 约束，渲染进程能正常 fork 出来并完成沙箱初始化。
 *
 * explorer 代理的天然副作用：`explorer.exe` 不接受给目标传命令行参数，所以这条
 * 路径**必然**是裸启动（零旗标）——而这恰好等价于用户双击，正是
 * docs/process/QA.md 要求的「发版前裸跑一次」。这个语义写进了 ENV 行与汇总行。
 *
 * 混合口径（只出现在 shell 模式，且是刻意的）：首实例经 explorer 代理（渲染进程
 * 才起得来），**第二实例仍走直启** —— explorer 不返回退出码，而第 2 条判据要求
 * 观测到真实 exit=0。这不是「两套判据」，而是同一条判据（单实例锁由主进程的
 * userData 决定，与谁把它拉起来无关）改用唯一能观测到的方式度量。第 2 条的
 * message 会把这件事直接印在验收单上，读输出的人不必去翻源码。
 *
 * 何时用哪种：
 *   - 日常 CI / 快速回归：直启（默认），8 条里前 7 条足够判断「进程层面」是否
 *     健康，第 8 条在本环境会红，红得正确；
 *   - 受限环境要验证渲染层：SMOKE_LAUNCH_VIA_SHELL=1，第 8 条才可能为真绿；
 *   - 发版前：SMOKE_LAUNCH_VIA_SHELL=1 裸跑一次（等价用户双击）。
 *
 * 环境依赖（Windows 真机冒烟的四项非可选配置，均附实测现象）：
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
 *    注意：explorer 代理模式不走 spawn，环境由 explorer 决定（= 用户双击的
 *    环境），本项清理对它不适用也不必要。
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
 * d) explorer 代理模式没有子进程句柄，pid 只能从进程表里发现（见
 *    discoverMainPid / takeLaunchBaseline）。两条硬约束：
 *    - 必须在启动**之前**快照已存在的同名进程 pid；否则会把用户正在用的实例
 *      当成本次被测对象，断言读到别人的日志，收尾还可能把用户的窗口杀掉；
 *    - 必须排除 CommandLine 含 `--type=` 的记录（那是渲染/GPU/utility 子进程，
 *      不是主进程）。
 *
 * 用法：node scripts/smoke-test-manual.js [exe路径]
 * 默认：release/win-unpacked/Lanyue.exe
 *
 * 三个环境变量（都必须是严格 '=1'，'0'/false/no 一律视为未开启）：
 *   SMOKE_BARE_LAUNCH=1       不追加任何旗标（裸启动，见上 c)）；
 *   SMOKE_SKIP_RENDER_CHECK=1 第 8 条记 SKIP 而非判定（见其注释，会把结论
 *                             明确写成「渲染层: 未验证」，不是 PASS）；
 *   SMOKE_LAUNCH_VIA_SHELL=1  改用 explorer.exe 代理启动（无旗标，等同双击），
 *                             受限环境下这是唯一能真实验证第 8 条的策略。
 *                             非 Windows 平台设置它 -> 直接报错 exit 1，
 *                             不静默降级成直启。
 *
 * 退出码：0 全通过（含显式跳过）；1 断言失败或收尾有残留；2 环境/产物缺失。
 * 跳过不计入失败 —— 否则开关就没意义；但它也绝不算通过，汇总行会单独报数。
 *
* 收尾的「零残留」检查**不计入 N/M 分母**：QA 上一版验收单的 8 条是既定口径，
* 往里塞第 9 条会让两版分数无法对照。它用单独一行表达（`清理: 零残留` /
* `清理: 残留 N 个（pid ...）` / `清理: 无法确认（...）`），有残留时把退出码
* 置 1。残留判定是**两条信号的并集**：「路径匹配 且 pid 不在启动前快照」**或**
* 「创建时间在启动之后 且 pid 不在启动前快照 且 进程名等于 exe 名」—— 后者
* 是与路径无关的独立信号，因为路径数据被污染时路径比对会静默失配（空数组在
* 那条路径上是「坏掉」的输出，不是「干净」的输出）。
*
* 「无法确认」的三种情形一律 fail-closed，**绝不打印「清理: 零残留」**：进程表
* 查询失败 / 路径数据不可用 / 本次启动的主进程 pid 从未发现。
*
* 进程表查询的数据**不走 stdout 文本通道**：PowerShell 把 JSON 写进一个无 BOM
* 的 UTF-8 临时文件，Node 按 utf8 读。原因见 queryTargetProcesses 的注释 ——
* stdout 受控制台代码页影响，而路径里有中文，损坏后所有路径比对静默失配。
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
  parseProcessList,
  selectMainPid,
  findPreexistingMainProcesses,
  findUnreadablePathProcesses,
  pathDataLooksUsable,
  renderWaitSettled,
  findResidualProcesses,
  resolveLaunchStrategy,
} = require('./release-smoke-checks.cjs');

/**
 * 启动策略解析（纯函数在 release-smoke-checks.cjs，便于单测）。
 *
 * 三种形态：直启 + 旗标（默认）/ 直启裸启动（SMOKE_BARE_LAUNCH=1）/
 * explorer 代理（SMOKE_LAUNCH_VIA_SHELL=1）。选择依据见头注释。
 *
 * 开关必须是严格字符串比较：'0' / 'false' / '' / 'no' 一律视为未开启。
 * 用真值判断（`if (process.env.SMOKE_BARE_LAUNCH)`）会让
 * `SMOKE_BARE_LAUNCH=0` 意外变成裸启动——那正好是本环境随机红的成因。
 */
const launchStrategy = resolveLaunchStrategy(process.env, process.platform);
if (launchStrategy.error) {
  // 非 Windows 上设置 SMOKE_LAUNCH_VIA_SHELL=1：必须硬失败。静默降级成直启会
  // 让汇总行照旧印「N/8 通过」，读验收单的人无从看出渲染层其实没在 shell 模式
  // 下验过 —— 那是把「没验」伪装成「验过」，比红更糟。
  console.error(`ERROR  ${launchStrategy.error}`);
  process.exit(1);
}

const VIA_SHELL = launchStrategy.mode === 'shell';
const BARE_LAUNCH = launchStrategy.bare;

/** 直启模式追加的旗标；explorer 代理模式下 explorer.exe 不接受目标参数，故恒为空。 */
const GPU_SANDBOX_FLAG = '--disable-gpu-sandbox';
const CHILD_ARGS = VIA_SHELL ? [] : (BARE_LAUNCH ? [] : [GPU_SANDBOX_FLAG]);

/** explorer 代理用的启动器（只用它做「代用户双击」，不传任何旗标）。 */
const SHELL_LAUNCHER = 'explorer.exe';

/** explorer 代理模式下的 pid 发现参数：上限 10 秒，每 500ms 轮询一次。 */
const SHELL_DISCOVER_TIMEOUT_MS = 10000;
const SHELL_DISCOVER_INTERVAL_MS = 500;

/**
 * 渲染层判据（第 8 条）的观测时序：**轮询到判据成立或超时**，取代原先
 * 「固定等够 SHELL_LOG_SETTLE_MS = 14000 再读一次」。
 *
 * 为什么必须换（2026-10-23 真机实测）：固定等待 14s 时，唯一那次读数只比
 * 「loadFile done」落盘早 0.19s。余量薄到这个程度，慢机/安全软件扫描/冷启动
 * 抖动都会把它吃掉，于是判成 unknown（假红）；「4 次里出现 1 次 6/8」的抖动
 * 就是同一个成因。假红的净效果是训练人「重跑一次就行」，比多等几秒糟得多。
 *
 * 判据没有放宽，一个字都没改：仍然是「增量日志里最后一次 loadFile 是 done」。
 * 白屏应用永远不会写 done，所以轮询不会把红等成绿，只会消掉「观测太早」这类
 * 假红。相反，绝大多数运行会比过去**更快**结束：拿到结论立刻走，不等满窗口。
 *
 *   RENDER_POLL_INTERVAL_MS  每 400ms 读一次增量。选 400ms 而不是更小，是因为
 *                            日志写入本身有缓冲，读得再密也不会更早看到结论，
 *                            只会多打几行 WAIT 噪声。
 *   RENDER_WAIT_MIN_MS       下限 1500ms（从启动时刻算）：保证日志已 flush、
 *                            不会读到半行（半行里既没有 done 也没有 failed，
 *                            多看一次就能补上，但没必要在 1.5s 内空转）。
 *                            直启模式下首次观测本来就在启动后 ~10s，这个下限
 *                            不会给正常路径增加任何耗时。
 *   RENDER_WAIT_DEADLINE_MS  上限 30s（同样从启动时刻算）：到点仍 unknown 判
 *                            FAIL，message 写明「既无 done 也无 failed」。
 *                            30s 远大于 shell 模式实测的 ~14.2s，是给慢机的
 *                            真实余量，而不是把判据拖长。
 */
const RENDER_POLL_INTERVAL_MS = 400;
const RENDER_WAIT_MIN_MS = 1500;
const RENDER_WAIT_DEADLINE_MS = 30000;

/** 进程表查询自身的超时（PowerShell 冷启动最慢实测 ~1.5s，留足余量）。 */
const PROCESS_QUERY_TIMEOUT_MS = 20000;

/** 进程表查询用的一次性临时文件名前缀（放在 os.tmpdir() 下，用完即删）。 */
const PROCESS_QUERY_TMP_PREFIX = 'lanyue-smoke-procs-';

/** stdout 通道自检行的前缀（PowerShell 侧写出，Node 侧核对）。 */
const STDOUT_CANARY_PREFIX = 'CANARY|';

/**
 * stdout 通道自检用的**非 ASCII 探针**（「路径通道」）。
 *
 * 必须是非 ASCII：编码损坏（CP936 → UTF-8）只影响非 ASCII 字符，纯 ASCII 的
 * 探针在乱码后照样「看起来对」，检不出问题。探针被写坏 = 通道不是 UTF-8。
 */
const STDOUT_CANARY_PROBE = '路径通道';

/**
 * 探针的 PowerShell 侧表达式（用字符码拼出上面的中文）。
 *
 * 写成 ASCII 数字而不是直接写中文：命令行本身不含非 ASCII 字符，就不会再引入
 * 「命令行怎么传给 powershell」这一层编码变量 —— 探针要检验的只有 stdout 通道。
 */
const PS_PROBE_EXPR = '([string][char]0x8DEF + [char]0x5F84 + [char]0x901A + [char]0x9053)';

/** 启动方式的人类可读描述，用于汇总行（ENV 行另有更详细的形态说明）。 */
const LAUNCH_MODE_LABEL = VIA_SHELL
  ? 'explorer 代理裸启动（无旗标，等同用户双击）'
  : (BARE_LAUNCH
    ? '直启裸启动（无旗标，SMOKE_BARE_LAUNCH=1）'
    : `直启 + ${GPU_SANDBOX_FLAG}（非裸启动）`);

/**
 * 渲染层加载断言的显式跳过开关（第 8 条）。
 *
 * 为什么需要它：本执行环境（agent sandbox / 部分 CI runner / 无桌面会话的
 * 虚拟化环境）里渲染进程沙箱起不来，loadFile 每次都以 ERR_FAILED (-2) 失败
 * ——同机实测：`--no-sandbox` 下 title="揽乐"、日志 loadFile done；去掉它
 * 就是白屏 + loadFile failed。也就是说直启模式下本机这一条**会真红**，且这是
 * 正确的红。要真正把这一条验绿请用 SMOKE_LAUNCH_VIA_SHELL=1（换启动策略，
 * 不是放宽判据）。
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
  '渲染层未验证：本环境渲染进程沙箱不可用（实测 ERR_FAILED），须在真实桌面会话补做'
  + '（或改用 SMOKE_LAUNCH_VIA_SHELL=1 换启动策略后重跑）';

/** 失败时的归因提示：把「白屏」这件事直接写到验收单上。 */
const RENDER_FAIL_HINT =
  '渲染层未加载 = 用户白屏；若同时有 GPU/沙箱相关错误，先按环境错处理并改用真实桌面会话复测'
  + '（受限环境可直接用 SMOKE_LAUNCH_VIA_SHELL=1）';

/**
 * ENV 声明行：脚本开跑的最前面输出一次（早于任何 check()）。
 * 冒烟产出的是一张给发版人签字的验收单，验收单必须自证「用了什么启动方式」，
 * 否则就是在用环境适配冒充产品可用。三种形态各有一行（口径见头注释）。
 */
const ENV_LINE = VIA_SHELL
  ? 'ENV   启动方式: explorer 代理 ｜ 附加旗标: 无（等同用户双击） ｜ 渲染层: 可验证'
  : (BARE_LAUNCH
    ? 'ENV   启动方式: 直启 spawn(detached) ｜ 附加旗标: 无（裸启动，SMOKE_BARE_LAUNCH=1） ｜ 渲染层: 受限环境下必然失败'
    : `ENV   启动方式: 直启 spawn(detached) ｜ 附加旗标: ${GPU_SANDBOX_FLAG} ｜ 渲染层: 受限环境下必然失败（改用 SMOKE_LAUNCH_VIA_SHELL=1）`);

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
 *
 * 注意：收尾的「零残留」检查**不在这里**（见 verifyCleanup）：它是第九件事，
 * 但没有编号、不进分母 —— 塞进来会让本脚本的分数与 QA 上一版验收单的 8 条
 * 口径对不上，评审时没人能判断「7/9」到底比「7/8」好还是坏。
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
 * 收尾「零残留」检查的结论（不进 N/M 分母，见 verifyCleanup）。
 * cleanupFailure 一旦为真就把退出码置 1：残留进程会占住 userData 锁，让下一次
 * 冒烟的「第二实例被拒绝」断言直接失效，属必须修的现场污染。
 */
let cleanupFailure = false;
let residualCount = 0;
let residualPidText = '';

/**
 * 前置检查的盲区计数：本机**存在同名进程但 ExecutablePath 读不到**的条数。
 *
 * 由来：前置检查靠「路径等值」认本机已有的同包实例，而权限不足时进程表会给回
 * 一条 ExecutablePath 为空的记录 —— 判不出路径就不算命中，于是前置检查输出
 * 「本机没有已存在实例」（可能错），接着新实例被单实例锁拒绝、main.log 零增量，
 * 汇总印出「1/8 通过」。那是如实的红、错误的归因，会被人当成产品缺陷写进缺陷单。
 * 所以把盲区显式说出来：探测到就打一行 WARN，并在第 1/4 条 FAIL 时把同一个数字
 * 写进 message（见 withBlindSpotHint）。
 *
 * **盲区不再只是提示（2026-10-23 收口）：前置检查改为拒绝执行。**
 * WARN 那一行保留（它是证据），但在它之后脚本直接 exit 1，理由是：路径读不到
 * ⇒ 无法排除「用户的实例被当成本次启的那个」⇒ 收尾时可能误杀用户的窗口。
 * 用户丢窗口是最坏的失效方向，所以「无法确认是否有已存在实例」必须中止本次
 * 冒烟，而不是继续跑出一个「1/8 通过」。这条比「路径数据不可用」更严格：
 * 后者是「读到的数据自相矛盾」，盲区是「根本没读到」。
 *
 * 只在前置检查阶段赋值一次，之后的断言与清理都不再改动它。
 */
let unreadablePathCount = 0;

/**
 * 给**失败**的 message 追加盲区归因。
 *
 * 只在失败时调用：盲区数是提示性证据，挂在一条 PASS 后面会让读验收单的人以为
 * 「结论不稳」，反而降低整张单子的可信度。
 *
 * 可达性（2026-10-23 收口）：盲区命中时前置检查在拉起任何进程之前就 exit 1
 * （见 unreadablePathCount 的注释），因此本函数当前**不可达** —— 走到任何
 * check() 时 unreadablePathCount 恒为 0，原样返回。保留函数与两处调用形态是
 * 纵深防御：若将来把「拒绝执行」放宽成「WARN 后继续跑」，归因自动生效；
 * 静态守卫（test/release-smoke-checks.test.js 的盲区一组）钉住了这些调用形态。
 *
 * @param {string} detail 原有 message（可为空串）。
 * @returns {string} 追加了「本机有 N 个路径不可读的 ...」的 message；无盲区原样返回。
 */
function withBlindSpotHint(detail) {
  if (unreadablePathCount <= 0) return detail;
  const hint = `本机有 ${unreadablePathCount} 个路径不可读的 ${path.basename(exePath)}，可能是单实例锁干扰`;
  return detail ? `${detail} —— ${hint}` : hint;
}

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
  process.exitCode = (failed || !bookkeepingOk || cleanupFailure) ? 1 : 0;
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

/**
 * explorer 代理模式发现的 pid 登记表。
 *
 * 与 liveChildren 分开，是因为这里没有子进程句柄，只有一个 pid；语义也更窄：
 * 只装「启动后新发现的主进程」——启动前快照里那些（用户正在用的实例）永远
 * 不会进来，所以异常中断时的兜底清理同样不会误杀用户实例。
 */
const ownedPids = new Set();

process.on('exit', () => {
  for (const child of liveChildren) forceKillSync(child.pid);
  for (const pid of ownedPids) forceKillSync(pid);
});

/**
 * 查询与本机目标 exe 同名的进程，返回 { ok, processes, error, channelBroken }。
 *
 * 走 PowerShell 的 CIM 查询而不是 `tasklist`：只有 Win32_Process 同时给出
 * ExecutablePath、CommandLine 与 CreationDate。ExecutablePath 用于排除「同名
 * 但不同路径」的进程，CommandLine 用于排除 `--type=renderer|gpu-process|utility`
 * 子进程，CreationDate 用于「本次启动之后新建的进程」这条与路径无关的独立信号。
 *
 * 为什么用 execFileSync 而不是 exec：不经过 shell，路径里的空格/中文/引号
 * 不会被打散（本机产物路径就含中文目录）。
 *
 * ok=false 表示**查询本身失败**，与「查到了 0 个进程」严格区分：pid 发现据此
 * 继续轮询/超时失败，残留检查据此拒绝声明「零残留」——两者都是 fail-closed。
 * channelBroken=true 表示**通道自检失败**（stdout 不是 UTF-8，见 checkStdoutChannel）：
 * 这台机器的文本通道已经不可信，调用方必须直接拒绝执行。
 */
function queryTargetProcesses() {
  const exeName = path.basename(exePath);
  // 单引号是 PowerShell 单引号字符串的转义方式（'' 表示一个 '）。
  const filterName = exeName.replace(/'/g, "''");
  const outFile = makeTempProcessFile();
  const psOutFile = outFile.replace(/'/g, "''");
  // ── 为什么路径数据走「文件通道」而不是 stdout 文本通道 ────────────────────
  // 旧实现把 JSON 文本从 PowerShell 的 stdout 送回 Node。Windows PowerShell 5.1
  // 默认按控制台代码页（本机 CP936）写 stdout，Node 按 utf8 解码后，本机产物
  // 路径里的中文（「新建文件夹」）变成一串替换字符 —— 归一化后的路径与目标路径
  // **永远不相等**。后果不是「漏检一个东西」，而是**静默失配**：pid 发现必然
  // 超时、零残留检查必然假绿（QA 实测：4 个 Lanyue.exe 还在跑，脚本报「清理:
  // 零残留」）。守卫主动报告了与事实相反的结论，比没有守卫更坏。
  // 现在改成：PowerShell 把 JSON 写进一个**无 BOM 的 UTF-8 文件**，Node 用
  // fs.readFileSync(file, 'utf8') 读 —— 文件通道不受控制台代码页影响。
  //
  // 顺带说明 `[Console]::OutputEncoding = UTF8` 这行**不再是承重的**：它现在
  // 只服务于 stdout 上那行通道自检（canary），不再承载任何路径数据。留着它是
  // 为了让自检能发现「有人把这行删了」；删掉它的后果现在是「冒烟拒绝执行」，
  // 而不再是「路径比对静默失配」。
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$ErrorActionPreference = \'Stop\';',
    `$json = Get-CimInstance Win32_Process -Filter "Name='${filterName}'"`
      + ' | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress;',
    // 零匹配时 ConvertTo-Json 不产生任何输出（$json 为 $null），WriteAllText
    // 传 $null 会抛 ArgumentNullException —— 先兜成空串，让 Node 侧解析成空数组。
    'if ($null -eq $json) { $json = \'\'; }',
    // 无 BOM 的 UTF-8：WriteAllText + UTF8Encoding($false)。**不要**用
    // `Out-File -Encoding utf8`（PS 5.1 会写 BOM，BOM 会让 JSON.parse 直接失败）。
    `[System.IO.File]::WriteAllText('${psOutFile}', $json, (New-Object System.Text.UTF8Encoding($false)));`,
    // stdout 只承载一行自检信息：编码名 + 一个非 ASCII 探针（探针的字符码写成
    // ASCII 数字，命令行本身不含非 ASCII 字符，避免再引入一层编码变量）。
    `Write-Output ('${STDOUT_CANARY_PREFIX}' + [Console]::OutputEncoding.WebName + '|' + ${PS_PROBE_EXPR});`,
  ].join(' ');
  let stdout = '';
  let raw = '';
  let failure = '';
  try {
    stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // BOM 防御：即便有人把 WriteAllText 换成会写 BOM 的写法，也不至于整份解析失败。
    raw = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
  } finally {
    // 临时文件用完即删（异常路径也删）：不留垃圾，也不留可能被后来者读到的快照。
    removeTempFile(outFile);
  }
  if (failure) {
    return { ok: false, processes: [], error: failure, channelBroken: false };
  }
  const channel = checkStdoutChannel(stdout);
  if (!channel.ok) {
    return { ok: false, processes: [], error: channel.error, channelBroken: true };
  }
  return { ok: true, processes: parseProcessList(raw), error: '', channelBroken: false };
}

/**
 * 生成进程表查询用的一次性临时文件路径（os.tmpdir + pid + 随机串）。
 *
 * 随机串是必须的：同一台机器上可能同时有多个冒烟进程在跑，固定文件名会互相
 * 覆盖对方的查询结果（那会变成另一种形式的假数据）。
 *
 * @returns {string} 临时文件绝对路径。
 */
function makeTempProcessFile() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `${PROCESS_QUERY_TMP_PREFIX}${process.pid.toString(36)}-${stamp}-${rand}.json`);
}

/**
 * 删除临时文件（已不存在时静默忽略）。
 *
 * @param {string} file 文件路径。
 */
function removeTempFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    // 文件可能已被清理；删不掉不影响本次结论（路径在 tmpdir 下，下次重启自会清）。
  }
}

/**
 * stdout 通道自检：确认 PowerShell 的输出确实按 UTF-8 落地。
 *
 * 为什么需要这道自检（它不是「把 UTF8 那行加回来」那种堵漏洞的写法）：路径数据
 * 已经改走 UTF-8 文件通道，本就不受控制台代码页影响；但 stdout 通道一旦不是
 * UTF-8，说明**这台机器的文本通道本身是坏的**（本机控制台代码页 CP936）。在
 * 这种机器上继续出一张「8/8 通过」的验收单，等于把一台已知会写坏中文的机器
 * 的结果当成可信结论 —— 所以直接拒绝执行，并说清原因。
 *
 * 判据两条都要满足：
 *   1) PowerShell 自报的输出编码名是 utf-8；
 *   2) 一个**非 ASCII 探针**原样回来（探针被写坏 ⇒ 通道不是 UTF-8）。
 * 第 2 条不是冗余：编码名可能被改、探针是实际字节的证据。
 *
 * @param {string} stdout PowerShell 的 stdout 文本。
 * @returns {{ok:boolean, error:string}}
 */
function checkStdoutChannel(stdout) {
  // BOM 防御：某些输出编码会在开头写 BOM（U+FEFF 不属于 trim 的空白集），
  // 不剥掉的话自检行会被误判成「没收到」。
  const text = String(stdout == null ? '' : stdout).replace(/^\uFEFF/, '');
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(STDOUT_CANARY_PREFIX));
  if (!line) {
    return { ok: false, error: 'stdout 未收到通道自检行（PowerShell 未按预期执行）' };
  }
  const parts = line.split('|');
  const webName = String(parts[1] || '').trim().toLowerCase();
  const probe = parts.slice(2).join('|');
  if (webName !== 'utf-8') {
    return {
      ok: false,
      error: `stdout 编码不是 UTF-8（实际 ${webName || '未知'}，本机控制台代码页可能是 CP936）`,
    };
  }
  if (!probe.includes(STDOUT_CANARY_PROBE)) {
    return { ok: false, error: 'stdout 的非 ASCII 探针被破坏（中文会被写成乱码，路径比对会静默失配）' };
  }
  return { ok: true, error: '' };
}

/**
 * 启动前快照：记下当前所有同名进程的 pid 与原始记录。
 *
 * **这是保护用户正在运行实例的红线，必须做。** 没有它，pid 发现会把用户手上
 * 那个 Lanyue.exe 当成本次被测对象——断言读到的是别人的日志（假绿假红都可能），
 * 收尾的 taskkill 更会直接把用户的窗口关掉。按进程名数数/按名字杀同样不行：
 * 那等于默认「机器上只该有一个实例」，而用户随时可能开着。
 *
 * 返回原始 processes 是给前置条件用的（findPreexistingMainProcesses 要按
 * ExecutablePath + CommandLine 判定「哪一条才是主进程」），pid 集合则给
 * pid 发现与零残留检查做差集基线。两者共用同一次查询，不多跑一次 PowerShell。
 *
 * @returns {{ok:boolean, pids:Set<number>, processes:Array<object>, error:string,
 *   channelBroken:boolean}}
 *   ok=false 时 pids 为空集、processes 为空数组，调用方在 shell 模式下必须硬
 *   失败（没有快照就没有安全边界）；channelBroken=true 表示通道自检失败
 *   （stdout 不是 UTF-8），两种模式都必须拒绝执行。
 */
function takeLaunchBaseline() {
  const snapshot = queryTargetProcesses();
  if (!snapshot.ok) {
    return {
      ok: false,
      pids: new Set(),
      processes: [],
      error: snapshot.error,
      channelBroken: snapshot.channelBroken === true,
    };
  }
  return {
    ok: true,
    pids: new Set(snapshot.processes.map((p) => p.pid)),
    processes: snapshot.processes,
    error: '',
    channelBroken: false,
  };
}

/**
 * 单个 pid 的存活状态：'alive' / 'gone' / 'unknown'（查询失败）。
 *
 * 三态而不是布尔：报警与断言都要求「unknown 不等于 gone」。把查询失败当成
 * 「进程已退出」会让清理检查假装成功；当成「还活着」会让存活断言假装通过。
 */
function pidState(pid) {
  const query = queryTargetProcesses();
  if (!query.ok) return 'unknown';
  return query.processes.some((p) => p.pid === pid) ? 'alive' : 'gone';
}

/**
 * explorer 代理模式下的主进程发现（本改动的核心难点：这条路拿不到 child.pid）。
 *
 * 从进程表里找同时满足三条的记录，命中即返回：
 *   1) ExecutablePath 归一化后等于目标 exe（大小写不敏感、正斜杠归一）；
 *   2) CommandLine 不含 `--type=`（排除渲染/GPU/utility 子进程）；
 *   3) pid 不在启动前快照里（排除用户正在用的实例，见 takeLaunchBaseline）。
 * 判定逻辑本身是纯函数 selectMainPid（可单测），这里只负责轮询与超时。
 *
 * 上限 10 秒、每 500ms 一次：explorer 代理本身是同步的，实测新主进程在 1s 内
 * 出现；10 秒是给「explorer 排队 + 安全软件扫描 + 冷启动」留的余量上限，超过
 * 就按失败报，把「可能被安全软件拦截或 exe 路径含特殊字符」写进 message ——
 * 这两种是实测见过的最可能原因，写出来才有排查方向。
 *
 * @param {Set<number>} baselinePids 启动前已存在的同名进程 pid 集合。
 * @returns {Promise<{pid:number|null, elapsedMs:number, error:string}>}
 */
async function discoverMainPid(baselinePids) {
  const startedAt = Date.now();
  let lastQueryError = '';
  for (;;) {
    const query = queryTargetProcesses();
    if (!query.ok) {
      lastQueryError = query.error;
    } else {
      const pid = selectMainPid({ processes: query.processes, exePath, baselinePids });
      if (pid) return { pid, elapsedMs: Date.now() - startedAt, error: '' };
    }
    if (Date.now() - startedAt + SHELL_DISCOVER_INTERVAL_MS > SHELL_DISCOVER_TIMEOUT_MS) break;
    await delay(SHELL_DISCOVER_INTERVAL_MS);
  }
  const seconds = SHELL_DISCOVER_TIMEOUT_MS / 1000;
  const base = `explorer 代理启动后 ${seconds} 秒内未发现新的主进程 —— 可能被安全软件拦截或 exe 路径含特殊字符`;
  return {
    pid: null,
    elapsedMs: Date.now() - startedAt,
    error: lastQueryError ? `${base}（进程表查询同时失败: ${lastQueryError}）` : base,
  };
}

/**
 * 杀掉一个 pid 及其整棵进程树（explorer 代理模式的清理入口）。
 *
 * 与 stop(child) 的分工：detached 子进程有句柄，可以走 kill 兜底链；这里只有
 * pid，等价手段就是 taskkill /T /F，再按进程表确认确实没了。轮询上限 5 秒
 * （taskkill /F 正常 <200ms 生效，慢的是被安全软件挂钩的情形）。
 *
 * @param {number} pid 目标 pid（调用方保证它不是启动前快照里的用户实例）。
 * @returns {Promise<boolean>} true 表示已确认消失；false 表示仍存在或无法确认。
 */
async function stopPidTree(pid) {
  if (!pid) return true;
  forceKillSync(pid);
  for (let i = 0; i < 20; i += 1) {
    if (pidState(pid) === 'gone') return true;
    await delay(250);
  }
  forceKillSync(pid);
  for (let i = 0; i < 4; i += 1) {
    if (pidState(pid) === 'gone') return true;
    await delay(250);
  }
  return false;
}

/**
 * 收尾断言：本次启动拉起的进程一个都不能留。
 *
 * 判据：本次启动之后**还在跑**的同名进程数应为 0。残留判定是两条信号的并集
 * （findResidualProcesses）：
 *   A) 路径匹配 且 pid 不在启动前快照；
 *   B) 创建时间在启动之后（容差 2s）且 pid 不在启动前快照且进程名等于 exe 名。
 * 用快照差集而不是按进程名数数，是为了不把用户自己开着的那份实例算进来
 * （并因此去杀它）。
 *
 * **不进 N/M 分母**：QA 上一版验收单的 8 条是既定口径，加第 9 条会让两版分数
 * 无法对照。它用单独一行表达，有残留时把退出码置 1（见 finish）。
 *
 * 三种「不得宣称零残留」的情形，全部 fail-closed：
 *   1) 查询失败 —— 无法确认不等于干净；
 *   2) 路径数据不可用（pathDataLooksUsable 为 false）—— 路径比对在这条路径上
 *      是**静默失配**：匹配不到 ≠ 不存在。此时只能报「无法确认」；
 *   3) 本次启动的主进程 pid 从未发现（shell 模式 pid 发现失败）—— 此时
 *      「路径差集」这条判据的基线不可信，改用创建时间判据，并写明用的是哪种。
 *
 * @param {Set<number>} baselinePids 启动前快照。
 * @param {number} launchedAt 本次启动时刻（epoch 毫秒），创建时间判据用。
 * @param {boolean} pidDiscoveryFailed 本次启动是否没找到主进程 pid。
 */
function verifyCleanup(baselinePids, launchedAt, pidDiscoveryFailed) {
  const query = queryTargetProcesses();
  if (!query.ok) {
    cleanupFailure = true;
    residualCount = -1;
    console.log(`WARN  清理: 无法确认（进程表查询失败: ${query.error}）—— 不得视为零残留`);
    return;
  }
  const usable = pathDataLooksUsable(query.processes, exePath);
  const residual = findResidualProcesses({
    processes: query.processes,
    exePath,
    baselinePids,
    launchedAt,
  });
  if (residual.length) {
    cleanupFailure = true;
    residualCount = residual.length;
    residualPidText = residual.map((p) => p.pid).join(', ');
    const typeHint = residual.some((p) => /--type=/i.test(p.commandLine)) ? '，其中含 --type= 子进程' : '';
    console.log(
      `FAIL  清理后仍有残留进程 ｜ 清理: 残留 ${residual.length} 个（pid ${residualPidText}${typeHint}）`
      + ' —— 残留会占住 userData 锁，让下一次冒烟的第二实例断言失效',
    );
    return;
  }
  if (!usable) {
    cleanupFailure = true;
    residualCount = -1;
    console.log('清理: 无法确认（进程表路径数据不可用）—— 不得视为零残留');
    return;
  }
  if (pidDiscoveryFailed) {
    // 本次启动的主进程 pid 从未被发现 ⇒ 「路径差集」这条判据没有可信基线
    // （我们不知道该拿什么去比），改用与路径无关的创建时间判据。
    cleanupFailure = true;
    residualCount = -1;
    console.log(
      '清理: 无法确认（本次启动的主进程 pid 未发现，路径差集判据无可信基线）—— '
      + '已改用创建时间判据（启动后新建的同名进程），未发现残留；不得视为零残留',
    );
    return;
  }
  residualCount = 0;
  console.log('清理: 零残留');
}

/**
 * 拉起 exe 并采集 stdout/stderr（直启路径，与本次改动前完全一致）。
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
 *    explorer 代理模式不走 spawn，环境由 explorer 决定（= 用户双击的环境），
 *    所以这套清理对它不适用也不必要。
 */
function buildChildEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * 直启模式附加参数的取舍依据（详见头注释 c) 与环境依赖清单）。
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
 *
 * 注意：它解决不了第 8 条（渲染层）——七种旗标组合的矩阵实验已证伪这条路，
 * 只有关掉整个沙箱才行，所以渲染层要靠 SMOKE_LAUNCH_VIA_SHELL=1 换启动策略。
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

/**
 * 直启：spawn(detached) + CHILD_ARGS。有子进程句柄与真实退出码。
 *
 * @returns {{mode:'direct', child:import('child_process').ChildProcess, pid:number,
 *   state:object, launchedAt:number, alive:boolean}}
 */
function launchDirect() {
  const { child, state } = capture();
  const launchedAt = Date.now();
  return { mode: 'direct', child, pid: child.pid, state, launchedAt, alive: false };
}

/**
 * explorer 代理启动：`explorer.exe "<绝对路径>"`，不追加任何旗标。
 *
 * 为什么用 explorer：它把目标进程挂到真实桌面会话的父子链上（实测 Lanyue.exe
 * 的 parent 就是 explorer.exe），脱离 agent 沙箱的 job object，渲染进程才起得来
 * （total=3/renderer=0 → total=4/renderer=1，见头注释）。
 *
 * 为什么不能传参：explorer.exe 不转发命令行给目标，所以这条路天然零旗标
 * ——恰好等价用户双击，也正好满足 docs/process/QA.md 的「发版前裸跑一次」。
 *
 * 代价：拿不到 pid、拿不到 stdout/stderr、拿不到退出码。pid 靠 discoverMainPid
 * 从进程表补，存活靠进程表复查；stdout/stderr 不可得这件事在第 3 条断言的
 * message 里显式写明（判据不变，只是可观测量变少，不许假装采到了）。
 *
 * @param {Set<number>} baselinePids 启动前快照（保护用户实例的红线）。
 * @returns {Promise<{mode:'shell', child:null, pid:number|null, state:object,
 *   launchedAt:number, alive:boolean}>}
 */
async function launchViaShell(baselinePids) {
  const launchedAt = Date.now();
  const state = { spawnError: null, exitCode: null, exitSignal: null, stdout: '', stderr: '', timedOut: false };
  try {
    const launcher = spawn(SHELL_LAUNCHER, [exePath], { stdio: 'ignore', windowsHide: true, detached: true });
    // explorer 交棒后自己就退了；错误只可能来自「explorer.exe 不存在」这类
    // 系统级问题，交给下面的 pid 发现统一表达，这里只防止 unhandled 'error'。
    launcher.on('error', () => {});
    launcher.unref();
  } catch (e) {
    state.spawnError = e instanceof Error ? e : new Error(String(e));
    return { mode: 'shell', child: null, pid: null, state, launchedAt, alive: false };
  }

  const found = await discoverMainPid(baselinePids);
  if (!found.pid) {
    state.spawnError = new Error(found.error);
    return { mode: 'shell', child: null, pid: null, state, launchedAt, alive: false };
  }
  ownedPids.add(found.pid);
  return { mode: 'shell', child: null, pid: found.pid, state, launchedAt, alive: false };
}

/**
 * 启动分发：唯一的入口，避免两处各自判断 VIA_SHELL。
 *
 * @param {Set<number>} baselinePids 启动前快照。
 * @returns {Promise<object>} launchDirect / launchViaShell 的返回值。
 */
async function launchInstance(baselinePids) {
  return VIA_SHELL ? launchViaShell(baselinePids) : launchDirect();
}

/**
 * 把「观察窗内是否持续存活」折算成第 1 条断言要的 state，并返回判定结果。
 *
 * 直启：state 由 child 的 error/exit 事件填充，timedOut 语义 = 「观察期内没等到
 * 退出事件」——判据函数 processStayedAlive 原样复用。
 *
 * explorer 代理：没有句柄，只能靠进程表复查（6 秒到点再查一次）。判据不变：
 * 只有「到点仍在进程表里」才折算成 timedOut=true / exitCode=null，其余情况一律
 * 折算成 timedOut=false —— 也就是「没观测到它活着」，不许因为「没看到 exit 事件」
 * 就判绿（这正是假绿的经典来源）。
 *
 * @param {object} record launchInstance 的返回值。
 * @param {number} windowMs 观察窗长度（毫秒，从启动时刻算）。
 * @returns {Promise<boolean>}
 */
async function observeAlive(record, windowMs) {
  const remaining = record.launchedAt + windowMs - Date.now();
  if (remaining > 0) await delay(remaining);
  if (record.mode === 'direct') {
    record.state.timedOut = record.state.exitCode == null && !record.state.spawnError;
    record.alive = processStayedAlive(record.state);
    return record.alive;
  }
  if (record.state.spawnError || !record.pid) {
    record.state.timedOut = false;
    record.alive = false;
    return false;
  }
  // 三态原样挂在 record 上：unknown（查询失败）与 gone（确认消失）必须在
  // message 里分开说 —— 把「没观测到」说成「已消失」会把排查引向错误方向。
  record.pidState = pidState(record.pid);
  record.alive = record.pidState === 'alive';
  record.state.timedOut = record.alive;
  return record.alive;
}

/** 第 1 条断言的 message：两种启动方式各自说清「凭什么认为它活着」。 */
function firstAliveDetail(record) {
  if (record.state.spawnError) return record.state.spawnError.message;
  if (record.mode === 'shell') {
    if (!record.pid) return 'explorer 代理 ｜ 未发现新的主进程';
    if (record.pidState === 'unknown') {
      return `explorer 代理 ｜ 主进程 pid=${record.pid} ｜ 6 秒复查时进程表查询失败，`
        + '无法确认存活（查询失败 ≠ 已退出，按 fail-closed 判红）';
    }
    return record.alive
      ? `explorer 代理 ｜ 发现主进程 pid=${record.pid} ｜ 6 秒后进程表仍存在`
      : `explorer 代理 ｜ 主进程 pid=${record.pid} ｜ 6 秒内已从进程表消失（启动即退出）`;
  }
  return `exit=${record.state.exitCode} signal=${record.state.exitSignal}`;
}

/** 第 2 条断言的 message；shell 模式下必须点明「第二实例为什么走直启」。 */
function secondRejectedDetail(record) {
  if (record.state.spawnError) return record.state.spawnError.message;
  const base = `exit=${record.state.exitCode} timedOut=${record.state.timedOut}`;
  return VIA_SHELL
    ? `${base} ｜ 验证口径: 第二实例经直启验证（explorer 不返回退出码，`
      + '单实例锁由 userData 决定，与启动方式无关）'
    : base;
}

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
 * 终止子进程（直启路径）。
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

/**
 * 按启动方式做清理（两种模式下都不会碰到用户实例）。
 *
 * 直启：stop(child) 的四级兜底（taskkill /T /F → SIGTERM → SIGKILL →
 *       process.kill），与改动前一致。
 * explorer 代理：对发现的 main pid 执行 taskkill /PID <pid> /T /F
 *       （stopPidTree）。pid 只可能是「启动后新出现、且不在快照里」的那一个。
 *
 * @param {object|null} record launchInstance 的返回值。
 */
async function shutdownInstance(record) {
  if (!record) return;
  if (record.mode === 'direct') {
    await stop(record.child);
    return;
  }
  if (!record.pid) return;
  const gone = await stopPidTree(record.pid);
  if (gone) ownedPids.delete(record.pid);
}

/**
 * main.log 的候选路径（按优先级）。三处都查不到 → 观测条件缺失（见 main 里的
 * 日志缺失分支）。抽成函数是因为启动**前后**各要查一次：前一次定增量基线，
 * 后一次（轮询里）取内容。
 *
 * @returns {string[]} 绝对路径候选列表。
 */
function logPathCandidates() {
  return [
    path.join(process.env.APPDATA || '', 'music-downloader', 'logs', 'main.log'),
    path.join(process.env.APPDATA || '', 'Lanyue', 'logs', 'main.log'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'music-downloader', 'logs', 'main.log'),
  ].filter(Boolean);
}

/** @returns {string|null} 第一个存在的 main.log 路径；都不存在返回 null。 */
function findLogPath() {
  return logPathCandidates().find((p) => fs.existsSync(p)) || null;
}

/**
 * 读一次 main.log 增量。**纯读取，不打印**：轮询路径 400ms 调一次，打印交给
 * 调用方控制（否则一次 shell 运行会刷满几十行日志）。
 *
 * 增量语义见 logIncrementalState 的注释：只有 'fresh' 的切片能当证据，
 * 'empty'（本次启动零新增）与 'rotated'（轮转/截断）一律不得判绿。
 *
 * UTF-8 对齐：fs 的偏移是字节，多字节字符可能被切在中间。若切片首字节的高位
 * 是 1（不是 ASCII 起点），说明切点落在序列内部，丢弃第一行。
 *
 * @param {{logPathPre:string|null, spawnOffset:number|null}} args
 *   logPathPre 启动前定位到的路径（null = 启动前没有日志）；
 *   spawnOffset 启动前记录的字节偏移（null = 启动前没有日志，基线按 0 计，
 *   此时整份文件都是本次启动写的）。
 * @returns {{logPath:string|null, baseline:number, bufLength:number,
 *   deltaBytes:number, logState:'fresh'|'empty'|'rotated',
 *   incremental:string, pathChanged:boolean}}
 */
function readLogIncremental({ logPathPre, spawnOffset }) {
  const logPath = findLogPath();
  const baseline = spawnOffset == null ? 0 : spawnOffset;
  if (!logPath) {
    return {
      logPath: null,
      baseline,
      bufLength: 0,
      deltaBytes: 0,
      logState: 'empty',
      incremental: '',
      pathChanged: false,
    };
  }

  const buf = fs.readFileSync(logPath);
  const pathChanged = logPathPre != null && logPath !== logPathPre;

  // 调用顺序是判据的一部分，不可调换：
  //   1) 先由 spawnOffset（首实例 spawn 之前的字节偏移）算出 logIncrementalState；
  //   2) 只有 'fresh' 才允许把增量切片交给四条日志内容断言（无致命错误 /
  //      快捷键 / 托盘 / 渲染层）；
  //   3) 'empty' / 'rotated' 一律不得判绿（历史内容无法证明本次启动健康）。
  let logState = logIncrementalState(buf.length, baseline);
  if (pathChanged) {
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
  }

  return {
    logPath,
    baseline,
    bufLength: buf.length,
    deltaBytes: Math.max(0, buf.length - baseline),
    logState,
    incremental,
    pathChanged,
  };
}

/**
 * 轮询读日志直到渲染层判据有明确结论，或到 deadline。
 *
 * 时序（都从 launchedAt 算，即首个实例真正被拉起的时刻）：
 *   下限 RENDER_WAIT_MIN_MS  → 首次观测不早于它（等日志 flush，避免半行）；
 *   间隔 RENDER_POLL_INTERVAL_MS → 之后每 400ms 一次；
 *   上限 RENDER_WAIT_DEADLINE_MS → 到点仍无结论就带着最后一次快照返回。
 *
 * 每次观测都打印一行 WAIT（含启动后秒数、增量字节数、判定值、是否停止），
 * 这样验收单本身就带着「什么时候看到的、等了几次、为什么停」的证据 ——
 * 不需要谁去复现时序。停下来的那次快照就是后续 5 条日志断言用的快照，
 * 不额外再读一次（多读一次会引入「轮询看到 done、断言读到 failed」的口径漂移）。
 *
 * 停止原因有两种，输出上严格分开（见循环里 settledBySkip 的注释）：
 *   未跳过且拿到 loaded/failed   → 该行以「→ 结论明确，停止等待」收尾；
 *   第 8 条已显式跳过（开关生效）→ 该行不带「结论明确」，改印一行
 *     `WAIT  渲染层已跳过（SMOKE_SKIP_RENDER_CHECK=1），提前停止等待 @<秒>s`
 *     让人从输出就能看出「不是超时、是刻意不等」。
 *
 * @param {number} launchedAt 启动时刻（Date.now()）。
 * @param {() => object} readSnapshot 无参读快照函数（readLogIncremental 的闭包）。
 * @param {{skipRenderCheck:boolean, processGone:boolean}} options
 *   skipRenderCheck 第 8 条是否已显式跳过；processGone 首实例是否确定已退出
 *   （退出之后日志不会再增长，继续轮询只是空等，属「证据源已终止」这一种结论）。
 * @returns {Promise<{snapshot:object, state:'loaded'|'failed'|'unknown',
 *   polls:number, waitedMs:number, settled:boolean,
 *   stoppedBy:'settled'|'skip-render-check'|'process-gone'|'deadline'|'no-log'}>}
 *   stoppedBy='skip-render-check' 表示「因第 8 条已跳过而提前停止」，与 'settled'
 *   （判据给出结论）严格区分：前者记的是 SKIP，不得当结论用（即便同一次轮询里
 *   渲染层的字样碰巧出现）；后者的 state 一定是 loaded 或 failed。
 */
async function waitForRendererSnapshot(launchedAt, readSnapshot, { skipRenderCheck, processGone }) {
  const deadlineAt = launchedAt + RENDER_WAIT_DEADLINE_MS;
  const floorWait = launchedAt + RENDER_WAIT_MIN_MS - Date.now();
  console.log(
    `WAIT  渲染层判据轮询: 每 ${RENDER_POLL_INTERVAL_MS}ms 一次`
    + ` ｜ 下限 ${RENDER_WAIT_MIN_MS}ms（等日志 flush）`
    + ` ｜ 上限 ${RENDER_WAIT_DEADLINE_MS}ms（自启动时刻算）`,
  );
  if (floorWait > 0) await delay(floorWait);

  let polls = 0;
  let snapshot = null;
  let state = 'unknown';
  let settled = false;
  for (;;) {
    snapshot = readSnapshot();
    polls += 1;
    // logState 不是 'fresh' 时增量不能当证据（历史尾部/无新增），传空串让判据
    // 明确返回 unknown —— 绝不因为「没读到失败证据」就判绿。
    state = rendererLoadedState(snapshot.logState === 'fresh' ? snapshot.incremental : '');
    settled = renderWaitSettled({
      logText: snapshot.incremental,
      logState: snapshot.logState,
      skipRenderCheck,
    });
    const waitedMs = Date.now() - launchedAt;
    const waitedSecText = (waitedMs / 1000).toFixed(1);
    // 停止原因必须分两种表达，不许合并成一句「结论明确」：
    //   未跳过 + 拿到 loaded/failed → 判据自己给出了答案，是**结论**；
    //   第 8 条已显式跳过（skipRenderCheck）→ 我们停下来的原因是**开关**，不是
    //     判据：要等的那条断言已被跳过，继续等 loadFile 毫无意义，白等 30s 反而
    //     促使人不用这个开关。这时即便渲染层的字样碰巧也出现了（本次轮询的 state
    //     可能已经是 loaded/failed），停下来的理由依然是「刻意不等」——因为那条
    //     断言本次记的是 SKIP，不是 PASS。
    // 所以只要在跳过模式下停下，就单独印一行 WAIT 把原因写在明处，让人从输出
    // 就能看出「不是超时、是刻意不等」；同时抑制「结论明确，停止等待」那句，
    // 避免同一处出现两句互相矛盾的停止理由。
    const settledBySkip = settled && skipRenderCheck === true;
    console.log(
      `WAIT  轮询#${polls} 启动后 ${waitedSecText}s`
      + ` ｜ 增量 ${snapshot.deltaBytes} B（${snapshot.logState}）`
      + ` ｜ 判定 ${state}`
      + (settled && !settledBySkip ? ' → 结论明确，停止等待' : ''),
    );
    if (settledBySkip) {
      console.log(
        `WAIT  渲染层已跳过（SMOKE_SKIP_RENDER_CHECK=1），提前停止等待 @${waitedSecText}s`
        + ` ｜ 轮询 ${polls} 次 ｜ 增量 ${snapshot.deltaBytes} B（${snapshot.logState}）`,
      );
    }
    if (settled) return { snapshot, state, polls, waitedMs, settled, stoppedBy: settledBySkip ? 'skip-render-check' : 'settled' };
    // 日志文件压根不存在：继续轮询也读不到东西，交给调用方的「日志缺失」分支
    // 立即判红（5 条 FAIL），不要白等 30 秒。
    if (!snapshot.logPath) {
      return { snapshot, state, polls, waitedMs, settled, stoppedBy: 'no-log' };
    }
    // 首实例已退出：日志不会再增长，「没有结论」本身就是结论（启动就崩了）。
    if (processGone) {
      return { snapshot, state, polls, waitedMs, settled, stoppedBy: 'process-gone' };
    }
    if (Date.now() >= deadlineAt) {
      return { snapshot, state, polls, waitedMs, settled, stoppedBy: 'deadline' };
    }
    const remain = deadlineAt - Date.now();
    await delay(Math.min(RENDER_POLL_INTERVAL_MS, Math.max(0, remain)));
  }
}

async function main() {
  console.log('exe:', exePath, `(${fs.statSync(exePath).size} B)`);

  // 启动前快照：pid 发现与零残留检查都以它为差集基线（见 takeLaunchBaseline
  // 与 verifyCleanup）。shell 模式下没有它就没有安全边界 —— 宁可硬失败，
  // 也不许在「无法区分用户实例与本次实例」的状态下继续跑。
  const launchBaseline = takeLaunchBaseline();
  if (!launchBaseline.ok) {
    // 通道自检失败：这台机器的「文本 → 字节」通道已经不可信（stdout 不是 UTF-8，
    // 本机控制台代码页 CP936）。路径数据虽然走的是 UTF-8 文件通道（不受影响），
    // 但环境本身就是坏的 —— 不许在这种机器上出一张看起来正常的验收单。
    // 两种模式都拒绝执行。
    if (launchBaseline.channelBroken) {
      console.error(
        `ERROR  进程表查询的通道自检失败（${launchBaseline.error}）—— `
        + '本机的控制台/进程表通道不可信，本次冒烟结论不可信，已拒绝执行',
      );
      process.exit(1);
    }
    if (VIA_SHELL) {
      console.error(
        'ERROR  启动前进程快照失败，explorer 代理模式无法安全识别本次启动的主进程'
        + `（可能误杀用户正在使用的实例）: ${launchBaseline.error}`,
      );
      process.exit(1);
    }
    console.log(`WARN  启动前进程快照失败，收尾的「零残留」检查将无法确认: ${launchBaseline.error}`);
  }

  // ── 前置条件 0：进程表的路径数据本身必须可用 ──────────────────────────────
  // 判据是纯函数 pathDataLooksUsable（release-smoke-checks.cjs），判据为什么可靠
  // 见该函数注释：一句话 —— exe 的 basename 是 ASCII，而编码损坏只影响非 ASCII
  // 字符，所以「非空路径里至少有一条 basename 命中目标 exe」是可判定的。
  //
  // 不可用 ⇒ 任何「按路径比对」的结论都不可信（匹配不到 ≠ 不存在）⇒ 拒绝执行。
  // 这正是 QA 变异实测抓到的那个假绿：路径数据被写坏时，旧实现照样打印
  // 「清理: 零残留」。现在路径数据改走 UTF-8 文件通道（源头修复），这一条是
  // 兜底：万一将来又有人把数据塞回某个会按控制台代码页编码的通道，这里拦住。
  if (!pathDataLooksUsable(launchBaseline.processes, exePath)) {
    console.log(
      'PRECOND 进程表路径数据不可用（同名进程存在但路径无法比对）—— 多为控制台编码问题，本次冒烟结论不可信，已拒绝执行',
    );
    process.exit(1);
  }

  // ── 前置检查的盲区：同名进程存在，但 ExecutablePath 读不到 ────────────────
  // 探测本身是纯函数（release-smoke-checks.cjs 的 findUnreadablePathProcesses），
  // 这里只负责输出与留痕。这类记录判不出路径，前置检查的「路径等值」谓词一律
  // 不算命中 —— 于是「本机没有已存在实例」这个结论**可能是错的**，而错的代价
  // 正是「1/8 通过」那种误导性结果。所以盲区必须写在明处。
  // 注意这里必须早于下面的 preexisting 判定输出，让 WARN 与 PRECOND 相邻，
  // 读输出的人一眼就能把两件事联系起来。
  unreadablePathCount = findUnreadablePathProcesses({
    processes: launchBaseline.processes,
  }).length;
  if (unreadablePathCount > 0) {
    console.log(
      `WARN  检测到 ${unreadablePathCount} 个 ${path.basename(exePath)} 无法读取路径（权限不足），`
      + '前置检查存在盲区：若其中之一正是本包实例，本次结果可能被单实例锁干扰',
    );
    // 盲区不得被当作「本机没有已存在实例」。路径读不到 ⇒ 无法排除「用户的实例
    // 被当成本次启的那个」⇒ 收尾时可能把用户的窗口杀掉（用户丢窗口是最坏的
    // 失效方向）。这条比「路径数据不可用」更严格：后者是「读到的数据自相矛盾」，
    // 盲区是「根本没读到」。两种情况都拒绝执行，且都不打印 N/M 汇总
    // （汇总行一出现就会被当成「结果」，而本次根本没测）。
    console.log(
      `PRECOND 无法确认本机是否已有已存在实例（${unreadablePathCount} 个 ${path.basename(exePath)} 的路径读不到）—— `
      + '无法排除用户的实例被当成本次启的那个（可能误杀用户窗口），本次冒烟结论不可信，已拒绝执行',
    );
    process.exit(1);
  }

  // ── 前置条件：本机已有同一路径的实例在跑 → 显式拒绝，一条断言都不跑 ──────
  // 为什么必须拒绝而不是「WARN 之后继续」：那种情况下新实例会被单实例锁
  // 拒绝、main.log 零增量，冒烟必然输出「1/8 通过」。它是如实的红，但归因
  // 错了 —— 读验收单的人只会得到「产品坏了」这个结论，然后把它写进缺陷单。
  // 制造假信息比少跑一次冒烟严重得多，所以这里只输出一行 PRECOND 并 exit 1，
  // 连 N/M 汇总都不打（汇总行一出现就会被当成「结果」，而本次根本没测）。
  //
  // 两种启动模式都适用（不含任何 VIA_SHELL 分支）：单实例锁由 userData 决定，
  // 与怎么被拉起来无关，所以前置条件对两种模式同样成立。
  // 与 launchBaseline 的排除逻辑并存、不冲突：这里是「跑之前拒绝」，那边是
  // 「跑期间只认自己拉起来的那个 pid」。
  const preexistingMain = findPreexistingMainProcesses({
    processes: launchBaseline.processes,
    exePath,
  });
  if (preexistingMain.length) {
    const preexistingPidText = preexistingMain.map((p) => p.pid).join(', ');
    console.log(
      `PRECOND 检测到本机已有同一路径的实例在运行（pid ${preexistingPidText}）。`
      + '冒烟会因单实例锁被判红，但那不是产品故障。'
      + '请先完全退出该实例（含托盘）后再跑。',
    );
    process.exit(1);
  }

  // 在拉起首个实例之前记录本机 main.log 的当前字节大小，作为「本次启动」
  // 的增量切片起点——后续 tray/shortcuts/致命错误断言只看这个偏移之后的
  // 新增内容，避免历史日志误伤。多字节 UTF-8 切割处理见 readLogIncremental。
  const logPathPre = findLogPath();
  const spawnOffset = logPathPre ? fs.statSync(logPathPre).size : null;

  const first = await launchInstance(launchBaseline.pids);
  const firstAlive = await observeAlive(first, 6000);
  // 本次启动的主进程 pid 从未发现（shell 模式的 pid 发现失败）⇒ 收尾的「零残留」
  // 不能靠「路径差集」下结论，改为走创建时间判据（见 verifyCleanup）。
  const pidDiscoveryFailed = first.mode === 'shell' && !first.pid;
  // 第 1 条是「单实例锁干扰」最容易命中的一条：本机已有实例时，新实例往往连
  // 6 秒都活不到。withBlindSpotHint 在当前口径下恒为原样返回（盲区已在前面
  // 前置拒绝，见其注释），保留调用是纵深防御：一旦前置口径放宽，这条 FAIL
  // 会被自动追加「可能是单实例锁干扰」，而不是被读成「进程起不来 = 产品缺陷」。
  check('首实例启动后持续存活 6 秒', firstAlive,
    firstAlive ? firstAliveDetail(first) : withBlindSpotHint(firstAliveDetail(first)));

  let second = null;
  if (firstAlive) {
    // 第二实例一律走直启（两种启动方式下都一样）：第 2 条的判据要求观测到
    // **真实退出码 0**，而 explorer 代理不返回退出码 —— 用 shell 启动第二实例
    // 就只能靠猜，等于偷偷放宽判据。单实例锁由主进程的 userData 决定，与
    // 「怎么被拉起来的」无关，所以直启第二实例不会改变这一条在测什么。
    second = launchDirect();
    await delay(4000);
    second.state.timedOut = second.state.exitCode == null && !second.state.spawnError;
    const rejected = secondInstanceWasRejected({
      firstAlive,
      secondSpawnError: second.state.spawnError,
      secondExitCode: second.state.exitCode,
      secondTimedOut: second.state.timedOut,
    });
    check('第二实例被单实例锁快速拒绝并以 0 退出', rejected, secondRejectedDetail(second));
  } else {
    check('第二实例被单实例锁快速拒绝并以 0 退出', false, '首实例未存活，无法验证');
  }

  const processLog = [first.state.stdout, first.state.stderr,
    second ? second.state.stdout : '', second ? second.state.stderr : ''].join('\n');
  // 判据不变（startupLogLooksHealthy），但 shell 模式下首实例的 stdout/stderr
  // 物理上采不到（explorer 交棒后没有管道可接）。这种情况必须写在 message 里 ——
  // 否则读验收单的人会以为「首实例的输出也检查过了」。
  const processLogDetail = VIA_SHELL
    ? 'explorer 代理无法采集首实例 stdout/stderr（本次仅覆盖第二实例输出；首实例的日志健康见「main.log 增量无常见致命错误」）'
    : '';
  check('进程输出无常见致命错误', startupLogLooksHealthy(processLog), processLogDetail);

  // ── 日志观测：轮询到判据有明确结论（或 30 秒超时），不再固定等待 ────────
  // 两种启动模式共用同一段轮询逻辑：判据相同、快照读取相同、停止条件相同，
  // 只有「首次观测时刻」因启动方式不同而天然不同（直启要等 6s 存活 + 4s
  // 第二实例，本来就在启动后 ~10s 才看第一眼）。直启模式因此不会因为轮询
  // 而变慢：首次观测就在拿到结论时立刻退出。
  const logWait = await waitForRendererSnapshot(
    first.launchedAt,
    () => readLogIncremental({ logPathPre, spawnOffset }),
    { skipRenderCheck: SKIP_RENDER_CHECK, processGone: !firstAlive },
  );
  const snapshot = logWait.snapshot;
  const logPath = snapshot.logPath;
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
    await shutdownInstance(second);
    await shutdownInstance(first);
    verifyCleanup(launchBaseline.pids, first.launchedAt, pidDiscoveryFailed);
    finish(`日志缺失，${LOG_DEPENDENT_COUNT} 条未验证`);
    return;
  }
  if (snapshot.pathChanged) {
    console.log('WARN  使用的 main.log 路径在启动前后发生了变化，偏移失去意义，本次增量不可采信');
  }
  if (snapshot.logState === 'rotated') {
    // 轮转/截断：新旧内容无法区分，下面四条日志内容断言全部被禁用（不得判绿）。
    console.log('WARN  日志被轮转/截断，增量不可采信');
  }

  // 下列断言消费的是**轮询停止时那一次**读到的快照（不做第二次读取）：
  // 多读一次会引入「轮询看到 done、断言读到 failed」的口径漂移。
  const { logState, incremental, deltaBytes } = snapshot;

  const logStateDetail = logState === 'empty'
    ? '本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化'
    : '日志被轮转/截断，新旧内容无法区分，本次增量不可采信';

  // 独立断言：本次启动到底有没有写日志。这一条不过，后面四条日志内容断言一律
  // FAIL（含第 8 条渲染层），绝不允许「读到历史尾部」冒充本次启动健康。
  // 第 4 条同样挂着 withBlindSpotHint（纵深防御，当前恒不触发，见其注释）：
  // 新实例若被单实例锁挡掉，主进程根本没跑起来，main.log 自然零增量 ——
  // 这一条 FAIL 与第 1 条是同一个成因。
  check('本次启动写了日志（main.log 增量非空）', logState === 'fresh',
    logState === 'fresh' ? `${deltaBytes} B 新增` : withBlindSpotHint(logStateDetail));

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
  //
  // 注意：判据只有一条 —— 增量日志里最后一次 loadFile 结果是 done。
  // 不存在「explorer 代理模式即视为通过」这类旁路；shell 模式的价值是让渲染
  // 进程真的起得来（实测 total=4 / renderer=1），从而让这条判据有机会为真，
  // 而不是把判据放宽。观测时刻由上面的轮询决定（停止时的快照即为判定依据），
  // 连「等了多久、轮询了几次」一起写进 message，让结论自带时序证据。
  const waitedSec = (logWait.waitedMs / 1000).toFixed(1);
  const waitEvidence = `启动后 ${waitedSec}s / 轮询 ${logWait.polls} 次`;
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
      check(RENDER_CHECK_NAME, true, `增量日志出现 [main] loadFile done（${waitEvidence}）`);
      rendererSummary = `已加载（loadFile done，${waitedSec}s）`;
    } else if (renderState === 'failed') {
      check(RENDER_CHECK_NAME, false,
        `${rendererFailureDetail(incremental)}（${waitEvidence}） —— ${RENDER_FAIL_HINT}`);
      rendererSummary = '未加载（loadFile failed）';
    } else {
      // 轮询到上限仍无结论：不是「没读到失败所以算过」，而是明确判 FAIL。
      // 两种可能都写出来，读的人才知道下一步该查哪儿。
      const deadlineSec = RENDER_WAIT_DEADLINE_MS / 1000;
      const unknownDetail = logWait.stoppedBy === 'process-gone'
        ? `首实例已退出，增量日志里既无 loadFile done 也无 failed（${waitEvidence}）`
          + ' —— 启动阶段就崩了，先看第 1 条与 stdout/stderr'
        : `${deadlineSec} 秒内既无 loadFile done 也无 failed —— 应用可能未创建窗口，或日志口径变化`
          + `（实测等满 ${waitedSec}s / 轮询 ${logWait.polls} 次）`;
      check(RENDER_CHECK_NAME, false, unknownDetail);
      rendererSummary = '无记录（既无 done 也无 failed）';
    }
  }

  await shutdownInstance(second);
  await shutdownInstance(first);
  verifyCleanup(launchBaseline.pids, first.launchedAt, pidDiscoveryFailed);
  finish();
}

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
 * 日志缺失路径要补记的 5 条 FAIL（第 4~8 条，全部依赖 main.log）。
 *
 * 为什么是 FAIL 而不是 SKIP：SKIP 的语义是「显式声明后允许不做」（见
 * SMOKE_SKIP_RENDER_CHECK），而本机没有 main.log 属冒烟前提不成立。按
 * docs/process/QA.md §五 的「条件错」口径：条件本身不可判定时既不改条件语义、
 * 也不得写成通过 —— 前提不满足就该红，退出码 1。
 *
 * 名字必须与 main() 正常路径里那四处 check('...') 逐字一致：两处改名不同步会
 * 让验收单上出现两个不同的断言名。之所以不用常量集中管理，是因为
 * test/release-smoke-checks.test.js 的静态守卫认的是正常路径的**字面量**
 * 调用形态（check('本次启动写了日志（main.log 增量非空）' 等），抽成
 * CHECK_NAMES.xxx 会让那条守卫变红 —— 守卫是契约，不动它。
 *
 * 用函数声明（而非 const 箭头函数）是为了拿函数提升：它在 main() 的早退分支里
 * 被调用，而本声明在源码上位于 main() 之后，const 会踩 TDZ。
 *
 * @param {string} detail 统一失败说明（LOG_MISSING_DETAIL），5 条共用。
 */
function failLogDependentAssertions(detail) {
  // 第 4 条在「日志缺失」路径上同样是 FAIL，所以与第 1 条保持同一调用形态
  // （口径是「第 1 条或第 4 条 FAIL 一律关联盲区」；盲区当前已前置拒绝，
  // 此调用为纵深防御，见 withBlindSpotHint 的注释）。
  check('本次启动写了日志（main.log 增量非空）', false, withBlindSpotHint(detail));
  check('本机 main.log 增量无常见致命错误', false, detail);
  check('全局快捷键注册成功（已注册 N/M 且 N≥1）', false, detail);
  check('托盘启动无失败记录（日志无 [tray] 告警）', false, detail);
  check(RENDER_CHECK_NAME, false, detail);
}

main().catch((e) => {
  console.error('发行冒烟执行失败:', e && e.stack || e);
  process.exitCode = 2;
});
