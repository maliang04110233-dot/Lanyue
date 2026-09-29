/**
 * 单元测试：utils/crossSourceAggregate.js —— 跨源聚合与去重标记（3-B）
 *
 * 最要紧的语义边界：**同名 ≠ 同曲**。
 * 跨源聚合最危险的错是把「翻唱版/伴奏版也叫《晴天》」判成同一首并合并，
 * 于是用户点下载拿到的是别人的演绎或一段伴奏。本文件对这条边界钉得最死。
 *
 * ⚠ 单位：全仓 duration 一律**毫秒**（qq/kugou 平台插件 * 1000，
 * netease 的 dt 原生毫秒，fmtDuration(ms) 除以 1000 展示）。
 * 写夹具时务必用 269000 而不是 269 —— 用秒会让 5s 容差形同虚设。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DURATION_TOLERANCE_MS,
  aggregateAcrossSources,
  pickRepresentative,
  isCrossSourceSameSong,
  sameTitle,
  sameArtist,
  durationCompatible,
  clusterKey,
  songKey,
  isUsableSong,
} = require('../src/utils/crossSourceAggregate');

/** 一首歌（duration 单位：毫秒） */
const s = (source, id, title, artist, duration) => ({
  source, id: String(id), title, artist, duration,
});

/** 判定某首歌是否被标为跨源重复 */
const marked = (songs) => songs.filter((x) => x._crossSource).length;

// ── 判定基元 ──────────────────────────────────────────

test('durationCompatible：5s 容差内算一致，超出/缺失/零值都不算', () => {
  assert.equal(durationCompatible(269000, 269000), true);
  assert.equal(durationCompatible(269000, 274000), true, '正好 5s 应在容差内');
  assert.equal(durationCompatible(269000, 275000), false, '6s 超出容差');
  assert.equal(durationCompatible(269000, 140000), false, '伴奏（差 129s）不是同一首');
  assert.equal(durationCompatible(269000, 0), false, '缺时长不可判');
  assert.equal(durationCompatible(0, 0), false, '两个 0 不是可比时长');
  assert.equal(durationCompatible(269000, null), false);
  assert.equal(durationCompatible(NaN, 269000), false);
  assert.equal(durationCompatible('269000', '269000'), true, '数字串应被 Number 接纳');
  assert.strictEqual(DURATION_TOLERANCE_MS, 5000);
});

test('sameArtist：归一后相等（多人歌手顺序无关），缺一侧不判等', () => {
  assert.equal(sameArtist('周杰伦', '周杰伦'), true);
  assert.equal(sameArtist(' ADELE ', 'adele'), true);
  assert.equal(sameArtist('周杰伦/费玉清', '费玉清/周杰伦'), true);
  assert.equal(sameArtist('周杰伦', '林俊杰'), false);
  assert.equal(sameArtist('', '周杰伦'), false, '缺歌手不判等');
  assert.equal(sameArtist(null, '周杰伦'), false);
});

test('sameTitle：归一后相等，(Live) 这类版本后缀不算换曲', () => {
  assert.equal(sameTitle('晴天', '晴天'), true);
  assert.equal(sameTitle('七里香', '七里香 (Live)'), true);
  assert.equal(sameTitle('晴天', '晴天（现场版）'), true);
  assert.equal(sameTitle('晴天', '稻香'), false);
  assert.equal(sameTitle('', '晴天'), false);
});

test('isCrossSourceSameSong：三条件缺一即否', () => {
  const base = s('netease', '1', '晴天', '周杰伦', 269000);
  assert.equal(isCrossSourceSameSong(base, s('qq', '9', '晴天', '周杰伦', 269000)), true);
  assert.equal(isCrossSourceSameSong(base, s('qq', '9', '晴天', '林俊杰', 269000)), false, '歌手不同');
  assert.equal(isCrossSourceSameSong(base, s('qq', '9', '稻香', '周杰伦', 269000)), false, '歌名不同');
  assert.equal(isCrossSourceSameSong(base, s('qq', '9', '晴天', '周杰伦', 140000)), false, '时长差过大');
  assert.equal(isCrossSourceSameSong(base, s('qq', '9', '晴天', '周杰伦', 0)), false, '缺时长');
  assert.equal(isCrossSourceSameSong(base, null), false);
});

