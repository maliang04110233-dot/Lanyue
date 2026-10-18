/**
 * agent 循环的行为：批准形态、预算、止损。
 *
 * 每条都从 invoke 实际收到的参数反查 —— 测的是「界面到底把什么交给了主进程」，
 * 不是「界面看起来怎么样」。批量令牌与单项令牌如果发错，主进程那道闸拦得住用户，
 * 但拦不住「界面以为批过了」的静默丢步骤，所以这里必须有牙齿。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, SONG } = require('./helpers/assistant-boot');

const TOOLS = [
  { name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' },
  { name: 'add_to_queue', description: '加入下载队列', mutating: true, risk: 'write', audience: 'both' },
  { name: 'clear_all_queue', description: '清空下载队列', mutating: true, risk: 'destructive', audience: 'both' },
  { name: 'list_platforms', description: '平台清单', mutating: false, risk: 'read', audience: 'both' },
];

const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
/**
 * 找到卡上那个按钮并点它。卡片还没出现就等几帧；真没有就返回 false（调用方据此停手），
 * 不在这里 assert —— 预算/止损那两条循环里「卡片不再出现」正是收束的信号，不该判红。
 */
async function decide(dom, kind) {
  for (let k = 0; k < 20; k++) {
    const log = dom.element('assistantLog');
    const card = log.children[log.children.length - 1];
    const btn = card && walk(card).find((n) => n.dataset && n.dataset.asstDecide === kind);
    if (btn && !btn.disabled) { await btn.dispatch('click'); return true; }
    await tickOnce();
  }
  return false;
}
function tickOnce() { return new Promise((r) => setTimeout(r, 0)); }

/** 反复批卡片直到循环收束（或超步数）。收束的判据是 sendAssistant 的 Promise 落地。 */
async function drive(h, kind) {
  for (let i = 0; i < 60 && !h.settled(); i += 1) {
    await decide(h.dom, kind);
    await h.tick(2);
  }
}

test('整份计划一次批准：write 步骤拿到的 scope 是 batch，且全程只问一次', async () => {
  const calls = [];
  const h = await boot({ playQueue: [SONG('q1', '晚风')] }, {
    tools: TOOLS,
    // 第一轮给计划，第二轮收尾（模型对结果满意不再动手）——否则循环会等第二次批准
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}},"why":"入队"},{"tool":"list_platforms","args":{}}]}'
      : '{"reply":"都办好了","steps":[]}',
    tool: (st, c, args) => { calls.push({ name: args[0], confirmed: args[2], scope: args[3], runId: args[4] }); return { ok: true, text: '{"songs":[]}' }; },
  });
  const p = h.sendAssistant('把这首加进下载队列');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'approve'), '计划卡上找不到 approve 按钮');
  await p;
  assert.strictEqual(calls.filter((c) => c.name === 'add_to_queue').length, 1);
  assert.strictEqual(calls[0].scope, 'batch', '批确认那步该发 batch');
  assert.strictEqual(calls[0].confirmed, true);
  assert.ok(calls[0].runId, 'runId 必须带上，审计才能把一整轮串起来');
});

test('取消：一步都不执行，且这一轮不再问第二次', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}}}]}',
    tool: (st, c, args) => { calls.push(args); return { ok: true, text: '{}' }; },
  });
  const p = h.sendAssistant('随便做点');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'cancel'), '计划卡上找不到 cancel 按钮');
  await p;
  assert.deepStrictEqual(calls, [], '取消后不该有任何工具调用');
});

test('只跑只读那几步：非只读步骤一条都不发，只读的照发', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"add_to_queue","args":{"song":{"id":"1"}}},{"tool":"list_platforms","args":{}}]}'
      : '{"reply":"好了","steps":[]}',
    tool: (st, c, args) => { calls.push({ name: args[0], confirmed: args[2], scope: args[3] }); return { ok: true, text: '{}' }; },
  });
  const p = h.sendAssistant('看看有什么平台');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'readOnly'), '计划卡上找不到 readOnly 按钮');
  await p;
  assert.deepStrictEqual(calls.map((c) => c.name), ['list_platforms']);
});

test('destructive 即使在批确认里也单独弹，且发出的 scope 是 single', async () => {
  const calls = [];
  const h = await boot({}, {
    tools: TOOLS,
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"clear_all_queue","args":{}}]}'
      : '{"reply":"清好了","steps":[]}',
    tool: (st, c, args) => { calls.push({ name: args[0], confirmed: args[2], scope: args[3] }); return { ok: true, text: '{}' }; },
    confirm: () => true,
  });
  const p = h.sendAssistant('把下载队列清空');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'approve'), '计划卡上找不到 approve 按钮');
  await p;
  assert.deepStrictEqual(calls[0], { name: 'clear_all_queue', confirmed: true, scope: 'single' });
  assert.strictEqual(h.confirms, 1, '危险步骤该且只该弹一次模态确认');
});

