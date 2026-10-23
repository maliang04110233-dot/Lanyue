# 工程师作业规程

适用：Lanyue（揽乐）`1.0.37` 及之后的所有实现工作。本文件只回答一件事——**工程师拿一条 `已准入` 的需求，怎么把它变成可被 QA 复核的事实**。
档位与验收条件归 `DEMAND.md`，角色权责与交接归 `COLLABORATION.md`，阶段与门禁归 `DELIVERY.md`，验收执行归 `QA.md`。本文不复制判据，只写动作。

> 为什么单独成文：上游四份定义了「什么需求能开工」「谁交给谁」「靠什么门禁」「怎么验」，没定义「代码怎么写、证据怎么留」。缺这一层，判定链完整而执行层靠手感——本仓 `git status --porcelain` 长期存在的一批未提交改动，就是「动作没规范」的存量证据。

## 〇、术语锁定（不自创，先读）

| 本文用词 | 唯一事实来源 | 本文只做什么 |
|---|---|---|
| L1 / L2 / L3、Q1–Q8 | `DEMAND.md` §1.1、§1.2 | 照抄进提交正文与自测范围，**不重判** |
| R1–R3、基线铁律 | `DEMAND.md` §4.2、§〇 | 规定开工前核对的动作 |
| H2 架构→工程、H3 工程→QA | `COLLABORATION.md` §三 | 规定交出去的东西长什么样 |
| 快闸 / 全量闸 / 发布闸、S3 实现自测 | `DELIVERY.md` §一、§二 | 规定跑什么、抓哪几行 |
| 唯一入口（`fsAsync`/`approvedDirs`/`esc*`/`atomicFile`/`logger`/`downloadDefaults`） | `CONTRIBUTING.md` 铁律② | 规定复用而非新造 |
| 证据编号 `EV-<需求ID>-<n>` | `QA.md` §一 | 自测证据按同一编号交出 |

**硬约束**：本文与上游冲突时以上游为准，并在此登记差异（§十三）。

## 一、提交粒度与 commit 正文模板

### 1.1 粒度：一个 commit = 一次可独立回滚的判断

| # | 判据 | 不满足时 |
|---|---|---|
| G1 | 回滚后仓库仍 `npm run build` 通过且 `npm test` 全绿 | 把「契约→注册→派生→调用」拆成 4 个各自可绿的 commit |
| G2 | 不混档：L1 不与 L2 同 commit | 先提 L2（含契约），再提文案/CSS |
| G3 | `git show --stat` 里无两个不相关域 | 「顺手修的」另起一个 commit，哪怕一行 |

规模参考（超出须在正文首行写「为什么不能拆」）：代码净增 ≤300 行、文件 ≤8 个、单文件 ≤200 行。
> 为什么：`bf64203 阶段 5 助手：P3 播放控制工具面落地 + 助手页界面重构` 把「主进程接线」与「助手页 DOM 重排」压成一条——回滚任一半要手工摘 hunk，`git revert` 会把另一半一起退掉，需要 bisect 时直接失去定位能力。

### 1.2 类型集（只取仓库出现过的）

`git log` 实测 506 个 commit：`feat` 31 / `refactor` 26 / `docs` 24 / `fix` 23 / `test` 9 / `chore` 9 / `release` 7 / `ci` 2。

| 类型 | 用在哪 | 不用于 |
|---|---|---|
| `feat` | 新增用户可感知行为或新通道 | 「把已有实现拆文件」 |
| `fix` | 与预期不符的行为，且能写出复现 | 「防将来出错」的加固（用 `test`/`refactor`） |
| `refactor` | 行为零变化的结构调整 | 夹带行为修正 |
| `test` | 只改 `test/**` | 夹带源码 |
| `docs` | 只改 `docs/**`、`*.md` | 夹带源码 |
| `chore` | 依赖、脚本、一次性杂务 | — |
| `ci` | 只改 `.github/**` | — |
| `release` | 发版收口：版本号 + `CHANGELOG.md` + 口径对齐，一版至多一条 | 夹带功能 |