// ── 输入归一 ──────────────────────────────────────────

test('聚合：垃圾输入 ⇒ 空结果，不抛错', () => {
  for (const g of [null, undefined, 'x', 42, {}, [], [{ songs: null }]]) {
    const r = aggregateAcrossSources(g);
    assert.deepEqual(r.songs, [], `应为空: ${JSON.stringify(g)}`);
    assert.equal(r.stats.total, 0);
  }
});

test('聚合：丢弃缺 id / source 的垃圾曲目（不能下载就没意义）', () => {
  const r = aggregateAcrossSources([{
    source: 'netease',
    songs: [s('netease', '1', 'A', 'X', 100000), { title: '无 id' }, { id: '2' }, null, { id: '', source: 'qq' }],
  }]);
  assert.equal(r.songs.length, 1);
  assert.equal(r.songs[0].title, 'A');
});

test('聚合：同一首歌出现在两个歌单里只收一次（歌单之间天然重叠）', () => {
  const dup = s('netease', '1', '晴天', '周杰伦', 269000);
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [dup] },
    { source: 'netease', songs: [dup, s('netease', '2', '稻香', '周杰伦', 223000)] },
  ]);
  assert.equal(r.songs.length, 2, '同平台同 id 只该出现一次');
  assert.equal(r.stats.sources, 1);
});

test('isUsableSong：id=0 合法（不该假设 id 从 1 起）', () => {
  assert.equal(isUsableSong({ id: 0, source: 'x' }), true);
  assert.equal(isUsableSong({ id: null, source: 'x' }), false);
  assert.equal(isUsableSong({ id: '', source: 'x' }), false);
  assert.equal(isUsableSong({ id: '1' }), false, '缺 source 不可用');
});

test('clusterKey / songKey：空标题不入簇，空 id 无 key', () => {
  assert.equal(clusterKey({ title: '', artist: 'X' }), '');
  assert.equal(songKey({ source: 'qq', id: '' }), '');
});

// ── 跨源同曲：应当标记 ────────────────────────────────

test('跨源同曲（歌名+歌手+时长全中）⇒ 标记为重复', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 268000)] },
  ]);
  assert.equal(r.songs.length, 2);
  for (const song of r.songs) {
    assert.equal(song._crossSource, true, '应被标记为跨源重复');
    assert.equal(song._dupCount, 2);
    assert.equal(song._dupOf.length, 1);
  }
  assert.equal(r.stats.duplicates, 2);
  assert.equal(r.stats.groups, 1);
  assert.equal(r.stats.sources, 2);
});

test('_dupOf 指向对方的 key，且不含自己', () => {
  const a = s('netease', '1', '晴天', '周杰伦', 269000);
  const b = s('qq', '9', '晴天', '周杰伦', 269000);
  const { songs } = aggregateAcrossSources([
    { source: 'netease', songs: [a] },
    { source: 'qq', songs: [b] },
  ]);
  const [x, y] = songs;
  assert.deepEqual(x._dupOf, [songKey(y)]);
  assert.deepEqual(y._dupOf, [songKey(x)]);
  assert.ok(!x._dupOf.includes(songKey(x)), '不该把自己算成重复');
});

test('版本词差异不该阻止同曲标记（(Live) 是同一首歌）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '七里香', '周杰伦', 299000)] },
    { source: 'qq', songs: [s('qq', '9', '七里香 (Live)', '周杰伦', 299000)] },
  ]);
  assert.equal(marked(r.songs), 2, '版本词差异不应阻止同曲判定');
  assert.equal(r.stats.groups, 1);
});

test('【回归】桶键必须与判定同口径：版本变体不得被粗筛分到不同桶', () => {
  // clusterKey 若用未剥版本词的歌名，「七里香」与「七里香 (Live)」会分进
  // 不同桶，两两比较永不发生，判定返回 true 也没用（"粗筛比判定更严"）。
  const a = s('netease', '1', '七里香', '周杰伦', 299000);
  const b = s('qq', '9', '七里香 (Live)', '周杰伦', 299000);
  assert.equal(isCrossSourceSameSong(a, b), true, '判定：同曲');
  assert.equal(clusterKey(a), clusterKey(b), '桶键：必须相同，否则永不相遇');

  const r = aggregateAcrossSources([
    { source: 'netease', songs: [a] },
    { source: 'qq', songs: [b] },
  ]);
  assert.equal(r.stats.groups, 1, '应聚成一簇');
  assert.equal(marked(r.songs), 2);
});

