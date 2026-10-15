/**
 * 大模型厂商登记表（一处说清「往哪发、发什么型号、哪来的 Key」）
 *
 * 为什么要有这个文件：升级前四处 LLM 调用（助手 / 歌词 / 关键词改写 / 智能歌单策划）
 * 全把 `https://api.minimaxi.com/v1/text/chatcompletion_v2` 与模型名写死在
 * `src/api/ai-music.js` 里。加厂商不是把常量换成变量那么简单 ——
 *
 *   1. **各家的 chat 路径互不相同**：智谱在 `/api/paas/v4`，火山方舟在 `/api/v3`，
 *      阿里百炼在 `/compatible-mode/v1`，Kimi 才是标准 `/v1/chat/completions`，
 *      MiniMax 用的是自家老名字 `/v1/text/chatcompletion_v2`。写错一处的表现是 404，
 *      而 404 在界面上和「Key 无效」长得一模一样 —— 所以必须能在离线断言里成立。
 *   2. **Key 从一根裸串变成一个映射**：`aiMusicApiKey` 仍是唯一的 secret 键名
 *      （`utils/prefs.js` 的 SECRET_KEYS、`utils/redact.js` 的掩码、cloudSync 的导出
 *      排除都按键名工作，改键名要同时动四处口径，必然漂移）。值改成 {厂商: Key} 的
 *      JSON，读侧一次性兼容旧裸串。关键约束：**看着像 JSON 却解析失败时当空映射**，
 *      绝不能退化成「把整串当 Key 发出去」—— 那是把坏状态往计费接口推。
 *   3. **自定义 Base URL 是用户可控的出网目标**：它和登记表内六家过同一道闸
 *      （`utils/urlGuard.js`：协议、userinfo、内网 IP 的十进制/十六进制/八进制写法、
 *      解析后把连接钉在已校验的 IP 上防 rebinding）。**不给任何厂商开免检例外** ——
 *      开一次例外，将来漏检的就是它。
 *
 * 型号名单不在这里钉：各家型号名一直在换，登记表负责的是**端点**。界面上型号是
 * 可编辑输入框，推荐值放在 `defaultModel`。两个例外要记住：豆包方舟的 `model`
 * 字段收的是推理接入点 ID（`ep-xxxxxxxx`）而不是型号名；音乐合成只有 MiniMax 提供。
 *
 * 渲染层（ESM、无打包器）require 不到本文件，而它要画下拉。**不在界面侧攒镜像名单**
 * —— 镜像要靠测试钉着才不分叉，而"递过去"根本不会分叉：`providerConfig()` 的返回值
 * 就是下拉的数据源（经 ai-provider-config 通道），`applyConfigPatch()` 就是保存的唯一
 * 写入口（校验 + Key 合并都在本文件，界面只交出它填的东西）。
 * 附带的好处：Key 本体从此不跨进程 —— 界面只拿到「这家配过没有」的布尔。
 */

const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');

/** 登记表顺序即界面下拉顺序；MiniMax 居首且是默认（只有它能合成音乐） */
const PROVIDERS = [
  {
    id: 'minimax',
    label: 'MiniMax（国内）',
    chatBase: 'https://api.minimaxi.com',
    chatPath: '/v1/text/chatcompletion_v2',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    defaultModel: 'MiniMax-Text-01',
    music: true,
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    chatBase: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    music: false,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云百炼）',
    chatBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    defaultModel: 'qwen-plus',
    music: false,
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    chatBase: 'https://api.moonshot.cn',
    chatPath: '/v1/chat/completions',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
    defaultModel: 'moonshot-v1-8k',
    music: false,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    chatBase: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    models: ['glm-4-flash', 'glm-4-plus'],
    defaultModel: 'glm-4-flash',
    music: false,
    keyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    chatBase: 'https://ark.cn-beijing.volces.com',
    chatPath: '/api/v3/chat/completions',
    // 方舟要的是「推理接入点 ID」，型号名填进去调不通，所以不给推荐值、
    // 名单留空 —— 用户必须自己填 ep-xxxxxxxx，界面上这栏的说明由此而来。
    models: [],
    defaultModel: '',
    music: false,
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'custom',
    label: '自定义端点（OpenAI 兼容）',
    chatBase: '',
    chatPath: '/chat/completions',
    models: [],
    defaultModel: '',
    music: false,
    keyUrl: '',
  },
];

