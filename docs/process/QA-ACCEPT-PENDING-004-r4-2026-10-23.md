### 验收执行单 · 待分配（建议 004） · 真机冒烟脚本健壮性修复 · r4（工程通道重构 + 守卫误报修复）

- **需求 ID**：**待分配**（占位 `PENDING-004`）。台账 ID 由产品经理独占，本单不自造。
- **档位**：**L3**（命中 `DEMAND.md` §1.2 判定表 **Q1**「改了 `scripts/`」「改了 `test/`」；命中即停）。
- **需求**：真机冒烟脚本健壮性修复 —— 本轮新增 **进程表通道重构（stdout → UTF-8 文件）+ 通道自检 fail-closed + 残留判定双信号 + 盲区改为拒绝执行 + 守卫误报修复**。
- **基线 SHA**：`57404ac0d7726dc7c02c95cc825287a1e189d046`（`git rev-parse HEAD` 实值）。采集时刻 2026-10-23 09:20。
- **未提交改动**：`git status --porcelain` 共 **6 项**（验收对象），全部处于工作区、**改动未锚定**：
  ```
   M docs/RELEASING.md                    ← 文档（发版手册）
   M docs/process/QA.md                   ← 文档（运行前提小节）
   M scripts/release-smoke-checks.cjs     ← 判据纯函数
   M scripts/smoke-test-manual.js         ← 冒烟脚本
   M test/no-increment-numbering.test.js  ← 守卫（本轮修其误报）
   M test/release-smoke-checks.test.js    ← 判据单测
  ```
  `git diff --numstat`（scripts/ 与 test/）：`553/0`、`1250/118`、`693/0`、`18/0`。
  **本单全部证据只对「`57404ac` + 这 6 项改动」这一组合成立。**
- **前序**：`QA-ACCEPT-PENDING-004-r2-2026-10-23.md`（r2 定稿留痕）、`QA-ACCEPT-PENDING-004-r3-2026-10-23.md`（r3 定稿留痕，**其中 §九 EV-24 记录了本单 QA 侧自身导致的一次闸门红**）。本单在其基础上推进。
- **本轮采信的上游定性**：本单**不采信工程师自述**。工程师来函三条声明，本单**逐条独立复现**（§四）。

---

#### 一、基线漂移登记（r3 → r4 的差异清单）

r3 验收时改动集为 **3 项**（`scripts/release-smoke-checks.cjs`、`scripts/smoke-test-manual.js`、`test/release-smoke-checks.test.js`），sha256 分别为 `7ebff3e9…` / `dcb56621…` / `01aa47dd…`。本轮验收时为 **6 项**，sha256 变为 `7b9fdce1…` / `0d2d4fe0…` / `26df79a3…` / `88a17417…`。

按 `QA.md` §七 **B3**（差异落在 `scripts/`、`test/`）→ **整轮重验**，故本单为 **r4**（不是只重跑失败那条）。r3 的证据只作历史留存，**不直接复用**；本单对三种启动模式重新取证。

新增的三项差异（`docs/RELEASING.md`、`docs/process/QA.md`、`test/no-increment-numbering.test.js`）中，**前两项是文档**（按 §七 B3 例外，只重验受影响条件 = 无判据影响），**第三项是守卫本身**（影响 `npm test` 闸门，见 §三）。

---

#### 二、8 条断言逐条判定

标记：`[观]` 只读观测 ｜ `[复]` 主动复现（跑命令）｜ `[自]` 静态自证（读码 + 口径核对）。

| # | 断言名称（`check()` 字面量） | 标记 | 判定 | 判据来源（函数/行，工作区） | 证据 |
|---|---|---|---|---|---|
| 1 | 首实例启动后持续存活 6 秒 | [复] | **通过** | `processStayedAlive()`（`release-smoke-checks.cjs:17`）＋ `check(...)` @ `smoke-test-manual.js:1414` | EV-01×7、EV-04×3、EV-06、EV-07 |
| 2 | 第二实例被单实例锁快速拒绝并以 0 退出 | [复] | **通过** | `secondInstanceWasRejected()`（`:23`）＋ `check(...)` @ `:1432` / `:1434` | EV-04×3、EV-06、EV-07 |
| 3 | 进程输出无常见致命错误 | [复] | **通过** | `startupLogLooksHealthy()`（`:27`）＋ `check(...)` @ `:1445` | EV-01×7、EV-04×3、EV-07 |
| 4 | 本次启动写了日志（main.log 增量非空） | [复] | **通过** | `logIncrementalState()`（`:97`）＋ `logState === 'fresh'` @ `:1498` | EV-01×7、EV-04×3、EV-07 |
| 5 | 本机 main.log 增量无常见致命错误 | [复] | **通过** | `canAssertLogContent && startupLogLooksHealthy(incremental)` @ `:1504-1505` | EV-01×7、EV-04×3、EV-07 |
| 6 | 全局快捷键注册成功（已注册 N/M 且 N≥1） | [复] | **通过** | `shortcutsRegisteredInLog()`（`:53`）＋ `canAssertLogContent && ...` @ `:1507-1508` | EV-01×7、EV-04×3、EV-07 |
| 7 | 托盘启动无失败记录（日志无 [tray] 告警） | [复] | **通过** | `trayFailureAbsent()`（`:70`）＋ `canAssertLogContent && ...` @ `:1510-1511` | EV-01×7、EV-04×3、EV-07 |
| 8 | 主窗口渲染层已加载（增量日志出现 [main] loadFile done） | [复] | **通过（shell 模式）／真红（直启模式，环境事实）** | `rendererLoadedState()`（`:140`，时间序取最后一次）＋ `renderState === 'loaded'` @ `:1542-1545` | EV-01×7（shell）、EV-04（直启 FAIL）、EV-16/EV-17（变异） |

