# 加一个音源平台（v3 之后的 SOP）

> 架构背景见 [platform-plugin-v3.md](./platform-plugin-v3.md)。
> **v3 之前**加平台要改 13 个文件 / 20 处手写清单，漏一处静默失效；
> **v3 之后**只有一步：**新建 1 个文件**，其余全部派生。

---

## 一句话

```bash
$EDITOR src/api/platforms/<id>.js     # 唯一要动的文件
node --test test/platform-contract.test.js    # 契约测试会告诉你漏了什么
```

---

## 步骤 1 · 写平台文件

照抄一个最简平台（`migu.js` 只有三能力）作为骨架：

```js
/**
 * <平台名> 音源适配器
 */
const request = require('../request');
const logger = require('../../utils/logger');

// ── 实现（内部函数名随意，manifest 里映射出去）────────────
async function mySearch(keyword, page = 1) { /* → { songs: [...] } */ }
async function myGetUrl(id, quality) { /* → { url } */ }
async function myGetLyrics(id) { /* → { lrc } */ }

module.exports = {
  // ── 事实 ──────────────────────────────────────────────
  id: 'myid',                 // 必填：全局唯一，用作 source 字段与 CSS 类名后缀
  name: '某某音乐',             // 必填：中文显示名
  nameEn: 'MyMusic',          // 必填：英文界面显示名
  icon: '🎵',                 // 可选：emoji，供 UI 使用

  // ── 徽标配色（必填）────────────────────────────────────
  // 会被 utils.js 注入成 `.badge-myid{--badge-bg/--badge-fg/--badge-border}`
  // 漏了不会报错但会被契约测试拦下（"静默掉色"漏洞已封）。
  // 选色要求：与现有 8 色两两可区分（红/黄/天蓝/青绿/蓝/紫/琥珀橙/粉）
  badge: { bg: 'rgba(56,189,248,.14)', fg: '#38bdf8', border: 'rgba(56,189,248,.24)' },

  // ── 网络域名（必填）—— CORS 白名单由此派生 ──────────────
  // ⚠️ 这是**唯一的安全边界**。列出该平台实际会请求的全部 origin，
  //    精确写，不要为了省事写宽（比如别写 https://kugou.com 去覆盖子域）。
  hosts: {
    origins: ['https://api.mymusic.com', 'https://cdn.mymusic.com'],
    // 仅当 CDN 域名是**动态**的（按地域/节点变化）才用后缀；
    // 后缀必须带前导点：'.mymusic.com'（防 evil-mymusic.com 绕过）
    originSuffixes: [],
  },

  // ── 链接识别（可选）—— 想让用户能直接粘贴该平台链接才需要 ──
  // ⚠️ extract 是**必需**的：parseMusicLink 靠它从匹配结果取 id。
  //    只写 type/re 会让链接识别静默失效（初版设计稿就漏了这个字段）。
  linkPatterns: [
    { type: 'song', re: /api\.mymusic\.com\/song\/(\d+)/, extract: (m) => m[1] },
  ],

  // ── 策略（必填，且必须**显式**写全，不依赖默认值）──────────
  // 这些是业务规则，代码里推导不出来，所以必须人写。
  // 契约测试要求这 4 个字段都在 —— 全用默认值时，
  // "这个平台不参与换源"和"作者忘了写"长得一模一样。
  policies: {
    order: 90,             // 展示/聚合顺序，小者在前。原值 10,20,…,80，
                           // 每档留 10 的间隙，插队用 45 这种值即可。
                           // ✅ v3 起顺序**不再**影响聚合条数（原先是按下标 10/10/5）。
    fallbackSource: true,  // 是否参与跨源换源候选。反例：bilibili=false，
                           // 因其 artist 是 UP 主名，参与换源只会制造错配。
    probeable: true,       // 是否参与设置页的可用性探针
    aggregateLimit: 5,     // 'all' 聚合搜索时最多取几条
    supportsQuality: ['128k', '320k'],
  },

  // ── 实现（方法存在 = 能力存在，能力不用另写）─────────────
  search: mySearch,
  getUrl: myGetUrl,
  getLyrics: myGetLyrics,          // 有就写，没有就删
  // 以下有则自动推导为能力，无则不声明（**不要虚报**）：
  // getSongDetail   → capabilities.linkDetail（支持链接直取详情）
  // verifyCookie    → capabilities.cookie（支持 Cookie 登录）
  // searchAlbum / getAlbumSongs           → album / albumSongs
  // searchSinger / getSingerSongs / getSingerAlbums → singer / singerSongs / singerAlbums
  // getLyricsByTitle → lyricsByTitle

  // 保留老式具名导出（可选）：单测里 `require('../src/api/platforms/<id>')` 直接调
  // 内部纯函数用的，不影响 registry。
  _internal: { /* 纯函数，供单测断言 */ },
};
```