`perf` / `build` 在本仓 506 个 commit 里出现 **0 次**，故不列入；性能改动走 `refactor`（行为不变）或 `fix`（可复现劣化），构建链路走 `chore`。新增类型须先改本节。

### 1.3 正文模板（写为什么，不写改了什么）

```
<type>(<scope>): <祈使句，≤50 字，不加句号>

为什么：<现象 + 需求 ID + 档位（含命中的 Q 编号）>
不这么做的代价：<可选>
验证：<命令 + 结果计数>
跳过项：<无 / SKIP_HOOKS_LINT=1 + 原因 + 补跑计划，见 §二>
```

`scope`：`ui` / `player` / `ipc` / `main` / `renderer` / `settings` / `mcp` / `shared` / `docs`。

```
✅ refactor(player-sync): 收敛换曲判定 —— 两份重复实现合一

为什么：换曲判定在 player-sync 与 audio-events 各写一份且已漂移（一份比 filePath、
一份比 src），AB 循环打开时结论不一致，表现为上一首续播监听不撤。L2（Q4、Q7）。
验证：全量 3439/3439 绿、lint 0（2026-10-23 快照；此后新增文档守卫，现为 3447）。

✅ fix(abLoop): 清除循环的判据用 != null —— A 点设在第 0 秒时也能清掉

为什么：原判据 `if (a)`，而 A=0 合法且为假值 ⇒「清除循环」静默失效，用户只能重启。L1（Q8）。
验证：新增 test/ab-loop.test.js 用例「A 点为 0 时可清除」；lint 0；test 绿。
```

**反例 1**（真实提交 `a556b98`）`修复：设置页「GitHub 仓库」快捷链接指向仓库而非 github.com 首页` —— 无 `type(scope)`；中文类型名破坏 `--grep` 与类型统计；只叙述「改成了什么」，而**为什么原链接是错的**（通用地址 vs 仓库地址）无处可查，下一个人会重犯。

**反例 2**（真实提交 `bf64203`）`阶段 5 助手：P3 播放控制工具面落地 + 助手页界面重构` —— 两个判断同 commit（违反 G1，revert 无法只退一半）；`+` 并列说明作者自己也说不清单一意图；无验证行，无法判断「落地」是否等于「跑通」。

## 二、`SKIP_HOOKS` 登记与补跑

快闸 = `hooks/pre-commit` 四项（敏感/本机文件 → `.gitattributes` 换行规则完整性 → 编码特征字符 → 仅暂存文件的 ESLint）。阀门两个：`SKIP_HOOKS=1`（全跳过）、`SKIP_HOOKS_LINT=1`（只跳第 4 项）。

| 允许 | 不构成理由 |
|---|---|
| 已 publish 版本的功能性缺陷热修，且快闸因环境误报（`npx eslint` 拉不到包、`node` 不在 PATH） | 赶时间 / 改动很小 / 本地跑过了 |
| 内容被 hook 误判（确需入库的测试证书，已单独立需求） | hook 太慢（第 4 项只查暂存文件） |
| 交付总监书面批准（`COLLABORATION.md` C4） | 工程师自行决定 |

**留痕格式**（写在正文**最后两行**，缺任一行视为未登记）：

```
跳过项：SKIP_HOOKS_LINT=1（原因：npx 拉包超时；已用 node_modules/.bin/eslint 全量跑过，0 error）
补跑计划：2026-10-25 前在无 SKIP_HOOKS 环境跑 `npm run lint && npm test`，结果贴台账该条目「闸门证据」列
```

**补跑纪律**：**24 小时内且不晚于下一次提交**（先到者为准）；L2+ 补跑 `npm run verify`，L1 补跑 `npm run lint && npm test`；结果追加到**同一台账条目**（`DEMAND.md` §4.2 的「禁止打补丁」只约束 R1–R3，闸门证据属同条目的正常追加）。
> 为什么必须两行：`DELIVERY.md` §6.1 把「用了 `SKIP_HOOKS=1` 且事后发现被绕过项确有问题」列为**必写复盘**。没有这两行，复盘答不出「跳过了什么、补了没有」。同理 `hooks/pre-commit` 第二项前两版都拦不住 CRLF——因为没写清自己该拦什么，最后改成检查 `.gitattributes` 规则本身。

