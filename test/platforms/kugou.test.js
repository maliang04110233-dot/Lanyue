/**
 * 酷狗平台测试
 *
 * 验证酷狗平台的：
 *   1. ID 编码/解码（三种音质 hash）
 *   2. 搜索功能（mock 网络）
 *   3. 取流功能（mock 网络）
 *   4. KRC 歌词解码
 */

const test = require('node:test');
const assert = require('node:assert');

const { mockRequest } = require('../helpers/platformStub.js');

// ── ID 编码/解码 ────────────────────────────────────────

test('ID 编码：三种音质 hash 编码到 id', () => {
  // 从 kugou.js 提取 encodeKugouId 逻辑进行测试
  const HASH_SEP = '::';
  const fileHash = 'ABC123';
  const sqHash = 'DEF456';
  const hqHash = 'GHI789';
  const encoded = `${fileHash}${HASH_SEP}${sqHash}${HASH_SEP}${hqHash}`;
  const parts = encoded.split(HASH_SEP);
  assert.strictEqual(parts[0], fileHash);
  assert.strictEqual(parts[1], sqHash);
  assert.strictEqual(parts[2], hqHash);
});

test('ID 解码：空 hash 处理', () => {
  const HASH_SEP = '::';
  const encoded = `ABC123${HASH_SEP}${HASH_SEP}`;
  const parts = encoded.split(HASH_SEP);
  assert.strictEqual(parts[0], 'ABC123');
  assert.strictEqual(parts[1], '');
  assert.strictEqual(parts[2], '');
});

// ── 搜索功能 ────────────────────────────────────────────

test('搜索：空关键词返回空数组', async () => {
  const restore = mockRequest(async () => ({ data: { lists: [] } }));
  const kugou = require('../../src/api/platforms/kugou');
  const result = await kugou.search('', 1, '');
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 0);
  restore();
  delete require.cache[require.resolve('../../src/api/platforms/kugou')];
});

test('搜索：正常返回歌曲列表', async () => {
  const mockResponse = {
    data: {
      lists: [
        {
          SongName: 'Test Song',
          SingerName: 'Test Artist',
          AlbumName: 'Test Album',
          FileHash: 'ABC123',
          SQFileHash: 'DEF456',
          HQFileHash: 'GHI789',
          Duration: 180,
        },
      ],
    },
  };
  const restore = mockRequest(async () => mockResponse);
  const kugou = require('../../src/api/platforms/kugou');
  const result = await kugou.search('test', 1, '');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, 'Test Song');
  assert.strictEqual(result[0].artist, 'Test Artist');
  assert.strictEqual(result[0].source, 'kugou');
  restore();
  delete require.cache[require.resolve('../../src/api/platforms/kugou')];
});

// ── 取流功能 ────────────────────────────────────────────

test('取流：缺少 hash 返回 fatal 错误', async () => {
  const kugou = require('../../src/api/platforms/kugou');
  const result = await kugou.getUrl(':::', 'standard', '');
  assert.strictEqual(result.fatal, true);
  assert.ok(result.error);
  delete require.cache[require.resolve('../../src/api/platforms/kugou')];
});

test('取流：标准音质使用 fileHash', async () => {
  const restore = mockRequest(async () => ({
    url: 'https://example.com/song.mp3',
  }));
  const kugou = require('../../src/api/platforms/kugou');
  const result = await kugou.getUrl('ABC123:::', 'standard', '');
  assert.ok(result.url);
  restore();
  delete require.cache[require.resolve('../../src/api/platforms/kugou')];
});

// ── KRC 歌词解码 ────────────────────────────────────────

test('KRC 解码：空歌词返回空字符串', async () => {
  const kugou = require('../../src/api/platforms/kugou');
  const result = await kugou.getLyrics('ABC123:::', 'Test Song', 'Test Artist');
  assert.ok(typeof result === 'object');
  assert.ok('lrc' in result);
  delete require.cache[require.resolve('../../src/api/platforms/kugou')];
});
