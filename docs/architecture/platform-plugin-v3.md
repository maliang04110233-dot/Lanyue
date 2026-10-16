# MusicDL 音源平台架构重设计（v3）

> 状态：**已实施** ｜ 目标版本：1.1.0 ｜ 2026-09-17 设计
> 实施证据（2026-10-15 核验）：`src/api/pluginRegistry.js`（PluginRegistry + PlatformManifest 自描述
> 契约 + 自动发现 + validate 抛错）、`src/api/gateway.js`（能力检查/cookie 注入/统一出口）、
> 8 个平台文件均导出 manifest；能力由方法存在性推导（CAPABILITY_METHODS 表），策略字段由
> manifest 显式声明（fallbackSource/probeable/order/aggregateLimit）；UI 平台清单从 registry 派生
> （index.html 仅留"全部"一个 option）。`test/platform-contract.test.js` + `test/gateway.test.js`
> 68/68 通过。能力声明驱动源接口层的研究提案（P1）就此闭合。
> 触发：平台从 1 个增长到 8 个（netease / qq / bilibili / kugou / kuwo / migu / fivesing / soda），
> 「加一个平台」的成本与出错率随数量线性上升，已到了必须收敛的临界点。

---

## 1. 摘要

当前**没有一个地方能回答「我们支持哪些平台」**。这个概念被复制成 **20 份形态各异的字面量**，
散在渲染层、主进程、API 层、网络层、i18n、CSS 和测试里，而且**它们故意互不相同**：

| 清单 | 数量 | 与其它清单不同的原因 |
|---|---|---|
| `_ADAPTERS` | 8 | 能力全集 |
| `PROBE_SOURCES` | 8 | 探针要覆盖全部 |
| `ALLOWED_ORIGINS` | 20 域名 | 按平台子域 |
| `CANDIDATE_SOURCES` | **7** | 故意排除 bilibili（其 artist 是 UP 主名，参与换源只会制造错配） |
| `getSongByLink` 分支 | **4** | 只有 4 家实现了链接直取详情 |
| `sourceSelect` | 8 | UI 展示 |

**这些差异是业务规则，不是疏漏**——但它们在代码里没有任何命名、注释或测试来承载，
下一次有人加平台时只能靠"记得改哪几处"。

**v3 目标**：把「平台」收敛为**单一事实来源（Single Source of Truth）**，
每个平台一个自描述文件；其余 19 处**全部由它派生**。

| 指标 | 现状 | v3 |
|---|---|---|
| 加一个平台要改的文件数 | **13 个文件 / 20 处** | **1 个文件** |
| 漏改的后果 | 静默失效（徽标掉色、探针查不到、CORS 被拒、跨域取流失败） | 契约测试直接红 |
| 平台能力（专辑/歌手/榜单）查询 | 无统一入口，靠 `plugin.searchAlbum` 有没有来猜 | `registry.getCapabilities(id)` |
| 「能否参与跨源换源」 | 隐含在数组字面量里，无注释 | `policies.fallbackSource` + 注释 |

> **§2 以下所有数字均为机器实测，非目测推算。** 由 `.preview/platform-baseline.mjs`
> 从**运行时 registry + 源码字面量**双向采集，快照落在 `.preview/platform-baseline.json`——
> 它既是阶段 0 的交付物，也是后续所有派生比对的黄金基准。
> 当前实测：registry **8** · 换源候选 **7**（差集恰为 `bilibili`）· 探针 **8**（两处数组**完全相同**）·
> CORS **20** 域名 + **3** 后缀 · linkParser **11** 规则 / **4** 平台 · 下拉框 **9** 项 ·
> 名称映射 **3** 份 · badge **8** 类（无缺配色）· i18n 平台键 **16/16**。
>
> ⚠️ 建这份基线时立即抓出本稿一处错误：CORS 域名我先按肉眼数成了 22，实测是 **20**。
> 这恰好说明为什么"派生一致性"必须靠机器比对，而不是复核者的眼睛。

---

## 2. 现状：22 个耦合点全表