#### 判据未被放宽的逐项核对

**核对方法**：与 r3 的核对方法一致 —— 把工作区与基线 `57404ac` 的断言调用点与**布尔实参**逐行对齐比对（不是「读起来像没改」）。

| 核对项 | 方法 | 结果 |
|---|---|---|
| 有没有删掉断言 | 抽取两边全部 `check('…'`/`skip('…'` 字面量名，`sort -u` 后 diff | **DIFF_EMPTY=YES** —— 8 条断言名集合逐字相同（EV-18） |
| 有没有把「必须满足 X」改成「满足 Y 也算」 | 逐条比对 `check()` 的**布尔实参** | **8 条全部逐字相同**（下表，EV-19） |
| 第 8 条是否有「EXPLORER 模式即视为通过」旁路 | 抽出 `:1537-1560` 全段检索启动方式字样 | **0 命中**，该段只有 `loaded` / `failed` / else 三分支（EV-20） |
| 第 4 条 `empty`/`rotated` 是否仍不判绿 | 读 `:1498-1511` | 仍不判绿：`canAssertLogContent = logState === 'fresh'`，`empty`/`rotated` → 5 条全 FAIL |
| 分母口径 | `TOTAL_ASSERTIONS = 8` + `finish()` 记账自检 | 未变，仍是常量 8；`verifyCleanup` 仍**不进分母**（单独一行输出） |

**8 条断言布尔条件的逐条对照（基线 `57404ac` vs 工作区）**

| # | 基线布尔实参 | 工作区布尔实参 | 是否放宽 |
|---|---|---|---|
| 1 | `firstAlive` | `firstAlive` | 否 |
| 2 | `rejected` | `rejected` | 否 |
| 3 | `startupLogLooksHealthy(processLog)` | 同 | 否 |
| 4 | `logState === 'fresh'` | 同 | 否 |
| 5 | `canAssertLogContent && startupLogLooksHealthy(incremental)` | 同 | 否 |
| 6 | `canAssertLogContent && shortcutsRegisteredInLog(incremental)` | 同 | 否 |
| 7 | `canAssertLogContent && trayFailureAbsent(incremental)` | 同 | 否 |
| 8 | `renderState === 'loaded'`（`renderState = rendererLoadedState(incremental)`） | 同 | 否 |

> 本轮对 8 条断言的**改动全部落在 message 文本**（补 `${waitEvidence}` 观测证据、补 `withBlindSpotHint` 归因），**布尔实参一字未动**。

**第 8 条判定代码全文**（`scripts/smoke-test-manual.js:1537-1560`，原文粘贴）：

```js
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
```

---

#### 三、守卫误报修复（QA 侧自查发现 → 工程师侧修根因）

r3 落盘后，`npm test` 出现 1 例红（r3 §九 EV-24 已登记）：本单 r3 的证据附录**逐字转贴了脚本运行时输出**，其中的字节数紧跟「增量」之后，命中 `test/no-increment-numbering.test.js` 的编号形态。

**工程师侧的修法**（`test/no-increment-numbering.test.js` 本轮 +18 行）：守卫正则改为**两支并列** —— ①「词 + 空白? + 数字 + -X 子序号」一律违规（**优先于**单位豁免，因为字母是序号后缀不是单位）；②「词 + 空白? + 数字」仅当数字后**不是**「空白 + 单位」时才违规。**判据从「词 + 数字」细化为「词 + 数字 + 无单位」**，把「测量值」与「改动序号」在形态上分开。

**本单独立复核的新守卫边界**（不采信工程师自述，实跑 `REF.test` 逐条验证，12/12 符合预期）：
```
增量 2062 B         → 放行（测量值，带单位）
增量 1396 B（fresh） → 放行
增量 500 ms         → 放行
增量〈裸数字〉       → 违规（光秃秃数字 = 序号）
增量〈裸数字〉〔无空白〕→ 违规
增量〈数字〉-B      → 违规（子序号优先于单位豁免）
增量〈数字〉-个     → 违规
增量扫描 / 增量缓存  → 放行（合法技术用法，反向钉仍在）
```
→ **守卫没有被削弱**：裸序号与子序号仍然必红，只放行了「数字 + 单位」这一类客观读数。