## 三、异步 IO 两处例外的注释模板

铁律①：主进程即 UI 线程，IO 一律走 `src/utils/fsAsync.js`。仅**应用启动早期**与**退出路径**两处允许同步，且必须在该行注释写明理由。

```js
// [同步 IO 例外·启动早期] 早于 app.whenReady()，事件循环尚未处理任何 IPC，
// 也没有等待渲染的窗口，阻塞代价 = 启动耗时本身。归属 CONTRIBUTING 铁律①。
const raw = fs.readFileSync(paths.prefsFile, 'utf8');
```

```js
// [同步 IO 例外·退出路径] 在 'before-quit' 内、所有窗口已销毁之后执行；
// 异步写可能来不及在进程退出前落盘，同步写反而更确定。归属同上。
fs.writeFileSync(paths.playQueueFile, JSON.stringify(data));
```

**自查问句（一条）：「这一行卡住 300ms 时，屏幕上有没有一个用户正在等的窗口？」**
答「有」→ 不属任何例外，改异步。答「没有」→ 再答两问：是否确在 `app.whenReady()` 之前？是否确在所有窗口销毁之后？两问皆「是」才允许落模板。
> 为什么问句比背定义有效：`src/utils/history.js` 的 `findDownloaded` 用 `fs.existsSync` 判活，单点毫无问题；被放进批量入队/订阅轮询循环后，网络盘一次 `stat` 数十毫秒 × 几百首 ⇒ 整窗无响应。成因不是「不知道要异步」，而是「单看这一行看不出它在循环里」。该函数至今保留一次同步调用，注释（`history.js:291`）明写「批量路径请改用 `findDownloadedAsync`」——**注释是这条例外唯一的合法凭证**。

## 四、新增/修改 IPC 通道：五步走自检单

顺序不可调换；跨层改动按此顺序提交，任一步漏掉都是启动即抛或静默 pending。

| 步 | 动作 | 可验证检查 |
|---|---|---|
| ① 契约登记 `src/shared/ipcContract.js` | `CHANNELS` 加一条，四要素齐全：方向（`invoke`/`send`/`receive`）+ `args` 参数规格（`t.str(max)`/`t.int(def,max)`/`t.enum([...],def)`）+ 可见窗口（`MAIN`/`BOTH`，最小窗口原则）+ 必要时补 `METHODS`（渲染层方法名）/`EVENTS`（receive 订阅名） | `node --test test/ipc-contract.test.js` 退出码 0（该测试双向比对契约与实现，只改一侧必红） |
| ② 主进程注册 `src/main/ipc/register.js` | `invoke` 用 `handle(channel, fn)`、`send` 用 `on(channel, fn)`；**禁裸 `ipcMain.handle`**（`_entry()` 直接 throw） | 启动控制台无 `IPC 通道未声明在契约`；契约测试「handle 的每个通道都声明了 invoke:main」绿 |
| ③ preload 派生 `preload.js`/`preload-secondary.js` | **不改这两个文件的清单**——由 `buildContractArg(win)` 经 `additionalArguments` 派生；主窗口 `musicAPI`、二级/迷你窗 `miniAPI`。要改的只有可见窗口归属（回①） | `node -e "const{channelsFor}=require('./src/shared/ipcContract');console.log([...channelsFor('main','invoke')].includes('你的通道'))"` → `true`；二级窗口再跑 `'secondary'` |
| ④ 渲染层调用 | 用派生的 `musicAPI.<method>()`，不手写 `ipcRenderer.invoke('字面量')` | `npm run dev` → Console 里 `await musicAPI.<method>(合法参数)` 返回期望值；传非法形状（对象/超长串）返回参数非法而非崩溃 |
| ⑤ 对外暴露（仅需给外部 Agent 时） | `src/main/mcp/tools.js` 加**一行**；写操作要求渲染层拿到用户确认后传 `confirmed: true` | `node --test test/agent-tool-registry.test.js` 绿 |

