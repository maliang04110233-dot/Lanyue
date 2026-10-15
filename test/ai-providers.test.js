/**
 * 国内主流大模型厂商接入的「登记表 + Key 映射 + 出网闸」口径
 *
 * 这份测试钉的是三件以前没有、加了厂商才会出现的问题：
 *   1. **端点在哪**。六家的 chat 路径各不相同（智谱在 /api/paas/v4，方舟在
 *      /api/v3，百炼在 /compatible-mode/v1，MiniMax 还在老名字
 *      /v1/text/chatcompletion_v2，其余是标准 /v1/chat/completions）。
 *      这些是查各家公开文档写的，写错一处就是 404 —— 而 404 在界面上
 *      长得跟「Key 无效」一样，所以必须有离线断言。
 *   2. **一把 secret 装多家 Key**。旧值是一根裸串，新值是 {厂商: Key} 的 JSON，
 *      读侧必须一次性兼容旧串，而**解析失败绝不能退化成「把整串当 Key 发出去」**
 *      —— 那等于拿一个坏到极点的 Authorization 头去打计费接口。
 *   3. **自定义 Base URL 是用户可控的出网目标**。这条不给免检：登记表内六家
 *      与用户手填的地址走同一道 urlGuard 闸（协议、userinfo、内网 IP 字面量的
 *      十进制/十六进制/八进制写法）。开一次「大厂免检」的例外，将来就是漏检点。
 *
 * 模型名不在这里钉死：各家型号名一直在换，登记表负责的是**端点**，
 * 型号由用户在界面上填（豆包方舟尤其特殊 —— 它的 model 字段收的是
 * 推理接入点 ID `ep-xxxxxxxx`，不是模型名，做成纯下拉就永远调不通）。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getProvider,
  chatEndpointUrl,
  validateBaseUrl,
  guardAiEndpoint,
  readKeyMap,
  writeKeyMap,
  keyFor,
  chatConfigFrom,
  buildChatRequest,
} = require('../src/api/aiProviders');

/** 假 prefs：只给一个 get(key)，不碰 electron 的 safeStorage */
const fakePrefs = (obj) => (key) => (key in obj ? obj[key] : undefined);

test('登记表：六家国内主流厂商 + 自定义，MiniMax 是默认', () => {
  const ids = PROVIDERS.map((p) => p.id);
  for (const want of ['minimax', 'deepseek', 'qwen', 'kimi', 'glm', 'doubao', 'custom']) {
    assert.ok(ids.includes(want), `登记表缺厂商：${want}`);
  }
  assert.equal(DEFAULT_PROVIDER_ID, 'minimax', '默认必须是 MiniMax（音乐合成只有它有）');
});

test('登记表形状：每家都有可用端点，音乐合成只有 MiniMax', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.label, `厂商缺 id/label: ${JSON.stringify(p)}`);
    if (p.id !== 'custom') {
      assert.ok(/^https:\/\//.test(p.chatBase), `${p.id} 的 chatBase 不是 https: ${p.chatBase}`);
      assert.ok(p.chatPath.startsWith('/'), `${p.id} 的 chatPath 没以 / 开头`);
    }
    assert.equal(typeof p.music, 'boolean', `${p.id} 的 music 标记缺失`);
    assert.equal(p.music, p.id === 'minimax', `音乐合成能力漂移: ${p.id}=${p.music}`);
  }
});

test('chat 端点逐家对齐各家公开路径（写错就是 404，界面上看着像 Key 无效）', () => {
  const expect = {
    minimax: 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
    deepseek: 'https://api.deepseek.com/chat/completions',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    kimi: 'https://api.moonshot.cn/v1/chat/completions',
    glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  };
  for (const [id, url] of Object.entries(expect)) {
    assert.equal(chatEndpointUrl({ providerId: id }), url, `厂商 ${id} 的端点不对`);
  }
});

test('Base URL 结尾多写的斜杠不会拼出双斜杠', () => {
  assert.equal(
    chatEndpointUrl({ providerId: 'deepseek', baseUrl: 'https://gw.example.com/v1/' }),
    'https://gw.example.com/v1/chat/completions',
  );
});

