### 验收执行单 · 待分配（建议 004） · 真机冒烟脚本健壮性修复 · r1

> **本单已作废（保留仅作留痕）。** 结论被 `docs/process/QA-ACCEPT-PENDING-004-r2-2026-10-23.md` 取代，原因有二：
> 一是「渲染层加载失败」一项已由交付总监定性为**执行环境渲染进程沙箱不可用**（实测 `--no-sandbox` 可证），
> 本单第 74 行的「成因未定性」不再成立；二是断言由 7 条增至 8 条（新增渲染层断言），本单的 7/7 口径已过期。
> 遗留项命名同时改写为描述性名称：原编号式命名与 `DEMAND.md` §4.2 的 R1–R3 撞号，已按 `test/no-increment-numbering.test.js` 的守卫口径改为描述句。

- 需求 ID：**待分配（建议 004）**。台账 ID 由产品经理独占，本单不自造；落盘文件名用 `PENDING-004` 作占位，台账录入后按 §九 改名即可。
- 档位：**L3**（命中 Q1「改了 `scripts/`」；命中即停，不再问 Q7）
- 基线 SHA：`5689bc9f4e241f21d31ff72d8007ead78e3f1cd7`（`git rev-parse HEAD` 实值）；采集时刻：2026-10-23 14:00
- 未提交改动：`git status --porcelain` 共 **3 项**，与本次交付说明一致；**改动未锚定**（HEAD 仍是 `5689bc9`，三处改动全部处于工作区未提交状态，本单证据只对「`5689bc9` + 这 3 项改动」这一组合成立）：
  ```
   M scripts/release-smoke-checks.cjs
   M scripts/smoke-test-manual.js
   M test/release-smoke-checks.test.js
  ```
  （`git diff --numstat`：`35/0`、`255/24`、`77/0` —— 前两列是「增/删」行数。`test/` 与 `release-smoke-checks.cjs` 的删行数为 **0**，是「只加不减」的硬证据。）
- 验收条件来源：本次无台账行、无需求详情文件（PM 尚未录入）。本单验收条件由交付说明中的改动项逐条转写为可判定句，**不含口头补充**；PM 录入台账后若字面文本与本单不一致，以台账为准并重出 r2。
- 备注（基线自证）：`dist/`、`.preview/` 在 `.gitignore` 内（`.gitignore:2`、`.gitignore:55`），故 `npm run verify` 的 build 与 `smoke:asar` 不会污染 `git status --porcelain`；复测全程仅本条执行单是新增文件，按 §七 B3 例外（差异仅落 `docs/`）不影响判据。

#### 逐条执行