test('整局预算：到了 MAX_RUN_CALLS 就停，并把停的原因上屏', async () => {
  // 每回合塞满协议上限（8 步只读），6 回合理论 48 次 —— 必须被 MAX_RUN_CALLS=24 截停
  const eight = Array.from({ length: 8 }, () => ({ tool: 'list_platforms', args: {} }));
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => JSON.stringify({ reply: '再来一轮', steps: eight }),
    tool: () => ({ ok: true, text: '{}' }),
  });
  const p = h.sendAssistant('一直查');
  await h.tick(3);
  await drive(h, 'approve');
  await p;
  assert.ok(h.calls.tool.length <= 24, `整局调用数越界: ${h.calls.tool.length}`);
  const texts = h.dom.element('assistantLog').children.map((c) => c.textContent);
  assert.ok(texts.some((x) => /上限/.test(x)), '停在预算上要有一句人话');
});

test('止损：同一步连续失败两次就不再试它，把错误摊给用户', async () => {
  let n = 0;
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => '{"reply":"再试","steps":[{"tool":"list_platforms","args":{}}]}',
    tool: () => { n += 1; return { ok: false, error: 'TOOL_FAILED', text: 'boom' }; },
  });
  const p = h.sendAssistant('查平台');
  await h.tick(3);
  await drive(h, 'approve');
  await p;
  assert.strictEqual(n, 2, `同一步只该被试到第 2 次就止损，实得 ${n}`);
});

test('app 工具不发 IPC：播放控制走渲染层自己的全局函数', async () => {
  const seen = { ipc: [], play: 0, vol: null };
  const h = await boot({}, {
    tools: [{ name: 'play_toggle', description: '播放/暂停', mutating: true, risk: 'write', audience: 'app', action: 'play.toggle' },
      { name: 'set_play_volume', description: '设音量', mutating: true, risk: 'write', audience: 'app', action: 'play.volume' }],
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"play_toggle","args":{}},{"tool":"set_play_volume","args":{"value":30}}]}'
      : '{"reply":"好了","steps":[]}',
    tool: (st, c, args) => { seen.ipc.push(args); return { ok: true, text: '{}' }; },
    extraGlobalsHook: (g) => { g.togglePlay = () => { seen.play += 1; }; g.setVolume = (v) => { seen.vol = v; }; },
  });
  const p = h.sendAssistant('暂停一下，音量调到 30');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'approve'), '计划卡上找不到 approve 按钮');
  await p;
  assert.deepStrictEqual(seen.ipc, [], 'app 工具一条 IPC 都不该发（主进程帮不上）');
  assert.strictEqual(seen.play, 1);
  assert.strictEqual(seen.vol, 30);
});

test('渲染层没有那个函数时如实报错，不许静默当成功', async () => {
  const h = await boot({}, {
    tools: [{ name: 'play_next', description: '下一首', mutating: true, risk: 'write', audience: 'app', action: 'play.next' }],
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"play_next","args":{}}]}'
      : '{"reply":"好了","steps":[]}',
    tool: () => ({ ok: true, text: '{}' }),
    // 不装 window.nextSong —— 真应用里它也可能在别的页面尚未注册，那种时候必须报失败
  });
  const p = h.sendAssistant('下一首');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'approve'), '计划卡上找不到 approve 按钮');
  await p;
  const texts = h.dom.element('assistantLog').children.map((c) => c.textContent);
  assert.ok(texts.some((x) => /play_next/.test(x) && !/完成/.test(x)), '该有一条失败上屏而不是假绿');
});

test('app 工具的观察结果里带上界内值：音量被钳到 0-100、序号越界不执行', async () => {
  const got = [];
  const h = await boot({}, {
    tools: [{ name: 'set_play_volume', description: '音量', mutating: true, risk: 'write', audience: 'app', action: 'play.volume' },
      { name: 'play_search_result', description: '播第 index 首', mutating: true, risk: 'write', audience: 'app', action: 'play.result' }],
    plan: (msgs, ctx, round) => round === 1
      ? '{"reply":"好","steps":[{"tool":"set_play_volume","args":{"value":900}},{"tool":"play_search_result","args":{"index":0}}]}'
      : '{"reply":"好了","steps":[]}',
    tool: () => ({ ok: true, text: '{}' }),
    extraGlobalsHook: (g) => { g.setVolume = (v) => got.push(['vol', v]); g.playSong = (i) => got.push(['play', i]); },
  });
  const p = h.sendAssistant('音量 900，播第 0 首');
  await h.tick(3);
  assert.ok(await decide(h.dom, 'approve'), '计划卡上找不到 approve 按钮');
  await p;
  assert.deepStrictEqual(got, [['vol', 100]], '音量要钳到上限；序号 0（从 1 数）不该执行');
});