---

## 歌曲条目规范（songShape · 必读）

搜索返回的歌曲条目要经过 `src/api/songShape.js` 的 `asSong()` 收敛：

```js
const { asSong } = require('../songShape');

async function mySearch(keyword, page = 1) {
  // ... 拿到平台原始条目以后：
  return list.map((s) => asSong({ title: ..., source: 'myid', /* ... */ }));
}
```

`asSong` 只做**形状/类型收敛**（durations NaN→0、核心字段统一为字符串等），
字段取值逻辑仍由平台自己写。三条硬约定：

| 字段 | 约定 |
|---|---|
| `duration` | **毫秒整数**。平台源是秒的（qq `interval` / kugou `Duration` / kuwo `DURATION`）在平台文件里 `* 1000`；接口不返回的报 `0` |
| `artist` | 已连接好的字符串；连接符**按平台现状保留**（勿统一）：netease/qq `' / '`、migu/soda `'、'`、kuwo `', '` |
| 扩展字段 | 透传保留（netease `fee/albumMid`、qq `pay/numId` 是下游依赖），平台特有的随意加 |

丢单守卫（空 id / 空 title）留在平台里——各平台丢单条件不同，收拢会改变丢单集合。

---

## 步骤 2 · 跑测试

```bash
node --test test/platform-contract.test.js    # 契约测试（最快反馈）
npx eslint src/ test/                          # 必须 0 告警
node --test "test/*.test.js"                   # 全量单测
npm run build                                  # 打包产物（dist/api 是整目录复制）
```

契约测试会检查（这些就是"原来会静默失效"的地方）：

| 检查 | 漏了会怎样（v3 之前） |
|---|---|
| 必填字段齐全 | 平台被静默跳过，搜索里少一个源，无任何报错 |
| `badge` 三色齐全 | 徽标静默掉回灰色 |
| `policies` 4 字段显式声明 | 无法区分"故意排除换源"与"忘了配" |
| `hosts.origins` 与派生白名单一致 | 播放时才报跨域错误，报错难懂 |
| `linkPatterns[].extract` 存在 | 粘贴链接识别不出来 |
| 无硬编码守卫 | 防止有人又手写第二份平台清单 |

---

## 不需要改的文件（v3 的核心收益）

| 原来要改 | 现在 |
|---|---|
| `src/main/index.js` 的 CORS 白名单（20 域名手写） | ❌ 不用 —— 由 `hosts` 派生 |
| `src/main/ipc/search.js` 探针数组（同一份抄了两遍） | ❌ 不用 —— 由 `policies.probeable` 派生 |
| `src/utils/matchMusic.js` 换源候选 | ❌ 不用 —— 由 `policies.fallbackSource` 派生 |
| `src/utils/linkParser.js` 链接正则 | ❌ 不用 —— 由 `linkPatterns` 派生 |
| `src/api/index.js` 的 `_ADAPTERS` 适配器表 | ❌ 不用 —— 自动发现（**该表已删除**） |
| `src/renderer/index.html` 的 8 个 `<option>` | ❌ 不用 —— IPC `get-platforms` 下发 |
| `player.js` / `settings.js` / `utils.js` 三份 `SOURCE_NAMES` | ❌ 不用 —— 收敛为 `platformName(id)`（**已只剩一处兜底表**） |
| `styles/content.css` 的 8 条 `.badge-<id>` | ❌ 不用 —— 变量注入（**该段已删除**） |
| `lang/zh.json` + `en.json` 的平台名键 | ❌ 不用 —— 平台名走 manifest，**16 个键已移除** |