> 全部为 2026-09-17 实测定位（文件:行），非推断。

> ⚠️ **编号 21/22 是实现期补的**（初稿只列了 20 处）：
> - **21 · 徽标配色**：`styles/content.css` 里 8 条 `.badge-<id>` 硬编码规则，类名由
>   `badge-${source}` **动态拼接**——漏补不报错，只静默回落默认配色（"静默掉色"）。
> - **22 · 平台能力分派**：`src/api/recommendations.js` 直接 `require('./platforms/{netease,qq,kugou,bilibili}')`
>   并按 id if/else 分派 `searchSinger` / `getSingerSongs` / `getSingerAlbums` / `getAlbumSongs`，
>   **完全绕过 registry** ⇒ 新平台即使声明了这些能力也走不通。
>   ⚠️ 这是 v3 唯一**遗留未重构**的耦合点（改动面大），已用契约测试钉住：
>   平台声明了某能力却没接进分派链，`test/platform-contract.test.js` 会红。

### 2.1 平台事实（描述"这个平台是什么"）

| # | 位置 | 形态 |
|---|---|---|
| 1 | `src/api/index.js:18-25` | 8 条 `require('./platforms/x')` |
| 2 | `src/api/index.js:29-105` | `_ADAPTERS` 数组：id/name/icon + 把具名函数包成标准接口 |
| 19 | `src/utils/linkParser.js:30-90+` | `PATTERNS` 数组，每条 `{ platform, type, re }` 硬编码链接正则 |
| 11 | `src/main/index.js:541-566` | `ALLOWED_ORIGINS`：20 个域名，靠注释按平台分组 |
| 12 | `src/main/index.js:569` | `ALLOWED_ORIGIN_SUFFIXES`：3 个动态 CDN 后缀 |

### 2.2 场景策略（描述"这个平台参与哪些流程"）

| # | 位置 | 形态 | 隐含规则 |
|---|---|---|---|
| 8 | `src/utils/matchMusic.js:21` | `CANDIDATE_SOURCES`（7 个） | 排除 bilibili，**无注释** |
| 9 | `src/main/ipc/search.js:125` | `getSourceHealthMap([...])` 8 个 | 探针覆盖全部 |
| 10 | `src/main/ipc/search.js:131` | `PROBE_SOURCES` 8 个 | **与 #9 完全重复** |
| 4 | `src/api/index.js:396-399` | `if/else if` 4 个平台 | 链接详情能力子集 |
| 7 | `src/api/index.js:165-171` | `i === 0 ? 10 : i === 1 ? 10 : 5` | 聚合条数**按注册下标**分配 |

> ⚠️ #7 是本次调研新发现的隐患：聚合搜索每个平台返回多少条，取决于它在 `_ADAPTERS`
> 里的**数组位置**。将来调整平台顺序会静默改变搜索体验，且没有任何测试盯着它。

### 2.3 展示与文案

| # | 位置 | 形态 |
|---|---|---|
| 13 | `src/renderer/index.html:165-173` | `<select id="sourceSelect">` 8 个静态 `<option>` |
| 14 | `src/renderer/js/player.js:230` | `SOURCE_NAMES` 映射 |
| 15 | `src/renderer/js/views/settings.js:155` | `SOURCE_NAMES` **同一份抄了第二遍** |
| 16 | `src/renderer/js/utils.js:43` | 同内容**内联匿名对象**（第三遍） |
| 17 | `src/renderer/styles/content.css:409-419` | `.badge-netease` … `.badge-soda`（`badge-${source}` 动态拼类名） |
| 18 | `src/renderer/js/lang/zh.json` + `en.json` | 平台名键，**命名还不统一**（`search.kugou` / `home.qqTab` / `home.biliTab`） |

### 2.4 机制与兼容层

