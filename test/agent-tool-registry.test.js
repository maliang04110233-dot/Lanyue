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

test('改造不许悄悄改面：今天恰 17 条、其中 3 条非只读', () => {
  const defs = toolsFromContract();
  assert.strictEqual(defs.length, 17);
  assert.deepStrictEqual(defs.filter((d) => d.mutating).map((d) => d.name).sort(),
    ['add_to_playlist', 'add_to_queue', 'toggle_favorite']);
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
