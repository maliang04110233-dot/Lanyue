/**
 * AI 智能歌单 IPC（轨道三）
 *
 * 一条通道做完这件事的全部：`smart-playlist-generate(prompt, scope)`
 * → {ok, name, reason, songs}。**只读**：它不写 prefs、不进歌单、不进队列，
 * 存不存由界面里那一下「存为歌单」决定，走的是既有通道 save-user-playlist。
 *
 * 为什么它不在 MCP 工具表白名单里（轨道一那 17 个之外的第 18 个不是白加的理由）：
 * 工具表是给**外部 Agent** 的动手面，而这个动作什么都不改 ——
 * 把它加进去等于给 Agent 开一条「读光用户曲库并送去出网」的通道，
 * 而这条通道的产物还要用户在界面上点头才落地。Agent 想要同样效果，
 * 用 get_user_playlists 自己挑即可，无需 LLM 代劳。
 *
 * 范围三只，全是"用户已经攒下的歌"：
 *   library        所有歌单的并集（含收藏）—— 本应用里唯一**能播**的曲库口径
 *   favorites      只看红心
 *   playlist:<id>  只看某一单
 * 刻意不含本地文件库（library-index.json）：那里的条目只有 filePath 没有 id/source，
 * 而歌单行的播放路径是 getDownloadUrlSmart(song)——存进去就是一排播不动的死行。
 *
 * 错误一律 ASCII 令牌（同 ipc/ai-assistant.js 的口径），文案的家在渲染层词典。
 */

const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { assistantChat } = require('../../api/ai-music');
const { generateSmartPlaylist, dedupeSongs } = require('../../api/services/smartPlaylistService');

const FAVORITES_ID = 'favorites';
const SCOPE_LIBRARY = 'library';
const SCOPE_FAVORITES = 'favorites';
const SCOPE_PLAYLIST_PREFIX = 'playlist:';

/**
 * 取候选歌曲。只读 prefs：ensureFavorites() 在收藏单缺失时会建单并落盘，
 * 那是写操作，与「生成不改数据」相悖（同 aggregate-cross-source 的取舍）。
 * @returns {{songs:Array}|{error:string}}
 */
function _collect(scope) {
  const playlists = (prefs.get('userPlaylists') || []).filter(p => p && typeof p === 'object');
  const s = String(scope || SCOPE_LIBRARY);

  if (s === SCOPE_FAVORITES) {
    const pl = playlists.find(p => p.id === FAVORITES_ID);
    return { songs: (pl && Array.isArray(pl.songs)) ? pl.songs : [] };
  }
  if (s.startsWith(SCOPE_PLAYLIST_PREFIX)) {
    const id = s.slice(SCOPE_PLAYLIST_PREFIX.length);
    const pl = playlists.find(p => p.id === id);
    if (!pl) return { error: 'PLAYLIST_NOT_FOUND' };
    return { songs: Array.isArray(pl.songs) ? pl.songs : [] };
  }
  // 认不出的 scope 退成全库：范围是"看哪些歌"，不是权限，退宽了不比报错更伤
  const all = [];
  for (const pl of playlists) if (Array.isArray(pl.songs)) all.push(...pl.songs);
  return { songs: dedupeSongs(all) };
}

function register() {
  handle('smart-playlist-generate', async (_, prompt, scope) => {
    const topic = String(prompt == null ? '' : prompt).trim();
    if (!topic) return { ok: false, error: 'EMPTY_PROMPT' };

    const collected = _collect(scope);
    if (collected.error) return { ok: false, error: collected.error };
    if (!collected.songs.length) return { ok: false, error: 'NO_CANDIDATES' };

    const apiKey = prefs.get('aiMusicApiKey');
    if (!apiKey) return { ok: false, error: 'NO_KEY' };

    try {
      const r = await generateSmartPlaylist({
        prompt: topic,
        songs: collected.songs,
        chat: (messages) => assistantChat({ messages, apiKey }),
      });
      if (!r.ok) return r;
      return {
        ok: true,
        name: r.name,
        reason: r.reason,
        songs: r.songs,
        candidateCount: r.candidateCount,
        truncated: r.truncated,
        scope: String(scope || SCOPE_LIBRARY),
      };
    } catch (e) {
      logger.warn('[smart-playlist] 生成失败:', e && e.message ? e.message : e);
      return { ok: false, error: 'LLM_FAILED' };
    }
  });
}

module.exports = { register, _collectForTest: _collect };
