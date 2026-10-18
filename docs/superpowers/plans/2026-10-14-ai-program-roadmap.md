# AI×揽乐 升级计划集（Program Roadmap）

> **For agentic workers:** 本文件只是索引与切分理由。每份轨道计划都是独立可交付、
> 独立可测试的单元，按编号顺序执行；执行某条轨道时用 superpowers:subagent-driven-development
> 或 superpowers:executing-plans，逐任务实现。

**目标（用户原话）**：AI与项目结合升级当前项目。

**为什么拆成四份**：这四条轨道落在四个互不依赖的子系统上 —— MCP 服务面
（`src/main/mcp/` + `src/main/ipc/mcp.js`）、渲染层新面板（`src/renderer/js/views/` + 新 tab）、
曲库/历史数据面（`src/utils/historyStore` + 歌单）、CI 工具链（`.github/workflows/` + `scripts/`）。
合成一份计划会让每份交付物都失去「独立可测试」的边界，也让 reviewer 无法
「驳回后一条而放行前一条」。

| # | 轨道 | 计划文件 | 依赖 | 状态 |
|---|------|----------|------|------|
| 1 | MCP 一等公民化 + 调用审计 + 速率限制 | `2026-10-14-mcp-first-class.md` | 无 | 已落地（收尾 e5320a1） |
| 2 | 应用内 AI 助手（复用 MCP 工具面做 function-calling） | `2026-10-14-in-app-ai-assistant.md` | 轨道 1 的 `auditStore` / `onCall` 钩子 | 已落地（3dcd2a5 起六枚提交，收尾 b8e8059）；推送+CI 已绿（`e44df72` 两条 job success），界面实测：机制四条已在真 DOM 点到（只读直连、写前真弹层、取消零执行、回复含标签只当文本），欠账只剩「真供应商回复形态」一层，待用户 Key；该层的离线那半已收 —— 回复里出现两个 JSON 对象（模型改口）不再被贪婪正则跨坏成「花括号上屏 + steps 静默丢掉」，改为配平扫描取最后一个协议形状的对象（`65ae6dd`、`8fbca64` 两条 job 均 success，后者是一道「不许有第四份口径」的门禁）；`92e5ffd` 补上应用状态上下文注入（每回合把正在播放/待播队列/本次搜索折进**同一条** system 尾部，1600 字符闸由契约与服务同一份数字钉住），两条 job 亦全绿 |
| 3 | AI 智能歌单（**打标已砍**，见下方说明） | 无计划文件：范围收到一处 bounded 改动，直接按 TDD 落地 | 轨道 2 的出网通道 `assistantChat` 与严格 JSON 协议 | 已落地（4e28237）；行为单测 16 枚 + CDP 真点离线链（错误分支）+ 成功分支真 DOM（2026-10-14，见下方说明），CI 同上一条一起绿 |
| 4 | AI 接管研发流水线（CI 归因 + 复审 agent） | 归因：无计划文件（bounded，只碰 `.github/workflows/` 与新脚本，直接按 TDD 落地）；复审：`2026-10-14-ci-review-agent.md`（2026-10-14 新写，**用户拍板：暂不落地**） | 无（与 1-3 并行不冲突） | 归因侧已落地并在 runner 上验绿（`1302f35` → `05e31ed` → `84fa480` → `dec890b`，两个 job 全成功）；归因引擎的**红路**随后也进了日常 —— 新增「CI doctor self-check」步骤每次绿跑都喂合成红 TAP 真跑一遍脚本，`test/doctorSelfCheck.test.js` 四条用例（含两条坏现场的牙齿用例）守它，见下方留白闭合段，并已在 runner 上验绿（`82905c3` 两条 job 全 success，那次 run 的 annotation 里 `CI-DOCTOR` 命中 0）；复审 agent 一行代码没写 —— 它必然要出网花钱，计划里把「贴标签 = 授权花钱」做成闸门，**用户同日拍板不落地**，留档不删 |
| 5 | 助手 → AI Agent（风险分层 + 计划卡 + 整局预算） | `2026-10-15-ai-agent-upgrade.md`（spec：`../specs/2026-10-15-ai-agent-design.md`） | 轨道 1 的登记表与 `agentBridge`；轨道 2 的助手循环 | **P1 已落地并在 runner 验绿**：`48fac11` 两条 job（Lint & Unit Tests / Build & Asar Smoke）均 success。这一期把工具表从 17 条长到 21 条、并给每行长出 `risk`/`audience` 两列（`mutating` 改由 `risk` 派生，一份判据只留一个出处）；两侧视图由 `toolsForSource(source)` 给，source 白名单外的值直接抛；第二条出网路（工具返回值发给厂商）装了键名闸 `src/shared/outboundScrub.js`。**P2 已本地全绿**（Task 6-12）：风险闸按 `risk`+`scope` 判（`assistantGate.js`）、审计带 `scope`/`risk`/`runId`（`mcpCore.js`）、协议层 steps 带 `why` 且上限 4→8、计划卡纯渲染模块（`assistantPlanCard.js`）、循环改造（整局 24 调用/12 改写预算 + 同一步连败两次止损 + 破坏性单独弹确认发 `scope:'single'`）、工具面扩到 38 条（13 write + 7 destructive，外部 Agent 看不到 destructive）。**P3 已本地全绿**（Task 13-15）：登记表第一次允许「没有 IPC 通道」的能力——6 条播放控制（播放/暂停/切歌/音量/播搜索结果/切页面）`audience:'app'`，只在渲染层经 `APP_ACTIONS` 表执行、一条 IPC 都不发，主进程对它们回 `APP_ONLY`，外部 Agent 连名字都看不到（工具面 44 条 = 18 只读 + 19 write + 7 destructive；agent 视角 31 条）。文档三份口径已同步（SECURITY.md 三种确认形态 + 自查清单第 5 条、CHANGELOG 未发布条目、README 助手/MCP 条目）。**如实记下只有用户能验的那一层**：真供应商下的批确认金路只能用户本人在应用里点，agent 侧证据到本地/CI 绿为止。执行方式：subagent-driven，每任务一枚新评审 + 一轮修复复审；台账在 `.superpowers/sdd/2026-10-15-ai-agent-upgrade/progress.md`（git-ignored，实现期六条裁定已回填进 spec 末尾）。本地全量测试受 devDeps 未装限制（缺 electron/eslint），3246 用例中 3201 绿、2 红（均为预先存在的环境问题：ciDoctor 需 PowerShell、ai-assistant-ui 的计数钉已同步）；**全量闸门已在真实环境逐项验绿（2026-10-16）**：lint 0 error（2 个历史 warning 未动）、`npm test` 3255 用例 3252 绿 0 fail（沙箱此前误报的 43 fail 全是文件系统视角假象，真实环境 devDeps 齐全）、`check:dead-deps` 31 个排除项均未被运行时加载、`check:icons` 20 项全过、`npm run build` postbuild done、`smoke:asar` 13/13、`smoke:release` 4/4（真启动 + 单实例锁 + 无致命错误）。**收口推送与 runner 证据未做**：git 在当前 runtime 被 fork-bomb 保护拦截（`git.exe` 无法执行），而推送属「改远端共享状态」的敏感操作，需用户在本机 git 里亲自 `git add/commit/push` 并取 `check-runs` 注解；**真供应商下的批确认金路只能用户本人在应用里点**，agent 侧证据到全量闸门绿为止——别把这枚增量读成「已验证」 |