| 需求 ID | 档位 | 基线 SHA | 条件编号 | 判定结果 | 证据编号 | 执行人 | 执行时间 |
|---|---|---|---|---|---|---|---|
| PENDING-004 | L3 | 5689bc9 | 1 [自] 基线复跑 7/7 | 通过 | EV-PENDING-004-1 | 严过关 | 2026-10-23 14:03 |
| PENDING-004 | L3 | 5689bc9 | 2 [自] 新增纯函数三态用例可跑通 | 通过 | EV-PENDING-004-2 | 严过关 | 2026-10-23 14:06 |
| PENDING-004 | L3 | 5689bc9 | 3 [复] 「无新增日志」断言变异后必须红 | 通过 | EV-PENDING-004-3 | 严过关 | 2026-10-23 14:04 |
| PENDING-004 | L3 | 5689bc9 | 4 [复] 污染环境（`ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`）仍 7/7 | 通过 | EV-PENDING-004-4 | 严过关 | 2026-10-23 14:05 |
| PENDING-004 | L3 | 5689bc9 | 5 [复] `taskkill` 后零残留（两轮） | 通过 | EV-PENDING-004-5 | 严过关 | 2026-10-23 14:05 |
| PENDING-004 | L3 | 5689bc9 | 6 [观] `ENV` 声明行 + 汇总行旗标状态可见 | 通过 | EV-PENDING-004-6 | 严过关 | 2026-10-23 14:03 |
| PENDING-004 | L3 | 5689bc9 | 7 [复] `SMOKE_BARE_LAUNCH=1` 可关闭旗标 | 通过 | EV-PENDING-004-7 | 严过关 | 2026-10-23 14:08 |
| PENDING-004 | L3 | 5689bc9 | 8 [复] 裸启动真实稳定性（连跑 3 次） | **不通过（环境错）** | EV-PENDING-004-8 | 严过关 | 2026-10-23 14:08 |
| PENDING-004 | L3 | 5689bc9 | 9 [自] 7 条断言无删减、无放宽 | 通过 | EV-PENDING-004-9 | 严过关 | 2026-10-23 14:09 |
| PENDING-004 | L3 | 5689bc9 | 10 [自] 档位最低闸门 `npm run verify` | 通过 | EV-PENDING-004-10 | 严过关 | 2026-10-23 14:12 |
| PENDING-004 | L3 | 5689bc9 | 11 [观] 渲染层实际加载成功（窗口可用） | **未执行（无观测出口，脚本无此断言）** | EV-PENDING-004-11 | 严过关 | 2026-10-23 14:09 |
| PENDING-004 | L3 | 5689bc9 | 12 [复] 7 项人工冒烟（安装/启动窗口可见/搜索/入队/下载/播放/更新检查） | **未执行（全部 0/7）** | — | 严过关 | 2026-10-23 14:12 |

#### 强制项勾选（照抄 `DEMAND.md` §3.3 对应类型，缺一即不通过）

改动落在 `scripts/`（门禁脚本），不属 §3.3 七类中任何一类业务改动；按「改依赖 / 构建配置」一栏的口径套用，并要求 §十 红线④（改行为必须有用例）：

- [x] `npm run check:dead-deps` + `npm run build` + `npm run smoke:asar` 全通过 → EV-PENDING-004-10
- [x] 改行为有对应用例，且新用例名出现在 `npm test` 计数里（6 个新 `test()`，`# tests` 由 3447 升至 3453）→ EV-PENDING-004-2
- [x] L3 附加项「影响面清单 + 回滚方案」→ 见下方同名小节
- [ ] L3 附加项「一次人工启动冒烟」→ **未执行**（见条件 12），故本单**只能签「脚本健壮性修复」这一层，不能签「可发布」**

#### 闸门输出摘要（抓取写法见 §三，完整日志在系统临时目录，不入库）

| 闸门 | 命令 | 退出码 | 保留行（≤5 行） | 完整日志 |
|---|---|---|---|---|
| 全量闸（L3 最低闸门） | `npm run verify` | **0** | `# tests 3453` / `# pass 3453` / `# fail 0` / `# skipped 0` / `PASS asar 含全部平台模块（src 中共 8 个）` | `/tmp/verify.log`（22384 行，已抽取入附录） |
| 单测（分段跑） | `npm test` | **0** | `# tests 3453` / `# pass 3453` / `# fail 0` / `# duration_ms 56455.7755` | `/tmp/test.log` |
| Lint | `npm run lint` | **0** | `✖ 6 problems (0 errors, 6 warnings)`（warning 全在未改动的 `src/renderer/js/playback/engine.js` 与 5 个既有 `test/`） | `/tmp/lint.log` |
| 脚本本体（带旗标） | `node scripts/smoke-test-manual.js .preview/release-smoke-ui/win-unpacked/Lanyue.exe` | **0** | `7/7 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动）` | `/tmp/smoke-base.log` |
| 脚本本体（裸启动 ×3） | `SMOKE_BARE_LAUNCH=1 node scripts/smoke-test-manual.js …` | **0 / 1 / 1** | `7/7` ／ `6/7` ／ `5/7` | `/tmp/bare-1..3.log` |
| 人工冒烟（§四） | 手动 | — | **0/7 项执行** | — |