**r3 验收单的 7 处证据已逐字还原**为原始输出形态（`增量 2062 B` / `增量 2330 B`），**证据的逐字性与闸门两者兼得**。r3 验收单未改守卫、未申请白名单（白名单要求指向注释/文档行，救不了代码块内的输出转贴）。

---

#### 四、工程师三条声明的独立复现

工程师来函三条声明，本单**逐条实跑复现**，不采信自述。

| # | 工程师声明 | 本单复现方式 | **实测结果** | 判定 |
|---|---|---|---|---|
| ① | 删掉 stdout 的 UTF8 声明行 → 冒烟**直接拒绝执行**（EXIT=1、无「清理: 零残留」、一条断言未跑、未拉起任何进程） | 删 `smoke-test-manual.js:555` 的 `[Console]::OutputEncoding = UTF8;` 行，跑 shell 模式 | `EXIT=1 ELAPSED=1s`；输出 `ERROR  进程表查询的通道自检失败（stdout 编码不是 UTF-8（实际 gb2312，本机控制台代码页可能是 CP936））—— 本机的控制台/进程表通道不可信，本次冒烟结论不可信，已拒绝执行`；`N/M` 汇总行 **0** 次、断言行 **0** 次、`清理:` 行 **0** 次 | **成立**（EV-16） |
| ② | 把进程表文件按 CP936 写出 → 脚本如实报「清理后仍有残留进程」而非「零残留」 | 把 `WriteAllText` 的编码从 `UTF8Encoding($false)` 改为 `GetEncoding(936)`，跑 shell 模式 | `EXIT=1`；`FAIL  清理后仍有残留进程 ｜ 清理: 残留 4 个（pid 25672, 32296, 33120, 14744，其中含 --type= 子进程）`；`tasklist` 实测**恰有 4 个** `Lanyue.exe` 存活 —— **脚本报的数与事实一致，旧假绿已消除** | **成立**（EV-17） |
| ③ | `pathDataLooksUsable` 若只看 basename 会漏判（CP936 只坏非 ASCII 字符，exe 名原样幸存） | 构造用例：真值 vs 工程师提供的本机真实污染串 | 真值 basename `lanyue.exe` **==** 污染串 basename `lanyue.exe` → **只看 basename 确实漏判**（工程师说法成立）；`pathDataLooksUsable(污染串)` = **false**（识破）、`pathDataLooksUsable(干净串)` = **true**（放行）、`pathDataLooksUsable(路径不可读)` = **true**（交盲区判据） | **成立**（EV-21） |

**残留判定双信号的独立复核**（纯函数层，构造用例）：

| 场景 | 输入 | 实测 | 期望 | 判定 |
|---|---|---|---|---|
| 路径全被写坏 | 污染路径 + 创建时间在启动后 | 捞出 pid `[15876, 34600]`（含 `--type=renderer` 子进程） | 非空（旧实现此处为空数组 = 假绿） | 通过 |
| 干净路径残留（信号 A 未被破坏） | 目标路径 + 启动后创建 | 捞出 pid `[900]` | 非空 | 通过 |
| 启动前就存在的进程（信号 B 不得过宽） | 污染路径 + 启动前 60s 创建 | 残留数 **0** | 0 | 通过 |
| 同上但路径干净（信号 A 仍生效） | 目标路径 + 启动前 60s 创建 | 残留数 **1** | 1 | 通过 |
| 启动后创建但已在启动前快照内 | 目标路径 + pid 在快照 | 残留数 **0** | 0 | 通过 |

**两处变异均已还原**：每处还原后 `grep -c "QA-MUTATION"` = **0**，四个文件 sha256 与变异前**逐行一致**（`SHA_IDENTICAL=YES`），且**还原后重跑回到 8/8 exit 0、零残留**。

---

#### 三种启动模式的本轮结论（第九项，单列）

| 启动模式 | 开关 | 第 8 条 | 本轮实测 | 证据 |
|---|---|---|---|---|
| **explorer 代理（裸启动）** | `SMOKE_LAUNCH_VIA_SHELL=1` | 可绿 | **8/8 exit 0**，本轮共 **7 次**：1 次专项 + 5 次连跑 + 1 次变异还原后复跑，**6 次 8/8 + 1 次抖动 7/8（unknown 形态，详见 §六 边界 5）**。`loadFile done` 稳定在启动后 **10.8~12.0s** | EV-01 |
| **直启 + 旗标** | 默认 | 恒红 | **7/8 exit 1**，连跑 3 次**全部** 7/8，第 8 条 FAIL 含 `ERR_FAILED (-2)`；第二条断言 3/3 PASS；清理 3/3 **零残留** | EV-04 |
| **直启裸启动** | `SMOKE_BARE_LAUNCH=1` | 恒红 | 本轮**仍未单独取证**，登记为未验证项，不签 | — |
| **前置条件（PRECOND）** | 无开关 | — | 本机已有同路径实例 → `PRECOND 检测到本机已有同一路径的实例在运行（pid 23472）…` **EXIT=1**，`N/M` 汇总行 **0** 次、断言行 **0** 次、`清理:` 行 **0** 次 | EV-06 |
| **盲区（路径不可读）** | 无开关 | — | **本轮语义已变**：由 r3 的「只 WARN 不阻断」改为「**WARN + 拒绝执行**」。本机实测触发一次（`PRECOND 无法确认本机是否已有已存在实例（1 个 Lanyue.exe 的路径读不到）…已拒绝执行`，EXIT=1、零断言、零 N/M 汇总）。**见 §六 边界 2 与 §八 遗留 1** | EV-07、EV-22 |
| **零残留（收尾）** | 无开关 | — | 直启 3/3 **零残留**；shell 模式 6/7 **零残留**、1 次为「残留 4 个」（变异 B 态，路径被写坏时如实报出，与实际进程数一致） | EV-04、EV-17 |