**轨道 4 为什么先只做归因**：归因引擎已定**纯确定性规则，CI 不出网、不花钱**
（2026-10-14 用户选定；LLM 摘要与本地 agent 两个备选都否了）。它读的是一段已经被
`bb5cfba` 完整搬进 annotation 的 TAP 文本 —— 判据来自本轮红四天的现场：同一个 `not ok`
可以是真回归、可以是异步泄漏误归属、可以是测试偷偷出网、可以是指纹漂移、也可以压根不是
代码问题，这五种的正确处置方向相反，靠人对着原文分辨就是把归因推回给人。
落地时顺带清掉三处旧账：详情窗口从「not ok 后 26 行」改成「前 3 行 + 后 26 行」（node 把
用例结束后的异步活动报成整文件级失败，真凶地址写在**前面**那行 `# Error:` 里，只取后文必然丢掉）；
`73a7ce7` 的 probe 调试行删掉（它每次绿跑都发一条 `::error::`，是训练「红了也忽略」）；
步骤体首行强令控制台 UTF-8（不设则落盘的 TAP 里中文静默损坏 —— 回显时按同一码页编回去，
看起来一切正常）。两条 workflow 的命令体现在逐行相同，由 `test/ciDoctor.test.js` 的形状钉守着 ——
分叉过一次，代价是那条 probe 行只在一侧被删掉、在另一侧又活了四天。
归因引擎还补了一处死角：`scripts/` 整目录不过 lint，而 CI 里其他脚本都被某条步骤**执行**过、
语法错误当场就炸 —— 只有它在绿跑里跑不到（`passed on attempt 1` 直接 exit 0），坏掉的时间点
恰好是唯一需要它的时刻，所以它被单独纳进 `npm run lint`。
**留白（不是遗漏）**：红路（三次尝试全红后才调归因）至今没在真 runner 上跑过一次 —— 落地后
唯一的红是 `84fa480` 那次，红在 lint 步、压根走不到单测步。本地是用真 TAP + 真 PowerShell
模拟验过的，另有一条测试守住「归因全程不产生任何对外连接」。要拿到 runner 侧证据得故意让 main 红一次，
那是给别人看的噪音，不值得为一条已三重覆盖的路径去制造 —— 记下即可。
（这句只堵了「用真红取证」这一条路，本文件末尾记的是它后来怎么用**合成红**闭合的 —— 不必制造真红。）
**同日再收一格（不留本地-only 的口径）**：「落盘会不会把中文烂掉」这一环此前只有一次性手工模拟。
现在它是一条用例 —— 把 workflow 里强令码页与 `Out-File` 那两行**从 YAML 里抠出来**、用真 PowerShell 执行，
生产者换成吐已知中文用例名的探针，落盘后再让归因引擎读回并核对名字。于是每次绿跑都在 runner 上走一遍
「捕获 → 落盘 → 归因读回」。它的牙有两半，别读过头：删改那两行 → 抠取断言直接红（环境无关）；
默认码页不是 UTF-8 的机器上绕过码页那行 → 落盘中文真烂 → 第二个断言红。这台开发机的码页已经是 UTF-8，
所以后者在本机**不复现**（实测写进用例注释，防止下一个人把它当成万能探测器）。
收窄后剩下的真空白只有一句：FAIL 分支没在 runner 上跑过一次。
**这最后一格也用同一路子收掉了（第三个选项，不是回头去制造红）**：留白之所以是留白，是因为当时只想得到
「要么等一次真红、要么人为让 main 红一次」这两种拿证据的方式。第三条是**喂合成红** —— CI 新增
「CI doctor self-check」一步，每次绿跑都拿 `test/fixtures/ci-doctor-red.tap`（三轮同指纹、中文用例名的
真 TAP 形状）铺成 `attempt-1..3` 交给 `ci-doctor.cjs --tap-dir … --summary` 真跑，然后核对 annotation
与 summary。于是「归因引擎自己坏了」不再只会在最需要它的那次红里暴露。这一步自己受两条不变量约束，
各有用例守着：**归因输出必须捕获、不许裸回显**（红路的 annotation 真身是 `::error::` 行，裸跑等于在
绿跑上伪造真红 annotation —— probe 调试行干过的事），**`GITHUB_STEP_SUMMARY` 必须在步骤内改指临时文件**
（否则那份长得很像回事的假红归因表会写进真实 job summary，比没有自检更糟）。
`test/doctorSelfCheck.test.js` 里另有两条「牙齿用例」，把抠出来的步骤体在坏现场下真跑：喂全绿 TAP 必须报
`no annotation`、喂纯 ASCII 用例名必须报 `test name lost`。第二条是被试穿出来的：初版断言写成「全串里
还有非 ASCII 字符吗」，而处置建议文案本身就是中文，纯 ASCII 用例名照样放行 —— 断言据此收窄到 `name=` 那一位。
还剩的边界照实说：这一步验的是脚本在 runner 的 Node/PowerShell/真实路径下跑得通、定得对性、中文不烂；
它读的是合成 TAP，**不验真红时上游落盘的那三份文件本身是否完好** —— 那半由上面那条抠行执行的用例守着。
**为什么没往 `release.yml` 也添一份**：发版流水线要 tag 才跑，一年点不了几次，死角不在那儿；
`release.yml` 的红路依赖的是同一个 `ci-doctor.cjs`，而它坏掉的时间点已被日常 CI 这一步提前拦下 ——
两处各跑一遍只会多一条要维护的形状（`Unit tests` 命令体那对逐行相同的钉子已经证明过分叉的代价）。
**runner 侧证据到了 annotation 一级（`82905c3`，两条 job 全 success）**：`Lint & Unit Tests` 这一步
没有 `if:`，job 绿就等于是这份合成红在 windows-latest 上被真跑真验过；更硬的一条是那次 run 的
annotation 清单只有 3 条 warning（Node 20 弃用 + 两枚历史 lint 未用变量）、`CI-DOCTOR` 命中 **0** 条 ——
「捕获不回显」这条不变量在 runner 上成立，不是只在本地成立。取证据不必 admin：
`GET /repos/<owner>/<repo>/check-runs/<id>/annotations` 匿名可读（job 原始日志才要 admin）。
复审 agent 不同：它得读 diff 之外的东西（需求、历史、运行时行为），不出网做不到，
于是与本轨道的「零成本、零出网」口径正面相撞。解法不是折中，是把「零」的定义挪到**默认路径**上：
归因在每一次 push 上都跑（纯规则、免费），复审只在人往 PR 上贴 `ai-review` 标签那一刻才花钱 ——
贴标签这个动作本身就是授权，所以 YAML 里不存在「自动决定花钱」的条件。
这条设计已写成可执行计划 `2026-10-14-ci-review-agent.md`（2026-10-14），
**用户已拍板：暂不落地**（同日）。计划留档不删 —— 它记的是"如果要花这笔钱，闸门该长在哪"，
重新论证一次的成本比留着它高。落不落地由人贴标签那一下决定这件事，已经写死在 YAML 草稿里了。

