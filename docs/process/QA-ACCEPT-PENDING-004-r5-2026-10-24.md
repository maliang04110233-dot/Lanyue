### 验收执行单 · 待分配（建议 004） · 真机冒烟脚本健壮性修复 · r5（r4 后工程侧收口修改 → 整轮重验）

- **需求 ID**：**待分配**（占位 `PENDING-004`）。台账 ID 由产品经理独占，本单不自造。
- **档位**：**L3**（同 r4：命中 `DEMAND.md` §1.2 判定表 **Q1**「改了 `scripts/`」，命中即停）。
- **需求**：真机冒烟脚本健壮性修复。本单性质：r4 落盘后工程侧做了 7 处收口修改（详见 §二），差异落在 `scripts/` → 按 `QA.md` §七 **B3** 整轮重验，出执行单 r5。
- **基线 SHA**：`57404ac0d7726dc7c02c95cc825287a1e189d046`（`git rev-parse HEAD` 实值，与 r4 相同——本轮无新提交）。
- **未提交改动**：`git status --porcelain` 时点快照（本单落笔时）：6 项 M + 2 项未跟踪（r3/r4 两份旧执行单）+ 本执行单 + 台账编辑。与 r4 验收时相比，改动集**内容**有变（见 §二），**项数口径**不变。
- **前序**：`QA-ACCEPT-PENDING-004-r2-2026-10-23.md`（QA 逐条判定）、`r3`（守卫误报修复）、`r4`（通道重构 + 守卫收口）。r2~r4 的证据只作历史留存，本单全部重新取证。
- **本单全部证据只对「`57404ac` + 本单 §二登记的改动集」这一组合成立。**

---

#### 一、r5 轮次的来历（QA 审查 → 工程师收口）

r4 落盘后，QA 对工作区做了一轮独立代码审查，发现三条问题；工程师随后修复，构成 r4 → r5 的全部工程侧差异：

1. **文档与实现口径相反（P2，两处）**：r4 已把盲区语义改为「WARN + 拒绝执行」（`smoke-test-manual.js:1358` 起，EV-22 实测），但 `docs/process/QA.md`「已知边界」一条与 `smoke-test-manual.js` 头注释 51~56 行仍写旧口径「只 WARN 不阻断」——发版人按文档理解会把「拒绝执行」误判成脚本异常。两处均已改为与实现一致。
2. **`withBlindSpotHint` 已不可达但注释按活跃逻辑描述（P3）**：盲区命中时前置检查在任何断言之前就 `exit 1`，走到 `check()` 时 `unreadablePathCount` 恒为 0，该函数及其两处调用形态永不产生非空归因。处置：**保留为纵深防御**（若将来前置口径放宽，归因自动生效），docstring 与三处调用点注释已写明「当前不可达、保留理由」；静态守卫要求的调用形态原样未动。
3. **shell 模式存活断言把「查询失败」说成「已消失」（P3）**：`pidState` 自身注释明确「unknown ≠ gone」，但 `firstAliveDetail` 在进程表查询失败时仍输出「6 秒内已从进程表消失（启动即退出）」，会把排查引向错误方向。处置：三态原样挂到 `record.pidState`，`unknown` 时单独输出「6 秒复查时进程表查询失败，无法确认存活（查询失败 ≠ 已退出，按 fail-closed 判红）」；**判定向不变**（unknown 仍判红）。

---

#### 二、基线漂移登记（r4 → r5 差异清单）

r4 登记了 4 个文件哈希（r4 §九）。本轮实测比对：

| 文件 | r4 登记值 | 本轮实测值 | 判定 |
|---|---|---|---|
| `scripts/release-smoke-checks.cjs` | `7b9fdce1…` | `7b9fdce1bd2cf997127f0b87297be0260892785b3ee342e3c31315c2da6d765e` | **逐字未动** |
| `test/release-smoke-checks.test.js` | `26df79a3…` | `26df79a34a827ae9d4f6f9dd1942fb937fd2d3570407c213ddcb983a96f6c283` | **逐字未动** |
| `test/no-increment-numbering.test.js` | `88a17417…` | `88a17417c760e159cb75ee3a7e5bf5288c6ddb4dc83b54e5cc550341834b2e63` | **逐字未动** |
| `scripts/smoke-test-manual.js` | `0d2d4fe0…` | `bfbc5a8fad458719414bb65628d0bd1bdd4c816e12a1c13b7e27cbf095b61703` | **变化**（§一的 7 处修改所致） |

