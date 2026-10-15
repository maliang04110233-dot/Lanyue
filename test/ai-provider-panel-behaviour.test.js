/**
 * 共用厂商面板的行为测试 —— 真跑 src/renderer/js/aiProviderPanel.js。
 *
 * 与 test/ai-provider-ui.test.js 的分工：那枚钉的是**形状**（面板只有一处、令牌表只在
 * 面板、名单不镜像），这枚钉的是**跑起来的行为**：下拉到底长不出别的厂商、切厂商时发的
 * 是不是只有 {providerId}、留空的 Key 会不会把别家凭据抹掉、端点被拒时屏幕上那句是人话
 * 还是 BAD_BASE_URL:HTTPS_ONLY。这些只有真调用一遍才知道。
 *
 * 两条如实性来自"用真东西"而不是"仿一个"：
 *   · 下拉数据 = 真 providerConfig()，保存 = 真 applyConfigPatch()（都在主进程那一份
 *     登记表里），所以"Key 是合并不是覆盖"这条由产品代码自己成立，测试只观察结果；
 *   · 文案 = 同一份 zh.json，断言的是界面上那句话。
 * 套具同 smart-playlist-behaviour.test.js：fake-dom + loadView（本仓没有 jsdom）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { FakeEl, installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');
const { providerConfig, applyConfigPatch } = require('../src/api/aiProviders');

const PANEL = 'src/renderer/js/aiProviderPanel.js';
const zh = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lang', 'zh.json'), 'utf8'),
);

const IDS = ['aiProviderPanel', 'assistantProviderPanel', 'toastContainer'];

/** 词典占位符替换（与 i18n-stub 的 t() 同形，这里只需要单键） */
function say(key, vars) {
  let s = zh[key];
  assert.ok(typeof s === 'string', `zh 缺键 ${key}`);
  for (const [k, v] of Object.entries(vars || {})) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  return s;
}

/**
 * 给容器补上"节点身份"。
 *
 * fake-dom 每次 querySelector 现造一个伪元素、身份不保持（见其文件头），而面板恰好吃
 * 两件事：填进输入框的值、挂在按钮上的监听。所以这里按选择器缓存同一个对象，并在容器
 * 重写 innerHTML 时整批作废 —— 真 DOM 里 innerHTML 赋值就是换掉节点，输入框的值回落到
 * 新 markup 的 value 属性。漏掉这一步，「保存后输入框该显示新值」会假绿。
 */
function makeStable(host) {
  const cache = new Map();
  let html = '';
  Object.defineProperty(host, 'innerHTML', {
    configurable: true,
    get: () => html,
    set: (v) => {
      html = String(v);
      cache.clear();
    },
  });
  host.querySelector = (sel) => {
    if (cache.has(sel)) return cache.get(sel);
    const hit = FakeEl.prototype.querySelector.call(host, sel);
    if (!hit) throw new Error(`面板 markup 里查不到 ${sel}（类名换了会让"没渲染"伪装成"没找到"）`);
    const el = new FakeEl(hit.tagName);
    el._attrs = { ...hit._attrs };
    el._classes = new Set(hit._classes);
    el.value = hit.getAttribute('value') == null ? '' : String(hit.getAttribute('value'));
    cache.set(sel, el);
    return el;
  };
  return host;
}

/** 假 prefs：形状与真 prefs 一致（get 取值、set 返回 true 表示写成功） */
function makePrefs(seed = {}) {
  const store = {
    aiProvider: 'minimax',
    aiMusicApiKey: JSON.stringify({ minimax: 'sk-minimax-已有' }),
    ...seed,
  };
  return {
    store,
    get: (k) => store[k],
    set: (k, v) => {
      store[k] = v;
      return true;
    },
  };
}