test('【回归】桶键也要剥版本修饰字（现场版 / 高音质）', () => {
  assert.equal(clusterKey({ title: '七里香', artist: '周杰伦' }),
    clusterKey({ title: '七里香（现场版）', artist: '周杰伦' }));
  assert.equal(clusterKey({ title: '晴天', artist: '周杰伦' }),
    clusterKey({ title: '晴天 高音质', artist: '周杰伦' }));
});

test('多人歌手顺序不同仍算同曲', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '屋顶', '周杰伦/费玉清', 299000)] },
    { source: 'qq', songs: [s('qq', '9', '屋顶', '费玉清/周杰伦', 299000)] },
  ]);
  assert.equal(marked(r.songs), 2);
});

// ── 跨源同曲：绝不能误判（最重要的边界）──────────────

test('【误伤闸门】同名但歌手不同 ⇒ 不得标记（多半是翻唱）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '林俊杰', 269000)] },
  ]);
  assert.equal(marked(r.songs), 0, '同名不同歌手绝不能合并');
  assert.equal(r.stats.duplicates, 0);
});

test('【误伤闸门】同名同歌手但时长差很多 ⇒ 不得标记（伴奏/变速/现场）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 140000)] },
  ]);
  assert.equal(marked(r.songs), 0, '时长差 129s（伴奏）不得判同曲');
  assert.equal(r.songs.length, 2, '两首都得留着');
});

test('【误伤闸门】同源多副本（同歌不同专辑）不算跨源重复', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'netease', songs: [s('netease', '77', '晴天', '周杰伦', 269000)] },
  ]);
  assert.equal(r.songs.length, 2);
  assert.equal(marked(r.songs), 0, '同源两个 id 不该算跨源重复');
});

test('【误伤闸门】跨源时长都缺失 ⇒ 不得标记（缺判据时宁可漏标）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 0)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 0)] },
  ]);
  assert.equal(marked(r.songs), 0, '两边都没时长时不该断言同曲');
});

test('【误伤闸门】一侧缺歌手 ⇒ 不得标记（判据不全）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
  ]);
  assert.equal(marked(r.songs), 0, '一侧缺歌手不足以断言同曲');
});

// ── 为什么不直接用裸 matchScore 当门槛（回归钉）───────

test('回归：裸 matchScore 对"同名同歌手+时长不符"给 2 分，本模块必须判否', () => {
  const { matchScore } = require('../src/utils/matchMusic');
  const a = s('netease', '1', '晴天', '周杰伦', 269000);
  const b = s('qq', '9', '晴天', '周杰伦', 140000);
  // 这条断言是本模块存在的理由：matchScore 会给 2 分（若拿 >=2 当门槛就会误并）
  assert.equal(matchScore(a, b), 2, 'matchScore 给 2 分（前提变了本用例要重估）');
  assert.equal(isCrossSourceSameSong(a, b), false, '本模块正确判否');
});

test('回归：裸 matchScore 对"两侧无时长"也给 2 分，本模块必须判否', () => {
  const { matchScore } = require('../src/utils/matchMusic');
  const a = s('netease', '1', '晴天', '周杰伦', 0);
  const b = s('qq', '9', '晴天', '周杰伦', 0);
  assert.equal(matchScore(a, b), 2);
  assert.equal(isCrossSourceSameSong(a, b), false, '缺时长不可判同曲');
});

// ── 多簇与统计 ───────────────────────────────────────

test('多簇：统计只数真正跨源的簇', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000), s('netease', '2', '稻香', '周杰伦', 223000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
    { source: 'kugou', songs: [s('kugou', '3', '稻香', '周杰伦', 224000)] },
  ]);
  assert.equal(r.stats.total, 4);
  assert.equal(r.stats.groups, 2, '两个跨源簇');
  assert.equal(r.stats.duplicates, 4, '4 首歌都在跨源簇里');
  assert.equal(r.stats.sources, 3);
});

