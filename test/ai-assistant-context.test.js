/**
 * 助手「应用状态上下文」行为测试 —— 真跑视图模块（fake-dom + loadView，本仓无 jsdom）。
 *
 * 这枚测的是注入的**位置与时机**，service 那侧的拼装已由
 * test/ai-assistant-service.test.js 钉住。这里要抓住的是三种各自攒一份时才出现的事故：
 *   ① 状态塞进 _history —— 会被 trimHistory 削头、被 clearAssistant 当成聊天记录清掉；
 *   ② 开局拼一次就缓存 —— 助手自己 add_to_queue 之后拿旧快照回「队列里没有这首歌」；
 *   ③ 顺手把歌词/本地路径也带上 —— 那些不该出网。
 * 所以每条都从 invoke 实际收到的参数反查，不看源码正则。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { boot, send, SONG } = require('./helpers/assistant-boot');

/** 递归走一棵伪 DOM 子树（找计划卡上的决定按钮） */
const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };

test('上下文带正在播放、队列与搜索结果，且带 id（不然它只能再搜一遍）', async () => {
  const state = {
    currentPlaying: SONG('p0', '晚风'),
    playQueue: [SONG('q1', '早班车'), SONG('q2', '夜航')],
    playIdx: 1,
    currentKeyword: '轻快 中文 晨跑',
    songs: [SONG('s1', '晨光'), SONG('s2', '的风')],
  };
  const { calls, dom } = await boot(state);
  await send(dom, '再来一首类似的');

  const ctx = calls.plan[0].context;
  assert.ok(typeof ctx === 'string' && ctx, '第二参没递上状态');
  assert.ok(ctx.includes('晚风') && ctx.includes('id=p0'), '正在播放那首不在这段里');
  assert.ok(ctx.includes('第 2/2 首'), '队列指针没算对');
  assert.ok(ctx.includes('id=q2') && ctx.includes('id=s1'), '队列/搜索结果的 id 没带上');
  assert.ok(ctx.includes('轻快 中文 晨跑'), '搜索关键词没带上');
});

test('空状态也成行：三个空值各有一句，不留「段消失了」的歧义', async () => {
  const { calls, dom } = await boot({});
  await send(dom, '随便来一首');
  const ctx = calls.plan[0].context;
  assert.ok(ctx.includes('未在播放'), ctx);
  assert.ok(ctx.includes('队列为空'), ctx);
  assert.ok(ctx.includes('本会话还没搜过'), ctx);
});

/**
 * ②的牙齿：助手自己动过队列之后，第二回合的上下文必须是**改之后**的快照。
 * 让队列在工具执行回执里长出来（等价于 add_to_queue 落了地），两次 plan 收到的
 * context 因此必须不同 —— 开局拼一次缓存住的写法在这里就红。
 */
test('状态每回合现读：助手入队之后第二回合看到的是新歌', async () => {
  const state = {
    currentPlaying: null, playQueue: [SONG('q1', '早班车')], playIdx: 0,
    currentKeyword: '', songs: [],
  };
  const h = await boot(state, {
    plan: (messages, context, round) => (round === 1
      ? { ok: true, reply: '先看一眼', steps: [{ tool: 'search_music', args: { keyword: '夜' } }] }
      : { ok: true, reply: '都加进来了', steps: [] }),
    tool: (st) => { st.playQueue.push(SONG('q9', '新来的歌')); },
  });
  const { calls, dom } = h;
  const p = h.sendAssistant('把夜航加进队列');
  // 计划卡出现时点「批准」：sendAssistant 会等用户决定，不能裸 await（Task 10 起的行为）
  await h.tick(3);
  const log = dom.element('assistantLog');
  const card = log.children[log.children.length - 1];
  const btn = walk(card).find((n) => n.dataset && n.dataset.asstDecide === 'approve');
  assert.ok(btn, '计划卡上找不到 approve 按钮');
  btn.dispatch('click');
  await p;

  assert.strictEqual(calls.plan.length, 2, '应跑了两回合');
  assert.ok(!calls.plan[0].context.includes('新来的歌'), '第一回合不该已经看到后来入队的歌');
  assert.ok(calls.plan[1].context.includes('新来的歌'), '第二回合仍拿旧快照 = 开局拼一次缓存住了');
  assert.ok(calls.plan[1].context.includes('id=q9'), '新快照里该带上新歌的 id');
});

test('状态不进聊天记录：历史的头一条仍是用户原话，且不含状态段', async () => {
  const state = { currentPlaying: SONG('p0', '晚风'), playQueue: [], playIdx: -1, currentKeyword: '', songs: [] };
  const { calls, dom } = await boot(state);
  await send(dom, '你好');
  const msgs = calls.plan[0].messages;
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, '你好');
  assert.ok(!JSON.stringify(msgs).includes('正在播放'), '状态被塞进 _history 了');
});

test('歌词与本地路径不出网：状态段里只有标题/歌手/来源/id/音质', async () => {
  const state = {
    currentPlaying: SONG('p0', '晚风'),
    playQueue: [SONG('q1', '早班车')],
    playIdx: 0,
    currentKeyword: 'k',
    songs: [SONG('s1', '晨光')],
  };
  const { calls, dom } = await boot(state);
  await send(dom, '这首歌歌词');
  const ctx = calls.plan[0].context;
  assert.ok(!ctx.includes('LYRICS-LEAK'), '歌词进了提示');
  assert.ok(!ctx.includes('path-leak'), '本地路径进了提示');
  assert.ok(ctx.includes('音质=hires'), '正在播那首该带上音质');
});
