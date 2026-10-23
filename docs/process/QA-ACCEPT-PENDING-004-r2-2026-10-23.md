### 验收执行单 · 待分配（建议 004） · 真机冒烟脚本健壮性修复 · r2（最终复测）

- **需求 ID**：**待分配**（占位 `PENDING-004`）。台账 ID 由产品经理独占，本单不自造；台账录入后按 `QA.md` §九 改名即可。
- **档位**：**L3**（命中 Q1「改了 `scripts/`」；命中即停，不再问 Q7）
- **基线**：`5689bc9f4e241f21d31ff72d8007ead78e3f1cd7`（`git rev-parse HEAD` 实值）。采集时刻 2026-10-23 14:40。
- **未提交改动**：`git status --porcelain` 共 **3 项**，全部处于工作区、**改动未锚定**（HEAD 仍是 `5689bc9`）。本单全部证据只对「`5689bc9` + 这 3 项改动」这一组合成立：
  ```
   M scripts/release-smoke-checks.cjs
   M scripts/smoke-test-manual.js
   M test/release-smoke-checks.test.js
  ```
  `git diff --numstat`：`82/0`、`488/35`、`167/0`（增/删行）。
- **前序**：上一轮执行单 `docs/process/QA-ACCEPT-PENDING-004-r1-2026-10-23.md`（7 条断言口径）**已作废**，保留仅作留痕；作废原因见该文件首段。
- **本轮采信的上游定性**（交付总监，2026-10-23）：渲染层白屏的根因是**本执行环境无法创建带沙箱的渲染进程**，不是产品缺陷。本单不重新归因，只做独立复验（见 §一）。

#### 一、上游定性事实 + 本单独立复验

采信的五项实验（不重复做，作为前提）：

| 实验 | 结果 |
|---|---|
| `Lanyue.exe --disable-gpu-sandbox` | 进程活，日志 `[WARN] [main] loadFile failed: ERR_FAILED (-2)` |
| 同上 + CDP `/json` | page target 在，`title=""`（真白屏） |
| 同上 + `--no-sandbox` | `title="揽乐"` + `[LOG] [main] loadFile done` |
| 开发态 `npx electron .`（纯 `file://`，非 asar） | 同样 `ERR_FAILED` |
| 历史包 `.preview/release-smoke-s4`（10-20 打包） | 同样 `ERR_FAILED` |

**本单独立复验**（不改源码、只在本机同一会话里换旗标，主进程 `main.log` 的时间序可自证）：

```
2026-10-23T06:35:33.201Z [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///…app.asar\dist\renderer\index.html'
2026-10-23T06:36:00.846Z [LOG] [main] loadFile done                          ← 变异轮（追加 --no-sandbox）
2026-10-23T06:36:24.855Z [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///…app.asar\dist\renderer\index.html'
```
`grep -c 'loadFile failed'` = **51**，`grep -c 'loadFile done'` = **36**（同一份日志、同一个 exe、同一台机器、同一分钟窗口内两种结果并存）。
→ **结论：一个 exe 的渲染层能否画出界面，由「本机能否创建带沙箱的渲染进程」决定，与本次改动无关。** 交付总监的定性在本机可复现，本单采信。

#### 二、8 条断言逐条判定

标记：`[观]` 只读观测（读产出/日志，不干预）｜`[复]` 主动复现（跑命令）｜`[自]` 静态自证（读码/口径核对）。

| # | 断言（`check()` 字面量） | 标记 | 判定 | 证据 |
|---|---|---|---|---|
| 1 | 首实例启动后持续存活 6 秒 | [复] | **通过** | 3 次默认跑与跳过跑均 `exit=null signal=null`（EV-12、EV-13） |
| 2 | 第二实例被单实例锁快速拒绝并以 0 退出 | [复] | **通过（本环境 4/4）** | `exit=0 timedOut=false`（EV-12 ×3、EV-13 ×1）；上轮裸启动的 1 次异常**本轮未复现**，仍留遗留（见 §七） |
| 3 | 进程输出无常见致命错误 | [复] | **通过** | 三个实例 stdout/stderr 无 `uncaught exception` / `cannot find module` / `ERR_ELECTRON` 等（EV-12） |
| 4 | 本次启动写了日志（main.log 增量非空） | [复] | **通过** | 新增字节 1664 / 2330 / 2330 B（EV-12 三次）；判定源 `logIncrementalState(...)==='fresh'` |
| 5 | 本机 main.log 增量无常见致命错误 | [复] | **通过** | 只读 spawn 之后的切片，门控 `canAssertLogContent` 成立（EV-12） |
| 6 | 全局快捷键注册成功（已注册 N/M 且 N≥1） | [复] | **通过** | 切片内出现「[shortcuts] 全局快捷键已注册 N/M」且 N≥1（EV-12） |
| 7 | 托盘启动无失败记录（日志无 [tray] 告警） | [复] | **通过** | 切片内无 `[tray]` 前缀告警（EV-12） |
| 8 | 主窗口渲染层已加载（增量日志出现 [main] loadFile done） | [复] | **不通过 —— 环境错（已定性，非产品缺陷）** | 默认路径真红且 message 含 `ERR_FAILED (-2)`；变异追加 `--no-sandbox` 后同一条真绿（8/8 + `渲染层: 已加载`）。双向证据见 §三 |