test('三源同曲 ⇒ 一簇 3 首，每首的 _dupOf 有 2 个', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
    { source: 'kugou', songs: [s('kugou', '3', '晴天', '周杰伦', 269000)] },
  ]);
  assert.equal(r.stats.groups, 1);
  for (const song of r.songs) {
    assert.equal(song._dupCount, 3);
    assert.equal(song._dupOf.length, 2);
  }
});

test('markDuplicates:false ⇒ 只聚合不打标（省掉两两比较的开销）', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
  ], { markDuplicates: false });
  assert.equal(r.songs.length, 2);
  assert.equal(r.songs[0]._crossSource, undefined);
  assert.equal(r.stats.duplicates, 0);
  assert.equal(r.stats.total, 2, '总数仍要正确');
});

test('空标题的曲目仍出现在结果里，只是不参与成簇', () => {
  const r = aggregateAcrossSources([
    { source: 'netease', songs: [s('netease', '1', '', '周杰伦', 269000), s('netease', '2', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
  ]);
  assert.equal(r.songs.length, 3);
  assert.equal(r.stats.groups, 1);
});

test('聚合不重排、不删除传入的分组结构', () => {
  const groups = [
    { source: 'netease', songs: [s('netease', '1', '晴天', '周杰伦', 269000)] },
    { source: 'qq', songs: [s('qq', '9', '晴天', '周杰伦', 269000)] },
  ];
  aggregateAcrossSources(groups);
  assert.equal(groups.length, 2, '分组数量不该变');
  assert.equal(groups[0].songs.length, 1, '分组内不该被删元素');
});

// ── 代表条目挑选 ──────────────────────────────────────

test('pickRepresentative：优先已登录的平台（未登录时会员资源取不到流）', () => {
  const a = s('netease', '1', '晴天', '周杰伦', 269000);
  const b = s('qq', '9', '晴天', '周杰伦', 269000);
  assert.equal(pickRepresentative([a, b], new Set(['qq'])).source, 'qq');
  assert.equal(pickRepresentative([a, b], new Set(['netease'])).source, 'netease');
});

test('pickRepresentative：登录态相同时，有时长者优先（时长是同曲判据之一）', () => {
  const noDur = s('netease', '1', '晴天', '周杰伦', 0);
  const withDur = s('qq', '9', '晴天', '周杰伦', 269000);
  assert.equal(pickRepresentative([noDur, withDur], new Set()).id, '9');
});

test('pickRepresentative：空/单元素/全相同 ⇒ 不崩', () => {
  assert.equal(pickRepresentative([]), null);
  assert.equal(pickRepresentative(null), null);
  assert.equal(pickRepresentative([null, undefined]), null);
  const one = s('qq', '9', '晴天', '周杰伦', 269000);
  assert.equal(pickRepresentative([one]), one);
  assert.equal(pickRepresentative([one, one], new Set()), one);
});

test('pickRepresentative：同分时保持原顺序（与传入顺序一致）', () => {
  const a = s('netease', '1', '晴天', '周杰伦', 269000);
  const b = s('qq', '9', '晴天', '周杰伦', 269000);
  // 两首登录态与时长都相同 ⇒ 并列，应取传入的第一个
  assert.equal(pickRepresentative([a, b], new Set()), a);
  assert.equal(pickRepresentative([b, a], new Set()), b);
});

// ── 生产接线：归一化复用 matchMusic，但不触发网络搜索 ──

test('生产接线：归一化复用 matchMusic', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/crossSourceAggregate.js'), 'utf8');
  assert.match(src, /require\('\.\/matchMusic'\)/, '应复用 matchMusic 的归一化');
  assert.match(src, /normalizeName|normalizeArtists/, '应调用其归一化函数');
});

test('生产接线：代码（去掉注释后）不得出现 findMatchedCandidates', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/crossSourceAggregate.js'), 'utf8');
  // 先剥注释再断言：注释里解释「为什么不用它」是必要的，不能因此误判
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  assert.ok(!/findMatchedCandidates/.test(code),
    '聚合是对已有数据分组，代码路径里不该发起跨源网络搜索');
});
