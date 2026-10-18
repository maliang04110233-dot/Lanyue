const { test } = require('node:test');
const assert = require('node:assert');

const { asSong } = require('../src/api/songShape');

test('asSong：核心字段类型收敛（数字 id → 字符串，null → 默认值）', () => {
  const out = asSong({ id: 3, title: '歌名', artist: null, album: undefined, cover: undefined, duration: 180000, source: 't' });
  assert.equal(out.id, '3');
  assert.equal(out.title, '歌名');
  assert.equal(out.artist, '');
  assert.equal(out.album, '');
  assert.equal(out.cover, '');
  assert.equal(out.duration, 180000);
  assert.equal(out.source, 't');
});

test('asSong：duration NaN / 非有限值 → 0（杜绝 NaN 流进渲染层）', () => {
  assert.equal(asSong({ duration: NaN }).duration, 0);
  assert.equal(asSong({ duration: undefined }).duration, 0);
  assert.equal(asSong({ duration: 'bad' }).duration, 0);
  assert.equal(asSong({ duration: '180000' }).duration, 180000, '数字字符串允许');
});

test('asSong：平台扩展字段透传（fee/pay/albumMid/numId…）', () => {
  const out = asSong({ id: '1', title: 't', source: 'netease', fee: 8, albumMid: 'm1', pay: { pay_play: 1 } });
  assert.equal(out.fee, 8);
  assert.equal(out.albumMid, 'm1');
  assert.deepEqual(out.pay, { pay_play: 1 });
});

test('asSong：不增删条目 —— 守卫留在各平台（asSong 不返回 null）', () => {
  // 空对象也收敛成规范形状而非丢弃，丢单集合由各平台自己决定
  const out = asSong({});
  assert.deepEqual(Object.keys(out).sort(), ['album', 'artist', 'cover', 'duration', 'id', 'source', 'title']);
});

test('asSong：artist 分隔符原样保留 —— 各平台约定不同，勿统一', () => {
  // netease/qq 现状 ' / '；migu/soda 现状 '、'；kuwo 现状 ', '
  assert.equal(asSong({ artist: 'A / B' }).artist, 'A / B');
  assert.equal(asSong({ artist: 'A、B' }).artist, 'A、B');
  assert.equal(asSong({ artist: 'A, B' }).artist, 'A, B');
});

test('asSong：扩展字段在核心字段覆盖后仍保留（spread 在前，收敛字段在后）', () => {
  // 防呆：如果未来有人把 spread 挪到最后，会覆盖掉收敛结果
  const out = asSong({ id: 5, title: 'x', duration: 1000, title_raw: 'y' });
  assert.equal(out.id, '5');
  assert.equal(out.title, 'x');
  assert.equal(out.duration, 1000);
  assert.equal(out.title_raw, 'y');
});