| 已知失败形态 | 症状 | 根因 |
|---|---|---|
| 未声明就注册 | 应用**启动即抛** `IPC 通道未声明在契约 (invoke): xxx` | 漏①，直接写了② |
| 声明了没人注册 | 启动**不抛**，日志出现 `[ipc] 契约通道无人注册（N）: xxx`（`assertContractCoverage()` 用 `logger.warn` 点名） | 漏②，只写了契约 |

> 为什么第二种只 warn：契约里存在「主进程内复用、外部不触发」的通道，抛错会误杀；代价是只能靠看日志发现——所以①②的顺序在 H2 任务清单里就定死（`COLLABORATION.md` H2 判据③），不靠运行期兜。

## 五、渲染层改动自测取证

渲染层无框架：`innerHTML` 拼贴 + 内联 `onclick` 调 `window.*` 桥，**没有 mount/unmount**。取证靠几何、预览、截图三件事。

**5.1 几何用 `--dump-dom`，不靠目测。** 面板入场是 `translateY(10px) scale(.985)`（`ui.css:1597`），截图拍在动画中途会量出小 1.5% 的高度——这曾导致「面板高了 8px」的错误结论与一轮无效修改。

```bash
npm run build                       # build 会清掉探针页，顺序不能反
# 写 dist/renderer/probe.html：iframe 载 index.html，load 后 setTimeout(2200) 调 window 函数切页/开弹层
chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 \
  --virtual-time-budget=8000 --dump-dom "http://127.0.0.1:8080/probe.html?modal=settings" > dom.html
grep -o '<title>[^<]*</title>' dom.html
```

探针里把 `getBoundingClientRect()` 的 `w/h/top/left`、`getComputedStyle` 的 `border-radius`/`gap`/`color`、以及 `el.children.length`（图标化必查，见 §九）写进 `document.title`。
> 为什么：`--headless` 不能向页面注入脚本，像素只能量当前帧；把数值搬进 title 是唯一「量的最终态、且可被 grep 复核」的组合。

**5.2 用 `mockApi` 复现视图。** `location.protocol` 以 `http` 开头时渲染层自动走 `src/renderer/js/mockApi.js`：`npm run build` → `python -m http.server 8080 -d dist/renderer` → 打开 `http://127.0.0.1:8080/`，得到真实布局 + 假数据，无需起 Electron。`mockApi` 是取证环境的一部分，**改了要当代码改**：`getPref` 曾恒返回 `null` ⇒ 主题停在 `:root` 青绿，而产品默认 `void` 是电青——对着预览调色、装到机器上偏一个色相；`getHomeSection` 曾恒返回空数组 ⇒ 首页每块都掉进降级态。修法就是让 mock 与真实主进程同形。

**5.3 截图取证。** 拍最终态（`--virtual-time-budget=8000` + 探针延迟 ≥2200ms）；需动效时另拍起点并在文件名标注，不用中途帧冒充终态；每张图必须能回答「看哪个元素的哪个属性 = 什么值」（不写「页面正常」）；随 `EV-<需求ID>-<n>` 贴台账或 `DELIVERY.md` §五 签收单。

## 六、守卫测试模板与「在防什么」注释

守卫测试 = 静态读源码的 `node:test` 断言，不起 Electron、不出网。

```js
/**
 * 守卫：<「某类改动会导致某类静默失效」句式>
 *
 * ── 那个坑怎么发生的（写实测，不写推测）──────────────
 * <日期 + 文件:行 + 现场数字>
 * ── 为什么修完还要钉 ─────────────────────────────
 * <下一次写同类代码的人读不到这次修复>
 * 谁修过：<commit sha / 增量号>
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

test('扫描本身要有效（门禁不能空转）', () => {
  assert.ok(read('src/renderer/js/app.js').length > 1000, '读到的文件异常小，多半路径变了');
});

test('<被守的规则>：违规清单必须为空', () => {
  const bad = [];   // 逐条 push `${rel}:${line}`
  assert.deepStrictEqual(bad, [], '违规：\n  ' + bad.join('\n  '));
});
```