async function fresh(opts = {}) {
  const prefs = makePrefs(opts.prefs);
  const calls = { config: 0, save: [] };
  const dom = installBrowserGlobals({
    ids: IDS,
    extraGlobals: {
      api: {
        aiProviderConfig: async () => {
          calls.config += 1;
          if (opts.configFails) throw new Error('channel down');
          return providerConfig(prefs.get);
        },
        aiProviderSave: async (patch) => {
          calls.save.push(patch);
          return applyConfigPatch(patch, prefs.get, prefs.set);
        },
      },
    },
  });
  const mod = await loadView(PANEL, dom);
  const host = makeStable(dom.element('aiProviderPanel'));
  const other = makeStable(dom.element('assistantProviderPanel'));
  const toasts = () => dom.element('toastContainer').children.map((c) => c.textContent);
  const options = () => [...host.innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)]
    .map((m) => ({ value: m[1], label: m[2] }));
  return { mod, dom, calls, prefs, host, other, toasts, options };
}

/** 面板真实挂载路径：视图在 DOMContentLoaded 里调的就是这个 */
async function mount(h, opts) {
  return h.mod.mountProviderPanel(h.host, opts);
}

test('挂载：下拉的每一项都来自通道，一个不多一个不少（界面侧没有地方镜像名单）', async () => {
  const h = await fresh();
  const cfg = await mount(h);
  assert.strictEqual(h.calls.config, 1);
  assert.deepStrictEqual(
    h.options(),
    cfg.providers.map((p) => ({ value: p.id, label: p.label })),
    'option 集合必须与通道给的一字不差');
  assert.ok(h.host.innerHTML.includes(`value="${cfg.current.providerId}" selected`),
    '当前厂商要带上 selected，否则回显的是第一项而不是真值');
  assert.ok(h.host.innerHTML.includes(say('ai.provider')), '标签走词典');
});

test('配置拉不到：容器里是词典那句「读取失败」，不是空白也不是把异常抛给页面', async () => {
  const h = await fresh({ configFails: true });
  const cfg = await mount(h);
  assert.strictEqual(cfg, null);
  assert.strictEqual(h.host.innerHTML.includes(say('ai.loadFailed')), true);
  assert.strictEqual(h.options().length, 0, '拉不到就不该有下拉');
});

test('两页共用同一份配置：第二次挂载不再打通道，各自画出一份控件', async () => {
  const h = await fresh();
  await mount(h);
  await h.mod.mountProviderPanel(h.other);
  assert.strictEqual(h.calls.config, 1, '全应用只该拉一次');
  assert.deepStrictEqual(
    [...h.other.innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    h.options().map((o) => o.value),
    '另一页画的必须是同一份名单');
});

test('切厂商：只发 {providerId}，成功回调到的配置是新厂商的', async () => {
  const h = await fresh();
  await mount(h);
  const sel = h.host.querySelector('.aip-select');
  sel.value = 'deepseek';
  await sel.dispatch('change');
  assert.deepStrictEqual(h.calls.save, [{ providerId: 'deepseek' }],
    '切厂商不该顺手把型号/端点/Key 一起发（空串会被当成"清空端点"写进 pref）');
  assert.strictEqual(h.prefs.store.aiProvider, 'deepseek');
  assert.strictEqual(h.prefs.store.aiProviderBaseUrl, undefined, '没填的端点不该被这次切换改动');
  const label = h.options().find((o) => o.value === 'deepseek').label;
  assert.ok(h.toasts().some((t) => t === say('ai.providerSwitched', { name: label })),
    '回执报的是通道给的那个名字，不是厂商 id');
});

test('切厂商后 onChange 收到新配置：音乐按钮据此置灰要读的是 supportsMusic', async () => {
  const h = await fresh();
  const got = [];
  await mount(h, { onChange: (cfg) => got.push(cfg) });
  assert.strictEqual(got.length, 1, '挂载即回调一次，页面不用等第一次保存');
  assert.strictEqual(got[0].supportsMusic, true, '默认 MiniMax 支持音乐合成');
  const sel = h.host.querySelector('.aip-select');
  sel.value = 'kimi';
  await sel.dispatch('change');
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[1].current.providerId, 'kimi');
  assert.strictEqual(got[1].supportsMusic, false, '换成纯文本厂商后 supportsMusic 必须落下来');
});