---

#### 五、闸门摘要

| 闸门 | 命令 | 退出码 | 保留行（≤5 行） | 完整日志 |
|---|---|---|---|---|
| 全量单测 | `npm test` | **0** | `# tests 3500` / `# pass 3500` / `# fail 0` / `# cancelled 0` / `# skipped 0` / `# duration_ms 78118.3815` | `/tmp/qa-r3/npm-test-r4.log` |
| Lint | `npm run lint` | **0** | `✖ 6 problems (0 errors, 6 warnings)` | `/tmp/qa-r3/lint-r4.log` |
| 判据单测 | `node --test test/release-smoke-checks.test.js` | **0** | `# tests 55` / `# pass 55` / `# fail 0` / `# cancelled 0` / `# skipped 0` | — |
| 守卫单测 | `node --test test/no-increment-numbering.test.js` | **0** | `# tests 7` / `# pass 7` / `# fail 0` | — |
| 文档守卫 | `node --test test/process-docs.test.js` | **0** | `# tests 10` / `# pass 10` / `# fail 0` | — |
| 冒烟（shell ×7） | `SMOKE_LAUNCH_VIA_SHELL=1 node scripts/smoke-test-manual.js …` | 0×6 / 1×1 | 6 次 `8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.8~12.0s）`；1 次 `7/8 … 渲染层: 无记录（既无 done 也无 failed）` | `/tmp/qa-r3/r4-*.log` |
| 冒烟（直启 ×3） | `node scripts/smoke-test-manual.js …` | **1 / 1 / 1** | 3 次均 `7/8 通过 ｜ 渲染层: 未加载（loadFile failed）` | `/tmp/qa-r3/r4-direct-1..3.log` |
| 冒烟（PRECOND） | 有实例时 | **1** | `PRECOND 检测到本机已有同一路径的实例在运行（pid 23472）…`（**无 N/M 汇总**） | `/tmp/qa-r3/r4-precond.log` |
| 冒烟（变异 ①） | 删 UTF8 声明行 | **1** | `ERROR  进程表查询的通道自检失败（stdout 编码不是 UTF-8（实际 gb2312…））—— …已拒绝执行` | `/tmp/qa-r3/r4-mut-utf8.log` |
| 冒烟（变异 ②） | 进程表按 CP936 写出 | **1** | `FAIL  清理后仍有残留进程 ｜ 清理: 残留 4 个（pid 25672, 32296, 33120, 14744…）` | `/tmp/qa-r3/r4-mut-cp936.log` |
| 人工冒烟（7 项） | 手动 | — | **0/7 项执行** | — |

**零残留（跑完立即查）**：直启 3/3 = 0 个；shell 6/7 = 0 个（变异态 1 次为 4 个，且脚本报出的数与实际一致）。

---

#### 六、边界（本单**没有**签到的部分，禁止在下游被读成已签）

1. **7 项人工冒烟仍 0/7 执行**（安装 / 启动窗口可见 / 搜索 / 入队 / 下载 / 播放 / 更新检查）。「用户视角可用」这一层**完全空白**。
2. **盲区语义本轮由「只 WARN 不阻断」改为「WARN + 拒绝执行」** —— 这是**行为变更**，方向是 fail-closed（更严），且有单测守卫（`test/release-smoke-checks.test.js:880`）。但它带来一个**新的操作性后果**：本机只要存在**任何一个**路径读不到的 `Lanyue.exe`（哪怕是别的安装包、别的权限层级），冒烟就**整轮跑不了**。本轮实测触发了 1 次（EV-22）。**该后果本单如实登记，不签「盲区链路在真机上可靠」**。
3. **shell 模式仅 Windows 可用**（`resolveLaunchStrategy()` 在非 Windows 平台硬报错 exit 1，不静默降级）。
4. **盲区（`ExecutablePath` 不可读）的真机触发，本轮只观测到 1 次，且触发条件是「上一轮实例的子进程尚在退出中」**（见 §八 遗留 1），**并非**构造出的权限不足场景。纯函数层已用构造用例证明（EV-21），真机权限不足场景仍未验。
5. **shell 模式存在低频抖动**：本轮 7 次中 1 次落 `unknown`（第 8 条 FAIL，**方向安全 —— 判红不判绿**）。该形态是 r2 已记录的形态（「工程师自述 4 次中 1 次出现 6/8，渲染层判 unknown」），r2 本轮未复现，**r4 复现 1 次**。它只在「上一轮实例的子进程尚未退净」时出现（该次增量只有 732 B，正常是 1396 B）→ **成因是测试环境被上一轮污染，不是判据缺陷**。**方向安全：unknown 与 failed 都判 FAIL，绝不会产生假绿。**
6. **直启模式在本环境第 8 条恒红，这是环境事实不是缺陷，但不得因此把直启模式标为可用**。**直启模式的「可用」结论本单不签。**
7. **「直启裸启动」（`SMOKE_BARE_LAUNCH=1`）本轮仍未取证**，登记为未验证项。
8. **本单不签「产品可发布」**。见 §七。