| # | 位置 | 形态 |
|---|---|---|
| 3 | `src/api/index.js:109-111` | 注册循环 |
| 5 | `src/api/index.js:367` | `getLyrics` 的 fallback 2 **直连 `kugou.kugouGetLyricsByTitle`**，绕过 registry |
| 6 | `src/api/index.js:458-465` + `472-474` | `module.exports` 导出 8 个原始模块 + `qqSearch` 等兼容别名 |
| 20 | `src/main/preload.js:36` / `168-169` | `SAFE_CHANNELS_INVOKE` + `METHOD_MAP`（**新增 IPC 才需要改**） |
| 21 | `test/{fivesing,migu,soda}.test.js` … | 每平台一个测试文件（无"所有平台共同契约"的测试） |

---

## 3. 根因

### 3.1 缺 SSOT
`pluginRegistry.js` **已经写好但没被用起来**：

- 它的 `loadPlatformPlugins()`（扫描 `platforms/` 自动发现）**全仓零调用**（`grep loadPlatformPlugins` 只命中定义处）。
- 它的注册条件要求 `pluginModule.id && pluginModule.search`，而 8 个平台文件**全是多具名函数导出**
  （`{ bilibiliSearch, bilibiliGetUrl, ... }`），没有 `id`，因此**即使被调用也会全部跳过**（只打一条 warn）。
- `api/index.js` 走的是自己的路子：手写 `_ADAPTERS` 数组 + 手动 `register`。
  `defaultRegistry` 拿到了，但**只用于路由**，没用于派生任何清单。

⇒ 结论：现有 `pluginRegistry.js` 是一个**中途停下的重构**，留下了"看起来是插件架构、
实际上平台清单仍然手写"的半成品。v3 要把它做完，而不是推翻。

### 3.2 两类知识被混为一谈
「平台是什么」（事实）与「平台在此流程中扮演什么角色」（策略）混在同一个数组字面量里。
事实可以自动派生，策略必须显式声明。v3 用 `manifest` / `policies` 两个字段把它们分开。

### 3.3 隐式契约无守卫
「方法存在 = 能力存在」是当前唯一的表达方式（例如 `kuwo` 没有 `searchAlbum` 就是没有专辑能力）。
它**本身是合理的**（省一处维护），但缺少一个**遍历所有平台**的契约测试来兜住它。

---

## 4. 目标架构

### 4.1 分层

```
┌─ 平台层（唯一事实来源）────────────────────────────────────┐
│  src/api/platforms/<id>.js                                 │
│    = manifest（事实：id/name/icon/hosts/quality/linkPatterns）│
│    + policies（策略：能否换源/是否探针/聚合权重）             │
│    + 实现（search / getUrl / getLyrics / …）                │
└──────────────────────┬────────────────────────────────────┘
                       │ 扫描目录 + 校验
                       ▼
┌─ 注册中心（src/api/pluginRegistry.js）─────────────────────┐
│  自动发现 · manifest 校验 · capabilities 推导 · 策略查询     │
└──────────────────────┬────────────────────────────────────┘
                       │ 派生（全部为纯函数）
     ┌─────────────────┼──────────────────┬─────────────────┐
     ▼                 ▼                  ▼                 ▼
  路由            换源候选集          探针清单        CORS 白名单
 (api/index)   (matchMusic)   (ipc/search)     (main/index)
                       │
                       ▼
              ┌─ IPC: get-platforms ─┐
              │  渲染层启动拉取一次   │
              └──────────┬───────────┘
                         ▼
    sourceSelect 动态生成 · platformName(id) · badge 配色 · 能力驱动 UI
```

### 4.2 PlatformManifest 接口

平台文件改为导出**一个自描述对象**（示例用 migu，最简形态）：

