/**
 * 下载完成自动补歌词
 *
 * 设置页「autoLyric」开关（prefs 默认 true）此前只有 UI 没有消费方，本模块
 * 把它做实：queue-updated 里新完成的下载行 → 该文件已有歌词（sidecar/嵌入）
 * 则跳过 → get-lyrics 取词 → write-local-lrc 写在音频旁。全部复用现有通道，
 * 零新 IPC。会话内按 source:id 去重，失败静默（下次队列推送可重试）。
 */

import { logger } from './logger.js';

const _seen = new Set();          // 'source:id' 本轮会话已处理的完成行
let _enabled = null;              // null=未读；getPref 只拉一次

/** 纯函数：从队列快照挑出未处理过的完成行（同时登记 seen 防重） */
export function pickLyricTargets(queue, seen) {
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

/** 纯函数：read-local-lrc 返回里是否已有歌词（有则不覆盖用户歌词） */
export function hasExistingLyric(r) {
  return !!(r && typeof r.lrc === 'string' && r.lrc.trim());
}

let _toastTimer = null;
let _written = 0;
function _reportOne() {
  _written++;
  if (_toastTimer) return;
  _toastTimer = setTimeout(() => {
    _toastTimer = null;
    const n = _written; _written = 0;
    showToast(`🎤 已自动保存 ${n} 首歌词（.lrc）`, 'info', 2200);
  }, 1200);
}

/** 队列推送入口（app.js onQueueUpdated 调用）。返回 promise 便于测试等待。 */
export async function autoLyricObserve(queue) {
  if (typeof api === 'undefined' || typeof api.getLyrics !== 'function') return;
  if (_enabled === null) {
    try { _enabled = (await api.getPref('autoLyric')) !== false; }
    catch (e) { _enabled = true; }
  }
  if (!_enabled) return;
  const targets = pickLyricTargets(queue, _seen);
  for (const t of targets) {
    try {
      const cur = await api.readLocalLrc(t.filePath);
      if (hasExistingLyric(cur)) continue;
      const r = await api.getLyrics(t.id, t.source, t.title, t.artist);
      if (!hasExistingLyric(r)) continue;
      await api.writeLocalLrc(t.filePath, r.lrc);
      _reportOne();
    } catch (e) {
      logger.warn('[autoLyric] 补词失败:', t.filePath, e && e.message);
    }
  }
}

window.autoLyricObserve = autoLyricObserve;
