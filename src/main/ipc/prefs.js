/**
 * 用户偏好 IPC
 *
 * 注册：get-pref / set-pref
 *
 * 持久化到 userData/prefs.json（用 utils/prefs.js）
 */

const prefs = require('../../utils/prefs');
const { handle } = require('./register');
const logger = require('../../utils/logger');
const approvedDirs = require('../approvedDirs');

// C1: 目录型偏好只有「用户经原生选器选过的」（select-dir 登记 + 启动 seed）
// 才允许写入，否则被 XSS 的渲染层可直接 set-pref('saveDir','C:\\Windows\\...')
// 绕过下载落盘沙箱。空值视为清除，放行。
const { DIR_PREF_KEYS } = approvedDirs;

// H9: Whitelist of allowed preference keys to prevent arbitrary key injection
// 键全集 = 主进程 prefs.get() 读取的键 ∪ 渲染层 getPref/setPref 使用的键（见 src/renderer/js/）
// 白名单只登记「有消费方、且有写入口」的键：挂了名字却没代码读的键，
// set-pref 照样回 true，等于对调用方承诺"设置已保存"而这件事永远不会发生；被代码
// 读着却进不了白名单的键，则是谁都改不动的死旋钮。两个方向由
// test/prefs-key-reconciliation.test.js 双向对账，新键与它的消费方/控件必须同一次落地。
const ALLOWED_PREF_KEYS = new Set([
  // 目录 / 通用
  'saveDir', 'localDirPath', 'theme', 'language',
  'quality', 'concurrency', 'speedLimit', 'notifications',
  // 命名模板（统一键名：下载页与设置页共用 namingTemplate）
  'namingTemplate',
  // 分平台音质覆盖表：平台 id → standard/hq/lossless，未列出的平台沿用 quality
  'qualityBySource',
  // 3-C quality policy rules: ordered [{id, enabled, params}]; downloadQueue reads it
  // before taking a stream; settings page writes it.
  'qualityPolicyRules',
  // 换源排除平台清单（设置页写，主进程 resolveTrackService 每次解析时读）
  'fallbackDisabledPlatforms',
  // 单平台并发上限 / 单曲失败尝试次数（设置页 GENERAL_PREFS 写，主进程 downloadQueue 读）
  'perSourceConcurrency', 'maxAttempts',
  // 下载完成钩子开关（autoLyric/autoCoverOnDone.js 读，设置页写）
  'autoLyric', 'autoCover',
  // 播放行为
  'lyricFontSize', 'lyricOffset', 'playProgressMemory', 'playerVolume',
  'playbackRate', 'globalShortcuts',
  // 四枚全局动作各自的 accelerator（主进程 registerGlobalShortcuts 读；
  // 候选白名单与默认值的家在 src/shared/accelerators.js）
  'shortcutPlayPause', 'shortcutPrev', 'shortcutNext', 'shortcutShowHide',
  // 播放淡入/淡出档位（ms，player/fade.js 读写）
  'fadeInMs', 'fadeOutMs',
  // 歌词区显隐与逐曲偏移覆盖（player/lyrics.js 读写）
  'lyricsVisible', 'lyricOverrides',
  // 搜索页「不感兴趣」屏蔽清单（views/dismissed.js 读写）
  'dismissedSongs',
  // 剪贴板链接识别开关（主进程 clipboardWatch 每 tick 读取）
  'clipboardWatch',
  // 订阅新歌的周期检查间隔（小时，主进程 subscriptions._intervalMs 读，设置页写）
  'subscriptionCheckIntervalHours',
  // 下载队列全部完成后的动作（none/quit/sleep/shutdown，渲染层 afterQueueDone.js 读写）
  'afterQueueDone',
  // 定时下载任务列表（渲染层 scheduledDownload.js 读写：[{id, at, lines}]）
  'scheduledDownloads',
  // 新手引导已看过标记（渲染层 welcome.js 读写）
  'welcomeSeen',
  // 播放状态持久化
  'recentlyPlayed', 'playStats', 'playProgressMap',
  // EQ
  'eqPreset', 'eqGains', 'eqBypass',
  // AI 音乐
  'aiMusicApiKey', 'aiMusicSaveDir',
  // 转码输出目录 / 响度归一开关（P0-B）
  'convertOutputDir', 'convertLoudnorm',
  // 队列模板 / 搜索历史（主进程内部写入，但导入流程会经 set）
  'downloadTemplates', 'searchHistory',
]);

function register() {
  handle('get-pref', (_, key) => prefs.get(key));
  handle('set-pref', (_, key, value) => {
    if (!ALLOWED_PREF_KEYS.has(key)) {
      logger.warn('[prefs] 拒绝写入未白名单的键:', key);
      return false;
    }
    if (DIR_PREF_KEYS.has(key) && value && !approvedDirs.isApprovedDir(value)) {
      logger.warn('[prefs] 拒绝未批准的目录:', key);
      return false;
    }
    // 凭证键在安全存储不可用时会返回 false（拒绝明文落盘）——
    // 如实回 false，别对调用方谎报「已保存」（渲染层据此提示用户）
    return prefs.set(key, value) !== false;
  });
  // 修复 B8：搜索历史通过 IPC 持久化到主进程 prefs.json（而非渲染端 localStorage）
  handle('get-search-history', () => prefs.get('searchHistory') || []);
  handle('set-search-history', (_, history) => {
    if (!Array.isArray(history)) return false;
    prefs.set('searchHistory', history.slice(0, 20)); // 上限 20 条
    return true;
  });
}

module.exports = { register, ALLOWED_PREF_KEYS };