```js
// src/api/platforms/migu.js
module.exports = {
  // ── 事实 ──
  id: 'migu',
  name: '咪咕音乐',
  nameEn: 'Migu',
  icon: '🎼',
  badge: { fg: '#a78bfa', bg: 'rgba(167,139,250,.14)', border: 'rgba(167,139,250,.24)' },

  // 网络事实：CORS 白名单由此派生（原来是手写 20 条）
  hosts: {
    origins: [
      'https://pd.musicapp.migu.cn',
      'https://c.musicapp.migu.cn',
      'https://d.musicapp.migu.cn',
      'https://freetyst.nf.migu.cn',
      'https://music.migu.cn',
    ],
    originSuffixes: [],        // 动态 CDN 才填，如 soda 的 '.douyinvod.com'
  },

  // 链接识别：原来是 linkParser.js 里的 PATTERNS 数组
  // ⚠️ extract 是必需的 —— parseMusicLink 靠它从匹配结果里取 id
  //    （实现期修正：初稿只写了 type/re，直接照做会让链接识别静默失效）
  linkPatterns: [
    // { type: 'song', re: /.../, extract: m => m[1] }
  ],

  // ── 策略（必须显式，因为无法从代码推导）──
  policies: {
    order: 60,              // 展示与聚合顺序（小者在前）
                            // ⚠️ 实现期新增的必填字段：顺序决定聚合权重与 UI 排序，
                            //    不能依赖 readdir 的文件系统返回顺序。旧值见下方映射表。
    fallbackSource: true,   // 参与跨源换源候选
    probeable: true,        // 参与可用性探针
    aggregateLimit: 5,      // 'all' 聚合搜索时最多取几条（原来是按下标 10/10/5）
    supportsQuality: ['128k', '320k'],
  },

  // ── 实现（方法存在 = 能力存在，capabilities 由此推导，不额外声明）──
  search: miguSearch,
  getUrl: miguGetUrl,
  getLyrics: miguGetLyrics,
};
```

全能力平台（qq）在此基础上多 `verifyCookie` / `searchAlbum` / `getAlbumSongs` /
`searchSinger` / `getSingerSongs` / `getSingerAlbums` / `getSongDetail`。

**关键设计：`capabilities` 不写进 manifest，由 registry 推导。**

```js
// registry 加载时
plugin._caps = Object.freeze({
  album:  typeof plugin.searchAlbum === 'function',
  singer: typeof plugin.searchSinger === 'function',
  lyrics: typeof plugin.getLyrics === 'function',
  linkDetail: typeof plugin.getSongDetail === 'function',
  cookie: typeof plugin.verifyCookie === 'function',
});
```

理由：避免"声明了 `album: true` 但忘了实现 `searchAlbum`"这种**两处不一致**。
方法存在是唯一事实。UI 想查"哪些平台支持专辑"→ `registry.filter(p => p._caps.album)`。

### 4.3 注册中心职责（改造现有文件，不新建）

| 方法 | 作用 |
|---|---|
| `loadPlatformPlugins(registry)` | **改为真正被调用**；扫描 `dist/api/platforms/`；校验 manifest |
| `validate(plugin)` | 缺 `id`/`search`/`name`/`hosts` → 抛错（**当前是静默跳过**） |
| `getCapabilities(id)` | 推导出的能力 |
| `getProbeSources()` | `policies.probeable === true` 的平台 id |
| `getFallbackSources()` | `policies.fallbackSource === true` 的平台 id |
| `getLinkPatterns()` | 汇总所有 `linkPatterns`，供 linkParser 使用 |
| `getAllowedOrigins()` | `{ origins: Set, suffixes: [] }`，供 CORS 使用 |
| `toClientPayload()` | 序列化给渲染层（剔除函数，只留展示与能力） |

> ⚠️ **打包可行性已实测确认**：`src/api/` 是**整目录复制**到 `dist/api/`（`scripts/postbuild.js`
> 的 `copyDir`），vite 只 bundle `src/main/index.js` 入口。`dist/api/platforms/*.js` 8 个文件
> 独立存在，`fs.readdirSync(path.join(__dirname, 'platforms'))` 在 dist 与 app.asar 内均成立。
> 这是自动发现方案的前提，已验证，非假设。

### 4.4 渲染层契约

新增一个 IPC：`get-platforms`（一次性，启动拉取）。

```js
// 渲染层 init 阶段
const platforms = await api.getPlatforms();   // [{ id, name, icon, badge, capabilities, policies }]
window.__PLATFORMS = platforms;
renderSourceSelect(platforms);                // 动态生成 <option>
```