---

#### 七、结论

**判定：有条件通过。**

- **签的是这一层**：`scripts/smoke-test-manual.js` + `scripts/release-smoke-checks.cjs` 的**脚本健壮性与判据完整性**，本轮新增部分一并签掉四件事：
  1. **进程表通道从 stdout 文本改为 UTF-8 文件通道** —— 路径数据不再受控制台代码页污染。变异 ② 实测：按 CP936 写出时脚本如实报「清理: 残留 4 个」且与实际进程数一致，**r3 记录的那个「脚本报零残留、实际残留 4 个进程」的假绿已被根除**；
  2. **通道自检 fail-closed** —— 变异 ① 实测：删掉 UTF8 声明行后冒烟**直接拒绝执行**（EXIT=1、零断言、零 N/M 汇总、未拉起任何进程），「这台机器的文本通道不可信」被如实报出，而不是继续出一张不可信的绿单；
  3. **残留判定改为「路径信号 ∪ 创建时间信号」** —— 路径整体被写坏时，独立的 ASCII 安全的创建时间信号仍能把残留捞出来（EV-21 构造用例 5/5 符合预期，含两条防过宽的反向用例）；
  4. **8 条判据一字未动** —— 与基线逐行对齐，布尔实参 8 条全部逐字相同，无删无增（EV-18、EV-19、EV-20）。
  5. 闸门：`npm test` **3500/3500 全绿**、lint **0 error**、判据单测 **55/55**、守卫单测 **7/7**、文档守卫 **10/10**；两处变异均已还原且 sha256 与 `git diff --stat` 与变异前逐字一致。
- **没签的是这一层**：**「产品可发布」**。7 项人工冒烟 0/7（边界 1）；盲区改为拒绝执行带来新的操作性阻塞且真机权限场景未验（边界 2、4）；shell 模式仅 Windows（边界 3）；shell 模式有低频 `unknown` 抖动（边界 5）；直启模式恒红（边界 6）；直启裸启动未取证（边界 7）。**这六条任一未了结，本需求都不得进 `已发布`。**
- **把本条需求置 `已签收` 的条件**（六条全满足）：
  1. 在**真实桌面会话**用 `SMOKE_LAUNCH_VIA_SHELL=1` 裸跑一次，得 `8/8 通过 … 渲染层: 已加载（loadFile done）`；
  2. `SMOKE_BARE_LAUNCH=1` 直启裸跑一次并留痕；
  3. 7 项人工冒烟逐项执行并留痕（`QA.md` §四）；
  4. 盲区**拒绝执行**的触发条件在真实权限不足环境下复现一次，并确认提示文案准确；
  5. 连续 3 次 shell 模式跑**无 `unknown` 抖动**（当前 7 次 1 次，样本不足以判稳）；
  6. 把本轮 6 项未提交改动**提交并锚定 commit**。
- **交回工程师的**：**无实现错、无条件错**。有一条**待裁决的口径变更**（盲区语义）与若干观察项（§八），**不打回**。

---

#### 八、遗留清单

1. **盲区拒绝执行的阻塞面过宽（本轮新发现）**：只要本机存在**任何一个**路径读不到的 `Lanyue.exe`（哪怕不是本包、哪怕是别的权限层级），冒烟就整轮跑不了。r3 的设计是「只 WARN 不阻断」，理由是「阻断会把『机器上恰好有个高权限同名进程』这种正常场景永久堵死」——**该理由在本轮仍然成立**。本轮实现把 WARN 升级为拒绝执行，方向是 fail-closed，但**代价是正常场景被永久堵死**。建议工程师把拒绝条件收窄为「盲区进程**可能就是本包实例**」时才拒绝（例如按 basename + 创建时间 + 已知安装路径集合交叉判断），而不是「有盲区就拒绝」。**这是口径变更，非缺陷，不打回；请交付总监裁决该口径是否接受。**
2. **shell 模式 `unknown` 抖动复现 1 次**（本轮 7 次 1 次，r2 记录过同形态）。成因是上一轮实例的子进程未退净（增量 732 B vs 正常 1396 B）。**方向安全（判红不判绿）**，但需 3 次连续无抖动才能定性（§七 条件 5）。责任：QA（复测）。
3. **7 项人工冒烟 0/7**：发版前必做。责任：QA + 交付总监。
4. **「直启裸启动」模式未取证**。责任：QA（下一轮补）。
5. **盲区真机权限不足场景未验**（本轮只观测到「子进程未退净」这一种触发）。责任：QA + 工程师。
6. **基线仍未锚定**：6 项未提交改动，且 `docs/RELEASING.md`、`docs/process/QA.md` 两项文档在本轮/上轮验收期间被改动（后者于 r3 验收期间 16:16 改动）。文档改动按 §七 B3 例外不影响判据，但**基线铁律要求「porcelain 逐行完全一致」，本轮已连续两轮不满足**。责任：交付总监。
7. **「启动方式标签由实参生成」**（r2 起遗留，本轮仍未处理）：当前三种模式的标签与实参一致，不影响结论。责任：工程师（下轮顺带）。