**唯一仍要手改的例外**（有测试钉住，改漏会红）：

- 若新平台**支持 Cookie 登录**（实现了 `verifyCookie`）：
  它是唯一需要改渲染层的场景，因为账号卡是 `index.html` 里的静态 DOM
  （3 张卡片 + 侧栏状态点）。需要同步三处：
  `settings.js` 的 `PLATFORMS` 数组、`index.html` 的 `.account-card`、
  以及 `settings.js` 的 `COOKIE_FIELDS` / `updateSidebarPlatformStatus` 映射。
  契约测试 `settings.js 的 Cookie 账号卡 == registry 的 cookie 能力平台 == index.html 的卡片`
  会告诉你漏了哪一处。
- 若新平台实现了 `searchSinger` / `getSingerSongs` / `getSingerAlbums` / `getAlbumSongs`：
  这些能力目前由 `recommendations.js` **手写分派**（直接 require 平台模块、按 id if/else），
  **不经过 registry** —— 即新平台即使实现了也走不通。
  契约测试会红并把缺的平台列出来，届时二选一：接入 `recommendations.js`，
  或明确说明该平台不提供这些能力。见下方"已知缺口"。

---

## 已知缺口（v3 有意留下的，未做）

1. **`recommendations.js` 绕过 registry**（歌手 / 专辑曲目）。
   它直接 `require('./platforms/{netease,qq,kugou,bilibili}')` 并按 id if/else 分派，
   与 `getLyrics` 曾经的 kugou 直连、`linkParser` 曾经的 `PATTERNS` 是同一类问题。
   **未改的原因**：涉及 4 个平台的方法签名统一与真实功能回归面，
   不适合混在渲染层收敛里做。**已用契约测试钉住**（新增平台会立刻暴露），
   待单独一轮迁移（建议命名为 v3.1）。
   - 其中 `bilibili` 的 require 只用于首页排行榜（`bilibiliGetRanking`），
     该能力未进 `CAPABILITY_METHODS`，属独立用途。

2. **`getSingerSongs(singerMid)` 无 source 参数**，靠 id 形状猜平台
   （纯数字→netease 失败回退 kugou，否则 qq）。这是启发式，无法从 manifest 推导，
   迁移时需要保留为显式规则。

3. **`settings.js` 的账号卡是静态 DOM**。见上方例外说明。

---

## 排错

**"平台没被加载"**
```bash
node -e "const{defaultRegistry:r,loadPlatformPlugins}=require('./src/api/pluginRegistry');loadPlatformPlugins();console.log(r.getIds())"
```
`validate()` 现在会**抛错**而不是静默跳过 —— 启动日志里能直接看到缺哪个字段。

**"能搜到但播不了"**
九成是 `hosts.origins` 少了取流域名。取流走的是主进程 CORS 白名单，
搜索走的是主进程 `request`，两者路径不同 ⇒ **搜索通不代表域名配对**。
用真实链接验证：参考 `.preview/e2e-kuwo-play.cjs`。

**"徽标是灰的"**
`badge` 缺失或 `id` 与 CSS 类名对不上。检查运行时注入的 `<style id="platformBadgeTheme">`。

**"打包后平台不见了"**
`dist/api/platforms/*.js` 必须是独立文件（`scripts/postbuild.js` 整目录复制 `src/api/`）。
若被 vite 打进入口包，`fs.readdirSync` 就会失败。