改动对应：

| 现状 | v3 |
|---|---|
| `index.html` 静态 8 个 `<option>` | 运行时生成（HTML 只留 `<option value="all">`） |
| `SOURCE_NAMES` ×3（player / settings / utils） | 单一 `platformName(id)`，查 `__PLATFORMS` |
| `.badge-<id>` ×8 条 CSS | 由 manifest.badge 注入 CSS 变量，CSS 规则收敛为一条 |
| i18n 里 16 个平台名键（zh+en） | **移除**（专有名词不需要翻译），改用 `name` / `nameEn` |

⚠️ **顺序陷阱（必须写进实现注意事项）**：`applyTranslations()` 与动态生成 `<option>` 的先后。
平台名不再走 i18n，但 `<option>` 上的其它文案仍走。正确顺序是
**先拉清单 → 生成 option → 再 applyTranslations()**，否则新插入的节点拿不到翻译。
（本项目已有同类教训：无头截图时"先 applyTranslations 再灌桩数据"导致 `.account-status` 丢翻译。）

### 4.5 降级路径（必须有）

验证台会用桩替换 `app.js`，`window.__PLATFORMS` 可能不存在；主进程 IPC 也可能尚未就绪。
因此 `platformName(id)` 必须降级：`__PLATFORMS` 缺失时返回**内置兜底表**
（从 registry 构建期生成，或直接 `return id`）。**不允许因为拉取失败而让界面炸掉。**

---

## 5. 设计决策与权衡

| # | 决策 | 被否方案 / 理由 |
|---|---|---|
| D1 | manifest 内嵌在平台文件里 | ❌ 独立 `platforms.json` 注册表：加平台要改 2 个文件，且事实与实现分离，易失配 |
| D2 | `capabilities` 由方法存在性**推导** | ❌ 显式声明：会与实现两处不一致；本项目已因"汽水虚报 searchAlbum"踩过同类坑 |
| D3 | `policies` **显式声明** | ❌ 也推导：换源资格 / 探针资格是**业务规则**，代码里没有可推导的依据 |
| D4 | 平台清单走 IPC 下发 | ❌ 构建期生成静态 JSON：渲染层仍需构建期耦合，且改了平台要重新 build 才能看到。IPC 让"加平台"完全落在主进程一侧 |
| D5 | 平台名退出 i18n | ❌ 保留 i18n 键：专有名词（QQ音乐 / 5sing / B站）翻译收益为零，却要维护 16 个键且命名已经不统一 |
| D6 | badge 配色进 manifest + CSS 变量注入 | ❌ 保留 `.badge-<id>` 类名：**漏洞在于静默**——加平台忘了补 CSS 不报错，只掉回默认色。变量注入让"没有配色"变成可断言的缺失 |
| D7 | CORS 白名单由 `hosts` 派生 | ⚠️ **但有安全前提**，见 §7 R1。派生结果必须与现状快照**逐条相等**，不允许出现新增项 |
| D8 | 保留老式具名导出（阶段 1-2） | ❌ 一步删干净：渲染层 `buildApi` 与主进程仍可能引用，一次性删除会静默断链。改为"先证明无调用方再删"（阶段 3） |
| D9 | `getLyrics` fallback 改为遍历 registry | ❌ 保留直连 `kugou.*`：它绕过插件抽象，是新平台无法参与 fallback 的原因。改为"按 fallbackSource 策略顺序尝试" |

---

## 6. 迁移路径（5 阶段，每阶段独立可验收、可回滚）

> ⚠️ 动手前：`.backup/platform-v3-<date>/` 备份全部待改文件；每阶段结束跑四道闸。

### 阶段 0 · 基线快照（不改代码）
把现状**导出成 JSON 快照**，作为后续所有比对的黄金基准：
- `registry.getAll()` 的 id 顺序与名称
- `getSourceHealthMap` 的 8 个源
- `ALLOWED_ORIGINS`（20 条）与 `ALLOWED_ORIGIN_SUFFIXES`（3 条）
- `CANDIDATE_SOURCES`（7 条）
- `linkParser` 支持的 platform 集合（4 条）
- 每个平台的能力矩阵

