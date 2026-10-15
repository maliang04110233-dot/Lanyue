/**
 * 厂商配置的可读写两侧（离线断言）
 *
 * 界面上那三个控件（厂商下拉 / 型号输入框 / 自定义端点）与 Key 输入框都不许
 * 自己攒判据：判据的家在 src/api/aiProviders.js，这里钉的就是那一家。
 * 之所以能在 node 下真跑（不需要 electron）：两侧都写成「给我 getter/setter，
 * 我自己不碰 prefs」—— 主进程那条 IPC 只是三行胶水。
 *
 * 三条最要紧的：
 *   ① 递给界面的包里绝不能出现 Key 本体（界面只需要知道"这家配过没有"）；
 *   ② 存 Key 是**合并**，不是覆盖 —— 直接 setPref('aiMusicApiKey', 新串) 会把
 *      别家已配好的凭据整包抹掉，那是用户数据丢失，不是显示问题；
 *   ③ 校验不过就一个字节都不写（半写状态最坏：下拉显示新厂商、存的还是旧的）。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  PROVIDERS, DEFAULT_PROVIDER_ID, PREF_KEYS,
  providerConfig, applyConfigPatch, validateModel,
} = require('../src/api/aiProviders');

/** 一份内存 prefs：get/set 都是纯读写，set 可被测试改成"写失败" */
function store(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; return true; },
    writes: [],
  };
}

/** 带 recorder 的 store：记录写入顺序，用来验「校验不过不写」 */
function tracked(initial = {}) {
  const s = store(initial);
  const writes = [];
  s.set = (k, v) => { writes.push([k, v]); s.data[k] = v; return true; };
  s.writes = writes;
  return s;
}

// ── 1. 型号形状 ─────────────────────────────────────────

test('validateModel：空=用该家推荐值，合法名放行，脏名与超长拒', () => {
  assert.equal(validateModel('').ok, true, '空串该放行（落回 defaultModel）');
  assert.equal(validateModel('  ').ok, true);
  assert.equal(validateModel('deepseek-chat').ok, true);
  assert.equal(validateModel('ep-20240711abcdef0123456789-7d9f2').ok, true, '方舟接入点 ID 必须是合法形态');
  for (const bad of ['glm-4\nX-Header: 1', 'glm 4', 'qwen"plus', '<script>', 'x'.repeat(121)]) {
    assert.equal(validateModel(bad).ok, false, `该拒的没拒: ${JSON.stringify(bad.slice(0, 20))}`);
    assert.equal(validateModel(bad).reason, 'SHAPE');
  }
});

// ── 2. 读侧：界面拿到的包 ────────────────────────────────

test('providerConfig：下拉要的信息一枚不少（id/名称/推荐型号/能不能合成音乐/去哪拿 Key）', () => {
  const cfg = providerConfig(() => undefined);
  assert.ok(Array.isArray(cfg.providers) && cfg.providers.length >= 7);
  for (const p of cfg.providers) {
    for (const field of ['id', 'label', 'defaultModel', 'models', 'music', 'keyUrl']) {
      assert.ok(field in p, `${p.id} 缺 ${field}`);
    }
  }
  assert.equal(cfg.providers[0].id, DEFAULT_PROVIDER_ID, '下拉首项应是默认厂商');
  assert.equal(cfg.providers.find((p) => p.id === 'minimax').music, true);
  assert.equal(cfg.providers.filter((p) => p.music).length, 1, '只有 MiniMax 能合成音乐');
});

test('providerConfig：没配任何 Key 时 keys 全 false，且不报错（首次启动是空盘）', () => {
  const cfg = providerConfig(() => undefined);
  assert.equal(cfg.current.hasKey, false);
  assert.equal(cfg.supportsMusic, true, '默认厂商是 MiniMax');
  for (const p of cfg.providers) {
    assert.equal(cfg.keys[p.id], false, `${p.id} 没配 Key 却报了 true`);
  }
});

test('providerConfig：老版裸串 Key 仍认作 MiniMax 的（升级不许把用户的 Key 判成没了）', () => {
  const cfg = providerConfig((k) => (k === PREF_KEYS.apiKey ? 'sk-legacy-plain' : undefined));
  assert.equal(cfg.current.hasKey, true);
  assert.equal(cfg.keys.minimax, true);
  assert.equal(cfg.keys.deepseek, false);
});

