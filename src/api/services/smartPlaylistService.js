/**
 * AI 智能歌单（轨道三）—— 纯函数 + 依赖注入，单测不触网
 *
 * 一句话主题 → 从用户**已有**的歌里现场挑一首一首 → 起个名字交回界面。
 * 与轨道二的助手共用同一条出网通道（assistantChat）与同一套严格 JSON 协议：
 * 这里没有工具调用，因为「挑歌」这件事一次问答就够了，
 * 让模型面对 400 行清单挑序号，比让它自己调三个工具再拼结果便宜得多也稳得多。
 *
 * 为什么候选是序号而不是 JSON 歌曲对象：模型的职责是**筛选与排序**，
 * id/source 这些身份字段一旦经由它的手就多了被改写的可能；
 * 序号是一一对应、越界即可判废的的最小接口。
 */

const { extractModelJson } = require('./modelJson');

const MAX_CANDIDATES = 400;
const MAX_PICKS = 100;
const MAX_FIELD_CHARS = 60;
const MAX_NAME_CHARS = 24;
const MAX_REASON_CHARS = 200;

/** 歌单内歌曲的唯一键：与 src/main/ipc/playlist.js 的 songKey 同规则（只按 id 会跨平台撞车） */
function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

/** 按 id:source 去重，保留首次出现的那份（用户从多个歌单里攒到的同一首歌不该占两行） */
function dedupeSongs(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs || []) {
    if (!s || typeof s !== 'object') continue;
    const k = songKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function _field(v) {
  return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

/**
 * 候选清单：喂给模型的全部世界。
 * 没有标题的行直接丢掉 —— 占位符只会换来幻觉，而不是用户想要的那首。
 * @param {Array} songs
 * @returns {{list:Array<{n:number,title:string,artist:string,song:Object}>, text:string, total:number, truncated:number}}
 */
function buildCandidates(songs) {
  const rows = [];
  // eligible = 「有标题、真能被选」的总数：上限截的是清单，不是这个数，
  // 否则用户会以为 AI 看完了整个曲库，而实际只看了前 400 行
  let eligible = 0;
  for (const s of songs || []) {
    const title = _field(s && s.title);
    if (!title) continue;
    eligible++;
    if (rows.length >= MAX_CANDIDATES) continue;
    rows.push({ n: rows.length + 1, title, artist: _field(s.artist), song: s });
  }
  return {
    list: rows,
    text: rows.map(r => `${r.n}\t${r.title}\t${r.artist}`).join('\n'),
    total: eligible,
    truncated: Math.max(0, eligible - rows.length),
  };
}

function buildSystemPrompt() {
  return `你是桌面音乐应用「揽乐」的歌单编排器。用户给一个主题，你只从**给出的候选清单**里挑歌，组成一个歌单。

回答方式：只输出一个 JSON 对象，除此之外不要有任何文字。形如：
{"name":"夜跑节奏","reason":" BPM 偏高、前奏短","picks":[3,1,7]}

规则：
- picks 里只放候选清单左侧的**序号**（1 起），按你想要的先后顺序排列。
- 序号必须在清单里存在；不要编造清单外的歌，也不要把标题或 id 写进 picks。
- name 是歌单标题，不超过 ${MAX_NAME_CHARS} 个字；reason 是一句话说明为什么是这些歌。
- 宁缺毋滥：只选真正贴合主题的，一般 5~30 首。主题理解不了就 picks 给空数组。`;
}

/** 从一段可能有毛刺的模型输出里抠出 JSON 对象（与助手共用一份口径，见 `modelJson.js` 头注） */
function _extractJson(text) {
  // 判据要排除数组：候选里现在两种都配得平，而这里认的是 `{name, reason, picks}`
  return extractModelJson(text, (o) => !!o && typeof o === 'object' && !Array.isArray(o));
}

/**
 * 钳制序号列表：非数字、越界、小数、重复统统剔除，只留合法序号并截到上限。
 * 模型给的顺序就是它想排的顺序，这里不重排。
 */
function parseSelection(text, candidates) {
  const obj = _extractJson(text);
  const empty = { name: '', reason: '', picks: [] };
  if (!obj || typeof obj !== 'object') return empty;
  const count = (candidates && candidates.list && candidates.list.length) || 0;
  const seen = new Set();
  const picks = [];
  const raw = Array.isArray(obj.picks) ? obj.picks : [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).trim());
    if (!Number.isFinite(n)) continue;
    const i = Math.floor(n);
    if (i < 1 || i > count) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    picks.push(i);
    if (picks.length === MAX_PICKS) break;
  }
  return {
    name: _field(obj.name).slice(0, MAX_NAME_CHARS),
    reason: _field(obj.reason).slice(0, MAX_REASON_CHARS),
    picks,
  };
}

/**
 * 一次生成：主题 + 候选歌曲 → {name, reason, songs}
 * @param {Object} deps
 * @param {string} deps.prompt      用户的主题（一句人话）
 * @param {Array}  deps.songs       候选歌曲（已按范围取好、已去重）
 * @param {(messages:Array)=>Promise<string>} deps.chat  一次出网（主进程注入 assistantChat）
 */
async function generateSmartPlaylist({ prompt, songs, chat }) {
  const topic = String(prompt == null ? '' : prompt).trim();
  if (!topic) return { ok: false, error: 'EMPTY_PROMPT' };

  const candidates = buildCandidates(songs);
  if (!candidates.list.length) return { ok: false, error: 'NO_CANDIDATES' };

  let text;
  try {
    text = await chat([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: `主题：${topic.slice(0, 200)}\n\n候选曲目（序号\t标题\t歌手）：\n${candidates.text}` },
    ]);
  } catch (e) {
    // NO_KEY 是「还没配 Key」，LLM_FAILED 是「这次没成就」——两种失败用户要做的事不同，不能混成一个令牌
    const msg = String((e && e.message) || e);
    return { ok: false, error: msg === 'NO_KEY' ? 'NO_KEY' : 'LLM_FAILED' };
  }

  const { name, reason, picks } = parseSelection(text, candidates);
  if (!picks.length) return { ok: false, error: 'NO_PICKS' };

  const picked = picks.map(n => candidates.list[n - 1].song);
  // name 是 save-user-playlist 的硬要求；模型漏给就用用户自己的话兜底，别让用户存不下
  const finalName = name || topic.slice(0, MAX_NAME_CHARS);
  return {
    ok: true,
    name: finalName,
    reason,
    songs: picked,
    candidateCount: candidates.list.length,
    truncated: candidates.truncated,
  };
}

module.exports = {
  songKey, dedupeSongs, buildCandidates, buildSystemPrompt, parseSelection, generateSmartPlaylist,
  MAX_CANDIDATES, MAX_PICKS, MAX_NAME_CHARS,
};
