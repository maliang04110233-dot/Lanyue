/**
 * 本地曲库行右键菜单构建
 *
 * 纯函数：给定歌曲行与动作回调，返回 contextMenu 条目数组（形状见
 * contextMenu.js：{icon,label,onClick} / {sep:true}）。local.js 负责
 * showContextMenu 弹出与动作实现，本文件不碰 DOM。
 */

export function buildLocalRowMenuItems(song, actions) {
  const items = [
    { icon: '▶', label: '播放', onClick: () => actions.play(song) },
    { icon: '✏️', label: '编辑信息', onClick: () => actions.edit(song) },
    { icon: actions.favOn ? '💔' : '♥', label: actions.favOn ? '取消收藏' : '收藏', onClick: () => actions.fav(song) },
    { sep: true },
    { icon: actions.probeDone ? '✓' : '🔬', label: '检测真实音质', onClick: () => actions.probe(song) },
    { icon: '📂', label: '打开所在文件夹', onClick: () => actions.reveal(song) },
    { icon: '📋', label: '复制文件路径', onClick: () => actions.copyPath(song.filePath) },
  ];
  return items;
}
