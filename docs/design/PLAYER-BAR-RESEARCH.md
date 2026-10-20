# 播放条布局研究：AlgerMusicPlayer PlayBar.vue 实拆

> 来源：https://github.com/algerkong/AlgerMusicPlayer（17k star，本项目对标语）
> 文件：`src/renderer/components/player/PlayBar.vue`（main@b15617c，2026-10 抓取）
> 抓取方式：GitHub API contents 端点 base64 解码

## 它的真实骨架（此前我全是凭想象在做）

```
┌─ .music-play-bar（h-20=80px，absolute bottom-0 w-full，flex items-center px-6）─┐
│ ═══════════ .music-time：进度条绝对定位贴条顶（top-0 left-0 全宽）═══════════ │
│ 🖼封面56 │ 歌名+歌手(200px) │ ⏮  [▶ 胶囊80×48]  ⏭ (flex-1居中) │ 🔊 ♡  队列 │
──────────────────────────────────────────────────────────────────────────────┘
```

关键 CSS（原文摘录）：

```css
.music-play-bar {
  @apply h-20 w-full absolute bottom-0 left-0 flex items-center border px-6 py-2 pt-3;
  z-index: 9999;
}
/* 进度条：不在任何列里——它是贴着条顶的全宽细线 */
.music-time .n-slider { position: absolute; top: 0; left: 0; padding: 0; border-radius: 0; }
.custom-slider :deep(.n-slider) { --n-rail-height: 4px; --n-handle-size: 12px; }
.custom-slider :deep(.n-slider-handle) { opacity: 0; }           /* 常态隐藏 */
.custom-slider :deep(.n-slider:hover .n-slider-handle) { opacity: 1; } /* hover 才现 */

.music-content { width: 200px; @apply ml-4; }                     /* 信息列定宽 */
.music-buttons { @apply mx-6 flex-1 flex justify-center; }        /* 控制区吃掉剩余宽度 */
.music-buttons-play { @apply w-20 h-12 rounded-full mx-4 bg-gray-100/60 dark:bg-gray-800/60; }
.play-bar-img-wrapper { @apply w-14 h-14 rounded-2xl relative; }  /* 封面 56px */
```

## 五条可直接抄的设计决策

| # | Alger 的做法 | 我 D5.2 的错误做法 |
|---|---|---|
| 1 | **进度条=贴条顶的全宽细线**（absolute top-0），不占水平列 | 把进度条塞进第 4 列，宽度被挤压，位置违反直觉 |
| 2 | **单行 flex**：封面｜信息 200px｜控制 flex-1 居中｜工具 | 六列 grid，列宽分配处处打架 |
| 3 | **播放键是胶囊**（80×48 rounded-full，淡灰底），不是圆形主色块 | 42×42 圆形主色，视觉重量失衡 |
| 4 | **条上不放时间文本**，seek 精度靠 slider tooltip（`0:05 / 4:06`） | 时间两端硬塞，挤占进度线 |
| 5 | **音量=hover 弹垂直滑杆**；队列=右侧图标开抽屉；无「正在播放」状态文本 | 音量弹层+状态文本+队列大按钮全堆在条上 |
| 6 | thumb 常态 opacity:0，hover 才出现——细线态极简 | thumb 常驻 |

## 对揽乐的适配决定（D5.3）

照抄骨架 1/2/3/5，保留揽乐自己已有的功能件：
- 进度线贴顶全宽（揽乐 track 已有 hover-time tooltip 逻辑，正好承担 Alger 的 formatTooltip 职责）
- 时间 `0:05/4:06` 收进信息列歌手行末尾（小灰字，不占进度线）
- 播放键改胶囊（64×40，主色淡底 + 主色图标，跟随揽乐主题令牌）
- 音量弹层、歌词开关、更多菜单、队列入口保留在右侧工具区（轻量图标态）
- `pcState`（正在播放/已暂停）DOM 保留（JS 在写它），条上不显示，挪到 title 属性
- 歌词/频谱展开：flex-wrap 换行占满整行（Alger 的歌词是全屏页，揽乐保留内嵌展开）