---

#### 九、证据附录

[EV-PENDING-004-01] shell 模式（explorer 代理）本轮 7 次（`/tmp/qa-r3/r4-shell-1.log`、`r4-flake-1..5.log`、`r4-after-mutB.log`）
```
RUN 1 EXIT=0 ELAPSED=14s  8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.8s）
RUN 2 EXIT=0 ELAPSED=15s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，10.8s）
RUN 3 EXIT=0 ELAPSED=17s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，11.1s）
RUN 4 EXIT=0 ELAPSED=17s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，11.4s）
RUN 5 EXIT=0 ELAPSED=17s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，12.0s）
RUN 6 EXIT=0 ELAPSED=14s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，10.9s）
RUN 7 EXIT=0 ELAPSED=14s  8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，11.6s）
（另有 1 次抖动，计入 §六 边界 5）
```
RUN 1 完整输出：
```
ENV   启动方式: explorer 代理 ｜ 附加旗标: 无（等同用户双击） ｜ 渲染层: 可验证
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
PASS  首实例启动后持续存活 6 秒 — explorer 代理 ｜ 发现主进程 pid=29008 ｜ 6 秒后进程表仍存在
PASS  第二实例被单实例锁快速拒绝并以 0 退出 — exit=0 timedOut=false ｜ 验证口径: 第二实例经直启验证（explorer 不返回退出码，单实例锁由 userData 决定，与启动方式无关）
PASS  进程输出无常见致命错误 — explorer 代理无法采集首实例 stdout/stderr（本次仅覆盖第二实例输出；首实例的日志健康见「main.log 增量无常见致命错误」）
WAIT  渲染层判据轮询: 每 400ms 一次 ｜ 下限 1500ms（等日志 flush） ｜ 上限 30000ms（自启动时刻算）
WAIT  轮询#1 启动后 10.9s ｜ 增量 1396 B（fresh） ｜ 判定 loaded → 结论明确，停止等待
PASS  本次启动写了日志（main.log 增量非空） — 1396 B 新增
PASS  本机 main.log 增量无常见致命错误 — AppData\Roaming\music-downloader\logs\main.log
PASS  全局快捷键注册成功（已注册 N/M 且 N≥1）
PASS  托盘启动无失败记录（日志无 [tray] 告警）
PASS  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 增量日志出现 [main] loadFile done（启动后 10.9s / 轮询 1 次）
清理: 零残留

8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.9s）
```

[EV-PENDING-004-04] 直启模式本轮 3 次（`/tmp/qa-r3/r4-direct-1..3.log`）—— 判据未放宽
```
ENV   启动方式: 直启 spawn(detached) ｜ 附加旗标: --disable-gpu-sandbox ｜ 渲染层: 受限环境下必然失败（改用 SMOKE_LAUNCH_VIA_SHELL=1）
PASS  首实例启动后持续存活 6 秒 — exit=null signal=null
PASS  第二实例被单实例锁快速拒绝并以 0 退出 — exit=0 timedOut=false
PASS  进程输出无常见致命错误
WAIT  轮询#1 启动后 10.1s ｜ 增量 2330 B（fresh） ｜ 判定 failed → 结论明确，停止等待
PASS  本次启动写了日志（main.log 增量非空） — 2330 B 新增
PASS  本机 main.log 增量无常见致命错误 — AppData\Roaming\music-downloader\logs\main.log
PASS  全局快捷键注册成功（已注册 N/M 且 N≥1）
PASS  托盘启动无失败记录（日志无 [tray] 告警）
FAIL  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — [main] loadFile failed: Error: ERR_FAILED (-2) loading 'file:///F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\resources\app.asar\dist\renderer\index.html'（启动后 10.1s / 轮询 1 次） —— 渲染层未加载 = 用户白屏；若同时有 GPU/沙箱相关错误，先按环境错处理并改用真实桌面会话复测（受限环境可直接用 SMOKE_LAUNCH_VIA_SHELL=1）
清理: 零残留

7/8 通过 ｜ 启动方式: 直启 + --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 未加载（loadFile failed）
EXIT=1
（3 次均如此；跑完 tasklist 均为 0 个）
```