三条纪律：①**先有扫描自测再断言**——`test/css-token-integrity.test.js` 首条钉「文件数 ≥100、令牌数 ≥60、`--accent-ui` 必须既被定义又被引用」，否则正则失效时门禁静默变绿（`test/toast-i18n.test.js` 用合成文本跑 5 枚自测同理）；②**判据要能抓绕法**——反引号算字面量、`'前缀' + 变量` 算、`parts.push(中文)` 再 `join` 进出线也算（`accumulatorSites`），抓不住的如实记台账并注明盲区；③**白名单精确到行且自证未过期**——`test/encoding-guard.test.js` 按 `相对路径:行号` 且要求该行是注释。
> 为什么注释必须写「谁修过」：`test/inline-handler-escape.test.js` 记录的坑真实发生过两次（`subscriptions.js` 6 处、`ai-music.js` 1 处），更糟的是 `test/subscription-new-dl.test.js` 曾把 `escAttr` 版本当「已转义」钉住——**用测试保护了 bug**。没有「当初为什么这么写」，下一个人会把守卫当风格偏好绕开。

## 七、CSS token 增删流程（最易踩）

**7.1 新 token 只能追加进 `base.css` 既有的 `:root`。** `test/css-token-integrity.test.js` 的 `themeBlocks()` 解析 `base.css` 里所有 `:root{}` 与 `[data-theme="x"]{}`，对**每一块**索要 11 个 `CORE_THEME_TOKENS`（`--bg-deep`/`--bg-card`/`--bg-hover`/`--bg-input`/`--border`/`--text`/`--accent`/`--neon-cyan`/`--neon-red`/`--neon-orange`/`--neon-yellow`）。**新开一个 `:root{}` = 第 7 套主题，立刻红。**

| 判据 | 违反后果 | 修法 |
|---|---|---|
| 每个 `var(--x)` 必须有定义 | CSS 不报错，整条声明失效（卡片透明、分隔线消失、文字层级丢一档） | 补真定义，**不放宽守卫** |
| 禁裸 `border-radius` px、禁裸 `gap` px（1/2px「紧密」语义除外） | 同一界面圆角 5 档、间距 6 档，「不规整」的根因 | 走 `--r-*` / `--sp-*` |
| 禁硬编码 hex / `rgba()`（`#fff`/`#000`/`transparent`/`currentColor`/`#e5484d` 例外） | 切浅色主题时那块不变色 | 走 `--surface-*`/`--stroke-*`/`--fg-*` |
| 有 `cursor: pointer` 必须配 `:hover`/`:active`/`:focus-visible` | 「沉默的可点」：实测 117 个可点元素里 23 个如此 | 补反馈或落 `FEEDBACK_EXEMPT` |

新增 token 必须**同时有使用点**（`DEMAND.md` §3.3 强制项），不留孤儿。

**7.2 特异性纪律。** `ui.css` 最后加载，同特异度必胜；但**后代选择器 (0,2,0) 会静默压过单类 (0,1,0)**——现象是「大部分页面变了、只有本地曲库工具栏没变」，而 CSS 覆写失败**不报错**。实测已踩 6 处，处理方式是**显式重写**（把旧选择器原样写进 `ui.css` 再给新值）：`.local-toolbar .search-input`、`.dl-subtabs .filter-tab`、`.local-album-wall .grid-title`、`.home-stats .stat-card:hover`、`.local-row.selected`、`.queue-item.selected`。