test('自定义 Base URL 覆盖登记表地址（同一家换代理/换区域）', () => {
  assert.equal(
    chatEndpointUrl({ providerId: 'glm', baseUrl: 'https://my-gateway.internal.example.com/v4' }),
    'https://my-gateway.internal.example.com/v4/chat/completions',
  );
});

test('validateBaseUrl：只认 https，其它协议与花活一律拒', () => {
  const bad = [
    'http://api.deepseek.com',
    'ftp://api.deepseek.com',
    'javascript:alert(1)',
    'https://user:pass@api.deepseek.com',
    'https://',
    'api.deepseek.com',
    'not a url',
  ];
  for (const raw of bad) {
    const r = validateBaseUrl(raw);
    assert.equal(r.ok, false, `本该拒收却放行了: ${raw}`);
    assert.ok(r.reason, `拒收必须给理由: ${raw}`);
  }
  // 带路径、带非默认端口的公网反代是合理用法，放行
  for (const good of ['https://gw.example.com/v1', 'https://gw.example.com:8443']) {
    assert.equal(validateBaseUrl(good).ok, true, good);
  }
});

test('出网闸：内网地址的各种写法都进不去（含十进制/十六进制/IPv6 映射）', async () => {
  const blocked = [
    'https://127.0.0.1/v1',
    'https://0.0.0.0/v1',
    'https://10.1.2.3/v1',
    'https://192.168.1.1:8443/v1',
    'https://169.254.169.254/v1', // 云上取元数据那一条
    'https://2130706433/v1',
    'https://0x7f.0.0.1/v1',
    'https://0177.0.0.1/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'http://8.8.8.8/v1', // 非 https 先挡下，不必等 DNS
  ];
  for (const raw of blocked) {
    const r = await guardAiEndpoint(raw);
    assert.equal(r.ok, false, `本该拒绝却放行: ${raw}`);
  }
  const ok = await guardAiEndpoint('https://8.8.8.8/v1/chat/completions');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(typeof ok.lookup, 'function', '放行时必须带回钉好的 lookup（防 rebinding）');
});

test('Key 映射：裸串旧值认作 MiniMax 的，不丢用户的 Key', () => {
  assert.deepEqual(readKeyMap('sk-old-plain'), { minimax: 'sk-old-plain' });
  assert.deepEqual(readKeyMap('{"deepseek":"sk-d"}'), { deepseek: 'sk-d' });
});

test('Key 映射：坏 JSON 绝不退化成「整串当 Key」', () => {
  // 旧值是裸串才走 {minimax:串}；看着像 JSON 却解析失败的，只能当空——
  // 把整串塞进 Authorization 头去打计费接口，是把坏状态往上游推。
  assert.deepEqual(readKeyMap('{"minimax": oops}'), {});
  assert.deepEqual(readKeyMap('{'), {});
  assert.deepEqual(readKeyMap(''), {});
  assert.deepEqual(readKeyMap(null), {});
  assert.deepEqual(readKeyMap('{"minimax":123}'), {}, '非字符串的值不收');
});

test('Key 映射写回：空的厂商不占地儿，全空写回空串（NO_KEY 判据照旧成立）', () => {
  assert.deepEqual(readKeyMap(writeKeyMap({ minimax: 'a', deepseek: '  ' })), { minimax: 'a' });
  assert.equal(writeKeyMap({ deepseek: '' }), '');
  assert.equal(writeKeyMap({}), '');
  assert.equal(fakePrefs({ aiMusicApiKey: writeKeyMap({}) })('aiMusicApiKey'), '');
});

test('keyFor 按厂商取，取不到就是空串（调用方据此报 NO_KEY）', () => {
  const raw = writeKeyMap({ minimax: 'sk-m', kimi: 'sk-k' });
  assert.equal(keyFor(raw, 'minimax'), 'sk-m');
  assert.equal(keyFor(raw, 'kimi'), 'sk-k');
  assert.equal(keyFor(raw, 'glm'), '');
});