#### 影响面清单（L3 必需）

- 受影响脚本：`scripts/smoke-test-manual.js`（`verify:release` / `smoke:release` 的唯一执行体）、`scripts/release-smoke-checks.cjs`（纯判据）、`test/release-smoke-checks.test.js`。
- 受影响的既有纪律：`QA.md` §四 对「`smoke-test-manual.js` 只断言四组」的描述**已与实现对不上**（现为 7 条断言、含独立「本次启动写了日志」）。属文档口径滞后，非本单判据，登记为遗留「文档口径漂移」。
- 不受影响：`src/**` 零改动（`git status --porcelain` 可证），故产品运行时行为未变。

#### 回滚方案（L3 必需）

`git checkout -- scripts/smoke-test-manual.js scripts/release-smoke-checks.cjs test/release-smoke-checks.test.js`（三处均为未提交改动，回滚即弃掉本轮修复，HEAD `5689bc9` 无残留）。回滚后冒烟脚本回到「6 条断言 + 静默退化为历史尾部」的旧形态，即假绿形态回归——**回滚即放弃本需求价值**，属不可接受选项，仅作灾难路径。

#### 结论

- 判定：**有条件通过（脚本健壮性修复这一层签收；「可发布」不签收）**
  - 通过的部分：7 条断言里没有任何一条被放宽或删除；「无新增日志」这条经变异验证真能红，且红时连带冻结三条日志断言（3/7）；`ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` 清理实测生效；两轮零残留；`verify` 全绿。
  - 条件（**全部满足才可把本条需求置 `已签收`**）：
    1. **条件 8 判为环境错**（3 次裸启动失败指纹漂移：7/7 → 6/7 → 5/7，形态不同），按 §五 处置：本机（GPU 子进程 `0xC0000005` → 主进程 `0x80000003`）**不具备「发版前裸跑一次必过」的条件**。发版前裸跑必须在真实用户 GUI 会话（非 agent sandbox）执行，且**每次结果原样记录、禁止重跑到绿再报**；若在真实会话仍失败，按 §四 表归类后另开条目。
    2. **条件 11 的观测盲区必须由 PM 立新条目补齐**（补一条「渲染层 `did-finish-load` 成功」断言），在补齐前，任何「冒烟 7/7 = 产品可用」的表述禁止出现在验收单与发版说明里（EV-11 已证明 7/7 可与渲染层加载失败共存）。
    3. 条件 12 的 7 项人工冒烟 0/7 执行，因此本需求**不得**进入 `已发版`；发版闸仍压在本条上。
  - 交回工程师的只有一处**文本订正**（非实现错，不打回）：交付说明写「补 12 条用例」，实为 **6 个 `test()` 块**（`# tests` 3447→3453，+6），其中约 25 条 `assert`；请工程师更正说明措辞。
- 已知遗留：
  - 「GPU 子进程间歇崩溃」（环境）GPU 子进程间歇 `0xC0000005`，主进程 `0x80000003`；默认带 `--disable-gpu-sandbox` 是环境适配，非产品修复。**带旗标通过 ≠ 裸启动通过**，两者是不同强度结论。
  - 「渲染层加载失败」（本单标为未定性异常；**已被 r2 推翻并定性为环境错**）被测产物 `.preview/release-smoke-ui/win-unpacked` 自打包后 **30 次启动 30 次**出现 `[main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///…\resources\app.asar\dist\renderer\index.html'`，7 条断言全绿。已核 asar 内该文件完好（123685 B、头部 `<!DOCTYPE html>` 可读、`integrity.SHA256` 存在），故非「产物缺文件」；`src/main/index.js:131` 仅 `logger.warn` 无兜底。本单当时未代为定性，仅登记为「7/7 ≠ 可用」的直接证据。
  - 「文档口径漂移」（文档）`QA.md` §四 首段「只断言四组」已滞后于 7 条断言实现。
  - 「单实例锁未生效」（异常项，按 §四 末条纪律不得放过）裸启动第 2 轮「第二实例」未在 4 s 内退出（`exit=null timedOut=true`），且该轮 `main.log` 新增 1933 B 明显多于健康轮 1201 B——三次裸启动共写入 **4 条**完整启动序列，说明有 1 个「第二实例」进了主进程并跑完启动序列（`[logger] 日志落盘已启用` → `[shortcuts] 全局快捷键已注册 3/3`），单实例锁**当轮未生效**。3 次中 1 次、非确定性 → 按 §五 暂归**环境错（指纹漂移）**，但形态与 GPU 崩溃不同，需在真实 GUI 会话复测 3 次后定性；若是确定性复现，升级为实现错并打回。