另：`docs/process/QA.md` 亦有改动（r4 未登记其哈希，现值 `75cb573a…`）；`docs/RELEASING.md` 无新改动。

工程侧 7 处修改的构成：**6 处纯注释/文档**（§一.1 的两处、§一.2 的一处、§一.2 派生的 main() 两处调用点注释、`failLogDependentAssertions` 一处）+ **1 处输出文案**（§一.3，仅影响 shell 模式第 1 条 FAIL 且查询失败这一罕见路径的 message；新增 `record.pidState` 字段为纯记录，不参与任何判定）。

按 `QA.md` §七 B3（差异落在 `scripts/`）→ **整轮重验**，不引用 r4 证据。

---

#### 三、判据未放宽复核（[自]）

**方法**：注释感知的词法剥离（字符串感知，避免 `file:///` 串干扰）后，抽取 `check(`/`skip(` 调用的「断言名 + 前两个实参（布尔实参层）」，基线 `57404ac` vs 工作区，逐字比对。工具与本单同目录留档（`/tmp/qa-r5/extract-assertions.js`、`boolean-diff.log`）。

**实测**：两侧各 **18** 处调用，**DIFF_EMPTY=YES**——断言名与布尔实参逐字一致，无删无增无放宽。工作区全量清单（18 行）：

```
check('首实例启动后持续存活 6 秒', firstAlive)
check('第二实例被单实例锁快速拒绝并以 0 退出', rejected)
check('第二实例被单实例锁快速拒绝并以 0 退出', false)
check('进程输出无常见致命错误', startupLogLooksHealthy(processLog))
check('本次启动写了日志（main.log 增量非空）', logState === 'fresh')
check('本机 main.log 增量无常见致命错误', canAssertLogContent && startupLogLooksHealthy(incremental))
check('全局快捷键注册成功（已注册 N/M 且 N≥1）', canAssertLogContent && shortcutsRegisteredInLog(incremental))
check('托盘启动无失败记录（日志无 [tray] 告警）', canAssertLogContent && trayFailureAbsent(incremental))
skip(RENDER_CHECK_NAME, RENDER_SKIP_NOTE)
check(RENDER_CHECK_NAME, false)   ← !canAssertLogContent 分支
check(RENDER_CHECK_NAME, true)    ← loaded 分支
check(RENDER_CHECK_NAME, false)   ← failed 分支
check(RENDER_CHECK_NAME, false)   ← unknown 分支
check('本次启动写了日志（main.log 增量非空）', false)   ← 日志缺失路径补记 ×5
check('本机 main.log 增量无常见致命错误', false)
check('全局快捷键注册成功（已注册 N/M 且 N≥1）', false)
check('托盘启动无失败记录（日志无 [tray] 告警）', false)
check(RENDER_CHECK_NAME, false)
```

与 r4 EV-18/19（基线布尔实参 8 条逐字相同）结论一致，且覆盖了 §二 7 处修改之后的状态。message 文案的变化（`waitEvidence`、`withBlindSpotHint`、三态措辞）不进布尔层，不影响判定。

---

#### 四、闸门摘要（[复]）

| 闸门 | 命令 | 退出码 | 保留行 |
|---|---|---|---|
| 全量单测 | `npm test` | **0** | `# tests 3500` / `# pass 3500` / `# fail 0` / `# skipped 0` |
| Lint | `npm run lint` | **0** | `✖ 6 problems (0 errors, 6 warnings)`（warning 全为既有） |
| 判据单测 | `node --test test/release-smoke-checks.test.js` | **0** | 55 / 55 / 0 |
| 守卫单测 | `node --test test/no-increment-numbering.test.js` | **0** | 7 / 7 / 0 |
| 文档守卫 | `node --test test/process-docs.test.js` | **0** | 10 / 10 / 0 |

日志：`/tmp/qa-r5/{npm-test,lint,criteria-test,guard-test,docs-guard-test}.log`。

---

#### 五、真机取证（[复]，本单核心）

产物：`.preview/release-smoke-ui/win-unpacked/Lanyue.exe`（246324736 B，2026-10-23 13:45 打包，**与 r4 同一产物**）。开跑前 `tasklist` 零匹配；全部跑完后复查仍零匹配。

**shell 模式（explorer 代理）连跑 6 次**：

