# 九维度评分表 · Lanyue（揽乐 MusicDL）v1.0.36

| 维度 | 分数 | 依据 |
|---|:---:|---|
| 架构与模块化 | **7** | 标准 Electron 三层（main/preload/renderer），主窗 webPreferences 明确 nodeIntegration:false + contextIsolation:true，渲染层按 views/services/utils 分目录；但仍有多个超千行文件：app.js 1264 行、views/local.js 1481、views/search.js 1408、views/ai-music.js 1157、views/playlist.js 1126、player.js 1069、views/home.js 1053、api/platforms/qq.js 994——分层有了、个别文件偏大，取 7 |
| 可读性与命名 | **8** | 全仓命名一致；注释普遍解释「为什么」而非复述代码（logger.js 说明 info 与 log 一致的原因、progressStore.js 说明串行队列动机、rejectionGuard.js 说明进程级异常网关设计）；grep 无 TODO/FIXME/HACK 残留 |
| 稳定性与异常处理 | **8** | src/utils/rejectionGuard.js 桥接 uncaughtException 与 unhandledRejection，失败自带降级路径；关键异步链路普遍 try+日志兜底；可选能力失败有明确返回值（restorePlayProgress 失败返回 0、progressStore 写失败不阻断播放） |
| 性能与资源占用 | **8** | scripts/bench.js 对高频纯函数路径建了可复跑基准（npm run bench 可 --json 留档对比）；logger 全异步 appendFile + 内存缓冲 + 定时批量落盘，避免同步 IO 冻结窗口 |
| UI 组织 | **7** | 设置视图已拆 views/settings/* 多文件，进度写入收口 progressStore.js、歌词收口 lyrics.js；但多个千行视图仍按事件回调堆叠 + 直接 DOM 组织，且存在依赖真实时钟的历史风险（测试曾因日期翻转红灯一次），状态分散度取 7 |
| 线程与并发安全 | **8** | progressStore.js 显式串行 FIFO 队列消灭读改写竞态；resumeSeeker 处理 loadedmetadata 竞态与跨歌 seek 泄漏；单实例锁 requestSingleInstanceLock 已实现并被真机 e2e 拦截断言覆盖 |
| 配置与日志 | **8** | src/main/ipc/prefs.js:25 ALLOWED_PREF_KEYS 白名单键集合、:91 DIR_PREF_KEYS + approvedDirs.isApprovedDir 目录校验；src/utils/prefs.js SECRET_KEYS 凭证级键走 safeStorage 加密、加密失败拒绝写入并告警（绝不明文落盘）、atomicWriteJson 原子写 + 损坏自动备份 .bak；logger.js 分级 + 单行截断 + 异步落盘，warn/error 均可追溯 |
| 测试与打包 | **8.5** | 338 个 test/*.test.js 全量 3081 tests / 3078 pass / 0 fail / 3 skipped（2026-10-15 11:56 实测，test-after-upgrade.log）；eslint 0 error；smoke:asar 构建期断言含 bundle 哈希一致性；npm run verify 一条命令串联 lint+test+dead-deps+icons+build+smoke:asar（verify 覆盖集本身有专测钉住：offline 可复现、不含需触网步骤）；真机 e2e smoke-test-manual.js 覆盖首实例存活/单实例锁/日志健康；扣分点：真机 e2e 未覆盖播放真实发声链路 |
| 依赖管理 | **8** | package-lock.json lockfileVersion 3、666 packages 锁定精确版本（electron 44.4.1）；check-dead-deps.cjs 构建期查死依赖；dependencies 仅 6 + devDependencies 8，体量可控；不足：package.json 仍用 ^ 区间，可复现性略降 |

## 综合分

| 版本 | 九维均值 | 盲区折让 | 综合分 |
|---|:---:|:---:|:---:|
| v1.0.36 现状 | 7.83 | -0.20 | **7.6** |

- 现状折让理由：音频真实解码发声、托盘图标交互、系统级快捷键属进程级/系统级能力，单进程内自动化测试测不出；现有真机 e2e 仅 5 项且未覆盖播放发声链路。按口径折让 -0.20。

> 口径：九维等权均值 − 验证盲区折让（0.20）。
> 这个折让是拿真金白银换的：某项目 687 项测试全绿的当天，真机双击直接闪退。
> **测不到本身就是风险，必须体现在总分里，不能只写在备注里。**