#### 证据附录

[EV-PENDING-004-1] 基线复跑，完整输出（`/tmp/smoke-base.log`，退出码 0）
```
ENV   子进程附加旗标: --disable-gpu-sandbox（受限环境 GPU 子进程崩溃，实测 0x80000003；裸启动见 SMOKE_BARE_LAUNCH=1）
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
PASS  首实例启动后持续存活 6 秒 — exit=null signal=null
PASS  第二实例被单实例锁快速拒绝并以 0 退出 — exit=0 timedOut=false
PASS  进程输出无常见致命错误
PASS  本次启动写了日志（main.log 增量非空） — 1664 B 新增
PASS  本机 main.log 增量无常见致命错误 — AppData\Roaming\music-downloader\logs\main.log
PASS  全局快捷键注册成功（已注册 N/M 且 N≥1）
PASS  托盘启动无失败记录（日志无 [tray] 告警）

7/7 通过  ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动）
```

[EV-PENDING-004-2] 新增用例在 `npm test` TAP 里的落点（`/tmp/test.log` 第 16766–16796 行；6 个 `test()`、25 条 `assert`）
```
ok 2582 - 日志增量状态：无新增字节必须判 empty，不得退化为历史尾部
ok 2583 - 日志增量状态：当前长度短于启动前偏移说明被轮转/截断
ok 2584 - 日志增量状态：有新增字节才算 fresh
ok 2585 - 日志增量状态：非法入参一律归 empty（宁可判红不可假绿）
ok 2586 - empty / rotated 状态下三条日志断言一律不得判绿
ok 2587 - 静态守卫：冒烟脚本先判定增量状态，再决定三条日志断言
```

[EV-PENDING-004-3] 变异验证：把 `let logState = logIncrementalState(buf.length, baseline);` 临时改成 `…(buf.length, buf.length)`（等价空增量），退出码 **1**
```
FAIL  本次启动写了日志（main.log 增量非空） — 本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化
FAIL  本机 main.log 增量无常见致命错误 — 本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化
FAIL  全局快捷键注册成功（已注册 N/M 且 N≥1） — 本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化
FAIL  托盘启动无失败记录（日志无 [tray] 告警） — 本次启动未写日志：进程可能未真正进入主进程（检查 ELECTRON_RUN_AS_NODE）或日志路径变化

3/7 通过  ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动）
```
还原证明（备份 → `cp` 回写 → 指纹与 diff 双重校验）：
```
before: 4110ae4c9264347aa6d2492474ae6ba77fa41defb68c53dc8c7ecd238cc31dff *scripts/smoke-test-manual.js
after : 4110ae4c9264347aa6d2492474ae6ba77fa41defb68c53dc8c7ecd238cc31dff *scripts/smoke-test-manual.js
SHA_IDENTICAL=YES
35	0	scripts/release-smoke-checks.cjs
255	24	scripts/smoke-test-manual.js
77	0	test/release-smoke-checks.test.js
339:  let logState = logIncrementalState(buf.length, baseline);
```

