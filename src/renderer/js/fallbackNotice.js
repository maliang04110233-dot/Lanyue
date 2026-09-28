/**
 * 换源播放提示文案—— 共享纯函数。
 *
 * 背景：fresh 换源成功时五处播放入口各抄了一份 toast 文案（且用裸平台 id，
 * 显示「kuwo」而不是「酷我」，与 platformName 的显示名口径不一致）；
 * `_altSource` 记忆命中路径（第二次播放直接用上次成功的源）则**完全无提示**，
 * 用户看到的是「netease 的歌怎么是别家音质/音质档」。这里统一两处口径。
 *
 * 判定字段来自主进程 resolveTrackService 的返回归一化：
 *   - 新鲜换源成功 → matchedSong + matchedFrom（源切换）；
 *   - 记忆命中   → fromAltMemory + matchedFrom，无 matchedSong。
 * 名字解析默认取 utils.js 挂到全局的 platformName（node 测试下回落原 id，
 * 也可显式注入 stub），永不调用会抛错的路径。
 */

/**
 * 生成换源提示文案。
 * @param {Object|null} result getDownloadUrlSmart 返回的取流结果
 * @param {string} ownSource 歌曲原本的 source
 * @param {(id:string)=>string} [nameOf] 平台显示名解析（缺省用全局 platformName）
 * @returns {string|null} 需要提示时的文案，否则 null（本源直出/失败结果）
 */
function buildFallbackNotice(result, ownSource, nameOf) {
  if (!result || !result.url) return null;
  const name = nameOf || globalThis.platformName || ((id) => id);
  const to = result.source || (result.matchedSong && result.matchedSong.source);
  if (!to) return null;

  if (result.fromAltMemory) {
    const from = result.matchedFrom || ownSource;
    if (to === from) return null;
    return `🔁 沿用上次的换源结果，正在播放${name(to)}音源（原源${name(from)}暂不可用）`;
  }
  if (result.matchedSong) {
    const from = result.matchedFrom || ownSource;
    return `🎵 ${name(from)}源不可用，已切换到${name(to)}音源`;
  }
  return null;
}

if (typeof window !== 'undefined') {
  window.buildFallbackNotice = buildFallbackNotice;
}

export { buildFallbackNotice };
