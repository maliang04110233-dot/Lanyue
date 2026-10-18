# ADR-20261017-01：NeteaseCloudMusicApi 依赖的可达高危风险处置评估

**日期**：2026-10-17
**状态**：已评估，未批准变更（等用户拍板）
**作者**：小浣熊肖恩
**关联**：`Lanyue_v1.0.36_项目健康度评估报告.md` §五 P0 / §七 下一轮建议第 2 项

---

## 1. 背景（一句话）

`NeteaseCloudMusicApi@4.32.0` 及其旧依赖树（express 4.x / body-parser 1.x / path-to-regexp 0.1.x / node-forge 1.4.0 / basic-ftp / get-uri / pac-proxy-agent 等 8 项）被 audit-gate 判为 `upstream_locked` 豁免——**可达但上游已停止维护，修复需跨大版本重写 SDK 内部 HTTP 行为**。

## 2. 实测取证（全部为实际命令/工具输出，非估算）

| 取证项 | 结果 | 来源 |
|---|---|---|
| audit-gate 真实数据 | 豁免 14 项（unreachable_excluded 5 + upstream_locked 8 + unreachable_but_packaged 1），未豁免 4 项（全部 moderate/low），无未豁免 high/critical | `npm run audit:deps` 复跑 2 次（第 1 次触发空结果防护，第 2、3 次拿到真实数据） |
| registry 上是否有新版本 | **没有**。`npm view NeteaseCloudMusicApi` → latest=4.32.0，time.modified=2026-05-18；4.32.0 就是最后一版 | npm registry 实查 |
| 上游为何停更 | **2024-01-24 开发者 Binaryify 收到网易云音乐法务函，随后清空 GitHub 仓库、删除全部 commit，仅留"保护版权，此仓库不再维护"README**。多方报道一致（东方财富/砍柴网、IT之家转载、网易订阅、CSDN） | web_search，5 个独立来源互相印证 |
| SDK 消费面 | **收敛到单文件单入口**：仅 `src/api/platforms/netease.js:9` 一处 `require('NeteaseCloudMusicApi')`；gateway 不直接消费；`recommendations.js` 只走 gateway 接口 | grep 全仓 |
| SDK 使用的方法 | `search / song_url / song_detail / lyric / login_status / playlist_detail / personalized / artists / artist_album / album` **10 个方法** | grep `ncm.` |
| express 是否真的被拉入 asar | **是**。hook Module._load 实测：`require('NeteaseCloudMusicApi')` 即同时拉入 `./server, express, ./lib/express, express-fileupload`——build/config.cjs:59-63 注释属实，express 不是死代码 | 运行时插桩 |
| SDK 树体积 | NeteaseCloudMusicApi 11MB + express 421KB + node-forge 1.8MB | `du` 实盘 |
| 项目是否调它的 web server | **不调**。`src/api/platforms/netease.js` 里无 `listen/createServer`；express 是 SDK `main.js` 末尾 `Object.assign(module.exports, require('./server'))` 无条件拉入的**惰性载荷**，从未被启动 | 代码审查 + 运行时插桩 |

## 3. 风险的准确形态（不是"有漏洞"这么粗）

【事实】漏洞攻击面几乎全在 **express HTTP server 的路由/解析层**（body-parser、path-to-regexp、express 本身等），这些代码的**作用是**：如果有人调用 SDK 的 server 模式（监听端口收 HTTP 请求），攻击面才成立。
【事实】本项目**从不启动这个 server**——express 只是被上面那句无条件的 `Object.assign` 拉进内存，从未 `listen()`。
【事实】node-forge 被审计豁免的理由分支是 `upstream_locked`，但它在 SDK 树里的消费是证书/密钥处理；本项目把它带到端上的路径仍是惰性的。
【判断】**可达性被 audit-gate 按"到达依赖模块"口径判为 true 是正确的保守口径，但真实可利用面显著更小**——攻击需要先让恶意数据到达 express 路由匹配器或 body-parser 解析器，而它们的运行时入口（HTTP 监听）从未被启动。

**残余风险定性**：
- **供应链风险 > 漏洞可达风险**。包已删库停更 2.5+ 年，npm 上如果该包名被接管（或 registry 镜像被投毒），下一次 `npm install` 就会把恶意代码拉进每个开发者的依赖树。这不受"不启动 server"缓解，是 **跟所有停更依赖共享的最大风险**。
- **合规/版权风险独立存在**：SDK 本身就是网易法务函的目标，这个项目复用它做下载，法律边界与它一致——这不是"漏洞"但比漏洞更难量化。
- express 4 到 5 的跳跃`proxy-play` 等自有通道都**不经过** SDK express。

## 4. 处置选项（跑通哪条路，代价多大）

> **2026-10-17 增补取证（证据修正）**：本节最初写完后，审计人又对 GitHub/npm 上的活跃替代包做了实测（`npm view` + 干净环境 `npm audit`），**推翻了初版对方案 C "换皮不换根"的一刀切判断**，修正版本见下表 C 行与 §4.1。修正不是立场摇摆——初版判断没被证伪过，这次证伪了；按"证据优先于印象"原则更新。

