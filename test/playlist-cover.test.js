/**
 * 歌单封面纯函数测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/playlistCover.js?ck=${Math.random()}`);

test('normalizeCoverUrl 放行 http/https 并 trim', async () => {
  const { normalizeCoverUrl } = await mod();
  assert.equal(normalizeCoverUrl('  https://a.com/x.jpg '), 'https://a.com/x.jpg');
  assert.equal(normalizeCoverUrl('http://a.com/x.jpg'), 'http://a.com/x.jpg');
});

test('normalizeCoverUrl 空输入归零串', async () => {
  const { normalizeCoverUrl } = await mod();
  assert.equal(normalizeCoverUrl(''), '');
  assert.equal(normalizeCoverUrl('   '), '');
  assert.equal(normalizeCoverUrl(null), '');
  assert.equal(normalizeCoverUrl(undefined), '');
});

test('normalizeCoverUrl 拒绝非 http(s) 协议（javascript/data/裸串）', async () => {
  const { normalizeCoverUrl } = await mod();
  assert.equal(normalizeCoverUrl('javascript:alert(1)'), null);
  assert.equal(normalizeCoverUrl('data:image/png;base64,AAAA'), null);
  assert.equal(normalizeCoverUrl('ftp://a.com/x'), null);
  assert.equal(normalizeCoverUrl('a.com/x.jpg'), null);
  assert.equal(normalizeCoverUrl('https://a b.jpg'), null); // 含空格
});

test('pickFirstSongCover 跳过无封面曲，全无返回空串', async () => {
  const { pickFirstSongCover } = await mod();
  assert.equal(pickFirstSongCover([{ cover: '' }, { cover: 'https://x/c.jpg' }]), 'https://x/c.jpg');
  assert.equal(pickFirstSongCover([{ cover: 'bad' }, {}]), '');
  assert.equal(pickFirstSongCover([]), '');
  assert.equal(pickFirstSongCover(null), '');
});
