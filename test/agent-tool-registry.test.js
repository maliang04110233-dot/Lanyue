/**
 * 工具登记表的形状（P1 起）—— risk/audience 是两侧闸的唯一判据。
 *
 * mutating 从手写改成派生，是因为「一份数据两个出处」正是这类闸最典型的漂法：
 * 以后加一条工具只写 risk 忘了 mutating，闸门就会对着一个 false 放行写操作。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AGENT_TOOLS, RISK_LEVELS, AUDIENCES, toolsFromContract } = require('../src/main/mcp/tools');

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
