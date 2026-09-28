/**
 * 播放失败的就地补救—— 从「📁 本地文件读不到」这句话里直接伸手重下
 *
 * 把说法改对了，但也仅止于说法：想重下得自己翻到下载历史页、认出那一行。
 * 153/154 的批量口在另一个页面上，正在连播的人根本想不到那儿去。本模块只管一件小事：
 * 播放器决定"要不要给按钮"（playError.playFailureRetry），这里负责怎么入队、
 * 以及入队后按主进程的回话如实说什么 —— 一首都没进队列时不许报成功。
 */

import { errBrief } from './errBrief.js';
import { logger } from './logger.js';
import { enqueuePayloadFor, classifyRetryResult } from './enqueuePayload.js';

/**
 * @param {object} row playFailureRetry 给的回下行（含 id/source/title/artist/album/quality）
 */
async function retryAfterPlayFailure(row) {
  const payload = enqueuePayloadFor(row, getState('saveDir'));
  if (!payload) { showToast('⚠️ 这首歌缺少平台标识，重新下载不了', 'warn'); return; }
  let res = null;
  try {
    res = await api.addToQueue(payload);
  } catch (e) {
    logger.warn('[playRetry] 重新下载入队失败:', e.message);
    showToast('⬇ 重新下载失败：' + errBrief(e), 'error');
    return;
  }
  const kind = classifyRetryResult(res);
  if (kind === 'added') {
    showToast('⬇ 已重新加入下载队列', 'success');
    if (typeof switchDlSubTab === 'function') switchDlSubTab('queue');
    return;
  }
  if (kind === 'dup') { showToast('ℹ️ 这首歌本来就在下载队列里，等它下完即可', 'info'); return; }
  if (kind === 'had') { showToast('ℹ️ 文件又回到了磁盘上（可能刚被同步盘放回来），没有重复下载', 'info', 5000); return; }
  showToast('⬇ 重新下载失败：' + ((res && res.error) || '未知错误'), 'error');
}

export { retryAfterPlayFailure };