**轨道 2 剩下的三条为什么没拿本地假端点代跑**：要绕过 Key 把「找歌 / 入队确认 / 取消」跑完，
唯一的路是给 `MINIMAX_API_BASE`（`src/api/ai-music.js`）加一条 env 覆盖。刻意没做，两个理由：
① 那条请求带着 Bearer 计密钥，把它的目的地做成环境变量可指 = 给「谁能让这台机器起一个进程」
多开一条凭据外泄通道，与 `SECURITY.md` 的口径相反；② 换来的覆盖是重复的 ——
`planAssistantTurn` 的 `chat` 本来就是注入的，协议解析、白名单钳制、确认闸门、审计落点都已有
拿假 chat 跑过的单测，真没验的只剩「模型按协议答话时上游通不通」，那只有真 Key 答得出。

**机制半侧已在真 DOM 里点过**（2026-10-14，不出网、不要 Key）：脚手架是一个静态服务
`src/renderer` 的一次性 harness，把 `window.ipcRenderer` 按 preload 的真实语义打桩 —— 未授权通道
返回 `undefined`（生产就是这么静默）、信封已由 preload 解过所以桩返回渲染层实际拿到的东西、
白名单直接取主进程注入的同一份 `buildContractArg('main')` 而不是另攒一份。四条结论：
只读步骤不弹确认、`confirmed` 传 `false`；写步骤先弹**真**确认框（标题「助手想执行：add_to_queue」，
参数原样列在正文），点确认后才有那一次 `confirmed=true`；点取消则该步零次 tool-call、
上屏「已取消：toggle_favorite」且循环继续走到下一回合；模型回复塞 `<img src=x onerror=…>` 时
消息节点零子元素、文档里零注入 `img`。harness 用完即删 —— 它换到的是「界面侧断言从源码形状钉
升到真 DOM 观察」，重建做法已写在这段里。欠账因此收窄成一层：**真供应商的回复形态**。

