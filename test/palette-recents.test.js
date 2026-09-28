/**
 * 命令面板「🕘 最近使用」—— paletteRecents.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

function fresh() {
  return import('../src/renderer/js/paletteRecents.js?tc=' + Math.random());
}

test('recordRecent：前置去重 + 封顶 + 脏入参兜底，不动原数组', async () => {
  const { recordRecent } = await fresh();
  assert.deepEqual(recordRecent([], 'a'), ['a']);
  assert.deepEqual(recordRecent(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepEqual(recordRecent(['b', 'a'], 'b'), ['b', 'a'], '已在最前保持');
  assert.deepEqual(recordRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'], '封顶掉最旧');
  assert.deepEqual(recordRecent(undefined, 'a'), ['a']);
  assert.deepEqual(recordRecent(['a'], null), ['a'], '无 id 不记但不清空');
  assert.deepEqual(recordRecent(['a'], 'a', 0), ['a'], 'cap 下限保护');
  const src = ['a', 'b'];
  recordRecent(src, 'c');
  assert.deepEqual(src, ['a', 'b'], '纯函数不产生副作用');
});

test('pickRecents：新→旧投影带组标，下架 id 静默跳过，不污染原命令', async () => {
  const { pickRecents } = await fresh();
  const cmds = [
    { id: 'a', label: 'A', group: '播放' },
    { id: 'b', label: 'B', group: '下载' },
    { id: 'a', label: 'dup', group: 'x' },
  ];
  const out = pickRecents(['b', 'ghost', 'a', 'b'], cmds);
  assert.deepEqual(out.map(c => c.id), ['b', 'a']);
  assert.equal(out[0].group, '🕘 最近');
  assert.equal(out[0].label, 'B', 'run/label 原样带过来');
  assert.equal(cmds[1].group, '下载', '浅拷贝不污染源命令表');
  assert.deepEqual(pickRecents(null, cmds), []);
  assert.deepEqual(pickRecents(['a'], undefined), []);
});

test('接线钉：import/localStorage 键/记录点/空查询置顶合并全部就位', () => {
  assert.match(PALETTE_JS, /import \{ recordRecent, pickRecents \} from '\.\/paletteRecents\.js';/);
  assert.match(PALETTE_JS, /const RECENTS_KEY = 'cmdkRecents';/);
  assert.match(PALETTE_JS, /localStorage\.getItem\(RECENTS_KEY\)/);
  assert.match(PALETTE_JS, /function _saveRecents\(list\) \{\n\s*try \{ localStorage\.setItem\(RECENTS_KEY, JSON\.stringify\(list\)\); \} catch/, '存储异常静默');
  assert.match(PALETTE_JS, /_saveRecents\(recordRecent\(_loadRecents\(\), cmd && cmd\.id\)\);\n {2}closeCommandPalette\(\);/, '执行即记录');
  assert.match(PALETTE_JS, /if \(!String\(query \|\| ''\)\.trim\(\)\) \{/, '仅空查询置顶');
  // 投影的是按总开关过滤后的那张表，不是原始 COMMANDS（否则关掉的命令会被"最近使用"复活）
  assert.match(PALETTE_JS, /const rec = pickRecents\(_loadRecents\(\), PALETTE_COMMANDS\);/);
  assert.match(PALETTE_JS, /_items = rec\.concat\(_items\.filter\(c => !taken\.has\(c\.id\)\)\)\.slice\(0, 30\);/, '去重合并保截断');
  // rankCommands 函数体保持纯净（合并只发生在 _refresh，不动打分排序语义）
  assert.match(PALETTE_JS, /out\.sort\(\(a, b\) => b\.score - a\.score\);\n {2}return out\.slice\(0, 30\)\.map\(x => x\.cmd\);\n\}/);
});