产物：`.preview/platform-baseline.json`。**验收：快照内容与 §2 表格逐条一致。**

### 阶段 1 · 建立 SSOT
- 8 个平台文件尾部追加 manifest 字段（`id/name/nameEn/icon/badge/hosts/linkPatterns/policies`）+ 实现方法提升到顶层
- `pluginRegistry.js`：加 `validate()`、`getCapabilities()`、派生查询方法；`loadPlatformPlugins` 改为可用
- `api/index.js`：`_ADAPTERS` → 改为 `loadPlatformPlugins()`；**路由函数签名与行为完全不变**

**验收**：`registry.size === 8`；启动日志平台顺序与快照一致；`npm test` 全绿；
**渲染层与主进程的其它文件本阶段一行未改**（可用 `git diff --stat` 证明）。

### 阶段 2 · 派生消费方（一处一改，每改一处立即比对快照）
按顺序：① 探针（`ipc/search.js` 两处合并为一次派生）→ ② 换源候选（`matchMusic.js`）
→ ③ CORS（`main/index.js`）→ ④ `getSongByLink`（改用 `capabilities.linkDetail`）
→ ⑤ `getLyrics` fallback（改用 registry）→ ⑥ 聚合权重（改用 `policies.aggregateLimit`）
→ ⑦ **`linkParser.js` 的 `PATTERNS`（改用 `registry.getLinkPatterns()`）**

> ⚠️ **⑦ 是实现期补的**：初稿把「linkParser 平台正则」列进了 §2 的 20 个耦合点，
> 却漏进本阶段清单。若不改，新平台即使声明了 `linkPatterns` 也不生效——
> 派生能力备好了而没人消费，等于没做。

**验收**：每一项派生结果 == 阶段 0 快照；四道闸全绿。

**实现状态（2026-09-17）**：阶段 0/1/2 已完成，验收 15/15 PASS。
验收脚本 `.preview/verify-platform-v3.cjs`（可重复运行）。
两处**已知且已接受**的差异：
- 探针清单顺序由 `kugou…bilibili` 变为 registry 顺序（bilibili 归位到第 3），
  集合相等、无功能后果（仅影响设置页探针列表的展示顺序）。
- `_ADAPTERS` 中 netease/qq/kugou 声明的 `searchSinger/getSingerSongs/getSingerAlbums/
  getAlbumSongs` 实际由 `recommendations.js` 提供服务，registry 里这些声明**无调用方**
  （实现期保留以零风险，阶段 3 复核后再决定去留）。

### 阶段 3 · 渲染层收敛 + 清理
- 新增 IPC `get-platforms`（含 preload 三处登记）
- `index.html` 静态 option → 动态生成；`SOURCE_NAMES` ×3 → `platformName(id)`
- badge CSS 收敛为变量驱动；i18n 移除 16 个平台名键（zh/en 同步，键集合必须仍一致）
- 删除已证明无调用方的兼容导出

**验收**：无头验证台（`shot-player-redesign.cjs` 等）全绿；i18n 检查器零缺失；
无头截图确认下拉框 8 项 + 徽标配色正确。

**实现状态（2026-09-17）：已完成。** 落地内容与初稿的出入：
- IPC `get-platforms` 三处登记：`ipc/search.js` 处理器、`preload.js` 的 `SAFE_CHANNELS_INVOKE` +
  `METHOD_MAP.getPlatforms`；渲染层入口 `window.__PLATFORMS`。
- 平台名单一来源落在 `utils.js` 的 `platformName(id)`：**英文取 `nameEn`**（初稿 D5 的两个字段都用上了）；
  清单缺失时回落内置 `FALLBACK_PLATFORM_NAMES`（降级路径，§4.5）。
- 徽标改为 **manifest 注入 CSS 变量**：`.source-badge` 只消费 `var(--badge-bg|fg|border)`，
  注入点 `#platformBadgeTheme`。比初稿的「CSS 变量驱动」更彻底——8 条硬编码规则已**删除**。
