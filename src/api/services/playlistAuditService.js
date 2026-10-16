/**
 * 歌单语义运维服务（候选方向 3）—— 纯函数 + 依赖注入，单测不触网
 *
 * 对应竞品已验证的方向（小宝「歌单管理」、Spotify AI Playlist 每首带理由）：
 * 给**一个已经存在的歌单**做一次语义运维——AI 看完这份歌单，逐首给出
 * 「是否符合主题」的判断与理由，并给整个歌单的建议（改名/补风格/精简）。
 *
 * 与轨道三「智能歌单」的关系：那个是「挑」（从曲库里选新单），
 * 这个是「修」（给已有歌单做体检）。两者共用序号协议与 JSON 抠取口径，
 * 但语义完全相反：这里模型面对的是**已经选进歌单的每一首**，
 * 序号越界即判废的最小接口保持与智能歌单一致。
 *
 * 为什么候选是序号而不是 JSON 歌曲对象：模型的职责是**判断与建议**，
 * id/source 这些身份字段一旦经由它的手就多了被改写的可能；
 * 序号是一一对应、越界即可判废的最小接口。
 *
 * 隐私：歌单里的歌名与歌手会随请求出网（与智能歌单同一档），
 * 这是用户主动发起运维自己的歌单，不是隐式出网——SECURITY.md 已登记。
 * 但**回复里**要求模型不得编造歌单里没有的歌，也不得虚构播放数据。
 */

const { extractModelJson } = require('./modelJson');
const { isConfigToken } = require('../aiProviders');

const MAX_CANDIDATES = 400;     // 单份歌单候选上限（与智能歌单一致）
const MAX_FIELD_CHARS = 60;     // 标题/歌手字段长度
const MAX_NAME_CHARS = 24;      // 建议歌名长度
const MAX_DESC_CHARS = 80;      // 一句话描述长度
const MAX_REASON_CHARS = 160;   // 单首理由长度
const MAX_SUMMARY_CHARS = 300;  // 总评长度
const VALID_FIT = new Set(['high', 'mid', 'low']);
const VALID_SUGGEST = new Set(['keep', 'move', 'remove']);

/** 歌曲在歌单内的唯一键：与 ipc/playlist.js 的 songKey 同规则 */
function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

function _field(v, max) {
  return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim().slice(0, max);
}

/**
 * 候选清单：喂给模型的全部世界。
 * 没有标题的行直接丢掉 —— 占位符只会换来幻觉，而不是真实的运维建议。
 * @param {Array} songs 歌单原样的 songs 数组
 * @returns {{list:Array<{n:number,title:string,artist:string,song:Object}>, text:string, total:number, truncated:number}}
 */
function buildAuditCandidates(songs) {
  const rows = [];
  let eligible = 0;
  for (const s of songs || []) {
    const title = _field(s && s.title, MAX_FIELD_CHARS);
    if (!title) continue;
    eligible++;
    if (rows.length >= MAX_CANDIDATES) continue;
    rows.push({ n: rows.length + 1, title, artist: _field(s.artist, MAX_FIELD_CHARS), song: s });
  }
  return {
    list: rows,
    text: rows.map(r => `${r.n}\t${r.title}\t${r.artist}`).join('\n'),
    total: eligible,
    truncated: Math.max(0, eligible - rows.length),
  };
}

function buildSystemPrompt() {
  return `你是桌面音乐应用「揽乐」的歌单运维助手。用户给你一份**已经存在**的歌单，你要做的是一次体检：
- 逐首判断它是否贴合这份歌单的主题（fit: high/mid/low），并给一句理由（这首歌为什么合/不合）；
- 给每首一个建议动作（suggest）：keep（保留）/ move（挪到另一个更合适的歌单）/ remove（建议移除）；
- 给整个歌单一句话描述（desc）与一个更贴切的名字（name，不超过 ${MAX_NAME_CHARS} 个字；原本就合适就回原歌单名）；
- 最后给一段总评（summary），说清楚主题一致性、风格分布与建议补什么/精简什么。

回答方式：只输出一个 JSON 对象，除此之外不要有任何文字。形如：
{"name":"夜跑节奏","desc":"适合夜跑的 BPM 偏高中文歌","summary":"主题很集中，中段有两首偏抒情可以挪走","audit":[{"n":1,"fit":"high","reason":"前奏短、BPM 偏高","suggest":"keep"}]}

规则：
- audit 里每首都要给（清单里有多少首就多少条），n 是清单左侧的**序号**（1 起）；
- 序号必须在清单里存在；不要编造清单外的歌，也不要写歌名或 id；
- suggest 只在 keep/move/remove 里选；fit 只在 high/mid/low 里选；
- reason 一句话，不超过 ${MAX_REASON_CHARS} 字；总评不超过 ${MAX_SUMMARY_CHARS} 字；
- 宁缺毋滥：拿不准的单首宁可回 high 也不要硬凑理由。`;
}

