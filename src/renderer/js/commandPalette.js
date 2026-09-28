/**
 * 命令面板（Ctrl/⌘+K）—— 键盘一步直达全部核心动作
 *
 * 匹配逻辑 fuzzyScore/rankCommands 为纯函数（node 可单测）：
 * 前缀 > 包含 > ASCII 子序列（中文不做子序列——按字符读音无意义），
 * keywords 兜底拼音/英文/别称。面板本身只是「一个输入框 + 一张表」，
 * 所有动作复用既有 window 桥接，零新增 IPC。
 *
 * 键盘契约（增量195，182/193 三件套推广到第三个模态）：
 * ① open 即同步聚焦输入框——呼出即可打字，不留 30ms 空窗；
 * ② capture 围堵（承 193「让位优先于围堵」）：hasOpenConfirm() 先让位，
 *    随后 stopImmediatePropagation 封层——面板开着，一个键都不漏给背景的
 *    shortcuts.js / 自家 onGlobalKey。shortcuts.js 的 _anyModalOpen() 是手抄
 *    id 清单（148/151/185 律的活体），cmdkOverlay 从来不在表里，围堵是这条
 *    漏的第二道保险；
 * ③ 围堵下必须自留 Ctrl+K 通道：自家 capture 掐死 bubble 层的 onGlobalKey，
 *    不接就变成"面板开得出关不回"；
 * ④ isComposing 一律放行不处理：placeholder 明写着可输拼音，合成中的
 *    Enter/↑↓ 属于输入法选字翻页，面板抢键=中文用户打不完命令就执行；
 * ⑤ Tab/Shift+Tab 在面板 focusables（输入框+命令行钮）间循环且 preventDefault；
 *    ↑↓/Enter 的语义从输入框私有监听上收到围堵层一处立法（一个键一个家），
 *    Enter 恒执行"高亮行"而非"聚焦行"，两种游标不打架；
 * ⑥ 关闭公共路径：摘监听 + hidden + 焦点归还 opener（182 规矩），
 *    Esc 与执行与遮罩点三径同源；
 * ⑦ role=dialog + aria-modal——读屏软件要知道"世界换成了面板"。
 */

import { logger } from './logger.js';
import { recordRecent, pickRecents } from './paletteRecents.js';
import { hasOpenConfirm } from './confirmDialog.js';
import { featureOn, filterByFeature } from './features.js';

// ── 纯函数 ───────────────────────────────────────────
function fuzzyScore(q, text) {
  if (!q) return 0;
  const t = String(text || '').toLowerCase();
  const s = q.toLowerCase();
  const idx = t.indexOf(s);
  if (idx === 0) return 200;
  if (idx > 0) return 120 - Math.min(50, idx);
  if (/^[\x20-\x7e]+$/.test(s)) {
    let i = 0;
    for (const ch of t) {
      if (ch === s[i]) i++;
      if (i === s.length) return 20;
    }
  }
  return -1;
}