**禁止用 `!important` 解决**：加了之后「按设计改回」需要第二个，两轮后没人知道哪个值是真的。同类「谁在后面谁赢」的坑还有两个：`.setting-btn` 会吃掉 `.confirm-dialog-ok` 的背景（设置小节须写在按钮小节之前），也会吃掉 `.setting-btn--danger`（危险态须在 `ui.css` 重新声明）。找这类规则**别靠肉眼**——写脚本扫全库「选中目标类且特异度 ≥(0,2,0)」的规则。
> 为什么写成纪律：阶段 3 换皮时 `ui.css` 全绿、`npm test` 全绿、build 通过——没有任何测试断言「这条新规则真的生效」，唯一证据是人逐页看，12 视图 × 41 弹层不可能穷举。同轮还发现 `.btn-primary` **全仓从未定义**，「新建歌单」与助手发送键拿到 UA 灰白底 + 继承浅色字 = 白底白字，按钮文字完全不可见。

## 八、zh/en 同键与欠账台账

| 动作 | 要求 | 判据（`test/toast-i18n.test.js`） |
|---|---|---|
| 新增中文 | 先进 `src/renderer/js/lang/zh.json`，**同一次改动**给 `en.json` 同键 | 「用到的每个键都中英齐备」 |
| 占位符 | `{count}` 这类两边同集合（少一个就是把变量名印给用户） | 「中英占位符同集合」 |
| 译文 | `en` 不得照抄中文；`zh` 不得以冒号收尾（半句话＝把拼接留在源码） | 「译文是真英文」/「不许是半句话」 |
| 暂不收编 | 改 `LEDGER`（按文件的欠账台账）的**实跑数字** | 「欠账台账与实际逐字相等」 |
| 已收编文件（`CONQUERED`） | 整文件零中文字面量 | 「已收编文件零硬编码」 |

**台账读法（写死，别误判成测试坏了）**：数字**变多** = 欠账 → 收编进 `zh.json` 后改回；**变少** = 进步 → 必须钉小（归零删项，不留恒真记录）；新文件带中文反馈 → 以非零计数入表。`PASSTHROUGH`（透传台账）与 `LEDGER` 不得互相盖住：进了 `PASSTHROUGH` 的文件其 `LEDGER` 计数必须为 0。`ORPHANS` 常态是**空表**：新写 `toast.*` 键必须同一次改动里有消费方。
> 为什么是「逐字相等」而不是「不许增加」：判据加严时（`accumulatorSites` 那一刀）四个文件计数同时上调，只有一个是真改了代码，其余是**存量失明被照亮**。若写成「不许增加」，正确做法会红，人就会去改源码把数字压回去——`views/playlist.js` 正是这样假绿过一次：只接了分隔符、三个分句仍是中文，台账却归零，英文界面照旧整句中文。

## 九、图标体系作业规范

图标 = CSS `mask` + `[data-ico]` 伪元素：定义源 `scripts/gen-icons-css.cjs`，生成物 `src/renderer/styles/icons.css`（**勿手改**）。重新生成用 `node scripts/gen-icons-css.cjs`；`npm run gen:icons` 跑的是 `scripts/gen-icon.js`（生成应用图标 `assets/icon.png`），**两者不是一回事**。`npm run check:icons` 校验 `assets/icon.png`/`icon.ico`/安装器 BMP 与「AI 生成」水印残留。

**硬约束 1：不得在带 `data-i18n` 的元素内插子节点。** `src/renderer/js/i18n.js:58` 只对 `el.children.length === 0` 写 `textContent`（保护设置页 3 个内嵌 `<code>` 的提示框）。插一个 `<svg>` 进去，该按钮**永久失去翻译**且无任何报错。伪元素不进 DOM 树，`children.length` 仍是 0——这就是选 `mask` 而非内联 SVG 的全部理由。检查动作：§5.1 探针输出 `children.length`，改动前后都必须是 0。

**硬约束 2：mask 用 `currentColor`，禁止给图标写死 `color`。** `background-color: currentColor` 让图标跟随文字色，hover/active/禁用态与主题切换全部免费；写死颜色等于把状态色烤进图标（`background-image` 路线就死在这里）。