[EV-PENDING-004-4] 污染环境复跑，退出码 0（`/tmp/smoke-dirty.log`）。同一命令前置了残留检查，结论同 EV-5 第二轮
```
$ ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--max-old-space-size=512 node scripts/smoke-test-manual.js .preview/release-smoke-ui/win-unpacked/Lanyue.exe
…
PASS  本次启动写了日志（main.log 增量非空） — 2330 B 新增
…
7/7 通过  ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动）
```

[EV-PENDING-004-5] 零残留，两轮（`tasklist //FI "IMAGENAME eq Lanyue.exe"`）
```
第 1 轮（基线复跑后立即查）  信息: 没有运行的任务匹配指定标准。
第 2 轮 跑前（污染环境复跑前）信息: 没有运行的任务匹配指定标准。
第 2 轮 跑后                  信息: 没有运行的任务匹配指定标准。
（裸启动 3 连跑每次开跑前亦复检 3 次，均无匹配。）
```

[EV-PENDING-004-6] `ENV` 声明行与汇总行的旗标状态（两行原文，分别取自 EV-1 首行与末行）
```
ENV   子进程附加旗标: --disable-gpu-sandbox（受限环境 GPU 子进程崩溃，实测 0x80000003；裸启动见 SMOKE_BARE_LAUNCH=1）
7/7 通过  ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动）
```
裸启动时同一位置的取值（证明开关是严格字符串比较，`SMOKE_BARE_LAUNCH=1` 才生效）：
```
ENV   子进程附加旗标: 无（裸启动，与用户双击行为一致）
7/7 通过  ｜ 启动方式: 裸启动（无附加旗标，与用户双击行为一致）
```

[EV-PENDING-004-7] `SMOKE_BARE_LAUNCH=1` 生效（`/tmp/bare-1.log` 首末行），未见旗标被追加

[EV-PENDING-004-8] 裸启动连跑 3 次，**不稳定**（`/tmp/bare-1..3.log`）
```
RUN1 EXIT=0 ELAPSED=11233ms   7/7 通过
RUN2 EXIT=1 ELAPSED=11451ms   6/7 通过
     FAIL  第二实例被单实例锁快速拒绝并以 0 退出 — exit=null timedOut=true
RUN3 EXIT=1 ELAPSED=6718ms    5/7 通过
     FAIL  首实例启动后持续存活 6 秒 — exit=2147483651 signal=null
     FAIL  第二实例被单实例锁快速拒绝并以 0 退出 — 首实例未存活，无法验证
```
同窗口 `main.log` 佐证（4 条启动序列 vs 3 次首实例，见「单实例锁未生效」）：
```
2026-10-23T06:07:55.555Z [LOG] [logger] 日志落盘已启用: …
2026-10-23T06:08:07.816Z [LOG] [logger] 日志落盘已启用: …
2026-10-23T06:08:13.946Z [LOG] [logger] 日志落盘已启用: …
2026-10-23T06:08:20.263Z [LOG] [logger] 日志落盘已启用: …
```

[EV-PENDING-004-9] 7 条断言名称与判据来源（逐条读码，行号指当前工作区文件）

| # | 断言名（`check()` 字面量） | 判据来源（函数 / 行） | 与 HEAD `5689bc9` 比 |
|---|---|---|---|
| 1 | 首实例启动后持续存活 6 秒 | `processStayedAlive` `release-smoke-checks.cjs:6-10`；调用 `smoke-test-manual.js:283` | 函数体 0 改动 |
| 2 | 第二实例被单实例锁快速拒绝并以 0 退出 | `secondInstanceWasRejected` `:12-14`；调用 `smoke-test-manual.js:297`（首实例未存活时 `:300` 判 false） | 函数体 0 改动 |
| 3 | 进程输出无常见致命错误 | `startupLogLooksHealthy` `:16-27`；调用 `smoke-test-manual.js:305` | 函数体 0 改动 |
| 4 | **本次启动写了日志（main.log 增量非空）** | `logIncrementalState(buf.length, baseline) === 'fresh'` `:86-96`；调用 `smoke-test-manual.js:339`、断言 `:364` | **新增断言**（HEAD 无此条） |
| 5 | 本机 main.log 增量无常见致命错误 | `startupLogLooksHealthy(incremental)` 且 `canAssertLogContent`（`:367` 门控）；断言 `:370` | 判据**收紧**（旧版无门控，可读历史尾部） |
| 6 | 全局快捷键注册成功（已注册 N/M 且 N≥1） | `shortcutsRegisteredInLog` `:42-49` 且门控；断言 `:373` | 判据**收紧**；`N=0` 仍判 false、`N<M` 仍允许（与旧版一致，未放宽） |
| 7 | 托盘启动无失败记录（日志无 [tray] 告警） | `trayFailureAbsent` `:59-62` 且门控；断言 `:376` | 判据**收紧** |