function rankCommands(q, cmds) {
  const query = String(q || '').trim();
  const out = [];
  for (const c of (cmds || [])) {
    if (!c || !c.label) continue;
    let best = fuzzyScore(query, c.label);
    if (best < 0) {
      for (const k of (c.keywords || [])) {
        const s = fuzzyScore(query, k);
        if (s > best) best = s;
      }
    }
    if (query && best < 0) continue;
    out.push({ cmd: c, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 30).map(x => x.cmd);
}

// ── 命令清单 ─────────────────────────────────────────
function _goto(tab) {
  // 不再摸导航按钮（164 起 search 没有自己的按钮）；高亮归属由 switchTab 的 NAV_ALIAS 统一给
  if (typeof window.switchTab === 'function') window.switchTab(tab);
}

function _call(name, ...args) {
  const f = window[name];
  if (typeof f === 'function') return f(...args);
  try { showToast('当前界面不支持该操作', 'warn', 2000); } catch (_e) { /* 无 toast 环境 */ }
}

const COMMANDS = [
  { id: 'nav-home', icon: '🔍', group: '导航', label: '前往 搜歌（发现）', keywords: ['home', '首页', '发现', '推荐'], run: () => _goto('home') },
  { id: 'nav-search', icon: '🔍', group: '导航', label: '前往 搜歌（结果）', keywords: ['search', '搜索'], run: () => _goto('search') },
  { id: 'nav-download', icon: '⬇', group: '导航', label: '前往 下载', keywords: ['download', '队列'], run: () => _goto('download') },
  { id: 'nav-local', icon: '📂', group: '导航', label: '前往 本地曲库', keywords: ['local', '本地'], run: () => _goto('local') },
  { id: 'nav-playlist', icon: '💿', group: '导航', label: '前往 歌单', keywords: ['playlist', '收藏'], run: () => _goto('playlist') },
  { id: 'nav-sub', icon: '🔔', group: '导航', label: '前往 订阅', keywords: ['subscription', '更新'], run: () => _goto('subscription') },
  { id: 'sub-check', icon: '📡', group: '下载', label: '立即检查订阅更新（新歌提醒）', keywords: ['subscription check', '订阅', '检查', '新歌'], run: () => _call('subscriptionCheckNow') },
  { id: 'nav-ai', icon: '✨', group: '导航', label: '前往 AI 创作', keywords: ['ai', '生成'], feature: 'ai', run: () => _goto('ai-music') },
  { id: 'nav-conv', icon: '🎛', group: '导航', label: '前往 格式转换', keywords: ['convert', '转码'], run: () => _goto('converter') },

  { id: 'pl-toggle', icon: '▶⏸', group: '播放', label: '播放 / 暂停', keywords: ['play', 'pause', '暂停'], run: () => _call('togglePlay') },
  { id: 'pl-next', icon: '⏭', group: '播放', label: '下一首', keywords: ['next'], run: () => _call('nextSong') },
  { id: 'pl-prev', icon: '⏮', group: '播放', label: '上一首', keywords: ['prev', 'previous'], run: () => _call('prevSong') },
  { id: 'pl-fav', icon: '♥', group: '播放', label: '收藏 / 取消收藏当前播放的歌', keywords: ['favorite', 'fav', 'heart', '收藏', '红心', '当前播放'], run: () => _call('toggleFavoriteCurrent') },
  { id: 'pl-report', icon: '📈', group: '播放', label: '听歌报告（播放统计）', keywords: ['report', 'stats', '统计'], run: () => _call('generatePlayReport') },
  { id: 'pl-rcopy', icon: '📋', group: '播放', label: '复制听歌报告为纯文本', keywords: ['report', 'copy', '报告', '复制'], run: () => _call('copyPlayReportText') },
  { id: 'pq-dedupe', icon: '🧹', group: '播放', label: '播放队列去重（保留首次出现）', keywords: ['dedupe', 'queue', '队列', '去重'], run: () => _call('dedupePlayQueue') },
  { id: 'pq-save', icon: '💾', group: '播放', label: '播放队列存为歌单', keywords: ['save', 'queue', 'playlist', '队列', '歌单', '保存'], run: () => _call('saveQueueAsPlaylist') },
  { id: 'pl-lyradv', icon: '⏪', group: '播放', label: '歌词提前 0.5s（偏移 -500ms）', keywords: ['lyric offset', '歌词', '偏移'], run: () => _call('nudgeLyricOffset', -500) },
  { id: 'pl-lyrdly', icon: '⏩', group: '播放', label: '歌词延后 0.5s（偏移 +500ms）', keywords: ['lyric offset', '歌词', '偏移'], run: () => _call('nudgeLyricOffset', 500) },
  { id: 'pl-abloop', icon: '🔁', group: '播放', label: 'A-B 循环：设 A 点 / 设 B 点 / 清除', keywords: ['ab loop', '循环', '片段', '副歌'], run: () => _call('abLoopClick') },
  { id: 'pl-abclip', icon: '✂', group: '播放', label: '导出 A-B 片段为新文件（原曲不动）', keywords: ['clip', 'cut', '片段', '截取', '铃声', '导出'], run: () => _call('exportAbClip') },
  { id: 'pl-lyedit', icon: '✏️', group: '播放', label: '编辑当前歌曲歌词（本地 .lrc / 在线覆写）', keywords: ['lyric', '歌词', '编辑', 'edit'], run: () => _call('openLyricEditor') },
  { id: 'pl-addsong', icon: '➕', group: '播放', label: '搜索并添加歌曲到当前打开的歌单', keywords: ['playlist', '歌单', '加歌', '添加', 'add song'], run: () => _call('openPlaylistAddSongs') },
  { id: 'pl-psort', icon: '↕', group: '播放', label: '歌单详情排序：默认 / 标题 / 歌手 / 添加时间', keywords: ['playlist', 'sort', '歌单', '排序'], run: () => _call('cyclePlaylistSort') },
  { id: 'pl-cfilter', icon: '🔍', group: '播放', label: '搜索我的歌单（名称/描述过滤卡片）', keywords: ['playlist filter', '歌单', '搜索'], run: () => { _goto('playlist'); const el = document.getElementById('playlistCardFilter'); if (el) setTimeout(() => el.focus(), 80); } },
  { id: 'pl-export', icon: '⤴', group: '播放', label: '导出当前打开的歌单为 m3u', keywords: ['export', 'm3u', '歌单', '导出'], run: () => _call('exportCurrentPlaylistM3u') },
  { id: 'pl-msave', icon: '📥', group: '播放', label: '把平台歌单/专辑弹层勾选歌存为我的歌单（在线引用不下载）', keywords: ['save', '平台歌单', '弹层', '存为歌单', '专辑'], run: () => _call('savePlModalAsPlaylist') },
  { id: 'pl-bulkrm', icon: '☑', group: '播放', label: '歌单详情多选模式：勾选后批量移出歌单', keywords: ['bulk remove', '多选', '批量', '移除', '歌单'], run: () => _call('togglePlBulkMode') },
  { id: 'pl-seldl', icon: '⬇', group: '播放', label: '歌单详情多选：批量下载勾选的歌', keywords: ['download selected', '批量', '下载', '勾选', '歌单'], run: () => _call('plSelDownload') },
  { id: 'pl-selplay', icon: '▶', group: '播放', label: '歌单详情多选：连播勾选的歌', keywords: ['play selected', '连播', '播放', '勾选', '歌单'], run: () => _call('plSelPlay') },
  { id: 'sr-batchfav', icon: '♥', group: '搜索', label: '搜索结果多选：批量收藏勾选的歌', keywords: ['batch favorite', '收藏', '红心', '批量', '搜索'], run: () => _call('batchFavorite') },
  { id: 'pl-dlfilt', icon: '⬇', group: '下载', label: '歌单详情切换下载状态过滤（全部/未下载/已下载）', keywords: ['playlist downloaded filter', '未下载', '已下载', '过滤', '歌单'], run: () => _call('cyclePlDlFilter') },
  { id: 'loc-fmt', icon: '🎞', group: '下载', label: '本地曲库格式过滤循环（全部 / 曲库实际存在的格式）', keywords: ['local', 'format', '格式', '本地', 'flac', 'mp3', '过滤'], run: () => { _goto('local'); _call('cycleLocalFmt'); } },
  { id: 'loc-qual', icon: '🧪', group: '下载', label: '本地曲库音质视图过滤循环（全部 / 标称无损 / 真无损 / 存疑 / 待验）', keywords: ['quality', '音质', '无损', '伪无损', '待验', '过滤'], run: () => { _goto('local'); _call('cycleLocalQual'); } },
  { id: 'loc-meta', icon: '🏷', group: '下载', label: '本地曲库元数据完整度过滤循环（全部 / 缺封面 / 缺专辑 / 缺歌手标题 / 缺内嵌歌词）', keywords: ['metadata', '完整度', '缺封面', '缺歌词', '缺专辑', '标签', '过滤'], run: () => { _goto('local'); _call('cycleLocalMeta'); } },
  { id: 'loc-copylist', icon: '📋', group: '下载', label: '复制本地曲库当前视图的曲名清单（一行一首）', keywords: ['copy', 'local', '曲单', '清单', '本地', '复制'], run: () => { _goto('local'); _call('copyLocalListText'); } },
  { id: 'pl-merge', icon: '📥', group: '播放', label: '把其他歌单合并进当前打开的歌单（去重）', keywords: ['merge', '歌单', '合并', '去重'], run: () => _call('openPlaylistMergePicker') },
  { id: 'pl-dedupe', icon: '🧹', group: '播放', label: '清理当前歌单内的重复歌曲（保留首次出现）', keywords: ['dedupe', 'duplicate', '重复', '清理', '歌单'], run: () => _call('dedupeCurrentPlaylist') },
  { id: 'pl-dup', icon: '📋', group: '播放', label: '当前歌单另存副本（整单复制建新歌单，撞名自动让位）', keywords: ['duplicate playlist', 'copy', '副本', '另存', '备份', '歌单'], run: () => _call('duplicateCurrentPlaylist') },
  { id: 'pl-dedupescan', icon: '🧮', group: '播放', label: '跨歌单重复检测（找散落在多个歌单里的同一首歌）', keywords: ['cross playlist duplicate', 'dedupe', '重复', '查重', '歌单'], run: () => _call('scanCrossPlaylistDupes') },
  { id: 'pl-copylist', icon: '📋', group: '播放', label: '复制当前歌单曲名清单（一行一首：歌名 - 歌手）', keywords: ['copy', 'playlist', '曲单', '清单', '复制', '歌单'], run: () => _call('copyPlaylistListText') },
  { id: 'pl-locate', icon: '🎯', group: '播放', label: '在歌单详情中定位正在播放的歌', keywords: ['locate', '定位', '正在播放', '歌单'], run: () => _call('locatePlayingInDetail') },
  { id: 'pq-locate', icon: '🎯', group: '播放', label: '在播放队列面板中定位正在播放的歌（未开自动展开）', keywords: ['queue', 'locate', '定位', '队列', '正在播放'], run: () => _call('locatePlayingInQueue') },
  { id: 'pq-bulkrm', icon: '☑', group: '播放', label: '播放队列多选模式：勾选后批量移出队列', keywords: ['queue', 'bulk remove', '多选', '批量', '移除', '队列'], run: () => _call('togglePqSelMode') },
  { id: 'pq-selpl', icon: '🎼', group: '播放', label: '播放队列多选：把勾选的歌加进我的歌单', keywords: ['queue', 'add to playlist', '歌单', '批量', '勾选', '队列'], run: () => _call('pqSelAddPlaylist') },
  { id: 'pq-copylist', icon: '📋', group: '播放', label: '复制播放队列歌名清单（多选模式下只复制勾选行）', keywords: ['copy', 'queue', 'clipboard', '复制', '队列', '曲单', '清单'], run: () => _call('copyQueueListText') },
  { id: 'pl-csort', icon: '↕', group: '播放', label: '歌单卡片排序：默认 / 名称 / 曲数 / 最近更新', keywords: ['playlist', 'card', 'sort', '歌单排序'], run: () => _call('cyclePlCardSort') },
  { id: 'pl-fade', icon: '🌊', group: '播放', label: '播放淡入档位：关 / 0.5s / 1s / 2s', keywords: ['fade', '淡入', '音量', '渐变'], run: () => _call('cycleFadeIn') },
  { id: 'pl-fadeout', icon: '🌊', group: '播放', label: '播放淡出档位：暂停/定时到点缓停（关 / 0.5s / 1s / 2s）', keywords: ['fade out', 'fadeOut', '淡出', '缓停', '音量', '渐变'], run: () => _call('cycleFadeOut') },
  { id: 'viz-toggle', icon: '📊', group: '播放', label: '频谱可视化开关（进度条下方实时频谱）', keywords: ['visualizer', 'spectrum', '频谱', '可视化'], run: () => _call('toggleVisualizer') },
  { id: 'eq-cycle', icon: '🎚️', group: '播放', label: 'EQ 预设循环：平坦 → 流行 → 摇滚 → …', keywords: ['eq', 'equalizer', '均衡器', '预设', '曲线'], run: () => _call('cycleEqPreset') },
  { id: 'eq-bypass', icon: '🔇', group: '播放', label: 'EQ 旁路开关（关闭/打开均衡器，曲线保留）', keywords: ['eq', 'bypass', '均衡器', '旁路', '关闭'], run: () => _call('toggleEqBypass') },
  { id: 'eq-reset', icon: '↩', group: '播放', label: 'EQ 重置为平坦（清掉手调与预设抬升）', keywords: ['eq', 'reset', '均衡器', '重置', '平坦', 'flat'], run: () => _call('resetEq') },

  { id: 'dl-batch', icon: '📥', group: '下载', label: '批量导入链接', keywords: ['batch', '粘贴'], run: () => _call('openBatchImport') },
  { id: 'dl-namebatch', icon: '🎤', group: '下载', label: '按歌名批量导入（歌手 - 歌名清单）', keywords: ['name batch', '歌名', '文本清单'], run: () => _call('openNameBatch') },
  { id: 'dl-m3u', icon: '📁', group: '下载', label: '导入 m3u 歌单文件（解析后匹配入队）', keywords: ['m3u', 'playlist import', '歌单'], run: () => _call('openM3uImport') },
  { id: 'pl-m3uimp', icon: '📥', group: '下载', label: '导入 m3u 为用户歌单（匹配本地曲库，导入即可播）', keywords: ['m3u', 'playlist', '导入', '歌单', '本地'], run: () => _call('pickM3uForPlaylist') },
  { id: 'dl-retry-failed', icon: '🔁', group: '下载', label: '重试全部失败的历史记录（≤200 条）', keywords: ['retry', '失败', '历史'], run: () => _call('retryFailedFromHistory') },
  { id: 'dl-clean-dead', icon: '🧹', group: '下载', label: '清理失效的历史记录（文件已不在磁盘上）', keywords: ['clean', 'dead', '失效', '清理', '历史'], run: () => _call('cleanDeadHistory') },
  { id: 'dl-redl-dead', icon: '⬇', group: '下载', label: '重新下载失效的历史歌曲（文件被我删了但还想要）', keywords: ['redownload', 'dead', '失效', '重下', '重新下载', '历史'], run: () => _call('redownloadDeadHistory') },
  { id: 'dl-sched', icon: '⏰', group: '下载', label: '新建定时下载', keywords: ['schedule', '错峰', '夜间'], run: () => _call('openScheduledPanel') },
  { id: 'dl-pause', icon: '⏸', group: '下载', label: '暂停 / 继续下载队列', keywords: ['pause queue'], run: () => _call('toggleQueuePause') },
  { id: 'dl-clear', icon: '🧹', group: '下载', label: '清空已完成任务', keywords: ['clear done'], run: () => _call('clearFinishedDownloads') },
  { id: 'dl-after', icon: '🏁', group: '下载', label: '设置「完成后动作」', keywords: ['shutdown', '关机', '退出'], run: () => _call('openAfterQueueMenu') },
  { id: 'set-search', icon: '🔍', group: '通用', label: '搜索设置项（打开设置面板并聚焦搜索框）', keywords: ['settings', 'search', '设置', '搜索', '限速', '主题'], run: () => _call('focusSettingsSearch') },
  { id: 'dl-trend', icon: '📊', group: '下载', label: '下载趋势（近 14 天）', keywords: ['trend', '趋势', 'history stats'], run: () => _call('showTrendPanel') },
  { id: 'his-sort', icon: '↕', group: '下载', label: '历史排序档位（最新/最早/曲名/歌手/大小）', keywords: ['sort', '排序', '历史'], run: () => _call('cycleHistorySort') },
  { id: 'dl-diag', icon: '🆘', group: '下载', label: '诊断最近一个失败任务', keywords: ['diagnose', '失败', 'error'], run: () => _call('diagnoseLatestFailure') },
  { id: 'dl-diagall', icon: '🩹', group: '下载', label: '失败诊断报告（全部失败按原因聚合）', keywords: ['failure report', '批量诊断', '报告'], run: () => _call('openFailureReport') },
  { id: 'dl-summary', icon: '⚡', group: '下载', label: '队列总览（下载中/排队/总速/剩余）', keywords: ['queue summary', '总览', '速度'], run: () => _call('showQueueSummaryToast') },
  { id: 'dl-group', icon: '🧩', group: '下载', label: '下载队列「按平台分组」开关（组头计数/折叠/只看）', keywords: ['group by platform', '分组', '平台', '来源', '队列'], run: () => { _goto('download'); _call('toggleDlGroupMode'); } },
  { id: 'dl-platclear', icon: '✕', group: '下载', label: '取消下载队列「只看单平台」过滤', keywords: ['clear platform filter', '只看', '取消过滤', '平台'], run: () => { _goto('download'); _call('clearDlPlatformFilter'); } },

  { id: 'lc-refresh', icon: '🔄', group: '本地库', label: '刷新本地曲库', keywords: ['rescan', '扫描'], run: () => _call('refreshLocalLibrary') },
  { id: 'lc-stats', icon: '📊', group: '本地库', label: '曲库统计', keywords: ['stats', '统计'], run: () => _call('showLibraryStats') },
  { id: 'lc-dup', icon: '🧬', group: '本地库', label: '查重相同歌曲', keywords: ['duplicate', '重复'], run: () => _call('detectDuplicateSongs') },
  { id: 'lc-cdup', icon: '🧬', group: '本地库', label: '内容级查重（字节哈希找相同副本）', keywords: ['content duplicate', '哈希', '副本'], run: () => _call('detectContentDuplicates') },
  { id: 'lc-locate', icon: '🎯', group: '本地库', label: '定位正在播放的歌（滚动+闪烁）', keywords: ['locate', '定位', '正在播放'], run: () => _call('locatePlayingLocal') },
  { id: 'lc-favonly', icon: '♥', group: '本地库', label: '本地曲库仅看收藏开关', keywords: ['favorite', 'fav', '收藏', '本地', '过滤'], run: () => _call('toggleLocalFavOnly') },
  { id: 'lc-probe', icon: '🔬', group: '本地库', label: '全库音质扫描（查伪无损）', keywords: ['probe', '音质', 'lossless'], run: () => _call('batchProbeQuality') },
  { id: 'lc-m3u', icon: '⤴', group: '本地库', label: '导出曲库为 m3u 歌单（勾选优先）', keywords: ['export', 'm3u', '导出', 'playlist'], run: () => _call('exportLocalM3u') },
  { id: 'lc-agroups', icon: '🎤', group: '本地库', label: '按歌手分组统计曲库（点击即过滤）', keywords: ['artist', '歌手', '分组', 'group'], run: () => _call('showArtistGroups') },
  { id: 'lc-albums', icon: '💿', group: '本地库', label: '按专辑分组统计曲库（点击即过滤）', keywords: ['album', '专辑', '分组', 'group'], run: () => _call('showAlbumGroups') },
  { id: 'lc-folders', icon: '🗂', group: '本地库', label: '按所在文件夹分组过滤曲库', keywords: ['folder', 'dir', 'path', '文件夹', '目录', '分组', 'group'], run: () => _call('showFolderGroups') },

  { id: 'misc-sleep', icon: '⏾', group: '其他', label: '睡眠定时（N 分钟后暂停）', keywords: ['sleep timer'], run: () => _call('openSleepTimerMenu') },
  { id: 'misc-endstop', icon: '⏹', group: '其他', label: '播完当前歌曲再停（不切下一首）', keywords: ['sleep after song', 'end stop', '播完', '睡眠', '停止', '定时'], run: () => _call('toggleEndStop') },
  { id: 'misc-sort', icon: '↕', group: '其他', label: '切换搜索结果排序（时长/来源）', keywords: ['sort', '排序', 'duration'], run: () => _call('cycleSearchSort') },
  { id: 'misc-groups', icon: '🔗', group: '其他', label: '查看跨平台同名分组', keywords: ['cross platform', '分组', '同名', '聚合'], run: () => _call('showSongGroupsModal') },
  { id: 'misc-dism', icon: '🚫', group: '其他', label: '已屏蔽管理（不感兴趣列表，可恢复/清空）', keywords: ['dismiss', '屏蔽', '不感兴趣', 'blacklist'], run: () => _call('showDismissedManager') },
  { id: 'misc-artist', icon: '🔍', group: '其他', label: '搜索当前播放歌曲的歌手', keywords: ['artist', '歌手', '搜索'], run: () => {
    const s = typeof window.getState === 'function' ? window.getState('currentPlaying') : null;
    if (s && s.artist) _call('searchArtistSongs', s.artist);
    else showToast('暂无正在播放歌曲的歌手信息', 'warn');
  } },
  { id: 'misc-lsort', icon: '↕', group: '其他', label: '切换本地曲库排序（标题/歌手/时长/大小/播放/最近添加）', keywords: ['local sort', '本地排序', 'play count', 'recent', '最近添加', 'mtime'], run: () => _call('cycleLocalSort') },
  { id: 'misc-focus', icon: '🎯', group: '其他', label: '聚焦搜索框', keywords: ['focus', '输入'], run: () => { _goto('search'); const el = document.getElementById('searchInput'); if (el) setTimeout(() => el.focus(), 80); } },
  { id: 'misc-cache', icon: '🗑', group: '其他', label: '清理播放缓存', keywords: ['cache', '缓存'], run: () => _call('clearPlayCache') },
];

// 面板真正用的那张表：关掉的特性不进表。导出的 COMMANDS 保持原样（它是清单，不是入口），
// 但 _refresh 的两条通路（模糊排序 + 最近使用）都只读这张过滤表 —— 只接一条，
// 存过 nav-ai 的用户下次呼出面板仍会被「最近使用」把它复活。
const PALETTE_COMMANDS = filterByFeature(COMMANDS, featureOn);

// ── 面板 UI ──────────────────────────────────────────
let _open = false;
let _items = [];
let _active = 0;
let _opener = null;   // 唤起面板时的聚焦元素（182 规矩：关闭归还焦点）
let _capture = null;  // 围堵监听句柄（②③④⑤ 的唯一键位之家）

// 最近使用持久化：localStorage 异常（隐私模式/透明窗禁存储）一律静默
const RECENTS_KEY = 'cmdkRecents';
function _loadRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [];
  } catch (_e) { return []; }
}
function _saveRecents(list) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (_e) { /* 存不了就不记 */ }
}

