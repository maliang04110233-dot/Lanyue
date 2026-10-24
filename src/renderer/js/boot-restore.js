/**
 * 启动期偏好恢复 —— 自 app.js init() 内闭包提出，等价迁移
 *
 * 内容：prefs 并发拉取与恢复（下载目录/音质/主题/命名模板/本地曲库目录）、
 * 平台清单拉取与源下拉重建、语言包应用、版本号回显、记忆播放进度的一次性迁移。
 *
 * 顺序约定（平台清单必须先于 applyTranslations —— 见 restoreStartupPrefs 内注释）
 * 沿用 app.js 原实现，本模块只是搬走，不改任何顺序与时序。
 * api 由调用方（app.js init 开头 buildApi() 之后）显式传入。
 */

import { logger } from './logger.js';

export async function restoreStartupPrefs(api) {
  // 无相互依赖的启动 IPC 并发拉取：弱机上首屏不再被十几次
  // 串行 round-trip 拖慢。下面的消费顺序保持不变。
  const [savedSaveDir, savedQuality, savedTheme, savedTemplate, savedLocalDir, savedDiscoverLayout] =
    await Promise.all([
      api.getPref('saveDir'),
      api.getPref('quality').catch(() => null),
      api.getPref('theme').catch(() => null),
      api.getPref('namingTemplate'),
      api.getPref('localDirPath'),
      api.getPref('discoverLayout').catch(() => null),
    ]);

  if (savedSaveDir) setState('saveDir', savedSaveDir);
  // 未设置过下载目录时显示主进程默认目录（音乐\MusicDownloader），
  // 避免首页路径栏空白让用户误以为必须手动选目录
  document.getElementById('saveDirText').textContent = getState('saveDir') || (await api.getDefaultDir()) || '';

  // 恢复音质选择（此前仅设置页变更时同步，启动时从未恢复）
  if (savedQuality) {
    const qs = document.getElementById('qualitySelect');
    if (qs) qs.value = savedQuality;
  }

  // 恢复主题（尽早应用，避免闪烁）
  if (savedTheme && typeof applyTheme === 'function') applyTheme(savedTheme);

  // 恢复发现页布局（a/b/c；缺省 a。门户布局的预加载由 applyDiscoverLayout 触发，
  // 但此刻分区块骨架尚未渲染 —— renderHomeBlocks 尾部会按 dataset 再补一次）
  if (typeof applyDiscoverLayout === 'function') applyDiscoverLayout(savedDiscoverLayout || 'a');

  // 平台清单（v3）：源下拉 / 平台名 / 徽标配色的唯一来源，来自主进程 registry。
  // ⚠️ 必须在 applyTranslations() **之前** —— 本步会重建源下拉 DOM，
  //    若放在之后，新插入的「全部」选项拿不到翻译（设计稿 §4.4 的顺序陷阱）。
  try {
    const platforms = await api.getPlatforms();
    setPlatforms(platforms);
    renderSourceSelect(platforms);
  } catch (_e) {
    logger.warn('[init] 获取平台清单失败，降级到内置兜底表:', _e && _e.message);
    renderSourceSelect(getPlatforms());
  }

  // 加载语言包并应用翻译（applyTranslations 内部自会读一次 language pref）
  try {
    if (window.i18n) await window.i18n.applyTranslations();
  } catch (_e) { /* 忽略 */ }

  // 显示版本号 + commit（与上面 prefs 已并发，此处只消费结果）
  try {
    const versionEl = document.getElementById('appVersion');
    const commitEl = document.getElementById('appCommit');
    const ver = await api.getVersion();
    if (versionEl) versionEl.textContent = ver;
    if (window.__APP_COMMIT__ && commitEl) {
      commitEl.textContent = 'commit ' + window.__APP_COMMIT__.slice(0, 7);
    }
  } catch (_e) { /* 忽略 */ }

  // 一次性偏好迁移（2026-10-16）：记忆播放进度默认改为「关闭」。
  // 旧默认是 true，凡已按旧默认开启的用户（偏好值 = true），重播同一首歌
  // 会被拉到断点而不是从头。用户选择「关闭记忆播放进度」，这里把这类
  // 偏好迁移为 false；迁移后用户若在设置页手动开启，不会再被覆盖。
  // 只在「从未被本迁移写过」时执行一次，避免反复改写用户主动的选择。
  try {
    const ppmKey = 'playProgressMemory';
    const ppmMigratedKey = 'playProgressMemoryMigrated';
    if (!(await api.getPref(ppmMigratedKey))) {
      const cur = await api.getPref(ppmKey);
      // 旧默认是 true：凡不是显式 false 的（true，或从未写过的 undefined）
      // 一律固化为 false，让 prefs 里有明确记录、设置页 checkbox 也正确显示关闭态。
      if (cur !== false) await api.setPref(ppmKey, false);
      await api.setPref(ppmMigratedKey, true);
    }
  } catch (_e) { /* 迁移失败不阻断启动 */ }

  // 恢复命名模板（编辑入口在设置页，这里只同步 state）
  if (savedTemplate) {
    setState('namingTemplate', savedTemplate);
  }

  if (savedLocalDir) setState('localDirPath', savedLocalDir);
}