const DEFAULT_PROVIDER_ID = 'minimax';

/** 型号名的可接受形态：字母数字与 . _ - :，不许空白/控制字符/尖括号（要进 JSON 与 URL） */
const MODEL_RE = /^[\w.:-]{1,120}$/;

/** 空 = 不填（落回该家推荐值）；非空必须过形状。理由同 chatPath：型号要进 JSON 体，
 *  带换行进去的就是一个 header 注入面。 */
function validateModel(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, model: '' };
  if (!MODEL_RE.test(s)) return { ok: false, reason: 'SHAPE' };
  return { ok: true, model: s };
}

const PREF_KEYS = {
  provider: 'aiProvider',
  model: 'aiProviderModel',
  baseUrl: 'aiProviderBaseUrl',
  apiKey: 'aiMusicApiKey',
};

function getProvider(id) {
  const hit = PROVIDERS.find((p) => p.id === id);
  return hit || PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER_ID);
}

/**
 * Base URL 词法校验（不查 DNS，纯函数，给闸在前的一道）。
 * 拒：非 https、带 userinfo、没有主机名、根本不是 URL。放行带路径与非默认端口
 * 的公网反代（自建网关常在 8443），内网那一层由 urlGuard 的 IP 判定负责。
 */
function validateBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, reason: 'EMPTY' };
  let u;
  try {
    u = new URL(s);
  } catch (_e) {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'HTTPS_ONLY' };
  if (u.username || u.password) return { ok: false, reason: 'NO_USERINFO' };
  if (!u.hostname) return { ok: false, reason: 'NO_HOST' };
  return { ok: true, url: u };
}

/**
 * 出网闸：先词法再 DNS，并把连接钉在已校验的 IP 上（防 rebinding）。
 * 名字里带 Ai 不带 chat 是因为音乐合成那一跳也过它 —— 全仓的 AI 出网点
 * 同一条闸，**不给任何厂商开免检例外**。
 * 返回 { ok, lookup, reason }；reason 是 ASCII 码，给人看的措辞留在渲染层词典
 * —— 主进程不该把中文错误经 IPC 递给界面（本仓既有口径）。
 */
async function guardAiEndpoint(url) {
  const lexical = validateBaseUrl(url);
  if (!lexical.ok) return { ok: false, reason: `BAD_BASE_URL:${lexical.reason}` };
  const checked = await assertPublicHttpUrl(url);
  if (!checked.ok) return { ok: false, reason: 'ENDPOINT_BLOCKED' };
  return { ok: true, lookup: makePinnedLookup(checked.ips), hostname: checked.url.hostname };
}

/**
 * 配置类令牌的全集：这些串是「哪一步的哪个判据拒了」的编码，不是给人读的文案。
 * 调用链上每一层把异常压成 LLM_FAILED 之前都得先问一句是不是令牌 —— 「闸拒了这个
 * 端点」和「模型这轮没答好」用户要做的事完全不同（一个去改配置，一个直接重问），
 * 混成一个令牌就是把可修的问题报成了不可修的。
 */
const CONFIG_TOKEN_RE = /^(?:NO_KEY|MUSIC_UNSUPPORTED|ENDPOINT_BLOCKED|UNKNOWN_PROVIDER|PREF_WRITE_FAILED|BAD_BASE_URL(?::[A-Z0-9_]+)?|BAD_MODEL(?::[A-Z0-9_]+)?|LLM_HTTP:\d{3})$/;

