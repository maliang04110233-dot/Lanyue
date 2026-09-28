/**
 * MusicDL 播放器 — 均衡器（5 段 EQ / 预设曲线 / 偏好持久化）
 *
 * 依赖全局：api（由 app.js 经 window.api getter 注入）、DOM #audioPlayer / #eqPanel
 *
 * 37a57af 起 EQ 真实接入音频链路：首次播放后恢复偏好并懒建
 * AudioContext → MediaElementSource → 5 × BiquadFilter（lowshelf/peaking×3/
 * highshelf）→ destination（在滤波链首与链尾各插一枚节点，见下两段）。
 * _gains 数组是增益的唯一真身（图未建时也能
 * 记录手调值），BiquadFilter 只是它的镜像。图只在「有用户手势上下文」或
 * 首次 playing 事件时创建，AudioContext 挂了就整场生效——绝不静默劫持
 * 原生输出后又不 resume（那会导致无声）。
 * 持久化闭环：eqPreset（曲线名）+ eqBypass + eqGains（逐段手调值）三个
 * 偏好键在预设/手调/重置/bypass 四个动作里都会写，恢复时以 eqGains 为准。
 * 写这三键的家只有一个：saveEqSettings（把原先分开的两只手合成一处）。
 * 「默认态」也只有一份定义：重置 = applyEqPreset('flat')（收口，
 * 此前 resetEq 自带半份归零循环，漏掉预设名、bypass 与按钮高亮）。
 * test/eq-behaviour.test.js 由「现状钉」反转为「正向钉」守卫本实现，
 * test/eq-reset.test.js 守默认态那条路。
 *
 * c664fdf 收掉当时记在候选里的那扇门：「当前是哪条曲线」不许有第二个家。
 * 原先除 _gains 外还养着 currentEqPreset 一份抄本，而手调滑块只动 _gains ——
 * 于是曲线已偏离 rock、按钮上的高亮与 pref 里的 eqPreset 仍说 rock（当场说谎，
 * 且谎话能活过重启）。现在高亮与 eqPreset 一律由 matchPresetName(_gains) 现推，
 * 推不出就是 PRESET_CUSTOM（面板上显式标「自定义」），影子变量删除。
 * test/eq-preset-highlight.test.js 守这条路。
 *
 * EQ 输出级
 * trim + 命令面板入口。preampTrimDb 现推固定 trim dB（有效增益里最大正抬升取反），
 * 镜像到链首的 preamp GainNode；不写第四把 pref。cycleEqPreset 委派 applyEqPreset
 * （三键/高亮/bypass 的唯一家），供 Ctrl+K 的 eq-cycle 调用。
 * test/eq-clip-guard.test.js 守这两条。
 */

// ── EQ 5 段均衡器 ────────────────────────────────────
const EQ_BANDS = [
   { freq: 60,   label: '60Hz',   type: 'lowshelf' },
   { freq: 230,  label: '230Hz',  type: 'peaking' },
   { freq: 910,  label: '910Hz',  type: 'peaking' },
   { freq: 3600, label: '3.6kHz', type: 'peaking' },
   { freq: 14000,label: '14kHz',  type: 'highshelf' },
];
const eqFilters = []; // BiquadFilterNode[]，ensureEqGraph() 填充
let audioCtx = null;
let analyserNode = null; // 频谱可视化只读抽头，随 ensureEqGraph 建立
// 链首 preamp。放链首不是随手摆的：trim 必须与滤波串联才等效于输出衰减，
// 而插在 filters 之后会让 analyser（频谱的唯一抽头）读到被自己抵消后的信号 ——
// bass 预设 +6dB 低架配 trim −6dB，图上低频比 flat 还低，EQ 效果在图里看不见。
// 挪到链首后 analyser 落在滤波链尾，量到的是「EQ 干了什么」而不是「trim 拿走了多少」。
let preampNode = null;
const _gains = [0, 0, 0, 0, 0]; // 唯一真身：用户想要的每段 dB（-12..12）
let eqBypassed = false; // EQ bypass state