- i18n 实际移除 **11 个平台名键**（初稿写 16，含 5 个从未被引用的），两文件 258→247 行、键集合仍一致。
- `api/index.js` 清理：删除 8 个仅供再导出的 `require`、8 个原始模块再导出、3 个 `qq*` 兼容别名
  （前置依据：全仓调用方普查零命中，含 `scripts/`、`.preview/`）。
- **顺带修掉两个真 bug**（非 v3 范围，但被本轮触发）：① `window.i18n` 全仓零赋值点 ⇒ 语言切换
  一直是死代码；② `applyTranslations()` 无条件从 pref 回读，会把 `setLanguage()` 刚设的语言覆盖回去。
  另硬化 `applyTranslations`：只对**无子元素**节点写 `textContent`，否则会摧毁设置页含 `<code>` 的提示框。

**验收证据**：`.preview/verify-source-select.cjs` **23/23**（真实 Chromium 加载真实生产模块 +
真实 registry payload：下拉 9 项且顺序==registry、平台名取 manifest、切 en 走 `nameEn`、
徽标 8 条变量注入且配色生效、三条降级路径、零 JS 错误）。

### 阶段 4 · 防回归（这一步才让 v3 成立）
新增 `test/platform-contract.test.js`：
1. **契约完整性**：遍历 registry，断言每个平台有 `id/name/search/getUrl/policies.hosts`
2. **派生一致性**：`getProbeSources()` / `getFallbackSources()` / `getAllowedOrigins()` 与快照逐条相等
3. **UI 一致性**：`toClientPayload()` 的平台数 == 探针数 == 下拉框数（含 bilibili 的差异在策略里有据可依）
4. **badge 完整性**：每个平台的 `badge` 字段齐全（消灭"静默掉色"）
5. **无硬编码守卫**：断言 `matchMusic.js` / `ipc/search.js` / `main/index.js` / `renderer/js/utils.js`
   源码中**不再出现平台 id 字面量数组**（正则扫描，防止将来有人又写死一份）

新增 `docs/architecture/ADD-A-PLATFORM.md`：加平台 SOP（1 个文件 + 跑测试）。

**实现状态（2026-09-17）：已完成，`test/platform-contract.test.js` 30 个用例全绿。**
实际覆盖 6 类（比初稿的 5 条更细）：
1. **manifest 完整性**：必填字段、badge 三色齐全、`name` 与 `nameEn` **互异**、策略显式声明；
2. **派生一致性**：顺序 == 冻结的 8、探针 == 全 8、换源 == 7（排除 bilibili）、
   聚合权重 10/10/5、链接 4 平台带 `extract`、**🔴 CORS 18 域名逐条相等** + 3 后缀带前导点 + 本地源独立共 20；
3. **渲染层契约**：`toClientPayload()` 剔除函数、能力推导、`index.html` 内联 option 只剩 `all`、
   `renderSourceSelect` 不内联平台 id、`app.js` 的「拉清单 → 生成 → 翻译」顺序、`utils.js` 降级；
4. **无硬编码守卫**：主进程侧无平台 id 清单、`utils.js` 仅兜底表豁免、`api/index.js` 不再 require 平台模块；
5. **未覆盖耦合点钉住**：`recommendations.js` 分派覆盖所有能力平台、settings 账号卡 == registry 的 cookie 平台
   == `index.html` 卡片、IPC 三处登记；
6. **i18n 完整性**：zh/en 键集合一致、平台名键确已移除、`data-i18n` 键全存在、`window.i18n` 已挂载。

⚠️ 冻结值**内联在测试里**（不读 `.preview/`）——工具目录不是交付物，不能被 `npm test` 依赖。
⚠️ 写契约测试时的两个坑：① 顺序断言别被**注释文本**命中（先剥注释）；
② `preload.js` 的声明顺序是 SEND→RECEIVE→INVOKE，按 `split()` 切文件会把 INVOKE 切到后半段
（改成正则锚定 `const SAFE_CHANNELS_INVOKE = new Set([...])` 该表自身）。

