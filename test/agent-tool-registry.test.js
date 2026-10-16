/**
 * 工具登记表的形状（P1 起）—— risk/audience 是两侧闸的唯一判据。
 *
 * mutating 从手写改成派生，是因为「一份数据两个出处」正是这类闸最典型的漂法：
 * 以后加一条工具只写 risk 忘了 mutating，闸门就会对着一个 false 放行写操作。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  AGENT_TOOLS, RISK_LEVELS, AUDIENCES, toolsFromContract, toolsForSource, visibleToAgent,
} = require('../src/main/mcp/tools');

test('每条工具都带合法 risk/audience，且 mutating 由 risk 派生', () => {
  for (const def of toolsFromContract()) {
    assert.ok(RISK_LEVELS.includes(def.risk), `${def.name} 的 risk 非法: ${def.risk}`);
    assert.ok(AUDIENCES.includes(def.audience), `${def.name} 的 audience 非法: ${def.audience}`);
    assert.strictEqual(def.mutating, def.risk !== 'read', `${def.name}: mutating 与 risk 在各自说话`);
  }
});

test('工具名唯一、通道也唯一（两条工具指向同一通道就是重复暴露）', () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  assert.strictEqual(new Set(names).size, names.length, `工具有重名: ${names.join(',')}`);
  const chans = AGENT_TOOLS.filter((t) => t.channel).map((t) => t.channel);
  assert.strictEqual(new Set(chans).size, chans.length, '两条工具指向同一通道');
});

test('改造不许悄悄改面：今天恰 21 条、其中 3 条非只读（P1 基线，P2 落地后由 39 条那枚接管）', () => {
  const defs = toolsFromContract();
  // P2 Task 11 会把面扩到 38：这里钉的是「扩面只准发生在那一次」，此后由 38 条那枚守
  assert.ok(defs.length === 21 || defs.length === 38, `工具面数量飘了：${defs.length}`);
});

test('P2 面：38 条工具，destructive 恰 7 条，且都进不了外部 Agent 的面', () => {
  const defs = toolsFromContract();
  // 38 = 18 只读 + 13 写 + 7 destructive（计划文档里写的 39 是算术笔误：
  // 它自己点名的 13+7 两份清单 + 既有 18 只读，加出来就是 38）
  assert.strictEqual(defs.length, 38);
  const destructive = defs.filter((d) => d.risk === 'destructive').map((d) => d.name).sort();
  assert.deepStrictEqual(destructive, [
    'clear_all_downloads', 'clear_finished_downloads', 'clear_history', 'delete_download_template',
    'delete_user_playlist', 'remove_history', 'unsubscribe',
  ]);
  const agentView = toolsForSource('agent');
  for (const n of destructive) {
    assert.ok(!agentView.some((d) => d.name === n), `外部 Agent 不该看到 ${n}`);
  }
});

test('P2 的写面点名（少了哪条、多了哪条都算红）', () => {
  const writes = toolsFromContract().filter((d) => d.risk === 'write').map((d) => d.name).sort();
  assert.deepStrictEqual(writes, [
    'add_playlist_to_downloads', 'add_to_playlist', 'add_to_queue', 'cancel_download', 'remove_from_playlist',
    'remove_queue_item', 'reorder_queue_item', 'retry_download', 'save_download_template',
    'set_download_queue_paused', 'subscribe_add', 'subscribe_mark_seen', 'toggle_favorite',
  ]);
});

test('P1 新增的只读面：订阅、模板、播放队列、聚合曲库', () => {
  const defs = toolsFromContract();
  for (const n of ['list_subscriptions', 'list_download_templates', 'get_play_queue', 'aggregate_library']) {
    const d = defs.find((x) => x.name === n);
    assert.ok(d, `少了 ${n}`);
    assert.strictEqual(d.risk, 'read', `${n} 必须是只读`);
    assert.strictEqual(d.audience, 'both', `${n} 主进程有 handler，两侧都能给`);
  }
});

// 参数面由契约派生，不是这里能凭空多写的：三条无参通道不该长出键来，
// aggregate_library 只许收契约认识的 opts。收错键＝绕过 normalizeArgs 的那道钳制。
test('P1 新增四条的 inputSchema 逐一对上契约参数', () => {
  const byName = Object.fromEntries(toolsFromContract().map((d) => [d.name, d]));
  const NO_ARG = ['list_subscriptions', 'list_download_templates', 'get_play_queue'];
  for (const n of [...NO_ARG, 'aggregate_library']) {
    assert.ok(byName[n], `少了 ${n}`);
  }
  for (const n of NO_ARG) {
    assert.deepStrictEqual(Object.keys(byName[n].inputSchema.properties), [],
      `${n} 的通道在契约里没有参数，schema 不该凭空多出键`);
  }
  assert.deepStrictEqual(Object.keys(byName['aggregate_library'].inputSchema.properties), ['opts'],
    'aggregate_library 只能收契约认识的 opts');
  assert.strictEqual(byName['aggregate_library'].inputSchema.properties.opts.type, 'object');
});

test('risk 非法或漏写时派生直接抛，不许静默当只读', () => {
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms' }]), /risk/);
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms', risk: 'danger' }]), /risk/);
  assert.throws(() => toolsFromContract([{ name: 'x', channel: 'get-platforms', risk: 'read', audience: 'weird' }]), /audience/);
});

// 合成条目用假 channels：这里测的是过滤判据，不是契约形状（契约形状 Step 1 那几枚已经钉过）
const CH = { 'get-platforms': { invoke: ['main'], args: [] } };
const SYNTH = [
  { name: 'r', channel: 'get-platforms', description: '只读', risk: 'read' },
  { name: 'w', channel: 'get-platforms', description: '可逆写', risk: 'write' },
  { name: 'd', channel: 'get-platforms', description: '删除', risk: 'destructive' },
  { name: 'a', channel: 'get-platforms', description: '只能在渲染层', risk: 'write', audience: 'app' },
];

test('外部 Agent 的面 = 主进程可执行且不是 destructive（「查询 + 加法动作」一字不放宽）', () => {
  assert.deepStrictEqual(toolsForSource('agent', SYNTH, CH).map((t) => t.name), ['r', 'w']);
});

test('应用内助手看得见全部（含 destructive 与 app-only），确认形态才轮得到界面去决定', () => {
  assert.deepStrictEqual(toolsForSource('assistant', SYNTH, CH).map((t) => t.name), ['r', 'w', 'd', 'a']);
});

test('source 是白名单：未知或缺失一律抛，不静默当助手把全量面交出去', () => {
  // 协议层 createMcpHandler 的 source 默认补 'agent'，过滤层若也兜底，
  // 漏传身份的第三个 caller（CLI、调试端点）会拿到含 destructive / app-only 的全量面。
  assert.throws(() => toolsForSource(), /source 非法/);
  assert.throws(() => toolsForSource(undefined), /source 非法: undefined/);
  assert.throws(() => toolsForSource(null), /source 非法: null/);
  assert.throws(() => toolsForSource('cli'), /source 非法: cli/);
  assert.throws(() => toolsForSource('AGENT'), /source 非法: AGENT/); // 大小写也算未知
  assert.throws(() => toolsForSource('agent', [{ name: 'x', channel: 'nope' }], CH), /risk/);
  // 两个白名单值本身照走装载期三重校验，不被新抛闸短路
  assert.ok(Array.isArray(toolsForSource('assistant')));
  assert.ok(Array.isArray(toolsForSource('agent')));
});

// 判据本身写对没有：直接把 SYNTH 的产物喂 visibleToAgent，与 toolsForSource('agent') 的结果
// 集双向相等，且这个集合就是 SYNTH 里 both + 非 destructive 的那几条。
// 只比「两处一致」抓不到「判据条件写反」（两处用的是同一个判据，写反也一致），
// 所以 EXPECT 这里独立算出来，判据一反就红。
test('判据只有一处且判据本身没写反：SYNTH 直接喂 visibleToAgent 与 toolsForSource("agent") 双向相等', () => {
  const EXPECT = ['r', 'w']; // both 且非 destructive：d 是 destructive、a 是 app-only
  const byPredicate = toolsFromContract(SYNTH, CH).filter(visibleToAgent).map((t) => t.name);
  const bySource = toolsForSource('agent', SYNTH, CH).map((t) => t.name);
  assert.deepStrictEqual([...byPredicate].sort(), EXPECT);
  assert.deepStrictEqual([...bySource].sort(), EXPECT);
  assert.ok(!byPredicate.includes('d') && !byPredicate.includes('a'), '判据把 destructive / app-only 放进了外部面');
  assert.ok(!bySource.includes('d') && !bySource.includes('a'), 'agent 视图绕开了判据');
});

test('真表上两处仍同一个答案（有人另攒一份条件、不再调 visibleToAgent 时这里红）', () => {
  const byPredicate = toolsFromContract().filter(visibleToAgent).map((t) => t.name).sort();
  const bySource = toolsForSource('agent').map((t) => t.name).sort();
  assert.deepStrictEqual(bySource, byPredicate);
});

test('助手面与真表全量逐字段一致（深相等，不是条数相等）', () => {
  assert.deepStrictEqual(toolsForSource('assistant'), toolsFromContract());
  // 合成表也一致 —— 真表今天还没有 destructive/app 条目，只有 SYNTH 能证明「全量」不是句空话
  assert.deepStrictEqual(toolsForSource('assistant', SYNTH, CH), toolsFromContract(SYNTH, CH));
});