function _ensureOverlay() {
  let el = document.getElementById('cmdkOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cmdkOverlay';
  el.className = 'edit-overlay hidden';
  el.setAttribute('role', 'dialog'); // ⑦：读屏须知道"世界换成了面板"
  el.setAttribute('aria-modal', 'true');
  // 浮层注册表自报家门（增量197，还 195 的账）：手抄清单时代 cmdkOverlay 从来
  // 不在表里，背景键守卫与 Esc 双双失明；195 的围堵是第二保险，注册表是正源。
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'closeCommandPalette');
  el.setAttribute('data-modal-pri', '95');
  el.innerHTML = `
    <div class="cmdk-panel">
      <input id="cmdkInput" class="cmdk-input" autocomplete="off" spellcheck="false"
        placeholder="输入命令名 / 拼音 / 别称，回车执行…">
      <div id="cmdkList" class="cmdk-list"></div>
      <div class="cmdk-hint">↑↓ 选择 · Enter 执行 · Esc 关闭 · 随时 Ctrl+K 呼出</div>
    </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeCommandPalette(); });
  document.body.appendChild(el);
  const input = el.querySelector('#cmdkInput');
  input.addEventListener('input', () => _refresh(input.value));
  // 键位语义全部住进围堵层（⑤"一个键一个家"）——输入框不再自带第二套 keydown
  return el;
}

function _renderList() {
  const box = document.getElementById('cmdkList');
  if (!box) return;
  box.textContent = '';
  _items.forEach((c, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdk-item' + (i === _active ? ' cmdk-active' : '');
    const icon = document.createElement('span');
    icon.className = 'cmdk-icon';
    icon.textContent = c.icon || '·';
    const label = document.createElement('span');
    label.className = 'cmdk-label';
    label.textContent = c.label;
    const group = document.createElement('span');
    group.className = 'cmdk-group';
    group.textContent = c.group || '';
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(group);
    row.addEventListener('click', () => _exec(c));
    row.addEventListener('mousemove', () => { if (_active !== i) { _active = i; _highlight(); } });
    box.appendChild(row);
  });
}

function _highlight() {
  const box = document.getElementById('cmdkList');
  if (!box) return;
  [...box.children].forEach((el, i) => el.classList.toggle('cmdk-active', i === _active));
}

function _move(delta) {
  if (!_items.length) return;
  _active = (_active + delta + _items.length) % _items.length;
  _highlight();
  const box = document.getElementById('cmdkList');
  const el = box && box.children[_active];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function _refresh(query) {
  _items = rankCommands(query, PALETTE_COMMANDS);
  if (!String(query || '').trim()) {
    // 空查询（刚呼出）：最近使用置顶，其余保持原序跟在后面
    const rec = pickRecents(_loadRecents(), PALETTE_COMMANDS);
    if (rec.length) {
      const taken = new Set(rec.map(c => c.id));
      _items = rec.concat(_items.filter(c => !taken.has(c.id))).slice(0, 30);
    }
  }
  _active = 0;
  _renderList();
}

function _exec(cmd) {
  _saveRecents(recordRecent(_loadRecents(), cmd && cmd.id));
  closeCommandPalette();
  setTimeout(() => {
    try { cmd.run(); } catch (e) { logger.warn('[cmdk] 命令执行失败:', cmd.id, e && e.message); }
  }, 0);
}

function _execActive() {
  const c = _items[_active];
  if (c) _exec(c);
}

/** 面板焦点环：输入框 + 全部命令行钮（⑤ Tab 陷阱的循环面） */
function _focusables() {
  const el = document.getElementById('cmdkOverlay');
  if (!el) return [];
  const input = document.getElementById('cmdkInput');
  return [input].concat(Array.prototype.slice.call(el.querySelectorAll('button'))).filter(Boolean);
}

function _cycleFocus(step) {
  const list = _focusables();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  list[((i < 0 ? 0 : i) + step + list.length) % list.length].focus();
}

/**
 * 围堵层：面板开着时全站键盘的唯一入口。
 * 顺序纪律（193 血账）：让位必须排在围堵前面——确认框叠上时本层连封层都不做，
 * 否则跑在 confirm 前面的 capture 会把它 182 的键盘契约整个掐死。
 */
function _onPanelKey(e) {
  if (hasOpenConfirm()) return;
  e.stopImmediatePropagation();
  e.stopPropagation();
  if (e.isComposing) return; // ④：合成中的键归输入法，默认动作照常上屏
  if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
    e.preventDefault(); // ③：围堵掐死了 bubble 层的 onGlobalKey，toggle 通道必须自留
    closeCommandPalette();
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); _cycleFocus(e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); _move(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); _move(-1); return; }
  if (e.key === 'Enter') { e.preventDefault(); _execActive(); }
  // 其余键：不处理也不 preventDefault——打字/Ctrl+A 选字/退格删除等原生默认动作
  // 不受传播截断影响，输入框照常收字。
}

function openCommandPalette() {
  if (_open) return; // 重入会把围堵监听叠着再装一层——一个键一个家
  _opener = document.activeElement; // ⑥：先记账，关层时还
  const el = _ensureOverlay();
  el.classList.remove('hidden');
  _open = true;
  const input = document.getElementById('cmdkInput');
  if (input) {
    input.value = '';
    _refresh('');
  }
  _capture = _onPanelKey;
  document.addEventListener('keydown', _capture, true);
  if (input) input.focus(); // ①：同步聚焦，呼出即可打字，不留 30ms 空窗
}

function closeCommandPalette() {
  if (!_open) return;
  const el = document.getElementById('cmdkOverlay');
  if (el) el.classList.add('hidden');
  if (_capture) {
    document.removeEventListener('keydown', _capture, true);
    _capture = null;
  }
  _open = false;
  if (_opener && typeof _opener.focus === 'function') _opener.focus(); // ⑥
  _opener = null;
}

function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    if (_open) closeCommandPalette(); else openCommandPalette();
  }
}

if (typeof document !== 'undefined') document.addEventListener('keydown', onGlobalKey);

window.openCommandPalette = openCommandPalette;
window.closeCommandPalette = closeCommandPalette;

export { fuzzyScore, rankCommands, COMMANDS, openCommandPalette, closeCommandPalette };