逐条回答两问：
- **有没有任何一条从「必须满足 X」被改成「满足 Y 也算」？** 没有。三处纯判据函数（`processStayedAlive` / `secondInstanceWasRejected` / `startupLogLooksHealthy` / `shortcutsRegisteredInLog` / `trayFailureAbsent`）在此次改动中 `git diff` 删除行数为 **0**（`release-smoke-checks.cjs 35/0`），断言 1/2/3/5/6/7 的期望值均与 HEAD 逐字相同；5/6/7 只是**多了**一个 `canAssertLogContent &&` 前置条件，方向是更严。
- **有没有删掉原有断言？** 没有。HEAD 版 6 个断言名在当前文件里全部存在（`grep -c` 逐一命中），新增 1 条，故 6→7。`test/release-smoke-checks.test.js` 亦是 `77/0`（纯新增 6 个用例，未删未改既有用例）。

[EV-PENDING-004-10] `npm run verify`（L3 最低闸门），退出码 0，`/tmp/verify.log`
```
# tests 3453
# pass 3453
# fail 0
# cancelled 0
# skipped 0
VERIFY_EXIT=0
```
其中 `smoke:asar` 段（尾部 5 行）：
```
> node scripts/smoke-asar.js
PASS  asar 含全部平台模块（src 中共 8 个）  — 8 个
PASS  asar 内 package.json 版本非空  — pkg=1.0.37
PASS  渲染层 bundle 断言源 = dist（app.asar 早于 src/ 最新改动）  — … 发布前必须 npm run package 后复跑本脚本，否则验的是旧包
PASS  asar 内 assets/icon.png 与工作区当前图标一致（防打进去旧图标）  — 15033 B
PASS  生产依赖树 249 个包按 lock 解析全部在 asar 中（排除项 31 个除外）  — 无缺失
```
`npm run lint` 尾部：`✖ 6 problems (0 errors, 6 warnings)`，6 条 warning 均落在本次未改动的文件（`src/renderer/js/playback/engine.js` 2 条 + 4 个既有 `test/`），不计入本需求。

[EV-PENDING-004-11] 渲染层加载失败与 7/7 共存（`$APPDATA/music-downloader/logs/main.log`，只读粘贴）
```
2026-10-23T06:08:20.625Z [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\resources\app.asar\dist\renderer\index.html'
```
计数：`grep -c 'loadFile failed'` = **30**；`grep -c '日志落盘已启用'` = 68（含 10-13 起的历史轮次），而 30 次失败的首现时间 `2026-10-23T05:48:54.285Z` 与被测产物打包时刻（`.preview/…/app.asar` mtime 13:45 本地 = 05:45Z）吻合 → **该产物每一次启动都失败**。产物侧自证完好：
```
asar list → \dist\renderer\index.html 存在
header entry: {"size":123685,"offset":"33189427","integrity":{"algorithm":"SHA256",…}}
首 60 字节: <!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UT
```
`src/main/index.js:131` 仅 `logger.warn('[main] loadFile failed:', err);`，无兜底重载、无 `did-fail-load` 处理 —— 即窗口白屏时进程仍健康，7 条断言全部 PASS。
