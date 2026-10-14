/**
 * `src/api/services/modelJson.js` 的直接用例
 *
 * 三个消费方（助手回合 / 智能歌单 / 关键词改写）各自的用例都会路过这里，但它们只测自己那副判据；
 * 这份是配平扫描本体的钉子 —— 混合结构（对象里套数组、文本里既有对象又有数组）在三个消费方那儿
 * 都碰不到，而它恰恰是最容易在「顺手优化一下扫描器」时被改坏的一位。
 */

const test = require('node:test');
const assert = require('node:assert');

const { jsonCandidates, extractModelJson } = require('../src/api/services/modelJson');

test('候选扫描：顶层对象与顶层数组都收，嵌套的那层不单独成候选', () => {
  const cands = jsonCandidates('前言 {"a":[1,2],"b":{"c":3}} 中间 [4,5] 后记');
  assert.deepStrictEqual(cands, ['{"a":[1,2],"b":{"c":3}}', '[4,5]']);
});

test('候选扫描：字符串里的花括号、方括号与转义引号都不带偏', () => {
  const cands = jsonCandidates('说 "含 { 与 ] 和 \\" 的话" 然后 {"reply":"x"}');
  assert.deepStrictEqual(cands, ['{"reply":"x"}']);

  // 值里带 ] 的真数组照旧能被整段解析路径接住，这里是它作为候选的形状
  assert.deepStrictEqual(jsonCandidates('["a]b"]'), ['["a]b"]']);
});

test('取最后一个合形候选：改口之后的才是结论，判据不合形的往后退', () => {
  assert.deepStrictEqual(
    extractModelJson('{"picks":[1]}\n改一下 {"picks":[2,3]}'),
    { picks: [2, 3] });
  assert.deepStrictEqual(
    extractModelJson('["先给的"]\n再想想 ["b","c"]', Array.isArray),
    ['b', 'c']);

  // 最后一个是垃圾时退回前一个合形的，而不是返回 null
  assert.deepStrictEqual(
    extractModelJson('{"reply":"ok","steps":[]} 附带 {不是 JSON}',
      (o) => !!o && typeof o.reply === 'string'),
    { reply: 'ok', steps: [] });

  // 一个都不合形 → null（由调用方走自己的失败路径）
  assert.strictEqual(extractModelJson('配置 {a: 1} 和 [b', Array.isArray), null);
});

test('空/非字符串输入不成候选，也不抛', () => {
  assert.deepStrictEqual(jsonCandidates(null), []);
  assert.deepStrictEqual(jsonCandidates(''), []);
  assert.strictEqual(extractModelJson('   '), null);
});
