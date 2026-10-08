// ── 电台模式（3-A）────────────────────────────────────────
// 播放队列播完后不再停在「放完了」，而是顺着同一歌手的作品续播。
//
// 分工：
//   主进程 radioPool.js  取候选（降级与关键词策略都在那边）
//   utils/radio.js        纯函数挑下一批（去重/冷却/打散）
//   本文件                状态与编排，不含判定逻辑
//
// 保守优先：开关关 / 单曲循环 / 取不到歌手名，任一成立都**不**接管，
// 保持「停在放完」的原有行为。

import { generateRadioCandidates, shouldAutoContinue, trackKey } from './radioCore.js';

const RADIO_BATCH = 10;
const RADIO_ARTIST_COOLDOWN = 3;

let _radioBuffer = [];        // 已取好、还没进播放队列的候选
let _radioSeedKey = '';       // 这批是为哪首歌取的（换种子要重取）
let _radioLoading = false;
let _radioStatus = 'idle';    // idle | loading | ready | empty | error

function getRadioStatus() { return _radioStatus; }
function getRadioBuffer() { return _radioBuffer; }

/** 清空缓冲（换歌单/清队列时调，避免拿旧种子生成的候选续播） */
export function resetRadio() {
  _radioBuffer = [];
  _radioSeedKey = '';
  _radioStatus = 'idle';
}

/**
 * 队列耗尽时尝试续播。
 *
 * @param {Object} seed 刚播完的曲目
 * @param {Object} opts
 * @param {string[]} [opts.playedKeys] 已播过的 trackKey（避免复读）
 * @param {Function} [opts.onPick] 拿到候选后的回调（测试/上层注入）
 * @returns {Promise<Array|null>} 可续播的候选；null 表示不该接管或取不到
 */
export async function radioContinue(seed, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};

  if (!shouldAutoContinue({
    enabled: isRadioEnabled(),
    loopMode: getState('loopMode'),
    seed,
  })) {
    return null;
  }

  const seedKey = trackKey(seed);

  // 缓冲里有货且还是为同一首取的 ⇒ 直接用，不再打网络
  if (_radioBuffer.length && _radioSeedKey === seedKey) {
    return _radioBuffer;
  }

  if (_radioLoading) return null; // 正在取，等这一轮结束就好

  _radioLoading = true;
  _radioStatus = 'loading';
  try {
    const pool = await api.radioPool(seed, { limit: 30 });
    if (!pool || pool.reason !== 'ok' || !Array.isArray(pool.songs) || !pool.songs.length) {
      _radioBuffer = [];
      _radioSeedKey = '';
      _radioStatus = 'empty';
      return null;
    }

    const picked = generateRadioCandidates(seed, pool.songs, {
      playedKeys: o.playedKeys || [],
      batch: RADIO_BATCH,
      artistCooldown: RADIO_ARTIST_COOLDOWN,
    });

    if (!picked.songs.length) {
      _radioBuffer = [];
      _radioSeedKey = '';
      _radioStatus = 'empty';
      return null;
    }

    _radioBuffer = picked.songs;
    _radioSeedKey = seedKey;
    _radioStatus = 'ready';
    if (typeof o.onPick === 'function') o.onPick(_radioBuffer);
    return _radioBuffer;
  } catch (e) {
    logger.warn('电台取候选失败:', e && e.message);
    _radioBuffer = [];
    _radioSeedKey = '';
    _radioStatus = 'error';
    return null;
  } finally {
    _radioLoading = false;
  }
}

/**
 * 电台是否开启：读 pref，开关缺失/读取失败一律当作关闭
 *
 * 缺失即关闭是重要的默认值——新增功能不该在老用户不知情时自己动起来。
 */
export function isRadioEnabled() {
  try {
    return getState('radioEnabled') === true;
  } catch (_e) {
    return false;
  }
}

/** 切换开关（设置页用）；写 prefs 失败不影响本次会话内生效 */
export function setRadioEnabled(on) {
  const v = !!on;
  setState('radioEnabled', v);
  if (!v) resetRadio();
  try { api.setPref('radioEnabled', v); } catch (e) { logger.warn('电台开关落盘失败:', e && e.message); }
  return v;
}

/** 初始化：启动时读一次 pref */
export async function loadRadioEnabled() {
  try {
    const v = await api.getPref('radioEnabled');
    setState('radioEnabled', v === true);
  } catch (e) {
    logger.warn('读取电台开关失败，按关闭处理:', e && e.message);
    setState('radioEnabled', false);
  }
}

// 诊断/设置页需要读当前状态（inline handler 只能看到 window 上的东西）
if (typeof window !== 'undefined') {
  window.getRadioStatus = getRadioStatus;
  window.getRadioBuffer = getRadioBuffer;
  window.isRadioEnabled = isRadioEnabled;
  window.setRadioEnabled = setRadioEnabled;
  window.loadRadioEnabled = loadRadioEnabled;
  window.resetRadio = resetRadio;
}