// ── EQ 预设曲线 ───────────────────────────────────────
// 每条预设是 EQ_BANDS 对应索引的增益值 [60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz] (dB)
const EQ_PRESETS = {
  flat:    [ 0,  0,  0,  0,  0],
  pop:     [ 2,  3,  1,  2,  3],
  rock:    [ 4,  2, -1,  1,  3],
  classic: [ 1,  1,  2,  2,  1],
  vocal:   [-1,  2,  4,  3,  0],
  dance:   [ 4,  1,  0,  0,  3],
  jazz:    [ 2,  3,  2,  1,  3],
  bass:    [ 6,  3, -1, -1,  0],
};

/** 曲线不属于任何预设时写进 eqPreset 的哨兵（老版本读到它会在 EQ_PRESETS 校验处失配 → 回退，向后兼容） */
export const PRESET_CUSTOM = 'custom';

const _clampGain = (v) => Math.max(-12, Math.min(12, Number(v) || 0));
const _effective = () => (eqBypassed ? _gains.map(() => 0) : _gains);
const _hasProfile = () => !eqBypassed && _gains.some((g) => g !== 0);

/**
 * 输出级固定 trim：有效增益里的**最大单段正抬升**取反（dB）。
 * 平坦/全负 → 0（不额外衰减）；脏输入安全。preamp GainNode 只是它的镜像。
 *
 * 名字为什么从 clipGuardDb 改成 preampTrimDb（记账）：它**不是**削波保护。
 * 削波保护要看真实峰值，而这里的输入只有一条静态增益曲线：多段同时抬升会因相位
 * 叠加把峰值推到远超「最大单段 dB」的地方（bass 预设实测 6+3 段可同相），所以这个
 * 数字挡不住任何真实的过载；反过来它对**每一条带正增益的曲线都无条件生效**，于是
 * vocal −4dB ≈ 明显听感变轻。叫 clipGuardDb 是「名字承诺的比它能做的多」——
 * 本仓的取名规矩是宁可名字难看也不许骗人，故降级为「听感取向的固定 trim」：
 * 要的是「抬了 bass 就别让整首歌跟着变响」，不是「保证不削波」。
 */
export function preampTrimDb(gains) {
  if (!Array.isArray(gains) || !gains.length) return 0;
  let maxBoost = 0;
  for (const g of gains) {
    const n = Number(g);
    if (Number.isFinite(n) && n > maxBoost) maxBoost = n;
  }
  return maxBoost > 0 ? -maxBoost : 0;
}

/**
 * 曲线 → 预设名的唯一一只手。
 * 认不出返回 null，由调用方决定怎么交代——绝不"挑一条最接近的"糊上去。
 * 段数不符直接 null：半条曲线不是任何预设。
 */
export function matchPresetName(gains) {
  if (!Array.isArray(gains) || gains.length !== EQ_BANDS.length) return null;
  const hit = Object.keys(EQ_PRESETS).find((n) => EQ_PRESETS[n].every((g, i) => g === Number(gains[i])));
  return hit || null;
}

/** 高亮与「自定义」标记的唯一写入口。刻意不接名字参数：镜子只能是曲线的函数 */
function _syncPresetHighlight() {
  const name = matchPresetName(_gains);
  document.querySelectorAll('.eq-preset-btn').forEach((b) => {
    const mine = b.dataset ? b.dataset.eqPreset : null;
    b.classList.toggle('eq-preset-active', mine === name);
  });
  const hint = document.getElementById('eqCustomHint');
  if (hint) hint.style.display = name ? 'none' : '';
}

