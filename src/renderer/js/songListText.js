/**
 * 曲单文本导出 —— 纯函数（node 可单测，无 DOM 依赖）
 *
 * 「📋 复制曲单」把当前过滤视图整成一行一首的纯文本（歌名 - 歌手），
 * 发群聊/贴备忘录不用逐行右键复制（是行级分享文案带链接，这里清单级）。
 * 只产文本不碰剪贴板，写剪贴板走 songShare.js 的 copyText。
 */

/** 单曲 → 一行；缺歌手只留歌名，无标题歌跳过（回 ''） */
function toTrackLine(song) {
  const s = song || {};
  const title = String(s.title || '').trim();
  const artist = String(s.artist || '').trim();
  if (!title) return '';
  return artist ? `${title} - ${artist}` : title;
}

/** 批量 → 行数组（脏入参回空数组，空行剔除） */
function toTrackLines(songs) {
  return (Array.isArray(songs) ? songs : []).map(toTrackLine).filter(Boolean);
}

export { toTrackLine, toTrackLines };
