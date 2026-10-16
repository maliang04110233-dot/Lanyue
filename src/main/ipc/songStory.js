/**
 * 歌曲讲解 IPC（候选方向 1：背景卡片）
 *
 * 一条通道 = get-song-story：播放页「讲讲这首歌」。
 * 与 AI 助手同一根出网闸（assistantChat → _chatCall → urlGuard），
 * 凭据取「当前厂商那根 Key」，错误一律回 ASCII 令牌（文案的家是渲染层词典）。
 *
 * 缓存：按「歌名\0歌手\0语言」为键，内存 + userData/song-stories.json 落盘
 * （上限 300 条，超出淘汰最旧——讲解是纯常识内容，过期不敏感）。
 * 同一首歌第二次点不再出网：计费调用不该因为重复点击重复扣费。
 */

const path = require('path');
const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { atomicWriteJson, safeReadJson } = require('../../utils/atomicFile');
const { assistantChat } = require('../../api/ai-music');
const { chatConfigFrom, isConfigToken } = require('../../api/aiProviders');
const { buildStoryMessages, extractStoryText } = require('../../api/services/songStoryService');

const MAX_ENTRIES = 300;

// ── 可注入依赖（单测不触网、不碰真实 userData）──────────────
let _chat = null;   // (messages, apiKey) => Promise<content string>
let _dir = null;    // 缓存落盘目录（生产 = userData；测试注入临时目录）
let _keyReader = null; // (prefKey) => string（生产 = prefs.get；测试注入固定值）
function setStoryChat(fn) { _chat = typeof fn === 'function' ? fn : null; }
function setStoryStoreDir(dir) { _dir = typeof dir === 'string' ? dir : null; }
function setStoryKeyReader(fn) { _keyReader = typeof fn === 'function' ? fn : null; }

const _mem = new Map(); // key → story（Map 保插入序 = LRU）

function cacheFile() {
  const dir = _dir || (() => {
    try { return require('electron').app.getPath('userData'); } catch (_e) { return null; }
  })();
  return dir ? path.join(dir, 'song-stories.json') : null;
}

function cacheKey({ title, artist, lang }) {
  return `${title}\u0000${artist || ''}\u0000${lang || ''}`;
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

function saveCache(key, story) {
  _mem.set(key, story);
  // LRU 淘汰：Map 迭代序即插入序，删最旧的
  while (_mem.size > MAX_ENTRIES) {
    const oldest = _mem.keys().next().value;
    _mem.delete(oldest);
  }
  const file = cacheFile();
  if (file) {
    // 落盘失败不阻断返回：内存缓存仍在，本次会话内不重复计费
    Promise.resolve(atomicWriteJson(file, Object.fromEntries(_mem)))
      .catch((e) => logger.warn('[songStory] 讲解缓存落盘失败:', e && e.message || e));
  }
}

async function getStory({ title, artist, lang }) {
  if (!title || typeof title !== 'string') return { ok: false, error: 'EMPTY' };
  const key = cacheKey({ title, artist, lang });
  const cached = loadCache().get(key);
  if (cached) return { ok: true, story: cached, cached: true };

  const { apiKey } = chatConfigFrom(_keyReader || ((k) => prefs.get(k)));
  if (!apiKey) return { ok: false, error: 'NO_KEY' };

  try {
    const chat = _chat || ((messages) => assistantChat({ messages, apiKey }));
    const raw = await chat(buildStoryMessages({ title, artist, lang }));
    const story = extractStoryText(raw);
    if (!story) return { ok: false, error: 'EMPTY_REPLY' };
    saveCache(key, story);
    return { ok: true, story, cached: false };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    logger.warn('[songStory] 讲解失败:', msg || e);
    return { ok: false, error: isConfigToken(msg) ? msg : 'LLM_FAILED' };
  }
}

function register() {
  handle('get-song-story', (_, title, artist, lang) => getStory({ title, artist, lang }));
}

module.exports = { register, getStory, setStoryChat, setStoryStoreDir, setStoryKeyReader, cacheKey, MAX_ENTRIES };
