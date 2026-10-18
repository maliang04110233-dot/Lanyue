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

const { CHANNELS, t } = require('../../shared/ipcContract');

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
  {
    name: 'list_subscriptions', channel: 'subscribe-list', risk: 'read',
    description: '列出用户订阅的歌手与歌单（type 只有 singer / playlist 两类，没有「账号」这一种）。返回 [{key,type,platform,targetId,name}] 形状的数组。',
  },
  {
    // 描述即提示词：这里写的必须是**两边今天就同时成立**的事实。出网脱敏闸按裁定 R-14 只装在
    // 「助手 → 厂商」那一条路上，外部 Agent 这条仍拿到 handler 原样返回的模板（prefs 里的
    // path/subpath，mcpCore 只把返回值 JSON.stringify，中间没有字段过滤），所以这句如实告知形状
    // 并提醒别原样念，而不是承诺「路径不回给你」。
    name: 'list_download_templates', channel: 'get-download-templates', risk: 'read',
    description: '列出下载目录模板与当前启用项。返回 {templates:[{id,name,path,subpath,createdAt,updatedAt}],active:模板id|null}。path 是用户本机的绝对目录路径，subpath 是它相对下载根目录的片段（可能为空字符串）：那是用户自己的磁盘布局，别原样念给用户，回答里只说模板名与是否启用。',
  },
  {
    name: 'get_play_queue', channel: 'load-play-queue', risk: 'read',
    description: '读持久化的播放队列（上次会话留下的那份）。返回 {queue:[{id,source,title,artist,…}]}。',
  },
  {
    name: 'aggregate_library', channel: 'aggregate-cross-source', risk: 'read',
    description: '跨源聚合用户的曲库。默认只看本地红心单；要把具体歌单一起纳进来得传 opts.playlists:[{source,id}]。opts 还支持 sources（平台 id 数组，不给则取红心里出现过的 source）与 markDuplicates（默认 true）。返回按曲目合并的清单，单个来源失败按空列表降级并在 failed 里回报。',
    paramDocs: { opts: '聚合选项对象：{playlists?:[{source,id}], sources?:[string], markDuplicates?:boolean}' },
  },
  // ── 只在渲染层执行（audience:'app'）──────────────────
  // 播放/切歌/音量/开页这些能力根本不在主进程里：状态与 audio 元素都长在渲染层，
  // 为它们造一条 IPC 只是把一次函数调用换成三层往返，还多一处可绕过的口子。
  // 因此它们**不进外部 Agent 的面**（toolsForSource 已按 audience 排除），
  // 执行者是助手视图自己的一份 action 表 —— 见 views/ai-assistant.js 的 APP_ACTIONS。
  { name: 'play_toggle', action: 'play.toggle', audience: 'app', risk: 'write',
    description: '继续或暂停当前播放。' },
  { name: 'play_next', action: 'play.next', audience: 'app', risk: 'write',
    description: '切到下一首。' },
  { name: 'play_prev', action: 'play.prev', audience: 'app', risk: 'write',
    description: '切到上一首。' },
  { name: 'set_play_volume', action: 'play.volume', audience: 'app', risk: 'write',
    description: '把播放音量设成 value（0-100）。', required: ['value'],
    argSpecs: [['value', t.int(50, 100)]], paramDocs: { value: '音量百分比' } },
  { name: 'play_search_result', action: 'play.result', audience: 'app', risk: 'write',
    description: '播放「本次搜索」列表里的第 index 首（从 1 数，索引来自状态段）。', required: ['index'],
    argSpecs: [['index', t.int(1, 50)]], paramDocs: { index: '序号，从 1 开始' } },
  { name: 'open_app_page', action: 'ui.open', audience: 'app', risk: 'write',
    description: '把应用切到某个页面，方便用户看到结果。', required: ['tab'],
    argSpecs: [['tab', t.enum(['home', 'search', 'download', 'local', 'aggregate', 'playlist', 'subscription', 'assistant'], 'home')]],
    paramDocs: { tab: '页面 id' } },
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
  // ── 可逆写（应用内整批批准；外部 Agent 仍可单独调用）──
  { name: 'cancel_download', channel: 'cancel-download', risk: 'write',
    description: '取消一个下载任务（taskId 来自下载队列）。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'retry_download', channel: 'retry-download', risk: 'write',
    description: '重试一个已失败的下载任务。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'remove_queue_item', channel: 'remove-queue-item', risk: 'write',
    description: '从下载队列里移掉一个任务（不删已下好的文件）。', required: ['taskId'], paramDocs: { taskId: '任务 id' } },
  { name: 'reorder_queue_item', channel: 'reorder-queue-item', risk: 'write',
    description: '调整下载队列顺序。action: up/down/top。', required: ['taskId', 'action'],
    paramDocs: { taskId: '任务 id', action: 'up | down | top' } },
  { name: 'set_download_queue_paused', channel: 'set-queue-paused', risk: 'write',
    description: '暂停或继续整个下载队列。', required: ['paused'], paramDocs: { paused: 'true=暂停' } },
  { name: 'add_playlist_to_downloads', channel: 'add-playlist-to-queue', risk: 'write',
    description: '把一个歌单整体加入下载队列。payload 是界面那条批量对象（含歌曲清单与质量）。',
    required: ['payload'], paramDocs: { payload: '批量入队对象' } },
  { name: 'save_download_template', channel: 'save-download-template', risk: 'write',
    description: '新增或更新一个下载目录模板（template:{id?,name,path}）。模板的存储路径由界面给定。',
    required: ['template'], paramDocs: { template: '模板对象' } },
  { name: 'remove_from_playlist', channel: 'remove-from-user-playlist', risk: 'write',
    description: '从用户歌单里移掉一首歌（歌单本身还在）。', required: ['playlistId', 'songId'],
    paramDocs: { playlistId: '歌单 id', songId: '歌曲 id', source: '平台 id' } },
  { name: 'subscribe_add', channel: 'subscribe-add', risk: 'write',
    description: '新增一个订阅项（歌手/歌单/账号）。type 与 platform 见 list_platforms。',
    required: ['type', 'platform', 'targetId'], paramDocs: { type: '订阅类型', platform: '平台 id', targetId: '目标 id', name: '显示名' } },
  { name: 'subscribe_mark_seen', channel: 'subscribe-mark-seen', risk: 'write',
    description: '把一个订阅项标记为已读（清掉「有新内容」的角标）。', required: ['key'], paramDocs: { key: '订阅键' } },
  // ── 破坏性（只在应用内、且必须单项确认；外部 Agent 看不到）──
  { name: 'clear_finished_downloads', channel: 'clear-finished-queue', risk: 'destructive',
    description: '把下载队列里已完成/失败的条目从列表里清掉（不动磁盘上的文件）。' },
  { name: 'clear_all_downloads', channel: 'clear-all-queue', risk: 'destructive',
    description: '清空整个下载队列（未完成的会一起被取消）。' },
  { name: 'delete_download_template', channel: 'delete-download-template', risk: 'destructive',
    description: '删掉一个下载目录模板。', required: ['templateId'], paramDocs: { templateId: '模板 id' } },
  { name: 'delete_user_playlist', channel: 'delete-user-playlist', risk: 'destructive',
    description: '删掉一个用户自建歌单（里面的歌会一起从歌单里消失）。', required: ['playlistId'],
    paramDocs: { playlistId: '歌单 id' } },
  { name: 'unsubscribe', channel: 'subscribe-remove', risk: 'destructive',
    description: '移除一个订阅项。', required: ['key'], paramDocs: { key: '订阅键' } },
  { name: 'clear_history', channel: 'clear-history', risk: 'destructive',
    description: '清空全部下载/播放历史记录。' },
  { name: 'remove_history', channel: 'remove-history', risk: 'destructive',
    description: '按条目移除历史记录。entries 是 query_history 返回的项。', required: ['entries'],
    paramDocs: { entries: '历史条目数组' } },
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
    const properties = {};
    if (audience === 'app') {
      // 渲染层能力没有 IPC 通道可派生：参数规格就地声明（argSpecs），但用的还是契约那套 t.* 原语，
      // 于是「参数怎么钳制」这条链上的词汇仍是唯一一份；CHANNELS 里查不到它们，也不该去查。
      for (const [name, spec] of tool.argSpecs || []) {
        const prop = specToJsonSchema(spec);
        if (tool.paramDocs && tool.paramDocs[name]) prop.description = tool.paramDocs[name];
        properties[name] = prop;
      }
    } else {
      const entry = channels[tool.channel];
      if (!entry || !(entry.invoke || []).includes('main')) {
        throw new Error(`[mcp] 工具 ${tool.name} 的通道不是 main invoke: ${tool.channel}`);
      }
      for (const [name, spec] of entry.args || []) {
        const prop = specToJsonSchema(spec);
        if (tool.paramDocs && tool.paramDocs[name]) prop.description = tool.paramDocs[name];
        properties[name] = prop;
      }
    }
    const tdef = {
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties },
      channel: audience === 'app' ? null : tool.channel,
      risk: tool.risk,
      audience,
      ...(tool.action ? { action: tool.action } : {}),
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
 *
 * 只接 toolsFromContract 的**产物**：那里才把缺省的 audience 补成 'both'，原始登记表行
 * 没有 audience 字段，直接喂进来会被判成「不可见」。这里不补 `|| 'both'` ——
 * 那等于给同一个缺省造出第二个出处。
 */