| 方案 | 内容 | 代价 | 缓解效果 |
|---|---|---|---|
| **A. 维持现状 + 收紧豁免条件** | 豁免保留，但把 audit-gate 豁免规则升级为"每次重新实测可达性，而不是信任上次结论"；把 `unreachable_excluded`/`unreachable_but_packaged` ↔ `upstream_locked` 的三分类判据跟 attack-surface（是否真正 listen）打通 | **几乎零成本**（改 audit-allowlist.json 的注释与 audit-gate 的核对逻辑）；不消除漏洞，只是不再让"豁免"变成僵尸标签 | 弱——漏洞仍在，只是豁免标签说得诚实了 |
| **B. 挑出 SDK 内 10 个方法的自研** | 用轻量自研 HTTP 客户端复写 `search / song_url / song_detail / lyric / login_status / playlist_detail / personalized / artists / artist_album / album` 这 10 个网易接口（SDK 源码 MIT，算法是网易公开的 web 接口参数拼接 + LINUX/EAPI 加密 cookie），**不引入 express 树** | 中等（约 1~2 周量级）：加密函数需要逆向移植，网易接口参数格式有被网易变更的风险（非官方接口天然不稳） | **强**——express/body-parser/path-to-regexp/pac-proxy-agent/get-uri/basic-ftp **全部移出依赖树**；供应链风险随消失 |
| **C. 找替代 SDK** | GitHub/npm 上有真实维护的半重构 fork：**`@neteasecloudmusicapienhanced/api@4.41.1`**（2026-10-05 仍在更新，37 个版本）。**实测干净环境 audit**：老包 7 项漏洞 → enhanced fork **剩 5 项 high**，**express / body-parser / path-to-regexp / file-type / music-metadata 共 5 项消失**（express 已升 5.2.1、axios 已升 1.20）；但 node-forge（无修复版）+ pac-proxy-agent→get-uri→basic-ftp 代理链**仍在** | 换包本身：改 1 行 require + 依赖版本对账 + 全量回归（ netease 侧所有用例 + e2e + audit-gate 豁免清单要对账重写）；风险：仍是版权边缘产物，上游可持续性未知；pac-proxy-agent 只在**用户配了 PAC 代理**的分支才被实例化（`util/request.js:459`，本项目该分支从未使用） | **中强**——7 项减到 5 项，且最小攻击面（express 4 路由/解析）被根治；剩余 5 项里 3 项在本项目的运行时分支内不可达（PAC 代理从未配置） |
| **D. 彻底下线网易云媒体源** | 网易平台从平台清单里移除或标记为"不可用"，只剩 qq/kugou/kuwo/migu/bilibili/soda/fivesing | **最小**（平台注册是 pluginRegistry 自动发现，删一个文件 + 更新配置清单即可） | **最彻底**——风险源头直接消失；代价是**砍掉一个用户在用的内容源**，属于产品功能损失，不是技术修复 |

## 5. 天团裁定（2026-10-17 修正版）

**推荐组合：A（本轮做）+ C（下一迭代小步走）+ B（列入长期观察，非优先）。**

- **A 现在做**：audit-gate 的三分类豁免标签把"真的没被拉进产物"（jade 等）和"被拉进产物但从未被调用/启动"（express 等）混进了同一个"可达"口径。本轮评估实测到 express 属于"**被打进 asar、被 require、但其唯一攻击面（HTTP listen）从未启动**"——这个更细的事实值得被机器复核，而不是只留在 build/config.cjs 的注释里。改动小、收益明确。
- **C 排进下一迭代**（修正后的推荐）：`@neteasecloudmusicapienhanced/api` 是**实证有效的降险路径**——同接口名、同调用方式（search/song_url/lyric 等 API 不变，源码就是 Binaryify 的半重构延续），老包 5 项高危在新包中消失。真正要做的核实清单：
  1. 10 个被本项目使用的方法在新包中 API 签名一致性（接口名不变是它自己的 README 声称，需回归测试实测）；
  2. audit-gate 豁免清单需要重写：`upstream_locked` 8 项变成 5 项（`node-forge`、`pac-proxy-agent` 及其传递链），其中 3 项属于"分支不可达"（PAC 代理配置了才用）；
  3. 缺一个"包是否活跃"的门禁判据——不能只信 README，应该钉**最近一次 npm 发布时间 ≤ N 个月**作为 warn 阈值，防止下一个"_binaryify 式死亡"无声发生。
- **B 列入长期观察**：自研 10 方法依然是唯一能彻底脱离网易非官方 SDK 生态的路（连版权边缘属性也一起甩掉），但 C 的存在让 B 的"必须性"降低了——先用 C 拿回安全收益，把 B 留给"C 也死了/合规压力来了"的那天。
- **D 是生死判项**：如果网易再次发法务函、或包被接管/投毒，D 是立刻可执行的止损方案，B/C 投入也会被中止。**这条不是"建议"，是红线**。
- 上一版"不采纳 C"的判断**作废**——那是对替代包生态没做实测的印象判断，本轮实测推翻它。