test('chatConfigFrom：厂商/型号/Base URL/Key 一个出处（读 prefs），谁都不会拿到半套', () => {
  const cfg = chatConfigFrom(fakePrefs({
    aiProvider: 'deepseek',
    aiProviderModel: 'deepseek-reasoner',
    aiMusicApiKey: writeKeyMap({ deepseek: 'sk-d' }),
  }));
  assert.equal(cfg.providerId, 'deepseek');
  assert.equal(cfg.model, 'deepseek-reasoner');
  assert.equal(cfg.apiKey, 'sk-d');
  assert.equal(cfg.supportsMusic, false);
  assert.equal(chatEndpointUrl(cfg), 'https://api.deepseek.com/chat/completions');
});

test('chatConfigFrom：没配过的老用户落在 MiniMax + 推荐型号，行为与升级前一致', () => {
  const cfg = chatConfigFrom(fakePrefs({ aiMusicApiKey: 'sk-legacy' }));
  assert.equal(cfg.providerId, 'minimax');
  assert.equal(cfg.model, 'MiniMax-Text-01');
  assert.equal(cfg.apiKey, 'sk-legacy');
  assert.equal(cfg.supportsMusic, true);
});

test('chatConfigFrom：厂商名写错（手改配置文件）退回默认，而不是发一个空端点', () => {
  const cfg = chatConfigFrom(fakePrefs({ aiProvider: 'gpt', aiMusicApiKey: 'sk' }));
  assert.equal(cfg.providerId, 'minimax');
});

test('chatConfigFrom：自定义厂商没填 Base URL 时报错口径明确', () => {
  const cfg = chatConfigFrom(fakePrefs({ aiProvider: 'custom', aiMusicApiKey: 'sk' }));
  assert.equal(cfg.providerId, 'custom');
  assert.equal(cfg.baseUrl, '');
  assert.throws(() => chatEndpointUrl(cfg), /BASE_URL/);
});

test('buildChatRequest：URL、模型、Bearer 头三项都来自配置；Key 绝不进 body', () => {
  const req = buildChatRequest({
    providerId: 'kimi',
    model: 'moonshot-v1-8k',
    apiKey: 'sk-k',
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.8,
    maxTokens: 2048,
  });
  assert.equal(req.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(req.body.model, 'moonshot-v1-8k');
  assert.equal(req.body.max_tokens, 2048);
  assert.equal(req.headers.Authorization, 'Bearer sk-k');
  assert.ok(!JSON.stringify(req.body).includes('sk-k'), 'Key 漏进了请求体');
});

test('buildChatRequest：型号留空用该家推荐型号；豆包没有推荐型号就得由用户填', () => {
  assert.equal(buildChatRequest({ providerId: 'qwen', apiKey: 'k', messages: [] }).body.model, 'qwen-plus');
  assert.throws(() => buildChatRequest({ providerId: 'doubao', apiKey: 'k', messages: [] }), /MODEL/);
  assert.equal(
    buildChatRequest({ providerId: 'doubao', apiKey: 'k', model: 'ep-abcdef', messages: [] }).body.model,
    'ep-abcdef',
  );
});

test('buildChatRequest：型号与 Base URL 里的控制字符与超长串先拒（它要进 URL 与 JSON）', () => {
  assert.throws(() => buildChatRequest({ providerId: 'glm', apiKey: 'k', model: 'glm-4\nX-Header: 1', messages: [] }), /MODEL/);
  assert.throws(() => buildChatRequest({ providerId: 'glm', apiKey: 'k', model: 'x'.repeat(200), messages: [] }), /MODEL/);
  assert.throws(() => buildChatRequest({ providerId: 'glm', apiKey: 'k', baseUrl: 'http://glm.example.com', messages: [] }), /BASE_URL/);
});

test('buildChatRequest：没有 Key 就不出网（抛错，不发一次计费请求）', () => {
  assert.throws(() => buildChatRequest({ providerId: 'glm', apiKey: '', messages: [] }), /KEY/);
});

test('getProvider 认不出来的 id 一律落回默认厂商（不给任意字符串上计费接口的机会）', () => {
  assert.equal(getProvider('minimax').id, 'minimax');
  for (const junk of ['gpt', '', null, 'GLM', '../etc']) {
    assert.equal(getProvider(junk).id, DEFAULT_PROVIDER_ID, `junk=${junk}`);
  }
});
