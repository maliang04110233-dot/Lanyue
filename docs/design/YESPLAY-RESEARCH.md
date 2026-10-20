# YesPlayMusic 布局实拆（用户指定对标语，替代 Alger 方案）

> 来源：qier222/YesPlayMusic（33k star，Vue2+Electron，master@5d5fa23，2026-10-20 抓取）
> 文件：src/components/Navbar.vue + src/components/Player.vue（GitHub API base64 实拆）

## Navbar（顶部导航 = 用户截图的那个头部）

```css
nav {
  position: fixed; top: 0; left: 0; right: 0;
  display: flex; justify-content: space-between; align-items: center;
  height: 64px;
  padding: 0 10vw;                       /* 左右大留白 = 呼吸感的来源 */
  backdrop-filter: saturate(180%) blur(20px);
  background-color: var(--color-navbar-bg);
  z-index: 100;
  -webkit-app-region: drag;              /* 整条可拖窗 */
}
.navigation-links {                      /* 居中那组：首页 发现 音乐库 */
  flex: 1; display: flex; justify-content: center;
  text-transform: uppercase; user-select: none;
  a {
    font-size: 18px; font-weight: 700;   /* 粗体大字，无底色 */
    padding: 6px 10px; border-radius: 6px; margin: 0 12px;
    color: var(--color-text);
    &:hover { background: var(--color-secondary-bg-for-transparent); }
    &:active { transform: scale(0.92); }
  }
  a.active { color: var(--color-primary); }   /* 激活=主色文字，不是色块 */
}
.search-box .container {                 /* 右：胶囊搜索框 */
  height: 32px; width: 200px; border-radius: 8px;
  background: var(--color-secondary-bg-for-transparent);
  &.active { background: var(--color-primary-bg-for-transparent); } /* focus 变主色淡底 */
}
.avatar { width: 30px; height: 30px; border-radius: 50%; margin-left: 12px; }
```

三段式：左（前进后退箭头 flex-1）｜中（导航链接居中）｜右（搜索框+头像）。

## Player（底部条 = 我们 D5.3 已接近的形态）

```css
.player {
  position: fixed; bottom: 0; left: 0; right: 0;
  display: flex; flex-direction: column;
  height: 64px;
  backdrop-filter: saturate(180%) blur(30px);
}
.progress-bar { margin-top: -6px; margin-bottom: -6px; width: 100%; }  /* 2px 细线骑在条顶 */
.controls {
  display: grid; grid-template-columns: repeat(3, 1fr);  /* 三等分列 */
  height: 100%; padding: 0 10vw;
}
.playing img { height: 46px; border-radius: 5px; box-shadow: 0 6px 8px -2px rgb(0 0 0 / 16%); }
.name { font-weight: 600; font-size: 16px; opacity: .88; }
.artist { font-size: 12px; opacity: .58; }
.play { height: 42px; width: 42px; }     /* 播放键=纯图标按钮，无底色胶囊 */
.volume-bar { width: 84px; }             /* 音量条常驻内联，不是 hover 弹层 */
.blank { flex-grow: 1; }                 /* 每组内两侧撑开→内容居中贴边 */
```

## 与揽乐 D5.3 的差异清单（本刀 D6 要改的）

| 维度 | YesPlay | 揽乐现状 | D6 动作 |
|---|---|---|---|
| 导航 | **顶部 fixed 64px，大写粗体链接居中，active=主色文字** | 左侧 200px 常驻列 | 侧栏→顶栏（核心改动）|
| 呼吸感 | navbar/player 都 padding 0 10vw | 贴边 | 顶栏+底栏+内容左右大留白 |
| 底栏高 | 64px | 80px | 收 64px |
| 封面 | 46px r5 | 56px r-lg | 收 46px |
| 播放键 | 42×42 纯图标 | 72×40 胶囊 | 收 42×42 |
| 进度线 | 2px 骑条顶 | 4px | 收 2px |
| 音量 | 84px 内联常驻 | hover 弹层 | 保弹层（DOM 牵扯多，下刀再动）|
| 毛玻璃 | blur(20~30px) | 无 | backdrop-filter 上条+栏 |

## 揽乐适配决策

- 9 个 tab + 2 个操作全进顶栏（1100px 窗口放得下）；`nav-item` 类名与
  `data-tab` 属性原样保留 → switchTab/NAV_ALIAS/commandPalette 零改动。
- 分组标题（我的音乐/订阅与更新/工具）从顶栏消失——横排链接不需要分组，
  renderer-audit 的 sidebar-title 守卫随之改写为顶栏链接序列守卫。
- 「打开下载目录/设置」两个动作按钮移到顶栏右端（无 data-tab，
  守卫「操作段不得有 data-tab」继续成立）。
- 布局流方案：不用 fixed+padding 补偿，`.app` 纵向 flex 自然堆叠
  （titlebar → topbar → main → bottom-bar），Electron frameless 下更稳。
