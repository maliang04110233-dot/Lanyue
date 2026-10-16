/**
 * 品味解读 IPC（候选方向 2：口味画像）
 *
 * 一条通道 = get-taste-profile：设置页「品味画像」。
 * 与 AI 助手同一条出网闸（assistantChat → _chatCall → urlGuard），
 * 凭据取「当前厂商那根 Key」，错误一律回 ASCII 令牌（文案的家是渲染层词典）。
 *
 * 缓存：按「统计摘要签名」为键，内存 + userData/taste-profiles.json 落盘
 * （上限 100 条，超出淘汰最旧）。签名 = 累计时长 + 歌曲数 + 播放次数 +
 * 歌手数 + 活跃日数，**不含歌手明细** —— 不然每多听一首都换签名，
 * 缓存永远不命中，等于每次点都重复计费。
 * 画像只描述「一个时间窗的口味」，不是实时流，同一份统计重复点不应重复出网。
 *
 * 隐私：出网文本经 services/tasteProfileService.digestToText 收口 ——
 * 只含歌手聚合与聚合数字，不含具体歌名/曲库明细。
 */

const path = require('path');
const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { atomicWriteJson, safeReadJson } = require('../../utils/atomicFile');
const { assistantChat } = require('../../api/ai-music');
const { chatConfigFrom, isConfigToken } = require('../../api/aiProviders');
const {
  buildDigest, buildProfileMessages, extractProfileText,
} = require('../../api/services/tasteProfileService');

const MAX_ENTRIES = 100;

// ── 可注入依赖（单测不触网、不碰真实 userData）──────────────
let _chat = null;        // (messages, apiKey) => Promise<content string>
let _dir = null;         // 缓存落盘目录（生产 = userData；测试注入临时目录）
let _keyReader = null;   // (prefKey) => string（生产 = prefs.get；测试注入固定值）
let _statsReader = null; // () => playStats 对象（生产 = prefs.get('playStats')；测试注入）
function setTasteChat(fn) { _chat = typeof fn === 'function' ? fn : null; }
function setTasteStoreDir(dir) { _dir = typeof dir === 'string' ? dir : null; }
function setTasteKeyReader(fn) { _keyReader = typeof fn === 'function' ? fn : null; }
function setTasteStatsReader(fn) { _statsReader = typeof fn === 'function' ? fn : null; }

const _mem = new Map(); // 签名 → 画像（Map 保插入序 = LRU）

function cacheFile() {
  const dir = _dir || (() => {
    try { return require('electron').app.getPath('userData'); } catch (_e) { return null; }
  })();
  return dir ? path.join(dir, 'taste-profiles.json') : null;
}

/** 签名：只含聚合量，不含歌手明细 —— 见文件头「隐私」注释。
 *  刻意不把歌手指纹放进来：缓存的键会落盘到 taste-profiles.json，
 *  歌手指纹虽不可逆读回原文，但它仍是一种可比较的特征，而这份文件
 *  完全不该携带任何歌手级信息。聚合量（时长/歌曲数/播放次数/歌手数/活跃日）
 *  的碰撞空间已经足够大，撞签名的代价只是缓存失效再出网一次，不伤数据。 */
function signatureOf(digest) {
  const d = digest || {};
  return [
    Math.floor((d.totalPlayTimeSec || 0) / 60),
    d.distinctSongs || 0,
    d.totalPlays || 0,
    d.distinctArtists || 0,
    d.activeDays || 0,
  ].join(':');
}

function loadCache() {
  if (_mem.size) return _mem;
  const file = cacheFile();
  if (!file) return _mem;
  const saved = safeReadJson(file);
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === 'string' && v) _mem.set(k, v);
    }
  }
  return _mem;
}

/** 测试专用：清空内存缓存（用例隔离），不影响落盘文件 */
function clearTasteCache() { _mem.clear(); }

function saveCache(sig, profile) {
  _mem.set(sig, profile);
  while (_mem.size > MAX_ENTRIES) {
    const oldest = _mem.keys().next().value;
    _mem.delete(oldest);
  }
  const file = cacheFile();
  if (file) {
    Promise.resolve(atomicWriteJson(file, Object.fromEntries(_mem)))
      .catch((e) => logger.warn('[tasteProfile] 画像缓存落盘失败:', e && e.message || e));
  }
}

async function getProfile({ lang }) {
  const readStats = _statsReader || (() => prefs.get('playStats'));
  let rawStats;
  try {
    rawStats = readStats();
  } catch (_e) {
    return { ok: false, error: 'STATS_UNAVAILABLE' };
  }
  if (typeof rawStats === 'string') {
    try { rawStats = JSON.parse(rawStats); } catch (_e) { return { ok: false, error: 'STATS_CORRUPT' }; }
  }
  const built = buildDigest(rawStats);
  if (!built.ok) return { ok: false, error: built.error };

  const sig = signatureOf(built.digest);
  const cached = loadCache().get(sig);
  if (cached) return { ok: true, profile: cached, cached: true, signature: sig };

  const { apiKey } = chatConfigFrom(_keyReader || ((k) => prefs.get(k)));
  if (!apiKey) return { ok: false, error: 'NO_KEY' };

  try {
    const chat = _chat || ((messages) => assistantChat({ messages, apiKey }));
    const raw = await chat(buildProfileMessages({ digest: built.digest, lang }));
    const profile = extractProfileText(raw);
    if (!profile) return { ok: false, error: 'EMPTY_REPLY' };
    saveCache(sig, profile);
    return { ok: true, profile, cached: false, signature: sig };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    logger.warn('[tasteProfile] 画像生成失败:', msg || e);
    return { ok: false, error: isConfigToken(msg) ? msg : 'LLM_FAILED' };
  }
}

function register() {
  handle('get-taste-profile', (_, lang) => getProfile({ lang }));
}

module.exports = {
  register, getProfile, setTasteChat, setTasteStoreDir,
  setTasteKeyReader, setTasteStatsReader, signatureOf, clearTasteCache, MAX_ENTRIES,
};