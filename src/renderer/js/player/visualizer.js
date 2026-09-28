/**
 * MusicDL 播放器 — 频谱可视化
 *
 * 数据源是 player/eq.js 音频图上的 AnalyserNode 只读抽头
 * （source → preamp → filters → analyser → destination，对声音零影响。
 *   preamp 是 eq.js 的输出级 trim，刻意排在滤波之前：trim 与滤波串联时
 * 增益可交换，挪位置只改频谱抽到的是什么，不改听感。）
 * createMediaElementSource 一个元素只能建一次，建图必须统一走
 * ensureAudioGraph()——本模块严禁自造 AudioContext 节点。
 */
import { ensureAudioGraph, getAnalyser } from './eq.js';

const VIZ_H = 34;

let _on = false;
let _raf = 0;
let _data = null;

/**
 * 把频域字节数组（0..255）均分成 bars 组，组内均值归一 0..1。
 * sqrt 提升弱高频尾巴，条状分布视觉上更均衡。
 */
export function computeBars(freq, bars) {
  const n = freq ? freq.length : 0;
  const count = bars > 0 ? Math.floor(bars) : 0;
  const out = new Array(count).fill(0);
  if (!n || !count) return out;
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * n) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / count));
    let sum = 0;
    for (let j = start; j < end; j++) sum += freq[j];
    out[i] = Math.min(1, Math.sqrt(sum / (end - start) / 255));
  }
  return out;
}

function _syncBtn(on) {
  const btn = document.getElementById('btnVisualizer');
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function _vizToast(msg) {
  if (typeof showToast === 'function') showToast(msg, 'error');
}

function _draw() {
  if (!_on) return;
  const canvas = document.getElementById('vizCanvas');
  const an = getAnalyser();
  if (!canvas || !an) { stopVisualizer(); return; }
  const g = canvas.getContext('2d');
  an.getByteFrequencyData(_data);
  const w = canvas.width;
  const h = canvas.height;
  const bars = computeBars(_data, Math.max(16, Math.floor(w / 8)));
  g.clearRect(0, 0, w, h);
  const bw = w / bars.length;
  for (let i = 0; i < bars.length; i++) {
    const bh = Math.max(1, bars[i] * h);
    g.fillStyle = `hsl(${185 + (i / bars.length) * 75}, 90%, ${45 + bars[i] * 25}%)`;
    g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  }
  _raf = requestAnimationFrame(_draw);
}

/** 开启频谱（用户手势上下文里建图安全）；再次调用即关闭 */
export function toggleVisualizer() {
  if (_on) { stopVisualizer(); return; }
  if (!ensureAudioGraph()) { _vizToast('音频图初始化失败，频谱不可用'); return; }
  const an = getAnalyser();
  const canvas = document.getElementById('vizCanvas');
  if (!an || !canvas) { _vizToast('频谱可视化不可用'); return; }
  canvas.width = Math.max(160, canvas.clientWidth || 360);
  canvas.height = VIZ_H;
  _data = new Uint8Array(an.frequencyBinCount);
  canvas.style.display = 'block';
  _on = true;
  _syncBtn(true);
  _raf = requestAnimationFrame(_draw);
}

function stopVisualizer() {
  _on = false;
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  const canvas = document.getElementById('vizCanvas');
  if (canvas) {
    canvas.style.display = 'none';
    const g = canvas.getContext('2d');
    if (g) g.clearRect(0, 0, canvas.width, canvas.height);
  }
  _syncBtn(false);
}

/** 测试/巡检钩子：当前是否开启 */
export function isVisualizerOn() { return _on; }

if (typeof window !== 'undefined') {
  window.toggleVisualizer = toggleVisualizer;
}
