/**
 * MCP 工具面（P1）—— 从 ipcContract 派生的显式白名单
 *
 * 设计：
 *   - 工具 = { name(snake_case), channel(契约通道), description, required?, paramDocs? }
 *   - inputSchema 不手写，由契约参数规格（t.str/t.int/...）派生 —— 与
 *     preload 白名单同一套路：契约是唯一事实来源，工具面自动跟随参数钳制
 *   - 白名单纪律：只放「查询 + 加法动作」。cookie/登录、文件路径读写、
 *     set-pref、对话框、更新安装一律不进（外部 Agent 的可信度低于渲染层）
 *   - risk 分层（唯一判据）：read 只读 / write 改数据但可逆 / destructive 删、清空、覆盖盘
 *   - mutating 由 risk 派生（risk !== 'read'）：谁都不许再手写它，两处各写一遍迟早飘
 *   - audience：both = 主进程有 handler、两侧都能执行；app = 只能在渲染层执行（播放控制）
 *
 * 新通道要暴露给 Agent = 在这里加一行 + 想清楚它能否被陌生程序驱动。
 */

const { CHANNELS } = require('../../shared/ipcContract');

const RISK_LEVELS = ['read', 'write', 'destructive'];
const AUDIENCES = ['both', 'app'];

const AGENT_TOOLS = [
  // ── 查询 ──────────────────────────────────────────
  {
    name: 'search_music', channel: 'search-music', risk: 'read',
    description: '按关键词在音乐平台搜索歌曲。source 传 "all" 聚合 8 平台。返回 {songs:[{id,source,title,artist,album,duration,...}]}',
    required: ['keyword'],
    paramDocs: { keyword: '搜索关键词', source: '平台 id（netease/qq/kugou/kuwo/migu/bilibili/soda/fivesing）或 all', page: '页码，从 1 开始' },
  },
  {
    name: 'ai_search_music', channel: 'nl-search-music', risk: 'read',
    description: '自然语言找歌：输入一句话需求（如「适合夜跑的中文摇滚」），由 LLM 改写成多关键词并行聚合搜索后合并去重。需要已在应用内配置大模型 API Key（厂商可选，默认 MiniMax）。',
    required: ['phrase'],
    paramDocs: { phrase: '自然语言描述的听歌需求' },
  },
  {
    name: 'get_lyrics', channel: 'get-lyrics', risk: 'read',
    description: '获取歌曲 LRC 歌词。id/source 来自搜索结果；title/artist 用于跨源兜底匹配。',
    required: ['id'],
    paramDocs: { id: '歌曲 id', source: '来源平台 id', title: '歌名（兜底）', artist: '歌手（兜底）' },
  },
  {
    name: 'parse_link', channel: 'get-song-by-link', risk: 'read',
    description: '识别音乐平台分享链接/文本，返回 {matched, song?|link?} 结构化结果。',
    required: ['text'],
    paramDocs: { text: '含链接的原始文本' },
  },
  {
    name: 'search_singer', channel: 'search-singer', risk: 'read',
    description: '搜索歌手。qq 系平台返回 mid，可继续 get_singer_songs。',
    required: ['keyword'],
    paramDocs: { keyword: '歌手名', source: '平台 id 或 all', page: '页码' },
  },
  {
    name: 'search_album', channel: 'search-album', risk: 'read',
    description: '搜索专辑。',
    required: ['keyword'],
    paramDocs: { keyword: '专辑名', source: '平台 id', page: '页码' },
  },
  {
    name: 'get_singer_songs', channel: 'get-singer-songs', risk: 'read',
    description: '按歌手 mid 拉取其热门歌曲。',
    required: ['singerMid'],
    paramDocs: { singerMid: '歌手 mid（来自 search_singer）', limit: '数量上限' },
  },
  {
    name: 'get_album_songs', channel: 'get-album-songs', risk: 'read',
    description: '按专辑 mid 拉取专辑曲目。',
    required: ['platform', 'albumMid'],
    paramDocs: { platform: '平台 id', albumMid: '专辑 mid', limit: '数量上限' },
  },
  {
    name: 'get_playlist_songs', channel: 'get-playlist-songs', risk: 'read',
    description: '拉取平台公开歌单曲目。',
    required: ['platform', 'id'],
    paramDocs: { platform: '平台 id', id: '歌单 id', limit: '数量上限' },
  },
  {
    name: 'list_platforms', channel: 'get-platforms', risk: 'read',
    description: '列出全部音乐平台及其能力（id/名称/支持的功能标志）。',
  },
  {
    name: 'source_health', channel: 'get-source-health', risk: 'read',
    description: '各音源近期可用性健康度（真实下载/探测的滑动窗口统计）。',
  },
  // ── 曲库/历史查询 ─────────────────────────────────
  {
    name: 'query_history', channel: 'query-history', risk: 'read',
    description: '查询下载/播放历史。opts:{limit,offset,kind(download|play),keyword}。',
    paramDocs: { opts: '查询选项对象' },
  },
  {
    name: 'history_stats', channel: 'history-stats', risk: 'read',
    description: '历史记录总量统计。',
  },
  {
    name: 'list_playlists', channel: 'get-user-playlists', risk: 'read',
    description: '列出用户自建歌单（含曲目）。',
  },
  // ── 加法动作（可信 Agent 才开到这一层）─────────────
  {
    name: 'add_to_queue', channel: 'add-to-queue',
    description: '把一首歌加入下载队列（song 对象直接传 search_music 的结果项）。',
    required: ['song'],
    risk: 'write',
    paramDocs: { song: '搜索结果里的歌曲对象（需含 id/source/title/artist）' },
  },
  {
    name: 'add_to_playlist', channel: 'add-to-user-playlist',
    description: '把一首歌加入指定用户歌单。',
    required: ['playlistId', 'song'],
    risk: 'write',
    paramDocs: { playlistId: '歌单 id（来自 list_playlists）', song: '歌曲对象' },
  },
  {
    name: 'toggle_favorite', channel: 'toggle-favorite',
    description: '红心收藏切换一首歌。',
    required: ['source', 'songId'],
    risk: 'write',
    paramDocs: { source: '平台 id', songId: '歌曲 id', song: '歌曲对象（收藏时需要）' },
  },
];