**「真供应商的回复形态」这一层里，离线能收的那半已经收掉了**（2026-10-14）。对着真模型最常吐的第二种
毛刺 —— **一条回复里出现两个 JSON 对象**（先答一句又改口重来）—— 试出来的：两处容错都是贪婪正则
`\{[\s\S]*\}`，它把两个对象跨成一段非法 JSON，于是解析失败之后
**轨道二**把整坨花括号当作 `reply` 原样上屏、模型真正要执行的 `steps` 静默丢掉（用户看到一串花括号，
助手什么也没做，界面看起来却像「已经答过了」），**轨道三**则 picks 全丢、界面如实报「一首都没挑出来」
—— 而那其实是模型答对了、只是答了两遍。
现在换成逐字符配平的候选扫描（认字符串与转义，也认顶层数组，所以值里出现的 `{`、`]` 和引号不会带偏），
从最后一个候选往前找第一个协议形状的（**改口之后的才是结论**），一个都没有才退回各自的失败路径。
第三处同毛病在关键词改写（`ai_search_music` 那条 P0-A 链路）：它用的短匹配 `\[[\s\S]*?\]` 取的是模型
**已经丢掉的第一份草稿** —— 方向相反、更不容易被发现，所以一并接进同一份口径。
三处原来各攒一份、注释还互相指着「同一口径」—— 修一处就漏一处，所以抽成
`src/api/services/modelJson.js` 一份，判据（助手认 `reply`/`steps`、歌单认非数组对象、改写认数组）
留在各自服务里当入参。
测试：`test/ai-assistant-service.test.js` 一条四例用例（两个对象 / 后一个是代码块 /
两个都不是协议形状 / `reply` 里带花括号与转义引号），`test/smart-playlist-service.test.js` 补一条改口用例，
`test/nlSearch.test.js` 补一条「两个数组取后面那个」，外加 `test/modelJson.test.js` 四条钉扫描本体
（混合结构、字符串里的括号、判据不合形时退回前一个候选、空输入）；三条消费方用例都先红过一次再落地。
**并且钉住了「不许有第四份」**：同文件第五条用例扫遍 `src/`，除 `modelJson.js` 外任何文件出现
`[\s\S]` 就红并点名 —— 敏感性拿一份写着 `\{[\s\S]*\}` 的临时文件验过（塞进去立刻红，删掉就绿）。
三份各攒的取法能活到今天，靠的就是没有人挡第四份。
这一层剩下的**只有**「真模型是否遵守这套协议」：字段命名、该不该给 `steps`、中文措辞 ——
那些要用户的 MiniMax Key 才能验，不是代码问题，也不是能在离线补的。
Runner 侧证据：`65ae6dd`（三处接进一份口径 + 消费方用例）与 `8fbca64`（挡第四份的门禁）两条 commit
都是 `Lint & Unit Tests` 与 `Build & Asar Smoke` 全 success —— 门禁在 CI 的 Node22/windows-latest 上
同样扫得到 `src/`，不是只在这台机器上绿。（两枚都用匿名可读的 `check-runs` 接口取的，无需 admin。）