[EV-PENDING-004-06] PRECOND 拒绝路径（`/tmp/qa-r3/r4-precond.log`）
```
ENV   启动方式: 直启 spawn(detached) ｜ 附加旗标: --disable-gpu-sandbox ｜ 渲染层: 受限环境下必然失败（改用 SMOKE_LAUNCH_VIA_SHELL=1）
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
PRECOND 检测到本机已有同一路径的实例在运行（pid 23472）。冒烟会因单实例锁被判红，但那不是产品故障。请先完全退出该实例（含托盘）后再跑。
EXIT=1

--- 校验（必须均为 0）---
$ grep -cE "^[0-9]+/8 通过" /tmp/qa-r3/r4-precond.log   → 0
$ grep -cE "^(PASS|FAIL|SKIP) " /tmp/qa-r3/r4-precond.log → 0
$ grep -c "^清理:" /tmp/qa-r3/r4-precond.log               → 0
```

[EV-PENDING-004-16] 变异 ① 删掉 UTF8 声明行（`/tmp/qa-r3/r4-mut-utf8.log`）
```
$ grep -n "QA-MUTATION-R4" scripts/smoke-test-manual.js
555:    // QA-MUTATION-R4: 故意删掉 UTF8 编码声明行

ENV   启动方式: explorer 代理 ｜ 附加旗标: 无（等同用户双击） ｜ 渲染层: 可验证
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
ERROR  进程表查询的通道自检失败（stdout 编码不是 UTF-8（实际 gb2312，本机控制台代码页可能是 CP936））—— 本机的控制台/进程表通道不可信，本次冒烟结论不可信，已拒绝执行
EXIT=1 ELAPSED=1s
```
还原证明：`grep -c "QA-MUTATION" = 0`；四文件 sha256 与变异前逐行一致（`SHA_IDENTICAL=YES`）；还原后重跑 `EXIT=0` ／ `8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，10.9s）` ／ `清理: 零残留`。

[EV-PENDING-004-17] 变异 ② 进程表按 CP936 写出（`/tmp/qa-r3/r4-mut-cp936.log`）
```
$ grep -n "QA-MUTATION-R4B" scripts/smoke-test-manual.js
564:    // QA-MUTATION-R4B: 故意按控制台代码页 936 写出，模拟路径数据被写坏

ENV   启动方式: explorer 代理 ｜ 附加旗标: 无（等同用户双击） ｜ 渲染层: 可验证
FAIL  首实例启动后持续存活 6 秒 — explorer 代理启动后 10 秒内未发现新的主进程 —— 可能被安全软件拦截或 exe 路径含特殊字符
FAIL  第二实例被单实例锁快速拒绝并以 0 退出 — 首实例未存活，无法验证
PASS  进程输出无常见致命错误 — explorer 代理无法采集首实例 stdout/stderr（本次仅覆盖第二实例输出；…）
WAIT  轮询#1 启动后 9.7s ｜ 增量 2062 B（fresh） ｜ 判定 loaded → 结论明确，停止等待
PASS  本次启动写了日志（main.log 增量非空） — 2062 B 新增
PASS  本机 main.log 增量无常见致命错误 — AppData\Roaming\music-downloader\logs\main.log
PASS  全局快捷键注册成功（已注册 N/M 且 N≥1）
PASS  托盘启动无失败记录（日志无 [tray] 告警）
PASS  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 增量日志出现 [main] loadFile done（启动后 9.7s / 轮询 1 次）
FAIL  清理后仍有残留进程 ｜ 清理: 残留 4 个（pid 25672, 32296, 33120, 14744，其中含 --type= 子进程） —— 残留会占住 userData 锁，让下一次冒烟的第二实例断言失效

6/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，9.7s）
EXIT=1 ELAPSED=12s

--- 实际残留进程数（tasklist）---
4        ← 与脚本报出的 4 个一致
```
还原证明：`grep -c "QA-MUTATION" = 0`；sha256 与变异前逐行一致（`SHA_IDENTICAL=YES`）；还原后重跑 `EXIT=0` ／ `8/8 通过 ｜ … ｜ 渲染层: 已加载（loadFile done，11.6s）` ／ `清理: 零残留`。

[EV-PENDING-004-18] 断言名集合无删减（基线 vs 工作区）
```
$ git show HEAD:scripts/smoke-test-manual.js | grep -oE "(check|skip)\('[^']*'" | sed -E "s/^(check|skip)\('//" | sort -u > n-head.txt
$ grep -oE "(check|skip)\('[^']*'" scripts/smoke-test-manual.js | sed -E "s/^(check|skip)\('//" | sort -u > n-work.txt
$ diff n-head.txt n-work.txt
DIFF_EMPTY=YES
```