test('providerConfig：只把"配过没配过"递给界面，Key 本体一个字符都不许上屏', () => {
  const raw = JSON.stringify({ minimax: 'sk-M-secret', deepseek: 'sk-D-secret' });
  const cfg = providerConfig((k) => (k === PREF_KEYS.apiKey ? raw : undefined));
  const dumped = JSON.stringify(cfg);
  assert.ok(!dumped.includes('sk-'), 'Key 漏进了给渲染层的配置包');
  assert.equal(cfg.keys.minimax, true);
  assert.equal(cfg.keys.deepseek, true);
  assert.equal(cfg.current.providerId, 'minimax');
});

test('providerConfig：当前厂商/型号/端点回填自 prefs，型号没存过时给该家推荐值', () => {
  const cfg = providerConfig((k) => ({
    aiProvider: 'glm', aiProviderModel: '', aiProviderBaseUrl: '', [PREF_KEYS.apiKey]: '{}'
  }[k]));
  assert.equal(cfg.current.providerId, 'glm');
  assert.equal(cfg.current.model, 'glm-4-flash');
});

test('providerConfig：型号存过就用存过的（用户改的型号不许被推荐值盖掉）', () => {
  const cfg = providerConfig((k) => (k === PREF_KEYS.model ? 'qwen-max' : undefined));
  assert.equal(cfg.current.model, 'qwen-max');
});

test('providerConfig：认不出来的厂商串落回默认家（脏 pref 不该让界面画出一个空下拉）', () => {
  const cfg = providerConfig((k) => (k === PREF_KEYS.provider ? 'gpt-4' : undefined));
  assert.equal(cfg.current.providerId, DEFAULT_PROVIDER_ID);
});

// ── 3. 写侧：一次保存 ───────────────────────────────────

test('applyConfigPatch：只换厂商，别的东西不顺手写', () => {
  const s = tracked({ [PREF_KEYS.apiKey]: JSON.stringify({ minimax: 'sk-M', deepseek: 'sk-D' }) });
  const r = applyConfigPatch({ providerId: 'deepseek' }, s.get, s.set);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(s.writes.map((w) => w[0]), ['aiProvider']);
  assert.equal(s.data.aiProvider, 'deepseek');
  assert.equal(r.config.current.providerId, 'deepseek');
  assert.equal(r.config.supportsMusic, false, '选了非 MiniMax，音乐合成就该关着');
});

test('applyConfigPatch：存 Key 是合并 —— 给了新 Key 的那家变，其余原样留着', () => {
  const before = { minimax: 'sk-M', kimi: 'sk-K' };
  const s = tracked({ [PREF_KEYS.apiKey]: JSON.stringify(before) });
  const r = applyConfigPatch({ providerId: 'deepseek', key: { vendorId: 'deepseek', value: 'sk-D' } }, s.get, s.set);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const after = JSON.parse(s.data[PREF_KEYS.apiKey]);
  assert.deepEqual(after, { minimax: 'sk-M', kimi: 'sk-K', deepseek: 'sk-D' });
});

test('applyConfigPatch：老版裸串第一次加别家 Key 时，原串归位成 MiniMax 的而不是丢掉', () => {
  const s = tracked({ [PREF_KEYS.apiKey]: 'sk-legacy' });
  const r = applyConfigPatch({ key: { vendorId: 'glm', value: 'sk-G' } }, s.get, s.set);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(JSON.parse(s.data[PREF_KEYS.apiKey]), { minimax: 'sk-legacy', glm: 'sk-G' });
});

test('applyConfigPatch：Key 留空 = 不动它（清空输入框不该把配好的凭据抹了）', () => {
  const s = tracked({ [PREF_KEYS.apiKey]: JSON.stringify({ minimax: 'sk-M' }) });
  const r = applyConfigPatch({ providerId: 'minimax', key: { vendorId: 'minimax', value: '   ' } }, s.get, s.set);
  assert.equal(r.ok, true);
  assert.equal(s.data[PREF_KEYS.apiKey], JSON.stringify({ minimax: 'sk-M' }));
});

