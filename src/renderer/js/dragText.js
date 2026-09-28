/**
 * 拖拽取文本的纯函数（node 可测）：
 * 只有当拖拽载荷含可粘贴文本时才接管；文件拖入（Files）不接管，
 * 返回 null 由调用方静默忽略。长度钳到 500（与剪贴板识别同界）。
 */

const MAX_DROP_CHARS = 500;

/**
 * @param {{types: Iterable<string>, getData: (t:string)=>string}} dt DataTransfer 形状
 * @returns {string|null} 要交给搜索流程的文本，或 null（不处理）
 */
export function pickDroppedText(dt) {
  if (!dt || typeof dt.getData !== 'function') return null;
  const types = Array.from(dt.types || []);
  if (types.includes('Files')) return null;
  const hasText = types.includes('text/plain') || types.includes('text') || types.includes('URL');
  if (!hasText) return null;
  const raw = dt.getData('text/plain') || dt.getData('text') || dt.getData('URL') || '';
  const trimmed = String(raw).trim();
  return trimmed ? trimmed.slice(0, MAX_DROP_CHARS) : null;
}

// ── 歌词文件拖入──────────────────────────────
export const MAX_LRC_BYTES = 512 * 1024;

/** .lrc 直接认；.txt 只是候选（内容须过 looksLikeLrc），其余不接管 */
export function isLrcFilename(name) {
  const s = String(name == null ? '' : name);
  return /\.lrc$/i.test(s) || /\.txt$/i.test(s);
}

/** 时间戳行（[mm:ss] / [mm:ss.xx] / [m:ss.xx]）≥3 行才像歌词，防误拖普通文本 */
export function looksLikeLrc(text) {
  const t = String(text == null ? '' : text);
  const lines = t.match(/^\[\d{1,3}[:.]\d{1,2}([:.]\d{1,3})?\]/gm);
  return !!lines && lines.length >= 3;
}