判据侧的横向核对（均 `[自]`，读码 + `git diff`）：

| 核对项 | 结果 |
|---|---|
| 有没有断言被删除 | **没有**。HEAD 版 6 条断言名字面量在当前文件全部命中；第 8 条为新增，合计 8。 |
| 有没有断言被放宽 | **没有**。`release-smoke-checks.cjs` 的 diff 为 `82/0`（纯新增，零删除）；`smoke-test-manual.js` 的 35 行删除逐行复核后全部落在「头注释重写」「旧实现被更严实现替换」「旧缺失日志分支的 SKIP 文案」三类，无一条断言期望值被改宽。第 4~8 条为 5/6/7 增加了 `canAssertLogContent &&` 前置条件，方向是**更严**。 |
| 分母口径是否还会误导 | **不会**。分母是常量 `TOTAL_ASSERTIONS = 8`（不是 `results.length`），并带记账自检：两条路径实测都恰好记 8 条，不等即打 `WARN 断言记账与分母不一致` 并置退出码 1（EV-14）。 |
| 第 8 条是否「假绿」 | **不是**。默认路径真红、变异路径真绿，两个方向都观测到（§三）。`failed` 与 `unknown` 一律判 FAIL，只有 `done` 判 PASS。 |
| 跳过开关是否会被误判为通过 | **不会**。严格 `=== '1'` 比较；实测 `SMOKE_SKIP_RENDER_CHECK=0` 仍走判定分支并判红（EV-13）。 |

#### 三、第 8 条的双向变异（证明它不是装饰性断言）

**(a) 真红（默认路径，3 次全红）**
```
FAIL  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\resources\app.asar\dist\renderer\index.html' —— 渲染层未加载 = 用户白屏；若同时有 GPU/沙箱相关错误，先按环境错处理并改用真实桌面会话复测
7/8 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未加载（loadFile failed）
```
**(b) 真绿（临时给 `CHILD_ARGS` 追加 `--no-sandbox`）**
```
PASS  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 增量日志出现 [main] loadFile done
8/8 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 已加载（loadFile done）
```
**(c) 还原证明（变异必须零残留）**
```
变异前 sha256: 8415c5a37d1b2236767decee5cbf855568f0051c4787a5fca11f3984eaf431c2
还原后 sha256: 8415c5a37d1b2236767decee5cbf855568f0051c4787a5fca11f3984eaf431c2
SHA_IDENTICAL=YES
$ grep -n "CHILD_ARGS = " scripts/smoke-test-manual.js
98:const CHILD_ARGS = BARE_LAUNCH ? [] : [GPU_SANDBOX_FLAG];
$ git diff scripts/ | grep -n "no-sandbox"     → 仅命中两处**注释**（`:53`、`:220`，工程师原有注释），无可执行行残留
```

> 附带发现（**不构成打回项，登记为观察**）：`ENV` 行与汇总行的启动方式标签只拼 `GPU_SANDBOX_FLAG`，不反映 `CHILD_ARGS` 全量。变异轮实测汇总行仍写「带 --disable-gpu-sandbox」，而实际多传了 `--no-sandbox`。当前交付态下 `CHILD_ARGS` 只有一项、与声明一致，故不影响本单判据；但将来若再加旗标，声明就会滞后于实参。建议后续把标签改为由 `CHILD_ARGS` 生成。

#### 四、两条非正常路径的口径

