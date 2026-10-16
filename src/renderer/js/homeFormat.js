/**
 * 首页视图的纯格式化 / HTML 片段函数。
 *
 * 从 src/renderer/js/views/home.js 拆出（阶段 4 渲染层模块化）：
 * 封面缩略图、无封面占位、行内操作图标、毫秒时长均为纯函数，不依赖
 * 模块级状态，不操作 DOM，便于独立单测。home.js 保留导入与调用，
 * 对外行为不变。
 */

import { escAttr } from './utils.js';

export const ROW_ICONS = {
  play:  '<path d="M6 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  down:  '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  plus:  '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  heartOn: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
};

/** 无封面时的占位图形（内联 SVG，不依赖 emoji 字体） */
export function noCoverSvgHtml() {
  return `<svg class="cover-ph-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

/** 36px 方形封面缩略图。无封面时显示 noCoverSvgHtml() 占位。 */
export function coverThumbHtml(url, cls) {
  const c = cls || 'top-song-cover';
  return `<span class="${c}">${
    url
      ? `<img src="${escAttr(url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove()">`
      : ''
  }${noCoverSvgHtml()}</span>`;
}

/** 行内操作图标（内联 SVG，统一 16px 网格 + 1.7 描边）。 */
export function svgIcon(name) {
  return `<svg class="row-icon" viewBox="0 0 24 24" aria-hidden="true">${ROW_ICONS[name] || ''}</svg>`;
}

/** 毫秒 → m:ss；缺失/非法返回空串（不显示「0:00」这种噪音） */
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}
