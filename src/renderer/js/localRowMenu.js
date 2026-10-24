/**
 * 本地曲库行右键菜单构建
 *
 * 纯函数：给定歌曲行与动作回调，返回 contextMenu 条目数组（形状见
 * contextMenu.js：{icon,label,onClick} / {sep:true}）。local.js 负责
 * showContextMenu 弹出与动作实现，本文件不碰 DOM。
 *
 * 图标走 iconHtml + data-ico（仓内静态字符串，符合 contextMenu 的白名单
 * 通道）：icon 字段的文本 emoji（✏️📂📋 等）在极夜主题下是彩色像素图，
 * 与线性行内图标集（icons.css）不一致，2026-10-24 视觉检查后统一换掉。
 * 心形收藏保留文本 ♥/♡ —— 单色字形跟随 currentColor，主题安全，且
 * heartBtnHtml 全站同款，单独换掉反而两种形态并存。
 */

/** data-ico 条目的 iconHtml 模板（静态字符串，无用户可控字段）。 */
const ico = (name) => `<span data-ico="${name}" data-ico-only></span>`;

export function buildLocalRowMenuItems(song, actions) {
  const items = [
    { iconHtml: ico('play'), label: '播放', onClick: () => actions.play(song) },
    { iconHtml: ico('pencil'), label: '编辑信息', onClick: () => actions.edit(song) },
    { icon: actions.favOn ? '💔' : '♥', label: actions.favOn ? '取消收藏' : '收藏', onClick: () => actions.fav(song) },
    { sep: true },
    { iconHtml: ico(actions.probeDone ? 'check' : 'microscope'), label: '检测真实音质', onClick: () => actions.probe(song) },
    { iconHtml: ico('folder-open'), label: '打开所在文件夹', onClick: () => actions.reveal(song) },
    { iconHtml: ico('link'), label: '复制文件路径', onClick: () => actions.copyPath(song.filePath) },
  ];
  return items;
}