**(a) 日志缺失路径**（临时把 `logCandidates` 指向不存在的目录模拟，随后还原）
```
PASS  首实例启动后持续存活 6 秒 — exit=null signal=null
PASS  第二实例被单实例锁快速拒绝并以 0 退出 — exit=0 timedOut=false
PASS  进程输出无常见致命错误
FAIL  本次启动写了日志（main.log 增量非空） — 未定位到本机 main.log（检查过 APPDATA/music-downloader 与 APPDATA/Lanyue 两处），依赖日志的 5 条断言无法验证 —— 这属观测条件缺失，不得当作通过
FAIL  本机 main.log 增量无常见致命错误 — （同上）
FAIL  全局快捷键注册成功（已注册 N/M 且 N≥1） — （同上）
FAIL  托盘启动无失败记录（日志无 [tray] 告警） — （同上）
FAIL  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — （同上）
3/8 通过 ｜ 日志缺失，5 条未验证 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未验证（日志缺失）
```
分母仍是 **8**（不是 3），5 条补记 FAIL，退出码 **1**。还原后 `grep qa-nolog` 无命中、sha256 与变异前一致。

**(b) 显式跳过路径**
```
SKIP  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 渲染层未验证：本环境渲染进程沙箱不可用（实测 ERR_FAILED），须在真实桌面会话补做
7/8 通过 1 跳过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未验证
```
退出码 **0**；跳过单独计数、绝不计入通过。`SMOKE_SKIP_RENDER_CHECK=0` 实测仍判红（`7/8 通过 … 渲染层: 未加载（loadFile failed）`，退出码 1）——开关是严格字符串比较，防「置 0 反而藏红」的反向失效。

#### 五、闸门摘要

| 闸门 | 命令 | 退出码 | 保留行（≤5 行） | 完整日志 |
|---|---|---|---|---|
| 全量单测 | `npm test` | **0** | `# tests 3460` / `# pass 3460` / `# fail 0` / `# skipped 0` / `# duration_ms 60210.3157` | `/tmp/qa-test-final.log` |
| Lint | `npm run lint` | **0** | `✖ 6 problems (0 errors, 6 warnings)`（warning 全在本次未改动的 `src/renderer/js/playback/engine.js` 与 5 个既有 `test/`） | `/tmp/qa-lint-final.log` |
| 判据单测 | `node --test test/release-smoke-checks.test.js` | **0** | `# tests 19` / `# pass 19` / `# fail 0` | `/tmp/qa-unit.log` |
| 冒烟脚本（默认 ×3） | `node scripts/smoke-test-manual.js …` | **1 / 1 / 1** | `7/8` ／ `7/8` ／ `7/8`（三次第 8 条均 FAIL，message 均含 `ERR_FAILED`） | `/tmp/qa-def-1..3.log` |
| 冒烟脚本（跳过渲染层） | `SMOKE_SKIP_RENDER_CHECK=1 …` | **0** | `7/8 通过 1 跳过 ｜ … ｜ 渲染层: 未验证` | `/tmp/qa-skip.log` |
| 冒烟脚本（变异 +`--no-sandbox`） | 同上（临时改 `CHILD_ARGS`，已还原） | **0** | `8/8 通过 … ｜ 渲染层: 已加载（loadFile done）` | `/tmp/qa-mut-nosandbox.log` |
| 冒烟脚本（日志缺失模拟） | 临时改 `logCandidates`，已还原 | **1** | `3/8 通过 ｜ 日志缺失，5 条未验证 ｜ … ｜ 渲染层: 未验证（日志缺失）` | `/tmp/qa-nolog.log` |
| 人工冒烟（7 项） | 手动 | — | **0/7 项执行** | — |

零残留（每次冒烟开跑前 + 全部跑完后各查一次，共 6 次，均无匹配）：
```
$ tasklist //FI "IMAGENAME eq Lanyue.exe"
信息: 没有运行的任务匹配指定标准。
```

#### 六、三条边界（本单**没有**签到的部分，禁止在下游被读成已签）

1. **渲染层在本执行环境无法验证。** 本机无法创建带沙箱的渲染进程（已实测：同 exe 加 `--no-sandbox` 即 `loadFile done`、不加即 `ERR_FAILED`；开发态纯 `file://` 与历史包同样失败）。因此本单能签的只有「第 8 条断言按设计真红」，**不能**签「界面可用」。第 8 条在真实桌面会话的绿，必须由那一次执行产生，不得由本环境的跳过记录替代。
2. **7 项人工冒烟 0/7 执行**（安装 / 启动窗口可见 / 搜索 / 入队 / 下载 / 播放 / 更新检查）。一项都没做，故「用户视角可用」这一层完全空白。
3. **单实例锁有 1 次非确定性异常，待真实桌面会话复测。** 上一轮裸启动第 2 轮出现「第二实例未在 4 s 内退出（`exit=null timedOut=true`）」且该轮日志多出一条完整启动序列；本轮默认路径 4 次均未复现（断言 2 全 PASS）。**未复现 ≠ 已澄清**：该异常只在裸启动形态出现，而裸启动在本环境本身不稳定，必须在真实 GUI 会话连跑 3 次才能定性。