/** 契约参数规格 → JSON Schema 片段（MCP inputSchema 的属性） */
function specToJsonSchema(spec) {
  switch (spec.k) {
    case 'str':  return { type: 'string', maxLength: spec.max };
    case 'int':  return { type: 'integer', default: spec.def, minimum: 1, maximum: spec.max };
    case 'bool': return { type: 'boolean' };
    case 'enum': return { type: 'string', enum: spec.values, default: spec.def };
    case 'obj':  return { type: 'object' };
    case 'arr':  return { type: 'array' };
    default:     return {}; // any：id 等可能是数字或字符串
  }
}

/**
 * 派生 MCP tools/list 用的工具定义清单。
 * @param {Array} [list] AGENT_TOOLS 覆盖（测试用）
 * @param {Object} [channels] CHANNELS 覆盖
 * @returns {Array<{name,description,inputSchema,channel,risk,audience,mutating}>}
 */
function toolsFromContract(list = AGENT_TOOLS, channels = CHANNELS) {
  return list.map(tool => {
    if (!RISK_LEVELS.includes(tool.risk)) {
      throw new Error(`[mcp] 工具 ${tool.name} 的 risk 非法: ${String(tool.risk)}（只能是 ${RISK_LEVELS.join('/')}）`);
    }
    const audience = tool.audience || 'both';
    if (!AUDIENCES.includes(audience)) {
      throw new Error(`[mcp] 工具 ${tool.name} 的 audience 非法: ${String(audience)}（只能是 ${AUDIENCES.join('/')}）`);
    }
    const entry = channels[tool.channel];
    if (!entry || !(entry.invoke || []).includes('main')) {
      throw new Error(`[mcp] 工具 ${tool.name} 的通道不是 main invoke: ${tool.channel}`);
    }
    const properties = {};
    for (const [name, spec] of entry.args || []) {
      const prop = specToJsonSchema(spec);
      if (tool.paramDocs && tool.paramDocs[name]) prop.description = tool.paramDocs[name];
      properties[name] = prop;
    }
    const tdef = {
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties },
      channel: tool.channel,
      risk: tool.risk,
      audience,
      // 派生而不是手写：一份判据只许有一个出处
      mutating: tool.risk !== 'read',
    };
    if (tool.required && tool.required.length) tdef.inputSchema.required = tool.required;
    return tdef;
  });
}

const MUTATING_TOOL_NAMES = new Set(toolsFromContract().filter(t => t.mutating).map(t => t.name));

/**
 * 外部 Agent 能看到的工具 —— 判据只有这一处。
 * destructive（删、清空）与 app（主进程根本没法执行）都不给：前者外部 Agent 的可信度
 * 撑不起「一次批准就跑删除」，后者给它是个永远调用不通的工具名。
 */
function visibleToAgent(def) {
  return def.audience === 'both' && def.risk !== 'destructive';
}

/** @param {'agent'|'assistant'} source */
function toolsForSource(source, list = AGENT_TOOLS, channels = CHANNELS) {
  const all = toolsFromContract(list, channels);
  return source === 'agent' ? all.filter(visibleToAgent) : all;
}

module.exports = {
  AGENT_TOOLS, MUTATING_TOOL_NAMES, TOOLS_VERSION_HINT: '2025-03-26',
  toolsFromContract, specToJsonSchema, RISK_LEVELS, AUDIENCES,
  visibleToAgent, toolsForSource,
};
