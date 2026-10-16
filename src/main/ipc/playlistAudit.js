/**
 * 歌单语义运维 IPC（候选方向 3）
 *
 * 一条通道 = playlist-audit(playlistId, prompt)：给一个**已经存在**的歌单做体检。
 * 与 AI 助手同一根出网闸（assistantChat → _chatCall → urlGuard），
 * 凭据取「当前厂商那根 Key」，错误一律回 ASCII 令牌（文案的家是渲染层词典）。
 *
 * 只读：不改歌单。改名/删歌/挪歌全部由界面里那几下按钮经既有的
 * save-user-playlist / remove-from-user-playlist 决定（同 smart-playlist 的取舍）。
 * 因此这条通道也不进 MCP 工具表白名单：外部 Agent 想体检歌单，
 * 用 get_user_playlists 拿到歌单即可，无需让 LLM 直接动库。
 *
 * 隐私：歌单里的歌名/歌手会随请求出网（同智能歌单那一档，用户主动发起）。
 * 回复里强制不带播放数据、不编造清单外的歌 —— 见 services/playlistAuditService。
 */

const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { assistantChat } = require('../../api/ai-music');
const { chatConfigFrom, isConfigToken } = require('../../api/aiProviders');
const { auditPlaylist } = require('../../api/services/playlistAuditService');

// ── 可注入依赖（单测不触网、不碰真实 userData）──────────────
let _chat = null;        // (messages, apiKey) => Promise<content string>
let _keyReader = null;   // (prefKey) => string（生产 = prefs.get；测试注入固定值）
function setAuditChat(fn) { _chat = typeof fn === 'function' ? fn : null; }
function setAuditKeyReader(fn) { _keyReader = typeof fn === 'function' ? fn : null; }

function _findPlaylist(id) {
  const list = (prefs.get('userPlaylists') || []).filter(p => p && typeof p === 'object');
  return list.find(p => p.id === String(id)) || null;
}

async function audit(playlistId, prompt) {
  const id = String(playlistId == null ? '' : playlistId).trim();
  if (!id) return { ok: false, error: 'EMPTY' };

  const pl = _findPlaylist(id);
  if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND' };

  const { apiKey } = chatConfigFrom(_keyReader || ((k) => prefs.get(k)));
  if (!apiKey) return { ok: false, error: 'NO_KEY' };

  const songs = Array.isArray(pl.songs) ? pl.songs : [];
  try {
    const chat = _chat || ((messages) => assistantChat({ messages, apiKey }));
    const r = await auditPlaylist({
      playlistName: pl.name,
      playlistDesc: pl.desc,
      prompt,
      songs,
      chat,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      playlistId: pl.id,
      playlistName: pl.name,
      name: r.name,
      desc: r.desc,
      summary: r.summary,
      audit: r.audit,
      candidates: r.candidates,
      candidateCount: r.candidateCount,
      truncated: r.truncated,
    };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    logger.warn('[playlist-audit] 运维失败:', msg || e);
    return { ok: false, error: isConfigToken(msg) ? msg : 'LLM_FAILED' };
  }
}

function register() {
  handle('playlist-audit', (_, playlistId, prompt) => audit(playlistId, prompt));
}

module.exports = { register, audit, setAuditChat, setAuditKeyReader, _findPlaylistForTest: _findPlaylist };