#### 七、结论

**判定：有条件通过。**

- **签的是这一层**：`scripts/smoke-test-manual.js` 的**脚本健壮性与判据完整性**——8 条断言口径正确、无删减、无放宽；分母恒为 8 且带记账自检；日志缺失路径与显式跳过路径都不会印出「看起来能签字」的分数；第 8 条经双向变异证明可红可绿，不是装饰性断言；`npm test` 3460/3460 全绿、`lint` 0 error、零残留。这是「门禁变可信了」，可以签字。
- **没签的是这一层**：**「产品可发布」**。渲染层可用性在本环境不可验证（边界 1）、7 项人工冒烟 0/7（边界 2）、单实例锁 1 次异常未定性（边界 3）。这三条任一未了结，本需求都不得进 `已发布`。
- **把本条需求置 `已签收` 的条件**（三条全满足）：
  1. 真实 GUI 会话（非 agent sandbox）默认跑一次，得 `8/8 通过 … 渲染层: 已加载（loadFile done）`；
  2. 同会话裸启动（`SMOKE_BARE_LAUNCH=1`）连跑 3 次，**每次原样记录、禁止重跑到绿再报**——这 3 次同时覆盖渲染层真实绿与单实例锁定性；
  3. 7 项人工冒烟逐项执行并留痕（`QA.md` §四）。
- **交回工程师的**：只有一处措辞更正（非实现错，不打回）——本单 §三 的附带发现，建议 `ENV`/汇总行的启动方式标签改为由 `CHILD_ARGS` 生成，避免将来加旗标时声明滞后。

#### 八、遗留清单

1. **渲染层真实绿未取得**：本环境沙箱不可用，需真实桌面会话默认跑一次（预期 8/8）。责任：QA（复测执行）。
2. **7 项人工冒烟 0/7**：发版前必做，与脚本冒烟不是同一件事。责任：QA + 交付总监。
3. **单实例锁非确定性异常**：上一轮裸启动 3 次中 1 次「第二实例未被拒」，本轮默认 4 次未复现；需真实 GUI 会话裸启动 3 次定性，若确定性复现则升级为实现错并打回。责任：QA（观测）/ 工程师（如复现）。
4. **文档口径漂移**：`QA.md` §四 首段仍写「只断言四组」，与当前的 8 条断言对不上；本单只登记不改（owner 是架构师）。责任：架构师。
5. **启动方式标签不随实参自证**：见 §三 附带发现，属可维护性改进项，非缺陷。责任：工程师（下轮顺带）。

#### 九、证据附录

[EV-PENDING-004-12] 默认路径连跑 3 次（`/tmp/qa-def-1..3.log`），逐次原文
```
RUN1 EXIT=1 ELAPSED=13s  新增 1664 B   7/8 通过 ｜ 渲染层: 未加载（loadFile failed）
RUN2 EXIT=1 ELAPSED=11s  新增 2330 B   7/8 通过 ｜ 渲染层: 未加载（loadFile failed）
RUN3 EXIT=1 ELAPSED=12s  新增 2330 B   7/8 通过 ｜ 渲染层: 未加载（loadFile failed）
（每次开跑前 tasklist 均无 Lanyue.exe 匹配）
```
完整 8 行输出（RUN1）：
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
FAIL  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — [main] loadFile failed: Error: ERR_FAILED (-2) …
7/8 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未加载（loadFile failed）
```
**抖动事实（如实记录）**：工程师自述「4 次正常路径中 1 次出现 `6/8`，渲染层判 `unknown`」；**本轮我的 3 次默认跑全部是 `7/8`（`failed`）**，未复现 `unknown`。即：`unknown` 形态（增量日志里既无 `loadFile done` 也无 `loadFile failed`）存在但低频，本轮未观测到。它只会让第 8 条从 `failed` 变成 `unknown`，两种状态都判 FAIL，**方向安全，不会产生假绿**。

[EV-PENDING-004-13] 显式跳过路径（`/tmp/qa-skip.log`，退出码 0）与严格比较反证（`/tmp/qa-skip0.log`，退出码 1）
```
SKIP  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 渲染层未验证：本环境渲染进程沙箱不可用（实测 ERR_FAILED），须在真实桌面会话补做
7/8 通过 1 跳过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未验证