/** 从一段可能有毛刺的模型输出里抠出 JSON 对象（与助手/智能歌单共用一份口径） */
function _extractJson(text) {
  return extractModelJson(text, (o) => !!o && typeof o === 'object' && !Array.isArray(o));
}

/**
 * 钳制运维结果：非数字、越界、小数、重复序号与非法枚举统统剔除。
 * 模型给的顺序就按它给的；缺项的单首不回填（宁可少建议也不造假）。
 * @returns {{name:string, desc:string, summary:string, audit:Array<{n:number,fit:string,reason:string,suggest:string}>}}
 */
function parseAudit(text, candidates) {
  const empty = { name: '', desc: '', summary: '', audit: [] };
  const obj = _extractJson(text);
  if (!obj || typeof obj !== 'object') return empty;
  const count = (candidates && candidates.list && candidates.list.length) || 0;

  const seen = new Set();
  const audit = [];
  const raw = Array.isArray(obj.audit) ? obj.audit : [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const n = typeof v.n === 'number' ? v.n : Number(String(v.n == null ? '' : v.n).trim());
    // 序号必须严格整数：2.5 是模型的幻觉，向下取整成 2 会指到别的歌头上
    if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
    if (n < 1 || n > count) continue;
    // 先验枚举再进 seen：否则一条非法枚举会把同序号的合法条目误判成重复
    const fit = VALID_FIT.has(v.fit) ? v.fit : '';
    const suggest = VALID_SUGGEST.has(v.suggest) ? v.suggest : '';
    if (!fit || !suggest) continue; // 枚举不合法不硬凑
    if (seen.has(n)) continue;
    seen.add(n);
    audit.push({
      n,
      fit,
      reason: _field(v.reason, MAX_REASON_CHARS),
      suggest,
    });
  }
  // 序号升序排回歌单原序，模型给的顺序不改判据（只是展示）
  audit.sort((a, b) => a.n - b.n);
  return {
    name: _field(obj.name, MAX_NAME_CHARS),
    desc: _field(obj.desc, MAX_DESC_CHARS),
    summary: _field(obj.summary, MAX_SUMMARY_CHARS),
    audit,
  };
}

/**
 * 一次运维：歌单原样 + 主题 → {ok, name, desc, summary, audit, candidates}
 * @param {Object} deps
 * @param {string} deps.playlistName  歌单名
 * @param {string} deps.playlistDesc  歌单描述
 * @param {string} deps.prompt        用户补充主题（可空，空则用歌单名+描述兜底）
 * @param {Array}  deps.songs         歌单原样歌曲数组
 * @param {(messages:Array)=>Promise<string>} deps.chat
 */
async function auditPlaylist({ playlistName, playlistDesc, prompt, songs, chat }) {
  const candidates = buildAuditCandidates(songs);
  if (!candidates.list.length) return { ok: false, error: 'NO_CANDIDATES' };

  const topic = _field(prompt || '', 200);
  const name = _field(playlistName, MAX_NAME_CHARS) || '这份歌单';
  const desc = _field(playlistDesc, 200);
  const context = [
    `歌单名：${name}`,
    desc ? `描述：${desc}` : '',
    topic ? `本次运维想解决的问题：${topic}` : '本次运维目标：让这份歌单主题更集中、风格更统一',
  ].filter(Boolean).join('\n');

  let text;
  try {
    text = await chat([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: `${context}\n\n歌单内容（序号\t标题\t歌手，共 ${candidates.total} 首${candidates.truncated ? `，仅展示前 ${candidates.list.length} 首` : ''}）：\n${candidates.text}` },
    ]);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: isConfigToken(msg) ? msg : 'LLM_FAILED' };
  }

  const parsed = parseAudit(text, candidates);
  if (!parsed.audit.length) return { ok: false, error: 'NO_AUDIT' };
  return {
    ok: true,
    name: parsed.name || name,
    desc: parsed.desc,
    summary: parsed.summary,
    audit: parsed.audit,
    candidates: candidates.list.map(r => ({ n: r.n, title: r.title, artist: r.artist, song: r.song })),
    candidateCount: candidates.list.length,
    truncated: candidates.truncated,
  };
}

module.exports = {
  songKey, buildAuditCandidates, buildSystemPrompt, parseAudit, auditPlaylist,
  MAX_CANDIDATES, MAX_NAME_CHARS, MAX_DESC_CHARS, MAX_REASON_CHARS, MAX_SUMMARY_CHARS,
  VALID_FIT, VALID_SUGGEST,
};