用法：`<button data-i18n="download.clearDone" data-ico="trash">清空已完成</button>`；纯图标容器加 `data-ico-only`；`24×24 viewBox`、`stroke-width 1.75`、round cap/join；`play`/`heart`/`sparkle` 为实心。迁移动作用 `scripts/migrate-emoji.cjs`（不带 `--write` 只干跑）；两个已知坑：同位置多码位（`⬇️` 与 `⬇` 起始索引相同，须按位置分组取最长）、属性末尾追加会破坏 `[^>]*hidden>` 这类逐字钉。
> 为什么容易翻车：把 `✕` 换成 `data-ico="x"` 后屏幕阅读器**失去可读名**（原来读的就是字形），必须补 `aria-label="关闭"`；这会改动中文文案，进而触发 `PASSTHROUGH` 台账（`views/playlist.js` 14→16），必须同步改表。

## 十、`npm run verify` 输出尾部抓取与留档

七项串联（顺序即失败优先级）：`lint` → `test` → `check:dead-deps` → `check:attack-surface` → `check:icons` → `build` → `smoke:asar`。发布闸 `npm run verify:release`（= `verify` + `smoke:release`）只在 S6 打 tag 前跑。

```bash
LOG="verify-$(date +%Y%m%d-%H%M).log"
npm run verify >"$LOG" 2>&1; CODE=$?
echo "退出码=$CODE" | tee -a "$LOG"
tail -n 20 "$LOG"
git rev-parse HEAD                  # 基线 SHA，与台账逐字核对
git status --porcelain | wc -l      # 未提交项数（基线铁律）
```

> 为什么不用 PowerShell 重定向：`>`/`Out-File` 默认按 UTF-16 或 ANSI 码页落盘会写坏中文（与 `CONTRIBUTING.md` 铁律⑤ 同源）。用 Git Bash，或显式 `-Encoding utf8`。

**留档位置**：按 `COLLABORATION.md` §4.1 的唯一指定——提交正文 `验证：` 行 + 台账「闸门证据」列；进 H4 时贴 `DELIVERY.md` §五「闸门输出摘要」表（命令/退出码/≤5 行尾部）。不在 `deliverables/` 下新开子目录（`DELIVERY.md` §四 限定既有目录）。

| 项 | 红了的常见含义 | 先看哪里 |
|---|---|---|
| `lint` | 风格/未使用变量/`no-regex-spaces`/空 catch | 报错行；若快闸放过了，说明走了 `SKIP_HOOKS_LINT` |
| `test` | 行为回归，或守卫被同类改动合理触发（token、文案、内联事件） | `not ok <序号> - <用例名>` + `error:` 块；先判「实现错」还是「守卫该同步」 |
| `check:dead-deps` | 某条 asar 排除项被真的 `require` ⇒ 用户机器上 `Cannot find module` | `build/config.cjs` 排除清单 vs 报错包名 |
| `check:attack-surface` | 新增出网面/服务器代码，或把分组包从打包里排除 | 四条判据 A/B/C/D 的报错编号 |
| `check:icons` | `icon.png`/`icon.ico`/安装器 BMP 不合规（水印、白压白、尺寸档缺失） | 脚本 pass/fail 明细 |
| `build` | 打包或 rollup external 配置问题、`postbuild.js` 目录清单漏项 | vite 报错模块名 |
| `smoke:asar` | 产物内容不全（目录漏拷、平台文件没被扫到、版本号未同步；三个中文锚：恢复播放队列 / 未在播放 / 音频图初始化失败） | asar 内 `dist/` 与 `src/` 逐文件比对 |

> 为什么速查表要写「常见含义」：七项失败代价差三个数量级（`DELIVERY.md` §二），定位成本最高的是 `smoke:asar`——开发态跑的是 `src/` 不是 `dist/`，「本地全绿、装上是坏的」只有解开包逐文件比对才能发现。

## 十一、任务拆到文件级的最小粒度

**一个可执行任务 = 三要素齐全的一行**：`<文件路径> · <加/改什么（具体到函数或选择器）> · <如何验证>`