$ SMOKE_SKIP_RENDER_CHECK=0 …   → EXIT=1
7/8 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未加载（loadFile failed）
```

[EV-PENDING-004-14] 日志缺失路径（`/tmp/qa-nolog.log`），分母与退出码
```
$ grep -cE '^FAIL' /tmp/qa-nolog.log
5
EXIT=1
3/8 通过 ｜ 日志缺失，5 条未验证 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未验证（日志缺失）
还原：grep qa-nolog → 无命中；sha256 8415c5a3… 与变异前一致（SHA_IDENTICAL=YES）
```

[EV-PENDING-004-15] 变异验证（`/tmp/qa-mut-nosandbox.log`，退出码 0）
```
$ grep -n "CHILD_ARGS = " scripts/smoke-test-manual.js   ← 变异态
98:const CHILD_ARGS = BARE_LAUNCH ? [] : [GPU_SANDBOX_FLAG, '--no-sandbox'];
PASS  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 增量日志出现 [main] loadFile done
8/8 通过 ｜ 启动方式: 带 --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 已加载（loadFile done）
```

[EV-PENDING-004-16] 渲染层「真绿 / 真红」在同一份主进程日志里的时间序（只读粘贴）
```
2026-10-23T06:35:33.201Z [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///…app.asar\dist\renderer\index.html'
2026-10-23T06:36:00.846Z [LOG] [main] loadFile done
2026-10-23T06:36:24.855Z [WARN] [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///…app.asar\dist\renderer\index.html'
```
计数：`loadFile failed` = 51，`loadFile done` = 36。

[EV-PENDING-004-17] 判据单测 19/19（`node --test test/release-smoke-checks.test.js`）
```
# tests 19 / # pass 19 / # fail 0 / # duration_ms 264.8532
（含「渲染层加载」6 条：done→loaded、failed→failed、双缺→unknown、failed→done 取末次、done→failed 取末次、非字符串入参→unknown；
  以及「跳过必须显式严格 === "1" 且不得把 failed 判绿」的静态守卫）
```

[EV-PENDING-004-18] 全量闸门
```
$ npm test        → TEST_EXIT=0
1..3454
# tests 3460 / # suites 1 / # pass 3460 / # fail 0 / # cancelled 0 / # skipped 0 / # duration_ms 60210.3157

$ npm run lint    → LINT_EXIT=0
✖ 6 problems (0 errors, 6 warnings)
```
本单落盘后（工作区含两份验收单）在同一状态**重跑一次**，数字不变，作为最终态证据：
```
$ npm test → TEST_EXIT=0
# tests 3460 / # pass 3460 / # fail 0 / # skipped 0
$ tasklist //FI "IMAGENAME eq Lanyue.exe" → INFO: No tasks are running which match the specified criteria.
```

[EV-PENDING-004-19] 判据无放宽的删行复核（`git diff -U0 scripts/smoke-test-manual.js` 的 35 条删行，逐行归类）
```
头注释重写（1–9）          9 行
旧实现被更严实现替换（10、12–20、23–30）  18 行  ← detached/清环境/taskkill/增量状态都在这一类
旧「日志缺失 → 单条 SKIP」分支文案（21–22）  2 行  ← 被「补记 5 条 FAIL」取代
旧版四条日志断言的调用行（31–35）        5 行  ← 重新加回时多了 canAssertLogContent 门控，方向更严
合计 34 行 + 1 行空行 = 35，无一条是把「必须满足 X」改成「满足 Y 也算」
```

[EV-PENDING-004-20] 残留与工作区终态
```
$ tasklist //FI "IMAGENAME eq Lanyue.exe"      → 信息: 没有运行的任务匹配指定标准。
$ git status --porcelain
 M scripts/release-smoke-checks.cjs
 M scripts/smoke-test-manual.js
 M test/release-smoke-checks.test.js
?? docs/process/QA-ACCEPT-PENDING-004-r1-2026-10-23.md
?? docs/process/QA-ACCEPT-PENDING-004-r2-2026-10-23.md
$ git diff --numstat → 82/0、488/35、167/0（与变异前逐字一致，两轮变异零残留）
```
