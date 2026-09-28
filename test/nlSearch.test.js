/**
 * 单元测试：自然语言搜索（AI_MUSIC_RESEARCH P0-A）
 *
 * 覆盖两层：
 *   1. ai-music.parseSearchQueries —— LLM 输出稳健解析（纯函数）
 *   2. nlSearchService.searchByPhrase —— 编排：改写→扇出→去重合并→兜底
 *
 * 不触网：LLM 与搜索都以假实现注入。
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseSearchQueries } = require('../src/api/ai-music');
const { searchByPhrase } = require('../src/api/services/nlSearchService');

// ── 1. parseSearchQueries ────────────────────────────

test('parse: 标准 JSON 数组直接解析', () => {
  assert.deepStrictEqual(parseSearchQueries('["周杰伦 晴天", "华语 跑步"]'), ['周杰伦 晴天', '华语 跑步']);
});

test('parse: 容忍 markdown 代码围栏与前后废话', () => {
  const text = '好的，以下是搜索关键词：\n```json\n["轻快 中文 晨跑"]\n```\n希望有帮助！';
  assert.deepStrictEqual(parseSearchQueries(text), ['轻快 中文 晨跑']);
});

test('parse: 无数组的垃圾输出 → null（由上层兜底）', () => {
  assert.strictEqual(parseSearchQueries('抱歉，我无法完成这个任务'), null);
  assert.strictEqual(parseSearchQueries(''), null);
  assert.strictEqual(parseSearchQueries(null), null);
});

test('parse: 清洗——超长/非字符串/空白/去重/最多3个', () => {
  const junk = JSON.stringify(['  ', 42, 'a'.repeat(80), 'ok1', 'ok1', 'ok2', 'ok3', 'ok4']);
  assert.deepStrictEqual(parseSearchQueries(junk), ['ok1', 'ok2', 'ok3']);
});

// ── 2. searchByPhrase ────────────────────────────────

const song = (id, source, title) => ({ id, source, title });

function fakeSearchAll(resultsByKey) {
  const seen = [];
  return {
    fn: async (keyword) => {
      seen.push(keyword);
      return resultsByKey[keyword] || [];
    },
    seen,
  };
}

test('service: 多关键词扇出 + 按 id+source 去重（先出现者优先）', async () => {
  const { fn: searchAll, seen } = fakeSearchAll({
    'q1': [song('1', 'qq', 'A'), song('2', 'qq', 'B')],
    'q2': [song('2', 'qq', 'B重复'), song('3', 'netease', 'C')],
  });
  const r = await searchByPhrase({
    phrase: '适合夜跑的中文摇滚',
    rewrite: async () => ['q1', 'q2'],
    searchAll,
  });
  assert.deepStrictEqual(seen, ['q1', 'q2']);
  assert.deepStrictEqual(r.songs.map(s => s.title), ['A', 'B', 'C']);
  assert.deepStrictEqual(r.queries, ['q1', 'q2']);
});

test('service: LLM 改写失败 → 用原句兜底搜一次', async () => {
  const { fn: searchAll, seen } = fakeSearchAll({ '随便什么话': [song('9', 'kuwo', 'X')] });
  const r = await searchByPhrase({
    phrase: '随便什么话',
    rewrite: async () => { throw new Error('网络超时'); },
    searchAll,
  });
  assert.deepStrictEqual(seen, ['随便什么话']);
  assert.deepStrictEqual(r.queries, ['随便什么话']);
  assert.strictEqual(r.songs.length, 1);
});

test('service: 改写出空列表 → 同样兜底', async () => {
  const { fn: searchAll } = fakeSearchAll({ p: [song('1', 'qq', 'A')] });
  const r = await searchByPhrase({ phrase: 'p', rewrite: async () => [], searchAll });
  assert.deepStrictEqual(r.queries, ['p']);
});

test('service: 空输入直接拒绝，不触任何依赖', async () => {
  let touched = 0;
  const r = await searchByPhrase({
    phrase: '   ',
    rewrite: async () => { touched++; return []; },
    searchAll: async () => { touched++; return []; },
  });
  assert.ok(r.error, '应带 error');
  assert.strictEqual(touched, 0);
  assert.deepStrictEqual(r.songs, []);
});

test('service: 总数超上限按先查询先截断', async () => {
  const many = (n, off) => Array.from({ length: n }, (_, i) => song(String(i + off), 'qq', 't'));
  const { fn: searchAll } = fakeSearchAll({ q1: many(40, 0), q2: many(40, 100) });
  const r = await searchByPhrase({
    phrase: 'x', rewrite: async () => ['q1', 'q2'], searchAll, limit: 50,
  });
  assert.strictEqual(r.songs.length, 50);
  assert.strictEqual(r.songs[49].id, '109'); // q1 的 40 首 + q2 的前 10 首
  assert.strictEqual(r.truncated, true);
});

test('service: 并行扇出（不串行等待）', async () => {
  // 判据不用墙钟（CI 抖动会把 55ms 阈值打红）：看「第一个完成时已发起几个」。
  // 串行实现第一个完成时只发起过 1 个；并行扇出在任何完成前就已把三个都发起。
  const started = [];
  let startedAtFirstDone = null;
  const searchAll = async (k) => {
    started.push(k);
    await new Promise(res => setTimeout(res, 20));
    if (startedAtFirstDone === null) startedAtFirstDone = started.length;
    return [];
  };
  await searchByPhrase({ phrase: 'x', rewrite: async () => ['a', 'b', 'c'], searchAll });
  assert.strictEqual(startedAtFirstDone, 3,
    '第一个查询完成时三个都必须已发起（并行扇出，不是串行等待）');
  assert.deepStrictEqual(started, ['a', 'b', 'c']);
});
