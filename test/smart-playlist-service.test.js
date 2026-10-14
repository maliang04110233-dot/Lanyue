/**
 * 智能歌单：纯函数 + 依赖注入（与 aiAssistantService 同一模式，单测不触网）
 *
 * 这一层每一枚测试都钉着一个真实风险：
 *   ① 候选清单是**喂给模型的全部世界**，超上限必须截断并如实回报，
 *      否则用户以为 AI 看完了整个曲库；
 *   ② 模型返回的是**序号**不是歌曲，越界/重复/字符串数字都得先钳制，
 *      钳制完之后才可能拿到真歌曲对象——顺序反了就是拿越界下标去 splice；
 *   ③ 出网失败与"模型没选出来"是两种失败：前者文案在词典里，后者要重试，
 *      混成一个令牌用户就不知道该干什么；
 *   ④ 名字是歌单的必填项，模型不给也得有兜底，否则存单直接被
 *      save-user-playlist 拒了（name 为空）。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildCandidates, parseSelection, generateSmartPlaylist, dedupeSongs, songKey,
  MAX_CANDIDATES, MAX_PICKS,
} = require('../src/api/services/smartPlaylistService');

const online = (n) => ({ id: String(n), source: 'kw', title: `歌${n}`, artist: `手${n}` });
const many = (count) => Array.from({ length: count }, (_, i) => online(i + 1));

test('候选清单：一行一首，序号从 1 起，制表符分隔标题与歌手', () => {
  const c = buildCandidates([online(1), online(2)]);
  assert.strictEqual(c.total, 2);
  assert.strictEqual(c.truncated, 0);
  assert.deepStrictEqual(c.text.split('\n'), ['1\t歌1\t手1', '2\t歌2\t手2']);
  // 序号是真歌曲的唯一桥梁：list[n-1].song 必须回指原对象
  const src = [online(1), online(2)];
  const withRefs = buildCandidates(src);
  assert.strictEqual(withRefs.list[0].song, src[0]);
  assert.strictEqual(withRefs.list[1].song.title, '歌2');
});

test('候选清单：没有标题的行不进清单（模型无从选起，占位符只会换来幻觉）', () => {
  const c = buildCandidates([{ id: '1', source: 'kw', artist: '无题' }, online(2)]);
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.text, '1\t歌2\t手2');
});

test('候选清单：超过上限就截断，并把截掉多少如实回报', () => {
  const c = buildCandidates(many(MAX_CANDIDATES + 137));
  assert.strictEqual(c.list.length, MAX_CANDIDATES);
  assert.strictEqual(c.total, MAX_CANDIDATES + 137);
  assert.strictEqual(c.truncated, 137);
  assert.ok(!c.text.includes(String(MAX_CANDIDATES + 1)), '最后一行不该是越界的那首');
});

test('去重：同一首歌挂在多个歌单里只算一条（键是 id:source，与 playlist.js 同规则）', () => {
  assert.strictEqual(songKey({ id: '7', source: 'wy' }), '7:wy');
  const r = dedupeSongs([
    { id: '7', source: 'wy', title: 'A' },
    { id: '7', source: 'kw', title: 'B' },
    { id: '7', source: 'wy', title: 'A 又一遍' },
  ]);
  assert.deepStrictEqual(r.map(s => s.title), ['A', 'B']);
});

test('解析：干净 JSON 给出名字、理由与序号', () => {
  const c = buildCandidates(many(5));
  const r = parseSelection('{"name":"夜跑","reason":"节奏偏快","picks":[3,1,5]}', c);
  assert.strictEqual(r.name, '夜跑');
  assert.strictEqual(r.reason, '节奏偏快');
  assert.deepStrictEqual(r.picks, [3, 1, 5]); // 模型给的顺序就是它想排的顺序
});

test('解析：JSON 外面裹解释文字或代码块也要能吃下', () => {
  const c = buildCandidates(many(5));
  const r = parseSelection('好的：\n```json\n{"name":"晨间","reason":"","picks":[2]}\n```', c);
  assert.strictEqual(r.name, '晨间');
  assert.deepStrictEqual(r.picks, [2]);
});

test('钳制：越界、重复、非数字、字符串数字统统处理，只留合法序号', () => {
  const c = buildCandidates(many(5));
  const r = parseSelection(
    '{"name":"x","reason":"y","picks":[0, 1, "2", 2.7, 6, -3, null, "abc", 5]}', c);
  assert.deepStrictEqual(r.picks, [1, 2, 5]);
});

test('钳制：序号多于上限就截到上限（一首歌不该被选两遍，清单也不该无限长）', () => {
  const c = buildCandidates(many(MAX_PICKS + 20));
  const r = parseSelection(
    `{"name":"大单","reason":"","picks":[${Array.from({ length: MAX_PICKS + 20 }, (_, i) => i + 1).join(',')}]}`, c);
  assert.strictEqual(r.picks.length, MAX_PICKS);
});

test('解析：完全不是 JSON 时不抛错，退成"没选出来"', () => {
  const r = parseSelection('我看不懂这个曲库', buildCandidates(many(3)));
  assert.deepStrictEqual(r.picks, []);
  assert.strictEqual(r.name, '');
});

test('生成：空主题是 EMPTY_PROMPT，空曲库是 NO_CANDIDATES —— 都不出网', () => {
  let chats = 0;
  const chat = async () => { chats++; return '{}'; };
  return Promise.all([
    generateSmartPlaylist({ prompt: '  ', songs: many(3), chat }).then(r => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'EMPTY_PROMPT');
    }),
    generateSmartPlaylist({ prompt: '夜跑', songs: [], chat }).then(r => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'NO_CANDIDATES');
    }),
  ]).then(() => assert.strictEqual(chats, 0, '两种失败都不该花用户的钱'));
});

test('生成：成功时把序号换成真歌曲对象，并把截断事实带回去', () => {
  const songs = many(MAX_CANDIDATES + 5);
  const seen = [];
  return generateSmartPlaylist({
    prompt: '夜跑',
    songs,
    chat: async (messages) => { seen.push(messages); return '{"name":"夜跑节奏","reason":" tempo 合适","picks":[2,1]}'; },
  }).then((r) => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.name, '夜跑节奏');
    assert.deepStrictEqual(r.songs.map(s => s.title), ['歌2', '歌1']);
    assert.strictEqual(r.truncated, 5);
    assert.strictEqual(r.candidateCount, MAX_CANDIDATES);
    // 一次回合：system + user，且 user 里带着主题与候选清单
    const [sys, user] = seen[0];
    assert.strictEqual(sys.role, 'system');
    assert.match(user.content, /夜跑/);
    assert.match(user.content, /1\t歌1\t手1/);
  });
});

test('生成：出网抛 NO_KEY 原样成令牌（Key 缺失与模型失败是两回事）', () => {
  return generateSmartPlaylist({
    prompt: '夜跑', songs: many(2),
    chat: async () => { throw new Error('NO_KEY'); },
  }).then(r => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'NO_KEY');
  });
});

test('生成：出网其它异常收敛成 LLM_FAILED，不把上游原文往外丢', () => {
  return generateSmartPlaylist({
    prompt: '夜跑', songs: many(2),
    chat: async () => { throw new Error('上游把内部信息写在错误里：token=abc'); },
  }).then(r => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'LLM_FAILED');
    assert.ok(!JSON.stringify(r).includes('token=abc'), '上游原文不该出现在返回里');
  });
});

test('生成：模型一个都没选出来是 NO_PICKS（可重试），不是 LLM_FAILED', () => {
  return generateSmartPlaylist({
    prompt: '夜跑', songs: many(2),
    chat: async () => '{"name":"空","reason":"","picks":[]}',
  }).then(r => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'NO_PICKS');
  });
});

test('生成：模型不给名字时用用户自己的话兜底（存单必须有 name）', () => {
  return generateSmartPlaylist({
    prompt: '适合写代码的下半段', songs: many(3),
    chat: async () => '{"name":"","reason":"挑了三首","picks":[1,2,3]}',
  }).then(r => {
    assert.strictEqual(r.ok, true);
    assert.ok(r.name.length > 0);
    assert.ok(r.name.length <= 24);
    assert.match(r.name, /写代码|适合/);
  });
});