function isConfigToken(value) {
  return CONFIG_TOKEN_RE.test(String(value == null ? '' : value));
}

/** 该次调用真正打到哪：覆盖地址换 host，路径仍用这家登记的 chatPath */
function chatEndpointUrl(cfg) {
  const provider = getProvider(cfg && cfg.providerId);
  const override = String((cfg && cfg.baseUrl) || '').trim();
  let base = provider.chatBase;
  if (override) {
    const v = validateBaseUrl(override);
    if (!v.ok) throw new Error(`BAD_BASE_URL:${v.reason}`);
    base = `${v.url.protocol}//${v.url.host}${v.url.pathname.replace(/\/+$/, '')}`;
  } else if (provider.id === 'custom') {
    throw new Error('BAD_BASE_URL:EMPTY');
  }
  if (!base) throw new Error('BAD_BASE_URL:EMPTY');
  return base.replace(/\/+$/, '') + provider.chatPath;
}

/**
 * secret 值 → {厂商: Key}。
 * 三种输入都要有明确落点：旧裸串（升级前只有 MiniMax，认作 MiniMax 的）、
 * 合法 JSON 映射、坏 JSON。第三种**当空映射** —— 宁可报 NO_KEY 让用户重填，
 * 也不把一整个 JSON 串塞进 Authorization 头打出去。
 */
function readKeyMap(raw) {
  if (typeof raw !== 'string') return {};
  const s = raw.trim();
  if (!s) return {};
  if (!s.startsWith('{')) return { [DEFAULT_PROVIDER_ID]: s };
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (_e) {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** 空厂商不占地儿；全空写回空串，让 `if (!apiKey)` 这条 NO_KEY 判据照旧成立 */
function writeKeyMap(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => typeof v === 'string' && v.trim());
  if (!entries.length) return '';
  return JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, v.trim()])));
}

function keyFor(raw, providerId) {
  return readKeyMap(raw)[getProvider(providerId).id] || '';
}

/**
 * 一次文本调用需要的四件事，一个出处：都从 prefs 读。
 * （界面写 prefs、主进程读 prefs —— 若两边各留一份「当前厂商」，就是本仓
 *  已经付过学费的那类分叉。）
 */
function chatConfigFrom(getPref) {
  const get = typeof getPref === 'function' ? getPref : () => undefined;
  const provider = getProvider(String(get(PREF_KEYS.provider) || ''));
  const modelPref = String(get(PREF_KEYS.model) || '').trim();
  const baseUrlPref = String(get(PREF_KEYS.baseUrl) || '').trim();
  return {
    providerId: provider.id,
    model: modelPref || provider.defaultModel,
    baseUrl: baseUrlPref,
    apiKey: keyFor(get(PREF_KEYS.apiKey), provider.id),
    supportsMusic: provider.music,
  };
}

/**
 * 纯函数地拼出「这一次发什么」：URL + 头 + body。
 * 抽出来是因为计费接口不能拿真 Key 试错，请求正确性必须能在测试里成立。
 */
function buildChatRequest(params) {
  const p = params || {};
  const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
  if (!apiKey) throw new Error('NO_KEY');

  const url = chatEndpointUrl({ providerId: p.providerId, baseUrl: p.baseUrl });

  const provider = getProvider(p.providerId);
  const model = String(p.model == null ? '' : p.model).trim() || provider.defaultModel;
  if (!model) throw new Error('BAD_MODEL:REQUIRED');
  if (!MODEL_RE.test(model)) throw new Error('BAD_MODEL:SHAPE');

  const body = { model, messages: p.messages || [] };
  if (typeof p.temperature === 'number') body.temperature = p.temperature;
  if (typeof p.maxTokens === 'number') body.max_tokens = p.maxTokens;

  return { url, body, headers: { Authorization: `Bearer ${apiKey}` } };
}

