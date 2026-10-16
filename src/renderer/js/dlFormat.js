/**
 * 下载视图的纯格式化函数。
 *
 * 从 src/renderer/js/views/download.js 拆出（阶段 4 渲染层模块化）：
 * 文件大小/时长/ETA/URL 脱敏/进度文案均为纯函数，不依赖 DOM，不应长期
 * 留在一个 760 行的 view 里。download.js 保留窗口桥接（window.dlProgressText
 * 供 app.js 与 HTML inline 调用），具体实现统一在这里，便于独立单测。
 */

import { formatBytes } from './utils.js';

export function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export function formatDuration(ms) {
  if (ms == null || ms === 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return min + ' 分 ' + (remain > 0 ? remain + ' 秒' : '');
}

export function maskUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname;
    const parts = u.pathname.split('/');
    const filename = parts[parts.length - 1];
    if (filename.length > 20) {
      return host + '/…' + filename.slice(-18);
    }
    return host + '/' + filename;
  } catch (_e) {
    if (url.length > 40) return url.slice(0, 20) + '…' + url.slice(-16);
    return url;
  }
}

export function formatEta(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function dlProgressText(info) {
  if (!info) return '';
  const parts = [];
  if (typeof info.progress === 'number') parts.push(info.progress + '%');
  if (info.speedBps > 0) parts.push(formatBytes(info.speedBps) + '/s');
  if (info.etaSec != null) parts.push('剩余 ' + formatEta(info.etaSec));
  if (info.totalBytes > 0) parts.push(`${formatBytes(info.receivedBytes)} / ${formatBytes(info.totalBytes)}`);
  return parts.join(' · ');
}