| RUN | 退出码 | 结果 | 失败断言 | 增量字节 |
|---|---|---|---|---|
| 1 | 1 | 6/8 | 第 2 条 + 第 8 条（unknown，等满 30s） | 1349 B |
| 2 | 0 | **8/8** | — | 2062 B |
| 3 | 1 | 7/8 | 第 2 条（exit=null timedOut=true） | 2679 B |
| 4 | 1 | 6/8 | 第 2 条 + 第 8 条（unknown） | 1861 B |
| 5 | 1 | 7/8 | 第 8 条（unknown，增量 732 B——与 r4 抖动签名同值） | 732 B |
| 6 | 0 | **8/8** | — | 2062 B |

**直启默认 ×1**：`8/8` exit 0（`loadFile done` 10.1s）。
**直启裸启动 ×1**（`SMOKE_BARE_LAUNCH=1`，补 r4 遗留 4）：`7/8` exit 1——第 1/2/3/4/5/6/7 条全 PASS（**首实例存活 6 秒、第二实例 exit=0**），仅第 8 条 unknown（30s 无 done/failed）。
**变异 ①**（删 UTF8 声明行，shell 模式）：`EXIT=1`，拒绝执行（原文见 §七）；还原后 `grep -c QA-MUTATION` = 0，sha256 回到 `bfbc5a8f…` 与登记值一致。
**变异 ② 未复跑**：被变异行（`WriteAllText` 编码）与 r4 验证时逐字一致，本轮 7 处修改与其零交集；r4 EV-17 结论按历史留存继续引用，本单**不记作已复验**。

**两条 r4 环境结论在本轮过期（重要方法论发现）**：

1. r4「直启模式在本环境第 8 条恒红」→ 本轮直启默认 1 次得 **8/8**（渲染层真加载）。
2. r4 引用的「裸直启 5~6 秒必死 0x80000003」→ 本轮裸启动首实例**存活 6 秒**、进程层 7 条全 PASS。

脚本与判据未变（哈希可证、§三可证），变的是**机器状态**。结论：**「环境事实」必须带采集时刻，跨日复用会失真**——建议后续执行单中一切环境结论标注采集日期，台账引用时同样处理。

**shell 模式抖动（4/6，高于 r4 的 1/7）**，两种形态，**全部 FAIL 方向，零假绿**：

- **第 8 条 unknown（RUN 1/4/5）**：30s 上限内既无 done 也无 failed。RUN 1 轨迹：启动后 12.4s 轮询时增量 **0 B（empty）**——主进程 13 秒都还没写日志（冷启动极慢，产物 246 MB 当日首启）；之后转 fresh（1349 B）但始终无 loadFile 行。r4 把 732 B 归因为「上轮实例子进程未退净」，本轮 RUN 1 跑前 tasklist 零匹配仍出现 unknown → **该归因不完整**，需静置复测再定性。
- **第 2 条红（RUN 1/3/4，exit=null timedOut=true）**：第二实例在 4 秒窗口内未退出。shell 模式下第二实例恒为**裸直启**（`CHILD_ARGS = []`），形态量级与「裸直启 GPU 崩溃路径 5~6s」吻合（疑似崩溃时序与单实例锁拒绝竞速）；r2 台账也登记过一次「单实例锁未定性异常」。**工程侧口径建议（交裁决，非缺陷）**：第 2 条测的是单实例锁，不是裸启动语义（裸启动语义由首实例承载），shell 模式下第二实例可考虑加 `--disable-gpu-sandbox` 以隔离本环境噪声——是否接受请交付总监/工程师裁决。
- 每轮 `verifyCleanup` 自报零残留；开跑前与全部结束后 tasklist 均零匹配。

---

#### 六、边界（本单**没有**签到的部分）

1. **7 项人工冒烟仍 0/7**（安装 / 启动 / 搜索 / 入队 / 下载 / 播放 / 更新检查）——不变。
2. **shell 抖动未判稳**：本轮 6 次中 2 次全绿，r4 签收条件 5「连续 3 次无抖动」未达成（本轮最长连续 1 次）。当日机器高负载（本轮前刚跑过两轮全量测试套件）可能推高抖动率，**该假设未验证**——QA 下轮应在静置机器上连跑 ≥3 次定性。
3. **直启与裸启动的「可用」仍不签**：直启 8/8 与裸启动进程层 7/8 各只有 1 次样本，且两者与 r4 结论相反的成因未定性（见 §五环境结论过期）。
4. **盲区真机权限不足场景仍未验**（r4 遗留 5 未动）；r4 遗留 1（盲区拒绝条件过宽的口径裁决）仍悬置。
5. **变异 ② 未复跑**（§五已说明理由，按「未复跑」登记，不读作「已验」）。

