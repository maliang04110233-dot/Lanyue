/**
 * 下载完成自动嵌封面
 *
 * 设置页「autoCover」开关（prefs 默认 true）此前只有 UI 没有消费方，本模块
 * 把它做实：queue-updated 里新完成的下载行 → read-local-metadata 探测文件
 * 已有封面（含同目录 cover.jpg 兜底，探测不到才算无图）→ fetch-online-cover
 * 取 data URL → update-id3-cover 嵌入。已有封面绝不盲写覆盖。全部复用现有
 * 通道，零新 IPC。会话内按 source:id 去重，失败静默（下次队列推送可重试）。
 */

import { logger } from './logger.js';

const _seen = new Set();          // 'source:id' 本轮会话已处理的完成行
let _enabled = null;              // null=未读；getPref 只拉一次

/** 纯函数：从队列快照挑出未处理过的完成行（同时登记 seen 防重） */
export function pickCoverTargets(queue, seen) {
  const out = [];
  if (!Array.isArray(queue) || !seen || typeof seen.add !== 'function') return out;
  for (const s of queue) {
    if (!s || s.status !== 'done') continue;
    const filePath = s.filePath || s.savePath;
    if (!filePath || s.id == null || !s.title) continue;
    const key = String(s.source || '') + ':' + String(s.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filePath, id: s.id, source: s.source, title: s.title, artist: s.artist || '' });
  }
  return out;
}

/** 纯函数：read-local-metadata 返回里是否已有封面（有则不碰用户文件） */
export function hasExistingCover(meta) {
  return !!(meta && typeof meta.coverBase64 === 'string' && meta.coverBase64.trim());
}

/** 纯函数：fetch-online-cover 返回里取可嵌的 data URL（update-id3-cover 要整串） */
export function coverFromFetch(r) {
  if (!r || !r.success) return null;
  return typeof r.coverBase64 === 'string' && r.coverBase64.trim() ? r.coverBase64 : null;
}

let _toastTimer = null;
let _embedded = 0;
function _reportOne() {
  _embedded++;
  if (_toastTimer) return;
  _toastTimer = setTimeout(() => {
    _toastTimer = null;
    const n = _embedded; _embedded = 0;
    showToast(`🖼 已自动嵌入 ${n} 张封面`, 'info', 2200);
  }, 1200);
}

/** 队列推送入口（app.js onQueueUpdated 调用）。返回 promise 便于测试等待。 */
export async function autoCoverObserve(queue) {
  if (typeof api === 'undefined'
    || typeof api.readLocalMetadata !== 'function'
    || typeof api.fetchOnlineCover !== 'function'
    || typeof api.updateId3Cover !== 'function') return;
  if (_enabled === null) {
    try { _enabled = (await api.getPref('autoCover')) !== false; }
    catch (e) { _enabled = true; }
  }
  if (!_enabled) return;
  const targets = pickCoverTargets(queue, _seen);
  for (const t of targets) {
    try {
      const meta = await api.readLocalMetadata(t.filePath);
      if (hasExistingCover(meta)) continue;
      const dataUrl = coverFromFetch(await api.fetchOnlineCover(t.title, t.artist));
      if (!dataUrl) continue;
      const r = await api.updateId3Cover(t.filePath, dataUrl);
      if (r && r.success) _reportOne();
    } catch (e) {
      logger.warn('[autoCover] 嵌封面失败:', t.filePath, e && e.message);
    }
  }
}

window.autoCoverObserve = autoCoverObserve;