---

## 7. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| **R1** | **CORS 白名单派生 → 放宽安全边界**。这是唯一的**安全边界**，派生逻辑写错（如把后缀匹配写宽）会放行非预期源 | 🔴 高 | ① 派生结果必须与快照**逐条相等**（不是"包含"）；② 后缀匹配保留"带前导点"的严格写法；③ 阶段 2-③ 单独提交、单独验证 |
| R2 | 渲染层动态 option 与 `applyTranslations()` 顺序错 → 文案丢翻译 | 🟡 中 | 顺序固定为「拉清单 → 生成 → 翻译」，并在验证台断言选项文案非裸键 |
| R3 | 验证台/无头环境下 `__PLATFORMS` 缺失 → 界面异常 | 🟡 中 | `platformName()` 内置兜底表（§4.5），断言降级路径 |
| R4 | `loadPlatformPlugins` 在 asar 内 `readdirSync` 失败 | 🟢 低 | 已实测可行（§4.3）；且阶段 1 的验收就在打包后跑一次 |
| R5 | 渲染层 282 个 window 挂载契约被破坏 | 🟡 中 | 阶段 3 后跑 `check-window-bridge.mjs`（当前 26 模块 / 289 挂载 / 零环） |
| R6 | 一次性改动过大 → 难以定位回归 | 🔴 高 | 5 阶段拆分，每阶段 `git diff --stat` 自证"只改了预期文件" |
| R7 | 平台文件里 `hosts` 写错（复制粘贴）→ 取流被 CORS 拒 | 🟡 中 | 阶段 4 的派生一致性测试会立刻红 |

---

## 8. 效果对比

| 动作 | 现状 | v3 |
|---|---|---|
| 加一个新平台 | 改 13 个文件 20 处 | **新建 1 个文件**（manifest + 3 个方法） |
| 忘记补徽标配色 | 静默掉默认色 | 契约测试 FAIL |
| 忘记加 CORS 域名 | 运行时跨域失败，报错难懂 | 自动派生 |
| 「哪些平台支持专辑？」 | 无入口，读代码 | `registry.getCapabilities(id).album` |
| 调整平台顺序 | 静默改变聚合结果条数 | 无影响（权重显式） |
| 平台名三处不一致 | 可能（已有 3 份拷贝） | 不可能（单一来源） |

---

## 9. 明确不做（YAGNI）

- ❌ **不做运行时插件/lua 脚本**：8 个平台全是同仓维护的一等公民，引入动态加载只增加攻击面与调试难度。
- ❌ **不做平台热插拔/热更新**：无此需求，且会让 asar 签名与更新器复杂化。
- ❌ **不改平台实现内部的取流逻辑**：v3 是**结构重排**，任何平台的具体协议（咪咕的 HEAD+305、
  汽水的 `_ROUTER_DATA`）保持原样，不改一行。
- ❌ **不改 IPC 通道命名**：`get-source-health` / `probe-sources` 等既有通道名保持不变，
  只**新增** `get-platforms`，避免主进程与 preload 白名单大范围联动。

---

## 10. 决策记录（已拍板 2026-09-17）

| # | 问题 | 决定 | 结果 |
|---|---|---|---|
| 1 | 平台名是否退出 i18n（D5） | **退出，且同时提供 `name` / `nameEn`** | 中文界面 `网易云音乐`、英文界面 `NetEase`；两全 |
| 2 | 老式具名导出是否删除（D8） | **阶段 1-2 全保留**，阶段 3 先做调用方普查再删 | 普查零命中 ⇒ 已删（`api/index.js` 兼容层），平台文件自己的 `module.exports` 保留 |
| 3 | 实施范围 | **范围 B（阶段 0-2）先落地，随后追加阶段 3-4** | 全 5 阶段已完成 |

> 补充决定：**渲染层关掉 ESLint `no-undef` 是有道理的别贸然打开** —— 见 §4.4 的「裸标识符语义」实测。