function visibleToAgent(def) {
  return def.audience === 'both' && def.risk !== 'destructive';
}

/**
 * 按 caller 身份给视图。source 是**白名单**：除 'agent' / 'assistant' 一律抛。
 * 不做「未知就当助手」的兜底 —— 协议层 createMcpHandler 的 source 默认补 'agent'，
 * 过滤层若把未知/漏传也放过去，将来第三个 caller（CLI、调试端点）拿到的是含 destructive
 * 与 app-only 的全量面，而审计标签却被协议层默认补成 'agent'，两边各说各话。
 * 与本仓「装载期非法值即抛」（见 toolsFromContract 的 risk/audience 校验）同构。
 *
 * @param {'agent'|'assistant'} source 调用方身份
 * @param {Array} [list] AGENT_TOOLS 覆盖（测试用）
 * @param {Object} [channels] CHANNELS 覆盖
 */
function toolsForSource(source, list = AGENT_TOOLS, channels = CHANNELS) {
  if (source !== 'agent' && source !== 'assistant') {
    throw new Error(`[mcp] toolsForSource 的 source 非法: ${String(source)}（只能是 agent/assistant）`);
  }
  const all = toolsFromContract(list, channels);
  // agent 走唯一判据；assistant 是全量（确认形态由界面去决定）
  return source === 'agent' ? all.filter(visibleToAgent) : all;
}

module.exports = {
  AGENT_TOOLS, MUTATING_TOOL_NAMES, TOOLS_VERSION_HINT: '2025-03-26',
  toolsFromContract, specToJsonSchema, RISK_LEVELS, AUDIENCES,
  visibleToAgent, toolsForSource,
};