/** 把 _gains（含 bypass 语义）镜像到已存在的滤波器节点 + 链首 preamp 的固定 trim */
function _mirrorToGraph() {
  const eff = _effective();
  eqFilters.forEach((f, i) => { f.gain.value = eff[i]; });
  if (preampNode) {
    // dB → 线性：10^(dB/20)；trim 为 0 时 gain=1（直通）
    preampNode.gain.value = Math.pow(10, preampTrimDb(eff) / 20);
  }
}

/** 把 bypass 状态镜像到那枚按钮（文案 + 类名）：预设/开关/恢复三条路都得同步它 */
function _syncBypassBtn() {
  const btn = document.getElementById('eqBypassBtn');
  if (!btn) return;
  btn.textContent = eqBypassed ? '🔇 EQ关闭' : '🎚️ EQ开启';
  btn.classList.toggle('eq-bypassed', eqBypassed);
}

/**
 * 懒建音频图。只应在用户手势上下文或 playing 事件里调用——
 * 创建 AudioContext 后元素声音即被劫持进图，必须保证能 resume。
 * 返回是否已有可用图。
 */
function ensureEqGraph() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  }
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  const audio = typeof document !== 'undefined' && document.getElementById('audioPlayer');
  if (!AC || !audio) return false;
  try {
    audioCtx = new AC();
    let node = audioCtx.createMediaElementSource(audio);
    // 链首 preamp：source → preamp → filters → analyser → destination
    preampNode = audioCtx.createGain();
    preampNode.gain.value = 1;
    node.connect(preampNode);
    node = preampNode;
    eqFilters.length = 0;
    for (const band of EQ_BANDS) {
      const f = audioCtx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.Q.value = 1;
      node.connect(f);
      node = f;
      eqFilters.push(f);
    }
    // analyser 落在滤波链尾：频谱量到的是 EQ 曲线本身，不含 preamp trim ——
    // 取舍写在文件头与 preampNode 声明处，不是「顺手接在最后一个节点上」。
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.8;
    node.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    _mirrorToGraph();
    return true;
  } catch (e) {
    audioCtx = null;
    analyserNode = null;
    preampNode = null;
    eqFilters.length = 0;
    return false;
  }
}

// ── 频谱可视化公开面：确保建图 + analyser 只读访问 ──
export function ensureAudioGraph() { return ensureEqGraph(); }
export function getAnalyser() { return analyserNode; }

// ── 应用 EQ 预设 ──────────────────────────────────────
export function applyEqPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  eqBypassed = false;
  gains.forEach((g, i) => { _gains[i] = _clampGain(g); });
  ensureEqGraph();
  _mirrorToGraph();
  // 更新 UI 滑块
  const sliders = document.querySelectorAll('#eqPanel input[type=range]');
  const labels = document.querySelectorAll('#eqPanel [id^=eq_val_]');
  [...sliders].forEach((sl, i) => {
    if (gains[i] !== undefined) {
      sl.value = gains[i];
      if (labels[i]) labels[i].textContent = gains[i] + 'dB';
    }
  });
  // 高亮由曲线现推：这里刻意不传 name —— 传了就等于又养一份影子状态
  _syncPresetHighlight();
  // 选预设隐含"EQ 是开着的"（上面刚把 eqBypassed 置 false），按钮必须跟着走：
  // c211ee8 之前这里漏了这一格，于是"重置/选预设"之后按钮还写着 🔇 EQ关闭
  _syncBypassBtn();
  saveEqSettings();
}

export function toggleEqBypass() {
  eqBypassed = !eqBypassed;
  if (_hasProfile()) ensureEqGraph(); // 开启且有曲线才需要图
  _mirrorToGraph();
  // bypass 时不改滑块显示，只改按钮状态
  _syncBypassBtn();
  saveEqSettings(); // 三键的唯一持久化家；bypass 不改曲线，高亮自然也不改
}