---

#### 七、证据附录（关键原文）

[EV-PENDING-004-r5-01] 判据布尔实参比对（`/tmp/qa-r5/boolean-diff.log`）
```
baseline calls: 18 | worktree calls: 18
DIFF_EMPTY=YES
```

[EV-PENDING-004-r5-02] shell RUN 1 轮询轨迹（抖动形态 a，`/tmp/qa-r5/shell-1.log`）
```
WAIT  轮询#1 启动后 12.4s ｜ 增量 0 B（empty） ｜ 判定 unknown
WAIT  轮询#2 启动后 12.8s ｜ 增量 0 B（empty） ｜ 判定 unknown
…（中略，#43 起转 fresh）
WAIT  轮询#45 启动后 30.0s ｜ 增量 1349 B（fresh） ｜ 判定 unknown
FAIL  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 30 秒内既无 loadFile done 也无 failed —— 应用可能未创建窗口，或日志口径变化（实测等满 30.0s / 轮询 45 次）
```

[EV-PENDING-004-r5-03] shell RUN 2 全绿轮（`/tmp/qa-r5/shell-2.log`，关键行）
```
PASS  首实例启动后持续存活 6 秒 — explorer 代理 ｜ 发现主进程 pid=21572 ｜ 6 秒后进程表仍存在
PASS  第二实例被单实例锁快速拒绝并以 0 退出 — exit=0 timedOut=false ｜ 验证口径: 第二实例经直启验证（explorer 不返回退出码，单实例锁由 userData 决定，与启动方式无关）
PASS  本次启动写了日志（main.log 增量非空） — 2062 B 新增
PASS  主窗口渲染层已加载（增量日志出现 [main] loadFile done） — 增量日志出现 [main] loadFile done（启动后 10.9s / 轮询 1 次）
清理: 零残留
8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.9s）
```

[EV-PENDING-004-r5-04] 直启默认 8/8（`/tmp/qa-r5/direct-1.log`，汇总行）
```
8/8 通过 ｜ 启动方式: 直启 + --disable-gpu-sandbox（非裸启动） ｜ 渲染层: 已加载（loadFile done，10.1s）
```

[EV-PENDING-004-r5-05] 直启裸启动 7/8（`/tmp/qa-r5/direct-bare-1.log`，汇总行）
```
7/8 通过 ｜ 启动方式: 直启裸启动（无旗标，SMOKE_BARE_LAUNCH=1） ｜ 渲染层: 无记录（既无 done 也无 failed）
```

[EV-PENDING-004-r5-06] 变异 ① 拒绝执行（`/tmp/qa-r5/mut-utf8.log`，全文）
```
ENV   启动方式: explorer 代理 ｜ 附加旗标: 无（等同用户双击） ｜ 渲染层: 可验证
exe: F:\新建文件夹\Lanyue-1.0.35\.preview\release-smoke-ui\win-unpacked\Lanyue.exe (246324736 B)
ERROR  进程表查询的通道自检失败（stdout 编码不是 UTF-8（实际 gb2312，本机控制台代码页可能是 CP936））—— 本机的控制台/进程表通道不可信，本次冒烟结论不可信，已拒绝执行
```
（断言行 0、`N/M` 汇总 0、`清理:` 行 0、未拉起任何进程；EXIT=1。）

---

#### 八、结论

**判定：维持 r4 的「有条件通过（签脚本层，不签产品可发布）」，本轮收口修改全部通过。**

- **签掉的是**：§二的 7 处修改——判据零改动（§三 DIFF_EMPTY=YES）、闸门全绿（§四）、变异 ① 拒绝执行复验成立、文档口径与实现一致（盲区 = WARN + 拒绝执行）、shell 存活断言的 unknown/gone 措辞分离且判定向不变。
- **没签的是**：r4 §七的签收条件清单原样有效，其中——条件 2（裸跑一次留痕）本轮**已履行**（EV-r5-05，如实登记 7/8）；条件 5（连续 3 次无抖动）本轮**未达成**（§六.2）；条件 1/3/4/6 状态不变。
- **新增交回工程师/总监的**：1 条口径建议（shell 模式第二实例旗标，§五）+ 1 条方法论要求（环境结论必须带采集时刻，§五）。

---

#### 九、同日补充取证：静置复测与裸启动连跑（[复]）

