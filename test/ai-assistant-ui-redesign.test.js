/**
 * 助手页 UI 重构（2026-10-16）行为测试。
 *
 * 上一批 ai-assistant-ui / agent-loop / context 钉的是**接线纪律与循环语义**，
 * 这枚钉的是**重构后新增的界面行为**：气泡化、空态引导卡、快捷指令 chip、
 * busy 禁用、复制按钮、计划卡头部。都是「用户能点到的」这一层，不是源码正则。
 *
 * 沿用 fake-dom + loadView（本仓无 jsdom），从 assistant-boot 起台。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('./helpers/assistant-boot');

const ROOT = path.join(__dirname, '..');
const VIEW = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'views', 'ai-assistant.js'), 'utf8').replace(/\r\n/g, '\n');

const TOOLS = [
  { name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' },
  { name: 'add_to_queue', description: '加队列', mutating: true, risk: 'write', audience: 'both' },
];

const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };

test('空态：页面加载即渲染引导卡（标题 + 说明 + 快捷指令 chip）', async () => {
  const h = await boot({});
  const log = h.dom.element('assistantLog');
  const guide = walk(log).find((n) => n.className && n.className.includes('asst-empty-guide'));
  assert.ok(guide, '缺空态引导卡');
  const chips = walk(guide).filter((n) => n.className && n.className.includes('asst-quick-chip'));
  assert.strictEqual(chips.length, 3, `快捷指令 chip 应 3 枚，实得 ${chips.length}`);
  assert.ok(walk(guide).some((n) => n.className && n.className.includes('asst-empty')),
    '引导卡里还要保留原 .asst-empty 说明（清空后旧 ID 断言仍依赖它）');
});

test('快捷指令 chip 点击：把提示回填输入框（不自动发送）', async () => {
  const h = await boot({});
  const log = h.dom.element('assistantLog');
  const chip = walk(log).find((n) => n.className && n.className.includes('asst-quick-chip'));
  assert.ok(chip, '找不到快捷指令 chip');
  await chip.dispatch('click');
  const input = h.dom.element('assistantInput');
  assert.ok(input.value.length > 0, '输入框应被回填');
  assert.ok(h.calls.plan.length === 0, '点击 chip 不应直接发送');
});

test('busy 态：发送按钮与输入框同时禁用，回复后恢复', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => JSON.stringify({ reply: '好', steps: [] }),
  });
  const input = h.dom.element('assistantInput');
  const btn = h.dom.element('assistantSendBtn');
  // sendAssistant 是 async，但 _busy/disabled 在第一个 await 之前同步落地；
  // 此时断言才能抓到 busy 态（等 tick 的话整个回合已经跑完了）
  const p = h.sendAssistant('你好');
  assert.ok(btn.disabled, 'busy 时发送按钮应禁用');
  assert.ok(input.disabled, 'busy 时输入框应禁用');
  await p;
  assert.ok(!btn.disabled, '回复完成后发送按钮应恢复');
  assert.ok(!input.disabled, '回复完成后输入框应恢复');
});

test('气泡：用户消息与助手回复各自带上 asst-bubble-wrap 与角色类', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => JSON.stringify({ reply: '这就来', steps: [] }),
  });
  await h.sendAssistant('播一首');
  const log = h.dom.element('assistantLog');
  const bubbles = walk(log).filter((n) => n.className && n.className.includes('asst-bubble-wrap'));
  assert.ok(bubbles.length >= 2, `气泡至少 2 条（用户 + 助手），实得 ${bubbles.length}`);
  const user = bubbles.find((b) => b.className.includes('asst-user'));
  const ai = bubbles.find((b) => b.className.includes('asst-assistant'));
  assert.ok(user && ai, '应同时有用户侧与助手侧气泡');
  assert.ok(walk(log).some((n) => n.className && n.className.includes('asst-avatar')),
    '气泡应带头像');
});

test('复制按钮：点击后进入反馈态（已复制或复制失败），不依赖定时器', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => JSON.stringify({ reply: '这就来', steps: [] }),
  });
  await h.sendAssistant('播一首');
  const log = h.dom.element('assistantLog');
  const copyBtn = walk(log).find((n) => n.className === 'asst-copy');
  assert.ok(copyBtn, '助手气泡上应带复制按钮');
  copyBtn.dispatch('click');
  // _copyText 是 async：让出微任务让 handler 里的 await 落地再断言。
  // fake-dom 里没有 document.execCommand，会如实落到失败分支 —— 测的是「进入反馈态」，
  // 不是「一定复制成功」（浏览器里 navigator.clipboard 才是主路径）。
  await h.tick(3);
  const state = copyBtn.getAttribute('data-copied');
  assert.ok(state === '1' || state === 'fail', `复制后应进入反馈态，实得 data-copied=${state}`);
  // 反馈态用事件复位（不靠 setTimeout，避免挂住测试进程）：重新聚焦恢复「复制」
  copyBtn.dispatch('focus');
  assert.ok(!copyBtn.getAttribute('data-copied'), '重新聚焦后应恢复为「复制」');
});

test('计划卡：带卡头（标题 + 徽标计数）与 approve/readOnly/cancel 三级按钮', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: (msgs, ctx, round) => (round === 1
      ? JSON.stringify({
        reply: '计划',
        steps: [
          { tool: 'search_music', args: { keyword: 'a' } },
          { tool: 'add_to_queue', args: { keyword: 'a' } },
        ],
      })
      : JSON.stringify({ reply: '好', steps: [] })),
    tool: () => ({ ok: true, text: '{}' }),
  });
  const p = h.sendAssistant('搜并加');
  await h.tick(3);
  const log = h.dom.element('assistantLog');
  const card = log.children[log.children.length - 1];
  assert.ok(card && card.className && card.className.includes('asst-plan-card'), '计划卡应渲染');
  const head = walk(card).find((n) => n.className && n.className.includes('asst-plan-head'));
  assert.ok(head, '计划卡缺卡头');
  assert.ok(walk(card).some((n) => n.className && n.className.includes('asst-plan-head-badges')),
    '卡头缺风险徽标计数');
  for (const kind of ['approve', 'readOnly', 'cancel']) {
    const b = walk(card).find((n) => n.dataset && n.dataset.asstDecide === kind);
    assert.ok(b, `缺 ${kind} 按钮`);
  }
  // 批准收尾：否则 sendAssistant 挂在等用户决定，循环不结束、测试进程不退出
  const approve = walk(card).find((n) => n.dataset && n.dataset.asstDecide === 'approve');
  approve.dispatch('click');
  await p;
});

test('清空：恢复空态引导卡（不只清空 log）', async () => {
  const h = await boot({}, {
    tools: TOOLS,
    plan: () => JSON.stringify({ reply: '好', steps: [] }),
  });
  await h.sendAssistant('一条消息');
  globalThis.clearAssistant();
  const log = h.dom.element('assistantLog');
  const guide = walk(log).find((n) => n.className && n.className.includes('asst-empty-guide'));
  assert.ok(guide, '清空后应重新渲染空态引导卡');
});

test('重构未破坏安全红线：askConfirm 仍恰一处、innerHTML 无动态插值', () => {
  const calls = VIEW.match(/await\s+askConfirm\(/g) || [];
  assert.strictEqual(calls.length, 1, '重构后 askConfirm 应仍恰好一处');
  const bad = VIEW.split('\n').filter(l => /innerHTML\s*=/.test(l) && /\$\{/.test(l));
  assert.deepStrictEqual(bad, [], '重构后 innerHTML 仍禁止插动态文案');
});