test('applyConfigPatch：显式清空才删该家；全删空后写回空串，让 NO_KEY 判据照旧成立', () => {
  const s = tracked({ [PREF_KEYS.apiKey]: JSON.stringify({ minimax: 'sk-M', kimi: 'sk-K' }) });
  applyConfigPatch({ key: { vendorId: 'kimi', value: null } }, s.get, s.set);
  assert.deepEqual(JSON.parse(s.data[PREF_KEYS.apiKey]), { minimax: 'sk-M' });
  applyConfigPatch({ key: { vendorId: 'minimax', value: null } }, s.get, s.set);
  assert.equal(s.data[PREF_KEYS.apiKey], '', '空映射要写成空串，不能留一个 "{}" 让别处 JSON.parse 出意外');
});

test('applyConfigPatch：坏端点整个拒掉，一个字节都不写（不许半写状态）', () => {
  for (const bad of ['http://glm.example.com', 'ftp://x', 'https://user:pass@g.example.com', 'not a url']) {
    const s = tracked({});
    const r = applyConfigPatch({ providerId: 'glm', baseUrl: bad }, s.get, s.set);
    assert.equal(r.ok, false, `本该拒却放行: ${bad}`);
    assert.match(r.error, /^BAD_BASE_URL:/);
    assert.deepEqual(s.writes, [], `校验失败还写了盘: ${bad}`);
  }
});

test('applyConfigPatch：端点填空白等于「留空用厂商默认」，按清除处理而不是报错', () => {
  const s = tracked({ aiProviderBaseUrl: 'https://my-gw.example.com' });
  const r = applyConfigPatch({ baseUrl: '   ' }, s.get, s.set);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(s.data.aiProviderBaseUrl, '');
  assert.equal(r.config.current.baseUrl, '');
});

test('applyConfigPatch：坏型号照样整笔拒（Key 也不许先写进去）', () => {
  const s = tracked({});
  const r = applyConfigPatch({ model: 'glm 4\nX: 1', key: { vendorId: 'glm', value: 'sk-G' } }, s.get, s.set);
  assert.equal(r.ok, false);
  assert.match(r.error, /^BAD_MODEL:/);
  assert.deepEqual(s.writes, []);
});

test('applyConfigPatch：不在名单里的厂商 id 直接拒（不给任意字符串进 prefs 的机会）', () => {
  for (const junk of ['gpt', 'GLM', 'minimax ']) {
    const s = tracked({});
    const r = applyConfigPatch({ providerId: junk }, s.get, s.set);
    assert.equal(r.ok, false, `junk=${junk}`);
    assert.equal(r.error, 'UNKNOWN_PROVIDER');
    assert.deepEqual(s.writes, []);
  }
});

test('applyConfigPatch：写盘失败（安全存储不可用）不许谎报已保存', () => {
  const s = store({});
  s.set = () => false;
  const r = applyConfigPatch({ key: { vendorId: 'glm', value: 'sk-G' } }, s.get, s.set);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'PREF_WRITE_FAILED');
});

test('applyConfigPatch：型号留空即清除该 pref，读侧随后落回该家推荐值', () => {
  const s = tracked({ aiProviderModel: 'deepseek-reasoner' });
  const r = applyConfigPatch({ providerId: 'deepseek', model: '' }, s.get, s.set);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(s.data.aiProviderModel, '');
  assert.equal(r.config.current.model, 'deepseek-chat');
});

test('applyConfigPatch：空 patch 不写任何东西也回一份当前配置', () => {
  const s = tracked({ aiProvider: 'kimi' });
  const r = applyConfigPatch({}, s.get, s.set);
  assert.equal(r.ok, true);
  assert.deepEqual(s.writes, []);
  assert.equal(r.config.current.providerId, 'kimi');
});

test('登记表每家都带 label 与 keyUrl 字段（自定义端点没地方拿 Key，给空串而不是缺字段）', () => {
  for (const p of PROVIDERS) {
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.length > 0);
    assert.equal(typeof p.keyUrl, 'string', `${p.id} 的 keyUrl 字段缺失`);
  }
  assert.equal(PROVIDERS.find((p) => p.id === 'custom').keyUrl, '');
});