/**
 * 界面要画的那张下拉 + 那三个输入框的回显，一个出处。
 * 刻意**不含任何 Key 本体**：渲染层只需要知道"这家配过没有"，
 * 拿到的是布尔（升级前 getPref('aiMusicApiKey') 把明文 Key 递给界面，
 * 那一趟如今没有必要，也就少一个泄露面）。
 */
function providerConfig(getPref) {
  const get = typeof getPref === 'function' ? getPref : () => undefined;
  const cfg = chatConfigFrom(get);
  const map = readKeyMap(get(PREF_KEYS.apiKey));
  const keys = {};
  for (const p of PROVIDERS) keys[p.id] = !!map[p.id];
  return {
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      models: p.models.slice(),
      music: p.music === true,
      keyUrl: p.keyUrl || '',
    })),
    current: {
      providerId: cfg.providerId,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasKey: !!cfg.apiKey,
    },
    supportsMusic: cfg.supportsMusic === true,
    keys,
  };
}

function _knownProviderId(id) {
  return PROVIDERS.some((p) => p.id === String(id));
}

/**
 * 保存界面上那四个控件（厂商 / 型号 / 自定义端点 / 该家的 Key）。
 *
 * 两条不可让步的形状：
 *   - **全验完才写**：半写状态是「下拉显示新厂商、存的还是旧的」，用户看不出来。
 *   - **Key 是合并**：直接覆盖 secret 值会把别家已配好的凭据整包抹掉。
 * `key.value` 留空 = 不动它（清空输入框不该等于删凭据）；显式传 null 才是删。
 * 返回 {ok:true, config} 或 {ok:false, error:<ASCII 码>} —— 码表在渲染层词典翻译。
 */
function applyConfigPatch(patch, getPref, setPref) {
  const get = typeof getPref === 'function' ? getPref : () => undefined;
  const set = typeof setPref === 'function' ? setPref : () => false;
  const p = patch && typeof patch === 'object' ? patch : {};
  const writes = [];

  if (p.providerId !== undefined) {
    const id = String(p.providerId);
    if (!_knownProviderId(id)) return { ok: false, error: 'UNKNOWN_PROVIDER' };
    writes.push([PREF_KEYS.provider, id]);
  }

  if (p.model !== undefined) {
    const v = validateModel(p.model);
    if (!v.ok) return { ok: false, error: `BAD_MODEL:${v.reason}` };
    writes.push([PREF_KEYS.model, v.model]);
  }

  if (p.baseUrl !== undefined) {
    const s = String(p.baseUrl == null ? '' : p.baseUrl).trim();
    if (s) {
      const check = validateBaseUrl(s);
      if (!check.ok) return { ok: false, error: `BAD_BASE_URL:${check.reason}` };
    }
    writes.push([PREF_KEYS.baseUrl, s]);
  }

  if (p.key && typeof p.key === 'object') {
    const vendorId = String(p.key.vendorId || '');
    if (!_knownProviderId(vendorId)) return { ok: false, error: 'UNKNOWN_PROVIDER' };
    const explicitClear = p.key.value === null || p.key.value === undefined;
    const value = explicitClear ? '' : String(p.key.value).trim();
    if (explicitClear || value) {
      const map = readKeyMap(get(PREF_KEYS.apiKey));
      if (explicitClear) delete map[vendorId];
      else map[vendorId] = value;
      writes.push([PREF_KEYS.apiKey, writeKeyMap(map)]);
    }
  }

  for (const [k, v] of writes) {
    if (set(k, v) === false) {
      return { ok: false, error: 'PREF_WRITE_FAILED' };
    }
  }
  return { ok: true, config: providerConfig(get) };
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  PREF_KEYS,
  getProvider,
  chatEndpointUrl,
  validateBaseUrl,
  validateModel,
  guardAiEndpoint,
  isConfigToken,
  readKeyMap,
  writeKeyMap,
  keyFor,
  chatConfigFrom,
  buildChatRequest,
  providerConfig,
  applyConfigPatch,
};