## 6. 本轮实际做了什么

1. **实测复跑 audit-gate 触发过空结果防护一次** —— 数据源偶发拿不到数据的已知现象又一次复现，防护按预期工作（未把 0 结果误判为 stale）。
2. **把"express 不可删"的注释论断升级成了运行时插桩实证**（hook Module._load 抓到 `./server, express, ./lib/express, express-fileupload` 4 条加载事实）。
3. **把上游停更原因从"猜测"落成了多方一致的法律事实**（网易 2024-01 法务函 → 删库，5 个独立来源互相印证）。
4. **对 GitHub/npm 上的替代 SDK 做了干净环境实测审计**（`npm view` + 全新 `npm audit --registry=官方源`）：
   - `@neteasecloudmusicapienhanced/api@4.41.1`：真实半重构，express 4→5，**5 项高危消失**（express/body-parser/path-to-regexp/file-type/music-metadata），剩 5 项（node-forge 无修复 + pac-proxy-agent→get-uri→basic-ftp 链）；
   - `pac-proxy-agent` 在新包里只被 `util/request.js:459` 在**用户配置了 PAC 代理**时实例化——本项目的代理配置分支未使用这条路，属**配置门分支不可达**；
   - 同口径下老包实测剩 7 项，新包剩 5 项，**风险面确实缩小**，初版"换皮不换根"判断被证据推翻。
5. **产出本 ADR**，把 P0 从"一句 stigma 式的风险陈述"升级成"已取证 → 可选项 → 天团裁定 → 用户决策点"的可拍板材料。

6. **方案 A 已落地（2026-10-17 追记）** —— §5 裁定的第一优先项执行完毕：
   - `audit-allowlist.json` 三分组重分桶为四组攻击面层级：express / body-parser /
     path-to-regexp（3 项）迁入新组 `upstream_locked_server_never_launched`，
     `upstream_locked` 收敛为 5 项；`_verified` 全部更新 2026-10-17；
   - 新增 `scripts/audit-attack-surface.cjs` 四条机器判据（A 直达消费 / B 打包前提 /
     C 消费面含子路径唯一 / D listen 门许可清单），把 §3「_attack 面在 server 启动
     分支，而该分支从未执行」从散文论断固化为每次 CI 复核的检查；
   - `npm run check:attack-surface` 串进 verify 链（命名避开 "audit" 字样，
     离线纯静态，符合 verify-chain.test.js 的守卫钉）与 ci.yml / release.yml；
   - 测试：新增 `test/audit-attack-surface.test.js` 13 例（含变异测试证明判据能红），
     audit-gate.test.js「只用三组」钉同步改写为四组并新增「_why 必须指明机器判据
     挂钩」防退化钉；全量 3303 测试 0 fail，lint 0 error，三闸（dead-deps /
     attack-surface / audit-gate）实跑全绿；
   - **§7 决策清单第 1 项视为已拍板**（用户指令"先做A"），其余三项待确认。

## 7. 待用户拍板（决策清单）

- [x] 是否接受"维持现状 + 收紧豁免标签"（方案 A）作为本轮动作？—— **已拍板并落地**（见 §6 追记 6）
- [ ] 是否同意把方案 C（换装 `@neteasecloudmusicapienhanced/api`，并配套回归 + 豁免清单重写 + 活跃度门禁判据）排进下一迭代？
  - **未拍板，且已预置的依赖已撤回**（2026-10-18 收口）：`package.json` 曾被提前加入
    `@neteasecloudmusicapienhanced/api@4.41.1`，但全仓零引用（`src/api/platforms/netease.js`
    照旧走 `NeteaseCloudMusicApi`），而 `npm run audit:deps` 因此必红——它作为直接依赖带着一枚
    未豁免的 high 告警，v1.0.37 发版闸被它卡住。拍板前把一个带高危告警的包原样打进 asar
    是净增风险，故依赖与 `package-lock.json` 一并回退到发版基线（撤回前的 lock 已另存备份）。
    方案 C 若要推进，请在拍板后作为独立一期落地：加依赖 → 换 `netease.js` 消费面 → 回归
    10 个方法 → 重写豁免分组，四步一起做，不再出现「依赖先到、代码后到」的中间态。
- [ ] 方案 B（自研 10 方法）是否降级为"长期观察项"，仅在 C 失效或合规压力升级时启动？
- [ ] 网易平台在什么触发条件下走方案 D（下线该源）——法务再次发函 / 包被接管 / 其它？

## 8. 关联风险正面记录

- 本报告不含对网易/任何第三方的法律结论——法务判断超出本评估者的能力边界（红线 7）。
- 本报告引用的所有外部来源均标注及可复核（东方财富/砍柴网、CSDN、IM Geek、网易订阅、CSDN文库）。