test('保存：发的是(型号, 端点)，Key 留空就不发 key —— 清空输入框不等于删凭据', async () => {
  const h = await fresh();
  await mount(h);
  h.host.querySelector('.aip-model').value = ' deepseek-chat ';
  h.host.querySelector('.aip-baseurl').value = 'https://mirror.example.com/v1';
  await h.host.querySelector('.aip-save').dispatch('click');
  assert.deepStrictEqual(h.calls.save, [{ model: 'deepseek-chat', baseUrl: 'https://mirror.example.com/v1' }],
    '留空的 Key 不该出现在补丁里（更不能带 null，那是删除指令）');
  assert.strictEqual(h.prefs.store.aiProviderModel, 'deepseek-chat');
  assert.strictEqual(h.prefs.store.aiProviderBaseUrl, 'https://mirror.example.com/v1');
  assert.strictEqual(h.prefs.store.aiMusicApiKey, JSON.stringify({ minimax: 'sk-minimax-已有' }),
    '没碰 Key 框 = 一把映射原封不动');
  assert.ok(h.toasts().some((t) => t === say('ai.saved')));
});

test('保存成功后重画：输入框显示的是主进程回来的值，不是用户刚敲的那串', async () => {
  const h = await fresh();
  await mount(h);
  const model = h.host.querySelector('.aip-model');
  model.value = 'deepseek-chat';
  await h.host.querySelector('.aip-save').dispatch('click');
  assert.strictEqual(h.host.querySelector('.aip-model').value, 'deepseek-chat');
  assert.strictEqual(h.options().length > 0, true, '重画后名单仍是通道那份');
  assert.ok(/aip-key/.test(h.host.innerHTML), 'Key 框重画后回到空白（面板不持有 Key 本体）');
  assert.strictEqual(h.host.innerHTML.includes('sk-minimax'), false, '凭据不许出现在 markup 里');
});

test('填了 Key：带的是 {vendorId,value}，写进 pref 的是合并后的映射', async () => {
  const h = await fresh();
  await mount(h);
  const sel = h.host.querySelector('.aip-select');
  sel.value = 'deepseek';
  await sel.dispatch('change');
  h.host.querySelector('.aip-key').value = 'sk-deepseek-新配的';
  await h.host.querySelector('.aip-save').dispatch('click');
  const patch = h.calls.save[1];
  assert.deepStrictEqual(patch.key, { vendorId: 'deepseek', value: 'sk-deepseek-新配的' },
    'vendorId 必须是当前厂商：把 Key 记到别家名下会静默存错凭据');
  assert.deepStrictEqual(JSON.parse(h.prefs.store.aiMusicApiKey),
    { minimax: 'sk-minimax-已有', deepseek: 'sk-deepseek-新配的' },
    '覆盖式写法会抹掉 MiniMax 那把 —— 那是用户数据丢失');
});

test('端点不合法：屏幕上是人话，不是 BAD_BASE_URL:HTTPS_ONLY', async () => {
  const h = await fresh();
  await mount(h);
  h.host.querySelector('.aip-baseurl').value = 'http://insecure.example.com';
  await h.host.querySelector('.aip-save').dispatch('click');
  const line = h.toasts()[0];
  assert.strictEqual(line, say('ai.saveFailed', { msg: say('ai.errBaseUrl', { code: 'HTTPS_ONLY' }) }));
  assert.strictEqual(line.includes('BAD_BASE_URL'), false, '主进程码表不许原样印给用户');
  assert.strictEqual(h.prefs.store.aiProviderBaseUrl, undefined, '被拒的补丁一个字都不该落盘');
});

test('认不出的厂商（下拉被人改了）：回的是 UNKNOWN_PROVIDER 那句，当前厂商不动', async () => {
  const h = await fresh();
  await mount(h);
  const sel = h.host.querySelector('.aip-select');
  sel.value = 'not-a-vendor';
  await sel.dispatch('change');
  assert.ok(h.toasts().some((t) => t.includes(say('ai.errUnknownProvider'))));
  assert.strictEqual(h.prefs.store.aiProvider, 'minimax');
});

test('纯文本厂商：面板上写明只提供文本，支持音乐的厂商不写这句', async () => {
  const h = await fresh();
  await mount(h);
  assert.strictEqual(h.host.innerHTML.includes(say('ai.textOnly')), false, 'MiniMax 支持音乐合成，不该提示');
  const sel = h.host.querySelector('.aip-select');
  sel.value = 'qwen';
  await sel.dispatch('change');
  assert.ok(h.host.innerHTML.includes(say('ai.textOnly')), '换成千问后要出现那句');
});