**轨道三的成功半侧也在真 DOM 里点过**（2026-10-14，同一套 harness，喂的是假生成结果）：CDP 那次
只走到错误分支（`NO_CANDIDATES` → 词典整句），成功半侧一直只有源码形状钉。这回落到的观察：三首歌
渲染成三行 `label.spl-song` 各带一个 checkbox；歌单名自动填上生成结果里的名字；状态行同时写着
「挑了 3 首」与「另有 12 首没进挑选范围」—— 后半句那条「不让用户以为 AI 读完了整个曲库」的承诺
在界面上真的存在；第二行标题塞 `<img src=x onerror=…>` 时原样以文本出现、文档里零个注入 `img`；
取消勾选后状态行改口「挑了 2 首」、该行加 `spl-off`、保存载荷恰好少那一首且留下的每首都带 `addedAt`；
整条流程 IPC 只出过一条通道 `smart-playlist-generate`，存歌单走 `window.api.saveUserPlaylist`，
一条工具通道都没碰 ——「只读」不只是源码形状钉。
顺带记一条 harness 的教训：`save-user-playlist` 主进程契约是 `{success}`（`src/main/ipc/playlist.js:186`）
而不是助手那条通道的 `{ok}`，第一版桩给了 `{ok:true}`，于是界面**正确地**走了失败分支（面板不关、
toast 是失败文案）。这不是 bug，是桩不忠实 —— 但它顺手把失败分支也验了。