[EV-PENDING-004-19] 8 条断言布尔实参对照（基线 vs 工作区）
```
# 1  firstAlive                                  → firstAlive                                  否
# 2  rejected                                    → rejected                                    否
# 3  startupLogLooksHealthy(processLog)          → startupLogLooksHealthy(processLog)          否
# 4  logState === 'fresh'                        → logState === 'fresh'                        否
# 5  canAssertLogContent && startupLogLooksHealthy(incremental)   → 同                否
# 6  canAssertLogContent && shortcutsRegisteredInLog(incremental) → 同                否
# 7  canAssertLogContent && trayFailureAbsent(incremental)        → 同                否
# 8  renderState === 'loaded'（renderState = rendererLoadedState(incremental)）→ 同    否
```

[EV-PENDING-004-20] 渲染层判定分支无启动方式旁路
```
$ awk '/const renderState = rendererLoadedState/,/await shutdownInstance\(second\)/' scripts/smoke-test-manual.js | grep -nE "VIA_SHELL|launchStrategy|loaded|failed"
→ 该段只有 loaded / failed / else 三条路；启动方式字样 0 命中
```

[EV-PENDING-004-21] 路径污染与残留双信号的纯函数复核（构造用例）
```
=== ③ basename 洞 ===
  真值 basename      : "lanyue.exe"
  污染串 basename    : "lanyue.exe"
  basename 是否相同  : true        → 只看 basename 确实漏判（工程师说法成立）
=== ③ pathDataLooksUsable ===
  污染串判定 (期望 false=不可信): false
  干净串判定 (期望 true=可信)  : true
  路径不可读 (期望 true=放行)  : true
=== ② 残留判定（信号 B 兜底）===
  路径全污染时靠创建时间捞出的残留 pid: [ 15876, 34600 ]   （旧实现此处为空数组 = 假绿）
=== ② 回归 ===
  干净路径残留 pid: [ 900 ]
  路径污染 + 启动前 60s 创建 → 残留数: 0   （信号 B 不得过宽）
  路径干净 + 启动前 60s 创建 → 残留数: 1   （信号 A 仍生效）
  启动后创建但在快照内 → 残留数: 0          （pid 差集须生效）
```

[EV-PENDING-004-22] 盲区拒绝执行路径（本轮实测触发 1 次，`/tmp/qa-r3/r4-skip.log`）
```
ENV   启动方式: 直启 spawn(detached) ｜ 附加旗标: --disable-gpu-sandbox ｜ 渲染层: 受限环境下必然失败（改用 SMOKE_LAUNCH_VIA_SHELL=1）
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
WARN  检测到 1 个 Lanyue.exe 无法读取路径（权限不足），前置检查存在盲区：若其中之一正是本包实例，本次结果可能被单实例锁干扰
PRECOND 无法确认本机是否已有已存在实例（1 个 Lanyue.exe 的路径读不到）—— 无法排除用户的实例被当成本次启的那个（可能误杀用户窗口），本次冒烟结论不可信，已拒绝执行
EXIT=1
```
（触发时的背景：上一轮 shell 跑刚结束，其 `--type=` 子进程尚在退出中；见 §六 边界 5 与 §八 遗留 1。）

[EV-PENDING-004-23] 全量闸门与工作区终态
```
$ npm test        → TEST_EXIT=0
# tests 3500 / # pass 3500 / # fail 0 / # cancelled 0 / # skipped 0 / # duration_ms 78118.3815

$ npm run lint    → LINT_EXIT=0
✖ 6 problems (0 errors, 6 warnings)

$ node --test test/release-smoke-checks.test.js → # tests 55 / # pass 55 / # fail 0
$ node --test test/no-increment-numbering.test.js → # tests 7 / # pass 7 / # fail 0
$ node --test test/process-docs.test.js → # tests 10 / # pass 10 / # fail 0

$ git status --porcelain
 M docs/RELEASING.md
 M docs/process/QA.md
 M scripts/release-smoke-checks.cjs
 M scripts/smoke-test-manual.js
 M test/no-increment-numbering.test.js
 M test/release-smoke-checks.test.js
?? docs/process/QA-ACCEPT-PENDING-004-r3-2026-10-23.md
?? docs/process/QA-ACCEPT-PENDING-004-r4-2026-10-23.md

$ sha256sum scripts/smoke-test-manual.js scripts/release-smoke-checks.cjs test/release-smoke-checks.test.js test/no-increment-numbering.test.js
0d2d4fe02805a6fedaa327917f9a980fd1df53774913f99386139e52344f5ae6 *scripts/smoke-test-manual.js
7b9fdce1bd2cf997127f0b87297be0260892785b3ee342e3c31315c2da6d765e *scripts/release-smoke-checks.cjs
26df79a34a827ae9d4f6f9dd1942fb937fd2d3570407c213ddcb983a96f6c283 *test/release-smoke-checks.test.js
88a17417c760e159cb75ee3a7e5bf5288c6ddb4dc83b54e5cc550341834b2e63 *test/no-increment-numbering.test.js
（与两处变异前完全一致 ⇒ 变异零残留）

$ tasklist //FI "IMAGENAME eq Lanyue.exe" → 信息: 没有运行的任务匹配指定标准。
```
