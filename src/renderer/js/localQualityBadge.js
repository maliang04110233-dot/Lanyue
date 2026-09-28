/**
 * 本地曲库行「音质徽标」—— 纯函数（node 可单测，零 DOM）
 *
 * 行内原本只有时长 + 体积：一首 .flac 到底是真无损还是 MP3 改的，得逐首
 * 右键实测才知道。这里把「扩展名（标称）」和「ffprobe 实测结果」
 * 合成一行小徽标，实测过就以实测为准并盖住标称 —— 伪无损一眼可辨。
 * 扩展名口径复用 localFormatFilter.extOf（与 107 的格式过滤同一个来源）。
 */

import { extOf } from './localFormatFilter.js';

/** 常见容器显示名；表里没有的扩展名直接大写 */
const EXT_LABEL = {
  flac: 'FLAC', wav: 'WAV', aiff: 'AIFF', aif: 'AIFF', alac: 'ALAC',
  mp3: 'MP3', aac: 'AAC', m4a: 'M4A', ogg: 'OGG', opus: 'OPUS',
  ape: 'APE', wv: 'WV', dsf: 'DSF', dff: 'DFF', wma: 'WMA',
};

/** 实测判定 → 颜色（全是字面量 token，不进任何外部数据） */
const COLOR = {
  plain: 'var(--text-muted)',
  lossless: 'var(--neon-green)',
  suspicious: 'var(--neon-yellow)',
  lossy: 'var(--neon-orange)',
};

const VERDICT_LABEL = {
  lossless: '真无损',
  suspicious: '存疑（低码率转制）',
  lossy: '伪无损',
};

/** 无损类容器：扩展名看着是无损，但没实测时不能算「已证实」 */
const LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv', 'dsf', 'dff']);

function extLabel(ext) {
  return EXT_LABEL[ext] || String(ext || '').toUpperCase();
}

/**
 * 徽标数据；无扩展名且无实测结果时返回 null（不出徽标）。
 * @param {object} song 本地曲库行（用 filePath）
 * @param {object|null} probe audioProbe 的实测结果（可为失败对象）
 */
export function qualityBadge(song, probe) {
  const ext = extOf(song);
  const p = probe && probe.ok ? probe : null;
  const codec = p && p.codec ? String(p.codec).toUpperCase() : '';
  const kbps = p && Number.isFinite(p.bitrateKbps) && p.bitrateKbps > 0 ? `${Math.round(p.bitrateKbps)}k` : '';
  const verdict = p ? (VERDICT_LABEL[p.verdict] ? p.verdict : '') : '';

  let text = '';
  if (codec) {
    text = kbps ? `${codec} · ${kbps}` : codec;
    if (verdict === 'lossy') text += ' ✕';
    else if (verdict === 'suspicious') text += ' ?';
    else if (verdict === 'lossless') text += ' ✓';
  } else if (ext) {
    text = extLabel(ext);
  }
  if (!text) return null;

  const nominal = ext ? extLabel(ext) : '无扩展名';
  const bits = [`标称：${nominal}`];
  if (p) {
    bits.push(`实测：${codec || '编码未知'}`);
    bits.push(kbps ? `码率 ${kbps}` : '码率未知');
    if (p.sampleRate) bits.push(`${Math.round(p.sampleRate / 1000)}kHz`);
    bits.push(verdict ? VERDICT_LABEL[p.verdict] : '判定未知');
  } else if (LOSSLESS_EXT.has(ext)) {
    bits.push('未实测（右键「检测音质」验真伪无损）');
  }
  return { text, title: bits.join(' · '), color: COLOR[verdict] || COLOR.plain };
}