§六.2 留了一个未验证假设（「当日机器高负载可能推高抖动率」）与两个未竟项（连续 3 次无抖动、裸启动连跑 3 次）。本节为同日晚些时候的补充取证，全部原样记录。

**静置复测（shell 模式 ×6）**：静置 45 秒后开跑（CPU 负载 59%——本执行环境常驻进程所致，**非真零负载**，结论按此口径读）。开跑前 tasklist 零匹配，全部结束后仍零匹配。

| RUN | 退出码 | 结果 | 失败断言 | 备注 |
|---|---|---|---|---|
| 1 | 1 | 7/8 | 第 8 条（unknown） | 增量 732 B——r4 抖动签名同值 |
| 2 | 0 | 8/8 | — | done @10.8s |
| 3 | 0 | 8/8 | — | done @10.8s |
| 4 | 1 | 7/8 | 第 2 条（exit=null timedOut=true） | **done @24.2s**——渲染层加载成功但耗时 24 秒，30s 上限的真实余量仅 5.8s |
| 5 | 0 | 8/8 | — | done @10.8s |
| 6 | 0 | 8/8 | — | done @11.6s |

**对 §六.2 假设的回答**：抖动率由高负载时段的 4/6 降至 2/6，方向上与负载假说一致，但各 6 次的样本**不足以定性**；「连续 3 次无抖动」**仍未达成**（最长连续 2 次）。两种形态（第 8 条 unknown 含 732 B 签名、第 2 条 4 秒窗口未退）在静置后均复现。QUIET-RUN 4 的 24.2s 加载给出一条硬证据：**本机存在真实的慢加载形态，30s 上限偏紧**——r4 遗留 2 的定性工作转为两条：抖动成因待查（QA）+ 上限是否放宽待裁决（工程师/总监，涉及判据参数，不在本单权限内）。

**裸启动连跑（`SMOKE_BARE_LAUNCH=1`，解除条件②）**：本会话内累计 3 次，全部原样记录（第 1 次为 §五 那次 7/8，其后 2 次连跑）：

| RUN | 退出码 | 结果 | 备注 |
|---|---|---|---|
| 1（§五） | 1 | 7/8 | 第 8 条 unknown（增量 732 B）——首跑如实登记，未重跑消除 |
| 2 | 0 | **8/8** | done @10.1s |
| 3 | 0 | **8/8** | done @10.1s |

**解除条件②履行完毕**（连跑 3 次原样记录）。同时它带来第三条过期的 r4 环境结论：裸直启当日渲染层**可加载**（2/2 稳定 10.1s）——结合 §五 直启默认 8/8，r4 的「受限环境渲染进程起不来」定性在 2026-10-24 已整体不成立，**当日三种启动模式都观测到过渲染层加载**。r2/r4 基于旧环境定性给出的若干结论（如「本环境不能替代真实会话」）需在下一轮采集时重新判定，不得跨日引用。

[EV-PENDING-004-r5-07] 静置复测汇总行（`/tmp/qa-r5/shell-quiet-1..6.log`）
```
QUIET-RUN 1: 7/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 无记录（既无 done 也无 failed）
QUIET-RUN 2: 8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.8s）
QUIET-RUN 3: 8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.8s）
QUIET-RUN 4: 7/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，24.2s）
QUIET-RUN 5: 8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，10.8s）
QUIET-RUN 6: 8/8 通过 ｜ 启动方式: explorer 代理裸启动（无旗标，等同用户双击） ｜ 渲染层: 已加载（loadFile done，11.6s）
```

[EV-PENDING-004-r5-08] 裸启动连跑 3 次汇总行（`/tmp/qa-r5/direct-bare-1..3.log`）
```
BARE-RUN 1: 7/8 通过 ｜ 启动方式: 直启裸启动（无旗标，SMOKE_BARE_LAUNCH=1） ｜ 渲染层: 无记录（既无 done 也无 failed）
BARE-RUN 2: 8/8 通过 ｜ 启动方式: 直启裸启动（无旗标，SMOKE_BARE_LAUNCH=1） ｜ 渲染层: 已加载（loadFile done，10.1s）
BARE-RUN 3: 8/8 通过 ｜ 启动方式: 直启裸启动（无旗标，SMOKE_BARE_LAUNCH=1） ｜ 渲染层: 已加载（loadFile done，10.1s）
```

**§九补充后，§八结论维持不变**（签脚本层，不签产品可发布）；变化的是三条证据状态：解除条件②已履行、负载假说降级为「方向一致但未定性」、r4 环境定性整体过期需下轮重采。