/** 预设循环（命令面板/更多菜单）：当前曲线 → 下一内置预设；自定义从表首起 */
export function cycleEqPreset() {
  const order = Object.keys(EQ_PRESETS); // flat, pop, rock, classic, vocal, dance, jazz, bass
  const cur = matchPresetName(_gains);
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length]; // idx=-1 → order[0]=flat
  applyEqPreset(next);
  try {
    if (typeof showToast === 'function') showToast('EQ：' + next, 'info', 1800);
  } catch (_e) { /* 无 toast 环境 */ }
}

// ── 启动恢复 ─────────────────────────────────────────
async function restoreEqPresetSetting() {
  try {
    const stored = await api.getPref('eqPreset') || 'flat';
    const bypass = await api.getPref('eqBypass');
    const rawGains = await api.getPref('eqGains');
    eqBypassed = bypass === true;
    const valid = Array.isArray(rawGains)
      && rawGains.length === EQ_BANDS.length
      && rawGains.every((g) => Number.isFinite(g));
    // 没有 eqGains 的老备份按存过的曲线名兜底；'custom' 这类认不出的名字回落到 flat
    const gains = valid ? rawGains.map(_clampGain) : (EQ_PRESETS[stored] || EQ_PRESETS.flat);
    gains.forEach((g, i) => { _gains[i] = g; });
    _mirrorToGraph();
    // UI 对齐持久化状态（重启后台词/滑块不再停留默认值）
    EQ_BANDS.forEach((_, i) => {
      const slider = document.getElementById('eq_' + i);
      const label = document.getElementById('eq_val_' + i);
      if (slider) slider.value = _gains[i];
      if (label) label.textContent = _gains[i] + 'dB';
    });
    _syncBypassBtn();
    // 亮哪枚只看恢复出来的曲线，不看 stored 名字 —— 名字可能是上个版本存的谎
    _syncPresetHighlight();
  } catch (e) { /* silent */ }
}

// 启动恢复接线：EQ 图在「首次 playing」后建立——那时必有用户手势（点歌），
// AudioContext 不会被自动播放策略卡在 suspended 而憋死原生输出
export { restoreEqPresetSetting };

// ── EQ 设置持久化 ─────────────────────────────────────
function getEqGains() {
   return _gains.slice();
}

export function setEqBand(index, gain) {
   _gains[index] = _clampGain(gain);
   ensureEqGraph();
   _mirrorToGraph();
   // 拖一格，按钮就该当场改口（松手时 onchange 才写 pref）
   _syncPresetHighlight();
}

export function resetEq() {
  // 默认态只有一份定义：applyEqPreset('flat') 会写齐三键、推滑块、改标签、切高亮。
  // c211ee8 之前这里是自带的一半实现（只推滑块 + 只写 eqGains），于是滑条读 0 而按钮
  // 仍高亮旧预设、eqBypass 仍是关闭态、重启后按旧 eqPreset 复活 —— 同一件事的两只手必然长歪。
  applyEqPreset('flat');
}

/** 三键的唯一持久化家：曲线/预设名/开关要么一起写，要么都不写（收拢） */
export async function saveEqSettings() {
   _syncPresetHighlight();
   const gains = getEqGains();
   const name = matchPresetName(gains) || PRESET_CUSTOM;
   try {
     await Promise.all([
       api.setPref('eqGains', gains),
       api.setPref('eqPreset', name),
       api.setPref('eqBypass', eqBypassed),
     ]);
   } catch (_e) { /* EQ 保存失败使用默认 */ }
}

// ── 生命周期接线（渲染层才有；node 单测 import 不触发）──────────
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const boot = () => {
    restoreEqPresetSetting().then(() => {
      if (_hasProfile()) ensureEqGraph();
    }).catch(() => {});
  };
  const audio = document.getElementById('audioPlayer');
  if (audio) audio.addEventListener('playing', boot, { once: true });
  window.addEventListener('beforeunload', () => {
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
      eqFilters.length = 0;
      preampNode = null;
      analyserNode = null;
    }
  });
}