**轨道 3 为什么只剩一半**：曲库自动打标原计划把标签写进 `library-index.json`，
读时再 join 回歌单。动手前对着源码否掉了 —— `incrementalScan` 在文件 mtime 变化时执行
`existingTracks[idx] = meta`（`src/utils/libraryIndex.js:164`），整条索引条目被元数据读取器
的返回值**原样覆盖**，标签活不过一次重新扫描；换目录时更是整个索引清空（同文件 103 行）。
要活下去它就得变成第三份存储 + 第二套 join，那是为"顺手加个字段"付出的永久性复杂度。
智能生成歌单不依赖打标，且它自身就是用户要的那件事，于是留下它、砍掉打标。

**依赖方向的唯一理由**：轨道 2 的助手要把每次 LLM 工具调用记进同一份审计
（用户在设置页里能看到「AI 助手替我做了什么」），所以 `auditStore` 与
`createMcpHandler` 的 `onCall` 钩子必须先存在。其余轨道彼此无共享写入点。

## 全程序硬约束（每条轨道都受用）

- **零新增依赖**：`package.json` 的 dependencies 不许因为这几条轨道变长
  （`docs/archive/AI_MUSIC_RESEARCH_2026-09-19.md:51,54` 已写明离线 whisper/demucs、
  CLAP 语义检索因体积与 GPU 依赖**不做**）。
- **不迁框架、不上 TS、不改进程模型**：`docs/REFACTOR_PLAN_2026-09-17.md:10`。
- **MCP 工具白名单红线**：cookie/登录、文件路径读写、set-pref、对话框、更新安装
  一律不进工具面（`src/main/mcp/tools.js:8-9`、`SECURITY.md`、研究文档 `:66`）。
- **AI 翻唱/人声转换不做**（版权+表演者权风险，研究文档 `:55`）。
- **IPC 契约是唯一事实来源**：新通道先声明进 `src/shared/ipcContract.js`，
  再在 `src/main/ipc/register.js` 的 `handle()` 注册；preload 白名单自动派生。
- **文案必须进词典**：`src/renderer/js/lang/zh.json` 与 `en.json` 同步加键；
  `src/renderer/js/views/settings.js` 属 `test/toast-i18n.test.js` 的 `CONQUERED`（欠账 0），
  新代码不许往 `showToast()` 里塞中文字面量，否则台账与门禁一起翻脸。
- **开关值只准一处**：`src/renderer/js/features.js` 的 `FEATURES`；`ai: false`（AI 创作）
  是 4ffa7ea 里定下的**产品决定**，任何轨道都不许顺手翻它。
- **只发 Windows**：`release.yml:16-18`；不做代码签名（`SECURITY.md §4`）。
- **五层闸门必须全绿**：`npm run lint`（0 error）→ `npm run audit:deps` →
  `npm run check:dead-deps` → `node --test --test-concurrency=2 "test/*.test.js"` →
  `npm run build` → `npm run smoke:asar`。单测在本机汇总为 `ℹ tests N / ℹ pass N / ℹ fail N`，
  判绿只认 `ℹ fail 0`（管道 grep 会吞退出码，见项目记忆）。
- **本机 git 无全局身份**：提交用 `git -c user.name=CodeBuddy -c user.email=codebuddy@local commit`。
- **推送需要代理覆盖**：`git -c http.proxy= -c https.proxy= push`（全局配置指向 127.0.0.1:10809 且通常没开）。