| # | 文件 | 改动 | 验证 |
|---|---|---|---|
| 1 | `src/shared/ipcContract.js` | `CHANNELS['song-story-refresh']`（invoke: MAIN；args `title`/`artist`/`lang`） | `node --test test/ipc-contract.test.js` 绿 |
| 2 | `src/main/ipc/register.js` | `handle` 注册该通道，handler 调 `services.songStory()` | 启动无「未声明在契约」；无人注册 warn 不含该通道 |
| 3 | `src/renderer/js/views/home.js` | `refreshStory()` 改调 `musicAPI.songStoryRefresh()` | DevTools 里调用返回对象 |
| 4 | `test/song-story.test.js` | 新增用例「同曲第二次点不出网」 | `npm test` 该用例名出现在 `# pass` |

**反例**：`优化 UI`、`提升性能`、`重构播放器`、`把设置页理顺`——共同缺陷是**无文件路径（不知改哪）、无可验证值（不知何时算完）**，接收方只能凭感觉开工。
> 为什么必须到文件：H2 判据①就是「每个任务能对应到具体文件路径」，H2 常见退回原因第一条是「粒度停在优化一下」。这不是形式——契约改动一旦少了②，表现是启动即抛，而写着「接入新通道」的任务清单会让②整整消失。

## 十二、覆写层（`src/renderer/styles/ui.css`）维护纪律

`ui.css` 靠**加载顺序 + 同特异度**取胜，属隐式依赖：它不在任何 import 图里，删掉一个 `<link>` 顺序不报错，只是全站回退。

**① 新增覆写必须注释「压的是哪个旧类、为什么不能直接改旧文件」**

```css
/* 压 .local-row（content.css:1204）：旧规则写死 gap/radius，已由 --sp-* / --r-* 统一；
   直接改旧文件会同时影响 3 个视图的 8 处调用，且失去「删掉本段即回滚」的能力。 */
.local-row { … }
```

**② 改共享旧类前先全仓搜使用处。** 阶段 3 换皮的跨视图复用统计（12 视图口径）：`.empty-state` 家族 4 处、`.action-btn` 3 处、`.btn-sm` 5 处、`.tab` 3 处、`.filter-tab` 2 处、`.song-row` 2 处——这既是「改一处覆写即统一多页」成立的前提，也是「改旧文件会误伤多页」的风险来源。

```bash
grep -rl 'empty-state' src/renderer/js | wc -l     # 以你实测的数字为准，别引用本文的老数字
grep -rn 'class="[^"]*action-btn' src/renderer/js | head
```

**③ 「写了不生效」先查特异性，不要加 `!important`。** 三步：`getComputedStyle` 取实际生效值 → 扫全库找「含目标类且特异度 ≥(0,2,0)」的规则 → 在 `ui.css` 用同形选择器显式重写。三个已知成因：后代选择器压制（§7.2 六处）、同名单类先后顺序（`.setting-btn` vs `.confirm-dialog-ok`/`--danger`）、以及「规则对了但元素没那个类」（`.btn-primary` 从未定义、`class="btn ghost"` 里 `ghost` 是空类）。
> 为什么单列一节：CSS 覆写失败是**全静默**的——`npm test` 绿、build 通过、`css-token-integrity` 也绿（它只管令牌与刻度，不管压制）。唯一暴露途径是人逐页看，而 12 视图 × 41 弹层不可能穷举。所以纪律必须前置到写代码那一步：**先注释写明压谁，再写规则**。

## 十三、本文件的修订

触发条件（命中任一即必须修订）：① `package.json` 的 scripts 增删改（§十 七项与速查表同 commit 更新）；② 新增/删除 `src/` 顶层目录或新的加载层（§十二）；③ 某个坑第二次复发（补守卫并在此登记，评估是否升级为门禁）；④ commit 类型集变更（§1.2）。
修订人：工程师提建议，架构师（本文件 owner，与 `COLLABORATION.md` §六 一致）落笔，`CHANGELOG.md` 对应版本记一行。
> 为什么不是「谁发现谁改」：同一事实两处维护必然漂移（铁律②）。`docs/RELEASING.md` 第一节从「没有远端」烂到 `origin` 配好 21 个 commit 之后——规范腐烂的成因不是没人写，而是没有必须改的触发条件。
